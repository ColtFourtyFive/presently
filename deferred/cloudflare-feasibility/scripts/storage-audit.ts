/** Reproduce storage evidence locally. No Cloudflare account or remote binding is used. */
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntime, testAudience, testIssuer } from '../tests/runtime.js';
import { seedGrowthFixture } from './fixtures.js';
import type { Actor } from '../shared/types.js';

const output = resolve(process.env.STORAGE_AUDIT_OUTPUT || '../tmp/storage-audit');
try {
  await access(join(output, 'baseline.sqlite'));
  throw new Error('Audit output already exists. Set STORAGE_AUDIT_OUTPUT to a new directory to preserve previous evidence.');
} catch (error) {
  if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
}
await mkdir(output, { recursive: true });
const app = await createRuntime({ bindings: {
  APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'isolated-storage-audit',
  ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
} });
try {
  const token = await app.signer.token({ exp: Math.floor(Date.now() / 1000) + 7200 });
  const response = await app.request('/api/admin/session', { token });
  if (!response.ok) throw new Error('Isolated owner setup failed.');
  const { actor } = await response.json() as { actor: Actor };
  const days = Number(process.env.STORAGE_AUDIT_DAYS || 400);
  const fixture = await seedGrowthFixture(app.db, actor, days, console.log);
  const probe = await app.db.prepare('SELECT 1 AS probe').all();
  const files = await readdir(join(app.directory, 'd1'), { recursive: true });
  const database = files.filter(name => name.endsWith('.sqlite') && !name.endsWith('/metadata.sqlite'));
  if (database.length !== 1) throw new Error(`Expected one isolated SQLite database; found: ${JSON.stringify(files)}`);
  const metadata = { generatedAt: new Date().toISOString(), fixture, d1Meta: probe.meta,
    baselineDifference: 'Original benchmark also added about 100 present visits and action probes; this run isolates the unchanged historical fixture.' };
  await writeFile(join(output, 'fixture.json'), JSON.stringify(metadata, null, 2) + '\n');
  execFileSync('python3', ['scripts/storage-audit.py', join(app.directory, 'd1', database[0]), output], { stdio: 'inherit' });
} finally { await app.close(); }
