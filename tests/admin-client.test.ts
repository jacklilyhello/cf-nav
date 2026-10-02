import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/frontend/api';

const html = '<!doctype html><title>Access verification</title>';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('admin API response handling', () => {
  it.each([
    ['JSON 401', () => json({ error: 'Login required' }, 401)],
    [
      'HTML 401',
      () => new Response(html, { status: 401, headers: { 'Content-Type': 'text/html' } }),
    ],
    [
      'HTML 403',
      () => new Response(html, { status: 403, headers: { 'Content-Type': 'text/html' } }),
    ],
  ])('reports %s as recoverable authentication without parsing HTML', async (_name, response) => {
    fetchMock.mockResolvedValue(response());
    await expect(api('/api/admin/session')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'authentication',
    });
  });

  it('identifies a Cloudflare challenge before handling its 403 status', async () => {
    fetchMock.mockResolvedValue(
      new Response(html, {
        status: 403,
        headers: { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' },
      }),
    );
    await expect(api('/api/admin/session')).rejects.toMatchObject({
      code: 'challenge',
      status: 403,
    });
  });

  it.each(['opaqueredirect', 'redirected', '302'])(
    'rejects %s without following or exposing its destination',
    async (kind) => {
      const response = new Response(kind === '302' ? null : html, {
        status: kind === '302' ? 302 : 200,
        headers: { 'Content-Type': 'text/html', Location: 'https://untrusted.example/login' },
      });
      if (kind === 'opaqueredirect') Object.defineProperty(response, 'type', { value: kind });
      if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
      fetchMock.mockResolvedValue(response);
      const error = await api('/api/admin/session').catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'authentication' });
      expect(String(error)).not.toContain('untrusted.example');
    },
  );

  it.each([
    ['HTML 200', () => new Response(html, { headers: { 'Content-Type': 'text/html' } })],
    ['missing content type', () => new Response('{"ok":true}')],
    ['invalid JSON', () => new Response(html, { headers: { 'Content-Type': 'application/json' } })],
  ])('rejects %s with a safe response error', async (_name, response) => {
    fetchMock.mockResolvedValue(response());
    const error = await api('/api/admin/session').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'response' });
    expect(String(error)).not.toMatch(/<!doctype|Unexpected token|Access verification/);
  });

  it('returns a valid JSON response', async () => {
    const body = { authenticated: true, csrfToken: 'test-token' };
    fetchMock.mockResolvedValue(json(body));
    await expect(api('/api/admin/session')).resolves.toEqual(body);
  });

  it('preserves JSON 403 CSRF errors as ordinary HTTP failures', async () => {
    fetchMock.mockResolvedValue(json({ error: '请求来源验证失败' }, 403));
    await expect(api('/api/admin/links', { method: 'POST' })).rejects.toMatchObject({
      code: 'http',
      status: 403,
      message: '请求来源验证失败',
    });
  });

  it('never reports an HTML response to a mutation as success or retries the mutation', async () => {
    fetchMock.mockResolvedValue(new Response(html, { headers: { 'Content-Type': 'text/html' } }));
    await expect(
      api('/api/admin/links', { method: 'POST', body: JSON.stringify({ name: 'Example' }) }),
    ).rejects.toMatchObject({ code: 'response' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses a safe message for fetch failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Internal network detail'));
    const error = await api('/api/admin/session').catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'response' });
    expect(String(error)).not.toContain('Internal network detail');
  });

  it('preserves request headers while enforcing JSON, same-origin credentials and manual redirects', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    const headers = new Headers({ Accept: 'text/html', 'X-CSRF-Token': 'test-token' });
    await api('/api/admin/links', {
      method: 'POST',
      headers,
      credentials: 'include',
      redirect: 'follow',
    });
    const options = fetchMock.mock.calls[0]![1]!;
    expect(options).toMatchObject({ credentials: 'same-origin', redirect: 'manual' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options.headers).get('Accept')).toBe('application/json');
    expect(new Headers(options.headers).get('X-CSRF-Token')).toBe('test-token');
    expect(headers.get('Accept')).toBe('text/html');
  });

  it('combines a caller cancellation signal with the request timeout', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    const controller = new AbortController();
    await api('/api/admin/session', { signal: controller.signal });
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    expect(signal).not.toBe(controller.signal);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});
