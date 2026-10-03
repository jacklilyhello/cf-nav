import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { runChecks } from '../src/worker/scheduler';
import { acquireHealthLease, HEALTH_LEASE_MS } from '../src/health/lease';
import { DEFAULT_SETTINGS, settingsSchema } from '../src/api/settings';
import { adminApi, catalog } from '../src/api/catalog';
import type { Env } from '../src/shared/types';

// Actual SQLite conditional SQL, persistence and transactions across independent
// scheduler invocations. Only the public network is replaced, not the probe.
class SqliteD1 {
  database = new DatabaseSync(':memory:');
  latency: ((sql: string) => number) | null = null;
  constructor() {
    this.database.exec('PRAGMA foreign_keys=ON');
    for (const migration of readdirSync('migrations').sort())
      this.database.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  }
  prepare(sql: string) {
    const database = this.database;
    const queryLatency = () => this.latency?.(sql) || 0;
    let values: SQLInputValue[] = [];
    const execute = () => {
      const results = database.prepare(sql).all(...values);
      return {
        results,
        meta: { changes: Number(database.prepare('SELECT changes() AS n').get()!.n) },
      };
    };
    return {
      bind(...bound: SQLInputValue[]) {
        values = bound;
        return this;
      },
      execute,
      async first() {
        return execute().results[0] || null;
      },
      async all() {
        return execute();
      },
      async run() {
        const latency = queryLatency();
        if (latency) await delay(latency);
        return execute();
      },
    };
  }
  async batch(statements: { execute: () => unknown }[]) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
let db: SqliteD1;
let env: Env;
const startedAt = Date.parse('2026-10-03T00:00:00.000Z');
const targetCalls: { url: string; time: number; ua: string | null }[] = [];
let target: (request: Request, init?: RequestInit) => Promise<Response>;
let dnsDelay = 0;
let dnsAddress = '93.184.215.14';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const html = () =>
  new Response(
    '<title>Example service</title><main>Original purpose: Example service provides stable documentation, useful examples and reliable public resources.</main>',
    { headers: { 'content-type': 'text/html' } },
  );
const settings = (interval = 3600, timeout = 60) => ({
  ...DEFAULT_SETTINGS,
  healthUserAgent: 'Snapshot-probe/1.0',
  healthIntervalSeconds: interval,
  healthTimeoutSeconds: timeout,
});
function saveSettings(interval = 3600, timeout = 60) {
  db.database
    .prepare(
      "INSERT INTO metadata(key,value) VALUES('siteSettings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(JSON.stringify(settings(interval, timeout)));
}
function seed() {
  db.database
    .prepare("INSERT INTO categories(id,name,slug,updatedAt) VALUES('cat','Tools','tools',?)")
    .run(new Date().toISOString());
  db.database
    .prepare(
      "INSERT INTO links(id,categoryId,name,url,updatedAt,expectedKeywords,expectedTitle,expectedDescription,iconMode) VALUES('site','cat','Example','https://example.com/',?,'[\"Example\"]','Example service','Original purpose','none')",
    )
    .run(new Date().toISOString());
}
const job = () => db.database.prepare('SELECT * FROM health_jobs').get();
const history = () => db.database.prepare('SELECT * FROM health_history').all();
const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(`https://nav.lily.lat${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(startedAt);
  db = new SqliteD1();
  env = { DB: db as unknown as D1Database, APP_ENV: 'staging' } as Env;
  targetCalls.length = 0;
  dnsDelay = 0;
  dnsAddress = '93.184.215.14';
  target = async () => html();
  // Zero-delay DNS must not require advancing timers in tests that make no waits.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === 'cloudflare-dns.com') {
        if (dnsDelay) await delay(dnsDelay);
        const name = url.searchParams.get('name')!;
        const type = Number(url.searchParams.get('type'));
        return Response.json({
          Status: 0,
          Question: [{ name: `${name}.`, type }],
          Answer: type === 1 ? [{ name, type, data: dnsAddress }] : [],
        });
      }
      targetCalls.push({
        url: request.url,
        time: Date.now(),
        ua: request.headers.get('user-agent'),
      });
      return target(request, init);
    }),
  );
  seed();
  saveSettings();
});
afterEach(() => {
  db.database.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('durable health scheduling and active deadlines', () => {
  it('resumes a 3600-second redirect in a different invocation, preserves evidence and captured settings', async () => {
    target = async (request) =>
      new URL(request.url).pathname === '/'
        ? new Response('', { status: 302, headers: { Location: '/arrived' } })
        : html();
    expect(await runChecks(env, 'site')).toEqual([]);
    expect(targetCalls).toHaveLength(1);
    expect(job()).toMatchObject({ manual: 1, nextRequestAt: startedAt + 3_600_000 });
    const cursor = JSON.parse(String(job()!.cursor));
    expect(cursor.redirects).toEqual([
      { url: 'https://example.com/', status: 302, location: 'https://example.com/arrived' },
    ]);
    expect(history()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    saveSettings(1, 2);
    vi.setSystemTime(startedAt + 3_599_999);
    await runChecks({ ...env });
    expect(targetCalls).toHaveLength(1);
    expect(
      db.database.prepare("SELECT value FROM metadata WHERE key='lastCronAt'").get()!.value,
    ).toBe(new Date().toISOString());
    vi.setSystemTime(startedAt + 3_600_000);
    expect(await runChecks({ ...env })).toEqual([{ id: 'site', status: 'redirected' }]);
    expect(targetCalls.map((request) => request.time)).toEqual([startedAt, startedAt + 3_600_000]);
    expect(targetCalls.every((request) => request.ua === 'Snapshot-probe/1.0')).toBe(true);
    expect(job()).toBeUndefined();
    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({
      probeIntervalSeconds: 3600,
      probeTimeoutSeconds: 60,
      redirectChain: JSON.stringify(cursor.redirects),
      checkedAt: new Date(startedAt).toISOString(),
    });
    expect(
      db.database
        .prepare('SELECT expectedKeywords,expectedTitle,expectedDescription FROM links')
        .get(),
    ).toEqual({
      expectedKeywords: '["Example"]',
      expectedTitle: 'Example service',
      expectedDescription: 'Original purpose',
    });
  });

  it('rechecks DNS after an hour and blocks a host that now resolves to a private address', async () => {
    target = async () => new Response('', { status: 302, headers: { Location: '/arrived' } });
    await runChecks(env, 'site');
    expect(targetCalls).toHaveLength(1);
    dnsAddress = '127.0.0.1';
    vi.setSystemTime(startedAt + 3_600_000);
    expect(await runChecks(env)).toEqual([{ id: 'site', status: 'blocked' }]);
    expect(targetCalls).toHaveLength(1);
    expect(history()[0]).toMatchObject({
      status: 'blocked',
      httpStatus: 302,
      finalUrl: 'https://example.com/',
    });
    expect(String(history()[0]!.evidence)).toContain('DNS_NON_PUBLIC_ADDRESS');
  });

  it('rejects a malformed durable redirect cursor before any resumed egress', async () => {
    target = async () => new Response('', { status: 302, headers: { Location: '/arrived' } });
    await runChecks(env, 'site');
    const cursor = JSON.parse(String(job()!.cursor));
    cursor.visited = [];
    db.database.prepare('UPDATE health_jobs SET cursor=?').run(JSON.stringify(cursor));
    vi.mocked(fetch).mockClear();
    vi.setSystemTime(startedAt + 3_600_000);
    expect(await runChecks(env)).toEqual([{ id: 'site', status: 'blocked' }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(String(history()[0]!.evidence)).toContain('INVALID_HEALTH_CURSOR');
  });

  it('enforces remotely observed spacing despite unequal D1 commit latency', async () => {
    saveSettings(1, 60);
    let reservations = 0;
    db.latency = (sql) =>
      sql.includes("'$.lastIntervalSeconds'") ? (++reservations === 1 ? 300 : 20) : 0;
    target = async (request) => {
      await delay(20);
      return new URL(request.url).pathname === '/'
        ? new Response('', { status: 302, headers: { Location: '/arrived' } })
        : html();
    };
    const pending = runChecks(env, 'site');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual([{ id: 'site', status: 'redirected' }]);
    expect(targetCalls).toHaveLength(2);
    expect(targetCalls[0]!.time).toBe(startedAt + 300);
    expect(targetCalls[1]!.time - targetCalls[0]!.time).toBeGreaterThanOrEqual(1000);
  });

  it('keeps remote spacing after a delayed reservation and failed completion write', async () => {
    let reservations = 0;
    let failCompletion = true;
    db.latency = (sql) => {
      if (sql.includes("'$.pendingUntil',0") && failCompletion) {
        failCompletion = false;
        throw new Error('simulated completion-write failure');
      }
      return sql.includes("'$.lastIntervalSeconds'") ? (++reservations === 1 ? 300 : 20) : 0;
    };
    const first = runChecks(env, 'site');
    const rejected = expect(first).rejects.toThrow('simulated completion-write failure');
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(targetCalls[0]!.time).toBe(startedAt + 300);
    vi.setSystemTime(startedAt + 3_600_300);
    expect(await runChecks({ ...env }, 'site')).toEqual([]);
    expect(targetCalls).toHaveLength(1);
    expect(job()!.nextRequestAt).toBe(startedAt + 3_660_000);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(startedAt + 3_660_000);
    const retry = runChecks({ ...env }, 'site');
    await vi.advanceTimersByTimeAsync(20);
    expect(await retry).toEqual([{ id: 'site', status: 'healthy' }]);
    expect(targetCalls[1]!.time - targetCalls[0]!.time).toBeGreaterThanOrEqual(3_600_000);
  });

  it('anchors the next cooldown after a terminal 60-second timeout, even if fetch ignores abort', async () => {
    saveSettings(1, 60);
    target = async () => new Promise(() => undefined);
    const pending = runChecks(env, 'site');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toEqual([{ id: 'site', status: 'timeout' }]);
    const state = JSON.parse(
      String(
        db.database.prepare("SELECT value FROM metadata WHERE key='healthRunLease'").get()!.value,
      ),
    );
    expect(state.lastRequestAt).toBe(startedAt + 60_000);
    expect(state.expiresAt).toBe(0);
  });

  it('retains the total 60-second budget across redirect resumes rather than restarting it', async () => {
    target = async (request) => {
      if (new URL(request.url).pathname === '/') {
        await delay(25_000);
        return new Response('', { status: 302, headers: { Location: '/arrived' } });
      }
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/html' } });
    };
    const first = runChecks(env, 'site');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await first).toEqual([]);
    expect(JSON.parse(String(job()!.cursor)).elapsedMs).toBe(25_000);
    vi.setSystemTime(startedAt + 3_625_000);
    const second = runChecks({ ...env });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(history()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toEqual([{ id: 'site', status: 'timeout' }]);
    expect(history()[0]).toMatchObject({ durationMs: 60_000, httpStatus: 200, status: 'timeout' });
    expect(JSON.parse(String(history()[0]!.redirectChain))).toHaveLength(1);
  });

  it('uses the configured 60 seconds on an actual target response that exceeds the old 20 seconds', async () => {
    saveSettings(1, 60);
    target = async () => {
      await delay(25_000);
      return html();
    };
    const pending = runChecks(env, 'site');
    await vi.advanceTimersByTimeAsync(24_999);
    expect(history()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ id: 'site', status: 'healthy' }]);
    expect(history()[0]).toMatchObject({ durationMs: 25_000, probeTimeoutSeconds: 60 });
  });

  it('aborts a target at 60 seconds and shares that deadline with DNS and HTML body work', async () => {
    saveSettings(1, 60);
    dnsDelay = 25_000;
    let aborted = false;
    target = async (_request, init) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/html' } });
    };
    const pending = runChecks(env, 'site');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(aborted).toBe(false);
    expect(targetCalls[0]!.time).toBe(startedAt + 25_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ id: 'site', status: 'timeout' }]);
    expect(aborted).toBe(true);
    expect(history()[0]).toMatchObject({ durationMs: 60_000, status: 'timeout' });
  });

  it('returns 202 for a busy manual request, exposes pending state only to admin and resumes after lease expiry', async () => {
    const lease = (await acquireHealthLease(env.DB, 3600))!;
    const response = await adminApi(request('/api/admin/links/site/check', 'POST'), env);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, queued: true, settings: settings() });
    expect((await catalog(env, true)).links[0]).toMatchObject({
      healthNextRequestAt: 0,
      healthPendingSettings: settings(),
    });
    expect((await catalog(env)).links[0]).not.toHaveProperty('healthPendingSettings');
    expect(targetCalls).toHaveLength(0);
    vi.setSystemTime(startedAt + HEALTH_LEASE_MS);
    await runChecks({ ...env });
    expect(history()).toHaveLength(1);
    await lease.release();
    expect(job()).toBeUndefined();
  });

  it.each(['url', 'expectedTitle', 'deletedAt', 'checkDisabled'])(
    'invalidates a pending cursor when %s changes without creating stale history',
    async (field) => {
      target = async () => new Response('', { status: 302, headers: { Location: '/arrived' } });
      await runChecks(env, 'site');
      const updates: Record<string, string | number> = {
        url: 'https://example.org/',
        expectedTitle: 'New owner identity',
        deletedAt: new Date().toISOString(),
        checkDisabled: 1,
      };
      db.database
        .prepare(`UPDATE links SET ${field}=?,updatedAt='new-snapshot'`)
        .run(updates[field]!);
      // Defer any fresh due check in this test; only stale cleanup is under examination.
      db.database.prepare("UPDATE links SET nextCheckAt='2099-01-01T00:00:00.000Z'").run();
      vi.setSystemTime(startedAt + 3_600_000);
      await runChecks(env);
      expect(targetCalls).toHaveLength(1);
      expect(history()).toHaveLength(0);
      expect(job()).toBeUndefined();
      expect((await catalog(env, true)).links[0]?.healthPendingSettings ?? null).toBeNull();
    },
  );
});

describe('health settings boundaries', () => {
  it.each([1, 3600])('accepts interval %s with a 60-second timeout', (healthIntervalSeconds) => {
    expect(
      settingsSchema.parse({ ...DEFAULT_SETTINGS, healthIntervalSeconds, healthTimeoutSeconds: 60 })
        .healthTimeoutSeconds,
    ).toBe(60);
  });
  it.each([0, 3601, 1.5, NaN, Infinity, '3600', null])(
    'rejects invalid interval %s',
    (healthIntervalSeconds) => {
      expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, healthIntervalSeconds }).success).toBe(
        false,
      );
    },
  );
  it.each([1, 61, 2.5, NaN, Infinity, '60', null])(
    'rejects invalid timeout %s',
    (healthTimeoutSeconds) => {
      expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, healthTimeoutSeconds }).success).toBe(
        false,
      );
    },
  );
});

describe('additive durable health migration', () => {
  it('preserves existing navigation, expected content, settings and health history', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(readFileSync('migrations/0001_initial.sql', 'utf8'));
      database.exec(readFileSync('migrations/0002_navigation_controls.sql', 'utf8'));
      database
        .prepare(
          "INSERT INTO categories(id,name,slug,updatedAt) VALUES('cat','Tools','tools','original')",
        )
        .run();
      database
        .prepare(
          "INSERT INTO links(id,categoryId,name,url,icon,updatedAt,expectedKeywords,expectedTitle,expectedDescription,iconMode) VALUES('site','cat','Example','https://example.com/','★','original','[\"Example\"]','Original title','Original purpose','manual')",
        )
        .run();
      database
        .prepare(
          "INSERT INTO health_history(linkId,status,evidence,checkedAt,durationMs,redirectChain) VALUES('site','challenge','[\"retained evidence\"]','2026-10-02T00:00:00.000Z',100,'[]')",
        )
        .run();
      database
        .prepare("INSERT INTO metadata(key,value) VALUES('siteSettings',?)")
        .run(JSON.stringify(DEFAULT_SETTINGS));
      const before = {
        categories: database.prepare('SELECT * FROM categories').all(),
        links: database.prepare('SELECT * FROM links').all(),
        history: database.prepare('SELECT * FROM health_history').all(),
        settings: database.prepare('SELECT * FROM metadata').all(),
      };
      database.exec(readFileSync('migrations/0003_health_jobs.sql', 'utf8'));
      expect(database.prepare('SELECT * FROM categories').all()).toEqual(before.categories);
      expect(database.prepare('SELECT * FROM links').all()).toEqual(before.links);
      expect(database.prepare('SELECT * FROM health_history').all()).toEqual(before.history);
      expect(database.prepare('SELECT * FROM metadata').all()).toEqual(before.settings);
      expect(database.prepare('SELECT * FROM health_jobs').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
