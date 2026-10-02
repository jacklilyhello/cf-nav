import { mkdir, writeFile } from 'node:fs/promises';
import { routeMatchesHostname } from './release-guards.mjs';
const mode = process.argv[2];
if (!['production', 'rollback'].includes(mode)) throw new Error('Specify production or rollback');
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Domain changes run only in Actions');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const zone = process.env.CLOUDFLARE_ZONE_ID;
const hostname = process.env.CF_PRODUCTION_DOMAIN;
const worker = process.env.CF_WORKER_NAME;
if (!account || !zone || !process.env.CLOUDFLARE_API_TOKEN)
  throw new Error('Cloudflare environment is incomplete');
if (hostname !== 'nav.lily.lat' || worker !== 'cf-nav')
  throw new Error('Unexpected deployment target');
const headers = {
  Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
  'Content-Type': 'application/json',
};
async function api(path, method = 'GET', body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(JSON.stringify({ status: r.status, errors: j.errors }));
  return j.result;
}
const domains = await api(`accounts/${account}/workers/domains`);
const before = domains.find((x) => x.hostname === hostname);
if (
  !before ||
  !['cf-nav', 'websitenavigation'].includes(before.service) ||
  before.zone_id !== zone ||
  before.environment !== 'production'
)
  throw new Error('Unexpected current binding');
const routes = await api(`zones/${zone}/workers/routes`);
if (routes.some((x) => routeMatchesHostname(x.pattern, hostname)))
  throw new Error('Conflicting route requires investigation');
if (mode === 'production') {
  const r = await fetch('https://cf-nav.lilyya.workers.dev/api/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  const health = await r.json();
  if (
    !r.ok ||
    health.app !== 'cf-nav' ||
    health.environment !== 'production' ||
    health.version !== process.env.GITHUB_SHA
  )
    throw new Error('Production Worker does not match approved source');
}
await mkdir('build', { recursive: true });
await writeFile('build/domain-before.json', JSON.stringify(before, null, 2));
const service = mode === 'production' ? worker : 'websitenavigation';
// Use Wrangler's scoped origins endpoint to transfer this already-verified
// hostname atomically. Preserve other origins and refuse unrelated DNS conflicts.
await api(`accounts/${account}/workers/scripts/${service}/domains/records`, 'PUT', {
  override_scope: false,
  override_existing_origin: true,
  override_existing_dns_record: false,
  origins: [{ hostname, zone_id: zone, enabled: true, previews_enabled: false }],
});
const after = (await api(`accounts/${account}/workers/domains`)).find(
  (x) => x.hostname === hostname,
);
if (after?.service !== service || after?.zone_id !== zone || after?.environment !== 'production')
  throw new Error('Domain readback mismatch');
await writeFile('build/domain-after.json', JSON.stringify(after, null, 2));
console.log(
  JSON.stringify({
    hostname,
    previousService: before.service,
    service: after.service,
    oldWorkerPreserved: true,
  }),
);
