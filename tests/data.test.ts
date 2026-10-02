import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { importSchema } from '../src/api/validation';
const seed = JSON.parse(readFileSync('data/seed.json', 'utf8'));
const audit = JSON.parse(readFileSync('data/legacy-audit.json', 'utf8'));
describe('audited catalog integrity', () => {
  it('satisfies the same validation contract as an administrator import', () => {
    const data = importSchema.parse(seed);
    expect(data.links.length).toBe(audit.summary.publishedLinks);
    expect(data.categories.length).toBe(audit.summary.publishedCategories);
    const ids = new Set(data.categories.map((x) => x.id));
    expect(new Set(data.links.map((x) => x.url)).size).toBe(data.links.length);
    for (const link of data.links) {
      expect(ids.has(link.categoryId)).toBe(true);
      expect(link.url).toMatch(/^https:\/\//);
    }
  });
  it('traces every published entry to an accepted audit decision and excludes referral/template data', () => {
    for (const link of seed.links) {
      const record = audit.records.find((x: { id: string }) => x.id === link.id);
      expect(record).toBeDefined();
      expect(['retain', 'update']).toContain(record.action);
      expect(record.publishedUrl).toBe(link.url);
      expect(new URL(link.url).search).not.toMatch(/(?:ref|affiliate|utm_|invite)/i);
    }
    const publicText = JSON.stringify(
      seed.links.map((x: { name: string; url: string; description: string }) => ({
        name: x.name,
        url: x.url,
        description: x.description,
      })),
    );
    expect(publicText).not.toMatch(/Web_tool|kefu308|京ICP备2023018588|ShumLab/i);
  });
  it('accounts for every distinct legacy destination including unresolved records', () => {
    expect(audit.records.length).toBe(
      audit.summary.inventory.distinct_raw_targets_including_two_invalid_cards,
    );
    const actions = Object.values(audit.summary.actions) as number[];
    expect(actions.reduce((a, b) => a + b, 0)).toBe(audit.records.length);
  });
});
