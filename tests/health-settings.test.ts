import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireHealthLease, HEALTH_LEASE_MS } from '../src/health/lease';

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
    await vi.advanceTimersByTimeAsync(HEALTH_LEASE_MS);
    const second = await claim();
    expect(second).not.toBeNull();
    await expect(first.beforeRequest(signal())).rejects.toThrow('HEALTH_REQUEST_DEFERRED');
    await first.release();
    expect(await claim()).toBeNull();
    await second!.release();
    expect(await claim()).not.toBeNull();
  });

  it('refuses a new target request when the lease cannot cover its maximum timeout', async () => {
    const lease = (await claim())!;
    await vi.advanceTimersByTimeAsync(HEALTH_LEASE_MS - 60_000);
    await expect(lease.beforeRequest(signal())).rejects.toThrow('HEALTH_REQUEST_DEFERRED');
    expect(await claim()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await claim()).not.toBeNull();
  });
  it('defers a 3600-second cooldown without creating any long-lived timer', async () => {
    const first = (await claim(3600))!;
    await first.beforeRequest(signal());
    const requestedAt = Date.now();
    await first.release();
    const second = (await claim(3600))!;
    await expect(second.waitUntilReady()).rejects.toMatchObject({
      nextRequestAt: requestedAt + 3_600_000,
    });
    expect(vi.getTimerCount()).toBe(0);
    await second.release();
    vi.setSystemTime(requestedAt + 3_599_999);
    const early = (await claim(3600))!;
    let completed = false;
    const request = early.beforeRequest(signal()).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await request;
    expect(completed).toBe(true);
    const state = JSON.parse(
      String(db.database.prepare('SELECT value FROM metadata').get()!.value),
    );
    expect(state.lastRequestAt).toBe(requestedAt + 3_600_000);
  });

  it('retains an already reserved long cooldown when new settings shorten the interval', async () => {
    const first = (await claim(3600))!;
    await first.beforeRequest(signal());
    const requestedAt = Date.now();
    await first.release();
    const second = (await claim(1))!;
    await expect(second.beforeRequest(signal())).rejects.toMatchObject({
      nextRequestAt: requestedAt + 3_600_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defers a redirect when cooldown would consume the whole remaining deadline', async () => {
    const lease = (await claim(10))!;
    await lease.beforeRequest(signal());
    await expect(lease.beforeRequest(signal(), 10, 2000)).rejects.toMatchObject({
      nextRequestAt: Date.now() + 10_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
