import { checkLink, HEALTH_BATCH_SIZE, isHealthFailure } from '../health';
import type { Env } from '../shared/types';

interface DueLink {
  id: string;
  url: string;
  name: string;
  expectedKeywords: string;
  confirmedTitle: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}
export async function runChecks(env: Env, linkId?: string) {
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + 180000).toISOString();
  const due = await env.DB.prepare(
    `SELECT id,url,name,expectedKeywords,confirmedTitle,consecutiveFailures,updatedAt FROM links WHERE deletedAt IS NULL AND checkDisabled=0 AND (checkLeaseUntil IS NULL OR checkLeaseUntil<?) ${linkId ? 'AND id=?' : 'AND nextCheckAt<=?'} ORDER BY nextCheckAt LIMIT ${HEALTH_BATCH_SIZE}`,
  )
    .bind(now, linkId || now)
    .all<DueLink>();
  const results = [];
  for (const link of due.results) {
    const claim = await env.DB.prepare(
      'UPDATE links SET checkLeaseUntil=? WHERE id=? AND url=? AND updatedAt=? AND deletedAt IS NULL AND checkDisabled=0 AND (checkLeaseUntil IS NULL OR checkLeaseUntil<?)',
    )
      .bind(lease, link.id, link.url, link.updatedAt, now)
      .run();
    if (!claim.meta.changes) continue;
    try {
      const result = await checkLink(
        {
          url: link.url,
          name: link.name,
          expectedKeywords: JSON.parse(link.expectedKeywords),
          previousTitle: link.confirmedTitle,
          consecutiveFailures: link.consecutiveFailures,
        },
        { runtime: 'cloudflare-public' },
      );
      // A concurrent administrator edit invalidates this result for the old URL.
      const persisted = await env.DB.batch([
        // Insert before clearing the lease; both operations are one D1 transaction.
        // Administrator edits clear the lease and invalidate even same-URL results.
        env.DB.prepare(
          'INSERT INTO health_history(linkId,status,httpStatus,finalUrl,title,evidence,checkedAt,durationMs) SELECT id,?,?,?,?,?,?,? FROM links WHERE id=? AND url=? AND updatedAt=? AND checkLeaseUntil=? AND deletedAt IS NULL AND checkDisabled=0',
        ).bind(
          result.status,
          result.httpStatus,
          result.finalUrl,
          result.title,
          JSON.stringify(result.evidence),
          result.checkedAt,
          result.durationMs,
          link.id,
          link.url,
          link.updatedAt,
          lease,
        ),
        env.DB.prepare(
          `UPDATE links SET healthStatus=?,httpStatus=?,finalUrl=?,lastCheckedAt=?,nextCheckAt=?,consecutiveFailures=?,lastError=?,observedTitle=?,healthEvidence=?,confirmedTitle=CASE WHEN ? THEN ? ELSE confirmedTitle END,lastSuccessAt=CASE WHEN ? THEN ? ELSE lastSuccessAt END,lastFailureAt=CASE WHEN ? THEN ? ELSE lastFailureAt END,checkLeaseUntil=NULL WHERE id=? AND url=? AND updatedAt=? AND checkLeaseUntil=? AND deletedAt IS NULL AND checkDisabled=0`,
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
      if (persisted[1].meta.changes) results.push({ id: link.id, status: result.status });
    } finally {
      await env.DB.prepare('UPDATE links SET checkLeaseUntil=NULL WHERE id=? AND checkLeaseUntil=?')
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
      env.DB.prepare(
        "INSERT INTO metadata(key,value) VALUES('lastCronAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(new Date().toISOString()),
    ]);
  return results;
}
