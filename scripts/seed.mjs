import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const target = process.argv[2] || 'local';
if (!['local', 'staging', 'production'].includes(target))
  throw new Error('Invalid seed environment');
if (target !== 'local' && process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('Remote seeding runs only in Actions');
const data = JSON.parse(await readFile('data/seed.json', 'utf8'));
const quote = (x) =>
  x === null || x === undefined
    ? 'NULL'
    : typeof x === 'number'
      ? String(x)
      : typeof x === 'boolean'
        ? String(Number(x))
        : `'${String(Array.isArray(x) ? JSON.stringify(x) : x).replaceAll("'", "''")}'`;
const now = new Date().toISOString();
const sql = [];
const emit = (table, row) =>
  sql.push(
    `INSERT INTO ${table}(${Object.keys(row).join(',')}) SELECT ${Object.values(row).map(quote).join(',')} WHERE NOT EXISTS(SELECT 1 FROM metadata WHERE key='seed-imported');`,
  );
for (const c of data.categories)
  emit('categories', {
    id: c.id,
    name: c.name,
    slug: c.slug || c.id,
    description: c.description || '',
    sortOrder: c.sortOrder || 0,
    enabled: c.enabled !== false,
    updatedAt: now,
  });
for (const l of data.links)
  emit('links', {
    id: l.id,
    categoryId: l.categoryId,
    name: l.name,
    url: l.url,
    description: l.description || '',
    icon: l.icon || '',
    sortOrder: l.sortOrder || 0,
    enabled: l.enabled !== false,
    featured: !!l.featured,
    notes: l.notes || '',
    expectedKeywords: l.expectedKeywords || [],
    healthStatus: l.healthStatus || 'unknown',
    lastCheckedAt: l.lastCheckedAt || null,
    lastSuccessAt: l.lastSuccessAt || null,
    lastFailureAt: l.lastFailureAt || null,
    nextCheckAt: '1970-01-01T00:00:00.000Z',
    consecutiveFailures: l.consecutiveFailures || 0,
    observedTitle: l.observedTitle || null,
    confirmedTitle: ['healthy', 'redirected', 'moved'].includes(l.healthStatus)
      ? l.observedTitle || null
      : null,
    healthEvidence: l.healthEvidence || [],
    finalUrl: l.finalUrl || null,
    httpStatus: l.httpStatus || null,
    updatedAt: now,
  });
sql.push(`INSERT OR IGNORE INTO metadata(key,value) VALUES('seed-imported',${quote(now)});`);
await mkdir('build', { recursive: true });
await writeFile('build/seed.sql', sql.join('\n') + '\n');
const command = spawnSync(
  'npx',
  [
    'wrangler',
    'd1',
    'execute',
    'DB',
    target === 'local' ? '--local' : '--remote',
    '--env',
    target === 'local' ? 'staging' : target,
    '--file',
    'build/seed.sql',
  ],
  { stdio: 'inherit' },
);
if (command.error) throw command.error;
process.exit(command.status ?? 1);
