export function routeMatchesHostname(pattern: string, hostname: string): boolean;
export function buildSeedSql(data: unknown, now: string): string;
export function waitForDeploymentHealth(
  requestHealth: (remaining: number) => Promise<Response>,
  expectedVersion?: string,
  options?: {
    now?: () => number;
    delay?: (milliseconds: number) => Promise<void>;
    maxWaitMs?: number;
  },
): Promise<Record<string, unknown>>;
