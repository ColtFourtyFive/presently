import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unstable_splitSqlQuery } from 'wrangler';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { advancePublicationAbandonment, resumePublicationAbandonment, startPublicationAbandonment } from '../worker/archive-publication-abandonment';
import type { ArchiveAbandonmentJobRow } from '../worker/archive-abandonment-schema';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { BACKUP_TABLES, startBackup } from '../worker/backup';
import { digest, newHeader, sealPart, type BackupManifest } from '../worker/backup-crypto';
import { advanceHistoryBackfill } from '../worker/history-lookup';
import type { ArchiveReference } from '../shared/archive-format';
import type { Env } from '../worker/types';
import { createPublicationFixture, createPublicationSeed, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSeed } from './archive-publication-fixture';
import { projectRoot, type IsolatedStatement, type TestRuntime } from './runtime';

type Fixture = Awaited<ReturnType<typeof createPublicationFixture>>;
let seed: PublicationSeed;
const runtimes: TestRuntime[] = [], directories: string[] = [];
beforeAll(async () => { seed = await createPublicationSeed(); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map(app => app.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const childTables = ['archive_publication_requests', 'archive_publication_records', 'archive_publication_parts'];
const abandonmentTables = ['archive_publication_abandonment_jobs', 'archive_publication_abandonment_diagnostics'];
const preservedTables = ['archive_publication_builds', 'history_request_keys', 'history_record_locations', 'history_visit_heads', 'attendance_events', 'attendance_corrections', 'visits', 'reviews', 'archive_publications', 'archive_publication_availability', 'archive_publication_reconciliation_jobs', 'archive_publication_reconciliation_receipts'];
async function rows(app: TestRuntime, tables: readonly string[]): Promise<Record<string, string[]>> {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await app.db.prepare(`SELECT * FROM ${table}`).all()).results.map(row => JSON.stringify(row)).sort()])));
}
async function expectPreserved(app: TestRuntime, expected: Awaited<ReturnType<typeof rows>>) {
  const actual = await rows(app, preservedTables);
  for (const table of preservedTables.filter(table => table !== 'history_request_keys')) expect(actual[table], table).toEqual(expected[table]);
  const originals = new Set(expected.history_request_keys.map(text => String(JSON.parse(text).request_id)));
  expect(actual.history_request_keys.filter(text => originals.has(String(JSON.parse(text).request_id)))).toEqual(expected.history_request_keys);
  // Access reset records a new audit entry through ordinary native triggers.
  // Only those additional audit identities are allowed; prior ownership is exact.
  for (const text of actual.history_request_keys.filter(text => !originals.has(String(JSON.parse(text).request_id)))) {
    const row = JSON.parse(text) as Record<string, unknown>;
    expect(row).toMatchObject({ source_kind: 'audit', center_id: 'test-center', payload_hash: null, hash_encoding: 'none', canonicalization: 'legacy-unverified' });
    expect(await app.db.prepare('SELECT action FROM audit_entries WHERE id=?').bind(row.request_id).first('action')).toBe('recovery_access_reset');
  }
}
async function reset(app: TestRuntime) {
  const sql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
  await app.db.batch(sql.map(statement => app.db.prepare(statement)));
}
async function historyReady(app: TestRuntime) {
  const native = await app.runtime.getD1Database('CRM_DB');
  for (let step = 0; ; step++) { if (step > 12) throw new Error('Recovery history did not become ready'); if ((await advanceHistoryBackfill(native)).state === 'ready') return; }
}
async function invalidCandidate() {
  const fixture = await createPublicationFixture(seed); runtimes.push(fixture.app);
  const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
  for (let step = 0; step < 100; step++) {
    const build = await fixture.app.db.prepare('SELECT state,revision,indexed_count,request_count FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<{ state: string; revision: number; indexed_count: number; request_count: number }>();
    if (build!.request_count > 0) {
      expect(build!.state).toBe('building'); expect(build!.indexed_count).toBeGreaterThan(8);
      await fixture.staging.discard();
      const original = await fixture.app.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<Record<string, unknown>>();
      expect(original!.state).toBe('invalid'); expect(original!.lease_token).toBeNull();
      return { ...fixture, publicationId: handle.publicationId, original: original! };
    }
    await advanceMonthlyPublication(fixture.app.db, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: build!.revision });
  }
  throw new Error('Invalid candidate fixture did not reach request claims');
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
async function encryptedBundle(app: TestRuntime, key: string) {
  const captured = await captureBackup(app, key), sql = new TextEncoder().encode(await snapshotPublicationDatabase(app));
  const directory = await mkdtemp(join(tmpdir(), 'kumon-abandonment-recovery-')); directories.push(directory);
  const root = join(directory, 'downloaded'); await mkdir(root);
  const keyPath = join(directory, 'key'); await writeFile(keyPath, key + '\n', { mode: 0o600 });
  const parts: BackupManifest['parts'] = [];
  for (let offset = 0, index = 0; offset < sql.length; offset += 1024 * 1024, index++) {
    const bytes = sql.slice(offset, offset + 1024 * 1024), encrypted = await sealPart(key, bytes, newHeader(captured.job.id, index));
    const fileName = `part-${String(index).padStart(5, '0')}.kcrm`; await writeFile(join(root, fileName), encrypted);
    parts.push({ index, fileName, plaintextBytes: bytes.length, plaintextSha256: await digest(bytes), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) });
  }
  const manifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId: captured.job.id, applicationVersion: 'local-abandonment-recovery', createdAt: captured.job.created_at, schemaVersions: JSON.parse(captured.job.schema_json), snapshotBookmark: 'LOCAL_FIXTURE_NO_PROVIDER_EXPORT', recordCounts: captured.counts, archiveReferences: captured.references, sqlBytes: sql.length, parts };
  await writeFile(join(root, 'manifest.kcrm'), await sealPart(key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(captured.job.id, -1)));
  return { captured, directory, root, keyPath, manifest };
}
type AbandonmentHandle = Awaited<ReturnType<typeof startPublicationAbandonment>>;
async function job(app: TestRuntime, handle: AbandonmentHandle) {
  const row = await app.db.prepare('SELECT * FROM archive_publication_abandonment_jobs WHERE abandonment_id=?').bind(handle.abandonmentId).first<ArchiveAbandonmentJobRow>();
  if (!row) throw new Error('Fixture cleanup job missing'); return row;
}
async function partiallyDelete(value: Awaited<ReturnType<typeof invalidCandidate>>) {
  const handle = await startPublicationAbandonment(value.app.db, value.publicationId);
  for (let step = 0; step < 200; step++) {
    const current = await job(value.app, handle), removed = JSON.parse(current.removed_json) as { records: number };
    const remaining = await value.app.db.prepare('SELECT count(*) AS n FROM archive_publication_records WHERE publication_id=?').bind(value.publicationId).first<number>('n');
    if (removed.records > 0 && remaining! > 0) return { handle, job: current, remaining: remaining! };
    if (current.state === 'complete') throw new Error('Fixture cleanup completed before partial snapshot');
    const result = await advancePublicationAbandonment(value.app.db, handle, { expectedRevision: current.revision });
    expect(result.processed).toBeLessThanOrEqual(8);
  }
  throw new Error('Fixture cleanup did not reach partial locator deletion');
}
async function finish(app: TestRuntime, handle: AbandonmentHandle) {
  for (let step = 0; step < 200; step++) {
    const current = await job(app, handle); if (current.state === 'complete') return current;
    if (current.state === 'paused') throw new Error('Fixture cleanup unexpectedly paused');
    const result = await advancePublicationAbandonment(app.db, handle, { expectedRevision: current.revision });
    expect(result.processed).toBeLessThanOrEqual(8);
  }
  throw new Error('Fixture cleanup did not finish');
}
async function blockedOldHandle(app: TestRuntime, handle: AbandonmentHandle) {
  const before = await rows(app, childTables), current = await job(app, handle);
  try { expect((await advancePublicationAbandonment(app.db, handle, { expectedRevision: current.revision })).state).toBe('paused'); }
  catch (error) { expect(String(error)).toMatch(/ARCHIVE_ABANDONMENT_/); }
  expect(await rows(app, childTables)).toEqual(before); expect((await job(app, handle)).state).toBe('paused');
}
async function resumeAndInventory(app: TestRuntime, oldHandle: AbandonmentHandle) {
  const before = await rows(app, childTables), paused = await job(app, oldHandle);
  const handle = await resumePublicationAbandonment(app.db, oldHandle, { expectedRevision: paused.revision });
  expect(handle.generation).not.toBe(oldHandle.generation);
  expect(await rows(app, childTables)).toEqual(before);
  expect(await job(app, handle)).toMatchObject({ phase: 'inventory_requests', mode: 'resume', execution_generation: handle.generation, inventory_json: paused.inventory_json, removed_json: paused.removed_json });
  for (let step = 0; step < 200; step++) {
    const current = await job(app, handle);
    if (!current.phase.startsWith('inventory_')) return handle;
    await advancePublicationAbandonment(app.db, handle, { expectedRevision: current.revision });
    expect(await rows(app, childTables)).toEqual(before);
  }
  throw new Error('Fixture resumed inventory did not finish');
}

