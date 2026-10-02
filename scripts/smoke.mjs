import { waitForDeploymentHealth } from './release-guards.mjs';
const base = process.argv[2];
if (!base) throw new Error('Usage: npm run smoke -- https://host');
const request = async (path, remaining = 20000) => {
  const r = await fetch(new URL(path, base), {
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.min(20000, remaining)),
  });
  return r;
};
const state = await waitForDeploymentHealth(
  (remaining) => request('/api/health', remaining),
  process.env.EXPECTED_VERSION,
);
if (process.env.TARGET_ENV && state.environment !== process.env.TARGET_ENV)
  throw new Error('Wrong deployment environment');
const publicResponse = await request('/api/catalog');
if (publicResponse.status !== 200) throw new Error(`Catalog ${publicResponse.status}`);
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
for (const path of ['/admin', '/admin/']) {
  const admin = await request(path);
  if (admin.status !== 303 || admin.headers.get('location') !== new URL('/admin/login', base).href)
    throw new Error('Admin must navigate to Access before loading its session');
}
for (const path of ['/api/admin/session', '/api/admin/data', '/api/admin/export']) {
  const r = await request(path);
  if (r.status !== 401 || !r.headers.get('content-type')?.includes('application/json'))
    throw new Error(`${path} must return an unauthorized JSON response, got ${r.status}`);
}
const missing = await request('/api/no-such-endpoint');
if (missing.status !== 404 || !missing.headers.get('content-type')?.includes('json'))
  throw new Error('API 404 contract');
const errorPage = await request('/no-such-page');
if (errorPage.status !== 404) throw new Error('Page 404 contract');
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((x) => x[1]);
if (!assets.some((path) => path.endsWith('.js')) || !assets.some((path) => path.endsWith('.css')))
  throw new Error('Built application assets missing from HTML');
for (const path of assets) {
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
      checks: [
        'catalog',
        'assets',
        'headers',
        'admin-login-navigation',
        'admin-auth',
        'api-404',
        'page-404',
      ],
    },
    null,
    2,
  ),
);
