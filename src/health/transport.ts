import { ProbeError, type DnsResolver } from './types';
import { isPublicIp, validatePublicUrl } from './url';

export async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal?.aborted) throw new ProbeError('timeout', 'PROBE_DEADLINE_EXCEEDED');
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        // Release the connection slot before proceeding to another redirect.
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) cancel();
    reader.releaseLock();
  }
  return { text, truncated };
}

export function createDnsResolver(fetcher: typeof fetch): DnsResolver {
  return async (hostname, signal) => {
    const responses = await Promise.all(
      [1, 28].map(async (type) => {
        const endpoint = new URL('https://cloudflare-dns.com/dns-query');
        endpoint.searchParams.set('name', hostname);
        endpoint.searchParams.set('type', String(type));
        const response = await fetcher(endpoint.href, {
          signal,
          redirect: 'error',
          headers: { accept: 'application/dns-json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProbeError('dns_error', 'DNS_RESOLVER_UNAVAILABLE');
        }
        const body = await readBoundedBody(response, 32 * 1024, signal);
        if (body.truncated) throw new ProbeError('dns_error', 'DNS_RESPONSE_TOO_LARGE');
        let result: {
          Status?: number;
          TC?: boolean;
          Question?: { name: string; type: number }[];
          Answer?: { name: string; type: number; data: string }[];
        };
        try {
          result = JSON.parse(body.text) as typeof result;
        } catch {
          throw new ProbeError('dns_error', 'INVALID_DNS_RESPONSE');
        }
        if (!result || typeof result !== 'object' || result.TC || result.Status !== 0) {
          throw new ProbeError(
            'dns_error',
            result?.Status === 3 ? 'DNS_NXDOMAIN' : 'DNS_LOOKUP_FAILED',
          );
        }
        if (
          !Array.isArray(result.Question) ||
          result.Question.length !== 1 ||
          typeof result.Question[0]?.name !== 'string' ||
          result.Question[0]?.name.toLowerCase().replace(/\.$/, '') !== hostname ||
          result.Question[0]?.type !== type ||
          (result.Answer !== undefined && !Array.isArray(result.Answer)) ||
          (result.Answer?.length || 0) > 64
        ) {
          throw new ProbeError('dns_error', 'INVALID_DNS_RESPONSE');
        }
        const addresses: string[] = [];
        for (const answer of result.Answer || []) {
          if (!answer || typeof answer.data !== 'string') {
            throw new ProbeError('dns_error', 'INVALID_DNS_RESPONSE');
          }
          if (answer.type === 1 || answer.type === 28) {
            if (!isPublicIp(answer.data)) throw new ProbeError('blocked', 'DNS_NON_PUBLIC_ADDRESS');
            addresses.push(answer.data);
          } else if (answer.type === 5) {
            validatePublicUrl(`https://${answer.data.replace(/\.$/, '')}/`);
          }
        }
        return addresses;
      }),
    );
    const addresses = [...new Set(responses.flat())];
    if (!addresses.length) throw new ProbeError('dns_error', 'DNS_NO_ADDRESS');
    return addresses;
  };
}
