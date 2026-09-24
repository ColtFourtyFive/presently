import { readFileSync } from 'node:fs';
import { unstable_splitSqlQuery } from 'wrangler';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArchiveRecord } from '../shared/archive-format';
import { resolveHistoryRequest, type HistoryRequest } from '../worker/history-request';
import { publishedRequestStatement } from '../worker/archive-publication-reader';
import { decodeAttendanceReceipt } from '../worker/attendance-receipt';
import type { ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';
import { startMonthlyPublication, advanceMonthlyPublication } from '../worker/archive-publication';
import { startPublicationReconciliation, advancePublicationReconciliation } from '../worker/archive-publication-reconciliation';
import { createPublicationFixture, createPublicationSeed, refreshPublicationProof, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSnapshotOptions } from './archive-publication-fixture';
import { json } from './helpers';
import type { IsolatedStatement, TestRuntime } from './runtime';

type Source = Awaited<ReturnType<typeof createPublicationFixture>>;
type Restored = Awaited<ReturnType<typeof restore>>;
const instances: TestRuntime[] = [], unavailable = { status: 503, code: 'HISTORY_EVIDENCE_UNAVAILABLE' };
const omitted = ['attendance_events', 'attendance_corrections', 'reviews'];
const resetStatements = unstable_splitSqlQuery(readFileSync(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8'));
let source: Source, publishedSql: string, archivedSql: string, event: ArchiveRecord, correction: ArchiveRecord, unmatched: ArchiveRecord;

async function publish(fixture: Source) {
  const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
  for (let step = 0; step < 500; step++) {
    const row = await fixture.app.db.prepare('SELECT revision,state FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<{ revision: number; state: string }>();
    if (row?.state === 'published') return handle;
    if (!row || row.state !== 'building') throw new Error('Publication fixture stopped before publishing.');
    await advanceMonthlyPublication(fixture.app.db, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: row.revision });
  }
  throw new Error('Publication fixture did not finish.');
}

beforeAll(async () => {
  source = await createPublicationFixture(await createPublicationSeed());
  try {
    await publish(source);
    event = source.records.find(record => record.table === 'attendance_events' && record.row.action === 'exceptional_departure' && record.row.visit_id)!;
    unmatched = source.records.find(record => record.table === 'attendance_events' && record.row.visit_id === null)!;
    correction = source.records.find(record => record.table === 'attendance_corrections')!;
    // The seed captures rows through a legacy copy job. Release that unrelated
    // copy lock through its normal API before testing later live corrections.
    const legacy = await source.app.db.prepare("SELECT id FROM archive_jobs WHERE status IN ('parts','verify')").all<{ id: string }>();
    for (const job of legacy.results) await json(await source.app.request(`/api/admin/archives/${job.id}/cancel`, { token: source.app.token, body: {} }));
    await source.app.db.prepare("UPDATE students SET first_name='Renamed after publication' WHERE id=?").bind(event.row.student_id).run();
    const visit = await source.app.db.prepare('SELECT * FROM visits WHERE id=?').bind(event.row.visit_id).first<Record<string, unknown>>();
    await json(await source.app.request(`/api/admin/visits/${event.row.visit_id}/corrections`, {
      token: source.app.token,
      body: { correctionId: crypto.randomUUID(), expectedVersion: visit!.version,
        checkInAt: new Date(Date.parse(String(visit!.check_in_at)) + 1000).toISOString(),
        checkOutAt: new Date(Date.parse(String(visit!.check_out_at)) + 1000).toISOString(), reason: 'Later correction after publication' },
    }), 201);
    publishedSql = await snapshotPublicationDatabase(source.app);
    archivedSql = await snapshotPublicationDatabase(source.app, { omitTables: omitted });
  } finally { await source.app.close(); }
}, 60_000);

afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.close())); });

