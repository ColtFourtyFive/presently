import { readFileSync } from 'node:fs';
import { unstable_splitSqlQuery } from 'wrangler';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advanceCompactMonthlyPublication, startCompactMonthlyPublication } from '../worker/archive-compact-publication';
import {
  advanceCompactPublicationReconciliation,
  startCompactPublicationReconciliation,
  type CompactReconciliationHandle,
} from '../worker/archive-compact-reconciliation';
import type { ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';
import { resolveHistoryRequest } from '../worker/history-request';
import {
  createPublicationFixture,
  createPublicationSeed,
  refreshPublicationProof,
  restorePublicationDatabase,
  snapshotPublicationDatabase,
  type PublicationSnapshotOptions,
} from './archive-publication-fixture';
import type { TestRuntime } from './runtime';

type Fixture = Awaited<ReturnType<typeof createPublicationFixture>>;
type RecordFixture = Fixture['records'][number];
type Restored = Awaited<ReturnType<typeof restore>>;

const opened: TestRuntime[] = [];
const omittedSources = ['attendance_events', 'attendance_corrections', 'reviews'];
const resetStatements = unstable_splitSqlQuery(readFileSync(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8'));
let fixture: Fixture;
let publicationId: string;
let archivedSql: string;
let event: RecordFixture;
let correction: RecordFixture;

async function publish(app: TestRuntime) {
  const handle = await startCompactMonthlyPublication(app.db, fixture.handle);
  let revision = 0;
  for (let step = 0; step < 100; step += 1) {
    const result = await advanceCompactMonthlyPublication(app.db, handle, { expectedRevision: revision });
    revision = result.revision;
    if (result.state === 'published') return handle;
    if (result.state !== 'building') throw new Error(`Compact publication stopped: ${result.state}`);
  }
  throw new Error('Compact publication did not finish');
}

beforeAll(async () => {
  fixture = await createPublicationFixture(await createPublicationSeed());
  publicationId = (await publish(fixture.app)).publicationId;
  archivedSql = await snapshotPublicationDatabase(fixture.app, { omitTables: omittedSources });
  event = fixture.records.find(record => record.table === 'attendance_events' && record.row.result_visit === 'null')
    ?? fixture.records.find(record => record.table === 'attendance_events')!;
  correction = fixture.records.find(record => record.table === 'attendance_corrections')!;
}, 120_000);

afterAll(async () => { await fixture?.app.close(); });
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function restore(options: { transformRow?: PublicationSnapshotOptions['transformRow'] } = {}) {
  let sql = archivedSql;
  if (options.transformRow) {
    sql = await snapshotPublicationDatabase(fixture.app, { omitTables: omittedSources, transformRow: options.transformRow });
  }
  const app = await restorePublicationDatabase(sql);
  opened.push(app);
  const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  for (const [key, bytes] of fixture.objects) await bucket.put(key, bytes);
  await app.db.batch(resetStatements.map(statement => app.db.prepare(statement)));
  const fresh = await refreshPublicationProof(app, fixture);
  const calls: string[] = [];
  const storage: ArchiveRecordEvidenceStorage = {
    masterKey: fixture.key,
    bucket: {
      get: async key => {
        calls.push(key);
        return bucket.get(key);
      },
    },
  };
  return { app, db: app.db, bucket, fresh, calls, storage };
}

async function finish(value: Restored, handle?: CompactReconciliationHandle) {
  const selected = handle ?? await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle);
  let revision = 0;
  for (let step = 0; step < 200; step += 1) {
    const result = await advanceCompactPublicationReconciliation(value.db, value.storage, selected, { expectedRevision: revision });
    expect(result.processed).toBeLessThanOrEqual(8);
    expect(result.busy).toBe(false);
    revision = result.revision;
    if (result.state === 'complete') return { handle: selected, result };
    if (result.state !== 'pending') throw new Error(`Compact reconciliation stopped: ${result.state}`);
  }
  throw new Error('Compact reconciliation did not finish');
}

describe('schema29 compact restored publication reconciliation', () => {
  it('requires a fresh two-way receipt before source-free event and correction replay', async () => {
    const value = await restore();
    expect(await value.db.prepare('SELECT max(version) n FROM schema_versions').first<number>('n')).toBe(42);
    expect(await value.db.prepare('SELECT generation,status,reconciliation_id FROM archive_compact_availability WHERE publication_id=?')
      .bind(publicationId).first()).toMatchObject({ generation: value.fresh.handle.generation, status: 'unavailable', reconciliation_id: null });
    value.calls.length = 0;
    await expect(resolveHistoryRequest(value.db, {
      id: event.key, centerId: String(event.row.center_id), kind: 'event',
    }, value.storage)).rejects.toMatchObject({ status: 503, code: 'HISTORY_EVIDENCE_UNAVAILABLE' });
    expect(value.calls).toEqual([]);
    await expect(value.db.prepare("UPDATE archive_compact_availability SET status='ready' WHERE publication_id=?")
      .bind(publicationId).run()).rejects.toThrow('ARCHIVE_COMPACT_AVAILABILITY_INVALID');

    const { handle } = await finish(value);
    expect(await value.db.prepare('SELECT generation,status,reconciliation_id FROM archive_compact_availability WHERE publication_id=?')
      .bind(publicationId).first()).toEqual({ generation: handle.generation, status: 'ready', reconciliation_id: handle.reconciliationId });
    expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(1);
    const counters = JSON.parse(String(await value.db.prepare('SELECT counters_json FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=?')
      .bind(handle.reconciliationId).first('counters_json')));
    const requestCount = fixture.records.filter(record => record.table === 'attendance_events' || record.table === 'attendance_corrections').length;
    expect(counters).toMatchObject({ records: fixture.records.length, requests: requestCount, catalogRequests: requestCount });

    for (const record of [event, correction]) {
      value.calls.length = 0;
      expect(await resolveHistoryRequest(value.db, {
        id: record.key,
        centerId: String(record.row.center_id),
        kind: record.table === 'attendance_events' ? 'event' : 'correction',
        payloadHash: String(record.row.payload_hash),
      }, value.storage)).toEqual(record.row);
      expect(value.calls).toHaveLength(2);
    }
  });

  it('fails closed when a compact map member is missing', async () => {
    const value = await restore({
      transformRow: (table, row) => table === 'archive_compact_requests' && row.request_id === event.key ? null : row,
    });
    const handle = await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle);
    let revision = 0;
    let rejected = false;
    for (let step = 0; step < 100 && !rejected; step += 1) {
      try {
        const result = await advanceCompactPublicationReconciliation(value.db, value.storage, handle, { expectedRevision: revision });
        revision = result.revision;
      } catch { rejected = true; }
    }
    expect(rejected).toBe(true);
    expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(0);
    expect(await value.db.prepare('SELECT status FROM archive_compact_availability WHERE publication_id=?').bind(publicationId).first('status')).toBe('unavailable');
  });

  it('fails closed when a compact map member claims an audit record', async () => {
    const requestIds = new Set(fixture.records
      .filter(record => record.table === 'attendance_events' || record.table === 'attendance_corrections')
      .map(record => record.key));
    const audit = fixture.records.find(record => record.table === 'audit_entries' && !requestIds.has(record.key))!;
    expect(audit).toBeDefined();
    const value = await restore({
      transformRow: (table, row) => table === 'archive_compact_requests' && row.request_id === event.key
        ? { ...row, request_id: audit.key }
        : row,
    });
    const handle = await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle);
    let revision = 0;
    let rejected = false;
    for (let step = 0; step < 100 && !rejected; step += 1) {
      try {
        const result = await advanceCompactPublicationReconciliation(value.db, value.storage, handle, { expectedRevision: revision });
        revision = result.revision;
      } catch { rejected = true; }
    }
    expect(rejected).toBe(true);
    expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(0);
  });

  it('does not mint a receipt from missing or corrupt encrypted evidence', async () => {
    for (const failure of ['manifest', 'part'] as const) {
      const value = await restore();
      const handle = await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle);
      if (failure === 'manifest') await value.bucket.delete(fixture.archive.objectKey);
      else {
        const part = fixture.archive.manifest.parts[0];
        const bytes = fixture.objects.get(part.objectKey)!.slice();
        bytes[bytes.length - 1] ^= 1;
        await value.bucket.put(part.objectKey, bytes);
      }
      await expect(advanceCompactPublicationReconciliation(value.db, value.storage, handle, { expectedRevision: 0 })).rejects.toThrow();
      expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(0);
      await value.app.close();
      opened.splice(opened.indexOf(value.app), 1);
    }
  });

  it('retains receipts but revokes readiness and invalidates unfinished work on the next recovery', async () => {
    const value = await restore();
    const completed = await finish(value);
    const pending = await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle, crypto.randomUUID())
      .catch(() => null);
    expect(pending).toBeNull();
    const receipt = await value.db.prepare('SELECT * FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=?')
      .bind(completed.handle.reconciliationId).first();
    await value.db.batch(resetStatements.map(statement => value.db.prepare(statement)));
    expect(await value.db.prepare('SELECT * FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=?')
      .bind(completed.handle.reconciliationId).first()).toEqual(receipt);
    expect(await value.db.prepare('SELECT status,reconciliation_id FROM archive_compact_availability WHERE publication_id=?')
      .bind(publicationId).first()).toEqual({ status: 'unavailable', reconciliation_id: null });
  });

  it('invalidates pending work and clears its lease when recovery generation changes', async () => {
    const value = await restore();
    const handle = await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle);
    const progress = await advanceCompactPublicationReconciliation(value.db, value.storage, handle, { expectedRevision: 0 });
    expect(progress.state).toBe('pending');
    await value.db.batch(resetStatements.map(statement => value.db.prepare(statement)));
    expect(await value.db.prepare('SELECT state,lease_token,lease_expires_at FROM archive_compact_reconciliation_jobs WHERE reconciliation_id=?')
      .bind(handle.reconciliationId).first()).toEqual({ state: 'invalid', lease_token: null, lease_expires_at: null });
    expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(0);
    expect(await value.db.prepare('SELECT status,reconciliation_id FROM archive_compact_availability WHERE publication_id=?')
      .bind(publicationId).first()).toEqual({ status: 'unavailable', reconciliation_id: null });
  });

  it('fails the in-flight commit if recovery changes generation during encrypted reads', async () => {
    const value = await restore();
    const handle = await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle);
    const originalGet = value.storage.bucket.get;
    let changed = false;
    value.storage.bucket.get = async key => {
      const result = await originalGet(key);
      if (!changed) {
        changed = true;
        await value.db.prepare("UPDATE history_runtime SET generation='changed-during-compact-reconciliation' WHERE id=1").run();
      }
      return result;
    };
    await expect(advanceCompactPublicationReconciliation(value.db, value.storage, handle, { expectedRevision: 0 })).rejects.toThrow();
    expect(await value.db.prepare('SELECT state FROM archive_compact_reconciliation_jobs WHERE reconciliation_id=?')
      .bind(handle.reconciliationId).first('state')).toBe('invalid');
    expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(0);
  });

  it('rejects forged job completion, receipt, and ready projection', async () => {
    const value = await restore();
    const handle = await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle);
    await expect(value.db.prepare(`UPDATE archive_compact_reconciliation_jobs
      SET state='complete',phase='complete',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE reconciliation_id=?`).bind(handle.reconciliationId).run()).rejects.toThrow('ARCHIVE_COMPACT_RECONCILIATION_JOB_INVALID');
    await expect(value.db.prepare(`INSERT INTO archive_compact_reconciliation_receipts(
      reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,
      descriptor_json,descriptor_sha256,expected_parts,counters_json,evidence_digest,completed_at)
      SELECT reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,
        descriptor_json,descriptor_sha256,expected_parts,counters_json,evidence_digest,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM archive_compact_reconciliation_jobs WHERE reconciliation_id=?`).bind(handle.reconciliationId).run())
      .rejects.toThrow('ARCHIVE_COMPACT_RECONCILIATION_RECEIPT_INVALID');
    expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(0);
    await expect(value.db.prepare("UPDATE archive_compact_availability SET status='ready',reconciliation_id=? WHERE publication_id=?")
      .bind(handle.reconciliationId, publicationId).run()).rejects.toThrow('ARCHIVE_COMPACT_AVAILABILITY_INVALID');
  });

  it('is idempotent after completion and keeps one immutable receipt', async () => {
    const value = await restore();
    const { handle, result } = await finish(value);
    expect(await advanceCompactPublicationReconciliation(value.db, value.storage, handle, { expectedRevision: result.revision }))
      .toMatchObject({ state: 'complete', processed: 0, busy: false, ready: true });
    expect(await startCompactPublicationReconciliation(value.db, publicationId, value.fresh.handle, handle.reconciliationId)).toEqual(handle);
    expect(await value.db.prepare('SELECT count(*) n FROM archive_compact_reconciliation_receipts').first<number>('n')).toBe(1);
    await expect(value.db.prepare('UPDATE archive_compact_reconciliation_receipts SET evidence_digest=? WHERE reconciliation_id=?')
      .bind('1'.repeat(64), handle.reconciliationId).run()).rejects.toThrow();
    await expect(value.db.prepare('UPDATE archive_compact_availability SET reconciliation_id=NULL WHERE publication_id=?')
      .bind(publicationId).run()).rejects.toThrow();
  });
});
