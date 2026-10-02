import { ZodError } from 'zod';
import type { Env } from '../shared/types';
import { authenticate, csrf, HttpError, secure } from '../api/security';
import { adminApi, catalog, json } from '../api/catalog';
import { runChecks } from './scheduler';

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/health' && request.method === 'GET') {
    await env.DB.prepare('SELECT 1').first();
    const cron = await env.DB.prepare("SELECT value FROM metadata WHERE key='lastCronAt'").first<{
      value: string;
    }>();
    return json({
      ok: true,
      app: 'cf-nav',
      environment: env.APP_ENV,
      version: env.APP_VERSION || 'development',
      lastCronAt: cron?.value || null,
    });
  }
  if (path === '/api/catalog' && request.method === 'GET') return json(await catalog(env));
  if (path.startsWith('/api/admin/') || path === '/admin/login') {
    const auth = await authenticate(request, env);
    if (path === '/admin/login') return Response.redirect(`${url.origin}/admin`, 303);
    if (!['GET', 'HEAD'].includes(request.method)) csrf(request, auth.csrfToken);
    if (path === '/api/admin/session' && request.method === 'GET')
      return json({ authenticated: true, ...auth });
    return adminApi(request, env);
  }
  if (path.startsWith('/api/')) throw new HttpError(404, '接口不存在');
  if (request.method !== 'GET' && request.method !== 'HEAD')
    throw new HttpError(405, '不支持此请求方法');
  if (path === '/robots.txt')
    return new Response(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/admin\n`, {
      headers: { 'Content-Type': 'text/plain' },
    });
  if (['/', '/admin', '/admin/'].includes(path)) {
    const response = await env.ASSETS.fetch(new Request(`${url.origin}/`, request));
    const result = new Response(response.body, response);
    result.headers.set('Cache-Control', 'no-cache');
    return result;
  }
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) {
    const page = await env.ASSETS.fetch(new Request(`${url.origin}/`, request));
    const headers = new Headers(page.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(page.body, { status: 404, headers });
  }
  return response;
}
export default {
  async fetch(request: Request, env: Env) {
    try {
      return secure(await route(request, env), request);
    } catch (error) {
      let status = 500;
      let message = '服务暂时不可用，请稍后重试';
      if (error instanceof HttpError) {
        status = error.status;
        message = error.message;
      } else if (error instanceof ZodError) {
        status = 400;
        message = error.issues
          .map((x) => `${x.path.join('.')}: ${x.message}`)
          .join('；')
          .slice(0, 600);
      } else if (error instanceof Error && /UNIQUE constraint/.test(error.message)) {
        status = 409;
        message = '网址或分类标识已存在';
      } else if (
        error instanceof Error &&
        /FOREIGN KEY constraint|NOT NULL constraint failed: links.categoryId/.test(error.message)
      ) {
        status = 409;
        message = '关联记录不存在或仍在使用';
      }
      if (status === 500)
        console.error('cf-nav request failed', {
          path: new URL(request.url).pathname,
          kind: error instanceof Error ? error.name : 'unknown',
        });
      return secure(
        json({ error: message, ...(status === 401 ? { loginUrl: '/admin/login' } : {}) }, status),
        request,
      );
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runChecks(env));
  },
} satisfies ExportedHandler<Env>;
