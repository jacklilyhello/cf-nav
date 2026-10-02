import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireHealthLease } from '../src/health/lease';

// Exercise the lease's conditional SQL against SQLite rather than a canned D1 mock.
class LeaseDatabase {
  database = new DatabaseSync(':memory:');
  constructor() {
    this.database.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  prepare(sql: string) {
    const database = this.database;
    let values: SQLInputValue[] = [];
    return {
      bind(...bound: SQLInputValue[]) {
        values = bound;
        return this;
      },
      async run() {
        return { meta: { changes: Number(database.prepare(sql).run(...values).changes) } };
      },
      async first() {
        return database.prepare(sql).get(...values) || null;
      },
    };
  }
}

let db: LeaseDatabase;
const signal = () => new AbortController().signal;
const claim = (interval = 2) => acquireHealthLease(db as unknown as D1Database, interval);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
  db = new LeaseDatabase();
});
afterEach(() => {
  db.database.close();
  vi.useRealTimers();
});

describe('persistent pacing shared by manual and scheduled checks', () => {
  it('admits only one concurrent run even when acquisitions race', async () => {
    const leases = await Promise.all([claim(), claim(), claim()]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    await leases.find(Boolean)!.release();
    expect(await claim()).not.toBeNull();
  });

  it('spaces redirected requests and preserves pacing across invocation boundaries', async () => {
    const first = (await claim())!;
    await first.beforeRequest(signal());
    let completed = false;
    const redirect = first.beforeRequest(signal()).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await redirect;
    await first.release();
    const second = (await claim(5))!;
    completed = false;
    const next = second.beforeRequest(signal()).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(completed).toBe(true);
  });

  it('waits the initial cooldown before starting a short site timeout', async () => {
    const first = (await claim(10))!;
    await first.beforeRequest(signal());
    await first.release();
    const second = (await claim(10))!;
    const ready = second.waitUntilReady();
    await vi.advanceTimersByTimeAsync(10_000);
    await ready;
    const before = Date.now();
    await second.beforeRequest(signal());
    expect(Date.now()).toBe(before);
  });

  it('aborts pacing without recording a target request that never happened', async () => {
    const lease = (await claim(10))!;
    await lease.beforeRequest(signal());
    const before = db.database.prepare('SELECT value FROM metadata').get()!.value;
    const controller = new AbortController();
    const pending = lease.beforeRequest(controller.signal);
    const rejected = expect(pending).rejects.toThrow('PROBE_DEADLINE_EXCEEDED');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    expect(db.database.prepare('SELECT value FROM metadata').get()!.value).toBe(before);
  });

  it('recovers an expired lease without allowing the previous owner to release the new one', async () => {
    const first = (await claim())!;
    await vi.advanceTimersByTimeAsync(120_000);
    const second = await claim();
    expect(second).not.toBeNull();
    await expect(first.beforeRequest(signal())).rejects.toThrow('HEALTH_RUN_LEASE_EXPIRED');
    await first.release();
    expect(await claim()).toBeNull();
    await second!.release();
    expect(await claim()).not.toBeNull();
  });

  it('refuses a new target request when the lease cannot cover its maximum timeout', async () => {
    const lease = (await claim())!;
    await vi.advanceTimersByTimeAsync(100_001);
    await expect(lease.beforeRequest(signal())).rejects.toThrow('HEALTH_RUN_LEASE_EXPIRED');
    expect(await claim()).toBeNull();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(await claim()).not.toBeNull();
  });
});
