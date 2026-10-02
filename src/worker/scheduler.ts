import {
  checkLink,
  HEALTH_BATCH_SIZE,
  isHealthFailure,
  ProbeDeferred,
  type HealthCursor,
} from '../health';
import { acquireHealthLease, HEALTH_LEASE_MS } from '../health/lease';
import { getSettings, settingsSchema } from '../api/settings';
import type { Env } from '../shared/types';

interface DueLink {
  id: string;
  url: string;
  name: string;
  expectedKeywords: string;
  expectedTitle: string;
  expectedDescription: string;
  confirmedTitle: string | null;
  consecutiveFailures: number;
  updatedAt: string;
  jobSettings: string;
  cursor: string | null;
}
export async function runChecks(env: Env, linkId?: string) {
  const settings = await getSettings(env);
  // Invalidated snapshots cannot be resumed after an administrator edit, even
  // when the URL stayed the same. Old history is preserved by the existing policy.
  await env.DB.prepare(
    'DELETE FROM health_jobs WHERE NOT EXISTS(SELECT 1 FROM links WHERE links.id=health_jobs.linkId AND links.url=health_jobs.url AND links.updatedAt=health_jobs.linkUpdatedAt AND links.deletedAt IS NULL AND links.checkDisabled=0)',
  ).run();
  if (!linkId)
    await env.DB.prepare(
      "INSERT INTO metadata(key,value) VALUES('lastCronAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
      .bind(new Date().toISOString())
      .run();
  await env.DB.prepare(
    `INSERT INTO health_jobs(linkId,url,linkUpdatedAt,settings,manual,createdAt) SELECT id,url,updatedAt,?,?,? FROM links WHERE deletedAt IS NULL AND checkDisabled=0 ${linkId ? 'AND id=?' : 'AND nextCheckAt<=? AND NOT EXISTS(SELECT 1 FROM health_jobs WHERE linkId=links.id)'} ORDER BY nextCheckAt LIMIT ${HEALTH_BATCH_SIZE} ON CONFLICT(linkId) DO UPDATE SET manual=MAX(health_jobs.manual,excluded.manual)`,
  )
    .bind(
      JSON.stringify(settings),
      Number(Boolean(linkId)),
      new Date().toISOString(),
      linkId || new Date().toISOString(),
    )
    .run();
  const runLease = await acquireHealthLease(env.DB, settings.healthIntervalSeconds);
  if (!runLease) return [];
  try {
    const now = new Date().toISOString();
    const lease = new Date(Date.now() + HEALTH_LEASE_MS).toISOString();
    const due = await env.DB.prepare(
      `SELECT l.id,l.url,l.name,l.expectedKeywords,l.expectedTitle,l.expectedDescription,l.confirmedTitle,l.consecutiveFailures,l.updatedAt,j.settings AS jobSettings,j.cursor FROM health_jobs j JOIN links l ON l.id=j.linkId AND l.url=j.url AND l.updatedAt=j.linkUpdatedAt WHERE l.deletedAt IS NULL AND l.checkDisabled=0 AND (l.checkLeaseUntil IS NULL OR l.checkLeaseUntil<?) AND j.nextRequestAt<=? ${linkId ? 'AND l.id=?' : ''} ORDER BY j.manual DESC,j.createdAt,j.linkId LIMIT ${HEALTH_BATCH_SIZE}`,
    )
      .bind(now, Date.now(), ...(linkId ? [linkId] : []))
      .all<DueLink>();
    const results = [];
    for (const link of due.results) {
      const claim = await env.DB.prepare(
        'UPDATE links SET checkLeaseUntil=? WHERE id=? AND url=? AND updatedAt=? AND deletedAt IS NULL AND checkDisabled=0 AND (checkLeaseUntil IS NULL OR checkLeaseUntil<?)',
      )
        .bind(lease, link.id, link.url, link.updatedAt, now)
        .run();
      if (!claim.meta.changes) continue;
      const savePending = (nextRequestAt: number, cursor = link.cursor) =>
        env.DB.prepare(
          'UPDATE health_jobs SET cursor=?,nextRequestAt=? WHERE linkId=? AND url=? AND linkUpdatedAt=? AND EXISTS(SELECT 1 FROM links WHERE id=? AND url=? AND updatedAt=? AND checkLeaseUntil=? AND deletedAt IS NULL AND checkDisabled=0)',
        )
          .bind(
            cursor,
            nextRequestAt,
            link.id,
            link.url,
            link.updatedAt,
            link.id,
            link.url,
            link.updatedAt,
            lease,
          )
          .run();
      try {
        const jobSettings = settingsSchema.parse(JSON.parse(link.jobSettings));
        await runLease.waitUntilReady(undefined, jobSettings.healthIntervalSeconds);
        const result = await checkLink(
          {
            url: link.url,
            name: link.name,
            expectedKeywords: JSON.parse(link.expectedKeywords),
            expectedTitle: link.expectedTitle,
            expectedDescription: link.expectedDescription,
            previousTitle: link.confirmedTitle,
            consecutiveFailures: link.consecutiveFailures,
          },
          {
            runtime: 'cloudflare-public',
            userAgent: jobSettings.healthUserAgent,
            timeoutMs: jobSettings.healthTimeoutSeconds * 1000,
            beforeRequest: (signal, remainingMs) =>
              runLease.beforeRequest(signal, jobSettings.healthIntervalSeconds, remainingMs),
            resume: link.cursor ? (JSON.parse(link.cursor) as HealthCursor) : undefined,
          },
        );
        if (result.continuation) {
          await savePending(Date.parse(result.nextCheckAt), JSON.stringify(result.continuation));
          continue;
        }
        // A concurrent administrator edit invalidates this result for the old URL.
        const persisted = await env.DB.batch([
          // Insert before clearing the lease; both operations are one D1 transaction.
          // Administrator edits clear the lease and invalidate even same-URL results.
          env.DB.prepare(
            'INSERT INTO health_history(linkId,status,httpStatus,finalUrl,title,evidence,checkedAt,durationMs,contentStatus,similarityScore,redirectChain,probeUserAgent,probeIntervalSeconds,probeTimeoutSeconds) SELECT id,?,?,?,?,?,?,?,?,?,?,?,?,? FROM links WHERE id=? AND url=? AND updatedAt=? AND checkLeaseUntil=? AND deletedAt IS NULL AND checkDisabled=0',
          ).bind(
            result.status,
            result.httpStatus,
            result.finalUrl,
            result.title,
            JSON.stringify(result.evidence),
            result.checkedAt,
            result.durationMs,
            result.contentStatus,
            result.similarityScore,
            JSON.stringify(result.redirects),
            jobSettings.healthUserAgent,
            jobSettings.healthIntervalSeconds,
            jobSettings.healthTimeoutSeconds,
            link.id,
            link.url,
            link.updatedAt,
            lease,
          ),
          // Delete while the original link lease is still present. A delayed old
          // owner cannot discard a newer owner's continuation for the same snapshot.
          env.DB.prepare(
            'DELETE FROM health_jobs WHERE linkId=? AND url=? AND linkUpdatedAt=? AND EXISTS(SELECT 1 FROM links WHERE id=? AND checkLeaseUntil=?)',
          ).bind(link.id, link.url, link.updatedAt, link.id, lease),
          env.DB.prepare(
            `UPDATE links SET healthStatus=?,httpStatus=?,finalUrl=?,lastCheckedAt=?,nextCheckAt=?,consecutiveFailures=?,lastError=?,observedTitle=?,healthEvidence=?,contentStatus=?,similarityScore=?,redirectChain=?,confirmedTitle=CASE WHEN ? AND confirmedTitle IS NULL THEN ? ELSE confirmedTitle END,lastSuccessAt=CASE WHEN ? THEN ? ELSE lastSuccessAt END,lastFailureAt=CASE WHEN ? THEN ? ELSE lastFailureAt END,checkLeaseUntil=NULL WHERE id=? AND url=? AND updatedAt=? AND checkLeaseUntil=? AND deletedAt IS NULL AND checkDisabled=0`,
          ).bind(
            result.status,
            result.httpStatus,
            result.finalUrl,
            result.checkedAt,
            result.nextCheckAt,
            result.consecutiveFailures,
            result.error,
            result.title,
            JSON.stringify(result.evidence),
            result.contentStatus,
            result.similarityScore,
            JSON.stringify(result.redirects),
            Number(result.isSuccess),
            result.title,
            Number(result.isSuccess),
            result.checkedAt,
            Number(isHealthFailure(result.status)),
            result.checkedAt,
            link.id,
            link.url,
            link.updatedAt,
            lease,
          ),
        ]);
        if (persisted[2].meta.changes) results.push({ id: link.id, status: result.status });
      } catch (error) {
        if (error instanceof ProbeDeferred) await savePending(error.nextRequestAt);
        else throw error;
      } finally {
        await env.DB.prepare(
          'UPDATE links SET checkLeaseUntil=NULL WHERE id=? AND checkLeaseUntil=?',
        )
          .bind(link.id, lease)
          .run();
      }
    }
    if (!linkId)
      await env.DB.batch([
        env.DB.prepare('DELETE FROM rate_limits WHERE expiresAt<?').bind(
          Math.floor(Date.now() / 1000),
        ),
        env.DB.prepare('DELETE FROM health_history WHERE checkedAt<?').bind(
          new Date(Date.now() - 90 * 86400000).toISOString(),
        ),
        env.DB.prepare('DELETE FROM audit_events WHERE occurredAt<?').bind(
          new Date(Date.now() - 180 * 86400000).toISOString(),
        ),
      ]);
    return results;
  } finally {
    await runLease.release();
  }
}
