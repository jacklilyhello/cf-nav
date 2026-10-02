import { describe, expect, it, vi } from 'vitest';
import { checkLink, createDnsResolver, isPublicIp, validatePublicUrl } from '../src/health';

const publicDns = vi.fn(async () => ['93.184.215.14']);
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

describe('health target admission', () => {
  it.each([
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://10.0.0.1/',
    'https://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'https://localhost/',
    'http://a.local/',
    'https://metadata.google.internal/',
    'https://service.internal/',
    'https://example.com:8080/',
    'https://user:pass@example.com/',
    'https://@example.com/',
    'https://%65xample.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'gopher://example.com/',
    '//example.com/',
    ' https://example.com/',
    'https://example.com\n/',
    'https://example.com\\@127.1/',
    'https://example.com./',
    'https://a..example.com/',
    'https://-a.example.com/',
    'https://a_b.example.com/',
    'https://localhost.example.com/',
    'https://example.invalid/',
    'http://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
  ])('blocks unsafe or unsupported input %s', (url) => {
    expect(() => validatePublicUrl(url)).toThrow();
  });

  it('accepts canonical public domains, IDNs, and default ports', () => {
    expect(validatePublicUrl('HTTPS://Example.COM:443/a?x=1#test').href).toBe(
      'https://example.com/a?x=1',
    );
    expect(validatePublicUrl('http://example.com:80/').href).toBe('http://example.com/');
    expect(validatePublicUrl('https://例子.com/').hostname).toBe('xn--fsqu00a.com');
  });

  it.each([
    '0.0.0.0',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.99.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.0.0.9',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.1.1',
    '198.19.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '1.2.3.999',
    '127.1',
    '2130706433',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    '64:ff9b::808:808',
    '100::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'fec0::1',
    'ff00::1',
    'fe80::1%eth0',
    '2001:db8::1',
    '2001::1',
    '2001:20::1',
    '2002:7f00:1::',
    '3ffe::1',
    '3fff::1',
    'garbage',
    '2001:::1',
    '2606:4700::1::1',
    '2606:4700:4700:1111',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.215.14',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('accepts global address %s', (address) => {
    expect(isPublicIp(address)).toBe(true);
  });
});

describe('per-hop DNS and transport security', () => {
  it('rejects mixed public/private DNS answers without contacting the target', async () => {
    const fetcher = vi.fn();
    const result = await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'cloudflare-public',
        fetcher,
        resolver: async () => ['1.1.1.1', '10.0.0.1'],
      },
    );
    expect(result.status).toBe('blocked');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1/',
    'https://[::1]/',
    'https://metadata.google.internal/',
    'https://safe.example.com\\@127.1/',
  ])('blocks a redirect to %s before fetching it', async (location) => {
    const fetcher = vi.fn(async () => html('', 302, { location }));
    const result = await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'cloudflare-public',
        fetcher,
        resolver: publicDns,
      },
    );
    expect(result.status).toBe('blocked');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('resolves and validates each distinct redirect hostname', async () => {
    const resolver = vi.fn(async (hostname: string) =>
      hostname === 'example.com' ? ['1.1.1.1'] : ['::1'],
    );
    const fetcher = vi.fn(async () =>
      html('', 302, { location: 'https://destination.example.com/' }),
    );
    const result = await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'cloudflare-public',
        fetcher,
        resolver,
      },
    );
    expect(result.status).toBe('blocked');
    expect(resolver.mock.calls.map((call) => call[0])).toEqual([
      'example.com',
      'destination.example.com',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never forwards incoming credentials or follows redirects in the transport', async () => {
    const fetcher = vi.fn(async () => html('<title>Example service</title>'));
    await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'cloudflare-public',
        fetcher,
        resolver: publicDns,
      },
    );
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1];
    expect(options.redirect).toBe('manual');
    expect(new Headers(options.headers).has('cookie')).toBe(false);
    expect(new Headers(options.headers).has('authorization')).toBe(false);
    expect(options.method).toBe('GET');
  });

  it('does not allow an unrestricted runtime to substitute for the public egress boundary', async () => {
    const fetcher = vi.fn();
    const result = await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'node' as 'cloudflare-public',
        fetcher,
        resolver: publicDns,
      },
    );
    expect(result.error).toBe('PUBLIC_EGRESS_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops at an HTTPS downgrade and does not probe the insecure target', async () => {
    const fetcher = vi.fn(async () => html('', 301, { location: 'http://example.com/' }));
    const result = await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'cloudflare-public',
        fetcher,
        resolver: publicDns,
      },
    );
    expect(result.error).toBe('HTTPS_DOWNGRADE_REDIRECT');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds redirect chains and cancels redirect response bodies', async () => {
    let requests = 0;
    const cancellations = vi.fn();
    const fetcher = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel: cancellations }), {
          status: 302,
          headers: { location: `https://example.com/${++requests}` },
        }),
    );
    const result = await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'cloudflare-public',
        fetcher,
        resolver: publicDns,
      },
    );
    expect(result.error).toBe('REDIRECT_LIMIT');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(cancellations).toHaveBeenCalledTimes(4);
  });

  it('detects a redirect loop', async () => {
    const fetcher = vi.fn(async () => html('', 302, { location: 'https://example.com/' }));
    const result = await checkLink(
      { name: 'Example', url: 'https://example.com/' },
      {
        runtime: 'cloudflare-public',
        fetcher,
        resolver: publicDns,
      },
    );
    expect(result.error).toBe('REDIRECT_LOOP');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('DoH response validation', () => {
  function dnsFetcher(address: string, extra: Record<string, unknown> = {}): typeof fetch {
    return vi.fn(async (input) => {
      const url = new URL(String(input));
      const type = Number(url.searchParams.get('type'));
      return Response.json({
        Status: 0,
        TC: false,
        Question: [{ name: 'example.com.', type }],
        Answer: type === 1 ? [{ name: 'example.com.', type: 1, data: address }] : [],
        ...extra,
      });
    });
  }

  it('queries fixed HTTPS resolver for A and AAAA with redirect:error', async () => {
    const fetcher = dnsFetcher('1.1.1.1');
    const resolver = createDnsResolver(fetcher);
    expect(await resolver('example.com', new AbortController().signal)).toEqual(['1.1.1.1']);
    for (const [input, options] of vi.mocked(fetcher).mock.calls) {
      expect(new URL(String(input)).origin).toBe('https://cloudflare-dns.com');
      expect(options?.redirect).toBe('error');
    }
  });

  it.each([
    { Status: 3 },
    { TC: true },
    { Question: [{ name: 'attacker.com.', type: 1 }] },
    { Answer: [] },
    { Answer: [{ type: 1, data: '127.0.0.1' }] },
    {
      Answer: [
        { type: 5, data: 'localhost.' },
        { type: 1, data: '1.1.1.1' },
      ],
    },
  ])('fails closed on invalid or unsafe resolver evidence %#', async (extra) => {
    await expect(
      createDnsResolver(dnsFetcher('1.1.1.1', extra))('example.com', new AbortController().signal),
    ).rejects.toThrow();
  });
});
