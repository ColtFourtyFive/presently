import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { unstable_splitSqlQuery } from 'wrangler';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { advancePublicationReconciliation, startPublicationReconciliation } from '../worker/archive-publication-reconciliation';
import { openArchiveManifest } from '../worker/archive-codec';
import { resolveHistoryRequest } from '../worker/history-request';
import { BACKUP_TABLES, startBackup } from '../worker/backup';
import { digest, newHeader, sealPart, type BackupManifest } from '../worker/backup-crypto';
import type { ArchiveReference } from '../shared/archive-format';
import type { Env } from '../worker/types';
import { createPublicationFixture, createPublicationSeed, refreshPublicationProof, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSeed } from './archive-publication-fixture';
import { projectRoot, type TestRuntime } from './runtime';

type Fixture = Awaited<ReturnType<typeof createPublicationFixture>>;
let seed: PublicationSeed;
const runtimes: TestRuntime[] = [];
const directories: string[] = [];
beforeAll(async () => { seed = await createPublicationSeed(); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map(app => app.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
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
async function reset(app: TestRuntime) {
  const sql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
  await app.db.batch(sql.map(statement => app.db.prepare(statement)));
}
const publicationTables = ['archive_publication_builds', 'archive_publication_parts', 'archive_publication_records', 'archive_publication_requests', 'archive_publications'];
const reconciliationTables = ['archive_publication_reconciliation_jobs', 'archive_publication_reconciliation_receipts'];
async function rows(app: TestRuntime, tables: readonly string[]) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await app.db.prepare(`SELECT * FROM ${table}`).all()).results.map(row => JSON.stringify(row)).sort()])));
}
async function captureBackup(app: TestRuntime, key: string) {
  const env = await app.runtime.getBindings<Env>(), batches: number[] = []; let statements = 0;
  const db = new Proxy(env.CRM_DB, { get(target, property) {
    if (property === 'prepare') return (sql: string) => { statements++; return target.prepare(sql); };
    if (property === 'batch') return (input: Parameters<Env['CRM_DB']['batch']>[0]) => { batches.push(input.length); return target.batch(input); };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const jobId = await startBackup({ ...env, CRM_DB: db, BACKUP_KEY: key, CF_ACCOUNT_ID: 'isolated-backup-account', CF_DATABASE_ID: 'isolated-backup-database', CF_EXPORT_API_TOKEN: 'isolated-no-network-token' });
  const job = await app.db.prepare('SELECT * FROM backup_jobs WHERE id=?').bind(jobId).first<{ id: string; created_at: string; counts_json: string; schema_json: string; archives_json: string }>();
  return { job: job!, batches, statements, counts: JSON.parse(job!.counts_json) as Record<string, number>, references: JSON.parse(job!.archives_json) as ArchiveReference[] };
}
function cli(args: string[], keyPath: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/recovery.ts'), ...args], { cwd: projectRoot, env: { KUMON_RECOVERY_KEY_FILE: keyPath, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
}
async function encryptedBundle(app: TestRuntime, evidence: Fixture) {
  const captured = await captureBackup(app, evidence.key);
  const sql = new TextEncoder().encode(await snapshotPublicationDatabase(app));
  const directory = await mkdtemp(join(tmpdir(), 'kumon-reconciliation-recovery-')); directories.push(directory);
  const root = join(directory, 'downloaded'); await mkdir(root);
  const keyPath = join(directory, 'key'); await writeFile(keyPath, evidence.key + '\n', { mode: 0o600 });
  const parts: BackupManifest['parts'] = [];
  for (let offset = 0, index = 0; offset < sql.length; offset += 1024 * 1024, index++) {
    const bytes = sql.slice(offset, offset + 1024 * 1024), encrypted = await sealPart(evidence.key, bytes, newHeader(captured.job.id, index));
    const fileName = `part-${String(index).padStart(5, '0')}.kcrm`; await writeFile(join(root, fileName), encrypted);
    parts.push({ index, fileName, plaintextBytes: bytes.length, plaintextSha256: await digest(bytes), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) });
  }
  const manifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId: captured.job.id, applicationVersion: 'local-reconciliation-recovery', createdAt: captured.job.created_at, schemaVersions: JSON.parse(captured.job.schema_json), snapshotBookmark: 'LOCAL_FIXTURE_NO_PROVIDER_EXPORT', recordCounts: captured.counts, archiveReferences: captured.references, sqlBytes: sql.length, parts };
  await writeFile(join(root, 'manifest.kcrm'), await sealPart(evidence.key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(captured.job.id, -1)));
  for (const [objectKey, bytes] of evidence.objects) { const path = join(root, objectKey); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  return { captured, directory, root, keyPath, manifest };
}
async function reconcile(app: TestRuntime, publicationId: string, fresh: Awaited<ReturnType<typeof refreshPublicationProof>>, key: string) {
  const handle = await startPublicationReconciliation(app.db, publicationId, fresh.handle), bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  for (let step = 0; step < 500; step++) {
    const row = await app.db.prepare('SELECT state,revision FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).first<{ state: string; revision: number }>();
    if (row?.state === 'complete') return handle;
    if (!row || row.state === 'invalid') throw new Error('Fixture reconciliation stopped');
    await advancePublicationReconciliation(app.db, { bucket, masterKey: key }, handle, { expectedRevision: row.revision });
  }
  throw new Error('Fixture reconciliation did not finish');
}
async function restoredFixture(value: Fixture) {
  const app = await restorePublicationDatabase(await snapshotPublicationDatabase(value.app, { omitTables: ['attendance_events', 'attendance_corrections', 'reviews'] })); runtimes.push(app);
  const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  for (const [key, bytes] of value.objects) await bucket.put(key, bytes);
  await reset(app); const fresh = await refreshPublicationProof(app, value);
  return { app, bucket, fresh };
}
async function assertOriginalReceipts(app: TestRuntime, value: Fixture) {
  const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  const records = value.records.filter(record => record.table === 'attendance_events' || record.table === 'attendance_corrections');
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    const actual = await resolveHistoryRequest(app.db, { id: record.key, centerId: String(record.row.center_id), kind: record.table === 'attendance_events' ? 'event' : 'correction', payloadHash: String(record.row.payload_hash) }, { bucket, masterKey: value.key });
    expect(actual).toEqual(record.row);
  }
}

describe('archive availability reconciliation recovery', () => {
  it('creates fresh current-generation semantic proof from the original graph with live receipt rows absent', async () => {
    const value = await fixture(); const publication = await publish(value);
    const restored = await restorePublicationDatabase(await snapshotPublicationDatabase(value.app, { omitTables: ['attendance_events', 'attendance_corrections', 'reviews'] })); runtimes.push(restored);
    const original = await rows(restored, publicationTables);
    await reset(restored);
    const fresh = await refreshPublicationProof(restored, value);
    expect(fresh.handle.generation).not.toBe(value.handle.generation);
    expect(fresh.handle.runId).not.toBe(value.handle.runId);
    expect(fresh.snapshot.graphSha256).toBe(value.snapshot.graphSha256);
    expect(await restored.db.prepare('SELECT status FROM archive_semantic_runs WHERE run_id=?').bind(fresh.handle.runId).first('status')).toBe('complete');
    expect(await restored.db.prepare('SELECT status FROM archive_semantic_runs WHERE run_id=?').bind(value.handle.runId).first()).toBeNull();
    expect(await restored.db.prepare("SELECT count(*) AS n FROM archive_semantic_diagnostics WHERE verification_id=? AND kind='cleanup_complete'").bind(value.handle.verificationId).first('n')).toBe(1);
    expect(await rows(restored, publicationTables)).toEqual(original);
    expect(await restored.db.prepare('SELECT generation,status FROM archive_publication_availability WHERE publication_id=?').bind(publication.publicationId).first()).toEqual({ generation: publication.generation, status: 'unavailable' });
    expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
    expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_corrections').first('n')).toBe(0);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('captures all 96 backup inventory tables in a four-statement snapshot batch', async () => {
    const value = await fixture(); await publish(value);
    const captured = await captureBackup(value.app, value.key);
    expect(captured.batches).toEqual([4]); expect(captured.statements).toBeLessThanOrEqual(40);
    expect(Object.keys(captured.counts).sort()).toEqual([...BACKUP_TABLES].sort()); expect(Object.keys(captured.counts)).toHaveLength(96);
    for (const table of reconciliationTables) expect(captured.counts[table]).toBe(0);
    expect(captured.references).toEqual([value.reference]); expect(Math.max(...JSON.parse(captured.job.schema_json))).toBe(42);
    for (const table of BACKUP_TABLES) expect(await value.app.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(captured.counts[table]);
  });

  it.each(['pending', 'running'] as const)('invalidates restored %s reconciliation and its lease while keeping its immutable pins', async state => {
    const value = await fixture(); const publication = await publish(value), recovered = await restoredFixture(value);
    const handle = await startPublicationReconciliation(recovered.app.db, publication.publicationId, recovered.fresh.handle);
    if (state === 'running') await recovered.app.db.prepare("UPDATE archive_publication_reconciliation_jobs SET state='running',revision=revision+1,lease_token='restore-test-lease',lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reconciliation_id=?").bind(handle.reconciliationId).run();
    const before = await recovered.app.db.prepare('SELECT * FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).first<Record<string, unknown>>();
    const imported = await restorePublicationDatabase(await snapshotPublicationDatabase(recovered.app)); runtimes.push(imported);
    await reset(imported);
    const after = await imported.db.prepare('SELECT * FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).first<Record<string, unknown>>();
    expect(after).toMatchObject({ ...before, state: 'invalid', revision: Number(before!.revision) + 1, lease_token: null, lease_expires_at: null, updated_at: after!.updated_at });
    expect(await imported.db.prepare('SELECT count(*) AS n FROM archive_publication_reconciliation_receipts').first('n')).toBe(0);
    await reset(imported); expect(await imported.db.prepare('SELECT * FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).first()).toEqual(after);
  });

  it('retains committed reconciliation receipts through backup and repeated reset while marking their authority unavailable', async () => {
    const value = await fixture(); const publication = await publish(value), recovered = await restoredFixture(value);
    const handle = await reconcile(recovered.app, publication.publicationId, recovered.fresh, value.key);
    await assertOriginalReceipts(recovered.app, value);
    const evidence = await rows(recovered.app, [...publicationTables, ...reconciliationTables]);
    const captured = await captureBackup(recovered.app, value.key);
    expect(captured.counts.archive_publication_reconciliation_jobs).toBe(1); expect(captured.counts.archive_publication_reconciliation_receipts).toBe(1);
    expect(captured.references).toEqual([value.reference]); expect(captured.batches).toEqual([4]);
    const imported = await restorePublicationDatabase(await snapshotPublicationDatabase(recovered.app)); runtimes.push(imported);
    for (let attempt = 0; attempt < 2; attempt++) {
      await reset(imported); expect(await rows(imported, [...publicationTables, ...reconciliationTables])).toEqual(evidence);
      expect(await imported.db.prepare('SELECT generation,status,reconciliation_id FROM archive_publication_availability WHERE publication_id=?').bind(publication.publicationId).first()).toEqual({ generation: handle.generation, status: 'unavailable', reconciliation_id: handle.reconciliationId });
      expect((await imported.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    }
  });

  it('restores an encrypted independent backup, revalidates its original archive graph and serves exact historical receipts', async () => {
    const value = await fixture(); const publication = await publish(value), recovered = await restoredFixture(value);
    const first = await reconcile(recovered.app, publication.publicationId, recovered.fresh, value.key);
    const publicationEvidence = await rows(recovered.app, publicationTables), firstReceipts = await rows(recovered.app, ['archive_publication_reconciliation_receipts']);
    const bundle = await encryptedBundle(recovered.app, value);
    expect(bundle.captured.counts.attendance_events).toBe(0); expect(bundle.captured.counts.attendance_corrections).toBe(0);
    expect(bundle.captured.counts.archive_publication_reconciliation_receipts).toBe(1);
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
    const output = join(bundle.directory, 'restored.sql'), result = await cli(['verify-decrypt', bundle.root, output], bundle.keyPath);
    expect(result.code, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as BackupManifest;
    expect(manifest.recordCounts).toEqual(bundle.captured.counts); expect(manifest.archiveReferences).toEqual(bundle.captured.references);
    expect((await readdir(bundle.directory)).filter(name => name.includes('.recovery-') || name.includes('.semantic-'))).toEqual([]);
    const imported = await restorePublicationDatabase(await readFile(output, 'utf8')); runtimes.push(imported);
    for (const table of BACKUP_TABLES) expect(await imported.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(manifest.recordCounts[table]);
    await reset(imported);
    expect(await rows(imported, publicationTables)).toEqual(publicationEvidence); expect(await rows(imported, ['archive_publication_reconciliation_receipts'])).toEqual(firstReceipts);
    const key = (await readFile(bundle.keyPath, 'utf8')).trim(), reference = manifest.archiveReferences![0];
    const root = new Uint8Array(await readFile(join(bundle.root, reference.manifestObjectKey)));
    const archive = await openArchiveManifest(key, root, reference), objects = new Map<string, Uint8Array>([[reference.manifestObjectKey, root]]);
    for (const part of archive.parts) objects.set(part.objectKey, new Uint8Array(await readFile(join(bundle.root, part.objectKey))));
    const bucket = await imported.runtime.getR2Bucket('BACKUP_BUCKET');
    for (const [objectKey, bytes] of objects) await bucket.put(objectKey, bytes);
    const fresh = await refreshPublicationProof(imported, { key, reference, objects });
    const second = await reconcile(imported, publication.publicationId, fresh, key);
    expect(second.generation).not.toBe(first.generation); expect(second.reconciliationId).not.toBe(first.reconciliationId);
    const receipt = await imported.db.prepare('SELECT * FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?').bind(second.reconciliationId).first<Record<string, unknown>>();
    expect(receipt).toMatchObject({ reconciliation_id: second.reconciliationId, publication_id: publication.publicationId, execution_generation: fresh.handle.generation, verification_id: fresh.handle.verificationId, run_id: fresh.handle.runId, snapshot_commit_token: fresh.handle.commitToken, graph_sha256: fresh.handle.graphSha256 });
    expect(await imported.db.prepare('SELECT generation,status,reconciliation_id FROM archive_publication_availability WHERE publication_id=?').bind(publication.publicationId).first()).toEqual({ generation: fresh.handle.generation, status: 'ready', reconciliation_id: second.reconciliationId });
    expect(await imported.db.prepare('SELECT count(*) AS n FROM archive_publication_reconciliation_receipts').first('n')).toBe(2);
    expect(await rows(imported, publicationTables)).toEqual(publicationEvidence); await assertOriginalReceipts(imported, value);
    expect(await imported.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
    expect(await imported.db.prepare('SELECT count(*) AS n FROM attendance_corrections').first('n')).toBe(0);
    const retained = await rows(imported, reconciliationTables);
    await reset(imported); expect(await rows(imported, reconciliationTables)).toEqual(retained);
    expect(await imported.db.prepare('SELECT generation,status,reconciliation_id FROM archive_publication_availability WHERE publication_id=?').bind(publication.publicationId).first()).toEqual({ generation: second.generation, status: 'unavailable', reconciliation_id: second.reconciliationId });
    expect((await imported.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
