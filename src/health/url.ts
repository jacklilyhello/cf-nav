import { ProbeError } from './types';

const FORBIDDEN_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'lan',
  'home',
  'home.arpa',
  'test',
  'invalid',
  'example',
  'onion',
  'metadata.google.internal',
];

function ipv4Parts(input: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(input)) return null;
  const components = input.split('.');
  if (components.some((part) => part.length > 1 && part.startsWith('0'))) return null;
  const parts = components.map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

export function hasUnsafeUrlCharacters(input: string): boolean {
  return [...input].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || character === '\\';
  });
}

function ipv6Parts(input: string): number[] | null {
  if (!input.includes(':') || input.includes('%')) return null;
  let normalized = input.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = ipv4Parts(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  if (!/^[a-f\d:]+$/.test(normalized)) return null;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.concat(right).some((part) => !/^[a-f\d]{1,4}$/.test(part))) return null;
  const omitted = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && omitted < 1) return null;
  return [...left, ...Array<string>(Math.max(0, omitted)).fill('0'), ...right].map((part) =>
    parseInt(part, 16),
  );
}

/** Conservative global-unicast allow policy, including IPv4-mapped/transition exclusions. */
export function isPublicIp(input: string): boolean {
  const v4 = ipv4Parts(input);
  if (v4) {
    const [a, b, c] = v4 as [number, number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const v6 = ipv6Parts(input);
  if (!v6) return false;
  // Only 2000::/3 global unicast. This also excludes mapped IPv4, NAT64, ULA,
  // link-local, site-local, multicast, loopback, unspecified, and discard ranges.
  if ((v6[0]! & 0xe000) !== 0x2000) return false;
  // IETF protocol assignments (including Teredo), documentation, 6to4, and 6bone.
  if (v6[0] === 0x2001 && (v6[1]! <= 0x1ff || v6[1] === 0xdb8)) return false;
  if (v6[0] === 0x2002 || v6[0] === 0x3ffe || v6[0] === 0x3fff) return false;
  return true;
}

/** WHATWG canonicalization precedes address checks, catching numeric IP encodings. */
export function validatePublicUrl(input: string): URL {
  if (
    typeof input !== 'string' ||
    input.length > 2048 ||
    !/^https?:\/\//i.test(input) ||
    hasUnsafeUrlCharacters(input)
  ) {
    throw new ProbeError('blocked', 'INVALID_HTTP_URL');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ProbeError('blocked', 'INVALID_HTTP_URL');
  }
  const authority = input.match(/^https?:\/\/([^/?#]*)/i)?.[1] || '';
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[@%]/.test(authority) ||
    url.port
  ) {
    throw new ProbeError('blocked', 'UNSAFE_AUTHORITY_OR_PORT');
  }
  const hostname = url.hostname.toLowerCase();
  // Cloudflare HTTP fetch does not support IP literals. Reject all literals;
  // parsed numeric aliases (127.1, integer, octal, hex) become IPv4 here too.
  if (hostname.includes(':') || ipv4Parts(hostname)) {
    throw new ProbeError('blocked', 'IP_LITERAL_NOT_SUPPORTED');
  }
  const labels = hostname.split('.');
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
    !/[a-z]/.test(labels.at(-1) || '') ||
    FORBIDDEN_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)) ||
    /^(localhost|metadata|instance-data)(\.|$)/.test(hostname)
  ) {
    throw new ProbeError('blocked', 'NON_PUBLIC_HOSTNAME');
  }
  url.hash = '';
  return url;
}
