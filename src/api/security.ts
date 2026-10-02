import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../shared/types';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const keysets = new Map<string, JWTVerifyGetKey>();
export async function authenticate(request: Request, env: Env, keyOverride?: JWTVerifyGetKey) {
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) ||
    !env.ACCESS_AUD ||
    !env.ADMIN_EMAIL_HASH
  ) {
    throw new HttpError(503, '管理员认证尚未配置');
  }
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    request.headers.get('Cookie')?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token || token.length > 12000) throw new HttpError(401, '请先通过 Cloudflare Access 登录');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let key = keyOverride || keysets.get(issuer);
  if (!key) {
    key = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keysets.set(issuer, key);
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience: env.ACCESS_AUD.split(',')
        .map((audience) => audience.trim())
        .filter(Boolean),
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
      clockTolerance: 5,
    });
    if (
      typeof payload.email !== 'string' ||
      payload.type !== 'app' ||
      (await sha256(payload.email.toLowerCase())) !== env.ADMIN_EMAIL_HASH
    )
      throw new Error('identity');
    return { email: payload.email, csrfToken: await sha256(`cf-nav:csrf:${token}`) };
  } catch {
    throw new HttpError(401, '登录已失效，请重新登录');
  }
}
export function csrf(request: Request, token: string) {
  const origin = new URL(request.url).origin;
  if (
    request.headers.get('Origin') !== origin ||
    request.headers.get('X-CSRF-Token') !== token ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    throw new HttpError(403, '请求来源验证失败');
}
export async function readJson(request: Request, limit = 1048576): Promise<unknown> {
  if (
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new HttpError(415, '需要 JSON 内容');
  if (Number(request.headers.get('Content-Length') || 0) > limit)
    throw new HttpError(413, '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容为空');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) {
        await reader.cancel();
        throw new HttpError(413, '请求内容过大');
      }
      chunks.push(value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(content));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'JSON 格式无效');
  } finally {
    reader.releaseLock();
  }
}
export async function rateLimit(db: D1Database, key: string, max: number, windowSeconds: number) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = `${key}:${Math.floor(now / windowSeconds)}`;
  const value = await db
    .prepare(
      'INSERT INTO rate_limits(key,count,expiresAt) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
    )
    .bind(bucket, now + windowSeconds)
    .first<{ count: number }>();
  if (!value || value.count > max) throw new HttpError(429, '操作频繁，请稍后重试');
}
export function secure(response: Response, request: Request) {
  const result = new Response(response.body, response);
  result.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  );
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  result.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  result.headers.set('X-CF-Nav', 'cf-nav');
  if (new URL(request.url).protocol === 'https:')
    result.headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (
    new URL(request.url).pathname.startsWith('/admin') ||
    new URL(request.url).pathname.startsWith('/api/') ||
    result.status >= 400
  ) {
    result.headers.set('Cache-Control', 'no-store');
    result.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return result;
}
