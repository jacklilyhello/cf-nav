import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const initial = readFileSync('migrations/0001_initial.sql', 'utf8');
const upgrade = readFileSync('migrations/0002_navigation_controls.sql', 'utf8');
const seed = JSON.parse(readFileSync('data/seed.json', 'utf8')) as {
  links: { id: string; url: string; name: string; icon: string }[];
};
describe('additive navigation control migration', () => {
  it.each(['untouched', 'edited', 'imported', 'aged audit'] as const)(
    'preserves data and only converts untouched bootstrap icons: %s',
    (scenario) => {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec(initial);
        db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(
          'seed-imported',
          '2026-10-02T00:00:00.000Z',
        );
        db.prepare('INSERT INTO categories(id,name,slug,updatedAt) VALUES(?,?,?,?)').run(
          'tools',
          'Tools',
          'tools',
          '2026-10-02T00:00:00.000Z',
        );
        const link = seed.links[0]!;
        db.prepare(
          'INSERT INTO links(id,categoryId,name,url,icon,notes,expectedKeywords,healthStatus,httpStatus,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
          link.id,
          'tools',
          link.name,
          link.url,
          link.icon,
          'retained owner notes',
          '["original"]',
          'healthy',
          200,
          scenario === 'aged audit' ? '2026-10-02T00:00:01.000Z' : '2026-10-02T00:00:00.000Z',
        );
        if (scenario === 'edited' || scenario === 'imported')
          db.prepare('INSERT INTO audit_events(action,targetId,occurredAt) VALUES(?,?,?)').run(
            scenario === 'edited' ? 'update:links' : 'import',
            link.id,
            '2026-10-02T00:00:00.000Z',
          );
        const before = db.prepare('SELECT * FROM links').get()!;
        db.exec(upgrade);
        const after = db.prepare('SELECT * FROM links').get()!;
        for (const key of Object.keys(before).filter((k) => k !== 'icon'))
          expect(after[key]).toEqual(before[key]);
        expect(after.iconMode).toBe(scenario === 'untouched' ? 'auto' : 'manual');
        expect(after.icon).toBe(scenario === 'untouched' ? '' : link.icon);
        expect(after.contentStatus).toBe('unknown');
        expect(db.prepare('SELECT count(*) AS n FROM links').get()!.n).toBe(1);
        expect(db.prepare('SELECT count(*) AS n FROM categories').get()!.n).toBe(1);
      } finally {
        db.close();
      }
    },
  );
});