describe('invalid publication abandonment recovery', () => {
  it('retains immutable invalid candidate provenance and permanent request ownership in the authentic partial fixture', async () => {
    const value = await invalidCandidate();
    expect(await value.app.db.prepare('SELECT count(*) AS n FROM archive_publication_requests WHERE publication_id=?').bind(value.publicationId).first<number>('n')).toBeGreaterThan(0);
    expect(await value.app.db.prepare('SELECT count(*) AS n FROM history_request_keys').first<number>('n')).toBeGreaterThanOrEqual(Number(value.original.request_count));
    expect(await value.app.db.prepare('SELECT count(*) AS n FROM archive_publications').first('n')).toBe(0);
    expect((await value.app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('rejects restored committed evidence even when availability and semantic proof are invalidated and live receipt rows are absent', async () => {
    const value = await createPublicationFixture(seed); runtimes.push(value.app);
    const handle = await startMonthlyPublication(value.app.db, value.handle);
    for (let step = 0; ; step++) {
      if (step > 100) throw new Error('Published recovery fixture did not finish');
      const build = await value.app.db.prepare('SELECT state,revision FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<{ state: string; revision: number }>();
      if (build!.state === 'published') break;
      await advanceMonthlyPublication(value.app.db, { bucket: value.bucket, masterKey: value.key }, handle, { expectedRevision: build!.revision });
    }
    const restored = await restorePublicationDatabase(await snapshotPublicationDatabase(value.app, { omitTables: ['attendance_events', 'attendance_corrections', 'reviews'] })); runtimes.push(restored);
    await reset(restored); await historyReady(restored);
    expect(await restored.db.prepare('SELECT status FROM archive_publication_availability WHERE publication_id=?').bind(handle.publicationId).first('status')).toBe('unavailable');
    expect(await restored.db.prepare('SELECT status FROM archive_semantic_runs WHERE run_id=?').bind(value.handle.runId).first('status')).toBe('invalid');
    const before = await rows(restored, [...preservedTables, ...childTables, ...abandonmentTables]);
    await expect(startPublicationAbandonment(restored.db, handle.publicationId)).rejects.toThrow('ARCHIVE_ABANDONMENT_BUILD_INELIGIBLE');
    expect(await rows(restored, [...preservedTables, ...childTables, ...abandonmentTables])).toEqual(before);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('captures actual partial cleanup metadata and all 96 inventory tables in a four-statement backup transaction', async () => {
    const value = await invalidCandidate(), partial = await partiallyDelete(value);
    expect(JSON.parse(partial.job.inventory_json!)).toMatchObject({ records: value.original.indexed_count, requests: value.original.request_count });
    expect(Number(value.original.indexed_count)).toBeLessThan(Number(value.original.record_count));
    const before = await rows(value.app, [...childTables, ...abandonmentTables]), captured = await captureBackup(value.app, value.key);
    expect(captured.batches).toEqual([4]); expect(captured.statements).toBeLessThanOrEqual(40);
    expect(Object.keys(captured.counts).sort()).toEqual([...BACKUP_TABLES].sort()); expect(Object.keys(captured.counts)).toHaveLength(96);
    expect(Math.max(...JSON.parse(captured.job.schema_json))).toBe(42);
    expect(captured.counts.archive_publication_abandonment_jobs).toBe(1); expect(captured.counts.archive_publication_abandonment_diagnostics).toBeGreaterThan(0);
    expect(captured.counts.archive_publication_records).toBe(partial.remaining); expect(captured.references).toEqual([]);
    for (const table of BACKUP_TABLES) expect(await value.app.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(captured.counts[table]);
    const attempt = await Promise.allSettled([advancePublicationAbandonment(value.app.db, partial.handle, { expectedRevision: partial.job.revision })]);
    if (attempt[0].status === 'rejected') expect(String(attempt[0].reason)).toMatch(/backup_maintenance|ARCHIVE_ABANDONMENT_/);
    else expect(attempt[0].value.processed).toBe(0);
    expect(await rows(value.app, [...childTables, ...abandonmentTables])).toEqual(before);
  });

  it('independently restores a partially deleted candidate, pauses old authority and requires explicit validated resume before completion', async () => {
    const value = await invalidCandidate(), partial = await partiallyDelete(value);
    const preserved = await rows(value.app, preservedTables), children = await rows(value.app, childTables), diagnostics = await rows(value.app, ['archive_publication_abandonment_diagnostics']);
    const bundle = await encryptedBundle(value.app, value.key);
    expect(bundle.captured.references).toEqual([]);
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
    const output = join(bundle.directory, 'restored.sql'), result = await cli(['verify-decrypt', bundle.root, output], bundle.keyPath);
    expect(result.code, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as BackupManifest;
    expect(manifest.recordCounts).toEqual(bundle.captured.counts);
    expect((await readdir(bundle.directory)).filter(name => name.includes('.recovery-') || name.includes('.semantic-'))).toEqual([]);
    const restored = await restorePublicationDatabase(await readFile(output, 'utf8')); runtimes.push(restored);
    for (const table of BACKUP_TABLES) expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'), table).toBe(manifest.recordCounts[table]);
    for (let attempt = 0; attempt < 2; attempt++) {
      await reset(restored);
      const paused = await job(restored, partial.handle);
      expect(paused).toMatchObject({ state: 'paused', pause_reason: 'generation_reset', execution_generation: partial.handle.generation, admission_generation: partial.job.admission_generation, build_json: partial.job.build_json, build_sha256: partial.job.build_sha256, inventory_json: partial.job.inventory_json, removed_json: partial.job.removed_json, lease_token: null, lease_expires_at: null, selection_json: '[]' });
      await expectPreserved(restored, preserved); expect(await rows(restored, childTables)).toEqual(children);
      await blockedOldHandle(restored, partial.handle);
    }
    await historyReady(restored); await blockedOldHandle(restored, partial.handle);
    const resumed = await resumeAndInventory(restored, partial.handle), complete = await finish(restored, resumed);
    expect(complete).toMatchObject({ state: 'complete', build_json: partial.job.build_json, build_sha256: partial.job.build_sha256, inventory_json: partial.job.inventory_json });
    expect(JSON.parse(complete.removed_json)).toEqual(JSON.parse(complete.inventory_json!));
    expect(await restored.db.prepare("SELECT count(*) AS n FROM archive_publication_abandonment_diagnostics WHERE abandonment_id=? AND kind='completed'").bind(resumed.abandonmentId).first('n')).toBe(1);
    expect(await restored.db.prepare("SELECT execution_generation FROM archive_publication_abandonment_diagnostics WHERE abandonment_id=? AND kind='admitted'").bind(resumed.abandonmentId).first('execution_generation')).toBe(partial.handle.generation);
    expect(await restored.db.prepare("SELECT execution_generation FROM archive_publication_abandonment_diagnostics WHERE abandonment_id=? AND kind='rebound'").bind(resumed.abandonmentId).first('execution_generation')).toBe(resumed.generation);
    for (const table of childTables) expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE publication_id=?`).bind(value.publicationId).first('n')).toBe(0);
    await expectPreserved(restored, preserved);
    const retainedDiagnostics = (await rows(restored, ['archive_publication_abandonment_diagnostics'])).archive_publication_abandonment_diagnostics;
    expect(retainedDiagnostics).toEqual(expect.arrayContaining(diagnostics.archive_publication_abandonment_diagnostics));
    const retained = await rows(restored, abandonmentTables);
    for (let attempt = 0; attempt < 2; attempt++) { await reset(restored); expect(await rows(restored, abandonmentTables)).toEqual(retained); await expectPreserved(restored, preserved); }
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('clears a copied active deletion selection on reset and cannot use that stale lease after restoration', async () => {
    const value = await invalidCandidate(), partial = await partiallyDelete(value);
    let snapshot: string | undefined;
    const wrapped: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => value.app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const result = await value.app.db.batch<T>(statements), current = await job(value.app, partial.handle);
      if (!snapshot && current.state === 'running' && current.selection_json !== '[]') { snapshot = await snapshotPublicationDatabase(value.app); throw new Error('SIMULATED_RESTORE_CAPTURE'); }
      return result;
    } };
    await expect(advancePublicationAbandonment(wrapped, partial.handle, { expectedRevision: partial.job.revision })).rejects.toThrow('SIMULATED_RESTORE_CAPTURE');
    expect(snapshot).toBeTypeOf('string');
    const restored = await restorePublicationDatabase(snapshot!); runtimes.push(restored);
    expect(await job(restored, partial.handle)).toMatchObject({ state: 'running' }); expect((await job(restored, partial.handle)).lease_token).not.toBeNull();
    const children = await rows(restored, childTables); await reset(restored);
    expect(await job(restored, partial.handle)).toMatchObject({ state: 'paused', lease_token: null, lease_expires_at: null, selection_json: '[]', execution_generation: partial.handle.generation });
    await blockedOldHandle(restored, partial.handle); expect(await rows(restored, childTables)).toEqual(children);
    await historyReady(restored); await finish(restored, await resumeAndInventory(restored, partial.handle));
    expect(await restored.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(value.publicationId).first()).toEqual(value.original);
  });

  it.each(['job-and-diagnostics', 'diagnostics-only'] as const)('refuses to reconstruct missing partial-cleanup %s into new destructive authority', async missing => {
    const value = await invalidCandidate(), partial = await partiallyDelete(value);
    const omitted = missing === 'diagnostics-only' ? ['archive_publication_abandonment_diagnostics'] : abandonmentTables;
    const restored = await restorePublicationDatabase(await snapshotPublicationDatabase(value.app, { omitTables: omitted })); runtimes.push(restored);
    await reset(restored); await historyReady(restored); const before = await rows(restored, childTables);
    if (missing === 'diagnostics-only') await expect(resumeAndInventory(restored, partial.handle)).rejects.toThrow(/ARCHIVE_ABANDONMENT_/);
    else await expect((async () => { const handle = await startPublicationAbandonment(restored.db, value.publicationId); await finish(restored, handle); })()).rejects.toThrow(/ARCHIVE_ABANDONMENT_/);
    expect(await rows(restored, childTables)).toEqual(before);
    expect(await restored.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(value.publicationId).first()).toEqual(value.original);
  });

  it('blocks explicit resume when a restored remaining locator is missing from the saved deletion accounting', async () => {
    const value = await invalidCandidate(), partial = await partiallyDelete(value);
    const omitted = await value.app.db.prepare('SELECT table_name,record_key FROM archive_publication_records WHERE publication_id=? ORDER BY part_index,part_offset LIMIT 1').bind(value.publicationId).first<{ table_name: string; record_key: string }>();
    const sql = await snapshotPublicationDatabase(value.app, { transformRow: (table, row) => table === 'archive_publication_records' && row.publication_id === value.publicationId && row.table_name === omitted!.table_name && row.record_key === omitted!.record_key ? null : row });
    const restored = await restorePublicationDatabase(sql); runtimes.push(restored);
    await reset(restored); await historyReady(restored); const before = await rows(restored, childTables);
    await expect(resumeAndInventory(restored, partial.handle)).rejects.toThrow(/ARCHIVE_ABANDONMENT_/);
    expect(await rows(restored, childTables)).toEqual(before);
    expect(await restored.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(value.publicationId).first()).toEqual(value.original);
  });
});
