import { createDnsResolver, readBoundedBody } from '../health/transport';
import { ProbeError, type DnsResolver } from '../health/types';
import { hasUnsafeUrlCharacters, isPublicIp, validatePublicUrl } from '../health/url';

export interface IconDiscoveryOptions {
  /** Requires originless global fetch and the global_fetch_strictly_public flag. */
  runtime: 'cloudflare-public';
  fetcher?: typeof fetch;
  resolver?: DnsResolver;
  timeoutMs?: number;
}

export interface IconDiscoveryResult {
  icon: string;
  status: 'found' | 'not_found' | 'blocked' | 'timeout' | 'error';
  source: 'favicon' | 'apple_touch' | 'manifest' | null;
  checkedAt: string;
}

interface Candidate {
  url: URL;
  source: NonNullable<IconDiscoveryResult['source']>;
  rank: number;
}

const MAX_REQUESTS = 20; // Includes the two DNS queries for each new hostname.
const MAX_REDIRECTS = 2;
const MAX_CANDIDATES = 6;
const MAX_IMAGE_BYTES = 256 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'cf-nav-icons/1.0';

function resolvePublicUrl(value: string, base: URL, httpsOnly = false): URL {
  const authority = value.match(/^(?:https?:)?\/\/([^/?#]*)/i)?.[1] || '';
  if (!value || hasUnsafeUrlCharacters(value) || /[@%]/.test(authority)) {
    throw new ProbeError('blocked', 'UNSAFE_ICON_URL');
  }
  const url = validatePublicUrl(new URL(value, base).href);
  if (httpsOnly && url.protocol !== 'https:') {
    throw new ProbeError('blocked', 'HTTPS_ICON_REQUIRED');
  }
  return url;
}

function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&quot;': '"',
      '&apos;': "'",
      '&lt;': '<',
      '&gt;': '>',
    };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    const number = entity.toLowerCase().startsWith('&#x')
      ? parseInt(entity.slice(3, -1), 16)
      : parseInt(entity.slice(2, -1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const content = tag.replace(/^<\s*[\w-]+/, '').replace(/\/?\s*>$/, '');
  const pattern = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of content.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    // HTML uses the first duplicate attribute.
    if (!result.has(name))
      result.set(name, decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return result;
}

function sizeRank(sizes: string): number {
  if (sizes.toLowerCase().split(/\s+/).includes('any')) return 192;
  let best = 0;
  for (const match of sizes.matchAll(/(?:^|\s)(\d+)x(\d+)(?=\s|$)/gi)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width === height && width >= 16 && width <= 512) best = Math.max(best, width);
  }
  return best;
}

function htmlCandidates(html: string, pageUrl: URL): { icons: Candidate[]; manifest?: URL } {
  const icons: Candidate[] = [];
  let manifest: URL | undefined;
  let base = pageUrl;
  let baseSeen = false;
  // Discovery only needs bounded metadata. Ignore comments and inert/raw-text elements
  // so a sample HTML string in a script cannot manufacture an icon declaration.
  const metadata = html
    .split(/<\/head\s*>/i, 1)[0]!
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(
      /<(script|style|textarea|title|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      '',
    );
  const tags = metadata.match(/<(?:link|base)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || [];
  for (const tag of tags.slice(0, 64)) {
    const attrs = attributes(tag);
    const href = attrs.get('href');
    if (!href) continue;
    if (/^<base\b/i.test(tag)) {
      if (!baseSeen) {
        baseSeen = true;
        try {
          base = resolvePublicUrl(href, pageUrl);
        } catch {
          // Invalid or private base URLs cannot widen the admission policy.
        }
      }
      continue;
    }
    const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
    try {
      const url = resolvePublicUrl(href, base, true);
      if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
        icons.push({ url, source: 'apple_touch', rank: 300 + sizeRank(attrs.get('sizes') || '') });
      } else if (rel.includes('icon')) {
        icons.push({ url, source: 'favicon', rank: 200 + sizeRank(attrs.get('sizes') || '') });
      } else if (rel.includes('manifest') && !manifest) {
        manifest = url;
      }
    } catch {
      // An unsafe declaration is skipped; it is never sent to fetch.
    }
  }
  return { icons, manifest };
}

async function readImage(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ProbeError('timeout', 'ICON_DEADLINE_EXCEEDED');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new ProbeError('timeout', 'ICON_DEADLINE_EXCEEDED');
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (signal.aborted) cancel();
    reader.releaseLock();
  }
}

function isImage(bytes: Uint8Array | null, contentType: string): boolean {
  if (!bytes || bytes.length < 8) return false;
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  const prefix = new TextDecoder().decode(bytes.subarray(0, 16));
  const has = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (mime === 'image/png') return bytes.length >= 24 && has([137, 80, 78, 71, 13, 10, 26, 10]);
  if (mime === 'image/jpeg') return has([255, 216, 255]);
  if (mime === 'image/gif') return bytes.length >= 13 && /^GIF8[79]a/.test(prefix);
  if (mime === 'image/webp') return /^RIFF[\s\S]{4}WEBP/.test(prefix);
  if (['image/x-icon', 'image/vnd.microsoft.icon', 'application/octet-stream'].includes(mime)) {
    return bytes.length >= 22 && has([0, 0, 1, 0]) && bytes[4]! + bytes[5]! * 256 > 0;
  }
  if (mime === 'image/svg+xml') {
    const source = new TextDecoder()
      .decode(bytes)
      .replace(/^\uFEFF/, '')
      .trim();
    // Do not accept an HTML/challenge document merely labelled as an SVG.
    return (
      /^\s*(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(source) &&
      /<\/svg\s*>|<svg\b[^>]*\/>/i.test(source)
    );
  }
  return false;
}

/**
 * Find a site's actual image and return its validated HTTPS URL for persistent D1
 * caching. Never call from Cron health probes or overwrite a manually chosen icon.
 * DNS preflight is defense in depth; Cloudflare's public-only egress is mandatory
 * because DNS inspection alone cannot prevent DNS rebinding at connection time.
 */
export async function discoverIcon(
  input: string,
  options: IconDiscoveryOptions,
): Promise<IconDiscoveryResult> {
  const result: IconDiscoveryResult = {
    icon: '',
    status: 'not_found',
    source: null,
    checkedAt: new Date().toISOString(),
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requests = 0;
  const rawFetch = options.fetcher || fetch;
  const fetcher: typeof fetch = async (url, init) => {
    if (controller.signal.aborted) throw new ProbeError('timeout', 'ICON_DEADLINE_EXCEEDED');
    if (++requests > MAX_REQUESTS) throw new ProbeError('unknown', 'ICON_REQUEST_LIMIT');
    return rawFetch(url, init);
  };
  const resolver = options.resolver || createDnsResolver(fetcher);
  const hosts = new Set<string>();
  const fetchPublic = async (initial: URL, accept: string, httpsOnly: boolean) => {
    let url = initial;
    const visited = new Set<string>();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (visited.has(url.href)) throw new ProbeError('unknown', 'ICON_REDIRECT_LOOP');
      visited.add(url.href);
      if (!hosts.has(url.hostname)) {
        const addresses = await resolver(url.hostname, controller.signal);
        if (!addresses.length || addresses.length > 64 || !addresses.every(isPublicIp)) {
          throw new ProbeError('blocked', 'ICON_NON_PUBLIC_DNS');
        }
        hosts.add(url.hostname);
      }
      const response = await fetcher(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept, 'user-agent': USER_AGENT },
      });
      if (controller.signal.aborted || response.redirected) {
        await response.body?.cancel();
        throw new ProbeError(
          controller.signal.aborted ? 'timeout' : 'blocked',
          'ICON_UNSAFE_TRANSPORT',
        );
      }
      if (!REDIRECT_CODES.has(response.status)) return { response, url };
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === MAX_REDIRECTS)
        throw new ProbeError('unknown', 'ICON_REDIRECT_LIMIT');
      const destination = resolvePublicUrl(location, url, httpsOnly);
      if (url.protocol === 'https:' && destination.protocol === 'http:') {
        throw new ProbeError('blocked', 'ICON_HTTPS_DOWNGRADE');
      }
      url = destination;
    }
    throw new ProbeError('unknown', 'ICON_REDIRECT_LIMIT');
  };
  const attempted = new Set<string>();
  const attempt = async (candidates: Candidate[]): Promise<boolean> => {
    for (const candidate of candidates) {
      if (controller.signal.aborted || requests >= MAX_REQUESTS) return false;
      if (attempted.has(candidate.url.href)) continue;
      attempted.add(candidate.url.href);
      try {
        const { response, url } = await fetchPublic(candidate.url, 'image/*', true);
        const type = response.headers.get('content-type') || '';
        if (
          !response.ok ||
          !/^(?:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)|application\/octet-stream)(?:\s*;|$)/i.test(
            type,
          )
        ) {
          await response.body?.cancel();
          continue;
        }
        const bytes = await readImage(response, controller.signal);
        if (controller.signal.aborted) throw new ProbeError('timeout', 'ICON_DEADLINE_EXCEEDED');
        if (isImage(bytes, type)) {
          result.icon = url.href;
          result.status = 'found';
          result.source = candidate.source;
          return true;
        }
      } catch {
        // Try the next public candidate within the same deadline and request budget.
      }
    }
    return false;
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new ProbeError('timeout', 'ICON_DEADLINE_EXCEEDED'));
      },
      Math.max(1, Math.min(options.timeoutMs ?? 8000, 12000)),
    );
  });
  try {
    if (options.runtime !== 'cloudflare-public')
      throw new ProbeError('blocked', 'PUBLIC_EGRESS_REQUIRED');
    await Promise.race([
      deadline,
      (async () => {
        const initial = validatePublicUrl(input);
        const page = await fetchPublic(initial, 'text/html,application/xhtml+xml', false);
        let metadata: ReturnType<typeof htmlCandidates> = { icons: [] };
        if (
          page.response.ok &&
          /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(
            page.response.headers.get('content-type') || '',
          )
        ) {
          const body = await readBoundedBody(page.response, 128 * 1024, controller.signal);
          metadata = htmlCandidates(body.text, page.url);
        } else {
          await page.response.body?.cancel();
        }
        const unique = new Set<string>();
        const declared = metadata.icons
          .sort((a, b) => b.rank - a.rank)
          .filter((candidate) => {
            if (unique.has(candidate.url.href)) return false;
            unique.add(candidate.url.href);
            return true;
          })
          .slice(0, MAX_CANDIDATES - 2);
        if (await attempt(declared)) return;
        if (metadata.manifest && requests < MAX_REQUESTS && !controller.signal.aborted) {
          try {
            const manifest = await fetchPublic(
              metadata.manifest,
              'application/manifest+json,application/json',
              true,
            );
            if (
              manifest.response.ok &&
              /^(?:application\/(?:manifest\+json|json)|text\/json)(?:\s*;|$)/i.test(
                manifest.response.headers.get('content-type') || '',
              )
            ) {
              const body = await readBoundedBody(manifest.response, 32 * 1024, controller.signal);
              if (!body.truncated) {
                const data: unknown = JSON.parse(body.text);
                const icons: Candidate[] = [];
                const manifestUrls = new Set<string>();
                if (
                  data &&
                  typeof data === 'object' &&
                  'icons' in data &&
                  Array.isArray(data.icons)
                ) {
                  for (const item of data.icons.slice(0, 32)) {
                    if (!item || typeof item !== 'object' || typeof item.src !== 'string') continue;
                    try {
                      const url = resolvePublicUrl(item.src, manifest.url, true);
                      if (attempted.has(url.href) || manifestUrls.has(url.href)) continue;
                      manifestUrls.add(url.href);
                      icons.push({
                        url,
                        source: 'manifest',
                        rank: sizeRank(typeof item.sizes === 'string' ? item.sizes : ''),
                      });
                    } catch {
                      /* Unsafe manifest candidates are never fetched. */
                    }
                  }
                }
                if (
                  await attempt(
                    icons
                      .sort((a, b) => b.rank - a.rank)
                      .slice(0, Math.max(0, MAX_CANDIDATES - attempted.size - 1)),
                  )
                )
                  return;
              }
            } else {
              await manifest.response.body?.cancel();
            }
          } catch {
            /* A broken manifest still allows the conventional favicon check. */
          }
        }
        // A conventional path is only persisted after fetching and validating the image.
        const fallback = new URL('/favicon.ico', page.url);
        fallback.protocol = 'https:';
        if (!attempted.has(fallback.href))
          await attempt([{ url: fallback, source: 'favicon', rank: 0 }]);
      })(),
    ]);
  } catch (error) {
    result.status = controller.signal.aborted
      ? 'timeout'
      : error instanceof ProbeError && error.status === 'blocked'
        ? 'blocked'
        : 'error';
    controller.abort();
  } finally {
    clearTimeout(timer);
  }
  return result;
}
