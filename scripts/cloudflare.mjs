import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { routeMatchesHostname } from './release-guards.mjs';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const zone = process.env.CLOUDFLARE_ZONE_ID;
const mode = process.argv[2] || 'inspect';
if (!['inspect', 'provision'].includes(mode)) throw new Error('Invalid resource operation');
if (!account || !token || !zone) throw new Error('Cloudflare environment is incomplete');
if (mode !== 'inspect' && process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Cloudflare writes must run in GitHub Actions');
}
async function api(path, method = 'GET', body, fullResponse = false) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const value = await response.json();
  if (!response.ok || !value.success) {
    throw new Error(
      `Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(value.errors)}`,
    );
  }
  return fullResponse ? value : value.result;
}
async function list(path) {
  const records = [];
  for (let page = 1; page <= 100; page++) {
    const value = await api(`${path}?per_page=100&page=${page}`, 'GET', undefined, true);
    if (!Array.isArray(value.result)) throw new Error('Invalid Cloudflare resource list');
    records.push(...value.result);
    const lastPage = value.result_info?.total_pages;
    if (
      value.result.length === 0 ||
      (Number.isInteger(lastPage) && page >= lastPage) ||
      (!lastPage && value.result.length < 100)
    )
      return records;
  }
  throw new Error('Cloudflare resource pagination exceeded safety limit');
}
const [databases, domains, routes, organization, apps, subdomain] = await Promise.all([
  list(`accounts/${account}/d1/database`),
  api(`accounts/${account}/workers/domains`),
  api(`zones/${zone}/workers/routes`),
  api(`accounts/${account}/access/organizations`),
  list(`accounts/${account}/access/apps`),
  api(`accounts/${account}/workers/subdomain`),
]);
const legacyBinding = domains.find((x) => x.hostname === 'nav.lily.lat');
if (
  !legacyBinding ||
  !['websitenavigation', 'cf-nav'].includes(legacyBinding.service) ||
  legacyBinding.zone_id !== zone ||
  legacyBinding.environment !== 'production'
) {
  throw new Error('Unexpected production binding; refusing to proceed');
}
const result = {
  accountId: account,
  zoneId: zone,
  accessTeamDomain: organization.auth_domain,
  workersSubdomain: subdomain.subdomain,
  legacyBinding,
  productionRoutes: routes.filter((x) => routeMatchesHostname(x.pattern, 'nav.lily.lat')),
  databases: databases.filter((x) => x.name.startsWith('cf-nav')),
};
if (mode === 'provision') {
  const existingApps = apps.filter((x) => x.name === 'cf-nav administrator');
  if (existingApps.length > 1) throw new Error('Ambiguous cf-nav Access applications');
  const existing = existingApps[0];
  // The established application supplies the owner only on first provisioning.
  // Subsequent runs remain independent and preserve the cf-nav owner's policy.
  const ownerApp = existing || apps.find((x) => x.id === 'e7c70bbd-5bd3-4324-aa2c-f7c75bb012a9');
  if (!ownerApp) throw new Error('Established owner Access application not found');
  const policies = await api(`accounts/${account}/access/apps/${ownerApp.id}/policies`);
  const ownerRules = policies.filter((p) => p.decision === 'allow').flatMap((p) => p.include);
  if (
    ownerRules.length !== 1 ||
    !ownerRules[0].email?.email ||
    policies.some((p) => ['bypass', 'non_identity'].includes(p.decision))
  ) {
    throw new Error('Established Access policy is not an unambiguous single-email owner');
  }
  const email = ownerRules[0].email.email.toLowerCase();
  result.adminEmailHash = createHash('sha256').update(email).digest('hex');
  for (const name of ['cf-nav-staging-db', 'cf-nav-db']) {
    const matches = databases.filter((x) => x.name === name);
    if (matches.length > 1) throw new Error('Ambiguous cf-nav database names');
    let database = matches[0];
    if (!database) database = await api(`accounts/${account}/d1/database`, 'POST', { name });
    result.databases = result.databases.filter((x) => x.name !== name);
    result.databases.push({ name, uuid: database.uuid });
  }
  const hosts = [
    `cf-nav-staging.${subdomain.subdomain}.workers.dev`,
    `cf-nav.${subdomain.subdomain}.workers.dev`,
    'nav.lily.lat',
  ];
  // Separate applications avoid Access cookie-distribution callbacks to another
  // host that is not yet deployed or is still served by the legacy Worker.
  result.access = {};
  for (const [key, name, host] of [
    ['staging', 'cf-nav administrator', hosts[0]],
    ['production', 'cf-nav production administrator', hosts[2]],
    ['productionPreview', 'cf-nav production preview administrator', hosts[1]],
  ]) {
    const matches = apps.filter((item) => item.name === name);
    if (matches.length > 1) throw new Error('Ambiguous cf-nav Access applications');
    let app = matches[0];
    const expectedDomain = `${host}/admin/login`;
    const appBody = {
      name,
      type: 'self_hosted',
      domain: expectedDomain,
      self_hosted_domains: [expectedDomain],
      session_duration: '8h',
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: 'lax',
      app_launcher_visible: false,
      policies: [{ name: 'Single owner', decision: 'allow', include: [{ email: { email } }] }],
    };
    if (app) {
      const actualHosts = [...(app.self_hosted_domains || [])].sort();
      const originalHosts = hosts.map((item) => `${item}/admin/login`).sort();
      const isOriginalStaging =
        key === 'staging' && JSON.stringify(actualHosts) === JSON.stringify(originalHosts);
      const isSingleHost = actualHosts.length === 1 && actualHosts[0] === expectedDomain;
      if (
        app.type !== 'self_hosted' ||
        app.domain !== expectedDomain ||
        (!isOriginalStaging && !isSingleHost)
      ) {
        throw new Error(
          'Unexpected existing Access domains; refusing to modify another application',
        );
      }
      const currentPolicies =
        app.id === ownerApp.id
          ? policies
          : await api(`accounts/${account}/access/apps/${app.id}/policies`);
      const currentOwners = currentPolicies
        .filter((policy) => policy.decision === 'allow')
        .flatMap((policy) => policy.include);
      if (
        currentOwners.length !== 1 ||
        currentOwners[0].email?.email?.toLowerCase() !== email ||
        currentPolicies.some((policy) => ['bypass', 'non_identity'].includes(policy.decision))
      ) {
        throw new Error('Existing cf-nav Access owner differs; refusing policy changes');
      }
      if (
        isOriginalStaging ||
        app.http_only_cookie_attribute !== true ||
        app.same_site_cookie_attribute !== 'lax'
      ) {
        // Preserve exclusions, MFA requirements and policy IDs when shrinking the
        // originally provisioned multi-host application to the staging hostname.
        appBody.policies = currentPolicies.map((policy) => ({
          id: policy.id,
          name: policy.name,
          decision: policy.decision,
          include: policy.include,
          require: policy.require,
          exclude: policy.exclude,
          precedence: policy.precedence,
        }));
        app = await api(`accounts/${account}/access/apps/${app.id}`, 'PUT', appBody);
      }
    } else {
      app = await api(`accounts/${account}/access/apps`, 'POST', appBody);
    }
    result.access[key] = { id: app.id, aud: app.aud, hosts: [host] };
  }
}
await mkdir('build', { recursive: true });
await writeFile('build/cloudflare-resources.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
