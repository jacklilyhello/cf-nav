import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { adminApi } from '../src/api/catalog';
import { IMPORT_MAX_BYTES, linkSchema } from '../src/api/validation';
import type { Env } from '../src/shared/types';

let mf: Miniflare;
let database: D1Database;
let env: Env;
const boundBytes: number[] = [];
const batchSizes: number[] = [];
const origin = 'https://nav.lily.lat';
const request = (path: string, body?: unknown) =>
  new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const backup = (prefix: string, count: number) => ({
  version: 1,
  categories: [{ id: prefix, name: '工具', slug: prefix }],
  links: Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    categoryId: prefix,
    name: `工具 ${index}`,
    url: `https://example.com/${prefix}/${index}`,
    description: '说明'.repeat(500),
    notes: '私密备注'.repeat(1000),
    icon: '工具',
    expectedKeywords: ['关键词'.repeat(26)],
    healthOverride: 'needs_review',
  })),
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
  database = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const statement of (
    readFileSync('migrations/0001_initial.sql', 'utf8') +
    readFileSync('migrations/0002_navigation_controls.sql', 'utf8')
  )
    .split(';')
    .map((sql) => sql.trim())
    .filter(Boolean))
    await database.prepare(statement).run();
  const instrumented = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        for (const value of values)
          if (typeof value === 'string') boundBytes.push(new TextEncoder().encode(value).length);
        return bind(...values);
      };
      return statement;
    },
    batch<T>(statements: D1PreparedStatement[]) {
      batchSizes.push(statements.length);
      return database.batch<T>(statements);
    },
  };
  env = { DB: instrumented as D1Database, APP_ENV: 'staging' } as Env;
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
});

describe('bounded D1 backup imports', () => {
  it('round-trips a multi-megabyte editable export in one atomic batch with small parameters', async () => {
    const source = backup('large', 200);
    expect(new TextEncoder().encode(JSON.stringify(source)).length).toBeGreaterThan(2_000_000);
    boundBytes.length = 0;
    batchSizes.length = 0;
    await adminApi(request('/api/admin/import', source), env);
    expect(batchSizes).toHaveLength(1);
    expect(batchSizes[0]).toBeGreaterThan(3);
    expect(batchSizes[0] + 2).toBeLessThanOrEqual(50);
    expect(Math.max(...boundBytes)).toBeLessThanOrEqual(512 * 1024);

    // Automatic observations may be large or stale and are not editable backup data.
    await database
      .prepare("UPDATE links SET observedTitle='Observation', healthStatus='healthy' WHERE id=?")
      .bind('large-0')
      .run();
    const exported = await (await adminApi(request('/api/admin/export'), env)).text();
    expect(new TextEncoder().encode(exported).length).toBeGreaterThan(1024 * 1024);
    expect(new TextEncoder().encode(exported).length).toBeLessThan(IMPORT_MAX_BYTES);
    const parsed = JSON.parse(exported);
    expect(parsed.links).toHaveLength(200);
    expect(parsed.links[0]).not.toHaveProperty('observedTitle');
    expect(parsed.links[0]).not.toHaveProperty('healthStatus');
    expect(parsed.links[0]).not.toHaveProperty('healthEvidence');
    expect(parsed.links[0]).not.toHaveProperty('lastCheckedAt');
    expect(parsed.categories[0]).not.toHaveProperty('updatedAt');

    await database.prepare('DELETE FROM links').run();
    await database.prepare('DELETE FROM categories').run();
    boundBytes.length = 0;
    batchSizes.length = 0;
    await adminApi(request('/api/admin/import', parsed), env);
    expect(batchSizes).toHaveLength(1);
    expect(batchSizes[0] + 2).toBeLessThanOrEqual(50);
    expect(Math.max(...boundBytes)).toBeLessThanOrEqual(512 * 1024);
    const restored = await database
      .prepare(
        'SELECT notes,description,expectedKeywords,icon,healthOverride,healthStatus FROM links WHERE id=?',
      )
      .bind('large-199')
      .first();
    expect(restored).toEqual({
      notes: source.links[199].notes,
      description: source.links[199].description,
      expectedKeywords: JSON.stringify(source.links[199].expectedKeywords),
      icon: '工具',
      healthOverride: 'needs_review',
      healthStatus: 'unknown',
    });
  });

  it('rolls back earlier chunks and the category if a late chunk conflicts', async () => {
    await adminApi(request('/api/admin/import', backup('existing', 1)), env);
    const initial = await database.prepare('SELECT count(*) AS total FROM audit_events').first();
    const source = backup('rollback', 200);
    source.links[199].url = 'https://example.com/existing/0';
    batchSizes.length = 0;
    await expect(adminApi(request('/api/admin/import', source), env)).rejects.toThrow('UNIQUE');
    expect(batchSizes).toHaveLength(1);
    expect(batchSizes[0]).toBeGreaterThan(3);
    expect(
      await database
        .prepare("SELECT count(*) AS total FROM links WHERE categoryId='rollback'")
        .first(),
    ).toEqual({ total: 0 });
    expect(
      await database.prepare("SELECT id FROM categories WHERE id='rollback'").first(),
    ).toBeNull();
    expect(await database.prepare('SELECT count(*) AS total FROM audit_events').first()).toEqual(
      initial,
    );
  });

  it('keeps a near-limit 1000-link import below the Free-plan query budget', async () => {
    const source = backup('capacity', 1000);
    for (const link of source.links) {
      link.notes = '密'.repeat(2500);
      link.description = '';
      link.expectedKeywords = [];
    }
    const bytes = new TextEncoder().encode(JSON.stringify(source)).length;
    expect(bytes).toBeGreaterThan(7 * 1024 * 1024);
    expect(bytes).toBeLessThan(IMPORT_MAX_BYTES);
    boundBytes.length = 0;
    batchSizes.length = 0;
    await adminApi(request('/api/admin/import', source), env);
    expect(batchSizes).toHaveLength(1);
    expect(batchSizes[0] + 2).toBeLessThanOrEqual(50);
    expect(Math.max(...boundBytes)).toBeLessThanOrEqual(512 * 1024);
    expect(
      await database
        .prepare("SELECT count(*) AS total FROM links WHERE categoryId='capacity'")
        .first(),
    ).toEqual({ total: 1000 });
  });

  it('enforces the same 8 MiB limit with and without Content-Length', async () => {
    const headers = { 'Content-Type': 'application/json' };
    const declared = new Request(origin + '/api/admin/import', {
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(IMPORT_MAX_BYTES + 1) },
      body: '{}',
    });
    await expect(adminApi(declared, env)).rejects.toMatchObject({ status: 413 });
    const streamed = new Request(origin + '/api/admin/import', {
      method: 'POST',
      headers,
      body: ' '.repeat(IMPORT_MAX_BYTES + 1),
    });
    await expect(adminApi(streamed, env)).rejects.toMatchObject({ status: 413 });
  });

  it('only accepts normalized URLs that remain valid when exported and imported again', () => {
    const base = backup('url', 1).links[0];
    const valid = linkSchema.parse({ ...base, url: 'https://example.com/中文#说明' });
    expect(linkSchema.parse(valid)).toEqual(valid);
    expect(() =>
      linkSchema.parse({ ...base, url: `https://example.com/${'中'.repeat(300)}` }),
    ).toThrow('2048');
  });
});
