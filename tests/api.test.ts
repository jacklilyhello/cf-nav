vi.mock('../src/icons', () => ({
  discoverIcon: vi.fn(async () => ({
    icon: '',
    status: 'not_found',
    source: null,
    checkedAt: new Date().toISOString(),
  })),
}));
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { adminApi, catalog } from '../src/api/catalog';
import { authenticate, csrf, readJson, sha256 } from '../src/api/security';
import worker from '../src/worker';
import type { Env } from '../src/shared/types';

let mf: Miniflare;
let env: Env;
const origin = 'https://cf-nav-staging.lilyya.workers.dev';
const req = (path: string, method = 'GET', body?: unknown) =>
  new Request(`${origin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  const sql = readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(`migrations/${name}`, 'utf8'))
    .join('\n');
  for (const statement of sql
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
  env = {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: async () => new Response('asset', { status: 404 }) } as unknown as Fetcher,
    APP_ENV: 'staging',
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'audience',
    ADMIN_EMAIL_HASH: await sha256('owner@example.com'),
  };
});
afterAll(async () => {
  await mf.dispose();
});
describe('D1 admin lifecycle and visibility', () => {
  it('creates, edits, hides, exports, deletes and restores structured navigation', async () => {
    expect(
      (
        await adminApi(
          req('/api/admin/categories', 'POST', { id: 'tools', name: '工具', slug: 'tools' }),
          env,
        )
      ).status,
    ).toBe(201);
    const link = {
      id: 'example',
      categoryId: 'tools',
      name: 'Example',
      url: 'https://example.com/',
      description: 'Example resource',
      enabled: true,
    };
    expect((await adminApi(req('/api/admin/links', 'POST', link), env)).status).toBe(201);
    expect((await catalog(env)).links).toHaveLength(1);
    await adminApi(
      req('/api/admin/links/example', 'PUT', { ...link, enabled: false, notes: 'private note' }),
      env,
    );
    expect((await catalog(env)).links).toHaveLength(0);
    const full = await catalog(env, true);
    expect(full.links[0].notes).toBe('private note');
    const backup = await (await adminApi(req('/api/admin/export'), env)).json();
    expect((backup as { version: number }).version).toBe(1);
    await expect(adminApi(req('/api/admin/categories/tools', 'DELETE'), env)).rejects.toThrow(
      '请先移动',
    );
    await adminApi(req('/api/admin/links/example', 'DELETE'), env);
    expect((await catalog(env, true)).links).toHaveLength(0);
    await adminApi(req('/api/admin/links/example/restore', 'POST', {}), env);
    expect((await catalog(env, true)).links).toHaveLength(1);
    await adminApi(
      req('/api/admin/categories/tools', 'PUT', {
        id: 'tools',
        name: '工具',
        slug: 'tools',
        enabled: false,
      }),
      env,
    );
    expect((await catalog(env)).categories).toHaveLength(0);
  });
  it('atomically merges an export and rejects invalid imports without partial writes', async () => {
    const body = {
      version: 1,
      categories: [{ id: 'new-cat', name: '新分类', slug: 'new-cat' }],
      links: [
        { id: 'new-link', name: 'Other', url: 'https://example.org/', categoryId: 'new-cat' },
      ],
    };
    await adminApi(req('/api/admin/import', 'POST', body), env);
    expect((await catalog(env, true)).links).toHaveLength(2);
    await expect(
      adminApi(
        req('/api/admin/import', 'POST', {
          ...body,
          links: [{ ...body.links[0], categoryId: 'missing' }],
        }),
        env,
      ),
    ).rejects.toThrow('不存在');
    await expect(
      adminApi(
        req('/api/admin/import', 'POST', { ...body, links: [body.links[0], body.links[0]] }),
        env,
      ),
    ).rejects.toThrow('唯一');
    expect((await catalog(env, true)).links).toHaveLength(2);
  });
  it('rejects private destinations and does not expose private notes publicly', async () => {
    await expect(
      adminApi(
        req('/api/admin/links', 'POST', {
          name: 'bad',
          url: 'http://127.0.0.1',
          categoryId: 'tools',
        }),
        env,
      ),
    ).rejects.toThrow();
    const publicData = await catalog(env);
    expect(JSON.stringify(publicData)).not.toContain('private note');
  });
  it('protects all admin APIs and reports JSON 404 with security headers', async () => {
    const response = await worker.fetch(req('/api/admin/data'), env);
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const unknown = await worker.fetch(req('/api/missing'), env);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('Content-Type')).toContain('application/json');
  });
  it('sends anonymous and invalid admin page sessions through a fixed Access navigation', async () => {
    for (const path of ['/admin', '/admin/']) {
      for (const method of ['GET', 'HEAD']) {
        for (const cookie of ['', 'CF_Authorization=invalid-session']) {
          const response = await worker.fetch(
            new Request(`${origin}${path}?returnTo=https://untrusted.example`, {
              method,
              headers: { Cookie: cookie },
            }),
            env,
          );
          expect(response.status).toBe(303);
          expect(response.headers.get('Location')).toBe(`${origin}/admin/login`);
          expect(response.headers.get('Cache-Control')).toBe('no-store');
        }
      }
    }
    const session = await worker.fetch(req('/api/admin/session'), env);
    expect(session.status).toBe(401);
    expect(await session.json()).toMatchObject({ loginUrl: '/admin/login' });
    expect(session.headers.get('Location')).toBeNull();
  });
  it('does not redirect configuration failures into a login loop', async () => {
    const response = await worker.fetch(req('/admin'), { ...env, ACCESS_AUD: '' });
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
  });
});
describe('Access cryptographic authentication', () => {
  it('validates signature, issuer, audience, expiry and the single-owner identity', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const key = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }],
    });
    const sign = (email = 'owner@example.com', audience = 'audience', expiry = '1h') =>
      new SignJWT({ email, type: 'app' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuedAt()
        .setSubject('owner')
        .setIssuer('https://team.cloudflareaccess.com')
        .setAudience(audience)
        .setExpirationTime(expiry)
        .sign(privateKey);
    const token = await sign();
    const request = new Request(`${origin}/api/admin/session`, {
      headers: { Cookie: `CF_Authorization=${token}` },
    });
    expect((await authenticate(request, env, key)).email).toBe('owner@example.com');
    const productionEnv = { ...env, ACCESS_AUD: 'production, preview' };
    for (const audience of ['production', 'preview']) {
      const productionToken = await sign('owner@example.com', audience);
      expect(
        (
          await authenticate(
            new Request(origin, {
              headers: { Cookie: `CF_Authorization=${productionToken}` },
            }),
            productionEnv,
            key,
          )
        ).email,
      ).toBe('owner@example.com');
    }
    await expect(authenticate(request, productionEnv, key)).rejects.toThrow('登录');
    for (const invalid of [
      await sign('other@example.com'),
      await sign('owner@example.com', 'wrong'),
      await sign('owner@example.com', 'audience', '-1h'),
      token.slice(0, -8) + 'tampered',
    ])
      await expect(
        authenticate(
          new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': invalid } }),
          env,
          key,
        ),
      ).rejects.toThrow('登录');
  });
  it('rejects CSRF, content-type confusion and oversized streaming JSON', async () => {
    expect(() => csrf(req('/api/admin/links', 'POST', {}), 'token')).toThrow('来源');
    const good = new Request(origin, {
      method: 'POST',
      headers: { Origin: origin, 'X-CSRF-Token': 'token' },
    });
    expect(() => csrf(good, 'token')).not.toThrow();
    const wrong = new Request(origin, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-CSRF-Token': 'token' },
    });
    expect(() => csrf(wrong, 'token')).toThrow();
    await expect(readJson(new Request(origin, { method: 'POST', body: '{}' }))).rejects.toThrow(
      'JSON',
    );
    await expect(readJson(req('/', 'POST', { x: 'x'.repeat(100) }), 20)).rejects.toThrow('过大');
  });
});
