import { classifyPage } from './classify';
import { createDnsResolver, readBoundedBody } from './transport';
import { isHealthFailure, isHealthSuccess, nextCheckAt } from './schedule';
import {
  ProbeError,
  ProbeDeferred,
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
export { HEALTH_STATUSES, ProbeError, ProbeDeferred } from './types';
export type {
  DnsResolver,
  ContentStatus,
  HealthInput,
  HealthOptions,
  HealthCursor,
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
  const cursor = options.resume;
  let target = input.url;
  const visited = new Set<string>();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12_000, 60_000));
  let previousElapsed = 0;
  let deferred: ProbeDeferred | null = null;
  let requestPending = false;
  let requestCompletion: Promise<void> | null = null;
  function completeRequest() {
    if (requestCompletion) return requestCompletion;
    if (!requestPending) return Promise.resolve();
    requestPending = false;
    requestCompletion = Promise.resolve().then(() => options.afterRequest?.());
    return requestCompletion;
  }
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
      Math.max(1, timeoutMs - (cursor?.elapsedMs || 0)),
    );
  });
  try {
    if (options.runtime !== 'cloudflare-public')
      throw new ProbeError('blocked', 'PUBLIC_EGRESS_REQUIRED');
    await Promise.race([
      deadline,
      (async () => {
        if (cursor) {
          // A cursor is internal durable data, still validate its invariants before egress.
          if (
            !Number.isFinite(cursor.elapsedMs) ||
            cursor.elapsedMs < 0 ||
            !Number.isFinite(Date.parse(cursor.checkedAt)) ||
            !Array.isArray(cursor.visited) ||
            !Array.isArray(cursor.redirects) ||
            cursor.visited.length !== cursor.redirects.length ||
            cursor.redirects.length > MAX_REDIRECTS
          )
            throw new ProbeError('blocked', 'INVALID_HEALTH_CURSOR');
          if (cursor.elapsedMs >= timeoutMs)
            throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          previousElapsed = cursor.elapsedMs;
          target = validatePublicUrl(cursor.targetUrl).href;
          for (const url of cursor.visited) visited.add(validatePublicUrl(url).href);
          result.redirects = cursor.redirects.map((hop) => ({
            url: validatePublicUrl(hop.url).href,
            status: hop.status,
            location: validatePublicUrl(hop.location || '').href,
          }));
          let expected = validatePublicUrl(input.url).href;
          for (let index = 0; index < result.redirects.length; index++) {
            const hop = result.redirects[index]!;
            if (
              !REDIRECT_CODES.has(hop.status) ||
              hop.url !== expected ||
              cursor.visited[index] !== expected ||
              (new URL(hop.url).protocol === 'https:' &&
                new URL(hop.location).protocol !== 'https:')
            )
              throw new ProbeError('blocked', 'INVALID_HEALTH_CURSOR');
            expected = hop.location;
          }
          if (expected !== target || visited.size !== cursor.visited.length)
            throw new ProbeError('blocked', 'INVALID_HEALTH_CURSOR');
          result.checkedAt = cursor.checkedAt;
          result.httpStatus = cursor.httpStatus;
          result.finalUrl = cursor.finalUrl;
        } else {
          target = validatePublicUrl(input.url).href;
          result.finalUrl = target;
        }
        const checkedHosts = new Set<string>();
        for (let hop = result.redirects.length; hop <= MAX_REDIRECTS; hop++) {
          if (controller.signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          const targetUrl = validatePublicUrl(target);
          if (visited.has(targetUrl.href)) throw new ProbeError('needs_review', 'REDIRECT_LOOP');
          if (!checkedHosts.has(targetUrl.hostname)) {
            const addresses = await resolveDns(targetUrl.hostname, controller.signal);
            if (!addresses.length) throw new ProbeError('dns_error', 'DNS_NO_ADDRESS');
            if (addresses.length > 64 || !addresses.every(isPublicIp))
              throw new ProbeError('blocked', 'DNS_NON_PUBLIC_ADDRESS');
            checkedHosts.add(targetUrl.hostname);
          }
          if (controller.signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          await options.beforeRequest?.(
            controller.signal,
            timeoutMs - previousElapsed - (now() - started),
          );
          visited.add(targetUrl.href);
          if (controller.signal.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
          requestCompletion = null;
          requestPending = true;
          const response = await fetcher(targetUrl.href, {
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
          await completeRequest();
          // A transport that followed redirects would have skipped our per-hop checks.
          if (response.redirected) {
            await response.body?.cancel();
            throw new ProbeError('blocked', 'TRANSPORT_FOLLOWED_REDIRECT');
          }
          result.httpStatus = response.status;
          result.finalUrl = targetUrl.href;
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
              destination = validatePublicUrl(new URL(location, targetUrl).href);
            } catch {
              throw new ProbeError('blocked', 'UNSAFE_REDIRECT');
            }
            result.redirects.push({
              url: targetUrl.href,
              status: response.status,
              location: destination.href,
            });
            if (targetUrl.protocol === 'https:' && destination.protocol === 'http:') {
              throw new ProbeError('needs_review', 'HTTPS_DOWNGRADE_REDIRECT');
            }
            target = destination.href;
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
              url: targetUrl.href,
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
    if (error instanceof ProbeDeferred && !controller.signal.aborted) deferred = error;
    else {
      const failure = classifyError(error, controller.signal.aborted);
      result.status = failure.status;
      result.error = failure.code;
      result.evidence.push(failure.code);
    }
    controller.abort();
  } finally {
    clearTimeout(timer);
    // A stalled fetch may ignore abort in a test transport. Persist its terminal
    // boundary here as well, exactly once, before the scheduler releases its lease.
    await completeRequest();
  }
  result.durationMs = previousElapsed + Math.max(0, now() - started);
  if (deferred) {
    result.continuation = {
      targetUrl: target,
      visited: [...visited],
      redirects: result.redirects,
      checkedAt: result.checkedAt,
      elapsedMs: result.durationMs,
      httpStatus: result.httpStatus,
      finalUrl: result.finalUrl,
    };
    result.nextCheckAt = new Date(deferred.nextRequestAt).toISOString();
    return result;
  }
  result.isSuccess = isHealthSuccess(result.status);
  result.consecutiveFailures = isHealthFailure(result.status)
    ? Math.max(0, input.consecutiveFailures || 0) + 1
    : result.isSuccess
      ? 0
      : Math.max(0, input.consecutiveFailures || 0);
  result.nextCheckAt = nextCheckAt(result.status, result.consecutiveFailures, now(), input.url);
  return result;
}
