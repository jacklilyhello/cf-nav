import { describe, expect, it, vi } from 'vitest';
import {
  checkLink,
  classifyPage,
  extractPageEvidence,
  nextCheckAt,
  readBoundedBody,
} from '../src/health';

function classify(
  html: string,
  status = 200,
  headers: Record<string, string> = {},
  name = 'Example',
) {
  return classifyPage(
    { url: 'https://example.com/', name },
    {
      html,
      status,
      headers: new Headers({ 'content-type': 'text/html', ...headers }),
      url: 'https://example.com/',
      redirects: [],
      truncated: false,
    },
  );
}

describe('conservative availability and identity evidence', () => {
  it('does not label a successful but unrelated page healthy', () => {
    expect(classify('<title>Casino rewards</title>', 200, {}, 'UICloud').status).toBe(
      'needs_review',
    );
  });

  it('requires matching identity even when the old hostname still works', () => {
    expect(classify('<title>Gradients design tools</title>', 200, {}, 'Gradients').status).toBe(
      'healthy',
    );
    expect(classify('<title>Furniture store</title>', 200, {}, 'Gradients').status).toBe(
      'needs_review',
    );
  });

  it('avoids substring-only identity matches', () => {
    expect(classify('<title>Different ideas</title>', 200, {}, 'Ffe').status).toBe('needs_review');
  });

  it.each([
    [403, '<title>Access denied</title>', 'bot_protection'],
    [403, '<title>Example</title>', 'forbidden'],
    [429, '<title>Example</title>', 'rate_limited'],
    [200, '<title>Just a moment...</title>', 'challenge'],
    [503, '<title>Checking your browser</title>', 'challenge'],
    [404, '<title>Example not found</title>', 'not_found'],
    [410, '<title>Example gone</title>', 'gone'],
    [503, '<title>Example unavailable</title>', 'server_error'],
    [200, '<title>This domain is for sale</title>', 'domain_for_sale'],
    [200, '<title>Example</title><h1>Buy this domain</h1>', 'domain_for_sale'],
    [200, '<title>Domain Parking</title>', 'domain_parking'],
    [200, '<title>Example</title><p>This domain is parked</p>', 'domain_parking'],
  ])('classifies HTTP %s with visible evidence', (status, html, expected) => {
    expect(classify(String(html), Number(status)).status).toBe(expected);
  });

  it('uses Cloudflare challenge headers rather than HTTP status alone', () => {
    expect(classify('', 403, { 'cf-mitigated': 'challenge' }).status).toBe('challenge');
  });

  it('does not mistake script and style strings for visible parking evidence', () => {
    expect(
      classify(
        '<title>Example</title><script>const s="buy this domain"</script><style>.domain-parking{}</style>',
      ).status,
    ).toBe('healthy');
  });

  it('treats non-HTML and absent identity as review states', () => {
    expect(classify('{}', 200, { 'content-type': 'application/json' }).status).toBe('needs_review');
    expect(classify('<div>Application booting</div>').status).toBe('needs_review');
  });

  it('keeps extracted text bounded and inert, including reversed meta attribute order', () => {
    const result = extractPageEvidence(
      '<title>Example &amp; tools</title><meta content="An &lt;img src=x&gt; description" name="description">',
    );
    expect(result.title).toBe('Example & tools');
    expect(result.description).toBe('An <img src=x> description');
    expect(extractPageEvidence(`<title>${'x'.repeat(1000)}</title>`).title).toHaveLength(240);
  });

  it('flags substantial identity drift from prior observations', () => {
    const result = classifyPage(
      {
        url: 'https://example.com/',
        name: 'Original',
        previousTitle: 'Original UI design library',
      },
      {
        html: '<title>Premium betting casino</title>',
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        url: 'https://example.com/',
        redirects: [],
        truncated: false,
      },
    );
    expect(result.status).toBe('content_changed');
  });

  it('distinguishes same-host redirects from possible service moves', () => {
    const page = {
      html: '<title>Example service</title>',
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      redirects: [
        { url: 'http://example.com/', status: 301, location: 'https://www.example.com/' },
      ],
      truncated: false,
    };
    expect(
      classifyPage(
        { url: 'http://example.com/', name: 'Example' },
        { ...page, url: 'https://www.example.com/' },
      ).status,
    ).toBe('redirected');
    expect(
      classifyPage(
        { url: 'http://example.com/', name: 'Example' },
        { ...page, url: 'https://example.org/' },
      ).status,
    ).toBe('moved');
  });
});

