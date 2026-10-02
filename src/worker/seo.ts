import type { Env } from '../shared/types';
import { catalog } from '../api/catalog';
import { effectiveIndexing, getSettings, publicOrigin } from '../api/settings';

function escape(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export async function seoRoute(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const settings = await getSettings(env);
  const allowed = effectiveIndexing(env, request.url, settings);
  const origin = publicOrigin(env);
  const policy = allowed ? 'index, follow' : 'noindex, nofollow';
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Robots-Tag': policy });
  if (path === '/robots.txt') {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    // Crawling remains permitted so crawlers can read noindex after a switch.
    return new Response(
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n${allowed && origin ? `Sitemap: ${origin}/sitemap.xml\n` : '# Indexing disabled: pages send noindex via HTTP and HTML.\n'}`,
      { headers },
    );
  }
  if (path === '/sitemap.xml') {
    headers.set('Content-Type', 'application/xml; charset=utf-8');
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${allowed && origin ? `<url><loc>${escape(origin)}/</loc></url>` : ''}</urlset>`,
      { headers },
    );
  }
  const response = await env.ASSETS.fetch(
    new Request(new URL('/', request.url), { method: 'GET' }),
  );
  let html = await response.text();
  if (!response.ok) return new Response(html, response);
  html = html.replace(
    '</head>',
    `<meta name="robots" content="${policy}" />${origin ? `<link rel="canonical" href="${escape(origin)}/" />` : ''}</head>`,
  );
  // A useful ordinary HTML fallback makes catalog links discoverable without JS.
  const data = await catalog(env);
  const fallback = `<noscript><main><h1>Lily · 寻迹</h1>${data.categories
    .map(
      (category) =>
        `<section><h2>${escape(category.name)}</h2><p>${escape(category.description)}</p><ul>${data.links
          .filter((link) => link.categoryId === category.id)
          .map(
            (link) =>
              `<li><a href="${escape(link.url)}" rel="noopener noreferrer">${escape(link.name)}</a> — ${escape(link.description)}</li>`,
          )
          .join('')}</ul></section>`,
    )
    .join('')}</main></noscript>`;
  html = html.replace('</body>', `${fallback}</body>`);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(request.method === 'HEAD' ? null : html, { headers });
}
