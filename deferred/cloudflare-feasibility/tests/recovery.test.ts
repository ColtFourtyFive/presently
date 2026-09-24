import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { bytes64, digest, newHeader, sealPart, type BackupManifest } from '../worker/backup-crypto';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import type { ArchiveMetadata, ArchiveReference } from '../shared/archive-format';
import type { AttendanceResult, ObservationCorrectionResult } from '../shared/types';
import { BACKUP_TABLES } from '../worker/backup';
import { D1ArchiveSemanticStaging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { claimArchiveStagingCleanup, pauseArchiveStaging, renewArchiveStaging, resumeArchiveStaging } from '../worker/archive-staging-controls';
import { abandonArchiveBudgetAttempt, claimArchiveBudgetAttempt, openArchiveBudgetDay, readArchiveBudgetRuntime, reserveArchiveBudgetAttempt, settleArchiveBudgetAttempt } from '../worker/archive-budget-ledger';
import { createArchiveBudgetUsage } from '../worker/archive-budget-usage';
import { createArchiveBudgetInvocation } from '../worker/archive-budget-control-usage';
import { finalizeArchiveBudgetControl } from '../worker/archive-budget-control-store';
import { openBudgetFixture } from './archive-budget-fixture';
import { advanceHistoryBackfill } from '../worker/history-lookup';
import { CookieJar, createStudent, json, observation, startApp, type App } from './helpers';
import { createRuntime, projectRoot, testAudience, testIssuer, type IsolatedStatement, type TestRuntime } from './runtime';

// Actual recovery CLI subprocesses and isolated workerd/D1. The SQL fixtures are
// local snapshots assembled from test D1; no live provider export is claimed.
const directories: string[] = [];
const runtimes: TestRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary() { const directory = await mkdtemp(join(tmpdir(), 'kumon-recovery-test-')); directories.push(directory); return directory; }
function cli(args: string[], keyPath?: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/recovery.ts'), ...args], { cwd: projectRoot, env: { ...(keyPath ? { KUMON_RECOVERY_KEY_FILE: keyPath } : {}), NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, result };
}
async function absent(path: string) { await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }); }
async function noOutput(directory: string, name: string) { await absent(join(directory, name)); await absent(join(directory, `${name}.manifest.json`)); await absent(join(directory, `${name}.archives`)); await absent(join(directory, `${name}.recovery.lock`)); expect((await readdir(directory)).filter(file => file.startsWith(`.${name}.recovery-`))).toEqual([]); }
async function bundle(directory: string, chunks: Uint8Array[], extra: Partial<BackupManifest> = {}) {
  const root = join(directory, 'encrypted'); await mkdir(root); const key = bytes64(crypto.getRandomValues(new Uint8Array(32))); const keyPath = join(directory, 'recovery-key.txt'); await writeFile(keyPath, key + '\n', { mode: 0o600 });
  const backupId = crypto.randomUUID(); const parts: BackupManifest['parts'] = [];
  for (const [index, bytes] of chunks.entries()) { const encrypted = await sealPart(key, bytes, newHeader(backupId, index)); const fileName = `part-${String(index).padStart(5, '0')}.kcrm`; await writeFile(join(root, fileName), encrypted); parts.push({ index, fileName, plaintextBytes: bytes.length, plaintextSha256: await digest(bytes), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) }); }
  const manifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId, applicationVersion: 'local-recovery-test', schemaVersions: [1, 2, 3, 4], createdAt: new Date().toISOString(), snapshotBookmark: 'LOCAL_FIXTURE_NO_PROVIDER_EXPORT', recordCounts: {}, sqlBytes: chunks.reduce((sum, bytes) => sum + bytes.length, 0), parts, ...(extra.schemaVersions?.some(version => version >= 8) ? { archiveReferences: [] } : {}), ...extra };
  await writeFile(join(root, 'manifest.kcrm'), await sealPart(key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(backupId, -1)));
  return { root, key, keyPath, manifest };
}
async function addHistory(source: Awaited<ReturnType<typeof bundle>>, archiveRoot = source.root) {
  const objects = new Map<string, Uint8Array>();
  const metadata: ArchiveMetadata = { archiveId: 'history-parent', centerId: 'test-center', month: '2025-01', timezone: 'America/Los_Angeles', kind: 'monthly', createdAt: '2025-02-02T10:00:00.000Z', applicationVersion: 'test', schemaVersions: [1, 8], references: [] };
  const parent = await createArchive(source.key, metadata, [{ table: 'centers', key: 'test-center', row: { id: 'test-center', name: 'Synthetic Center', timezone: 'America/Los_Angeles' } }], async (part, bytes) => { objects.set(part.objectKey, bytes); });
  objects.set(parent.objectKey, parent.encrypted);
  const parentRef: ArchiveReference = { archiveId: metadata.archiveId, kind: 'monthly', manifestObjectKey: parent.objectKey, manifestSha256: parent.sha256 };
  const child = await createArchive(source.key, { ...metadata, archiveId: 'history-addendum', kind: 'addendum', createdAt: '2025-03-01T10:00:00.000Z', references: [parentRef] }, [{ table: 'audit_entries', key: 'historical-review', row: { id: 'historical-review', center_id: 'test-center', actor_name: 'Synthetic Reviewer', action: 'review.resolve', entity_type: 'review', entity_id: 'review-1', detail: '{"reason":"Reviewed original paper record"}', created_at: '2025-03-01T09:00:00.000Z' } }], async (part, bytes) => { objects.set(part.objectKey, bytes); });
  objects.set(child.objectKey, child.encrypted);
  for (const [name, bytes] of objects) { const path = join(archiveRoot, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  const references: ArchiveReference[] = [{ archiveId: child.manifest.archiveId, kind: 'addendum', manifestObjectKey: child.objectKey, manifestSha256: child.sha256 }];
  const manifest: BackupManifest = { ...source.manifest, schemaVersions: [1, 8, 9], archiveReferences: references };
  await writeFile(join(source.root, 'manifest.kcrm'), await sealPart(source.key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(manifest.backupId, -1)));
  return { objects, parent, child, manifest };
}
async function snapshot(app: App) {
  const objects = (await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all<{ name: string; type: string; sql: string }>()).results;
  const tables = objects.filter(object => object.type === 'table'); const sql = tables.map(table => `${table.sql};`);
  const literal = (value: unknown) => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  for (const table of tables) for (const row of (await app.db.prepare(`SELECT * FROM "${table.name}"`).all()).results) sql.push(`INSERT INTO "${table.name}" (${Object.keys(row).map(name => `"${name}"`).join(',')}) VALUES (${Object.values(row).map(literal).join(',')});`);
  sql.push(...objects.filter(object => object.type !== 'table').map(object => `${object.sql};`));
  const counts: Record<string, number> = {}; for (const table of BACKUP_TABLES) counts[table] = Number(await app.db.prepare(`SELECT count(*) AS n FROM "${table}"`).first('n'));
  return { sql: new TextEncoder().encode(sql.join('\n')), counts, versions: (await app.db.prepare('SELECT version FROM schema_versions ORDER BY version').all<{ version: number }>()).results.map(row => row.version) };
}

const budgetTables = ['archive_budget_runtime', 'archive_budget_days', 'archive_budget_pools', 'archive_budget_attempts', 'archive_budget_receipts', 'archive_budget_controls'] as const;
async function budgetEvidence(app: TestRuntime) {
  return Object.fromEntries<string[]>(await Promise.all(budgetTables.map(async table => [table,
    (await app.db.prepare(`SELECT * FROM ${table}`).all()).results.map(row => JSON.stringify(row)).sort(),
  ] as const)));
}

// Schema 19 allowed several resident private sessions. Build that historical
// state before applying the production admission policy; never disable its guards.
async function startLegacyStagingApp(): Promise<App> {
  const app = await createRuntime({ migrate: false, bindings: {
    APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'isolated-test',
    ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
  } });
  runtimes.push(app);
  const migrations = (await readdir(join(projectRoot, 'migrations'))).filter(name => name.endsWith('.sql') && Number(name.slice(0, 4)) <= 19).sort();
  for (const name of migrations) await app.db.batch(unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8')).map(sql => app.db.prepare(sql)));
  expect(await app.db.prepare('SELECT max(version) AS version FROM schema_versions').first('version')).toBe(19);
  const token = await app.signer.token();
  const session = await json<{ actor: App['actor'] }>(await app.request('/api/admin/session', { token }));
  return { ...app, token, actor: session.actor };
}

async function applyAdmissionAndLifecycleMigrations(app: TestRuntime) {
  const names = (await readdir(join(projectRoot, 'migrations'))).filter(name => /^002[0123456789]_.*\.sql$/.test(name) || /^003[0123456789]_.*\.sql$/.test(name)).sort();
  expect(names).toHaveLength(20);
  for (const name of names) await app.db.batch(unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8')).map(sql => app.db.prepare(sql)));
  expect(await app.db.prepare('SELECT max(version) AS version FROM schema_versions').first('version')).toBe(39);
}

describe('independent recovery CLI', () => {
  it('generates a private key without printing it or replacing an existing key', async () => {
    const directory = await temporary(); const keyPath = join(directory, 'private', 'key.txt'); const result = await cli(['generate-key', keyPath]).result; expect(result.code, result.stderr).toBe(0);
    const key = (await readFile(keyPath, 'utf8')).trim(); expect(Buffer.from(key, 'base64')).toHaveLength(32); expect(result.stdout + result.stderr).not.toContain(key); expect((await stat(keyPath)).mode & 0o777).toBe(0o600); expect((await stat(join(directory, 'private'))).mode & 0o777).toBe(0o700);
    expect((await cli(['generate-key', keyPath]).result).code).toBe(1); expect((await readFile(keyPath, 'utf8')).trim()).toBe(key);
  });
  it('decrypts and publishes complete SQL plus a private verified manifest', async () => {
    const directory = await temporary(); const chunks = ['CREATE TABLE saved(id TEXT);\n', "INSERT INTO saved VALUES('verified');\n"].map(text => new TextEncoder().encode(text)); const source = await bundle(directory, chunks); const output = join(directory, 'restored.sql');
    const result = await cli(['verify-decrypt', source.root, output], source.keyPath).result; expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ verified: true, sqlBytes: source.manifest.sqlBytes });
    expect(await readFile(output, 'utf8')).toBe(chunks.map(chunk => new TextDecoder().decode(chunk)).join('')); expect(JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'))).toEqual(source.manifest);
    expect((await stat(output)).mode & 0o777).toBe(0o600); expect((await stat(`${output}.manifest.json`)).mode & 0o777).toBe(0o600); expect(result.stdout + result.stderr).not.toContain(source.key);
    expect((await readdir(directory)).some(name => name.endsWith('.recovery.lock') || name.includes('.recovery-'))).toBe(false);
  });
  it('verifies SQL plus recursive pinned history, copies every encrypted object, and recovers after the source is gone', async () => {
    const directory = await temporary(); const source = await bundle(directory, [new TextEncoder().encode('CREATE TABLE verified(id TEXT);')]);
    const archiveRoot = join(directory, 'r2-download'); const history = await addHistory(source, archiveRoot);
    const output = join(directory, 'combined.sql');
    const result = await cli(['verify-decrypt', source.root, output, archiveRoot], source.keyPath).result;
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).historicalArchives).toMatchObject({ archives: 2, objects: history.objects.size, output: `${output}.archives` });
    for (const [objectKey, bytes] of history.objects) {
      expect(new Uint8Array(await readFile(join(`${output}.archives`, objectKey)))).toEqual(bytes);
      expect((await stat(join(`${output}.archives`, objectKey))).mode & 0o777).toBe(0o600);
    }
    await rm(archiveRoot, { recursive: true });
    const repeated = await cli(['verify-decrypt', source.root, join(directory, 'independent.sql'), `${output}.archives`], source.keyPath).result;
    expect(repeated.code, repeated.stderr).toBe(0);
  });
  it('never publishes SQL or partial archive output if a pinned manifest or recursive part is missing, changed, or encrypted under another key', async () => {
    for (const failure of ['missing-manifest', 'missing-part', 'corrupt-part', 'wrong-key', 'wrong-reference']) {
      const directory = await temporary(); const source = await bundle(directory, [new TextEncoder().encode('SELECT 1;')]);
      const history = await addHistory(source); const output = join(directory, 'failed.sql');
      if (failure === 'missing-manifest') await rm(join(source.root, history.parent.objectKey));
      if (failure === 'missing-part') await rm(join(source.root, history.parent.manifest.parts[0].objectKey));
      if (failure === 'corrupt-part') { const path = join(source.root, history.parent.manifest.parts[0].objectKey); const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes); }
      if (failure === 'wrong-key') {
        const original = source.key; source.key = bytes64(crypto.getRandomValues(new Uint8Array(32)));
        const otherKeyHistory = await addHistory(source); source.key = original;
        await writeFile(join(source.root, 'manifest.kcrm'), await sealPart(original, new TextEncoder().encode(JSON.stringify(otherKeyHistory.manifest)), newHeader(source.manifest.backupId, -1)));
      }
      if (failure === 'wrong-reference') {
        const changed = { ...history.manifest, archiveReferences: [{ ...history.manifest.archiveReferences![0], manifestSha256: '0'.repeat(64) }] };
        await writeFile(join(source.root, 'manifest.kcrm'), await sealPart(source.key, new TextEncoder().encode(JSON.stringify(changed)), newHeader(source.manifest.backupId, -1)));
      }
      const result = await cli(['verify-decrypt', source.root, output], source.keyPath).result;
      expect(result.code, failure).toBe(1); expect(result.stdout).not.toContain('"verified": true'); await noOutput(directory, 'failed.sql');
    }
  });
  it('removes partial plaintext for a wrong key, missing last part, and corrupted last part', async () => {
    for (const failure of ['wrong-key', 'missing', 'corrupted']) {
      const directory = await temporary(); const source = await bundle(directory, [new TextEncoder().encode('verified first chunk'), new TextEncoder().encode('last chunk')]);
      if (failure === 'wrong-key') await writeFile(source.keyPath, bytes64(crypto.getRandomValues(new Uint8Array(32))));
      if (failure === 'missing') await rm(join(source.root, 'part-00001.kcrm'));
      if (failure === 'corrupted') { const bytes = await readFile(join(source.root, 'part-00001.kcrm')); bytes[bytes.length - 1] ^= 1; await writeFile(join(source.root, 'part-00001.kcrm'), bytes); }
      const result = await cli(['verify-decrypt', source.root, join(directory, 'failed.sql')], source.keyPath).result; expect(result.code).toBe(1); expect(result.stdout).not.toContain('"verified": true'); await noOutput(directory, 'failed.sql');
    }
  });
  it('preserves existing output, sidecar, partial files, and locks without creating a placeholder', async () => {
    for (const suffix of ['', '.manifest.json', '.archives', '.partial', '.recovery.lock']) {
      const directory = await temporary(); const source = await bundle(directory, [new TextEncoder().encode('SELECT 1;')]); const output = join(directory, 'existing.sql'); await writeFile(output + suffix, 'KEEP THIS FILE');
      const result = await cli(['verify-decrypt', source.root, output], source.keyPath).result; expect(result.code).toBe(1); expect(await readFile(output + suffix, 'utf8')).toBe('KEEP THIS FILE');
      if (suffix) await absent(output); if (suffix !== '.recovery.lock') await absent(`${output}.recovery.lock`); expect((await readdir(directory)).some(name => name.startsWith('.existing.sql.recovery-'))).toBe(false);
    }
  });
  it('bounds encrypted file reads before decrypting oversized input', async () => {
    const directory = await temporary(); const source = await bundle(directory, [new Uint8Array(10)]); await writeFile(join(source.root, 'part-00000.kcrm'), new Uint8Array(2 * 1024 * 1024));
    const result = await cli(['verify-decrypt', source.root, join(directory, 'oversized.sql')], source.keyPath).result; expect(result.code).toBe(1); expect(result.stderr).toContain('at most'); await noOutput(directory, 'oversized.sql');
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('cleans private plaintext staging on %s before publishing SQL', async signal => {
    const directory = await temporary(); const source = await bundle(directory, Array.from({ length: 64 }, () => new Uint8Array(256 * 1024).fill(65))); const name = 'interrupted.sql'; const process = cli(['verify-decrypt', source.root, join(directory, name)], source.keyPath);
    let observedStage = false;
    try {
      for (let attempts = 0; attempts < 4000; attempts++) { const stage = (await readdir(directory)).find(file => file.startsWith(`.${name}.recovery-`)); if (stage) { observedStage = true; expect((await stat(join(directory, stage))).mode & 0o777).toBe(0o700); process.child.kill(signal); break; } if (process.child.exitCode !== null) break; await delay(2); }
      expect(observedStage).toBe(true); const result = await process.result; expect(result.code, result.stderr).toBe(signal === 'SIGINT' ? 130 : 143); expect(result.stdout).not.toContain('"verified": true'); await noOutput(directory, name);
    } finally { if (process.child.exitCode === null) process.child.kill('SIGTERM'); await process.result; }
  });
});

describe('independent SQL restore and credential reset in actual isolated D1', () => {

  it.each(['reserved', 'lost-reservation', 'executing', 'settled', 'unknown'] as const)('retains %s work with pending control liability through encrypted restore without recreating spending authority', async state => {
    const app = await startApp(); runtimes.push(app);
    const historyDb = await app.runtime.getD1Database('CRM_DB');
    for (let calls = 0; ; calls++) {
      expect(calls).toBeLessThan(12);
      if ((await advanceHistoryBackfill(historyDb)).state === 'ready') break;
    }
    const initial = await readArchiveBudgetRuntime(app.db);
    const identity = { epochId: crypto.randomUUID(), executionGeneration: initial.execution_generation, utcDay: await app.db.prepare("SELECT strftime('%Y-%m-%d','now') AS day").first<string>('day') as string };
    const opening = { ...identity, operationId: crypto.randomUUID(), expectedRevision: initial.revision, scopeId: 'synthetic-recovery-account', policyVersion: 'recovery-test-v1', envelopeVersion: 'recovery-test-v1', allocationSha256: 'a'.repeat(64), actorId: app.actor.id, reasonCode: 'ISOLATED_RECOVERY_TEST', pools: { work: { reads: 100_000, writes: 10_000 }, cleanup: { reads: 100_000, writes: 10_000 }, control: { reads: 100_000, writes: 10_000 } }, bootstrap: { reads: 10, writes: 10 } };
    await openArchiveBudgetDay(app.db, opening);
    const reservation = { ...identity, operationId: crypto.randomUUID(), attemptId: `restore-${state}`, pool: 'work' as const, workKeySha256: 'b'.repeat(64), targetRevision: 0, envelope: { reads: 10_000, writes: 1_000 }, overhead: { reads: 10_000, writes: 1_000 }, maximumStatements: 40 };
    if (state === 'lost-reservation') {
      const interrupted: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
        const results = await app.db.batch<T>(statements);
        if (statements.some(statement => statement.sql.startsWith('INSERT INTO archive_budget_attempts'))) throw new Error('Synthetic committed reservation reply loss');
        return results;
      } };
      await expect(reserveArchiveBudgetAttempt(interrupted, reservation)).rejects.toThrow('Synthetic committed reservation reply loss');
    } else await reserveArchiveBudgetAttempt(app.db, reservation);
    const claim = { ...identity, operationId: crypto.randomUUID(), attemptId: reservation.attemptId, expectedRevision: 0 };
    const claimed = state === 'executing' || state === 'settled' ? await claimArchiveBudgetAttempt(app.db, claim) : undefined;
    if (claimed) expect(claimed.grant).toBeDefined();
    let settlement: Parameters<typeof settleArchiveBudgetAttempt>[1] | undefined;
    if (state === 'settled') {
      const usage = createArchiveBudgetUsage(app.db, claimed!.grant!);
      await usage.batch([usage.prepare('SELECT id FROM centers WHERE id=?').bind('test-center')]);
      settlement = { operationId: crypto.randomUUID(), usage: usage.seal() };
      await settleArchiveBudgetAttempt(app.db, settlement);
    }
    if (state === 'unknown') await abandonArchiveBudgetAttempt(app.db, { ...identity, operationId: crypto.randomUUID(), attemptId: reservation.attemptId, expectedRevision: 0, reasonCode: 'LOST_RESPONSE' });

    const originalBudget = await budgetEvidence(app);
    const originalRuntime = JSON.parse(originalBudget.archive_budget_runtime[0]);
    expect(originalRuntime.state).toBe(state === 'unknown' ? 'closed' : 'open');
    expect(originalBudget.archive_budget_attempts.map(row => JSON.parse(row).state)).toEqual([state === 'lost-reservation' ? 'reserved' : state]);
    expect(originalBudget.archive_budget_controls.map(row => JSON.parse(row).state)).toEqual(['pending']);
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ dispatchBlocked: true, pendingControlOwner: reservation.attemptId });
    for (const table of budgetTables) expect(BACKUP_TABLES).toContain(table);
    const data = await snapshot(app);
    expect(data.versions.at(-1)).toBe(42);
    for (const table of budgetTables) expect(data.counts[table]).toBe(originalBudget[table].length);
    // A snapshot can predate later spending. Its older balances cannot authorize
    // another attempt after restore, including when the work had already settled.
    if (state === 'reserved' || state === 'executing') {
      await abandonArchiveBudgetAttempt(app.db, { ...identity, operationId: crypto.randomUUID(), attemptId: reservation.attemptId, expectedRevision: state === 'reserved' ? 0 : 1, reasonCode: 'AFTER_BACKUP_RESPONSE_LOSS' });
      expect((await budgetEvidence(app)).archive_budget_pools).not.toEqual(originalBudget.archive_budget_pools);
    }
    const directory = await temporary(); const encrypted = await bundle(directory, [data.sql], { recordCounts: data.counts, schemaVersions: data.versions });
    const output = join(directory, 'budget-restore.sql');
    const decrypted = await cli(['verify-decrypt', encrypted.root, output], encrypted.keyPath).result;
    expect(decrypted.code, decrypted.stderr).toBe(0);
    const verifiedManifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as BackupManifest;
    for (const table of budgetTables) expect(verifiedManifest.recordCounts[table]).toBe(originalBudget[table].length);
    const restored = await createRuntime({ migrate: false, bindings: {} }); runtimes.push(restored);
    await restored.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(await readFile(output, 'utf8'))].map(sql => restored.db.prepare(sql)));
    expect(await budgetEvidence(restored)).toEqual(originalBudget);
    expect(await readArchiveBudgetRuntime(restored.db)).toMatchObject({ dispatchBlocked: true, pendingControlOwner: reservation.attemptId });
    // Even before credential reset, a new process cannot treat unsettled
    // control as spare capacity, including when all work attempts are settled.
    await expect(reserveArchiveBudgetAttempt(restored.db, { ...reservation, operationId: crypto.randomUUID(), attemptId: 'restored-extra-attempt' })).rejects.toThrow();
    expect(await budgetEvidence(restored)).toEqual(originalBudget);
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    let previousRuntime = originalRuntime;
    for (let resetCount = 0; resetCount < 2; resetCount++) {
      await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
      const current = (await restored.db.prepare('SELECT * FROM archive_budget_runtime WHERE id=1').first<Record<string, unknown>>())!;
      expect(current).toEqual({ ...previousRuntime, state: 'closed', close_reason: 'restore_unreconciled', epoch_id: expect.stringMatching(/^[a-f0-9]{32}$/), execution_generation: await restored.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first('generation'), revision: previousRuntime.revision + 1 });
      expect(current.epoch_id).not.toBe(previousRuntime.epoch_id);
      expect(current.execution_generation).not.toBe(previousRuntime.execution_generation);
      expect(current.epoch_id).not.toBe(current.execution_generation);
      const afterReset = await budgetEvidence(restored);
      for (const table of budgetTables.filter(table => table !== 'archive_budget_runtime')) expect(afterReset[table], table).toEqual(originalBudget[table]);
      previousRuntime = current;
    }
    const beforeReplays = await budgetEvidence(restored);
    await expect(reserveArchiveBudgetAttempt(restored.db, reservation)).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    await expect(claimArchiveBudgetAttempt(restored.db, { ...claim, operationId: crypto.randomUUID() })).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    await expect(claimArchiveBudgetAttempt(restored.db, claim)).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    if (settlement) await expect(settleArchiveBudgetAttempt(restored.db, settlement)).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    await expect(abandonArchiveBudgetAttempt(restored.db, { ...identity, operationId: crypto.randomUUID(), attemptId: reservation.attemptId, expectedRevision: 1, reasonCode: 'LOST_RESPONSE' })).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    await expect(openArchiveBudgetDay(restored.db, opening)).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    const centers = (await restored.db.prepare('SELECT * FROM centers ORDER BY id').all()).results;
    if (state === 'executing') {
      const staleUsage = createArchiveBudgetUsage(restored.db, claimed!.grant!);
      await expect(staleUsage.batch([staleUsage.prepare("UPDATE centers SET timezone='UTC' WHERE id='test-center'")])).rejects.toThrow();
    }
    expect((await restored.db.prepare('SELECT * FROM centers ORDER BY id').all()).results).toEqual(centers);
    expect(await budgetEvidence(restored)).toEqual(beforeReplays);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it.each(['settled', 'lost-terminal-reply', 'unknown-prefix', 'overrun-prefix'] as const)('preserves %s control charges and terminal receipt through encrypted restore and repeated reset', async scenario => {
    const app = await startApp(); runtimes.push(app);
    const { identity, input: opening } = await openBudgetFixture(app, { work: { reads: 100_000, writes: 10_000 }, cleanup: { reads: 100_000, writes: 10_000 }, control: { reads: 100_000, writes: 10_000 } });
    const reservation = { ...identity, operationId: crypto.randomUUID(), attemptId: `terminal-${scenario}`, pool: 'work' as const, workKeySha256: 'b'.repeat(64), targetRevision: 0, envelope: { reads: 10_000, writes: 1_000 }, overhead: { reads: 1_000, writes: 100 }, maximumStatements: 26 };
    let altered = false;
    const native: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const results = await app.db.batch<T>(statements);
      if (!altered && (scenario === 'unknown-prefix' || scenario === 'overrun-prefix') && statements.some(statement => statement.sql.startsWith("UPDATE archive_budget_attempts SET state='executing'"))) {
        altered = true;
        return results.map((result, index) => index ? result : { ...result, meta: scenario === 'unknown-prefix' ? { rows_written: result.meta.rows_written } : { ...result.meta, rows_read: reservation.overhead.reads + 1 } });
      }
      if (scenario === 'lost-terminal-reply' && statements.some(statement => /UPDATE\s+archive_budget_controls/.test(statement.sql))) throw new Error('Synthetic committed control reply loss');
      return results;
    } };
    const invocation = createArchiveBudgetInvocation(native);
    const reserved = await reserveArchiveBudgetAttempt(invocation, reservation); expect(reserved.controlGrant).toBeDefined();
    const claimed = await claimArchiveBudgetAttempt(invocation, { ...identity, operationId: crypto.randomUUID(), attemptId: reservation.attemptId, expectedRevision: 0 }); expect(claimed.grant).toBeDefined();
    invocation.phase('work');
    const work = createArchiveBudgetUsage(invocation, claimed.grant!);
    await work.batch([work.prepare('SELECT id FROM centers WHERE id=?').bind('test-center')]);
    invocation.phase('control');
    await settleArchiveBudgetAttempt(invocation, { operationId: crypto.randomUUID(), usage: work.seal() });
    const poolsBeforeTerminal = (await budgetEvidence(app)).archive_budget_pools;
    const terminal = { operationId: crypto.randomUUID(), usage: invocation.sealControlUsage(reserved.controlGrant) };
    const expectedControl = scenario === 'unknown-prefix' ? 'unknown' : scenario === 'overrun-prefix' ? 'overrun' : 'settled';
    if (scenario === 'lost-terminal-reply') await expect(finalizeArchiveBudgetControl(invocation, terminal)).rejects.toThrow('Synthetic committed control reply loss');
    else expect(await finalizeArchiveBudgetControl(invocation, terminal)).toMatchObject({ operationId: terminal.operationId, kind: 'control', result: { state: expectedControl } });
    const original = await budgetEvidence(app);
    const control = JSON.parse(original.archive_budget_controls[0]);
    expect(control).toMatchObject({ state: expectedControl, operation_id: terminal.operationId, prepaid_reads: reservation.overhead.reads, prepaid_writes: reservation.overhead.writes });
    expect(JSON.parse(control.result_json)).toMatchObject({ attemptId: reservation.attemptId, state: expectedControl });
    expect(control.charge_reads).toBeGreaterThanOrEqual(reservation.overhead.reads);
    expect(control.charge_writes).toBeGreaterThanOrEqual(reservation.overhead.writes);
    expect(original.archive_budget_attempts.map(row => JSON.parse(row).state)).toEqual(['settled']);
    if (scenario === 'overrun-prefix') { expect(control.deficit_reads).toBeGreaterThan(0); expect(original.archive_budget_pools).not.toEqual(poolsBeforeTerminal); }
    else expect(original.archive_budget_pools).toEqual(poolsBeforeTerminal);
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ dispatchBlocked: expectedControl !== 'settled', pendingControlOwner: null });
    const data = await snapshot(app);
    // Preserve the earlier backup even if a healthy source later spends again.
    if (expectedControl === 'settled') {
      await reserveArchiveBudgetAttempt(app.db, { ...reservation, operationId: crypto.randomUUID(), attemptId: 'post-backup-control-liability' });
      expect((await budgetEvidence(app)).archive_budget_controls).toHaveLength(2);
      expect((await budgetEvidence(app)).archive_budget_pools).not.toEqual(original.archive_budget_pools);
    }
    const directory = await temporary(); const encrypted = await bundle(directory, [data.sql], { recordCounts: data.counts, schemaVersions: data.versions });
    const output = join(directory, 'terminal-restore.sql');
    const decrypted = await cli(['verify-decrypt', encrypted.root, output], encrypted.keyPath).result;
    expect(decrypted.code, decrypted.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as BackupManifest;
      expect(manifest.schemaVersions.at(-1)).toBe(42);
    for (const table of budgetTables) expect(manifest.recordCounts[table]).toBe(original[table].length);
    const restored = await createRuntime({ migrate: false, bindings: {} }); runtimes.push(restored);
    await restored.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(await readFile(output, 'utf8'))].map(sql => restored.db.prepare(sql)));
    expect(await budgetEvidence(restored)).toEqual(original);
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    for (let count = 0; count < 2; count++) {
      await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
      expect(await readArchiveBudgetRuntime(restored.db)).toMatchObject({ state: 'closed', close_reason: 'restore_unreconciled', dispatchBlocked: true, pendingControlOwner: null });
      const current = await budgetEvidence(restored);
      for (const table of budgetTables.filter(table => table !== 'archive_budget_runtime')) expect(current[table], table).toEqual(original[table]);
    }
    const beforeReplays = await budgetEvidence(restored);
    await expect(finalizeArchiveBudgetControl(restored.db, terminal)).rejects.toThrow('ARCHIVE_BUDGET_CONTROL_USAGE_INVALID');
    await expect(finalizeArchiveBudgetControl(restored.db, { ...terminal, usage: JSON.parse(JSON.stringify(terminal.usage)) })).rejects.toThrow('ARCHIVE_BUDGET_CONTROL_USAGE_INVALID');
    await expect(reserveArchiveBudgetAttempt(restored.db, reservation)).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    await expect(openArchiveBudgetDay(restored.db, opening)).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    expect(await budgetEvidence(restored)).toEqual(beforeReplays);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('fences budget reset under maintenance and rolls back lock release and epoch rotation together on failure', async () => {
    const app = await startApp(); runtimes.push(app);
    const { identity } = await openBudgetFixture(app);
    await reserveArchiveBudgetAttempt(app.db, { ...identity, operationId: crypto.randomUUID(), attemptId: 'locked-control-liability', pool: 'work', workKeySha256: 'b'.repeat(64), targetRevision: 0, envelope: { reads: 1_000, writes: 100 }, overhead: { reads: 1_000, writes: 100 }, maximumStatements: 26 });
    const beforeBudget = await budgetEvidence(app);
    expect(beforeBudget.archive_budget_controls.map(row => JSON.parse(row).state)).toEqual(['pending']);
    const beforeHistory = await app.db.prepare('SELECT * FROM history_runtime WHERE id=1').first();
    const beforeReport = await app.db.prepare('SELECT * FROM report_runtime WHERE id=1').first();
    const beforeStaff = (await app.db.prepare('SELECT * FROM staff ORDER BY id').all()).results;
    const lock = { until: new Date(Date.now() + 60_000).toISOString(), job: `restore-lock-${crypto.randomUUID()}` };
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1').bind(lock.until, lock.job).run();
    await expect(app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run()).rejects.toThrow('backup_maintenance');
    expect(await budgetEvidence(app)).toEqual(beforeBudget);
    expect(await app.db.prepare('SELECT * FROM history_runtime WHERE id=1').first()).toEqual(beforeHistory);

    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    await expect(app.db.batch([...reset, 'SELECT abs(-9223372036854775808)'].map(sql => app.db.prepare(sql)))).rejects.toThrow('integer overflow');
    expect(await budgetEvidence(app)).toEqual(beforeBudget);
    expect(await app.db.prepare('SELECT * FROM history_runtime WHERE id=1').first()).toEqual(beforeHistory);
    expect(await app.db.prepare('SELECT * FROM report_runtime WHERE id=1').first()).toEqual(beforeReport);
    expect((await app.db.prepare('SELECT * FROM staff ORDER BY id').all()).results).toEqual(beforeStaff);
    expect(await app.db.prepare('SELECT write_locked_until,lock_job_id FROM backup_runtime WHERE id=1').first()).toEqual({ write_locked_until: lock.until, lock_job_id: lock.job });
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE action='recovery_access_reset'").first('n')).toBe(0);

    await app.db.batch(reset.map(sql => app.db.prepare(sql)));
    const after = await app.db.prepare('SELECT * FROM archive_budget_runtime WHERE id=1').first<Record<string, unknown>>();
    const original = JSON.parse(beforeBudget.archive_budget_runtime[0]);
    expect(after).toMatchObject({ state: 'closed', close_reason: 'restore_unreconciled', execution_generation: await app.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first('generation'), revision: original.revision + 1 });
    expect(after!.epoch_id).not.toBe(original.epoch_id);
    const afterBudget = await budgetEvidence(app);
    for (const table of budgetTables.filter(table => table !== 'archive_budget_runtime')) expect(afterBudget[table], table).toEqual(beforeBudget[table]);
    expect(await app.db.prepare('SELECT write_locked_until,lock_job_id FROM backup_runtime WHERE id=1').first()).toEqual({ write_locked_until: null, lock_job_id: null });
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('retains accepted lifecycle progress and first verification through encrypted SQL restore and repeated reset', async () => {
    const source = await nativeSemanticFixture(2);
    const app = await startApp(); runtimes.push(app);
    const objects = new Map<string, Uint8Array>();
    const archive = await createArchive(source.key, source.metadata, source.records.sort(compareArchiveRecords), async (part, bytes) => { objects.set(part.objectKey, bytes); });
    const root: ArchiveReference = { archiveId: archive.manifest.archiveId, kind: archive.manifest.kind, manifestObjectKey: archive.objectKey, manifestSha256: archive.sha256 };
    const staging = await D1ArchiveSemanticStaging.create(app.db, source.key, root);
    await staging.registerManifest(root, archive.encrypted);
    for (const part of archive.manifest.parts) await staging.stageEncryptedPart(archive.manifest.archiveId, part.index, objects.get(part.objectKey)!);
    const controlIdentity = async () => ({ ...staging.handle, executionGeneration: staging.handle.generation, expectedRevision: Number(await app.db.prepare('SELECT revision FROM archive_semantic_lifecycle WHERE verification_id=?').bind(staging.handle.verificationId).first('revision')) });
    const renewed = await renewArchiveStaging(app.db, { ...await controlIdentity(), operationId: crypto.randomUUID(), actorId: app.actor.id, reason: 'RECOVERY_TEST_RENEWAL' });
    expect(renewed.renewalCount).toBe(1);
    await pauseArchiveStaging(app.db, { ...await controlIdentity(), operationId: crypto.randomUUID(), actorId: app.actor.id, reason: 'maintenance', nextEligibleAt: new Date(Date.now() + 500).toISOString() });
    await delay(600); // The native control requires the recorded pause boundary to pass.
    await resumeArchiveStaging(app.db, { ...await controlIdentity(), operationId: crypto.randomUUID(), actorId: app.actor.id });
    const frozen = await staging.freeze();
    const handle = await startMonthlySemanticVerification(app.db, { ...staging.handle, commitToken: frozen.commitToken, graphSha256: frozen.graphSha256 });
    for (let calls = 0; ; calls++) {
      expect(calls).toBeLessThan(500);
      const result = await advanceMonthlySemanticVerification(app.db, handle);
      expect(result.queries).toBeLessThanOrEqual(40);
      if (result.status === 'complete') break;
      expect(result.status).toBe('pending');
    }
    const lifecycle = await app.db.prepare('SELECT * FROM archive_semantic_lifecycle WHERE verification_id=? AND generation=?').bind(staging.handle.verificationId, staging.handle.generation).first<Record<string, unknown>>();
    expect(lifecycle).toBeTruthy();
    expect(lifecycle!.last_progress_at).toEqual(expect.any(String));
    expect(lifecycle!.verified_at).toEqual(expect.any(String));
    expect(Number(lifecycle!.progress_revision)).toBeGreaterThan(0);
    expect(lifecycle!.migration_grace_until).toBeNull();
    expect(lifecycle!.renewed_at).toEqual(expect.any(String));
    expect(lifecycle!.renewal_count).toBe(1);
    expect(lifecycle!.resume_grace_until).toEqual(expect.any(String));
    expect(BACKUP_TABLES).toContain('archive_semantic_lifecycle');
    expect(BACKUP_TABLES).toContain('archive_semantic_diagnostics');
    const diagnostics = (await app.db.prepare('SELECT * FROM archive_semantic_diagnostics ORDER BY event_id').all()).results;
    expect(diagnostics).toHaveLength(3);
    const data = await snapshot(app);
    expect(data.counts.archive_semantic_lifecycle).toBe(1);
    expect(data.counts.archive_semantic_diagnostics).toBe(diagnostics.length);
    const directory = await temporary();
    const encrypted = await bundle(directory, [data.sql], { recordCounts: data.counts, schemaVersions: data.versions });
    const output = join(directory, 'lifecycle-restore.sql');
    const decrypted = await cli(['verify-decrypt', encrypted.root, output], encrypted.keyPath).result;
    expect(decrypted.code, decrypted.stderr).toBe(0);
    const restored = await createRuntime({ migrate: false, bindings: {} }); runtimes.push(restored);
    await restored.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(await readFile(output, 'utf8'))].map(sql => restored.db.prepare(sql)));
    const readLifecycle = () => restored.db.prepare('SELECT * FROM archive_semantic_lifecycle WHERE verification_id=? AND generation=?').bind(staging.handle.verificationId, staging.handle.generation).first<Record<string, unknown>>();
    expect(await readLifecycle()).toEqual(lifecycle);
    expect((await restored.db.prepare('SELECT * FROM archive_semantic_diagnostics ORDER BY event_id').all()).results).toEqual(diagnostics);
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
    const invalidated = await readLifecycle();
    expect(invalidated).toEqual({ ...lifecycle, revision: Number(lifecycle!.revision) + 1, due_at: expect.any(String), resume_grace_until: null });
    expect(Date.parse(String(invalidated!.due_at))).toBeLessThanOrEqual(Date.now());
    expect(await restored.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first('generation')).not.toBe(staging.handle.generation);
    await expect(advanceMonthlySemanticVerification(restored.db, handle)).rejects.toThrow(/STALE/);
    const restoredDiagnostics = (await restored.db.prepare('SELECT * FROM archive_semantic_diagnostics ORDER BY event_id').all()).results;
    expect(restoredDiagnostics).toEqual(expect.arrayContaining(diagnostics));
    expect(restoredDiagnostics).toHaveLength(diagnostics.length + 1);
    expect(restoredDiagnostics.filter(row => row.kind === 'restore_invalidated')).toHaveLength(1);
    await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
    expect(await readLifecycle()).toEqual(invalidated);
    expect((await restored.db.prepare('SELECT * FROM archive_semantic_diagnostics ORDER BY event_id').all()).results).toEqual(restoredDiagnostics);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it.each(['paused', 'cleanup'] as const)('clears restored %s authority while retaining renewal and diagnostic history', async state => {
    const app = await startApp(); runtimes.push(app);
    const master = bytes64(crypto.getRandomValues(new Uint8Array(32)));
    const root: ArchiveReference = { archiveId: 'recovery-control-root', kind: 'monthly', manifestObjectKey: `archives/test-center/2025-01/recovery-control-root/manifest-${'a'.repeat(64)}.kca`, manifestSha256: 'a'.repeat(64) };
    const staging = await D1ArchiveSemanticStaging.create(app.db, master, root);
    const identity = async () => ({ ...staging.handle, executionGeneration: staging.handle.generation, expectedRevision: Number(await app.db.prepare('SELECT revision FROM archive_semantic_lifecycle WHERE verification_id=?').bind(staging.handle.verificationId).first('revision')) });
    const renewInput = { ...await identity(), operationId: crypto.randomUUID(), actorId: app.actor.id, reason: 'RECOVERY_TEST_RENEWAL' };
    await renewArchiveStaging(app.db, renewInput);
    const pauseInput = { ...await identity(), operationId: crypto.randomUUID(), actorId: app.actor.id, reason: 'maintenance' as const, nextEligibleAt: new Date(Date.now() + (state === 'cleanup' ? 500 : 60_000)).toISOString() };
    await pauseArchiveStaging(app.db, pauseInput);
    let oldCleanup: Awaited<ReturnType<typeof claimArchiveStagingCleanup>> | undefined;
    if (state === 'cleanup') {
      await delay(600);
      await resumeArchiveStaging(app.db, { ...await identity(), operationId: crypto.randomUUID(), actorId: app.actor.id });
      // Restore an abandoned invalid session with a real accepted cleanup claim.
      await app.db.prepare("UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL WHERE verification_id=?").bind(staging.handle.verificationId).run();
      oldCleanup = await claimArchiveStagingCleanup(app.db, staging.handle);
    }
    const lifecycle = (await app.db.prepare('SELECT * FROM archive_semantic_lifecycle WHERE verification_id=?').bind(staging.handle.verificationId).first<Record<string, unknown>>())!;
    expect(lifecycle.renewal_count).toBe(1);
    expect(lifecycle.renewed_at).toEqual(expect.any(String));
    if (state === 'paused') expect(lifecycle.pause_reason).toBe('maintenance');
    else expect(Date.parse(String(lifecycle.cleanup_lease_until))).toBeGreaterThan(Date.now());
    const diagnostics = (await app.db.prepare('SELECT * FROM archive_semantic_diagnostics ORDER BY event_id').all()).results;
    const data = await snapshot(app);
    expect(data.counts.archive_semantic_diagnostics).toBe(diagnostics.length);
    const restored = await createRuntime({ migrate: false, bindings: {} }); runtimes.push(restored);
    await restored.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(new TextDecoder().decode(data.sql))].map(sql => restored.db.prepare(sql)));
    const readLifecycle = () => restored.db.prepare('SELECT * FROM archive_semantic_lifecycle WHERE verification_id=?').bind(staging.handle.verificationId).first<Record<string, unknown>>();
    const readDiagnostics = async () => (await restored.db.prepare('SELECT * FROM archive_semantic_diagnostics ORDER BY event_id').all()).results;
    expect(await readLifecycle()).toEqual(lifecycle);
    expect(await readDiagnostics()).toEqual(diagnostics);
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
    const invalidated = await readLifecycle();
    expect(invalidated).toEqual({ ...lifecycle, revision: Number(lifecycle.revision) + 1, due_at: expect.any(String), pause_reason: null, paused_at: null, next_eligible_at: null, resume_grace_until: null, cleanup_lease_until: null });
    expect(Date.parse(String(invalidated!.due_at))).toBeLessThanOrEqual(Math.min(Date.now(), Date.parse(String(lifecycle.due_at))));
    expect(await restored.db.prepare('SELECT cleanup_generation,cleanup_token,status FROM archive_semantic_sessions WHERE verification_id=?').bind(staging.handle.verificationId).first()).toEqual({ cleanup_generation: null, cleanup_token: null, status: 'invalid' });
    const afterResetDiagnostics = await readDiagnostics();
    expect(afterResetDiagnostics).toEqual(expect.arrayContaining(diagnostics));
    expect(afterResetDiagnostics).toHaveLength(diagnostics.length + 1);
    const restoreNotes = afterResetDiagnostics.filter(row => row.kind === 'restore_invalidated');
    expect(restoreNotes).toHaveLength(1);
    expect(JSON.parse(String(restoreNotes[0].detail_json))).toMatchObject({ admittedAt: lifecycle.admitted_at, lastProgressAt: lifecycle.last_progress_at, progressRevision: lifecycle.progress_revision, verifiedAt: lifecycle.verified_at, renewalDeadlineAt: lifecycle.renewal_deadline_at, renewalCount: 1, renewedAt: lifecycle.renewed_at, resumeGraceUntil: lifecycle.resume_grace_until, pauseReason: lifecycle.pause_reason, pausedAt: lifecycle.paused_at, nextEligibleAt: lifecycle.next_eligible_at });
    await expect(pauseArchiveStaging(restored.db, pauseInput)).rejects.toThrow('ARCHIVE_STAGING_CONTROL_STALE');
    await expect(renewArchiveStaging(restored.db, renewInput)).rejects.toThrow('ARCHIVE_STAGING_CONTROL_STALE');
    if (oldCleanup) await expect(D1ArchiveSemanticStaging.cleanupPage(restored.db, oldCleanup)).rejects.toThrow(/STALE/);
    await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
    expect(await readLifecycle()).toEqual(invalidated);
    expect(await readDiagnostics()).toEqual(afterResetDiagnostics);
    const currentGeneration = await restored.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation');
    await restored.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1').bind(new Date(Date.now() + 60_000).toISOString(), `recovery-test-${crypto.randomUUID()}`).run();
    await expect(claimArchiveStagingCleanup(restored.db, staging.handle)).rejects.toThrow('backup_maintenance');
    expect(await readLifecycle()).toEqual(invalidated);
    expect(await readDiagnostics()).toEqual(afterResetDiagnostics);
    await restored.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL,lock_job_id=NULL WHERE id=1').run();
    const freshCleanup = await claimArchiveStagingCleanup(restored.db, staging.handle);
    expect(freshCleanup.cleanupGeneration).toBe(currentGeneration);
    expect(freshCleanup.generation).toBe(staging.handle.generation);
    for (let calls = 0; ; calls++) {
      expect(calls).toBeLessThan(20);
      const page = await D1ArchiveSemanticStaging.cleanupPage(restored.db, freshCleanup, 64);
      if (page.complete) break;
    }
    expect(await readLifecycle()).toBeNull();
    expect(await readDiagnostics()).toEqual(expect.arrayContaining(afterResetDiagnostics));
    expect((await readDiagnostics()).filter(row => row.kind === 'restore_invalidated')).toHaveLength(1);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('preserves private runner evidence but invalidates every restored run and lease, including completed runs', async () => {
    const app = await startLegacyStagingApp();
    const generation = await app.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation');
    const timestamp = new Date().toISOString(), future = new Date(Date.now() + 3600000).toISOString();
    const privateTables = ['archive_semantic_operations', 'archive_semantic_visit_totals', 'archive_semantic_review_witnesses'] as const;
    const runnerTables = ['archive_semantic_runs', ...privateTables] as const;
    const handles = [];
    // Synthetic checkpoint states test restore rules independently of the
    // verifier. Their derived rows carry no publication or operational authority.
    for (const status of ['pending', 'running', 'complete', 'invalid'] as const) {
      const runId = `restored-run-${status}`, verificationId = `runner-session-${status}`;
      const commitToken = `snapshot-${status}`, graphSha256 = 'a'.repeat(64), requestId = crypto.randomUUID();
      handles.push({ runId, verificationId, generation: generation!, commitToken, graphSha256 });
      await app.db.batch([
        app.db.prepare("INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at) VALUES(?,?,'private-root',?,'{}','staging',?)").bind(verificationId, generation, 'b'.repeat(64), timestamp),
        app.db.prepare("UPDATE archive_semantic_sessions SET status='frozen',commit_token=?,graph_sha256=? WHERE verification_id=? AND generation=?").bind(commitToken, graphSha256, verificationId, generation),
        app.db.prepare("INSERT INTO archive_semantic_runs(run_id,verification_id,generation,snapshot_commit_token,graph_sha256,validator_version,archive_id,header_json,status,phase,revision,cursor_json,created_at,updated_at) VALUES(?,?,?,?,?,1,'private-root','{}','pending','records',0,'{}',?,?)").bind(runId, verificationId, generation, commitToken, graphSha256, timestamp, timestamp),
        app.db.prepare("UPDATE archive_semantic_runs SET status='running',lease_token=?,lease_expires_at=?,revision=1 WHERE run_id=?").bind(`lease-${status}`, future, runId),
        app.db.prepare("INSERT INTO archive_semantic_operations(run_id,request_id,source_table,record_key,visit_id,operation_version,record_bytes) VALUES(?,?,'attendance_events',?,'private-visit',1,512)").bind(runId, requestId, requestId),
        app.db.prepare("INSERT INTO archive_semantic_visit_totals(run_id,visit_id,operation_count,record_bytes) VALUES(?,'private-visit',1,512)").bind(runId),
        app.db.prepare("INSERT INTO archive_semantic_review_witnesses(run_id,review_id,audit_key) VALUES(?,'private-review','private-audit')").bind(runId),
      ]);
      if (status !== 'running') await app.db.prepare('UPDATE archive_semantic_runs SET status=?,phase=?,lease_token=NULL,lease_expires_at=NULL,revision=3,cursor_json=?,error_code=? WHERE run_id=?').bind(status, status === 'complete' ? 'complete' : 'records', '{"restoredCursor":"keep-private-evidence"}', status === 'invalid' ? 'SYNTHETIC_INVALID_EVIDENCE' : null, runId).run();
      if (status === 'complete') await app.db.prepare("UPDATE archive_semantic_sessions SET status='verified' WHERE verification_id=? AND generation=?").bind(verificationId, generation).run();
    }
    const original = new Map<string, Record<string, unknown>[]>();
    for (const table of runnerTables) {
      expect(BACKUP_TABLES, table).toContain(table);
      original.set(table, (await app.db.prepare(`SELECT * FROM ${table}`).all()).results);
    }
    const residentSessions = (await app.db.prepare('SELECT * FROM archive_semantic_sessions ORDER BY verification_id').all()).results;
    await applyAdmissionAndLifecycleMigrations(app);
    expect((await app.db.prepare('SELECT * FROM archive_semantic_sessions ORDER BY verification_id').all()).results).toEqual(residentSessions);
    expect(BACKUP_TABLES).toContain('archive_semantic_lifecycle');
    const lifecycle = (await app.db.prepare('SELECT * FROM archive_semantic_lifecycle ORDER BY verification_id').all()).results;
    expect(lifecycle).toHaveLength(residentSessions.length);
    const data = await snapshot(app);
    const restored = await createRuntime({ bindings: {}, migrate: false }); runtimes.push(restored);
    await restored.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(new TextDecoder().decode(data.sql))].map(sql => restored.db.prepare(sql)));
    expect((await restored.db.prepare('SELECT * FROM archive_semantic_sessions ORDER BY verification_id').all()).results).toEqual(residentSessions);
    expect((await restored.db.prepare('SELECT * FROM archive_semantic_lifecycle ORDER BY verification_id').all()).results).toEqual(lifecycle);
    expect(data.counts.archive_semantic_lifecycle).toBe(lifecycle.length);
    const admitNewSession = () => restored.db.prepare("INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at) VALUES('after-retained-cleanup',(SELECT generation FROM history_runtime WHERE id=1),'new-private-root',?,?,'staging',?)").bind('c'.repeat(64), JSON.stringify({ archiveId: 'new-private-root', kind: 'monthly', manifestObjectKey: 'private-test-manifest', manifestSha256: 'c'.repeat(64) }), timestamp).run();
    await expect(admitNewSession()).rejects.toThrow('ARCHIVE_STAGING_ADMISSION_LIMIT');
    for (const table of runnerTables) {
      expect((await restored.db.prepare(`SELECT * FROM ${table}`).all()).results, table).toEqual(original.get(table));
      expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(data.counts[table]);
    }
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    let invalidatedLifecycle: Record<string, unknown>[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
      expect(await restored.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first('generation')).not.toBe(generation);
      expect((await restored.db.prepare('SELECT * FROM archive_semantic_runs').all()).results).toEqual(original.get('archive_semantic_runs')!.map(row => ({ ...row, status: 'invalid', lease_token: null, lease_expires_at: null })));
      expect(await restored.db.prepare("SELECT error_code FROM archive_semantic_runs WHERE run_id='restored-run-invalid'").first('error_code')).toBe('SYNTHETIC_INVALID_EVIDENCE');
      const afterReset = (await restored.db.prepare('SELECT * FROM archive_semantic_lifecycle ORDER BY verification_id').all()).results;
      if (attempt === 0) {
        expect(afterReset).toEqual(lifecycle.map(row => {
          const alreadyInvalid = residentSessions.find(session => session.verification_id === row.verification_id)!.status === 'invalid';
          return { ...row, revision: Number(row.revision) + (alreadyInvalid ? 0 : 1), due_at: alreadyInvalid ? row.due_at : expect.any(String) };
        }));
        for (const row of afterReset) expect(Date.parse(String(row.due_at))).toBeLessThanOrEqual(Date.now());
        invalidatedLifecycle = afterReset;
      } else expect(afterReset).toEqual(invalidatedLifecycle);
      for (const table of privateTables) expect((await restored.db.prepare(`SELECT * FROM ${table}`).all()).results, table).toEqual(original.get(table));
      for (const handle of handles) await expect(advanceMonthlySemanticVerification(restored.db, handle)).rejects.toThrow(/STALE/);
      await expect(restored.db.prepare("UPDATE archive_semantic_runs SET status='complete',phase='complete' WHERE run_id='restored-run-complete'").run()).rejects.toThrow('ARCHIVE_SEMANTIC_RUN_STALE');
      await expect(restored.db.prepare("UPDATE archive_semantic_runs SET generation=(SELECT generation FROM history_runtime WHERE id=1) WHERE run_id='restored-run-complete'").run()).rejects.toThrow('ARCHIVE_SEMANTIC_RUN_STALE');
      await expect(restored.db.prepare("INSERT INTO archive_semantic_operations(run_id,request_id,source_table,record_key,visit_id,operation_version,record_bytes) VALUES('restored-run-running','stale-request','attendance_events','stale-request','private-visit',2,512)").run()).rejects.toThrow('ARCHIVE_SEMANTIC_RUN_STALE');
      expect(await restored.db.prepare('SELECT count(*) AS n FROM archive_jobs').first('n')).toBe(0);
      expect(await restored.db.prepare('SELECT count(*) AS n FROM history_record_locations').first('n')).toBe(0);
      expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      await expect(admitNewSession()).rejects.toThrow('ARCHIVE_STAGING_ADMISSION_LIMIT');
    }
    // Restore rotates execution authority, not the generation of retained data.
    // Every partial cleanup must retain the admission slot until the final row.
    const resetGeneration = await restored.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation');
    for (const handle of handles) {
      const cleanup = await D1ArchiveSemanticStaging.beginCleanup(restored.db, handle);
      expect(cleanup.cleanupGeneration).toBe(resetGeneration);
      for (let calls = 0; ; calls++) {
        expect(calls).toBeLessThan(20);
        await expect(admitNewSession()).rejects.toThrow('ARCHIVE_STAGING_ADMISSION_LIMIT');
        const result = await D1ArchiveSemanticStaging.cleanupPage(restored.db, cleanup, 1);
        expect(result.deleted).toBeLessThanOrEqual(1);
        const residents = (await restored.db.prepare('SELECT generation FROM archive_semantic_sessions').all<{ generation: string }>()).results;
        expect(residents.every(row => row.generation === generation)).toBe(true);
        expect(await restored.db.prepare('SELECT count(*) AS n FROM archive_semantic_lifecycle').first('n')).toBe(residents.length);
        if (residents.length) await expect(admitNewSession()).rejects.toThrow('ARCHIVE_STAGING_ADMISSION_LIMIT');
        if (result.complete) break;
      }
    }
    for (const table of ['archive_semantic_sessions', 'archive_semantic_lifecycle', ...runnerTables]) expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(0);
    await admitNewSession();
    expect(await restored.db.prepare("SELECT generation FROM archive_semantic_sessions WHERE verification_id='after-retained-cleanup'").first('generation')).toBe(resetGeneration);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('preserves historical authority and private staging through restore but invalidates verification and backfill generations', async () => {
    const app = await startLegacyStagingApp();
    const student = await createStudent(app);
    const observed = observation(student.student.id, 'check_in');
    const accepted = await json<{ visit: { id: string; version: number } }>(await app.request('/api/admin/attendance', { token: app.token, body: observed }), 201);
    await json(await app.request(`/api/admin/visits/${accepted.visit.id}/corrections`, { token: app.token, body: {
      correctionId: crypto.randomUUID(), expectedVersion: accepted.visit.version,
      checkInAt: new Date(Date.parse(observed.observedAt) - 60000).toISOString(), checkOutAt: null,
      reason: 'Synthetic restored history must retain the accepted correction.',
    } }), 201);
    const authorityTables = ['history_request_keys', 'history_visit_heads', 'history_record_locations'] as const;
    const original = new Map<string, Record<string, unknown>[]>();
    for (const table of authorityTables) {
      const rows = (await app.db.prepare(`SELECT * FROM ${table}`).all()).results;
      if (table === 'history_record_locations') expect(rows).toEqual([]);
      else expect(rows.length, table).toBeGreaterThan(0);
      original.set(table, rows);
    }
    // Simulate the durable progress contained in an already reconciled backup.
    // The reset must revisit every source even if its saved cursor was complete.
    await app.db.batch([
      app.db.prepare("UPDATE history_backfill_jobs SET cursor='restored-complete-cursor',processed=41,status='complete'"),
      app.db.prepare("UPDATE history_runtime SET state='ready' WHERE id=1"),
    ]);
    const previousGeneration = await app.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation');
    const privateTables = ['archive_semantic_manifests', 'archive_semantic_parts', 'archive_semantic_rows'] as const;
    const stagingTables = ['archive_semantic_sessions', ...privateTables] as const;
    const stageCreatedAt = new Date().toISOString();
    const stagingKey = bytes64(crypto.getRandomValues(new Uint8Array(32)));
    const rootReference: ArchiveReference = { archiveId: 'private-root', kind: 'monthly', manifestObjectKey: `archives/test-center/2025-01/private-root/manifest-${'a'.repeat(64)}.kca`, manifestSha256: 'a'.repeat(64) };
    // These are synthetic private checkpoints, including one marked verified.
    // Recovery must not carry any of their success state into its new generation.
    for (const status of ['staging', 'frozen', 'verified', 'invalid'] as const) {
      const verificationId = `restore-${status}`;
      await app.db.batch([
        app.db.prepare("INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at) VALUES(?,?,?,?,?,'staging',?)").bind(verificationId, previousGeneration, 'private-root', 'a'.repeat(64), JSON.stringify(rootReference), stageCreatedAt),
        app.db.prepare('INSERT INTO archive_semantic_manifests(verification_id,generation,archive_id,manifest_sha256,manifest_json,plaintext_bytes,part_count,record_count) VALUES(?,?,?,?,?,128,1,1)').bind(verificationId, previousGeneration, 'private-root', 'a'.repeat(64), '{"private":"manifest"}'),
        app.db.prepare('INSERT INTO archive_semantic_parts(verification_id,generation,archive_id,part_index,descriptor_json,descriptor_sha256,rowset_sha256,commit_token) VALUES(?,?,?,0,?,?,?,?)').bind(verificationId, previousGeneration, 'private-root', '{"index":0}', 'b'.repeat(64), 'c'.repeat(64), `part-${status}`),
        app.db.prepare("INSERT INTO archive_semantic_rows(verification_id,generation,archive_id,table_name,record_key,part_index,part_commit_token,record_json) VALUES(?,?,?,'students',?,0,?,?)").bind(verificationId, previousGeneration, 'private-root', student.student.id, `part-${status}`, JSON.stringify({ id: student.student.id, center_id: 'test-center', first_name: 'Synthetic', last_name: 'Private staged evidence' })),
      ]);
      if (status === 'frozen' || status === 'verified') await app.db.prepare("UPDATE archive_semantic_sessions SET status='frozen',commit_token=?,graph_sha256=? WHERE verification_id=? AND generation=?").bind(`session-${status}`, 'd'.repeat(64), verificationId, previousGeneration).run();
      if (status === 'verified') await app.db.prepare("UPDATE archive_semantic_sessions SET status='verified' WHERE verification_id=? AND generation=?").bind(verificationId, previousGeneration).run();
      if (status === 'invalid') await app.db.prepare("UPDATE archive_semantic_sessions SET status='invalid' WHERE verification_id=? AND generation=?").bind(verificationId, previousGeneration).run();
    }
    // Synthetic saved capability, inserted under the original schema 19 guards.
    // The current adapter is used only after actual migrations 20 through 22.
    const cleanupHandle = { verificationId: 'restore-invalid', generation: previousGeneration!, cleanupGeneration: previousGeneration!, cleanupToken: crypto.randomUUID() };
    await app.db.prepare("UPDATE archive_semantic_sessions SET cleanup_generation=?,cleanup_token=? WHERE verification_id='restore-invalid'").bind(cleanupHandle.cleanupGeneration, cleanupHandle.cleanupToken).run();
    await applyAdmissionAndLifecycleMigrations(app);
    const staged = new Map<string, Record<string, unknown>[]>();
    for (const table of stagingTables) {
      expect(BACKUP_TABLES, table).toContain(table);
      staged.set(table, (await app.db.prepare(`SELECT * FROM ${table}`).all()).results);
    }
    const data = await snapshot(app);
    const restored = await createRuntime({ bindings: {}, migrate: false }); runtimes.push(restored);
    await restored.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(new TextDecoder().decode(data.sql))].map(sql => restored.db.prepare(sql)));
    for (const table of [...authorityTables, ...stagingTables, 'history_runtime', 'history_backfill_jobs']) {
      expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(data.counts[table]);
    }
    for (const table of stagingTables) expect((await restored.db.prepare(`SELECT * FROM ${table}`).all()).results, table).toEqual(staged.get(table));
    for (const table of stagingTables) expect((await restored.db.prepare(`SELECT * FROM ${table}`).all()).results, table).toEqual(staged.get(table));
    const restoredHandles = await Promise.all(['staging', 'frozen', 'verified'].map(status => D1ArchiveSemanticStaging.resume(restored.db, stagingKey, { verificationId: `restore-${status}`, generation: previousGeneration! })));
    for (const handle of restoredHandles) await expect(handle.freeze()).rejects.toThrow('ARCHIVE_STAGING_ADMISSION_LIMIT');
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    const verifyReset = async (staleGeneration: string) => {
      await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
      const runtime = await restored.db.prepare('SELECT generation,state FROM history_runtime WHERE id=1').first<{ generation: string; state: string }>();
      expect(runtime?.state).toBe('backfilling');
      expect(runtime?.generation).toMatch(/^[a-f0-9]{32}$/);
      expect(runtime?.generation).not.toBe(staleGeneration);
      const jobs = (await restored.db.prepare('SELECT source,generation,cursor,processed,status FROM history_backfill_jobs ORDER BY source').all()).results;
      expect(jobs).toEqual(['audits', 'corrections', 'events', 'visits'].map(source => ({ source, generation: runtime!.generation, cursor: null, processed: 0, status: 'pending' })));
      for (const table of authorityTables) {
        const rows = (await restored.db.prepare(`SELECT * FROM ${table}`).all()).results;
        // Recovery adds its own audit identity; all accepted rows survive.
        expect(rows, table).toEqual(expect.arrayContaining(original.get(table)!));
        if (table !== 'history_request_keys') expect(rows).toHaveLength(original.get(table)!.length);
      }
      expect((await restored.db.prepare('SELECT * FROM archive_semantic_sessions').all()).results).toEqual(staged.get('archive_semantic_sessions')!.map(row => ({ ...row, status: 'invalid', commit_token: null, graph_sha256: null, cleanup_generation: null, cleanup_token: null })));
      for (const table of privateTables) expect((await restored.db.prepare(`SELECT * FROM ${table}`).all()).results, table).toEqual(staged.get(table));
      for (const handle of restoredHandles) {
        await expect(D1ArchiveSemanticStaging.resume(restored.db, stagingKey, handle.handle)).rejects.toThrow('ARCHIVE_STAGING_STALE');
        await expect(handle.freeze()).rejects.toThrow('ARCHIVE_STAGING_STALE');
      }
      await expect(D1ArchiveSemanticStaging.cleanupPage(restored.db, cleanupHandle)).rejects.toThrow('ARCHIVE_STAGING_CLEANUP_STALE');
      // Restored private checkpoints cannot be retagged, extended, or promoted.
      await expect(restored.db.prepare("UPDATE archive_semantic_sessions SET generation=? WHERE verification_id='restore-verified'").bind(runtime!.generation).run()).rejects.toThrow('ARCHIVE_STAGING_TRANSITION_INVALID');
      await expect(restored.db.prepare("UPDATE archive_semantic_sessions SET status='verified',commit_token='restored-success',graph_sha256=? WHERE verification_id='restore-verified'").bind('d'.repeat(64)).run()).rejects.toThrow(/ARCHIVE_STAGING_(?:ADMISSION_LIMIT|TRANSITION_INVALID)/);
      await expect(restored.db.prepare("INSERT INTO archive_semantic_parts(verification_id,generation,archive_id,part_index,descriptor_json,descriptor_sha256,rowset_sha256,commit_token) VALUES('restore-staging',?,'private-root',1,'{}',?,?,?)").bind(previousGeneration, 'b'.repeat(64), 'c'.repeat(64), 'stale-part').run()).rejects.toThrow(/ARCHIVE_STAGING_(?:ADMISSION_LIMIT|STALE)/);
      expect(await restored.db.prepare('SELECT count(*) AS n FROM archive_jobs').first('n')).toBe(0);
      const stale = await restored.db.prepare("UPDATE history_backfill_jobs SET cursor='stale-page',processed=processed+1 WHERE generation=? AND source='events'").bind(staleGeneration).run();
      expect(stale.meta.changes).toBe(0);
      expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      return runtime!.generation;
    };
    const generation = await verifyReset(previousGeneration!);
    await verifyReset(generation);
  });


  it('preserves attendance but invalidates old staff JWTs, kiosk credentials, integrations, and import previews', async () => {
    const app = await startApp(); runtimes.push(app); const student = await createStudent(app); const pin = '48271639';
    const { staff } = await json<{ staff: { id: string } }>(await app.request('/api/admin/staff', { token: app.token, body: { email: 'recovery-operator@example.test', displayName: 'Recovery Test Operator', role: 'front_desk', kioskEnabled: true, pin } }), 201);
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201); const jar = new CookieJar(); const { device } = await json<{ device: { id: string } }>(await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Restored old device' } }), 201);
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: staff.id, pin } })); await json(await jar.request(app, '/api/kiosk/attendance', { body: observation(student.student.id, 'check_in') }), 201);
    const correctedStudent = await createStudent(app, { studentCode: `REC-${crypto.randomUUID().slice(0, 8)}` });
    const originalObservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const effectiveObservedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const unmatchedInput = observation(correctedStudent.student.id, 'exceptional_departure', {
      observedAt: originalObservedAt,
      reason: 'Departure was observed without a matching arrival.',
    });
    const originalReceipt = await json<AttendanceResult>(await app.request('/api/admin/attendance', {
      token: app.token,
      body: unmatchedInput,
    }), 201);
    expect(originalReceipt.visit).toBeNull();
    const correctionId = crypto.randomUUID();
    const acceptedCorrection = await json<ObservationCorrectionResult>(await app.request(
      `/api/admin/attendance/events/${originalReceipt.event.id}/corrections`,
      {
        token: app.token,
        body: {
          correctionId,
          expectedVersion: 1,
          effectiveObservedAt,
          reason: 'Recovered the signed departure time from the front-desk record.',
        },
      },
    ), 201);
    const correctionEvidence = {
      event: await app.db.prepare('SELECT * FROM attendance_events WHERE id=?').bind(originalReceipt.event.id).first(),
      projection: await app.db.prepare('SELECT * FROM observation_effective_times WHERE event_id=?').bind(originalReceipt.event.id).first(),
      correction: await app.db.prepare('SELECT * FROM observation_corrections WHERE id=?').bind(correctionId).first(),
      request: await app.db.prepare('SELECT * FROM observation_correction_request_keys WHERE request_id=?').bind(correctionId).first(),
    };
    const unused = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201);
    const timestamp = new Date().toISOString(); const future = new Date(Date.now() + 3600000).toISOString(); const importId = crypto.randomUUID(); const failedJob = crypto.randomUUID(); const pendingJob = crypto.randomUUID(); const previousRevocation = '2026-01-01T00:00:00.000Z';
    const oldDevice = crypto.randomUUID(); const oldEnrollment = crypto.randomUUID();
    await app.db.batch([
      app.db.prepare('INSERT INTO device_enrollments(id,center_id,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(oldEnrollment, 'test-center', crypto.randomUUID(), future, app.actor.id, timestamp),
      app.db.prepare('INSERT INTO kiosk_devices(id,center_id,enrollment_id,token_hash,label,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)').bind(oldDevice, 'test-center', oldEnrollment, crypto.randomUUID(), 'Previously revoked device', timestamp, future, previousRevocation),
      app.db.prepare('INSERT INTO backup_google(id,sealed_tokens,folder_id,connected_by,connected_at) VALUES(1,?,?,?,?)').bind('synthetic-sealed-old-credentials', 'old-drive-folder', app.actor.id, timestamp),
      app.db.prepare('INSERT INTO backup_oauth(state_hash,staff_id,sealed_verifier,expires_at) VALUES(?,?,?,?)').bind('old-oauth-state', app.actor.id, 'synthetic-old-verifier', future),
      ...[failedJob, pendingJob].map((jobId, index) => app.db.prepare('INSERT INTO backup_jobs(id,created_at,updated_at,status,signed_url,lease_until,lease_token,counts_json,schema_json) VALUES(?,?,?,?,?,?,?,?,?)').bind(jobId, timestamp, timestamp, index === 0 ? 'failed' : 'parts', 'https://stale-export.example.invalid/snapshot.sql', future, 'stale-lease', '{}', '[1,2,3,4]')),
      app.db.prepare("INSERT INTO roster_imports(id,center_id,source_hash,mapping_hash,preview_token,created_by,created_at,expires_at,status,total_rows,mapping_json) VALUES(?,?,?,?,?,?,?,?,'preview',1,'{}')").bind(importId, 'test-center', 'local-source', 'local-mapping', 'stale-preview-token', app.actor.id, timestamp, future),
      app.db.prepare("INSERT INTO roster_import_rows(import_id,row_number,action,status,payload_json) VALUES(?,1,'create','pending',?)").bind(importId, JSON.stringify({ studentCode: 'Stale student payload' })),
      app.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1').bind(future, pendingJob),
    ]);
    await app.db.prepare("UPDATE backup_runtime SET write_locked_until=NULL,lock_job_id=NULL WHERE id=1").run();
    await app.db.prepare("INSERT INTO archive_jobs(id,center_id,month,timezone,period_from,period_to,cutoff,created_at,updated_at,created_by,schema_json,application_version,status,source_expires_at,lease_token,lease_until) VALUES('pending-archive','test-center','2025-01','America/Los_Angeles','2025-01-01T08:00:00.000Z','2025-02-01T08:00:00.000Z',?,?,?,?,'[1,8]','test','parts',?,'restored-lease',?)").bind(timestamp,timestamp,timestamp,app.actor.id,future,future).run();
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1').bind(future,pendingJob).run();
    const data = await snapshot(app); const directory = await temporary(); const source = await bundle(directory, [data.sql], { recordCounts: data.counts, schemaVersions: data.versions }); const output = join(directory, 'restore.sql');
    const result = await cli(['verify-decrypt', source.root, output], source.keyPath).result; expect(result.code, result.stderr).toBe(0);
    const restored = await createRuntime({ signer: app.signer, migrate: false, bindings: { APP_ENV: 'production', CENTER_ID: 'test-center', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test' } }); runtimes.push(restored);
    const statements = ['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(await readFile(output, 'utf8'))]; await restored.db.batch(statements.map(sql => restored.db.prepare(sql)));
    for (const table of BACKUP_TABLES) expect(await restored.db.prepare(`SELECT count(*) AS n FROM "${table}"`).first('n'), table).toBe(data.counts[table]);
    const verifyCorrectionEvidence = async () => {
      expect(await restored.db.prepare('SELECT * FROM attendance_events WHERE id=?')
        .bind(originalReceipt.event.id).first()).toEqual(correctionEvidence.event);
      expect(await restored.db.prepare('SELECT * FROM observation_effective_times WHERE event_id=?')
        .bind(originalReceipt.event.id).first()).toEqual(correctionEvidence.projection);
      expect(await restored.db.prepare('SELECT * FROM observation_corrections WHERE id=?')
        .bind(correctionId).first()).toEqual(correctionEvidence.correction);
      expect(await restored.db.prepare('SELECT * FROM observation_correction_request_keys WHERE request_id=?')
        .bind(correctionId).first()).toEqual(correctionEvidence.request);
      expect(await restored.db.prepare('SELECT effective_observed_at FROM observation_effective_times WHERE event_id=?')
        .bind(originalReceipt.event.id).first('effective_observed_at')).toBe(effectiveObservedAt);
    };
    await verifyCorrectionEvidence();
    expect((await restored.request('/api/admin/session', { token: app.token })).status).toBe(200);
    const restoredReceipt = await json<AttendanceResult>(await restored.request(
      `/api/admin/attendance/events/${originalReceipt.event.id}`,
      { token: app.token },
    ));
    expect(restoredReceipt.event).toEqual(originalReceipt.event);
    expect(restoredReceipt.visit).toBeNull();
    const restoredCorrection = await json<ObservationCorrectionResult>(await restored.request(
      `/api/admin/attendance/events/${originalReceipt.event.id}/corrections/${correctionId}`,
      { token: app.token },
    ));
    expect(restoredCorrection.correction).toEqual(acceptedCorrection.correction);
    expect((await jar.request(restored, '/api/kiosk/roster')).status).toBe(200);
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8')); await restored.db.batch(reset.map(sql => restored.db.prepare(sql))); await verifyCorrectionEvidence();
    expect((await restored.request('/api/admin/session', { token: app.token })).status).toBe(403); expect((await restored.request('/api/admin/session', { token: await app.signer.token({ email: 'recovery-operator@example.test' }) })).status).toBe(403);
    expect((await jar.request(restored, '/api/kiosk/roster')).status).toBe(401); expect((await jar.request(restored, '/api/kiosk/unlock', { body: { staffId: staff.id, pin } })).status).toBe(401); expect((await restored.request('/api/kiosk/enroll', { body: { token: unused.token, label: 'Old unused enrollment' } })).status).toBe(401);
    expect(await restored.db.prepare('SELECT count(*) AS n FROM kiosk_sessions').first('n')).toBe(0); expect(await restored.db.prepare('SELECT count(*) AS n FROM staff WHERE kiosk_enabled=1 OR pin_hash IS NOT NULL OR pin_salt IS NOT NULL').first('n')).toBe(0);
    expect(await restored.db.prepare('SELECT revoked_at FROM kiosk_devices WHERE id=?').bind(oldDevice).first('revoked_at')).toBe(previousRevocation); expect(await restored.db.prepare('SELECT revoked_at FROM kiosk_devices WHERE id=?').bind(device.id).first('revoked_at')).toBeTruthy();
    expect(await restored.db.prepare('SELECT count(*) AS n FROM backup_google').first('n')).toBe(0); expect(await restored.db.prepare('SELECT count(*) AS n FROM backup_oauth').first('n')).toBe(0); expect(await restored.db.prepare('SELECT count(*) AS n FROM backup_jobs WHERE signed_url IS NOT NULL OR lease_until IS NOT NULL OR lease_token IS NOT NULL').first('n')).toBe(0);
    expect(await restored.db.prepare("SELECT status FROM archive_jobs WHERE id='pending-archive'").first('status')).toBe('cancelled');
    expect(await restored.db.prepare("SELECT lease_token FROM archive_jobs WHERE id='pending-archive'").first('lease_token')).toBeNull();
    expect(await restored.db.prepare('SELECT status FROM backup_jobs WHERE id=?').bind(pendingJob).first('status')).toBe('failed'); expect(await restored.db.prepare('SELECT status FROM roster_imports WHERE id=?').bind(importId).first('status')).toBe('expired'); expect(await restored.db.prepare('SELECT payload_json FROM roster_import_rows WHERE import_id=?').bind(importId).first('payload_json')).toBeNull();
    expect(await restored.db.prepare("SELECT count(*) AS n FROM staff WHERE role='owner' AND active=1").first('n')).toBeGreaterThan(0); expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(2); await expect(restored.db.prepare('DELETE FROM attendance_events').run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
    expect(await restored.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE action='recovery_access_reset'").first('n')).toBe(1);
    await restored.db.batch(reset.map(sql => restored.db.prepare(sql))); await verifyCorrectionEvidence(); expect((await restored.request('/api/admin/session', { token: app.token })).status).toBe(403); expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(2);
  });
});
