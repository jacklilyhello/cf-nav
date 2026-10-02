import type { HealthStatus } from './types';

const FAILURES = new Set<HealthStatus>([
  'not_found',
  'gone',
  'server_error',
  'dns_error',
  'tls_error',
  'timeout',
  'connection_refused',
  'connection_error',
]);
const SUCCESS = new Set<HealthStatus>(['healthy', 'redirected', 'moved']);

export function isHealthFailure(status: HealthStatus): boolean {
  return FAILURES.has(status);
}

export function isHealthSuccess(status: HealthStatus): boolean {
  return SUCCESS.has(status);
}

/** No immediate retry storm and no permanent auto-disable after a transient failure. */
export function nextCheckAt(
  status: HealthStatus,
  failures: number,
  now: number,
  key: string,
): string {
  let hours = 168;
  if (isHealthSuccess(status)) hours = 24;
  else if (isHealthFailure(status)) hours = Math.min(72, 2 ** Math.min(7, Math.max(1, failures)));
  else if (['forbidden', 'bot_protection', 'challenge', 'rate_limited'].includes(status))
    hours = 48;
  else if (status === 'unknown') hours = 24;
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const jitter = ((hash >>> 0) % 1500) / 10_000;
  return new Date(now + hours * 3_600_000 * (1 + jitter)).toISOString();
}

// Four requests maximum per redirect chain, plus two DNS queries per hostname.
// Two sequential links leave room for durable job writes within D1 Free limits.
export const HEALTH_BATCH_SIZE = 2;
export const HEALTH_CRON = '* * * * *';
