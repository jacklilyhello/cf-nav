import { ProbeError } from './types';

const LEASE_KEY = 'healthRunLease';
// Three sites * (20-second timeout + 10-second initial pacing), with DB headroom.
const LEASE_MS = 120_000;
const MAX_PROBE_MS = 20_000;

interface LeaseState {
  owner: string;
  expiresAt: number;
  lastRequestAt: number;
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
      JSON.stringify({ owner, expiresAt: now + LEASE_MS, lastRequestAt: 0 }),
      owner,
      now + LEASE_MS,
      now,
    )
    .run();
  if (!claimed.meta.changes) return null;

  async function waitUntilReady(signal?: AbortSignal) {
    const row = await db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .bind(LEASE_KEY)
      .first<{ value: string }>();
    const state = row ? (JSON.parse(row.value) as LeaseState) : null;
    if (!state || state.owner !== owner || state.expiresAt <= Date.now())
      throw new ProbeError('unknown', 'HEALTH_RUN_LEASE_EXPIRED');
    const delay = Math.max(0, state.lastRequestAt + intervalSeconds * 1000 - Date.now());
    if (Date.now() + delay >= state.expiresAt)
      throw new ProbeError('unknown', 'HEALTH_RUN_LEASE_EXPIRED');
    await pause(delay, signal);
    if (signal?.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
  }

  return {
    // Initial pacing happens before starting the per-site timeout, so a 10-second
    // interval and a 2-second timeout still allow a direct site to be checked.
    waitUntilReady,
    async beforeRequest(signal: AbortSignal) {
      await waitUntilReady(signal);
      const now = Date.now();
      const marked = await db
        .prepare(
          `UPDATE metadata SET value=json_set(value,'$.lastRequestAt',?) WHERE key=? AND json_extract(value,'$.owner')=? AND CAST(json_extract(value,'$.expiresAt') AS INTEGER)>?`,
        )
        // Never start a request that could outlive this lease and overlap a new owner.
        .bind(now, LEASE_KEY, owner, now + MAX_PROBE_MS)
        .run();
      if (!marked.meta.changes) throw new ProbeError('unknown', 'HEALTH_RUN_LEASE_EXPIRED');
      if (signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
    },
    async release() {
      // Preserve the previous request time so the next invocation observes pacing.
      await db
        .prepare(
          `UPDATE metadata SET value=json_set(value,'$.expiresAt',0) WHERE key=? AND json_extract(value,'$.owner')=?`,
        )
        .bind(LEASE_KEY, owner)
        .run();
    },
  };
}
