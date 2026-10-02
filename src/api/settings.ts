import { z } from 'zod';
import type { Env } from '../shared/types';

export const DEFAULT_SETTINGS = {
  allowIndexing: true,
  healthUserAgent: 'cf-nav-health/1.0 (+https://nav.lily.lat/)',
  healthIntervalSeconds: 2,
  healthTimeoutSeconds: 12,
};
export const settingsSchema = z.object({
  allowIndexing: z.boolean(),
  healthUserAgent: z
    .string()
    .trim()
    .min(3)
    .max(256)
    .regex(/^[\x20-\x7e]+$/, 'User-Agent 只能使用可打印 ASCII 字符'),
  healthIntervalSeconds: z.number().int().min(1).max(3600),
  healthTimeoutSeconds: z.number().int().min(2).max(60),
});
export type SiteSettings = z.infer<typeof settingsSchema>;
export async function getSettings(env: Env): Promise<SiteSettings> {
  const row = await env.DB.prepare("SELECT value FROM metadata WHERE key='siteSettings'").first<{
    value: string;
  }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  // Invalid stored configuration fails closed instead of silently re-enabling indexing.
  return settingsSchema.parse(JSON.parse(row.value));
}
export function publicOrigin(env: Env): string | null {
  try {
    const url = new URL(env.PUBLIC_ORIGIN || '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function effectiveIndexing(env: Env, requestUrl: string, settings: SiteSettings): boolean {
  return (
    settings.allowIndexing &&
    env.APP_ENV === 'production' &&
    new URL(requestUrl).origin === publicOrigin(env)
  );
}
