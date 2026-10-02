import type { HealthInput, HealthStatus, RedirectHop } from './types';

function decodeText(value: string): string {
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
      const numeric = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name: string) => {
      const entities: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
      };
      return entities[name.toLowerCase()] || '';
    })
    .replace(/./gs, (character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPageEvidence(html: string): {
  title: string;
  description: string;
  text: string;
} {
  // Do not evaluate HTML or retain raw markup in results. Scripts, styles, and comments
  // are not visible evidence and frequently contain misleading challenge/parking words.
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const title = decodeText(visible.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '')
    .replace(/<[^>]*>/g, '')
    .slice(0, 240);
  let description = '';
  for (const match of visible.matchAll(/<meta\b[^>]{0,2048}>/gi)) {
    const attributes: Record<string, string> = {};
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[attr[1]!.toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    }
    if ((attributes.name || attributes.property || '').toLowerCase() === 'description') {
      description = decodeText(attributes.content || '').slice(0, 500);
      break;
    }
    if ((attributes.property || '').toLowerCase() === 'og:description' && !description) {
      description = decodeText(attributes.content || '').slice(0, 500);
    }
  }
  return {
    title,
    description,
    text: decodeText(visible.replace(/<[^>]*>/g, ' ')).slice(0, 30_000),
  };
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function identityTokens(input: HealthInput): string[] {
  const ignored = new Set([
    'the',
    'and',
    'for',
    'online',
    'website',
    'official',
    'tools',
    'design',
    'free',
    'app',
    'www',
  ]);
  const candidates = [...(input.expectedKeywords || []), input.name]
    .flatMap((value) => [normalized(value), ...normalized(value).split(' ')])
    .filter(
      (value) =>
        value.length >= 3 ||
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}/u.test(value),
    )
    .filter((value) => !ignored.has(value));
  return [...new Set(candidates)].slice(0, 30);
}

function hasIdentity(value: string, identities: string[]): boolean {
  const text = ` ${normalized(value)} `;
  return identities.some((identity) => {
    // Latin brand names must be complete tokens, not accidental substrings.
    if (/^[a-z\d ]+$/.test(identity)) return text.includes(` ${identity} `);
    return text.includes(identity);
  });
}

export interface PageObservation {
  status: number;
  headers: Headers;
  url: string;
  html: string;
  truncated: boolean;
  redirects: RedirectHop[];
}

export function classifyPage(
  input: HealthInput,
  page: PageObservation,
): { status: HealthStatus; title: string; description: string; evidence: string[] } {
  const { title, description, text } = extractPageEvidence(page.html);
  const evidence: string[] = [];
  const result = (status: HealthStatus, reason: string) => ({
    status,
    title,
    description,
    evidence: [...evidence, reason],
  });
  const overview = `${title} ${description} ${text.slice(0, 4000)}`;
  if (page.headers.get('cf-mitigated') === 'challenge') {
    return result(
      'challenge',
      'Cloudflare challenge response; service availability is not established.',
    );
  }
  if (
    /^(just a moment|attention required|security verification|verify (?:you are|that you are) human|checking your browser|请完成安全验证)/i.test(
      title,
    ) ||
    /(?:verify (?:that )?you are human|checking your browser before accessing|enable javascript and cookies to continue|performing security verification)/i.test(
      overview,
    )
  ) {
    return result('challenge', 'Human-verification page detected; do not classify as dead.');
  }
  if (page.status === 429) return result('rate_limited', 'Rate limited; retry later with backoff.');
  if (
    page.status === 403 &&
    /(?:bot detection|automated (?:requests|access)|access denied|robot check|captcha)/i.test(
      overview,
    )
  ) {
    return result('bot_protection', 'Automated access blocked; service availability is uncertain.');
  }
  if (page.status === 401 || page.status === 403)
    return result('forbidden', 'Authentication or access policy prevents verification.');
  if (page.status === 404)
    return result(
      'not_found',
      'HTTP 404 observed; retain the link and failure history for review.',
    );
  if (page.status === 410)
    return result('gone', 'HTTP 410 observed; manual review is required before removal.');
  if (page.status >= 500) return result('server_error', `HTTP ${page.status}; retry with backoff.`);
  if (page.status < 200 || page.status >= 300)
    return result('unknown', `HTTP ${page.status} does not establish service health.`);
  if (
    /(?:this domain (?:name )?is (?:available )?for sale|(?:buy|purchase) this domain|domain name for sale|该域名(?:正在|可以)?出售|此域名出售)/i.test(
      overview,
    )
  ) {
    return result(
      'domain_for_sale',
      'Explicit domain-sale wording found in visible page evidence.',
    );
  }
  if (
    /(?:this (?:domain|web page) is parked|domain (?:name )?parking|parked (?:for free|courtesy of)|sedo domain parking|此域名已停放)/i.test(
      overview,
    )
  ) {
    return result(
      'domain_parking',
      'Explicit domain-parking wording found in visible page evidence.',
    );
  }
  const contentType = page.headers.get('content-type') || '';
  if (!/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
    return result(
      'needs_review',
      'HTTP success without an HTML page cannot confirm the original service identity.',
    );
  }
  if (!title && !description)
    return result('needs_review', 'No title or description available to verify service identity.');
  const identities = identityTokens(input);
  const identityMatched = hasIdentity(`${title} ${description}`, identities);
  if (!identityMatched) {
    if (input.previousTitle && normalized(input.previousTitle) !== normalized(title)) {
      const previous = new Set(
        normalized(input.previousTitle)
          .split(' ')
          .filter((token) => token.length > 2),
      );
      const current = new Set(
        normalized(title)
          .split(' ')
          .filter((token) => token.length > 2),
      );
      const overlap = [...previous].filter((token) => current.has(token)).length;
      if (
        previous.size >= 2 &&
        current.size >= 2 &&
        overlap / Math.max(previous.size, current.size) < 0.2
      ) {
        return result(
          'content_changed',
          'Title changed substantially and expected service identity is missing; possible replacement requires review.',
        );
      }
    }
    return result(
      'needs_review',
      'HTTP success, but title and description do not confirm the expected service identity.',
    );
  }
  evidence.push(
    'Expected service identity matches the title or description; this is a heuristic, not a business-continuity guarantee.',
  );
  if (page.truncated) evidence.push('Response was truncated at the inspection limit.');
  const original = new URL(input.url);
  const final = new URL(page.url);
  if (original.hostname.replace(/^www\./, '') !== final.hostname.replace(/^www\./, '')) {
    return result(
      'moved',
      'Service identity matches at a different hostname; confirm migration before updating the saved URL.',
    );
  }
  if (page.redirects.length)
    return result(
      'redirected',
      'Redirect chain reached a page matching expected service identity.',
    );
  return result('healthy', 'Successful HTTP response and matching service identity.');
}
