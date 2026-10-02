const base = process.argv[2];
if (!base) throw new Error('Usage: npm run smoke -- https://host');
const request = async (path) => {
  const r = await fetch(new URL(path, base), {
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  return r;
};
const health = await request('/api/health');
if (health.status !== 200) throw new Error(`Health ${health.status}`);
const state = await health.json();
if (state.app !== 'cf-nav') throw new Error('Wrong Worker');
if (process.env.EXPECTED_VERSION && state.version !== process.env.EXPECTED_VERSION)
  throw new Error('Deployed source differs');
const publicResponse = await request('/api/catalog');
const catalog = await publicResponse.json();
if (!catalog.links?.length || !catalog.categories?.length) throw new Error('Empty catalog');
if (catalog.links.some((x) => Object.hasOwn(x, 'notes'))) throw new Error('Private notes exposed');
const page = await request('/');
const html = await page.text();
if (
  page.status !== 200 ||
  !html.includes('Lily') ||
  /Web_tool|kefu308|京ICP备2023018588/.test(html)
)
  throw new Error('Wrong public page');
for (const h of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy'])
  if (!page.headers.get(h)) throw new Error(`Missing ${h}`);
for (const path of ['/api/admin/data', '/api/admin/export']) {
  const r = await request(path);
  if (r.status !== 401) throw new Error(`${path} should be unauthorized, got ${r.status}`);
}
const missing = await request('/api/no-such-endpoint');
if (missing.status !== 404 || !missing.headers.get('content-type')?.includes('json'))
  throw new Error('API 404 contract');
const errorPage = await request('/no-such-page');
if (errorPage.status !== 404) throw new Error('Page 404 contract');
for (const path of [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((x) => x[1])) {
  const r = await request(path);
  if (r.status !== 200) throw new Error(`Missing asset ${path}`);
}
console.log(
  JSON.stringify(
    {
      ok: true,
      base,
      ...state,
      links: catalog.links.length,
      categories: catalog.categories.length,
      checks: ['catalog', 'assets', 'headers', 'admin-auth', 'api-404', 'page-404'],
    },
    null,
    2,
  ),
);
