import type { Env } from '../shared/types';
import { HttpError, readJson, rateLimit } from './security';
import { categorySchema, linkSchema, importSchema, IMPORT_MAX_BYTES } from './validation';
import { runChecks } from '../worker/scheduler';

const linkFields = [
  'categoryId',
  'name',
  'url',
  'description',
  'icon',
  'sortOrder',
  'enabled',
  'featured',
  'notes',
  'expectedKeywords',
  'checkDisabled',
  'healthOverride',
] as const;
const categoryFields = ['name', 'slug', 'description', 'sortOrder', 'enabled'] as const;
// D1 limits any bound string to 2,000,000 bytes. Leave ample room below that
// ceiling and count UTF-8 bytes rather than JavaScript UTF-16 code units.
const importChunkBytes = 512 * 1024;
function importChunks(records: Record<string, unknown>[]): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let rows: string[] = [];
  let bytes = 2;
  for (const record of records) {
    const row = JSON.stringify(record);
    const rowBytes = encoder.encode(row).byteLength;
    if (rowBytes + 2 > importChunkBytes) throw new HttpError(413, '单条导入记录过大');
    if (rows.length && bytes + rowBytes + 1 > importChunkBytes) {
      chunks.push(`[${rows.join(',')}]`);
      rows = [];
      bytes = 2;
    }
    bytes += rowBytes + (rows.length ? 1 : 0);
    rows.push(row);
  }
  if (rows.length) chunks.push(`[${rows.join(',')}]`);
  return chunks;
}
const healthDefaults: Record<string, string> = {
  healthStatus: "'unknown'",
  httpStatus: 'NULL',
  finalUrl: 'NULL',
  lastCheckedAt: 'NULL',
  lastSuccessAt: 'NULL',
  lastFailureAt: 'NULL',
  lastError: 'NULL',
  observedTitle: 'NULL',
  confirmedTitle: 'NULL',
  consecutiveFailures: '0',
  healthEvidence: "'[]'",
  nextCheckAt: "'1970-01-01T00:00:00.000Z'",
};
function resetHealth(unchanged: string) {
  return Object.entries(healthDefaults)
    .map(
      ([field, fallback]) => `${field}=CASE WHEN ${unchanged} THEN ${field} ELSE ${fallback} END`,
    )
    .join(',');
}
function params(value: Record<string, unknown>, fields: readonly string[]) {
  return fields.map((key) =>
    typeof value[key] === 'boolean'
      ? Number(value[key])
      : Array.isArray(value[key])
        ? JSON.stringify(value[key])
        : (value[key] ?? null),
  );
}
function normalize(row: Record<string, unknown>) {
  const result = { ...row };
  for (const field of ['enabled', 'featured', 'checkDisabled'])
    if (field in result) result[field] = Boolean(result[field]);
  for (const field of ['expectedKeywords', 'healthEvidence'])
    if (field in result) {
      try {
        result[field] = JSON.parse(String(result[field]));
      } catch {
        result[field] = [];
      }
    }
  delete result.checkLeaseUntil;
  return result;
}
export async function catalog(env: Env, admin = false) {
  const [categories, links] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT * FROM categories WHERE deletedAt IS NULL ${admin ? '' : 'AND enabled=1'} ORDER BY sortOrder,name`,
    ),
    env.DB.prepare(
      `SELECT l.* FROM links l JOIN categories c ON c.id=l.categoryId WHERE l.deletedAt IS NULL AND c.deletedAt IS NULL ${admin ? '' : 'AND l.enabled=1 AND c.enabled=1'} ORDER BY l.sortOrder,l.name`,
    ),
  ]);
  const rows = links.results.map(normalize);
  if (!admin)
    for (const row of rows)
      for (const field of [
        'notes',
        'expectedKeywords',
        'healthEvidence',
        'lastError',
        'deletedAt',
        'observedTitle',
        'confirmedTitle',
        'nextCheckAt',
      ])
        delete row[field];
  return {
    categories: categories.results.map(normalize),
    links: rows,
    meta: {
      version: env.APP_VERSION || 'development',
      environment: env.APP_ENV,
      updatedAt: new Date().toISOString(),
    },
  };
}
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
function audit(db: D1Database, action: string, id: string) {
  return db
    .prepare('INSERT INTO audit_events(action,targetId,occurredAt) VALUES(?,?,?)')
    .bind(action, id, new Date().toISOString());
}
export async function adminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/admin/data' && method === 'GET') return json(await catalog(env, true));
  if (path === '/api/admin/export' && method === 'GET') {
    const [categories, links] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(
        `SELECT id,${categoryFields.join(',')} FROM categories WHERE deletedAt IS NULL ORDER BY sortOrder,name`,
      ),
      env.DB.prepare(
        `SELECT l.id,${linkFields.map((field) => `l.${field}`).join(',')} FROM links l JOIN categories c ON c.id=l.categoryId WHERE l.deletedAt IS NULL AND c.deletedAt IS NULL ORDER BY l.sortOrder,l.name`,
      ),
    ]);
    return new Response(
      JSON.stringify(
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          categories: categories.results.map(normalize),
          links: links.results.map(normalize),
        },
        null,
        2,
      ),
      {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="cf-nav-backup.json"',
          'Cache-Control': 'no-store',
        },
      },
    );
  }
  if (path === '/api/admin/logout' && method === 'POST')
    return json({ ok: true, logoutUrl: '/cdn-cgi/access/logout' });
  if (method !== 'GET') await rateLimit(env.DB, 'admin-write', 120, 60);
  if (path === '/api/admin/import' && method === 'POST') {
    const value = importSchema.parse(await readJson(request, IMPORT_MAX_BYTES));
    const categoryIds = new Set(value.categories.map((x) => x.id));
    const linkIds = new Set(value.links.map((x) => x.id));
    if (
      categoryIds.size !== value.categories.length ||
      linkIds.size !== value.links.length ||
      categoryIds.has(undefined) ||
      linkIds.has(undefined) ||
      new Set(value.categories.map((x) => x.slug)).size !== value.categories.length ||
      new Set(value.links.map((x) => x.url)).size !== value.links.length
    )
      throw new HttpError(400, '导入记录需要唯一 ID、分类标识和网址');
    const existing = await env.DB.prepare('SELECT id FROM categories WHERE deletedAt IS NULL').all<{
      id: string;
    }>();
    for (const c of existing.results) categoryIds.add(c.id);
    if (value.links.some((x) => !categoryIds.has(x.categoryId)))
      throw new HttpError(400, '导航引用了不存在的分类');
    const now = new Date().toISOString();
    // One atomic batch covers all chunks. No record is committed if any later
    // chunk fails, and every chunk statement uses only two bound parameters.
    const categoryJson = ['id', ...categoryFields].map(
      (field) => `json_extract(value,'$.${field}')`,
    );
    const linkJson = ['id', ...linkFields].map((field) =>
      field === 'categoryId'
        ? "(SELECT id FROM categories WHERE id=json_extract(value,'$.categoryId') AND deletedAt IS NULL)"
        : `json_extract(value,'$.${field}')`,
    );
    const unchanged =
      'links.url=excluded.url AND links.name=excluded.name AND links.expectedKeywords=excluded.expectedKeywords';
    const statements = [
      ...importChunks(value.categories).map((chunk) =>
        env.DB.prepare(
          `INSERT INTO categories(id,${categoryFields.join(',')},updatedAt) SELECT ${categoryJson.join(',')},? FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET ${categoryFields.map((f) => `${f}=excluded.${f}`).join(',')},updatedAt=excluded.updatedAt,deletedAt=NULL`,
        ).bind(now, chunk),
      ),
      ...importChunks(value.links).map((chunk) =>
        env.DB.prepare(
          `INSERT INTO links(id,${linkFields.join(',')},updatedAt) SELECT ${linkJson.join(',')},? FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET ${linkFields.map((f) => `${f}=excluded.${f}`).join(',')},updatedAt=excluded.updatedAt,deletedAt=NULL,${resetHealth(unchanged)},checkLeaseUntil=NULL`,
        ).bind(now, chunk),
      ),
      audit(env.DB, 'import', 'catalog'),
    ];
    // Reserve the rate-limit and existing-category reads within D1 Free's 50
    // queries per request, even if future validation limits allow larger records.
    if (statements.length > 48) throw new HttpError(413, '导入内容过大，请分批导入');
    await env.DB.batch(statements);
    return json({ ok: true, categories: value.categories.length, links: value.links.length });
  }
  const history = path.match(/^\/api\/admin\/links\/([a-zA-Z0-9_-]{1,80})\/history$/);
  if (history && method === 'GET')
    return json(
      (
        await env.DB.prepare(
          'SELECT * FROM health_history WHERE linkId=? ORDER BY id DESC LIMIT 30',
        )
          .bind(history[1])
          .all()
      ).results,
    );
  const check = path.match(/^\/api\/admin\/links\/([a-zA-Z0-9_-]{1,80})\/check$/);
  if (check && method === 'POST') {
    const link = await env.DB.prepare(
      'SELECT id,checkDisabled FROM links WHERE id=? AND deletedAt IS NULL',
    )
      .bind(check[1])
      .first<{ id: string; checkDisabled: number }>();
    if (!link) throw new HttpError(404, '导航不存在');
    if (link.checkDisabled) throw new HttpError(409, '此导航已忽略检测，请先关闭忽略');
    await rateLimit(env.DB, `check:${link.id}`, 1, 60);
    const results = await runChecks(env, link.id);
    if (!results.length) throw new HttpError(409, '检测正在进行，请稍后查看');
    return json({ ok: true, result: results[0] });
  }
  const match = path.match(
    /^\/api\/admin\/(categories|links)(?:\/([a-zA-Z0-9_-]{1,80}))?(?:\/(restore))?$/,
  );
  if (!match) throw new HttpError(404, '接口不存在');
  const [, table, id, restore] = match;
  if (id && restore && method === 'POST') {
    const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(id).first();
    if (!row) throw new HttpError(404, '记录不存在');
    if (
      table === 'links' &&
      !(await env.DB.prepare(
        'SELECT l.id FROM links l JOIN categories c ON c.id=l.categoryId WHERE l.id=? AND c.deletedAt IS NULL',
      )
        .bind(id)
        .first())
    )
      throw new HttpError(409, '请先恢复导航所属分类');
    const categoryGuard =
      table === 'links'
        ? ',categoryId=(SELECT id FROM categories WHERE id=links.categoryId AND deletedAt IS NULL),checkLeaseUntil=NULL'
        : '';
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${table} SET deletedAt=NULL,updatedAt=?${categoryGuard} WHERE id=?`,
      ).bind(new Date().toISOString(), id),
      audit(env.DB, 'restore', id),
    ]);
    return json({ ok: true, id });
  }
  if (restore) throw new HttpError(405, '不支持此请求方法');
  if (id && method === 'DELETE') {
    const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND deletedAt IS NULL`)
      .bind(id)
      .first();
    if (!row) throw new HttpError(404, '记录不存在');
    if (
      table === 'categories' &&
      (await env.DB.prepare('SELECT id FROM links WHERE categoryId=? AND deletedAt IS NULL LIMIT 1')
        .bind(id)
        .first())
    )
      throw new HttpError(409, '请先移动或删除分类内的导航');
    const now = new Date().toISOString();
    const guard =
      table === 'categories'
        ? ' AND NOT EXISTS(SELECT 1 FROM links WHERE categoryId=categories.id AND deletedAt IS NULL)'
        : '';
    const deletion = await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${table} SET deletedAt=?,updatedAt=?${table === 'links' ? ',checkLeaseUntil=NULL' : ''} WHERE id=? AND deletedAt IS NULL${guard}`,
      ).bind(now, now, id),
      env.DB.prepare(
        `INSERT INTO audit_events(action,targetId,occurredAt) SELECT ?,id,? FROM ${table} WHERE id=? AND deletedAt=?`,
      ).bind(`delete:${table}`, now, id, now),
    ]);
    if (!deletion[0].meta.changes) throw new HttpError(409, '记录已变化，请刷新后重试');
    return json({ ok: true, id, undoUrl: `/api/admin/${table}/${id}/restore` });
  }
  if ((!id && method === 'POST') || (id && method === 'PUT')) {
    const body = await readJson(request, 32768);
    const parsed = table === 'links' ? linkSchema.parse(body) : categorySchema.parse(body);
    const recordId = id || parsed.id || crypto.randomUUID();
    if (
      id &&
      !(await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND deletedAt IS NULL`)
        .bind(id)
        .first())
    )
      throw new HttpError(404, '记录不存在');
    if (
      'categoryId' in parsed &&
      !(await env.DB.prepare('SELECT id FROM categories WHERE id=? AND deletedAt IS NULL')
        .bind(parsed.categoryId)
        .first())
    )
      throw new HttpError(400, '分类不存在');
    const fields = table === 'links' ? linkFields : categoryFields;
    const now = new Date().toISOString();
    let statement: D1PreparedStatement;
    if (id) {
      const reset =
        table === 'links'
          ? `,${resetHealth('url=? AND name=? AND expectedKeywords=?')},checkLeaseUntil=NULL`
          : '';
      const tail =
        table === 'links' && 'url' in parsed
          ? Object.keys(healthDefaults).flatMap(() => [
              parsed.url,
              parsed.name,
              JSON.stringify(parsed.expectedKeywords),
            ])
          : [];
      statement = env.DB.prepare(
        `UPDATE ${table} SET ${fields.map((f) => (f === 'categoryId' ? `${f}=(SELECT id FROM categories WHERE id=? AND deletedAt IS NULL)` : `${f}=?`)).join(',')},updatedAt=?${reset} WHERE id=? AND deletedAt IS NULL`,
      ).bind(...params(parsed, fields), now, ...tail, id);
    } else {
      statement = env.DB.prepare(
        `INSERT INTO ${table}(id,${fields.join(',')},updatedAt) VALUES(?,${fields.map((f) => (f === 'categoryId' ? '(SELECT id FROM categories WHERE id=? AND deletedAt IS NULL)' : '?')).join(',')},?)`,
      ).bind(recordId, ...params(parsed, fields), now);
    }
    const written = await env.DB.batch([
      statement,
      audit(env.DB, `${id ? 'update' : 'create'}:${table}`, recordId),
    ]);
    if (!written[0].meta.changes) throw new HttpError(409, '记录已变化，请刷新后重试');
    return json({ ok: true, id: recordId }, id ? 200 : 201);
  }
  throw new HttpError(405, '不支持此请求方法');
}
