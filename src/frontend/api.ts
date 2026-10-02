export type ApiErrorCode = 'authentication' | 'challenge' | 'response' | 'http';
type BrowserRequestInit = RequestInit & { credentials?: 'omit' | 'same-origin' | 'include' };

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: BrowserRequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  const timeout = AbortSignal.timeout(
    /^\/api\/admin\/links\/[^/]+\/check$/.test(path) ? 85000 : 20000,
  );
  let response: Response;
  try {
    const requestOptions: BrowserRequestInit = {
      ...options,
      credentials: 'same-origin',
      redirect: 'manual',
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      headers,
    };
    response = await fetch(path, requestOptions);
  } catch {
    throw new ApiError('response', '网络连接失败或请求超时，请稍后重试。');
  }

  // Edge authentication and browser challenges may return HTML before the Worker runs.
  if (response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge')
    throw new ApiError(
      'challenge',
      '需要先完成浏览器访问验证，请重新打开登录页面。',
      response.status,
    );
  if (
    response.status === 401 ||
    String(response.type) === 'opaqueredirect' ||
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  )
    throw new ApiError(
      'authentication',
      '登录已失效或尚未登录，请重新验证管理员身份。',
      response.status,
    );

  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    if (response.status === 403)
      throw new ApiError('authentication', '访问验证未完成，请重新打开登录页面。', response.status);
    throw new ApiError('response', '服务返回了非 JSON 响应，请稍后重试。', response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('response', '服务返回的数据无法读取，请稍后重试。', response.status);
  }
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    throw new ApiError(
      'http',
      typeof error === 'string' && error.trim() ? error : `请求失败（${response.status}）`,
      response.status,
    );
  }
  return body as T;
}
