import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import worker from '../src/worker';
import type { Env } from '../src/shared/types';
import * as security from '../src/api/security';
import {
  buildSeedSql,
  routeMatchesHostname,
  waitForDeploymentHealth,
} from '../scripts/release-guards.mjs';

const shell =
  '<!doctype html><title>Lily 导航</title><main id="app"></main><script src="/assets/main.js"></script>';
function assetEnvironment() {
  const assets = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/index.html') return Response.redirect('https://nav.lily.lat/', 307);
    if (path === '/')
      return new Response(request.method === 'HEAD' ? null : shell, {
        headers: { 'Content-Type': 'text/html' },
      });
    return new Response('missing', { status: 404 });
  });
  return {
    assets,
    env: {
      ASSETS: { fetch: assets },
      DB: {
        prepare: () => ({ first: async () => null }),
        batch: async () => [{ results: [] }, { results: [] }],
      },
      APP_ENV: 'production',
      PUBLIC_ORIGIN: 'https://nav.lily.lat',
    } as unknown as Env,
  };
}

describe('Worker static routing release regressions', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['/', '/admin', '/admin/'])(
    'serves %s without canonicalization after any required authentication',
    async (path) => {
      const { env, assets } = assetEnvironment();
      // These tests isolate asset canonicalization; real JWT and anonymous redirects
      // are covered separately in api.test.ts.
      const authentication = vi.spyOn(security, 'authenticate').mockResolvedValue({
        email: 'owner@example.com',
        csrfToken: 'test-token',
      });
      const response = await worker.fetch(new Request(`https://nav.lily.lat${path}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toContain('Lily 导航');
      expect(assets).toHaveBeenCalledOnce();
      expect(new URL(assets.mock.calls[0]![0].url).pathname).toBe('/');
      if (path.startsWith('/admin')) {
        expect(authentication).toHaveBeenCalledOnce();
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
      } else expect(authentication).not.toHaveBeenCalled();
    },
  );

  it('returns the branded shell at HTTP404 without a redirect for unknown paths', async () => {
    const { env, assets } = assetEnvironment();
    const response = await worker.fetch(new Request('https://nav.lily.lat/missing-page'), env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(shell);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(assets.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      '/missing-page',
      '/',
    ]);
  });

  it('preserves HEAD semantics for the shell and branded404', async () => {
    const { env } = assetEnvironment();
    for (const [path, status] of [
      ['/', 200],
      ['/missing', 404],
    ] as const) {
      const response = await worker.fetch(
        new Request(`https://nav.lily.lat${path}`, { method: 'HEAD' }),
        env,
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('');
    }
  });
});

describe('release safety guards', () => {
  it.each([
    'nav.lily.lat/*',
    'https://nav.lily.lat/*',
    '*.lily.lat/*',
    '*lily.lat/admin*',
    'http://*.lily.lat/*',
    '*/*',
  ])('detects route %s that can intercept the production hostname', (pattern) => {
    expect(routeMatchesHostname(pattern, 'nav.lily.lat')).toBe(true);
  });
  it.each(['other.lily.lat/*', '*.example.com/*', 'lily.lat/*', 'notnav.lily.lat/*'])(
    'does not confuse unrelated route %s',
    (pattern) => {
      expect(routeMatchesHostname(pattern, 'nav.lily.lat')).toBe(false);
    },
  );

  it('serializes production deploy and domain cutover through the same concurrency group', () => {
    expect(readFileSync('.github/workflows/deploy.yml', 'utf8')).toContain(
      "group: cf-nav-delivery-${{ inputs.environment || 'staging' }}",
    );
    expect(readFileSync('.github/workflows/domain.yml', 'utf8')).toContain(
      'group: cf-nav-delivery-production',
    );
  });

  it('retries only expected deployment propagation states within a bounded deadline', async () => {
    let time = 0;
    const states = [
      new Response('', { status: 404 }),
      new Response('', { status: 503 }),
      Response.json({ ok: true, app: 'cf-nav', version: 'old' }),
      Response.json({ ok: true, app: 'cf-nav', version: 'new' }),
    ];
    const result = await waitForDeploymentHealth(async () => states.shift()!, 'new', {
      now: () => time,
      delay: async (ms) => {
        time += ms;
      },
      maxWaitMs: 20_000,
    });
    expect(result.version).toBe('new');
    expect(time).toBe(15_000);
  });

  it('fails bounded readiness when the deployed source stays stale', async () => {
    let time = 0;
    await expect(
      waitForDeploymentHealth(
        async () => Response.json({ ok: true, app: 'cf-nav', version: 'old' }),
        'new',
        {
          now: () => time,
          delay: async (ms) => {
            time += ms;
          },
          maxWaitMs: 10_000,
        },
      ),
    ).rejects.toThrow('timed out');
    expect(time).toBe(10_000);
  });

  it('does not retry authentication errors or accept a different Worker', async () => {
    const delay = vi.fn();
    await expect(
      waitForDeploymentHealth(async () => new Response('', { status: 403 }), 'new', { delay }),
    ).rejects.toThrow('403');
    await expect(
      waitForDeploymentHealth(async () => Response.json({ ok: true, app: 'legacy' }), 'new', {
        delay,
      }),
    ).rejects.toThrow('Wrong Worker');
    expect(delay).not.toHaveBeenCalled();
  });
});

