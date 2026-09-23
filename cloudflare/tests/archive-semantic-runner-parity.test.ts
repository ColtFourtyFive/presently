import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchiveMetadata, ArchiveRecord, ArchiveReference } from '../shared/archive-format';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { decodeAttendanceReceipt } from '../worker/attendance-receipt';
import { verifyArchiveSemantics } from '../worker/archive-semantics';
import { D1ArchiveSemanticStaging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { startMonthlySemanticVerification, advanceMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { createRuntime, projectRoot, type IsolatedStatement, type TestRuntime } from './runtime';

let source: Awaited<ReturnType<typeof nativeSemanticFixture>>;
let destination: TestRuntime;
let queryCount = 0;
const measurements: { accepted: boolean; calls: number; maximumStatements: number }[] = [];
const database: ArchiveStagingDatabase<IsolatedStatement> = {
  prepare(sql) { return destination.db.prepare(sql); },
  async batch<T = Record<string, unknown>>(statements: IsolatedStatement[]) {
    queryCount += statements.length;
    return destination.db.batch<T>(statements);
  },
};

beforeAll(async () => {
  source = await nativeSemanticFixture(13);
}, 60_000);
beforeEach(async () => { destination = await createRuntime({ bindings: {} }); });
afterEach(async () => { await destination.close(); });
afterAll(async () => {
  await mkdir(join(projectRoot, 'tmp'), { recursive: true });
  await writeFile(join(projectRoot, 'tmp/semantic-runner-parity-metrics.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), scope: 'Independent native local D1 verification after source D1 closed; no deployed CPU measurement.',
    sourceCounts: Object.fromEntries([...new Set(source?.records.map(record => record.table) ?? [])].map(table => [table, source.records.filter(record => record.table === table).length])),
    measurements,
  }, null, 2) + '\n');
});

async function staged(records: ArchiveRecord[], metadata: ArchiveMetadata) {
  const objects = new Map<string, Uint8Array>();
  const sealed = await createArchive(source.key, metadata, records.sort(compareArchiveRecords), async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const root: ArchiveReference = { archiveId: sealed.manifest.archiveId, kind: sealed.manifest.kind, manifestObjectKey: sealed.objectKey, manifestSha256: sealed.sha256 };
  const target = await D1ArchiveSemanticStaging.create(database, source.key, root);
  await target.registerManifest(root, sealed.encrypted);
  for (const part of sealed.manifest.parts) await target.stageEncryptedPart(sealed.manifest.archiveId, part.index, objects.get(part.objectKey)!);
  const snapshot = await target.freeze();
  return { target, snapshot, manifest: sealed.manifest };
}

async function checkBoth(records: ArchiveRecord[], metadata: ArchiveMetadata, shouldPass: boolean) {
  const { target, snapshot, manifest } = await staged(records, metadata);
  let oracleError: unknown;
  try { await verifyArchiveSemantics([manifest], snapshot.semanticStore); } catch (error) { oracleError = error; }
  expect(oracleError === undefined, String(oracleError)).toBe(shouldPass);
  const handle = await startMonthlySemanticVerification(database, { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
  let runnerError: unknown, complete = false, steps = 0, maxQueries = 0;
  try {
    for (; steps < 2_000; steps++) {
      queryCount = 0;
      const result = await advanceMonthlySemanticVerification(database, handle);
      maxQueries = Math.max(maxQueries, queryCount);
      expect(queryCount).toBeLessThanOrEqual(40);
      expect(result.queries).toBe(queryCount);
      if (result.status === 'complete') { complete = true; break; }
      expect(result.status).toBe('pending');
    }
  } catch (error) { runnerError = error; }
  maxQueries = Math.max(maxQueries, queryCount);
  expect(queryCount).toBeLessThanOrEqual(40);
  expect(complete, String(runnerError)).toBe(shouldPass);
  if (shouldPass) {
    expect(runnerError).toBeUndefined();
    expect(steps).toBeGreaterThan(10);
    queryCount = 0;
    const replay = await advanceMonthlySemanticVerification(database, handle);
    expect(replay.status).toBe('complete');
    expect(queryCount).toBeLessThanOrEqual(40);
    expect(await destination.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(target.handle.verificationId).first('status')).toBe('verified');
  } else {
    expect(runnerError).toBeInstanceOf(Error);
    expect(String(runnerError)).toContain('Invalid historical evidence:');
    expect(await destination.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(target.handle.verificationId).first('status')).toBe('invalid');
  }
  // Verification is private and cannot manufacture live attendance or publication authority.
  for (const table of ['attendance_events', 'attendance_corrections', 'visits', 'history_record_locations', 'archive_jobs']) {
    expect(await destination.db.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
  }
  measurements.push({ accepted: shouldPass, calls: steps + 1, maximumStatements: maxQueries });
  return { steps, maxQueries };
}

const first = (records: ArchiveRecord[], table: ArchiveRecord['table']) => records.find(record => record.table === table)!.row;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64');

describe('independent native monthly-runner equivalence to complete semantic verification', () => {
  it('verifies native accepted receipts, regular pickup, unmatched departure, 13 corrections and resolved reviews after source D1 is gone', async () => {
    const result = await checkBoth(structuredClone(source.records), structuredClone(source.metadata), true);
    expect(result.maxQueries).toBeGreaterThan(0);
  }, 120_000);

  it('preserves full legacy receipts and explicitly permitted hex request fingerprints', async () => {
    const records = structuredClone(source.records), metadata = structuredClone(source.metadata);
    for (const record of records) if (record.table === 'attendance_events' || record.table === 'attendance_corrections') {
      record.row.payload_hash = Buffer.from(String(record.row.payload_hash), 'base64').toString('hex');
      if (record.table === 'attendance_events') record.row.result_visit = JSON.stringify(decodeAttendanceReceipt(record.row as Parameters<typeof decodeAttendanceReceipt>[0]));
    }
    metadata.semanticProof!.payloadHashEncoding = 'base64-or-hex';
    await checkBoth(records, metadata, true);
  }, 120_000);

  it('accepts later resolution attempts while retaining the exact original review witness', async () => {
    const records = structuredClone(source.records), metadata = structuredClone(source.metadata);
    const audit = structuredClone(records.find(record => record.table === 'audit_entries' && record.row.action === 'review_resolved')!);
    audit.key = crypto.randomUUID(); audit.row.id = audit.key;
    audit.row.created_at = new Date(Date.parse(String(audit.row.created_at)) + 1).toISOString();
    audit.row.detail = JSON.stringify({ resolution: 'Later documented resolution attempt' });
    metadata.createdAt = new Date(Date.parse(metadata.createdAt) + 5_000).toISOString();
    records.push(audit);
    await checkBoth(records, metadata, true);
  }, 120_000);

  const invalid: { name: string; mutate(records: ArchiveRecord[], metadata: ArchiveMetadata): void }[] = [
    { name: 'missing pickup relationship context', mutate(records) {
      const departure = records.find(record => record.table === 'attendance_events' && record.row.action === 'check_out')!;
      const index = records.findIndex(record => record.table === 'guardians' && record.key === departure.row.guardian_id);
      records.splice(index, 1);
    } },
    { name: 'changed source request fingerprint', mutate(records) { first(records, 'attendance_events').payload_hash = Buffer.alloc(32, 9).toString('base64'); } },
    { name: 'SQL-null unsealed unmatched receipt', mutate(records) {
      records.find(record => record.table === 'attendance_events' && record.row.visit_id === null)!.row.result_visit = null;
    } },
    { name: 'missing kiosk ownership context', mutate(_records, metadata) { metadata.semanticProof!.deviceContexts = []; } },
    { name: 'incorrect final visit version', mutate(records) { first(records, 'visits').version = Number(first(records, 'visits').version) + 1; } },
    { name: 'receipt from a different student', mutate(records) {
      const event = records.find(record => record.table === 'attendance_events' && record.row.action === 'check_in')!.row;
      const receipt = decodeAttendanceReceipt(event as Parameters<typeof decodeAttendanceReceipt>[0])!;
      receipt.studentId = 'another-student'; event.result_visit = JSON.stringify(receipt);
    } },
    { name: 'correction version gap with valid recomputed input hash', mutate(records) {
      const correction = first(records, 'attendance_corrections');
      correction.expected_version = 400;
      correction.payload_hash = hash({ visitId: correction.visit_id, expectedVersion: correction.expected_version, checkInAt: correction.check_in_at, checkOutAt: correction.check_out_at, reason: correction.reason });
    } },
    { name: 'missing exact resolved-review audit witness', mutate(records) {
      const review = first(records, 'reviews');
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        if (record.table === 'audit_entries' && record.row.action === 'review_resolved' && record.row.entity_id === review.id) records.splice(index, 1);
      }
    } },
    { name: 'later resolution attempt offered as the original witness', mutate(records, metadata) {
      const review = first(records, 'reviews');
      const audit = records.find(record => record.table === 'audit_entries' && record.row.action === 'review_resolved' && record.row.entity_id === review.id)!;
      audit.row.created_at = new Date(Date.parse(String(audit.row.created_at)) + 1).toISOString();
      metadata.createdAt = new Date(Date.parse(metadata.createdAt) + 5_000).toISOString();
    } },
    { name: 'source audit payload substitution', mutate(records) {
      const event = first(records, 'attendance_events');
      records.find(record => record.table === 'audit_entries' && record.key === event.id)!.row.detail = JSON.stringify({ note: 'Changed authenticated evidence' });
    } },
  ];
  for (const scenario of invalid) it(`rejects ${scenario.name} in both implementations`, async () => {
    const records = structuredClone(source.records), metadata = structuredClone(source.metadata);
    scenario.mutate(records, metadata);
    await checkBoth(records, metadata, false);
  }, 120_000);
});
