import { classifyPage } from './classify';
import { createDnsResolver, readBoundedBody } from './transport';
import { isHealthFailure, isHealthSuccess, nextCheckAt } from './schedule';
import {
  ProbeError,
  type HealthInput,
  type HealthOptions,
  type HealthResult,
  type HealthStatus,
} from './types';
import { hasUnsafeUrlCharacters, isPublicIp, validatePublicUrl } from './url';

export { classifyPage, extractPageEvidence } from './classify';
export { createDnsResolver, readBoundedBody } from './transport';
export {
  HEALTH_BATCH_SIZE,
  HEALTH_CRON,
  isHealthFailure,
  isHealthSuccess,
  nextCheckAt,
} from './schedule';
export { isPublicIp, validatePublicUrl } from './url';
export { HEALTH_STATUSES, ProbeError } from './types';
export type {
  DnsResolver,
  ContentStatus,
  HealthInput,
  HealthOptions,
  HealthResult,
  HealthStatus,
  RedirectHop,
} from './types';

const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 128 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function classifyError(error: unknown, timedOut: boolean): { status: HealthStatus; code: string } {
  if (timedOut) return { status: 'timeout', code: 'PROBE_DEADLINE_EXCEEDED' };
  if (error instanceof ProbeError) return { status: error.status, code: error.code };
  const message = error instanceof Error ? error.message : '';
  if (/certificate|\btls\b|\bssl\b/i.test(message))
    return { status: 'tls_error', code: 'TLS_CONNECTION_FAILED' };
  if (/ENOTFOUND|EAI_AGAIN|dns|name.*resolution/i.test(message))
    return { status: 'dns_error', code: 'DNS_LOOKUP_FAILED' };
  if (/ECONNREFUSED|connection refused/i.test(message))
    return { status: 'connection_refused', code: 'CONNECTION_REFUSED' };
  return { status: 'connection_error', code: 'CONNECTION_FAILED' };
}

/**
 * Run only on an originless Cloudflare Worker using global_fetch_strictly_public.
 * The platform's public-only network boundary handles DNS rebinding at connection
 * time. A/AAAA preflight cannot provide that guarantee by itself. In particular,
 * never reuse this checker with unrestricted Node fetch on a private network.
 * https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public
 * https://blog.cloudflare.com/workers-environment-live-object-bindings/
 */
export async function checkLink(input: HealthInput, options: HealthOptions): Promise<HealthResult> {
  const now = options.now || Date.now;
  const started = now();
  const result: HealthResult = {
    status: 'unknown',
    httpStatus: null,
    finalUrl: '',
    title: '',
    description: '',
    contentStatus: 'unknown',
    similarityScore: null,
    evidence: [],
    error: null,
    redirects: [],
    checkedAt: new Date(started).toISOString(),
    durationMs: 0,
    bodyTruncated: false,
    consecutiveFailures: input.consecutiveFailures || 0,
    nextCheckAt: '',
    isSuccess: false,
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetcher = options.fetcher || fetch;
  const resolveDns = options.resolver || createDnsResolver(fetcher);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED'));
      },
      Math.max(1, Math.min(options.timeoutMs ?? 12_000, 20_000)),
    );
  });
  try {
    if (options.runtime !== 'cloudflare-public')
      throw new ProbeError('blocked', 'PUBLIC_EGRESS_REQUIRED');
    await Promise.race([
      deadline,
      (async () => {
        let target = validatePublicUrl(input.url);
        result.finalUrl = target.href;
        const visited = new Set<string>();
        const checkedHosts = new Set<string>();
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          if (controller.signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          if (visited.has(target.href)) throw new ProbeError('needs_review', 'REDIRECT_LOOP');
          visited.add(target.href);
          if (!checkedHosts.has(target.hostname)) {
            const addresses = await resolveDns(target.hostname, controller.signal);
            if (!addresses.length) throw new ProbeError('dns_error', 'DNS_NO_ADDRESS');
            if (addresses.length > 64 || !addresses.every(isPublicIp))
              throw new ProbeError('blocked', 'DNS_NON_PUBLIC_ADDRESS');
            checkedHosts.add(target.hostname);
          }
          if (controller.signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          await options.beforeRequest?.(controller.signal);
          if (controller.signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          const response = await fetcher(target.href, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              accept: 'text/html,application/xhtml+xml;q=0.9',
              'user-agent': options.userAgent || 'cf-nav-health/1.0 (+https://nav.lily.lat/)',
            },
          });
          if (controller.signal.aborted) {
            await response.body?.cancel();
            throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          }
          // A transport that followed redirects would have skipped our per-hop checks.
          if (response.redirected) {
            await response.body?.cancel();
            throw new ProbeError('blocked', 'TRANSPORT_FOLLOWED_REDIRECT');
          }
          result.httpStatus = response.status;
          result.finalUrl = target.href;
          if (REDIRECT_CODES.has(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new ProbeError('needs_review', 'REDIRECT_WITHOUT_LOCATION');
            if (hop === MAX_REDIRECTS) throw new ProbeError('needs_review', 'REDIRECT_LIMIT');
            // Check the raw Location as well as the resolved URL: URL() would silently
            // normalize backslashes and controls before the validator could reject them.
            const rawAuthority = location.match(/^(?:https?:)?\/\/([^/?#]*)/i)?.[1] || '';
            if (hasUnsafeUrlCharacters(location) || /[@%]/.test(rawAuthority))
              throw new ProbeError('blocked', 'INVALID_REDIRECT');
            let destination: URL;
            try {
              destination = validatePublicUrl(new URL(location, target).href);
            } catch {
              throw new ProbeError('blocked', 'UNSAFE_REDIRECT');
            }
            result.redirects.push({
              url: target.href,
              status: response.status,
              location: destination.href,
            });
            if (target.protocol === 'https:' && destination.protocol === 'http:') {
              throw new ProbeError('needs_review', 'HTTPS_DOWNGRADE_REDIRECT');
            }
            target = destination;
            continue;
          }
          let body = { text: '', truncated: false };
          if (
            /(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(
              response.headers.get('content-type') || '',
            )
          ) {
            body = await readBoundedBody(response, MAX_BODY_BYTES, controller.signal);
          } else {
            await response.body?.cancel();
          }
          if (controller.signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          result.bodyTruncated = body.truncated;
          Object.assign(
            result,
            classifyPage(input, {
              status: response.status,
              headers: response.headers,
              url: target.href,
              html: body.text,
              truncated: body.truncated,
              redirects: result.redirects,
            }),
          );
          return;
        }
      })(),
    ]);
  } catch (error) {
    const failure = classifyError(error, controller.signal.aborted);
    result.status = failure.status;
    result.error = failure.code;
    result.evidence.push(failure.code);
    controller.abort();
  } finally {
    clearTimeout(timer);
  }
  result.durationMs = Math.max(0, now() - started);
  result.isSuccess = isHealthSuccess(result.status);
  result.consecutiveFailures = isHealthFailure(result.status)
    ? Math.max(0, input.consecutiveFailures || 0) + 1
    : result.isSuccess
      ? 0
      : Math.max(0, input.consecutiveFailures || 0);
  result.nextCheckAt = nextCheckAt(result.status, result.consecutiveFailures, started, input.url);
  return result;
}
