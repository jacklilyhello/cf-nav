import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import type { Env } from '../src/shared/types';
import { adminApi, catalog } from '../src/api/catalog';
import { DEFAULT_SETTINGS, getSettings } from '../src/api/settings';
import worker from '../src/worker';
const discovery = vi.hoisted(() => vi.fn());
vi.mock('../src/icons', () => ({ discoverIcon: discovery }));
let mf: Miniflare;
let env: Env;
const origin = 'https://nav.lily.lat';
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
      compatibilityDate: '2026-10-01',
    }),
  );
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').sort())
    for (const sql of readFileSync(`migrations/${name}`, 'utf8')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  env = {
    DB: db as unknown as D1Database,
    APP_ENV: 'production',
    PUBLIC_ORIGIN: origin,
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    ADMIN_EMAIL_HASH: 'unused',
    ASSETS: {
      fetch: async () =>
        new Response(
          '<html><head><title>Lily</title></head><body><div id="app"></div></body></html>',
        ),
    } as unknown as Fetcher,
  };
  discovery.mockResolvedValue({
    icon: 'https://example.com/favicon.ico',
    status: 'found',
    source: 'favicon',
    checkedAt: new Date().toISOString(),
  });
  await adminApi(
    request('/api/admin/categories', 'POST', { id: 'cat', name: 'Tools', slug: 'tools' }),
    env,
  );
});
afterAll(async () => {
  await mf.dispose();
});

describe('persistent indexing and health controls', () => {
  it('validates settings and applies toggles to header, HTML, robots and sitemap', async () => {
    expect(await getSettings(env)).toEqual(DEFAULT_SETTINGS);
    for (const allowIndexing of [false, true]) {
      const value = {
        ...DEFAULT_SETTINGS,
        allowIndexing,
        healthUserAgent: 'Lily-Probe/2.0',
        healthIntervalSeconds: 5,
        healthTimeoutSeconds: 8,
      };
      expect((await adminApi(request('/api/admin/settings', 'PUT', value), env)).status).toBe(200);
      expect(await (await adminApi(request('/api/admin/settings'), env)).json()).toMatchObject({
        ...value,
        effectiveAllowIndexing: allowIndexing,
      });
      const page = await worker.fetch(request('/'), env);
      const policy = allowIndexing ? 'index, follow' : 'noindex, nofollow';
      expect(page.headers.get('X-Robots-Tag')).toBe(policy);
      expect(page.headers.get('Cache-Control')).toBe('no-store');
      const html = await page.text();
      expect(html).toContain(`<meta name="robots" content="${policy}"`);
      expect(html).toContain(`rel="canonical" href="${origin}/"`);
      const robots = await (await worker.fetch(request('/robots.txt'), env)).text();
      expect(robots).toContain('Allow: /\nDisallow: /admin');
      expect(robots.includes('Sitemap:')).toBe(allowIndexing);
      expect(robots).not.toContain('Disallow: /\n');
      const sitemap = await (await worker.fetch(request('/sitemap.xml'), env)).text();
      expect(sitemap.includes(`<loc>${origin}/</loc>`)).toBe(allowIndexing);
      const head = await worker.fetch(request('/', 'HEAD'), env);
      expect(head.headers.get('X-Robots-Tag')).toBe(policy);
      expect(await head.text()).toBe('');
    }
    for (const invalid of [
      { healthIntervalSeconds: 0 },
      { healthIntervalSeconds: 11 },
      { healthTimeoutSeconds: 21 },
      { healthTimeoutSeconds: 1 },
      { healthUserAgent: 'bad\r\nInjected: yes' },
      { healthUserAgent: '中文' },
    ]) {
      await expect(
        adminApi(request('/api/admin/settings', 'PUT', { ...DEFAULT_SETTINGS, ...invalid }), env),
      ).rejects.toThrow();
    }
    expect((await getSettings(env)).healthIntervalSeconds).toBe(5);
  });
  it('keeps staging, alternate origins, APIs and private pages out of search', async () => {
    for (const [url, override] of [
      [origin, { APP_ENV: 'staging' }],
      ['https://cf-nav.lilyya.workers.dev', {}],
    ] as const) {
      const response = await worker.fetch(new Request(url + '/'), { ...env, ...override });
      expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
      expect(await response.text()).toContain('content="noindex, nofollow"');
    }
    for (const path of [
      '/api/admin/settings',
      '/api/admin/data',
      '/admin',
      '/api/health',
      '/api/missing',
    ]) {
      const response = await worker.fetch(request(path), env);
      expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    }
  });
});
describe('icon ownership and baseline lifecycle', () => {
  const link = {
    id: 'site',
    categoryId: 'cat',
    name: 'Example',
    url: 'https://example.com/',
    expectedTitle: 'Example Domain',
    expectedDescription: 'Documentation examples',
    expectedKeywords: ['Example'],
  };
  it('discovers defaults, persists manual choices and honors none mode', async () => {
    await adminApi(request('/api/admin/links', 'POST', link), env);
    let row = (await catalog(env, true)).links[0]!;
    expect(row).toMatchObject({
      iconMode: 'auto',
      icon: 'https://example.com/favicon.ico',
      expectedTitle: link.expectedTitle,
    });
    const calls = discovery.mock.calls.length;
    await adminApi(
      request('/api/admin/links/site', 'PUT', { ...link, iconMode: 'manual', icon: '★' }),
      env,
    );
    await expect(adminApi(request('/api/admin/links/site/icon', 'POST', {}), env)).rejects.toThrow(
      '自动图标',
    );
    expect(discovery.mock.calls).toHaveLength(calls);
    await adminApi(
      request('/api/admin/links/site', 'PUT', { ...link, iconMode: 'none', icon: 'ignored' }),
      env,
    );
    row = (await catalog(env, true)).links[0]!;
    expect(row).toMatchObject({ iconMode: 'none', icon: '' });
    const pub = (await catalog(env)).links[0]!;
    expect(pub).not.toHaveProperty('expectedTitle');
    expect(pub).not.toHaveProperty('expectedDescription');
    const exported = (await (await adminApi(request('/api/admin/export'), env)).json()) as {
      links: Record<string, unknown>[];
    };
    expect(exported.links[0]).toMatchObject({
      expectedTitle: link.expectedTitle,
      iconMode: 'none',
    });
  });
  it('falls back after failed discovery and escapes the no-JS catalog', async () => {
    discovery.mockResolvedValueOnce({
      icon: '',
      status: 'not_found',
      source: null,
      checkedAt: new Date().toISOString(),
    });
    await adminApi(
      request('/api/admin/links/site', 'PUT', {
        ...link,
        name: '<script>alert(1)</script>',
        description: '"<&',
        iconMode: 'auto',
      }),
      env,
    );
    expect((await catalog(env, true)).links[0]).toMatchObject({ iconMode: 'auto', icon: '' });
    const page = await (await worker.fetch(request('/'), env)).text();
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>alert(1)');
  });
});