describe('resource limits and failure recovery', () => {
  it('cancels oversized body streams at the byte limit', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(5000)));
      },
      cancel,
    });
    const body = await readBoundedBody(new Response(stream), 1000);
    expect(body.text).toHaveLength(1000);
    expect(body.truncated).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds the entire probe including stalled DNS', async () => {
    const result = await checkLink(
      { url: 'https://example.com/', name: 'Example' },
      {
        runtime: 'cloudflare-public',
        timeoutMs: 5,
        resolver: () => new Promise(() => undefined),
        fetcher: vi.fn(),
      },
    );
    expect(result.status).toBe('timeout');
    expect(result.consecutiveFailures).toBe(1);
  });

  it('bounds a stalled response body and propagates cancellation', async () => {
    let signal: AbortSignal | null = null;
    const result = await checkLink(
      { url: 'https://example.com/', name: 'Example' },
      {
        runtime: 'cloudflare-public',
        timeoutMs: 5,
        resolver: async () => ['1.1.1.1'],
        fetcher: vi.fn(async (_, init) => {
          signal = init?.signal || null;
          return new Response(new ReadableStream(), { headers: { 'content-type': 'text/html' } });
        }),
      },
    );
    expect(result.status).toBe('timeout');
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('retains failures on a challenge and resets only after successful identity evidence', async () => {
    const input = { url: 'https://example.com/', name: 'Example', consecutiveFailures: 3 };
    const options = { runtime: 'cloudflare-public' as const, resolver: async () => ['1.1.1.1'] };
    const blocked = await checkLink(input, {
      ...options,
      fetcher: async () => new Response('', { status: 403 }),
    });
    expect(blocked.consecutiveFailures).toBe(3);
    expect(blocked.isSuccess).toBe(false);
    const healthy = await checkLink(input, {
      ...options,
      fetcher: async () =>
        new Response('<title>Example service</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(healthy.consecutiveFailures).toBe(0);
    expect(healthy.isSuccess).toBe(true);
  });

  it('backs off failures without permanently removing the item', () => {
    const now = Date.parse('2026-10-02T00:00:00Z');
    const first = Date.parse(nextCheckAt('timeout', 1, now, 'example')) - now;
    const later = Date.parse(nextCheckAt('timeout', 20, now, 'example')) - now;
    expect(first).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(later).toBeGreaterThan(first);
    expect(later).toBeLessThan(83 * 3_600_000);
    expect(Date.parse(nextCheckAt('healthy', 0, now, 'example')) - now).toBeGreaterThanOrEqual(
      24 * 3_600_000,
    );
    expect(Date.parse(nextCheckAt('challenge', 0, now, 'example')) - now).toBeGreaterThanOrEqual(
      48 * 3_600_000,
    );
  });

  it('redacts raw exception messages from stored results', async () => {
    const result = await checkLink(
      { url: 'https://example.com/', name: 'Example' },
      {
        runtime: 'cloudflare-public',
        resolver: async () => ['1.1.1.1'],
        fetcher: async () => {
          throw new Error('connection refused bearer SECRET_INTERNAL_DETAIL');
        },
      },
    );
    expect(result.status).toBe('connection_refused');
    expect(JSON.stringify(result)).not.toContain('SECRET_INTERNAL_DETAIL');
  });
});
