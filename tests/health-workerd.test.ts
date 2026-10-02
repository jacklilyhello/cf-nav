import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, type V4ModuleDefinition } from 'miniflare';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type { HealthResult } from '../src/health';

let runtime: Miniflare;
beforeAll(() => {
  // Run the actual health source in workerd, including its native Request/fetch.
  // Only the external network is replaced by a deterministic second local Worker.
  const modules: V4ModuleDefinition[] = [
    {
      type: 'ESModule',
      path: resolve('health-runtime-entry.js'),
      contents: `
      import { checkLink } from './src/health/index.js';
      export default { async fetch(request) {
        const url = new URL(request.url);
        const target = url.pathname === '/dns-redirect' ? 'https://blocked.example.com/'
          : url.pathname === '/challenge' ? 'https://challenge.example.com/' : 'https://example.com/';
        return Response.json(await checkLink({url: target, name:'Example'}, {runtime:'cloudflare-public'}));
      }};
    `,
    },
  ];
  for (const filename of readdirSync('src/health').filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`src/health/${filename}`, 'utf8');
    const compiled = transpileModule(source, {
      compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
    }).outputText.replace(/from (['"])(\.\/[^'"]+)\1/g, 'from "$2.js"');
    modules.push({
      type: 'ESModule',
      path: resolve(`src/health/${filename.replace(/\.ts$/, '.js')}`),
      contents: compiled,
    });
  }
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'health-checker',
          modules,
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['global_fetch_strictly_public'],
          outboundService: 'public-network-fixture',
        },
        {
          name: 'public-network-fixture',
          modules: true,
          compatibilityDate: '2026-10-01',
          script: `
      export default { async fetch(request) {
        const url = new URL(request.url);
        if(url.hostname === 'cloudflare-dns.com') {
          const name = url.searchParams.get('name');
          const type = Number(url.searchParams.get('type'));
          if(name === 'blocked.example.com') return new Response('', {status:302, headers:{Location:'http://127.0.0.1/'}});
          return Response.json({Status:0,TC:false,Question:[{name:name+'.',type}],Answer:type===1?[{name:name+'.',type:1,data:'93.184.215.14'}]:[]});
        }
        if(url.hostname === 'challenge.example.com') return new Response('<title>Just a moment</title>', {status:403,headers:{'content-type':'text/html','cf-mitigated':'challenge'}});
        if(url.hostname === 'example.com') return new Response('<title>Example service</title>', {headers:{'content-type':'text/html'}});
        return new Response('Unexpected outbound destination', {status:500});
      }};
    `,
        },
      ],
    }),
  );
});
afterAll(async () => {
  await runtime?.dispose();
});

describe('real Workers health transport compatibility', () => {
  it('completes native fetch DNS preflight and target inspection', async () => {
    const result = (await (
      await runtime.dispatchFetch('https://checker.test/')
    ).json()) as HealthResult;
    expect(result.status).toBe('healthy');
    expect(result.httpStatus).toBe(200);
    expect(result.title).toBe('Example service');
    expect(result.error).toBeNull();
  });

  it('rejects resolver redirects in the native fetch runtime', async () => {
    const result = (await (
      await runtime.dispatchFetch('https://checker.test/dns-redirect')
    ).json()) as HealthResult;
    expect(result.status).toBe('dns_error');
    expect(result.error).toBe('DNS_RESOLVER_UNAVAILABLE');
    expect(result.httpStatus).toBeNull();
  });

  it('retains bot challenges as unverified, without incrementing death-like failures', async () => {
    const result = (await (
      await runtime.dispatchFetch('https://checker.test/challenge')
    ).json()) as HealthResult;
    expect(result.status).toBe('challenge');
    expect(result.httpStatus).toBe(403);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.isSuccess).toBe(false);
  });
});
