import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const zone = process.env.CLOUDFLARE_ZONE_ID;
const mode = process.argv[2] || 'inspect';
if (!account || !token || !zone) throw new Error('Cloudflare environment is incomplete');
if (mode !== 'inspect' && process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Cloudflare writes must run in GitHub Actions');
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok || !value.success) {
    throw new Error(
      `Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(value.errors)}`,
    );
  }
  return value.result;
}
const [databases, domains, routes, organization, apps, subdomain] = await Promise.all([
  api(`accounts/${account}/d1/database?per_page=100`),
  api(`accounts/${account}/workers/domains`),
  api(`zones/${zone}/workers/routes`),
  api(`accounts/${account}/access/organizations`),
  api(`accounts/${account}/access/apps?per_page=100`),
  api(`accounts/${account}/workers/subdomain`),
]);
const legacyBinding = domains.find((x) => x.hostname === 'nav.lily.lat');
if (!legacyBinding || !['websitenavigation', 'cf-nav'].includes(legacyBinding.service)) {
  throw new Error('Unexpected production binding; refusing to proceed');
}
const result = {
  accountId: account,
  zoneId: zone,
  accessTeamDomain: organization.auth_domain,
  workersSubdomain: subdomain.subdomain,
  legacyBinding,
  productionRoutes: routes.filter((x) => x.pattern.includes('nav.lily.lat')),
  databases: databases.filter((x) => x.name.startsWith('cf-nav')),
};
if (mode === 'provision') {
  const ownerApp = apps.find((x) => x.id === 'e7c70bbd-5bd3-4324-aa2c-f7c75bb012a9');
  if (!ownerApp) throw new Error('Established owner Access application not found');
  const policies = await api(`accounts/${account}/access/apps/${ownerApp.id}/policies`);
  const ownerRules = policies.filter((p) => p.decision === 'allow').flatMap((p) => p.include);
  if (ownerRules.length !== 1 || !ownerRules[0].email?.email) {
    throw new Error('Established Access policy is not an unambiguous single-email owner');
  }
  const email = ownerRules[0].email.email.toLowerCase();
  result.adminEmailHash = createHash('sha256').update(email).digest('hex');
  for (const name of ['cf-nav-staging-db', 'cf-nav-db']) {
    let database = databases.find((x) => x.name === name);
    if (!database) database = await api(`accounts/${account}/d1/database`, 'POST', { name });
    result.databases = result.databases.filter((x) => x.name !== name);
    result.databases.push({ name, uuid: database.uuid });
  }
  const hosts = [
    `cf-nav-staging.${subdomain.subdomain}.workers.dev`,
    `cf-nav.${subdomain.subdomain}.workers.dev`,
    'nav.lily.lat',
  ];
  const existing = apps.find((x) => x.name === 'cf-nav administrator');
  const appBody = {
    name: 'cf-nav administrator',
    type: 'self_hosted',
    domain: `${hosts[0]}/admin/login`,
    self_hosted_domains: hosts.map((host) => `${host}/admin/login`),
    session_duration: '8h',
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: 'lax',
    app_launcher_visible: false,
    policies: [{ name: 'Single owner', decision: 'allow', include: [{ email: { email } }] }],
  };
  const app = await api(
    `accounts/${account}/access/apps${existing ? `/${existing.id}` : ''}`,
    existing ? 'PUT' : 'POST',
    appBody,
  );
  result.access = { id: app.id, aud: app.aud, hosts };
}
await mkdir('build', { recursive: true });
await writeFile('build/cloudflare-resources.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
