import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('production health egress security boundary', () => {
  it('keeps Cloudflare public-only fetch enabled in every deployment environment', () => {
    const config = JSON.parse(
      readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(
        /,\s*([}\]])/g,
        '$1',
      ),
    ) as {
      compatibility_flags: string[];
      env: Record<string, { compatibility_flags?: string[] }>;
    };
    expect(config.compatibility_flags).toContain('global_fetch_strictly_public');
    for (const environment of Object.values(config.env)) {
      const flags = environment.compatibility_flags || config.compatibility_flags;
      expect(flags).toContain('global_fetch_strictly_public');
      expect(flags).not.toContain('global_fetch_private_origin');
    }
  });

  it('does not grant the health worker private-network bindings', () => {
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).not.toMatch(/"(?:vpc_services|vpc_networks|services)"\s*:/);
  });
});
