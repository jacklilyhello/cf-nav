import { describe, expect, it, vi } from 'vitest';
import { discoverIcon, type IconDiscoveryOptions } from '../src/icons';

const publicDns = async () => ['93.184.215.14'];
const pngBytes = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK6sAAAAASUVORK5CYII=',
    'base64',
  ),
);
const image = () => new Response(pngBytes, { headers: { 'content-type': 'image/png' } });
const html = (content: string) =>
  new Response(content, { headers: { 'content-type': 'text/html' } });
const missing = () => new Response('Not found', { status: 404 });

function options(
  fetcher: typeof fetch,
  extra: Partial<IconDiscoveryOptions> = {},
): IconDiscoveryOptions {
  return { runtime: 'cloudflare-public', fetcher, resolver: publicDns, ...extra };
}

describe('website icon discovery', () => {
  it('selects and verifies a declared touch icon, decoding HTML attributes', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      return path === '/'
        ? html(
            '<head><link rel="icon" href="/small.png" sizes="32x32"><link sizes="180x180" href="/touch.png?v=1&amp;x=2" rel="apple-touch-icon"></head>',
          )
        : image();
    });
    const result = await discoverIcon('https://example.com/', options(fetcher));
    expect(result).toMatchObject({
      icon: 'https://example.com/touch.png?v=1&x=2',
      status: 'found',
      source: 'apple_touch',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('resolves relative icon URLs against a public document base', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/docs/')
        ? html(
            '<head><base href="https://cdn.example.com/assets/"><link rel="shortcut icon" href="logo.png"></head>',
          )
        : image(),
    );
    const result = await discoverIcon('https://example.com/docs/', options(fetcher));
    expect(result.icon).toBe('https://cdn.example.com/assets/logo.png');
  });

  it('reads a manifest and verifies its largest bounded image after bad HTML declarations', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/')
        return html(
          '<link rel=icon href=/bad.png><link rel=manifest href=/assets/site.webmanifest>',
        );
      if (path === '/bad.png') return html('<title>Just a moment...</title>');
      if (path === '/assets/site.webmanifest')
        return Response.json(
          {
            icons: [
              { src: 'small.png', sizes: '32x32' },
              { src: 'big.png', sizes: '192x192' },
            ],
          },
          { headers: { 'content-type': 'application/manifest+json' } },
        );
      return image();
    });
    const result = await discoverIcon('https://example.com/', options(fetcher));
    expect(result).toMatchObject({
      icon: 'https://example.com/assets/big.png',
      source: 'manifest',
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('only returns the conventional favicon URL after an image is actually found', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === '/' ? html('<title>Site</title>') : image(),
    );
    const result = await discoverIcon('https://example.com/', options(fetcher));
    expect(result.icon).toBe('https://example.com/favicon.ico');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      (
        await discoverIcon(
          'https://example.com/',
          options(async () => missing()),
        )
      ).icon,
    ).toBe('');
  });

  it('tries the next manifest image when its preferred image is broken', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/') return html('<link rel=manifest href=/site.webmanifest>');
      if (path === '/site.webmanifest')
        return Response.json({
          icons: [
            { src: '/big.png', sizes: '192x192' },
            { src: '/small.png', sizes: '48x48' },
          ],
        });
      return path === '/small.png' ? image() : missing();
    });
    const result = await discoverIcon('https://example.com/', options(fetcher));
    expect(result.icon).toBe('https://example.com/small.png');
  });

  it('ignores sample declarations in scripts and comments and unsupported data icons', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === '/'
        ? html(
            '<script>"<link rel=icon href=/script.png>"</script><!-- <link rel=icon href=/comment.png> --><link rel=icon href="data:image/png;base64,test">',
          )
        : missing(),
    );
    const result = await discoverIcon('https://example.com/', options(fetcher));
    expect(result.icon).toBe('');
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://example.com/',
      'https://example.com/favicon.ico',
    ]);
  });

  it('does not mistake an HTML challenge labelled image/png for an actual image', async () => {
    const result = await discoverIcon(
      'https://example.com/',
      options(async (input) =>
        new URL(String(input)).pathname === '/'
          ? html('<link rel=icon href=/challenge.png>')
          : new Response('<html><title>Just a moment...</title></html>', {
              headers: { 'content-type': 'image/png' },
            }),
      ),
    );
    expect(result).toMatchObject({ icon: '', status: 'not_found' });
  });

  it('accepts SVG roots but not HTML passed with an SVG MIME type', async () => {
    for (const [content, valid] of [
      ['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', true],
      ['<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>', false],
    ] as const) {
      const result = await discoverIcon(
        'https://example.com/',
        options(async (input) =>
          new URL(String(input)).pathname === '/'
            ? html('<link rel=icon href=/icon.svg>')
            : new Response(content, { headers: { 'content-type': 'image/svg+xml' } }),
        ),
      );
      expect(Boolean(result.icon)).toBe(valid);
    }
  });
});

