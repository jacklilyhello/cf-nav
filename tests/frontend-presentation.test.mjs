import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindImageFallback,
  contentBadge,
  contentInfo,
  httpLabel,
  siteIcon,
  validIcon,
} from '../src/frontend/ui';
import { createBackupParts } from '../src/frontend/backup';

const link = {
  name: 'Lily',
  icon: 'https://example.com/icon.png',
  iconMode: 'auto',
  healthStatus: 'healthy',
  httpStatus: 200,
  lastCheckedAt: '2026-10-03T01:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('navigation icon display', () => {
  it('uses the actual icon URL with a name fallback and no referrer', () => {
    const output = siteIcon(link);
    expect(output).toContain('src="https://example.com/icon.png"');
    expect(output).toContain('data-fallback="L"');
    expect(output).toContain('referrerpolicy="no-referrer"');
  });

  it('honors an explicit fallback selection even if an old icon remains', () => {
    const output = siteIcon({ ...link, iconMode: 'none' });
    expect(output).not.toContain('<img');
    expect(output).toContain('>L</span>');
  });

  it('escapes manual text and rejects unsafe or overlong image URLs', () => {
    expect(siteIcon({ ...link, iconMode: 'manual', icon: '<Lily>' })).toContain('&lt;Lily&gt;');
    expect(siteIcon({ ...link, icon: 'http://example.com/icon.png' })).not.toContain('<img');
    expect(validIcon('https://example.com/' + 'a'.repeat(600))).toBe(true);
    expect(validIcon('https://example.com/' + 'a'.repeat(2048))).toBe(false);
    expect(validIcon('https://user:password@example.com/icon.png')).toBe(false);
    expect(validIcon('javascript:alert(document.domain)')).toBe(false);
  });

  it.each([true, false])(
    'replaces failed images, including failures completed before binding: %s',
    (cached) => {
      let onError;
      const image = {
        complete: cached,
        naturalWidth: 0,
        dataset: { fallback: '寻' },
        addEventListener: (_type, callback) => {
          onError = callback;
        },
        replaceWith: vi.fn(),
      };
      vi.stubGlobal('document', { createTextNode: (text) => ({ textContent: text }) });
      bindImageFallback({ querySelectorAll: () => [image] });
      if (!cached) onError();
      expect(image.replaceWith).toHaveBeenCalledWith({ textContent: '寻' });
    },
  );
});

describe('health result presentation', () => {
  it.each([
    ['match', '内容符合预期'],
    ['partial', '大致符合'],
    ['changed', '内容可能已改变'],
    ['mismatch', '明显不符合'],
    ['unknown', '无法判断'],
  ])('keeps the %s content outcome explicit', (status, label) => {
    expect(contentInfo(status).label).toBe(label);
    expect(contentBadge({ ...link, contentStatus: status, similarityScore: 0 })).toContain('0%');
  });

  it('never confuses HTTP 200 with a content match or hides transport errors', () => {
    expect(httpLabel(link)).toBe('HTTP 200');
    expect(contentBadge({ ...link, contentStatus: 'mismatch', similarityScore: 3 })).toContain(
      '明显不符合',
    );
    for (const [status, label] of [
      ['dns_error', 'DNS Error'],
      ['tls_error', 'TLS Error'],
      ['timeout', 'Timeout'],
      ['connection_error', 'Connection Error'],
    ]) {
      expect(httpLabel({ ...link, httpStatus: null, healthStatus: status })).toBe(label);
    }
    expect(httpLabel({ ...link, httpStatus: null, lastCheckedAt: null })).toBe('尚未检测');
    expect(contentBadge({ ...link, similarityScore: null })).not.toContain('%');
  });
});

describe('editable backup preservation', () => {
  it('keeps icon choices and expected content intact across split exports', () => {
    const editable = {
      icon: '人工',
      iconMode: 'manual',
      expectedTitle: 'UI Cloud',
      expectedDescription: 'UI components',
      expectedKeywords: ['design', 'UI'],
    };
    const source = {
      version: 1,
      categories: [{ id: 'design' }],
      links: Array.from({ length: 1001 }, (_, index) => ({ id: String(index), ...editable })),
    };
    const parts = createBackupParts(source);
    expect(parts).toHaveLength(2);
    const restored = parts.flatMap((part) => JSON.parse(part.contents).links);
    expect(restored).toEqual(source.links);
    expect(parts.every((part) => JSON.parse(part.contents).mode === 'merge')).toBe(true);
  });
});
