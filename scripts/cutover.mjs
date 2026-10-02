import { mkdir, writeFile } from 'node:fs/promises';
const mode = process.argv[2];
if (!['production', 'rollback'].includes(mode)) throw new Error('Specify production or rollback');
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Domain changes run only in Actions');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const zone = process.env.CLOUDFLARE_ZONE_ID;
const hostname = process.env.CF_PRODUCTION_DOMAIN;
const worker = process.env.CF_WORKER_NAME;
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
if (!before || !['cf-nav', 'websitenavigation'].includes(before.service) || before.zone_id !== zone)
  throw new Error('Unexpected current binding');
const routes = await api(`zones/${zone}/workers/routes`);
if (routes.some((x) => x.pattern.includes(hostname)))
  throw new Error('Conflicting route requires investigation');
if (mode === 'production') {
  const r = await fetch('https://cf-nav.lilyya.workers.dev/api/health');
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
await api(`accounts/${account}/workers/domains`, 'PUT', {
  hostname,
  service,
  environment: 'production',
  zone_id: zone,
});
const after = (await api(`accounts/${account}/workers/domains`)).find(
  (x) => x.hostname === hostname,
);
if (after?.service !== service) throw new Error('Domain readback mismatch');
await writeFile('build/domain-after.json', JSON.stringify(after, null, 2));
console.log(
  JSON.stringify({
    hostname,
    previousService: before.service,
    service: after.service,
    oldWorkerPreserved: true,
  }),
);
