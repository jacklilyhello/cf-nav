export const HEALTH_STATUSES = [
  'healthy',
  'redirected',
  'moved',
  'forbidden',
  'not_found',
  'gone',
  'rate_limited',
  'server_error',
  'dns_error',
  'tls_error',
  'timeout',
  'connection_refused',
  'connection_error',
  'bot_protection',
  'challenge',
  'domain_parking',
  'domain_for_sale',
  'content_changed',
  'needs_review',
  'blocked',
  'unknown',
] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export type ContentStatus = 'match' | 'partial' | 'changed' | 'mismatch' | 'unknown';

export interface HealthInput {
  url: string;
  name: string;
  expectedKeywords?: string[];
  expectedTitle?: string;
  expectedDescription?: string;
  previousTitle?: string | null;
  consecutiveFailures?: number;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface HealthResult {
  status: HealthStatus;
  httpStatus: number | null;
  finalUrl: string;
  title: string;
  description: string;
  contentStatus: ContentStatus;
  similarityScore: number | null;
  evidence: string[];
  error: string | null;
  redirects: RedirectHop[];
  checkedAt: string;
  durationMs: number;
  bodyTruncated: boolean;
  consecutiveFailures: number;
  nextCheckAt: string;
  isSuccess: boolean;
  /** Present only while a scheduled redirect continuation is unfinished. */
  continuation?: HealthCursor;
}

export interface HealthCursor {
  targetUrl: string;
  visited: string[];
  redirects: RedirectHop[];
  checkedAt: string;
  elapsedMs: number;
  httpStatus: number | null;
  finalUrl: string;
}

/** Scheduling is not a transport failure and must never create failure evidence. */
export class ProbeDeferred extends Error {
  constructor(public readonly nextRequestAt: number) {
    super('HEALTH_REQUEST_DEFERRED');
    this.name = 'ProbeDeferred';
  }
}

export type DnsResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

export interface HealthOptions {
  /**
   * Security boundary: only Cloudflare global fetch with global_fetch_strictly_public.
   * DNS preflight is defense in depth, not connection pinning. Do not substitute Node
   * fetch, origin/service/VPC bindings, or an authenticated proxy in production.
   */
  runtime: 'cloudflare-public';
  fetcher?: typeof fetch;
  resolver?: DnsResolver;
  timeoutMs?: number;
  userAgent?: string;
  /** Shared scheduler limiter, called before every target request including redirects. */
  beforeRequest?: (signal: AbortSignal, remainingMs: number) => Promise<void>;
  resume?: HealthCursor;
  now?: () => number;
}

export class ProbeError extends Error {
  constructor(
    public readonly status: HealthStatus,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'ProbeError';
  }
}
