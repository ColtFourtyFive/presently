import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { unstable_splitSqlQuery } from 'wrangler';
import { startMonthlyPublication, advanceMonthlyPublication } from '../worker/archive-publication';
import { BACKUP_TABLES, startBackup } from '../worker/backup';
import type { Env } from '../worker/types';
import { digest, newHeader, sealPart, type BackupManifest } from '../worker/backup-crypto';
import { createArchive } from '../worker/archive-codec';
import type { ArchiveReference } from '../shared/archive-format';
import { openBudgetFixture, budgetReservation } from './archive-budget-fixture';
import { reserveArchiveBudgetAttempt } from '../worker/archive-budget-ledger';
import { createPublicationFixture, createPublicationSeed, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSeed } from './archive-publication-fixture';
import { json } from './helpers';
import { projectRoot, testAudience, testIssuer, type TestRuntime } from './runtime';

let seed: PublicationSeed;
const runtimes: TestRuntime[] = [];
const directories: string[] = [];
beforeAll(async () => { seed = await createPublicationSeed(); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map(app => app.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
type Fixture = Awaited<ReturnType<typeof createPublicationFixture>>;
async function fixture() { const value = await createPublicationFixture(seed); runtimes.push(value.app); return value; }
async function publish(value: Fixture) {
  const handle = await startMonthlyPublication(value.app.db, value.handle);
  for (let step = 0; step < 500; step++) {
    const row = await value.app.db.prepare('SELECT state,revision FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<{ state: string; revision: number }>();
    if (row?.state === 'published') return handle;
    const result = await advanceMonthlyPublication(value.app.db, { bucket: value.bucket, masterKey: value.key }, handle, { expectedRevision: row!.revision });
    if (result.state === 'invalid') throw new Error('Fixture publication became invalid');
  }
  throw new Error('Fixture publication did not finish');
}
async function backup(app: TestRuntime, token: string) {
  const response = await app.request('/api/admin/backups/start', { token, body: {} });
  const measured = JSON.parse(response.headers.get('x-isolated-d1-metrics')!) as { statements: number; unmeasuredCalls: number };
  const { jobId } = await json<{ jobId: string }>(response, 202);
  const job = await app.db.prepare('SELECT * FROM backup_jobs WHERE id=?').bind(jobId).first<{ id: string; counts_json: string; schema_json: string; archives_json: string; created_at: string }>();
  return { job: job!, measured, counts: JSON.parse(job!.counts_json) as Record<string, number>, references: JSON.parse(job!.archives_json) as ArchiveReference[] };
}
async function reset(app: TestRuntime) {
  const sql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
  await app.db.batch(sql.map(statement => app.db.prepare(statement)));
}
async function rows(app: TestRuntime, tables: readonly string[]) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await app.db.prepare(`SELECT * FROM ${table}`).all()).results.map(row => JSON.stringify(row)).sort()])));
}
const publicationEvidence = ['archive_publication_parts', 'archive_publication_records', 'archive_publication_requests', 'archive_publications'];
const chargedEvidence = ['archive_budget_days', 'archive_budget_pools', 'archive_budget_attempts', 'archive_budget_receipts', 'archive_budget_controls'];
async function catalogLegacy(value: Fixture, reference: ArchiveReference, manifest: unknown, month = '2024-01') {
  const at = new Date().toISOString();
  await value.app.db.prepare(`INSERT INTO archive_jobs(id,center_id,month,timezone,period_from,period_to,cutoff,created_at,updated_at,created_by,schema_json,application_version,status,source_expires_at,manifest_key,manifest_sha256,manifest_json,completed_at) VALUES(?,? ,?,'America/Los_Angeles','2024-01-01','2024-02-01','2024-04-01',?,?,?,'[1,8]','test','complete',?,?,?,?,?)`).bind(reference.archiveId, 'test-center', month, at, at, value.app.actor.id, at, reference.manifestObjectKey, reference.manifestSha256, JSON.stringify(manifest), at).run();
}
function cli(args: string[], keyPath: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/recovery.ts'), ...args], { cwd: projectRoot, env: { KUMON_RECOVERY_KEY_FILE: keyPath, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
}

