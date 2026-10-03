// Temporary, isolated remote fixture for browser acceptance. No bindings, storage,
// authentication, request forwarding, application routes, or request logging.
const description = 'Lily probe acceptance';
const headers = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Cf-Nav-Fixture': 'probe-acceptance-v1',
};

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

function page(title: string, body = description): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><meta name="description" content="${description}"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head><body><h1>${escape(title)}</h1><p>${escape(body)}</p></body></html>`,
    {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response('Not found', { status: 404, headers });
    const url = new URL(request.url);
    const userAgent = (request.headers.get('user-agent') || '').slice(0, 256);
    if (url.pathname === '/') return page(description);
    if (url.pathname === '/identity') return page(`UA=${userAgent}`);
    if (url.pathname === '/redirect')
      return new Response(null, {
        status: 302,
        headers: { ...headers, Location: `/arrived?started=${Date.now()}` },
      });
    if (url.pathname === '/arrived') {
      const started = url.searchParams.get('started') || '';
      const interval = Date.now() - Number(started);
      // Allow one-hour durable cooldown acceptance plus bounded Cron queue delay.
      if (!/^\d{13}$/.test(started) || interval < 0 || interval > 7_200_000) {
        return new Response('Invalid interval', { status: 400, headers });
      }
      return page(`${description} | interval=${interval}ms | UA=${userAgent}`);
    }
    if (['/slow', '/slow-25', '/slow-65'].includes(url.pathname)) {
      const delay =
        url.pathname === '/slow-25' ? 25_000 : url.pathname === '/slow-65' ? 65_000 : 5000;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return page(`${description} | delayed=${delay}ms | UA=${userAgent}`);
    }
    if (url.pathname === '/changed') {
      return page('This domain is for sale', 'This domain is parked. Buy this domain.');
    }
    if (url.pathname === '/favicon.svg')
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#527657"/><path d="M19 15h9v29h18v8H19z" fill="white"/></svg>',
        { headers: { ...headers, 'Content-Type': 'image/svg+xml' } },
      );
    return new Response('Not found', { status: 404, headers });
  },
};
