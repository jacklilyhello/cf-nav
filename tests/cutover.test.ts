import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

interface DomainBinding {
  hostname: string;
  service: string;
  zone_id: string;
  environment: string;
}
interface Scenario {
  mode?: 'production' | 'rollback';
  before?: Partial<DomainBinding> | null;
  routes?: { pattern: string; script: string }[];
  health?: { app: string; environment: string; version: string };
  after?: Partial<DomainBinding>;
}
interface HarnessResult {
  error: string | null;
  calls: { path: string; method: string; host: string }[];
  writes: { path: string; method: string; body: unknown; beforeSaved: boolean }[];
  beforeArtifact: DomainBinding | null;
  afterArtifact: DomainBinding | null;
  domains: DomainBinding[];
}
const oldBinding: DomainBinding = {
  hostname: 'nav.lily.lat',
  service: 'websitenavigation',
  zone_id: 'zone',
  environment: 'production',
};
const unrelatedBinding: DomainBinding = {
  hostname: 'other.lily.lat',
  service: 'unrelated-worker',
  zone_id: 'zone',
  environment: 'production',
};

function runCutover(scenario: Scenario = {}): HarnessResult {
  const directory = mkdtempSync(join(tmpdir(), 'cf-nav-cutover-'));
  const script = new URL('../scripts/cutover.mjs', import.meta.url).href;
  const harness = `
    import { existsSync } from 'node:fs';
    const scenario = ${JSON.stringify(scenario)};
    const before = scenario.before === null ? null : {...${JSON.stringify(oldBinding)}, ...scenario.before};
    const domains = [...(before ? [before] : []), ${JSON.stringify(unrelatedBinding)}];
    const calls = [];
    const writes = [];
    let transferred = false;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method || 'GET';
      calls.push({path: url.pathname, method, host: url.hostname});
      if (url.hostname === 'cf-nav.lilyya.workers.dev' && url.pathname === '/api/health' && method === 'GET') {
        return Response.json(scenario.health || {app: 'cf-nav', environment: 'production', version: 'approved-sha'});
      }
      if (url.hostname !== 'api.cloudflare.com') throw new Error('Unexpected fetch host');
      const path = url.pathname;
      let result;
      if (method !== 'GET') {
        const body = JSON.parse(init.body);
        writes.push({path, method, body, beforeSaved: existsSync('build/domain-before.json')});
        if (method !== 'PUT' || !['cf-nav','websitenavigation'].some(service => path === '/client/v4/accounts/account/workers/scripts/' + service + '/domains/records')) {
          throw new Error('Unexpected write endpoint ' + path);
        }
        const service = path.split('/')[7];
        const current = domains.find(item => item.hostname === 'nav.lily.lat');
        Object.assign(current, {service});
        transferred = true;
        result = {success: true};
      } else if (path === '/client/v4/accounts/account/workers/domains') {
        result = domains.map(item => item.hostname === 'nav.lily.lat' && transferred ? {...item, ...scenario.after} : item);
      } else if (path === '/client/v4/zones/zone/workers/routes') {
        result = scenario.routes || [];
      } else throw new Error('Unexpected read endpoint ' + path);
      return Response.json({success: true, result});
    };
    process.argv[2] = scenario.mode || 'production';
    let error = null;
    try { await import(${JSON.stringify(script)}); }
    catch (cause) { error = cause.message; }
    console.log('RESULT ' + JSON.stringify({error, calls, writes, domains}));
  `;
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', harness], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: 'approved-sha',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        CLOUDFLARE_ZONE_ID: 'zone',
        CLOUDFLARE_API_TOKEN: 'dummy-test-token',
        CF_PRODUCTION_DOMAIN: 'nav.lily.lat',
        CF_WORKER_NAME: 'cf-nav',
      },
    });
    const result = JSON.parse(
      output
        .split('\n')
        .find((line) => line.startsWith('RESULT '))!
        .slice(7),
    ) as HarnessResult;
    for (const [file, field] of [
      ['domain-before.json', 'beforeArtifact'],
      ['domain-after.json', 'afterArtifact'],
    ] as const) {
      try {
        result[field] = JSON.parse(readFileSync(join(directory, 'build', file), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        result[field] = null;
      }
    }
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('production custom domain transfer', () => {
  it.each([
    ['production', 'websitenavigation', 'cf-nav'],
    ['rollback', 'cf-nav', 'websitenavigation'],
  ] as const)(
    '%s transfers only the named origin without uploading or deleting any Worker code',
    (mode, previousService, service) => {
      const result = runCutover({ mode, before: { service: previousService } });
      expect(result.error).toBeNull();
      expect(result.writes).toEqual([
        {
          path: `/client/v4/accounts/account/workers/scripts/${service}/domains/records`,
          method: 'PUT',
          beforeSaved: true,
          body: {
            override_scope: false,
            override_existing_origin: true,
            override_existing_dns_record: false,
            origins: [
              { hostname: 'nav.lily.lat', zone_id: 'zone', enabled: true, previews_enabled: false },
            ],
          },
        },
      ]);
      expect(result.beforeArtifact).toEqual({ ...oldBinding, service: previousService });
      expect(result.afterArtifact).toEqual({ ...oldBinding, service });
      expect(result.domains.find((item) => item.hostname === 'other.lily.lat')).toEqual(
        unrelatedBinding,
      );
      expect(result.calls.filter((call) => call.host === 'cf-nav.lilyya.workers.dev')).toHaveLength(
        mode === 'production' ? 1 : 0,
      );
    },
  );

  it.each([
    null,
    { service: 'unknown-worker' },
    { zone_id: 'different-zone' },
    { environment: 'staging' },
  ])('refuses unknown or mismatched existing ownership before any write: %j', (before) => {
    const result = runCutover({ before });
    expect(result.error).toBe('Unexpected current binding');
    expect(result.writes).toEqual([]);
    expect(result.beforeArtifact).toBeNull();
    expect(result.afterArtifact).toBeNull();
  });

  it.each(['*.lily.lat/*', '*lily.lat/admin*', '*/*', 'https://nav.lily.lat/*'])(
    'refuses interception route %s before any write',
    (pattern) => {
      const result = runCutover({ routes: [{ pattern, script: 'other-worker' }] });
      expect(result.error).toBe('Conflicting route requires investigation');
      expect(result.writes).toEqual([]);
      expect(result.beforeArtifact).toBeNull();
      expect(result.afterArtifact).toBeNull();
    },
  );

  it.each([
    { app: 'cf-nav', environment: 'production', version: 'different-sha' },
    { app: 'other-worker', environment: 'production', version: 'approved-sha' },
    { app: 'cf-nav', environment: 'staging', version: 'approved-sha' },
  ])('refuses unapproved production health before any write: %j', (health) => {
    const result = runCutover({ health });
    expect(result.error).toBe('Production Worker does not match approved source');
    expect(result.writes).toEqual([]);
    expect(result.beforeArtifact).toBeNull();
    expect(result.afterArtifact).toBeNull();
  });

  it.each([
    { service: 'websitenavigation' },
    { zone_id: 'different-zone' },
    { environment: 'staging' },
  ])('fails mismatched readback without reporting a successful after artifact: %j', (after) => {
    const result = runCutover({ after });
    expect(result.error).toBe('Domain readback mismatch');
    expect(result.writes).toHaveLength(1);
    expect(result.beforeArtifact).toEqual(oldBinding);
    expect(result.afterArtifact).toBeNull();
  });
});
