import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/shared/types';
import type { HealthResult } from '../src/health';

const probe = vi.hoisted(() => vi.fn());
vi.mock('../src/health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/health')>()),
  checkLink: probe,
}));
vi.mock('../src/icons', () => ({
  discoverIcon: vi.fn(async () => ({
    icon: '',
    status: 'not_found',
    source: null,
    checkedAt: new Date().toISOString(),
  })),
}));

import { adminApi, catalog } from '../src/api/catalog';
import { readJson } from '../src/api/security';
import { linkSchema } from '../src/api/validation';
import { runChecks } from '../src/worker/scheduler';

// Execute the real queries against SQLite, with atomic batch rollback and a hook
// for deterministic edit/delete races. No external network is used in these tests.
class SqliteD1 {
  database = new DatabaseSync(':memory:');
  before: ((sql: string) => void) | null = null;
  calls = 0;
  constructor() {
    this.database.exec('PRAGMA foreign_keys=ON');
    for (const migration of readdirSync('migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort())
      this.database.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  }
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  async batch(statements: Statement[]) {
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
class Statement {
  values: SQLInputValue[] = [];
  constructor(
    readonly db: SqliteD1,
    readonly sql: string,
  ) {}
  bind(...values: SQLInputValue[]) {
    this.values = values;
    return this;
  }
  execute() {
    this.db.calls++;
    this.db.before?.(this.sql);
    const results = this.db.database.prepare(this.sql).all(...this.values);
    const changes = Number(this.db.database.prepare('SELECT changes() AS count').get()!.count);
    return { results, success: true, meta: { changes } };
  }
  async all() {
    return this.execute();
  }
  async run() {
    return this.execute();
  }
  async first() {
    return this.execute().results[0] || null;
  }
}

let db: SqliteD1;
let env: Env;
const origin = 'https://nav.lily.lat';
const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const link = { id: 'link', categoryId: 'category', name: 'Example', url: 'https://example.com/' };
const success: HealthResult = {
  status: 'healthy',
  httpStatus: 200,
  finalUrl: link.url,
  title: 'Example original service',
  description: '',
  contentStatus: 'match',
  similarityScore: 100,
  evidence: ['identity'],
  error: null,
  redirects: [],
  checkedAt: '2026-10-02T00:00:00.000Z',
  durationMs: 50,
  bodyTruncated: false,
  consecutiveFailures: 0,
  nextCheckAt: '2026-10-03T00:00:00.000Z',
  isSuccess: true,
};
const row = () => db.database.prepare('SELECT * FROM links WHERE id=?').get('link')!;
async function seed() {
  await adminApi(
    request('/api/admin/categories', 'POST', { id: 'category', name: 'Tools', slug: 'tools' }),
    env,
  );
  await adminApi(request('/api/admin/links', 'POST', link), env);
}
beforeEach(() => {
  db = new SqliteD1();
  env = {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    APP_ENV: 'staging',
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'audience',
    ADMIN_EMAIL_HASH: 'unused',
  };
  probe.mockReset().mockResolvedValue({ ...success });
});
afterEach(() => db.database.close());

describe('health lifecycle race and evidence review', () => {
  it('keeps the confirmed identity baseline across bot challenges', async () => {
    await seed();
    await runChecks(env, 'link');
    expect(row().confirmedTitle).toBe(success.title);
    probe.mockResolvedValue({
      ...success,
      status: 'challenge',
      title: 'Just a moment',
      isSuccess: false,
    });
    await runChecks(env, 'link');
    expect(row().observedTitle).toBe('Just a moment');
    expect(row().confirmedTitle).toBe(success.title);
    expect(row().lastFailureAt).toBeNull();
    expect(probe.mock.calls[1]![0].previousTitle).toBe(success.title);
    const publicData = await catalog(env);
    expect(publicData.links[0]).not.toHaveProperty('confirmedTitle');
  });

  it('clears all previous URL evidence on edits and schedules a fresh check', async () => {
    await seed();
    await runChecks(env, 'link');
    await adminApi(
      request('/api/admin/links/link', 'PUT', { ...link, url: 'https://example.org/' }),
      env,
    );
    const current = row();
    expect(current.healthStatus).toBe('unknown');
    for (const key of [
      'httpStatus',
      'finalUrl',
      'lastCheckedAt',
      'lastSuccessAt',
      'lastFailureAt',
      'lastError',
      'observedTitle',
      'confirmedTitle',
      'checkLeaseUntil',
    ])
      expect(current[key]).toBeNull();
    expect(current.consecutiveFailures).toBe(0);
    expect(current.healthEvidence).toBe('[]');
    expect(current.nextCheckAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('preserves health for cosmetic edits and invalidates it for identity-keyword edits', async () => {
    await seed();
    await runChecks(env, 'link');
    await adminApi(
      request('/api/admin/links/link', 'PUT', { ...link, notes: 'updated note' }),
      env,
    );
    expect(row().healthStatus).toBe('healthy');
    await adminApi(
      request('/api/admin/links/link', 'PUT', { ...link, expectedKeywords: ['New identity'] }),
      env,
    );
    expect(row().healthStatus).toBe('unknown');
    expect(row().confirmedTitle).toBeNull();
  });

  it('drops both result and history when an administrator edits during a probe', async () => {
    await seed();
    probe.mockImplementation(async () => {
      await adminApi(
        request('/api/admin/links/link', 'PUT', { ...link, checkDisabled: true }),
        env,
      );
      return { ...success };
    });
    expect(await runChecks(env, 'link')).toEqual([]);
    expect(row().healthStatus).toBe('unknown');
    expect(row().checkDisabled).toBe(1);
    expect(db.database.prepare('SELECT count(*) AS total FROM health_history').get()!.total).toBe(
      0,
    );
  });

  it('does not probe a snapshot edited between selection and lease acquisition', async () => {
    await seed();
    db.before = (sql) => {
      if (sql.startsWith('UPDATE links SET checkLeaseUntil=')) {
        db.before = null;
        db.database.exec("UPDATE links SET url='https://example.org/',updatedAt='changed'");
      }
    };
    expect(await runChecks(env, 'link')).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not overlap concurrent probes for the same link', async () => {
    await seed();
    let release!: (result: HealthResult) => void;
    probe.mockImplementation(
      () =>
        new Promise<HealthResult>((resolve) => {
          release = resolve;
        }),
    );
    const first = runChecks(env, 'link');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    expect(await runChecks(env, 'link')).toEqual([]);
    release({ ...success });
    expect(await first).toEqual([{ id: 'link', status: 'healthy' }]);
  });

  it('serializes manual and Cron probes across different links', async () => {
    await seed();
    await adminApi(
      request('/api/admin/links', 'POST', { ...link, id: 'other', url: 'https://example.org/' }),
      env,
    );
    let release!: (result: HealthResult) => void;
    probe.mockImplementation(
      () =>
        new Promise<HealthResult>((resolve) => {
          release = resolve;
        }),
    );
    const first = runChecks(env, 'link');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    expect(await runChecks(env, 'other')).toEqual([]);
    expect(await runChecks(env)).toEqual([]);
    expect(probe).toHaveBeenCalledOnce();
    release({ ...success });
    await first;
    probe.mockResolvedValue({ ...success });
    expect(await runChecks(env, 'other')).toEqual([{ id: 'other', status: 'healthy' }]);
  });

  it('cannot delete a newer owner job after the original lease expires', async () => {
    await seed();
    vi.useFakeTimers();
    try {
      const releases: ((result: HealthResult) => void)[] = [];
      probe.mockImplementation(
        () =>
          new Promise<HealthResult>((resolve) => {
            releases.push(resolve);
          }),
      );
      const oldRun = runChecks(env, 'link');
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(240_001);
      const newRun = runChecks(env, 'link');
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(2);
      const newLease = row().checkLeaseUntil;
      releases[0]!({ ...success });
      expect(await oldRun).toEqual([]);
      expect(row().checkLeaseUntil).toBe(newLease);
      expect(db.database.prepare('SELECT linkId FROM health_jobs').get()!.linkId).toBe('link');
      releases[1]!({ ...success });
      expect(await newRun).toEqual([{ id: 'link', status: 'healthy' }]);
      expect(db.database.prepare('SELECT linkId FROM health_jobs').get()).toBeUndefined();
      expect(db.database.prepare('SELECT count(*) AS total FROM health_history').get()!.total).toBe(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes saved configuration to manual and Cron and persists used values in history', async () => {
    await seed();
    const settings = {
      allowIndexing: false,
      healthUserAgent: 'Owner-health/2.0',
      healthIntervalSeconds: 10,
      healthTimeoutSeconds: 2,
    };
    db.database
      .prepare("INSERT INTO metadata(key,value) VALUES('siteSettings',?)")
      .run(JSON.stringify(settings));
    await runChecks(env, 'link');
    db.database.prepare("UPDATE links SET nextCheckAt='1970-01-01T00:00:00.000Z'").run();
    await runChecks(env);
    for (const call of probe.mock.calls) {
      expect(call[1]).toMatchObject({
        runtime: 'cloudflare-public',
        userAgent: settings.healthUserAgent,
        timeoutMs: 2000,
      });
      expect(typeof call[1].beforeRequest).toBe('function');
    }
    const history = db.database.prepare('SELECT * FROM health_history').all();
    expect(history).toHaveLength(2);
    for (const entry of history)
      expect(entry).toMatchObject({
        probeUserAgent: settings.healthUserAgent,
        probeIntervalSeconds: 10,
        probeTimeoutSeconds: 2,
        contentStatus: 'match',
        similarityScore: 100,
        redirectChain: '[]',
      });
  });

  it('keeps a worst-case two-link Cron with four requests per link within D1 Free query limits', async () => {
    await seed();
    for (let index = 1; index < 2; index++)
      await adminApi(
        request('/api/admin/links', 'POST', {
          ...link,
          id: `extra-${index}`,
          url: `https://example.com/${index}`,
        }),
        env,
      );
    vi.useFakeTimers();
    try {
      probe.mockImplementation(async (_input, options) => {
        for (let hop = 0; hop < 4; hop++) await options.beforeRequest(new AbortController().signal);
        return { ...success };
      });
      db.calls = 0;
      const pending = runChecks(env);
      await vi.runAllTimersAsync();
      expect(await pending).toHaveLength(2);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(db.calls).toBe(38);
      expect(db.calls).toBeLessThanOrEqual(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overwrites explicit baselines or advances a confirmed title automatically', async () => {
    await seed();
    db.database
      .prepare(
        "UPDATE links SET expectedTitle='Owner original title', expectedDescription='Original purpose', confirmedTitle='Previously confirmed title'",
      )
      .run();
    await runChecks(env, 'link');
    expect(probe.mock.calls[0]![0]).toMatchObject({
      expectedTitle: 'Owner original title',
      expectedDescription: 'Original purpose',
      previousTitle: 'Previously confirmed title',
    });
    expect(row()).toMatchObject({
      expectedTitle: 'Owner original title',
      expectedDescription: 'Original purpose',
      confirmedTitle: 'Previously confirmed title',
      observedTitle: success.title,
    });
  });

  it('drops a stale result after a same-URL baseline edit during a probe', async () => {
    await seed();
    probe.mockImplementation(async () => {
      await adminApi(
        request('/api/admin/links/link', 'PUT', { ...link, expectedTitle: 'New expected site' }),
        env,
      );
      return { ...success };
    });
    expect(await runChecks(env, 'link')).toEqual([]);
    expect(row()).toMatchObject({
      expectedTitle: 'New expected site',
      contentStatus: 'unknown',
      similarityScore: null,
    });
    expect(db.database.prepare('SELECT count(*) AS total FROM health_history').get()!.total).toBe(
      0,
    );
  });
});

describe('atomic backups and category integrity', () => {
  it('imports 1000 links in a fixed number of D1 statements', async () => {
    const payload = {
      version: 1,
      categories: [{ id: 'category', name: 'Tools', slug: 'tools' }],
      links: Array.from({ length: 1000 }, (_, i) => ({
        ...link,
        id: `link-${i}`,
        url: `https://example.com/${i}`,
      })),
    };
    await adminApi(request('/api/admin/import', 'POST', payload), env);
    expect(db.database.prepare('SELECT count(*) AS total FROM links').get()!.total).toBe(1000);
    expect(db.calls).toBeLessThan(10);
  });

  it('rolls back the entire import when a link violates URL uniqueness', async () => {
    await seed();
    await expect(
      adminApi(
        request('/api/admin/import', 'POST', {
          version: 1,
          categories: [{ id: 'other', name: 'Other', slug: 'other' }],
          links: [{ ...link, id: 'duplicate', categoryId: 'other' }],
        }),
        env,
      ),
    ).rejects.toThrow('UNIQUE');
    expect(db.database.prepare("SELECT id FROM categories WHERE id='other'").get()).toBeUndefined();
    expect(db.database.prepare('SELECT count(*) AS total FROM links').get()!.total).toBe(1);
  });

  it('round-trips backup data and resets stale evidence when an imported URL changes', async () => {
    await seed();
    await runChecks(env, 'link');
    const backup = (await (await adminApi(request('/api/admin/export'), env)).json()) as {
      version: number;
      links: Record<string, unknown>[];
    };
    await adminApi(request('/api/admin/import', 'POST', backup), env);
    expect(row().healthStatus).toBe('healthy');
    backup.links[0]!.url = 'https://example.org/';
    await adminApi(request('/api/admin/import', 'POST', backup), env);
    expect(row().healthStatus).toBe('unknown');
    expect(row().confirmedTitle).toBeNull();
    expect(row().finalUrl).toBeNull();
  });

  it('requires category restoration before restoring a deleted link', async () => {
    await seed();
    await adminApi(request('/api/admin/links/link', 'DELETE'), env);
    await adminApi(request('/api/admin/categories/category', 'DELETE'), env);
    await expect(
      adminApi(request('/api/admin/links/link/restore', 'POST', {}), env),
    ).rejects.toThrow('恢复');
    await adminApi(request('/api/admin/categories/category/restore', 'POST', {}), env);
    await adminApi(request('/api/admin/links/link/restore', 'POST', {}), env);
    expect((await catalog(env, true)).links).toHaveLength(1);
    await expect(
      adminApi(request('/api/admin/links/missing/restore', 'POST', {}), env),
    ).rejects.toThrow('不存在');
  });

  it('rejects category deletion if a link is created after the preflight', async () => {
    await seed();
    await adminApi(request('/api/admin/links/link', 'DELETE'), env);
    db.before = (sql) => {
      if (sql.startsWith('UPDATE categories SET deletedAt=')) {
        db.before = null;
        db.database.exec('UPDATE links SET deletedAt=NULL');
      }
    };
    await expect(
      adminApi(request('/api/admin/categories/category', 'DELETE'), env),
    ).rejects.toThrow('变化');
    expect(db.database.prepare('SELECT deletedAt FROM categories').get()!.deletedAt).toBeNull();
  });

  it('rejects link creation if its category is deleted after the preflight', async () => {
    await seed();
    await adminApi(request('/api/admin/links/link', 'DELETE'), env);
    db.before = (sql) => {
      if (sql.startsWith('INSERT INTO links(')) {
        db.before = null;
        db.database.exec("UPDATE categories SET deletedAt='deleted'");
      }
    };
    await expect(
      adminApi(request('/api/admin/links', 'POST', { ...link, id: 'raced' }), env),
    ).rejects.toThrow('NOT NULL');
    expect(db.database.prepare("SELECT id FROM links WHERE id='raced'").get()).toBeUndefined();
  });

  it('does not interpret DELETE on a restore route as a normal deletion', async () => {
    await seed();
    await expect(adminApi(request('/api/admin/links/link/restore', 'DELETE'), env)).rejects.toThrow(
      '方法',
    );
    expect(row().deletedAt).toBeNull();
  });
});

describe('request and icon validation review', () => {
  it('preserves URL fragments used by single-page apps across edits and exports', async () => {
    await seed();
    await adminApi(
      request('/api/admin/links/link', 'PUT', {
        ...link,
        url: 'https://example.com/#/tools?tab=design',
      }),
      env,
    );
    expect(row().url).toBe('https://example.com/#/tools?tab=design');
    expect((await catalog(env)).links[0]!.url).toBe('https://example.com/#/tools?tab=design');
  });
  it('rejects content-type prefixes that are not application/json', async () => {
    await expect(
      readJson(
        new Request(origin, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json-evil' },
          body: '{}',
        }),
      ),
    ).rejects.toThrow('JSON');
  });
  it.each([
    'https://127.0.0.1/icon',
    'https://localhost/icon',
    'https://user:pass@example.com/icon',
    'https://example.com:8443/icon',
  ])('rejects unsafe external icon %s', (icon) => {
    expect(linkSchema.safeParse({ ...link, icon }).success).toBe(false);
  });
});
