import { ProbeDeferred, ProbeError } from './types';

const LEASE_KEY = 'healthRunLease';
// Two 60-second probes, short cooldowns and DB headroom; below Cron's 15 minutes.
export const HEALTH_LEASE_MS = 240_000;
const MAX_PROBE_MS = 60_000;
export const MAX_HEALTH_WAIT_MS = 10_000;

interface LeaseState {
  owner: string;
  expiresAt: number;
  lastRequestAt: number;
  lastIntervalSeconds?: number;
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** A single D1 lease serializes manual and Cron probes across Worker isolates. */
export async function acquireHealthLease(db: D1Database, intervalSeconds: number) {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const claimed = await db
    .prepare(
      `INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=json_set(metadata.value,'$.owner',?,'$.expiresAt',?) WHERE CAST(json_extract(metadata.value,'$.expiresAt') AS INTEGER)<=?`,
    )
    .bind(
      LEASE_KEY,
      JSON.stringify({ owner, expiresAt: now + HEALTH_LEASE_MS, lastRequestAt: 0 }),
      owner,
      now + HEALTH_LEASE_MS,
      now,
    )
    .run();
  if (!claimed.meta.changes) return null;

  async function waitUntilReady(
    signal?: AbortSignal,
    interval = intervalSeconds,
    maxWaitMs = MAX_HEALTH_WAIT_MS,
  ) {
    const row = await db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .bind(LEASE_KEY)
      .first<{ value: string }>();
    const state = row ? (JSON.parse(row.value) as LeaseState) : null;
    if (!state || state.owner !== owner || state.expiresAt <= Date.now())
      throw new ProbeDeferred(Math.max(Date.now(), state?.expiresAt || Date.now()));
    const nextRequestAt = state.lastRequestAt
      ? state.lastRequestAt + Math.max(interval, state.lastIntervalSeconds || 0) * 1000
      : 0;
    const delay = Math.max(0, nextRequestAt - Date.now());
    // Persist a wake time instead of sleeping through a long interval or spending
    // all of a site's active deadline before its next redirect can even begin.
    if (
      delay > Math.min(MAX_HEALTH_WAIT_MS, maxWaitMs) ||
      Date.now() + delay + MAX_PROBE_MS >= state.expiresAt
    )
      throw new ProbeDeferred(
        Math.max(
          nextRequestAt,
          state.expiresAt <= Date.now() + delay + MAX_PROBE_MS ? state.expiresAt : 0,
        ),
      );
    await pause(delay, signal);
    if (signal?.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
  }

  return {
    waitUntilReady,
    async beforeRequest(
      signal: AbortSignal,
      interval = intervalSeconds,
      remainingMs = MAX_PROBE_MS,
    ) {
      await waitUntilReady(signal, interval, Math.max(0, remainingMs - 1));
      const now = Date.now();
      const marked = await db
        .prepare(
          `UPDATE metadata SET value=json_set(value,'$.lastRequestAt',?,'$.lastIntervalSeconds',?) WHERE key=? AND json_extract(value,'$.owner')=? AND CAST(json_extract(value,'$.expiresAt') AS INTEGER)>?`,
        )
        // Never start a request that could outlive the lease and overlap a new owner.
        .bind(now, interval, LEASE_KEY, owner, now + MAX_PROBE_MS)
        .run();
      if (!marked.meta.changes) throw new ProbeDeferred(now + MAX_PROBE_MS);
      if (signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
    },
    async release() {
      // Preserve previous request time and cooldown across invocation boundaries.
      await db
        .prepare(
          `UPDATE metadata SET value=json_set(value,'$.expiresAt',0) WHERE key=? AND json_extract(value,'$.owner')=?`,
        )
        .bind(LEASE_KEY, owner)
        .run();
    },
  };
}