async function restore(options: { live?: boolean; transformRow?: PublicationSnapshotOptions['transformRow']; omitTables?: string[] } = {}) {
  let runtime = await restorePublicationDatabase(options.live ? publishedSql : archivedSql);
  if (options.transformRow || options.omitTables) {
    const sql = await snapshotPublicationDatabase(runtime, options);
    await runtime.close(); runtime = await restorePublicationDatabase(sql);
  }
  instances.push(runtime);
  const bucket = await runtime.runtime.getR2Bucket('BACKUP_BUCKET');
  for (const [key, bytes] of source.objects) await bucket.put(key, bytes);
  const calls: string[] = [];
  const storage: ArchiveRecordEvidenceStorage = { masterKey: source.key, bucket: { get: async (key: string) => {
    calls.push(key); return bucket.get(key);
  } } };
  return { runtime, db: runtime.db, bucket, calls, storage };
}

function request(record = event, withHash = false): HistoryRequest {
  return { id: record.key, centerId: String(record.row.center_id), kind: record.table === 'attendance_events' ? 'event' : 'correction',
    ...(withHash ? { payloadHash: String(record.row.payload_hash) } : {}) };
}
async function assertTwoReads(fixture: Restored, record = event) {
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls[0]).toBe(source.archive.objectKey);
  const locator = await fixture.db.prepare('SELECT r.part_index FROM archive_publication_records r JOIN archive_publication_requests q ON q.publication_id=r.publication_id AND q.table_name=r.table_name AND q.record_key=r.record_key WHERE q.request_id=?').bind(record.key).first<{ part_index: number }>();
  expect(fixture.calls[1]).toBe(source.archive.manifest.parts[locator!.part_index].objectKey);
}

async function reset(app: TestRuntime) {
  await app.db.batch(resetStatements.map(sql => app.db.prepare(sql)));
}

async function reconcileRestored(app: TestRuntime, evidence: Source, storage: ArchiveRecordEvidenceStorage, record = event) {
  const publication = await app.db.prepare('SELECT * FROM archive_publications').first<Record<string, unknown>>();
  const unavailableState = await app.db.prepare('SELECT * FROM archive_publication_availability').first();
  expect(unavailableState).toMatchObject({ status: 'unavailable' });
  await expect(resolveHistoryRequest(app.db, request(record, true), storage)).rejects.toMatchObject(unavailable);
  const fresh = await refreshPublicationProof(app, evidence);
  expect(fresh.handle.generation).not.toBe(publication!.generation);
  expect(await app.db.prepare('SELECT * FROM archive_publication_availability').first()).toEqual(unavailableState);
  await expect(resolveHistoryRequest(app.db, request(record, true), storage)).rejects.toMatchObject(unavailable);
  const handle = await startPublicationReconciliation(app.db, String(publication!.publication_id), fresh.handle);
  let revision = 0, complete = false;
  for (let step = 0; step < 500; step++) {
    expect(await app.db.prepare('SELECT * FROM archive_publication_availability').first()).toEqual(unavailableState);
    const result = await advancePublicationReconciliation(app.db, storage, handle, { expectedRevision: revision });
    expect(result.busy).toBe(false);
    revision = result.revision;
    if (result.state === 'complete') { complete = true; break; }
    expect(result.state).toBe('pending');
    await expect(resolveHistoryRequest(app.db, request(record), storage)).rejects.toMatchObject(unavailable);
  }
  expect(complete).toBe(true);
  expect(await app.db.prepare('SELECT * FROM archive_publications').first()).toEqual(publication);
  expect(await app.db.prepare('SELECT * FROM archive_publication_availability').first()).toEqual({
    publication_id: publication!.publication_id, generation: fresh.handle.generation, status: 'ready', reconciliation_id: handle.reconciliationId,
  });
  expect(await app.db.prepare('SELECT * FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?').bind(handle.reconciliationId).first()).toMatchObject({
    reconciliation_id: handle.reconciliationId, publication_id: publication!.publication_id, execution_generation: fresh.handle.generation,
    verification_id: fresh.handle.verificationId, run_id: fresh.handle.runId, snapshot_commit_token: fresh.handle.commitToken,
    graph_sha256: fresh.handle.graphSha256, locator_digest: publication!.locator_digest,
  });
  return { handle, publication };
}

