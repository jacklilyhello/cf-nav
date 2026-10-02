import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import fixture from './fixtures/probe-acceptance-worker';

const origin = 'https://cf-nav-acceptance.lilyya.workers.dev';
const get = (path: string, headers?: HeadersInit) =>
  fixture.fetch(new Request(origin + path, { headers }));

describe('isolated remote probe acceptance fixture', () => {
  afterEach(() => vi.useRealTimers());

  it('deploys and removes only an explicit isolated configuration with no bindings or routes', () => {
    const workflow = readFileSync('.github/workflows/probe-acceptance.yml', 'utf8');
    const config = JSON.parse(workflow.match(/<<'JSON'\n([\s\S]*?)\n {10}JSON/)![1]!);
    expect(config).toEqual({
      name: 'cf-nav-acceptance',
      main: '../../tests/fixtures/probe-acceptance-worker.ts',
      compatibility_date: '2026-10-01',
      compatibility_flags: ['global_fetch_strictly_public'],
      workers_dev: true,
      preview_urls: false,
      observability: { enabled: false },
      logpush: false,
    });
    const mutations = workflow
      .split('\n')
      .filter((line) => /run: npx wrangler (?:deploy|delete)/.test(line));
    expect(mutations).toHaveLength(2);
    expect(
      mutations.every((line) => line.includes('--config build/probe-acceptance/wrangler.json')),
    ).toBe(true);
    expect(mutations.find((line) => line.includes(' delete '))).toContain(
      'delete cf-nav-acceptance ',
    );
  });

  it('escapes and bounds the reflected UA and does not echo other request data', async () => {
    const response = await get('/identity?private=query-secret', {
      'user-agent': '<script>alert("test")</script>' + 'x'.repeat(300),
      cookie: 'session=cookie-secret',
      authorization: 'Bearer auth-secret',
    });
    const body = await response.text();
    expect(body).toContain('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('x'.repeat(257));
    for (const secret of ['query-secret', 'cookie-secret', 'auth-secret'])
      expect(body).not.toContain(secret);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('measures the actual elapsed time between two remote requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
    const response = await get('/redirect');
    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(location).toBe('/arrived?started=1790985600000');
    vi.setSystemTime(new Date('2026-10-03T00:00:02.123Z'));
    const arrived = await get(location, { 'user-agent': 'acceptance-test/1.0' });
    expect(await arrived.text()).toContain('interval=2123ms | UA=acceptance-test/1.0');
  });

  it.each(['invalid', '-1', '9999999999999', '1'])(
    'rejects malformed or implausible timing input %s',
    async (started) => {
      expect((await get(`/arrived?started=${started}`)).status).toBe(400);
    },
  );

  it('waits exactly five seconds for bounded timeout acceptance', async () => {
    vi.useFakeTimers();
    let completed = false;
    const pending = get('/slow').then((response) => {
      completed = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).text()).toContain('delayed=5000ms');
  });

  it('serves a genuine isolated icon and recognizable changed-content fixture', async () => {
    expect(await (await get('/')).text()).toContain('rel="icon" href="/favicon.svg"');
    const icon = await get('/favicon.svg');
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(await icon.text()).toMatch(/^<svg\b.*<\/svg>$/);
    expect(await (await get('/changed')).text()).toContain('This domain is for sale');
  });

  it('provides no write methods or application/admin routes', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      expect((await fixture.fetch(new Request(origin + '/identity', { method }))).status).toBe(404);
    }
    for (const path of ['/admin', '/api/admin/data', '/missing']) {
      expect((await get(path)).status).toBe(404);
    }
  });
});