describe('icon fetch admission and resource limits', () => {
  it.each(['http://127.1/', 'https://metadata.google.internal/', 'https://local.test/'])(
    'never fetches a private input %s',
    async (url) => {
      const fetcher = vi.fn();
      const result = await discoverIcon(url, options(fetcher));
      expect(result).toMatchObject({ icon: '', status: 'blocked' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('requires public-only Cloudflare egress even with injected DNS', async () => {
    const fetcher = vi.fn();
    const result = await discoverIcon(
      'https://example.com/',
      options(fetcher, { runtime: 'node' as 'cloudflare-public' }),
    );
    expect(result.status).toBe('blocked');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects public hostname DNS answers containing a private address', async () => {
    const fetcher = vi.fn();
    const result = await discoverIcon(
      'https://example.com/',
      options(fetcher, { resolver: async () => ['1.1.1.1', '10.0.0.1'] }),
    );
    expect(result.status).toBe('blocked');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'https://127.0.0.1/icon.png',
    'https://internal.local/icon.png',
    'http://example.com/icon.png',
    'https://user:pass@example.com/icon.png',
    'https://%65xample.com/icon.png',
  ])('never fetches unsafe candidate %s', async (candidate) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === '/'
        ? html(`<link rel="icon" href="${candidate}">`)
        : missing(),
    );
    const result = await discoverIcon('https://example.com/', options(fetcher));
    expect(result.icon).toBe('');
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://example.com/',
      'https://example.com/favicon.ico',
    ]);
  });

  it('revalidates every redirected host and blocks private targets before contact', async () => {
    const resolver = vi.fn(async (host: string) =>
      host === 'example.com' ? ['1.1.1.1'] : ['192.168.0.1'],
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/') return html('<link rel=icon href=/icon.png>');
      if (path === '/icon.png')
        return new Response('', {
          status: 302,
          headers: { location: 'https://cdn.example.com/icon.png' },
        });
      return missing();
    });
    expect((await discoverIcon('https://example.com/', options(fetcher, { resolver }))).icon).toBe(
      '',
    );
    expect(resolver.mock.calls.map(([host]) => host)).toEqual(['example.com', 'cdn.example.com']);
    expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(
      'https://cdn.example.com/icon.png',
    );
  });

  it('refuses HTTPS downgrades, encoded authority, and backslash redirects', async () => {
    for (const destination of [
      'http://example.com/icon.png',
      'https://%65xample.com/icon.png',
      'https://example.com\\@127.1/icon.png',
    ]) {
      const fetcher = vi.fn(
        async () => new Response('', { status: 302, headers: { location: destination } }),
      );
      const result = await discoverIcon('https://example.com/', options(fetcher));
      expect(result.status).toBe('blocked');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('never sends credentials and always uses manual redirects', async () => {
    const fetcher = vi.fn(async () => missing());
    await discoverIcon('https://example.com/', options(fetcher));
    for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.redirect).toBe('manual');
      expect(new Headers(init.headers).has('cookie')).toBe(false);
      expect(new Headers(init.headers).has('authorization')).toBe(false);
    }
  });

  it('bounds an unresponsive target by the entire discovery deadline', async () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => undefined));
    const result = await discoverIcon('https://example.com/', options(fetcher, { timeoutMs: 10 }));
    expect(result).toMatchObject({ icon: '', status: 'timeout' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled image stream without accepting its partial image signature', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === '/'
        ? html('<link rel=icon href=/stalled.png>')
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(pngBytes);
              },
              cancel,
            }),
            { headers: { 'content-type': 'image/png' } },
          ),
    );
    const result = await discoverIcon('https://example.com/', options(fetcher, { timeoutMs: 10 }));
    expect(result).toMatchObject({ icon: '', status: 'timeout' });
    await Promise.resolve();
    expect(result.icon).toBe('');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects transports that already followed redirects', async () => {
    const response = html('<link rel=icon href=/icon.png>');
    Object.defineProperty(response, 'redirected', { value: true });
    const fetcher = vi.fn(async () => response);
    const result = await discoverIcon('https://example.com/', options(fetcher));
    expect(result.status).toBe('blocked');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels oversized images and uses the fallback without persisting them', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/') return html('<link rel=icon href=/large.png>');
      if (path === '/large.png')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(256 * 1024 + 1));
            },
            cancel,
          }),
          { headers: { 'content-type': 'image/png' } },
        );
      return missing();
    });
    expect((await discoverIcon('https://example.com/', options(fetcher))).icon).toBe('');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('caps all subrequests including A and AAAA DNS checks', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') {
        const type = Number(url.searchParams.get('type'));
        const name = url.searchParams.get('name');
        return Response.json({
          Status: 0,
          Question: [{ name, type }],
          Answer: type === 1 ? [{ type, data: '1.1.1.1' }] : [],
        });
      }
      if (url.hostname === 'example.com' && url.pathname === '/')
        return html(
          Array.from(
            { length: 12 },
            (_, index) => `<link rel=icon href="https://icon${index}.example.com/icon.png">`,
          ).join(''),
        );
      return new Response('', {
        status: 302,
        headers: { location: `https://redirect-${url.hostname}/icon.png` },
      });
    });
    const result = await discoverIcon('https://example.com/', {
      runtime: 'cloudflare-public',
      fetcher,
    });
    expect(result.icon).toBe('');
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(20);
  });
});