describe('publication backup and recovery', () => {
  it('keeps authentic operational receipts alongside completed detached semantic evidence', async () => {
    const fixture = await createPublicationFixture(seed); runtimes.push(fixture.app);
    expect(await fixture.app.db.prepare('SELECT state FROM history_runtime WHERE id=1').first('state')).toBe('ready');
    expect(await fixture.app.db.prepare('SELECT status FROM archive_semantic_runs WHERE run_id=?').bind(fixture.handle.runId).first('status')).toBe('complete');
    expect(await fixture.app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(fixture.handle.verificationId).first('status')).toBe('verified');
    for (const record of fixture.records.filter(record => ['attendance_events', 'attendance_corrections'].includes(record.table))) {
      expect(await fixture.app.db.prepare(`SELECT * FROM ${record.table} WHERE id=?`).bind(record.key).first()).toMatchObject(record.row);
    }
    await expect(fixture.app.db.prepare('DELETE FROM attendance_events').run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
    expect((await fixture.app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('restores source-absent fixtures with original guards and retained audit evidence', async () => {
    const fixture = await createPublicationFixture(seed); runtimes.push(fixture.app);
    const audits = (await fixture.app.db.prepare('SELECT * FROM audit_entries ORDER BY id').all()).results;
    const sql = await snapshotPublicationDatabase(fixture.app, { omitTables: ['attendance_events', 'attendance_corrections', 'reviews'] });
    const restored = await restorePublicationDatabase(sql); runtimes.push(restored);
    expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
    expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_corrections').first('n')).toBe(0);
    expect((await restored.db.prepare('SELECT * FROM audit_entries ORDER BY id').all()).results).toEqual(audits);
    expect(await restored.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE '%attendance%'").first<number>('n')).toBeGreaterThan(0);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('pins committed v2 and legacy roots, including unavailable publications, with bounded native backup statements', async () => {
    const value = await fixture(); const handle = await publish(value);
    const { semanticProof: _proof, ...legacyMetadata } = seed.metadata;
    const legacy = await createArchive(value.key, { ...legacyMetadata, archiveId: crypto.randomUUID(), schemaVersions: [1, 8], month: '2024-01' }, [{ table: 'centers', key: 'test-center', row: { id: 'test-center', name: 'Synthetic Center', timezone: 'America/Los_Angeles' } }], async () => {});
    expect(legacy.manifest.format).toBe('kumon-history-archive-v1'); expect(value.archive.manifest.format).toBe('kumon-history-archive-v2');
    const legacyReference: ArchiveReference = { archiveId: legacy.manifest.archiveId, kind: 'monthly', manifestObjectKey: legacy.objectKey, manifestSha256: legacy.sha256 };
    await catalogLegacy(value, legacyReference, legacy.manifest);
    await value.app.db.prepare("UPDATE archive_publication_availability SET status='unavailable' WHERE publication_id=?").bind(handle.publicationId).run();
    const saved = await backup(value.app, value.app.token);
    expect(saved.references).toEqual(expect.arrayContaining([value.reference, legacyReference])); expect(saved.references).toHaveLength(2);
    expect(Object.keys(saved.counts).sort()).toEqual([...BACKUP_TABLES].sort()); expect(Object.keys(saved.counts)).toHaveLength(96);
    expect(saved.counts.archive_publications).toBe(1); expect(saved.counts.archive_publication_requests).toBeGreaterThan(0);
    expect(Math.max(...JSON.parse(saved.job.schema_json))).toBe(42);
    expect(saved.measured.unmeasuredCalls).toBe(0); expect(saved.measured.statements).toBeLessThanOrEqual(40);
    for (const table of BACKUP_TABLES) expect(await value.app.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(saved.counts[table]);
  });

  it('deduplicates the same immutable root appearing in both backup catalogs', async () => {
    const value = await fixture(); await publish(value);
    await catalogLegacy(value, value.reference, value.archive.manifest);
    expect((await backup(value.app, value.app.token)).references).toEqual([value.reference]);
  });

  it.each(['manifestSha256', 'manifestObjectKey', 'kind'] as const)('rejects conflicting %s for one archive identity and releases the snapshot lock', async field => {
    const value = await fixture(); await publish(value);
    const altered = { ...value.reference, [field]: field === 'manifestSha256' ? 'a'.repeat(64) : field === 'kind' ? 'addendum' : value.reference.manifestObjectKey.replace('/test-center/', '/other-center/') } as ArchiveReference;
    if (field === 'manifestSha256') altered.manifestObjectKey = altered.manifestObjectKey.replace(value.reference.manifestSha256, altered.manifestSha256);
    await catalogLegacy(value, altered, { ...value.archive.manifest, kind: altered.kind });
    const response = await value.app.request('/api/admin/backups/start', { token: value.app.token, body: {} });
    expect(response.status).toBe(500);
    await expect(startBackup(await value.app.runtime.getBindings<Env>())).rejects.toThrow('BACKUP_ARCHIVE_IDENTITY_CONFLICT');
    expect(await value.app.db.prepare('SELECT count(*) AS n FROM backup_jobs').first('n')).toBe(0);
    expect(await value.app.db.prepare('SELECT write_locked_until,lock_job_id FROM backup_runtime WHERE id=1').first()).toEqual({ write_locked_until: null, lock_job_id: null });
  });

  it('invalidates unfinished leased publication work without discarding its proof or accounting evidence', async () => {
    const value = await fixture(); const handle = await startMonthlyPublication(value.app.db, value.handle);
    await advanceMonthlyPublication(value.app.db, { bucket: value.bucket, masterKey: value.key }, handle, { expectedRevision: 0 });
    await value.app.db.prepare("UPDATE archive_publication_builds SET revision=revision+1,lease_token='restore-test-lease',lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE publication_id=?").bind(handle.publicationId).run();
    const budget = await openBudgetFixture(value.app); await reserveArchiveBudgetAttempt(value.app.db, budgetReservation(budget.identity));
    const prior = await value.app.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<Record<string, unknown>>();
    const evidence = await rows(value.app, [...publicationEvidence, ...chargedEvidence]);
    await reset(value.app);
    const next = await value.app.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<Record<string, unknown>>();
    expect(next).toMatchObject({ ...prior, state: 'invalid', lease_token: null, lease_expires_at: null, revision: Number(prior!.revision) + 1, updated_at: next!.updated_at });
    expect(await rows(value.app, [...publicationEvidence, ...chargedEvidence])).toEqual(evidence);
    await reset(value.app); expect(await rows(value.app, [...publicationEvidence, ...chargedEvidence])).toEqual(evidence);
    expect(await value.app.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first()).toEqual(next);
  });

  it('preserves committed descriptors, locators, request claims and charges across repeated access resets', async () => {
    const value = await fixture(); const handle = await publish(value);
    const budget = await openBudgetFixture(value.app); await reserveArchiveBudgetAttempt(value.app.db, budgetReservation(budget.identity));
    const tables = ['archive_publication_builds', ...publicationEvidence, ...chargedEvidence]; const evidence = await rows(value.app, tables);
    for (let attempt = 0; attempt < 2; attempt++) {
      await reset(value.app); expect(await rows(value.app, tables)).toEqual(evidence);
      expect(await value.app.db.prepare('SELECT * FROM archive_publication_availability WHERE publication_id=?').bind(handle.publicationId).first()).toEqual({ publication_id: handle.publicationId, generation: handle.generation, status: 'unavailable', reconciliation_id: null });
      expect(await value.app.db.prepare('SELECT status FROM archive_semantic_runs WHERE run_id=?').bind(value.handle.runId).first('status')).toBe('invalid');
      expect((await value.app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    }
  });

  it('independently decrypts an actual captured backup inventory plus the v2 graph and restores published evidence without operational source rows', async () => {
    const value = await fixture(); const handle = await publish(value);
    const budget = await openBudgetFixture(value.app); await reserveArchiveBudgetAttempt(value.app.db, budgetReservation(budget.identity));
    const omitted = ['attendance_events', 'attendance_corrections', 'reviews'];
    const absentSql = await snapshotPublicationDatabase(value.app, { omitTables: omitted });
    const source = await restorePublicationDatabase(absentSql, { metrics: true, bindings: { APP_ENV: 'local', CENTER_ID: 'test-center', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BACKUP_KEY: value.key, CF_ACCOUNT_ID: 'isolated-publication-account', CF_DATABASE_ID: 'isolated-publication-database', CF_EXPORT_API_TOKEN: 'isolated-no-network-token' } }); runtimes.push(source);
    const captured = await backup(source, await source.signer.token());
    expect(captured.references).toEqual([value.reference]);
    for (const table of omitted) expect(captured.counts[table], table).toBe(0);
    const before = await rows(source, ['archive_publication_builds', ...publicationEvidence, ...chargedEvidence]);
    const sql = new TextEncoder().encode(await snapshotPublicationDatabase(source));
    const directory = await mkdtemp(join(tmpdir(), 'kumon-publication-recovery-')); directories.push(directory);
    const encryptedRoot = join(directory, 'downloaded'); await mkdir(encryptedRoot);
    const keyPath = join(directory, 'key'); await writeFile(keyPath, value.key + '\n', { mode: 0o600 });
    const encrypted = await sealPart(value.key, sql, newHeader(captured.job.id, 0));
    const manifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId: captured.job.id, applicationVersion: 'local-publication-recovery', createdAt: captured.job.created_at, schemaVersions: JSON.parse(captured.job.schema_json), snapshotBookmark: 'LOCAL_FIXTURE_NO_PROVIDER_EXPORT', recordCounts: captured.counts, archiveReferences: captured.references, sqlBytes: sql.length, parts: [{ index: 0, fileName: 'part-00000.kcrm', plaintextBytes: sql.length, plaintextSha256: await digest(sql), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) }] };
    await writeFile(join(encryptedRoot, 'part-00000.kcrm'), encrypted);
    await writeFile(join(encryptedRoot, 'manifest.kcrm'), await sealPart(value.key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(captured.job.id, -1)));
    for (const [objectKey, bytes] of value.objects) { const path = join(encryptedRoot, objectKey); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
    // Close every source runtime before the independent process receives only
    // downloaded encrypted files and its key; no D1 or Worker state is available.
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
    const output = join(directory, 'restored.sql'); const result = await cli(['verify-decrypt', encryptedRoot, output], keyPath);
    expect(result.code, result.stderr).toBe(0);
    const verified = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as BackupManifest;
    expect(verified.recordCounts).toEqual(captured.counts); expect(verified.archiveReferences).toEqual(captured.references);
    expect((await readdir(directory)).filter(name => name.includes('.recovery-') || name.includes('.semantic-'))).toEqual([]);
    const restored = await restorePublicationDatabase(await readFile(output, 'utf8')); runtimes.push(restored);
    for (const table of BACKUP_TABLES) expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(captured.counts[table]);
    expect(await rows(restored, ['archive_publication_builds', ...publicationEvidence, ...chargedEvidence])).toEqual(before);
    for (let attempt = 0; attempt < 2; attempt++) {
      await reset(restored);
      expect(await rows(restored, ['archive_publication_builds', ...publicationEvidence, ...chargedEvidence])).toEqual(before);
      expect(await restored.db.prepare('SELECT generation,status FROM archive_publication_availability WHERE publication_id=?').bind(handle.publicationId).first()).toEqual({ generation: handle.generation, status: 'unavailable' });
      expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    }
  });
});
