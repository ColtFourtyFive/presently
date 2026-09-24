import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { unstable_splitSqlQuery } from 'wrangler';
import { startCompactMonthlyPublication, advanceCompactMonthlyPublication } from '../worker/archive-compact-publication';
import { advanceCompactPublicationReconciliation, startCompactPublicationReconciliation } from '../worker/archive-compact-reconciliation';
import { BACKUP_TABLES, startBackup } from '../worker/backup';
import { resolveHistoryRequest } from '../worker/history-request';
import { digest, newHeader, sealPart, type BackupManifest } from '../worker/backup-crypto';
import type { ArchiveReference } from '../shared/archive-format';
import type { Env } from '../worker/types';
import { createPublicationFixture, createPublicationSeed, refreshPublicationProof, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSeed } from './archive-publication-fixture';
import { projectRoot, type TestRuntime } from './runtime';

type Fixture = Awaited<ReturnType<typeof createPublicationFixture>>;
const compactTables = ['archive_compact_identities', 'archive_compact_builds', 'archive_compact_requests', 'archive_compact_publications', 'archive_compact_availability'] as const;
const immutableEvidence = ['archive_compact_identities', 'archive_compact_builds', 'archive_compact_requests', 'archive_compact_publications', 'history_request_keys', 'history_visit_heads'] as const;
let seed: PublicationSeed;
const runtimes: TestRuntime[] = [], directories: string[] = [];
beforeAll(async () => { seed = await createPublicationSeed(); });
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(app => app.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() { const value = await createPublicationFixture(seed); runtimes.push(value.app); return value; }
async function publish(value: Fixture) {
  const handle = await startCompactMonthlyPublication(value.app.db, value.handle);
  for (let step = 0; step < 100; step++) {
    const row = await value.app.db.prepare('SELECT state,revision FROM archive_compact_builds WHERE publication_id=?').bind(handle.publicationId).first<{ state: string; revision: number }>();
    if (row?.state === 'published') return handle;
    if (!row || row.state === 'invalid') throw new Error('Compact fixture publication stopped');
    await advanceCompactMonthlyPublication(value.app.db, handle, { expectedRevision: row.revision });
  }
  throw new Error('Compact fixture publication did not finish');
}
async function reconcile(value: { app: TestRuntime; key: string; bucket: Fixture['bucket'] }, publicationId: string, fresh: Awaited<ReturnType<typeof refreshPublicationProof>>) {
  const handle = await startCompactPublicationReconciliation(value.app.db, publicationId, fresh.handle);
  const storage = { masterKey: value.key, bucket: value.bucket };
  let revision = 0;
  for (let step = 0; step < 200; step += 1) {
    const result = await advanceCompactPublicationReconciliation(value.app.db, storage, handle, { expectedRevision: revision });
    revision = result.revision;
    if (result.state === 'complete') return handle;
    if (result.state !== 'pending') throw new Error(`Compact reconciliation stopped: ${result.state}`);
  }
  throw new Error('Compact reconciliation did not finish');
}
async function reset(app: TestRuntime) {
  const sql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
  await app.db.batch(sql.map(statement => app.db.prepare(statement)));
}
async function rows(app: TestRuntime, tables: readonly string[]) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await app.db.prepare(`SELECT * FROM ${table}`).all()).results.map(row => JSON.stringify(row)).sort()])));
}
async function expectPreservedAfterReset(app: TestRuntime, original: Record<string, string[]>, resetCount: number) {
  const previousKeys = new Set(original.history_request_keys.map(row => JSON.parse(row).request_id as string));
  const resetKeys = (await app.db.prepare(`SELECT k.* FROM history_request_keys k JOIN audit_entries a ON a.id=k.request_id
    WHERE a.action='recovery_access_reset' AND k.source_kind='audit' AND k.center_id=a.center_id
      AND k.payload_hash IS NULL AND k.hash_encoding='none' AND k.canonicalization='legacy-unverified'`).all()).results
    .filter(row => !previousKeys.has(row.request_id as string)).map(row => JSON.stringify(row));
  const centers = await app.db.prepare('SELECT count(*) AS n FROM centers').first<number>('n');
  expect(resetKeys).toHaveLength(resetCount * centers!);
  expect(await rows(app, Object.keys(original))).toEqual({
    ...original, history_request_keys: [...original.history_request_keys, ...resetKeys].sort(),
  });
}
async function captureBackup(app: TestRuntime, key: string) {
  const env = await app.runtime.getBindings<Env>(), batches: number[] = [];
  const db = new Proxy(env.CRM_DB, { get(target, property) {
    if (property === 'batch') return (input: Parameters<Env['CRM_DB']['batch']>[0]) => { batches.push(input.length); return target.batch(input); };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const id = await startBackup({ ...env, CRM_DB: db, BACKUP_KEY: key, CF_ACCOUNT_ID: 'isolated-compact-account', CF_DATABASE_ID: 'isolated-compact-database', CF_EXPORT_API_TOKEN: 'isolated-no-network-token' });
  const job = await app.db.prepare('SELECT id,created_at,counts_json,schema_json,archives_json FROM backup_jobs WHERE id=?').bind(id).first<{ id: string; created_at: string; counts_json: string; schema_json: string; archives_json: string }>();
  if (!job) throw new Error('Captured compact backup job missing');
  return { job, batches, counts: JSON.parse(job.counts_json) as Record<string, number>, references: JSON.parse(job.archives_json) as ArchiveReference[] };
}
function cli(args: string[], keyPath: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/recovery.ts'), ...args], { cwd: projectRoot, env: { KUMON_RECOVERY_KEY_FILE: keyPath, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
}
async function encryptedBundle(value: { app: TestRuntime; key: string; objects: Fixture['objects'] }) {
  const captured = await captureBackup(value.app, value.key);
  // Native captured inventory and a test-only SQL export under the actual lock.
  // This is not provider export or Worker-to-R2 delivery evidence.
  const sql = new TextEncoder().encode(await snapshotPublicationDatabase(value.app));
  const directory = await mkdtemp(join(tmpdir(), 'kumon-compact-recovery-')); directories.push(directory);
  const root = join(directory, 'downloaded'); await mkdir(root);
  const keyPath = join(directory, 'key'); await writeFile(keyPath, value.key + '\n', { mode: 0o600 });
  const parts: BackupManifest['parts'] = [];
  for (let offset = 0, index = 0; offset < sql.length; offset += 1024 * 1024, index++) {
    const bytes = sql.slice(offset, offset + 1024 * 1024), encrypted = await sealPart(value.key, bytes, newHeader(captured.job.id, index));
    const fileName = `part-${String(index).padStart(5, '0')}.kcrm`; await writeFile(join(root, fileName), encrypted);
    parts.push({ index, fileName, plaintextBytes: bytes.length, plaintextSha256: await digest(bytes), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) });
  }
  const manifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId: captured.job.id, applicationVersion: 'local-compact-recovery', createdAt: captured.job.created_at, schemaVersions: JSON.parse(captured.job.schema_json), snapshotBookmark: 'LOCAL_FIXTURE_NO_PROVIDER_EXPORT', recordCounts: captured.counts, archiveReferences: captured.references, sqlBytes: sql.length, parts };
  await writeFile(join(root, 'manifest.kcrm'), await sealPart(value.key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(captured.job.id, -1)));
  for (const [key, bytes] of value.objects) { const path = join(root, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  return { captured, directory, root, keyPath };
}

describe('direct compact publication backup and recovery', () => {
  it('captures every compact table and the committed root even when availability was revoked', async () => {
    const value = await fixture(), handle = await publish(value);
    const original = await rows(value.app, immutableEvidence);
    await reset(value.app);
    await expectPreservedAfterReset(value.app, original, 1);
    expect(await value.app.db.prepare('SELECT status FROM archive_compact_availability WHERE publication_id=?').bind(handle.publicationId).first('status')).toBe('unavailable');
    const saved = await captureBackup(value.app, value.key);
    expect(saved.references).toEqual([value.reference]);
    expect(Object.keys(saved.counts).sort()).toEqual([...BACKUP_TABLES].sort());
    expect(BACKUP_TABLES).toHaveLength(96);
    expect(JSON.parse(saved.job.schema_json).at(-1)).toBe(42);
    for (const table of compactTables) {
      expect(BACKUP_TABLES).toContain(table);
      expect(saved.counts[table], table).toBeGreaterThan(0);
      expect(await value.app.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(saved.counts[table]);
    }
    expect(saved.counts.archive_compact_requests).toBe(value.records.filter(record => record.table === 'attendance_events' || record.table === 'attendance_corrections').length);
    for (const table of ['archive_publication_parts', 'archive_publication_records', 'archive_publication_requests', 'archive_publications']) expect(saved.counts[table], table).toBe(0);
    expect(saved.batches).toEqual([4]);
  });

  it('independently decrypts and restores the compact catalog and archive graph, then revokes copied authority', async () => {
    const value = await fixture(), handle = await publish(value);
    const original = await rows(value.app, immutableEvidence), bundle = await encryptedBundle(value);
    expect(bundle.captured.references).toEqual([value.reference]);
    // All source runtimes close before a separate process receives downloaded
    // encrypted files and the protected key file. No live DB or bucket remains.
    await Promise.all(runtimes.splice(0).map(app => app.close()));
    const output = join(bundle.directory, 'restored.sql'), result = await cli(['verify-decrypt', bundle.root, output], bundle.keyPath);
    expect(result.code, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as BackupManifest;
    expect(manifest.recordCounts).toEqual(bundle.captured.counts);
    expect(manifest.archiveReferences).toEqual([value.reference]);
    expect((await readdir(bundle.directory)).filter(name => name.includes('.recovery-') || name.includes('.semantic-'))).toEqual([]);
    const recoveredSql = await readFile(output, 'utf8');
    // D1 rejects PRAGMA integrity_check. Check the decrypted SQL independently
    // in SQLite, then verify the native D1 restore and its guarded reset below.
    const independent = new DatabaseSync(':memory:');
    try {
      independent.exec('BEGIN; PRAGMA defer_foreign_keys=ON;');
      independent.exec(recoveredSql);
      independent.exec('COMMIT;');
      expect(independent.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect(independent.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { independent.close(); }
    const restored = await restorePublicationDatabase(recoveredSql); runtimes.push(restored);
    for (const table of BACKUP_TABLES) expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(bundle.captured.counts[table]);
    expect(await rows(restored, immutableEvidence)).toEqual(original);
    for (let attempt = 0; attempt < 2; attempt++) {
      await reset(restored);
      await expectPreservedAfterReset(restored, original, attempt + 1);
      expect(await restored.db.prepare('SELECT status FROM archive_compact_availability WHERE publication_id=?').bind(handle.publicationId).first('status')).toBe('unavailable');
      await expect(restored.db.prepare("UPDATE archive_compact_availability SET status='ready' WHERE publication_id=?").bind(handle.publicationId).run()).rejects.toThrow();
      await expect(restored.db.prepare("UPDATE archive_compact_availability SET generation=(SELECT generation FROM history_runtime WHERE id=1),status='ready' WHERE publication_id=?").bind(handle.publicationId).run()).rejects.toThrow();
      expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    }
    // Reconciliation and public compact receipt activation are deliberately not
    // implemented by this catalog-preservation test.
  }, 60_000);

  it('preserves private partial mappings through a backup while reset invalidates their unfinished build', async () => {
    const value = await fixture(), handle = await startCompactMonthlyPublication(value.app.db, value.handle);
    await advanceCompactMonthlyPublication(value.app.db, handle, { expectedRevision: 0 });
    const privateMap = await rows(value.app, ['archive_compact_identities', 'archive_compact_requests', 'history_request_keys']);
    expect(await value.app.db.prepare('SELECT count(*) AS n FROM archive_compact_requests').first<number>('n')).toBeGreaterThan(0);
    expect(await value.app.db.prepare('SELECT count(*) AS n FROM archive_compact_publications').first('n')).toBe(0);
    const captured = await captureBackup(value.app, value.key);
    expect(captured.references).toEqual([]);
    const restored = await restorePublicationDatabase(await snapshotPublicationDatabase(value.app)); runtimes.push(restored);
    await reset(restored);
    await expectPreservedAfterReset(restored, privateMap, 1);
    const invalid = await restored.db.prepare('SELECT state,lease_token,lease_expires_at FROM archive_compact_builds WHERE publication_id=?').bind(handle.publicationId).first();
    expect(invalid).toEqual({ state: 'invalid', lease_token: null, lease_expires_at: null });
    expect(await restored.db.prepare('SELECT count(*) AS n FROM archive_compact_availability').first('n')).toBe(0);
    expect(await advanceCompactMonthlyPublication(restored.db, handle, { expectedRevision: 1 })).toMatchObject({ state: 'invalid', processed: 0, busy: false });
    await expectPreservedAfterReset(restored, privateMap, 1);
  expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('preserves completed compact receipts through encrypted source-free restore, revokes them, and accepts a fresh generation receipt', async () => {
    const source = await fixture(), publication = await publish(source);
    const sourceFreeSql = await snapshotPublicationDatabase(source.app, { omitTables: ['attendance_events', 'attendance_corrections', 'reviews'] });
    const archived = await restorePublicationDatabase(sourceFreeSql); runtimes.push(archived);
    const archivedBucket = await archived.runtime.getR2Bucket('BACKUP_BUCKET');
    for (const [key, bytes] of source.objects) await archivedBucket.put(key, bytes);
    const archivedValue = { ...source, app: archived, bucket: archivedBucket };
    await reset(archived);
    const firstProof = await refreshPublicationProof(archived, source);
    const first = await reconcile(archivedValue, publication.publicationId, firstProof);
    const receipt = await archived.db.prepare('SELECT * FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=?')
      .bind(first.reconciliationId).first();
    expect(receipt).toBeTruthy();
    expect(await archived.db.prepare('SELECT count(*) n FROM attendance_events').first<number>('n')).toBe(0);
    expect(await archived.db.prepare('SELECT count(*) n FROM attendance_corrections').first<number>('n')).toBe(0);

    const bundle = await encryptedBundle(archivedValue);
    expect(bundle.captured.counts.archive_compact_reconciliation_jobs).toBe(1);
    expect(bundle.captured.counts.archive_compact_reconciliation_receipts).toBe(1);
    expect(bundle.captured.counts.attendance_events).toBe(0);
    expect(bundle.captured.counts.attendance_corrections).toBe(0);
    await Promise.all(runtimes.splice(0).map(app => app.close()));

    const output = join(bundle.directory, 'compact-reconciled-restored.sql');
    const decrypted = await cli(['verify-decrypt', bundle.root, output], bundle.keyPath);
    expect(decrypted.code, decrypted.stderr).toBe(0);
    const recoveredSql = await readFile(output, 'utf8');
    const independent = new DatabaseSync(':memory:');
    try {
      independent.exec('BEGIN; PRAGMA defer_foreign_keys=ON;');
      independent.exec(recoveredSql);
      independent.exec('COMMIT;');
      expect(independent.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect(independent.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { independent.close(); }

    const restored = await restorePublicationDatabase(recoveredSql); runtimes.push(restored);
    const restoredBucket = await restored.runtime.getR2Bucket('BACKUP_BUCKET');
    for (const [key, bytes] of source.objects) await restoredBucket.put(key, bytes);
    expect(await restored.db.prepare('SELECT * FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=?')
      .bind(first.reconciliationId).first()).toEqual(receipt);
    await reset(restored);
    expect(await restored.db.prepare('SELECT status,reconciliation_id FROM archive_compact_availability WHERE publication_id=?')
      .bind(publication.publicationId).first()).toEqual({ status: 'unavailable', reconciliation_id: null });
    expect(await restored.db.prepare('SELECT * FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=?')
      .bind(first.reconciliationId).first()).toEqual(receipt);

    const secondProof = await refreshPublicationProof(restored, source);
    const secondValue = { ...source, app: restored, bucket: restoredBucket };
    const second = await reconcile(secondValue, publication.publicationId, secondProof);
    expect(second.generation).not.toBe(first.generation);
    expect(second.reconciliationId).not.toBe(first.reconciliationId);
    const archivedEvent = source.records.find(record => record.table === 'attendance_events');
    if (!archivedEvent) throw new Error('Publication fixture lacks an archived attendance event.');
    expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_events').first<number>('n')).toBe(0);
    const restoredStorage = { bucket: restoredBucket, masterKey: source.key };
    const request = {
      id: archivedEvent.key,
      centerId: String(archivedEvent.row.center_id),
      kind: 'event' as const,
      payloadHash: String(archivedEvent.row.payload_hash),
    };
    expect(await resolveHistoryRequest(restored.db, request, restoredStorage)).toEqual(archivedEvent.row);
    await expect(resolveHistoryRequest(restored.db, {
      ...request,
      payloadHash: Buffer.alloc(32, 19).toString('base64'),
    }, restoredStorage)).rejects.toMatchObject({ status: 409, code: 'EVENT_ID_REUSED' });
    expect(await restored.db.prepare('SELECT generation,status,reconciliation_id FROM archive_compact_availability WHERE publication_id=?')
      .bind(publication.publicationId).first()).toEqual({ generation: second.generation, status: 'ready', reconciliation_id: second.reconciliationId });
    expect(await restored.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(2);
  }, 120_000);
});
