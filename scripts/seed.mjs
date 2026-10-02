import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { buildSeedSql } from './release-guards.mjs';
const target = process.argv[2] || 'local';
if (!['local', 'staging', 'production'].includes(target))
  throw new Error('Invalid seed environment');
if (target !== 'local' && process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('Remote seeding runs only in Actions');
const data = JSON.parse(await readFile('data/seed.json', 'utf8'));
const now = new Date().toISOString();
const sql = buildSeedSql(data, now);
const args = [
  'wrangler',
  'd1',
  'execute',
  'DB',
  target === 'local' ? '--local' : '--remote',
  '--env',
  target === 'local' ? 'staging' : target,
];
// Skip even the remote file import on later deploys: importing a file temporarily
// blocks D1 queries, even when every INSERT is guarded by the seed marker.
const inspected = spawnSync(
  'npx',
  [
    ...args,
    '--json',
    '--command',
    "SELECT (SELECT value FROM metadata WHERE key='seed-imported') AS marker,(SELECT count(*) FROM categories) AS categories,(SELECT count(*) FROM links) AS links",
  ],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 },
);
if (inspected.error) throw inspected.error;
if (inspected.status !== 0) throw new Error('Seed preflight query failed');
const inventory = JSON.parse(inspected.stdout)?.[0]?.results?.[0];
if (!inventory || !Number.isInteger(inventory.categories) || !Number.isInteger(inventory.links))
  throw new Error('Invalid seed preflight response');
if (inventory.marker) {
  console.log('Audited seed already imported; preserving administrator data.');
  process.exit(0);
}
if (inventory.categories !== 0 || inventory.links !== 0)
  throw new Error('Unmarked nonempty catalog: refusing to overwrite or merge existing data');
await mkdir('build', { recursive: true });
await writeFile('build/seed.sql', sql);
const command = spawnSync('npx', [...args, '--file', 'build/seed.sql'], { stdio: 'inherit' });
if (command.error) throw command.error;
process.exit(command.status ?? 1);