describe('internal exact published request resolution', () => {
  it('requires fresh reconciliation after recovery, rechecks its receipt identity, and invalidates it on another reset', async () => {
    const archived = await restore();
    const original = await archived.db.prepare('SELECT * FROM archive_publications').first();
    await reset(archived.runtime);
    const { handle } = await reconcileRestored(archived.runtime, source, archived.storage);
    for (const record of [event, correction, unmatched]) {
      archived.calls.length = 0;
      expect(await resolveHistoryRequest(archived.db, request(record, true), archived.storage)).toEqual(record.row);
      await assertTwoReads(archived, record);
    }
    expect((await resolveHistoryRequest(archived.db, request(unmatched), archived.storage))!.result_visit).toBe('null');
    expect(await archived.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
    expect(await archived.db.prepare('SELECT count(*) AS n FROM attendance_corrections').first('n')).toBe(0);
    const receipt = await archived.db.prepare('SELECT * FROM archive_publication_reconciliation_receipts').first();
    // Model replacement by an isolated restored DB before its guards are
    // installed. Only the selected availability receipt identity changes.
    const replacementId = crypto.randomUUID();
    const replacementSql = await snapshotPublicationDatabase(archived.runtime, { transformRow: (table, row) =>
      ['archive_publication_reconciliation_jobs', 'archive_publication_reconciliation_receipts', 'archive_publication_availability'].includes(table)
        && row.reconciliation_id === handle.reconciliationId ? { ...row, reconciliation_id: replacementId } : row });
    const replacement = await restorePublicationDatabase(replacementSql); instances.push(replacement);
    expect((await replacement.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    let current = archived.db;
    const db = { prepare: (sql: string) => current.prepare(sql), batch: <T>(statements: IsolatedStatement[]) => current.batch<T>(statements) };
    const swappingStorage = { masterKey: source.key, bucket: { get: async (key: string) => { current = replacement.db; return archived.bucket.get(key); } } };
    await expect(resolveHistoryRequest(db, request(), swappingStorage)).rejects.toMatchObject(unavailable);
    await reset(archived.runtime);
    expect(await archived.db.prepare('SELECT * FROM archive_publications').first()).toEqual(original);
    expect(await archived.db.prepare('SELECT * FROM archive_publication_reconciliation_receipts').first()).toEqual(receipt);
    expect(await archived.db.prepare('SELECT * FROM archive_publication_availability').first()).toMatchObject({ status: 'unavailable', reconciliation_id: handle.reconciliationId });
    await expect(resolveHistoryRequest(archived.db, request(), archived.storage)).rejects.toMatchObject(unavailable);
  }, 60_000);

  it('preserves original event/correction/null receipts through live and archived paths after rename and later correction', async () => {
    const live = await restore({ live: true }), archived = await restore();
    for (const record of [event, correction, unmatched]) {
      live.calls.length = 0; archived.calls.length = 0;
      const fromLive = await resolveHistoryRequest(live.db, request(record, true), live.storage);
      const fromArchive = await resolveHistoryRequest(archived.db, request(record, true), archived.storage);
      expect(fromLive).toEqual(record.row);
      expect(fromArchive).toEqual(record.row);
      expect(live.calls).toEqual([]);
      await assertTwoReads(archived, record);
    }
    expect((await resolveHistoryRequest(archived.db, request(unmatched), archived.storage))!.result_visit).toBe('null');
    expect(await archived.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
    expect(await archived.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='attendance_events'").first('n')).toBeGreaterThan(0);
  });

  it('retains public-call live-only behavior when archive storage is omitted', async () => {
    const archived = await restore();
    await expect(resolveHistoryRequest(archived.db, request())).rejects.toMatchObject(unavailable);
    expect(archived.calls).toEqual([]);
  });

  it('resolves published evidence after all private semantic staging and proof rows are gone', async () => {
    const inventory = await restore();
    const staged = await inventory.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'archive_semantic_%'").all<{ name: string }>();
    expect(staged.results.length).toBeGreaterThan(5);
    const archived = await restore({ omitTables: staged.results.map(row => row.name) });
    expect((await archived.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await archived.db.prepare('SELECT count(*) AS n FROM archive_semantic_sessions').first('n')).toBe(0);
    expect(await archived.db.prepare('SELECT count(*) AS n FROM archive_semantic_runs').first('n')).toBe(0);
    expect(await archived.db.prepare('SELECT count(*) AS n FROM archive_publications').first('n')).toBe(1);
    expect(await resolveHistoryRequest(archived.db, request(), archived.storage)).toEqual(event.row);
    await assertTwoReads(archived);
  });

  it('preserves a legacy object-format receipt byte for byte through publication and restored reconciliation', async () => {
    const records = structuredClone(source.seed.records), original = await restorePublicationDatabase(source.seed.sourceSql);
    let sourceSql: string;
    try {
      for (const record of records) if (record.table === 'attendance_events' && record.row.visit_id !== null) {
        const row = record.row;
        row.result_visit = JSON.stringify(decodeAttendanceReceipt({ visit_id: row.visit_id, student_id: row.student_id, action: row.action, observed_at: row.observed_at, result_visit: row.result_visit }));
      }
      const receipts = new Map(records.filter(record => record.table === 'attendance_events').map(record => [record.key, record.row.result_visit]));
      sourceSql = await snapshotPublicationDatabase(original, { transformRow: (table, row) => table === 'attendance_events' ? { ...row, result_visit: receipts.get(String(row.id)) } : row });
    } finally { await original.close(); }
    const legacy = await createPublicationFixture({ ...source.seed, records, sourceSql });
    let sql: string;
    try { await publish(legacy); sql = await snapshotPublicationDatabase(legacy.app, { omitTables: omitted }); }
    finally { await legacy.app.close(); }
    const restored = await restorePublicationDatabase(sql); instances.push(restored);
    const bucket = await restored.runtime.getR2Bucket('BACKUP_BUCKET');
    for (const [key, bytes] of legacy.objects) await bucket.put(key, bytes);
    const saved = records.find(record => record.table === 'attendance_events' && record.key === event.key)!;
    await reset(restored);
    await reconcileRestored(restored, legacy, { bucket, masterKey: legacy.key }, saved);
    const result = await resolveHistoryRequest(restored.db, request(saved, true), { bucket, masterKey: legacy.key });
    expect(String(saved.row.result_visit).startsWith('{')).toBe(true);
    expect(result).toEqual(saved.row);
    expect(result!.result_visit).toBe(saved.row.result_visit);
  });

  it('treats retained source audit rows as aliases of the permanent event owner', async () => {
    // Current storage projects attendance audits from source rows. Restore one
    // older physical alias before guards are installed to exercise coexistence.
    const alias = source.records.find(record => record.table === 'audit_entries' && record.key === event.key)!;
    const archived = await restore({ transformRow: (table, row) => table === 'audit_entries' && row.action === 'archive_cancelled' ? alias.row : row });
    expect(await archived.db.prepare('SELECT id FROM audit_entries WHERE id=?').bind(event.key).first('id')).toBe(event.key);
    expect(await resolveHistoryRequest(archived.db, request(), archived.storage)).toEqual(event.row);
    await assertTwoReads(archived);
  });

  it('checks changed payload and foreign ownership before attempting unavailable R2', async () => {
    const archived = await restore();
    archived.storage.bucket.get = async () => { throw new Error('Object store unavailable'); };
    await expect(resolveHistoryRequest(archived.db, { ...request(), payloadHash: Buffer.alloc(32, 17).toString('base64') }, archived.storage)).rejects.toMatchObject({ status: 409, code: 'EVENT_ID_REUSED' });
    for (const foreign of [{ ...request(), centerId: 'other-center' }, { ...request(), kind: 'correction' as const }]) {
      expect(await resolveHistoryRequest(archived.db, foreign, archived.storage)).toBeNull();
      await expect(resolveHistoryRequest(archived.db, { ...foreign, payloadHash: String(event.row.payload_hash) }, archived.storage)).rejects.toMatchObject({ status: 409 });
    }
    expect(archived.calls).toEqual([]);
  });

  it('distinguishes a truly unused ID from a permanently owned ID missing its publication claim', async () => {
    const archived = await restore({ transformRow: (table, row) => table === 'archive_publication_requests' && row.request_id === event.key ? null : row });
    await expect(resolveHistoryRequest(archived.db, request(), archived.storage)).rejects.toMatchObject(unavailable);
    expect(await resolveHistoryRequest(archived.db, { ...request(), id: crypto.randomUUID(), payloadHash: String(event.row.payload_hash) }, archived.storage)).toBeNull();
    expect(archived.calls).toEqual([]);
  });

  it('does not mask invalid retained receipts with a valid archived copy', async () => {
    const live = await restore({ live: true, transformRow: (table, row) => table === 'attendance_events' && row.id === event.key ? { ...row, result_visit: 'null' } : row });
    await expect(resolveHistoryRequest(live.db, request(), live.storage)).rejects.toMatchObject(unavailable);
    expect(live.calls).toEqual([]);
  });

  it.each(['missing manifest', 'missing part', 'corrupt part', 'wrong key'] as const)('fails closed for %s', async failure => {
    const archived = await restore();
    const part = source.archive.manifest.parts.find(part => source.objects.has(part.objectKey))!;
    if (failure === 'missing manifest') await archived.bucket.delete(source.archive.objectKey);
    if (failure === 'missing part') await archived.bucket.delete(part.objectKey);
    if (failure === 'corrupt part') { const bytes = source.objects.get(part.objectKey)!.slice(); bytes[bytes.length - 1] ^= 1; await archived.bucket.put(part.objectKey, bytes); }
    if (failure === 'wrong key') archived.storage.masterKey = Buffer.alloc(32, 29).toString('base64');
    await expect(resolveHistoryRequest(archived.db, request(), archived.storage)).rejects.toMatchObject(unavailable);
    expect(archived.calls.length).toBeGreaterThan(0);
    expect(archived.calls.length).toBeLessThanOrEqual(2);
  });

  it.each(['wrong row hash', 'claim fingerprint mismatch', 'unavailable publication', 'old availability generation'] as const)('fails closed for %s in a restored snapshot', async failure => {
    const archived = await restore({ transformRow: (table, row) => {
      if (failure === 'wrong row hash' && table === 'archive_publication_records' && row.record_key === event.key && row.table_name === 'attendance_events') return { ...row, record_sha256: '0'.repeat(64) };
      if (failure === 'claim fingerprint mismatch' && table === 'archive_publication_requests' && row.request_id === event.key) return { ...row, payload_hash: Buffer.alloc(32, 31).toString('base64') };
      if (table === 'archive_publication_availability') {
        if (failure === 'unavailable publication') return { ...row, status: 'unavailable' };
        if (failure === 'old availability generation') return { ...row, generation: 'prior-recovery-generation' };
      }
      return row;
    } });
    await expect(resolveHistoryRequest(archived.db, request(), archived.storage)).rejects.toMatchObject(unavailable);
    expect(archived.calls).toHaveLength(failure === 'wrong row hash' ? 2 : 0);
  });

  it('rejects candidate locators that have no committed descriptor', async () => {
    const archived = await restore({ omitTables: ['archive_publications', 'archive_publication_availability'] });
    await expect(resolveHistoryRequest(archived.db, request(), archived.storage)).rejects.toMatchObject(unavailable);
    expect(archived.calls).toEqual([]);
  });

  it.each(['runtime', 'availability'] as const)('rechecks %s after object reads', async field => {
    const archived = await restore();
    archived.storage.bucket.get = async (key: string) => {
      archived.calls.push(key);
      if (archived.calls.length === 1) {
        if (field === 'runtime') await archived.db.prepare("UPDATE history_runtime SET generation='recovered-during-request' WHERE id=1").run();
        else await archived.db.prepare("UPDATE archive_publication_availability SET status='unavailable'").run();
      }
      return archived.bucket.get(key);
    };
    await expect(resolveHistoryRequest(archived.db, request(), archived.storage)).rejects.toMatchObject(unavailable);
    await assertTwoReads(archived);
  });

  it.each(['registry', 'locator', 'live authority'] as const)('rechecks %s when recovery replaces the database during R2 access', async field => {
    const archived = await restore(), replacement = await restore({ live: field === 'live authority', transformRow: (table, row) => {
      if (field === 'registry' && table === 'history_request_keys' && row.request_id === event.key) return { ...row, payload_hash: Buffer.alloc(32, 41).toString('base64') };
      if (field === 'locator' && table === 'archive_publication_records' && row.record_key === event.key && row.table_name === 'attendance_events') return { ...row, record_sha256: '1'.repeat(64) };
      return row;
    } });
    let current = archived.db;
    const db = { prepare: (sql: string) => current.prepare(sql), batch: <T>(statements: IsolatedStatement[]) => current.batch<T>(statements) };
    archived.storage.bucket.get = async (key: string) => { archived.calls.push(key); current = replacement.db; return archived.bucket.get(key); };
    await expect(resolveHistoryRequest(db, request(), archived.storage)).rejects.toMatchObject(unavailable);
    await assertTwoReads(archived);
  });

  it('snapshots a caller-owned request before its first asynchronous lookup', async () => {
    const archived = await restore(), supplied = request();
    const pending = resolveHistoryRequest(archived.db, supplied, archived.storage);
    supplied.id = correction.key; supplied.kind = 'correction'; supplied.centerId = 'other-center';
    expect(await pending).toEqual(event.row);
    await assertTwoReads(archived);
  });

  it('uses indexed bounded reads as unrelated permanent requests grow', async () => {
    const archived = await restore();
    async function measure() {
      let statements = 0, rowsRead = 0, rowsWritten = 0;
      const db = { prepare: (sql: string) => archived.db.prepare(sql), batch: async <T>(batch: IsolatedStatement[]) => {
        statements += batch.length; const results = await archived.db.batch<T>(batch);
        for (const result of results) { rowsRead += result.meta.rows_read; rowsWritten += result.meta.rows_written; }
        return results;
      } };
      expect(await resolveHistoryRequest(db, request(), archived.storage)).toEqual(event.row);
      return { statements, rowsRead, rowsWritten };
    }
    const before = await measure();
    await archived.db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<5000)
      INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
      SELECT 'unrelated-publication-'||printf('%06d',n),'test-center',NULL,'Synthetic fixture','history_fixture','center','test-center','{}','2024-01-01T00:00:00.000Z' FROM sequence`).run();
    const after = await measure();
    expect(after.statements).toBe(12);
    expect(after.statements).toBe(before.statements);
    expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 2);
    expect(after.rowsWritten).toBe(0);
    const selection = publishedRequestStatement(archived.db, event.key);
    const plan = await archived.db.prepare(`EXPLAIN QUERY PLAN ${selection.sql}`).bind(...selection.args).all<{ detail: string }>();
    expect(plan.results.some(row => /SCAN\s/i.test(row.detail))).toBe(false);
    for (const alias of ['q', 'p', 'r', 'a']) expect(plan.results.some(row => row.detail.includes(`SEARCH ${alias} USING PRIMARY KEY`))).toBe(true);
  });
});