describe('audited seed safety', () => {
  const seed = {
    version: 1,
    categories: [{ id: 'tools', name: 'Tools', slug: 'tools' }],
    links: [
      {
        id: 'resource',
        categoryId: 'tools',
        name: "Example's tools",
        url: 'https://example.com/#/tools',
        healthStatus: 'healthy',
        observedTitle: 'Example service',
        healthEvidence: ['matched'],
        lastSuccessAt: '2026-10-02T00:00:00.000Z',
      },
    ],
  };
  it.each([
    { ...seed, links: [] },
    { ...seed, categories: [] },
    { ...seed, links: [seed.links[0], seed.links[0]] },
  ])('rejects empty or duplicate seeds before a completion marker can be written', (input) => {
    expect(() => buildSeedSql(input, 'now')).toThrow();
  });

  it('preserves owner edits and imported identity evidence on repeated deployment', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(readFileSync('migrations/0001_initial.sql', 'utf8'));
      const sql = buildSeedSql(seed, 'now');
      db.exec(sql);
      const first = db.prepare('SELECT * FROM links').get()!;
      expect(first.url).toBe(seed.links[0].url);
      expect(first.name).toBe("Example's tools");
      expect(first.confirmedTitle).toBe('Example service');
      expect(first.healthEvidence).toBe('["matched"]');
      db.exec("UPDATE links SET name='Owner edit',notes='private note'");
      db.exec(buildSeedSql(seed, 'later'));
      expect(db.prepare('SELECT name,notes FROM links').get()).toEqual({
        name: 'Owner edit',
        notes: 'private note',
      });
      expect(db.prepare("SELECT value FROM metadata WHERE key='seed-imported'").get()!.value).toBe(
        'now',
      );
    } finally {
      db.close();
    }
  });

  it('does not promote an unverified page title to confirmed identity', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(readFileSync('migrations/0001_initial.sql', 'utf8'));
      db.exec(
        buildSeedSql(
          {
            ...seed,
            links: [
              { ...seed.links[0], healthStatus: 'challenge', observedTitle: 'Just a moment' },
            ],
          },
          'now',
        ),
      );
      expect(db.prepare('SELECT confirmedTitle,lastSuccessAt FROM links').get()).toEqual({
        confirmedTitle: null,
        lastSuccessAt: null,
      });
    } finally {
      db.close();
    }
  });
});

describe('single-host Access provisioning', () => {
  it('shrinks the original staging application, creates isolated production apps, and reuses existing resources on rerun', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cf-nav-release-'));
    const script = new URL('../scripts/cloudflare.mjs', import.meta.url).href;
    const harness = `
      const hosts=['cf-nav-staging.lilyya.workers.dev','cf-nav.lilyya.workers.dev','nav.lily.lat'];
      const owner={id:'owner-policy',name:'Owner',decision:'allow',include:[{email:{email:'owner@example.com'}}],require:[{email_domain:{domain:'example.com'}}],exclude:[]};
      const apps=[{id:'staging-id',aud:'staging-aud',name:'cf-nav administrator',type:'self_hosted',domain:hosts[0]+'/admin/login',self_hosted_domains:hosts.map(h=>h+'/admin/login'),http_only_cookie_attribute:true,same_site_cookie_attribute:'lax'}];
      const writes=[];
      globalThis.fetch=async(input,init={})=>{
        const u=new URL(input);const p=u.pathname;const method=init.method||'GET';let result;
        if(method!=='GET'){
          const body=JSON.parse(init.body);writes.push({method,path:p,body});
          if(p.endsWith('/access/apps/staging-id')) {Object.assign(apps[0],body);result=apps[0];}
          else if(p.endsWith('/access/apps')){result={...body,id:'app-'+apps.length,aud:'aud-'+apps.length};apps.push(result);}
          else throw new Error('Unexpected write '+p);
        } else if(p.endsWith('/d1/database')) result=[{name:'cf-nav-staging-db',uuid:'staging-db'},{name:'cf-nav-db',uuid:'prod-db'}];
        else if(p.endsWith('/workers/domains')) result=[{hostname:'nav.lily.lat',service:'websitenavigation',zone_id:'zone',environment:'production'}];
        else if(p.endsWith('/workers/routes')) result=[];
        else if(p.endsWith('/access/organizations')) result={auth_domain:'team.cloudflareaccess.com'};
        else if(p.endsWith('/access/apps')) result=apps;
        else if(p.endsWith('/workers/subdomain')) result={subdomain:'lilyya'};
        else if(p.endsWith('/policies')) result=[owner];
        else throw new Error('Unexpected read '+p);
        return Response.json({success:true,result,result_info:{total_pages:1}});
      };
      process.argv[2]='provision';
      await import(${JSON.stringify(script)}+'?run=1');
      await import(${JSON.stringify(script)}+'?run=2');
      console.log('RESULT '+JSON.stringify({writes,apps}));
    `;
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', harness], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          CLOUDFLARE_ACCOUNT_ID: 'account',
          CLOUDFLARE_ZONE_ID: 'zone',
          CLOUDFLARE_API_TOKEN: 'dummy-test-token',
        },
      });
      const result = JSON.parse(
        output
          .split('\n')
          .find((line) => line.startsWith('RESULT '))!
          .slice(7),
      ) as {
        writes: { body: { policies: { require: unknown[] }[] } }[];
        apps: { self_hosted_domains: string[]; id: string; aud: string }[];
      };
      expect(result.writes).toHaveLength(3);
      expect(result.apps).toHaveLength(3);
      expect(result.apps.every((app) => app.self_hosted_domains.length === 1)).toBe(true);
      expect(result.apps[0]!.id).toBe('staging-id');
      expect(result.apps[0]!.aud).toBe('staging-aud');
      expect(result.writes[0]!.body.policies[0]!.require).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
