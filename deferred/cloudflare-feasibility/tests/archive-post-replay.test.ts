import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArchiveRecord } from '../shared/archive-format';
import type { AttendanceResult, Correction } from '../shared/types';
import { decodeAttendanceReceipt } from '../worker/attendance-receipt';
import { correctionView } from '../worker/records';
import { startMonthlyPublication, advanceMonthlyPublication } from '../worker/archive-publication';
import { createPublicationFixture, createPublicationSeed, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSnapshotOptions } from './archive-publication-fixture';
import { createStudent, json } from './helpers';
import { testAudience, testIssuer, type RuntimeOptions, type TestRuntime } from './runtime';

type Source = Awaited<ReturnType<typeof createPublicationFixture>>;
type Fixture = Awaited<ReturnType<typeof restore>>;
type ApiResponse = Awaited<ReturnType<TestRuntime['request']>>;
type CorrectionResult = { correction: Correction; replayed: boolean; visit?: unknown };
const instances: TestRuntime[] = [];
let source: Source, liveSql: string, archivedSql: string, event: ArchiveRecord, unmatched: ArchiveRecord, correction: ArchiveRecord;
beforeAll(async () => {
  source = await createPublicationFixture(await createPublicationSeed());
  try {
    const handle = await startMonthlyPublication(source.app.db, source.handle);
    for (let step = 0; ; step++) {
      if (step > 500) throw new Error('Publication fixture did not finish');
      const state = await source.app.db.prepare('SELECT state,revision FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<{ state: string; revision: number }>();
      if (state?.state === 'published') break;
      if (state?.state !== 'building') throw new Error('Publication fixture stopped');
      await advanceMonthlyPublication(source.app.db, { bucket: source.bucket, masterKey: source.key }, handle, { expectedRevision: state.revision });
    }
    event = source.records.find(record => record.table === 'attendance_events' && record.row.action === 'exceptional_departure' && record.row.visit_id)!;
    unmatched = source.records.find(record => record.table === 'attendance_events' && record.row.visit_id === null)!;
    correction = source.records.find(record => record.table === 'attendance_corrections')!;
    const jobs = await source.app.db.prepare("SELECT id FROM archive_jobs WHERE status IN ('parts','verify')").all<{ id: string }>();
    for (const job of jobs.results) await json(await source.app.request(`/api/admin/archives/${job.id}/cancel`, { token: source.app.token, body: {} }));
    await source.app.db.prepare("UPDATE students SET first_name='Changed after publication',active=0 WHERE id=?").bind(event.row.student_id).run();
    liveSql = await snapshotPublicationDatabase(source.app);
    archivedSql = await snapshotPublicationDatabase(source.app, { omitTables: ['attendance_events', 'attendance_corrections', 'reviews'] });
  } finally { await source.app.close(); }
}, 60_000);
afterEach(async () => { await Promise.all(instances.splice(0).map(app => app.close())); });

async function restore(options: { live?: boolean; bindings?: Record<string, string>; r2?: boolean; aliases?: boolean; foreignOwner?: boolean; omitVisits?: boolean; transformRow?: PublicationSnapshotOptions['transformRow']; receiptRace?: RuntimeOptions['receiptRace'] } = {}) {
  const runtimeOptions = { metrics: true, r2: options.r2 ?? true, receiptRace: options.receiptRace, bindings: {
    APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'post-replay-test', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience,
    BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', ARCHIVE_ENABLED: 'true', BACKUP_KEY: source.key, ...options.bindings,
  } };
  let app = await restorePublicationDatabase(options.live ? liveSql : archivedSql, runtimeOptions);
  if (options.aliases || options.foreignOwner || options.omitVisits || options.transformRow) {
    if (options.foreignOwner) await app.db.prepare("INSERT INTO centers(id,name,timezone,created_at) VALUES('foreign-center','Synthetic foreign center','UTC',?)").bind(new Date().toISOString()).run();
    const aliases = options.aliases ? [event, correction].map(item => source.records.find(row => row.table === 'audit_entries' && row.key === item.key)!) : [];
    if (aliases.some(row => !row)) throw new Error('Native source audit alias fixture missing');
    const sql = await snapshotPublicationDatabase(app, { omitTables: options.omitVisits ? ['visits'] : [], transformRow: (table, row) => {
      if (table === 'audit_entries' && aliases.length) return aliases.shift()!.row;
      if (table === 'history_request_keys' && options.foreignOwner && row.request_id === event.key) return { ...row, center_id: 'foreign-center' };
      return options.transformRow ? options.transformRow(table, row) : row;
    } });
    await app.close(); app = await restorePublicationDatabase(sql, runtimeOptions);
  }
  instances.push(app);
  const token = await app.signer.token();
  const bucket = options.r2 === false ? undefined : await app.runtime.getR2Bucket('BACKUP_BUCKET');
  if (bucket) for (const [key, bytes] of source.objects) await bucket.put(key, bytes);
  return { app: { ...app, token, actor: source.app.actor }, token, bucket };
}
function input(record: ArchiveRecord) {
  const row = record.row;
  return record.table === 'attendance_events'
    ? { eventId: record.key, studentId: row.student_id, action: row.action, observedAt: row.observed_at, guardianId: row.guardian_id, reason: row.reason }
    : { correctionId: record.key, expectedVersion: row.expected_version, checkInAt: row.check_in_at, checkOutAt: row.check_out_at, reason: row.reason };
}
function post(fixture: Fixture, record: ArchiveRecord, overrides: Record<string, unknown> = {}) {
  const path = record.table === 'attendance_events' ? '/api/admin/attendance' : `/api/admin/visits/${record.row.visit_id}/corrections`;
  return fixture.app.request(path, { token: fixture.token, body: { ...input(record), ...overrides } });
}
function expected(record: ArchiveRecord): AttendanceResult | CorrectionResult {
  const row = record.row;
  if (record.table === 'attendance_corrections') return { correction: correctionView(row), replayed: true };
  return { event: { id: String(row.id), studentId: String(row.student_id), visitId: row.visit_id as string | null,
    action: row.action as AttendanceResult['event']['action'], observedAt: String(row.observed_at), receivedAt: String(row.received_at),
    actorId: String(row.actor_id), actorName: String(row.actor_name), channel: row.channel as AttendanceResult['event']['channel'],
    guardianId: row.guardian_id as string | null, reason: row.reason as string | null },
    visit: decodeAttendanceReceipt({ visit_id: row.visit_id, student_id: row.student_id, action: row.action, observed_at: row.observed_at, result_visit: row.result_visit }), replayed: true };
}
function io(response: ApiResponse, noWrites = true) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const metrics = JSON.parse(response.headers.get('x-isolated-d1-metrics')!) as { rowsWritten: number };
  if (noWrites) expect(metrics.rowsWritten).toBe(0);
  expect(JSON.parse(response.headers.get('x-isolated-r2-writes')!)).toEqual([]);
  return JSON.parse(response.headers.get('x-isolated-r2-reads')!) as string[];
}
async function selectedKeys(fixture: Fixture, record: ArchiveRecord) {
  const part = await fixture.app.db.prepare('SELECT r.part_index FROM archive_publication_records r JOIN archive_publication_requests q ON q.publication_id=r.publication_id AND q.table_name=r.table_name AND q.record_key=r.record_key WHERE q.request_id=?').bind(record.key).first<number>('part_index');
  return [source.archive.objectKey, source.archive.manifest.parts[part!].objectKey];
}
async function protectedRows(fixture: Fixture) {
  const names = ['attendance_events','attendance_corrections','visits','reviews','audit_entries','history_request_keys','history_visit_heads','archive_publications','archive_publication_requests','archive_publication_records','archive_publication_parts','archive_publication_availability'];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, (await fixture.app.db.prepare(`SELECT * FROM ${name}`).all()).results.map(row => JSON.stringify(row)).sort()])));
}
const conflict = (record: ArchiveRecord) => record.table === 'attendance_events' ? 'EVENT_ID_REUSED' : 'CORRECTION_ID_REUSED';

describe('authenticated archived POST receipt replay', () => {
  it('returns original event, correction and null DTOs before old-date, inactive-profile and current-version checks', async () => {
    const archived = await restore(), live = await restore({ live: true });
    const before = await protectedRows(archived);
    for (const record of [event, correction, unmatched]) {
      const response = await post(archived, record), retained = await post(live, record);
      expect(io(response)).toEqual(await selectedKeys(archived, record)); expect(io(retained)).toEqual([]);
      expect(await json(response)).toEqual(expected(record)); expect(await json(retained)).toEqual(expected(record));
    }
    expect((expected(unmatched) as AttendanceResult).visit).toBeNull();
    expect(await protectedRows(archived)).toEqual(before);
  });

  it.each(['enabled', 'disabled', 'empty key', 'missing bucket', 'malformed key'] as const)('keeps permanent-owner aliases and changed-payload conflicts independent of %s storage', async mode => {
    const fixture = await restore({ aliases: true, r2: mode !== 'missing bucket', bindings: mode === 'disabled' ? { ARCHIVE_ENABLED: 'false' } : mode === 'empty key' ? { BACKUP_KEY: '' } : mode === 'malformed key' ? { BACKUP_KEY: 'invalid' } : {} });
    const before = await protectedRows(fixture);
    for (const record of [event, correction]) {
      const changed = await post(fixture, record, { reason: 'A changed but syntactically valid historical request' });
      expect(io(changed)).toEqual([]); expect(await json(changed, 409)).toMatchObject({ error: { code: conflict(record) } });
      const same = await post(fixture, record);
      if (mode === 'enabled') { expect(io(same)).toEqual(await selectedKeys(fixture, record)); expect(await json(same)).toEqual(expected(record)); }
      else { expect(io(same).length).toBe(mode === 'malformed key' ? 1 : 0); expect(await json(same, 503)).toMatchObject({ error: { code: 'HISTORY_EVIDENCE_UNAVAILABLE' } }); }
    }
    expect(await protectedRows(fixture)).toEqual(before);
  });

  it.each(['missing manifest', 'corrupt part', 'unavailable publication'] as const)('fails closed without mutations for %s', async failure => {
    const fixture = await restore({ transformRow: (table, row) => table === 'archive_publication_availability' && failure === 'unavailable publication' ? { ...row, status: 'unavailable' } : row });
    if (failure === 'missing manifest') await fixture.bucket!.delete(source.archive.objectKey);
    if (failure === 'corrupt part') for (const part of source.archive.manifest.parts) { const bytes = source.objects.get(part.objectKey)!.slice(); bytes[bytes.length - 1] ^= 1; await fixture.bucket!.put(part.objectKey, bytes); }
    const before = await protectedRows(fixture);
    for (const record of [event, correction]) {
      const response = await post(fixture, record);
      expect(io(response)).toHaveLength(failure === 'unavailable publication' ? 0 : failure === 'missing manifest' ? 1 : 2);
      expect(await json(response, 503)).toMatchObject({ error: { code: 'HISTORY_EVIDENCE_UNAVAILABLE' } });
    }
    expect(await protectedRows(fixture)).toEqual(before);
  });

  it('does not disclose foreign-center or wrong-kind receipts with archive reads enabled', async () => {
    const fixture = await restore({ foreignOwner: true }); const before = await protectedRows(fixture);
    for (const [record, overrides] of [[event, {}], [event, { eventId: correction.key }], [correction, { correctionId: event.key }]] as const) {
      const response = await post(fixture, record, overrides);
      expect(io(response)).toEqual([]); expect(await json(response, 409)).toMatchObject({ error: { code: conflict(record) } });
    }
    expect(await protectedRows(fixture)).toEqual(before);
  });

  it('retains ordinary live acceptance and idempotent replay for truly unused event and correction IDs', async () => {
    const fixture = await restore(); const student = await createStudent(fixture.app);
    const body = { eventId: crypto.randomUUID(), studentId: student.student.id, action: 'check_in', observedAt: new Date(Date.now() - 60_000).toISOString() };
    const response = await fixture.app.request('/api/admin/attendance', { token: fixture.token, body });
    expect(io(response, false)).toEqual([]); const accepted = await json<AttendanceResult>(response, 201);
    const again = await fixture.app.request('/api/admin/attendance', { token: fixture.token, body });
    expect(io(again)).toEqual([]); expect(await json(again)).toEqual({ ...accepted, replayed: true });
    const correctionBody = { correctionId: crypto.randomUUID(), expectedVersion: accepted.visit!.version, checkInAt: new Date(Date.parse(body.observedAt) + 1000).toISOString(), checkOutAt: null, reason: 'Verified the recorded arrival time' };
    const path = `/api/admin/visits/${accepted.visit!.id}/corrections`;
    const corrected = await fixture.app.request(path, { token: fixture.token, body: correctionBody });
    expect(io(corrected, false)).toEqual([]); const saved = await json<CorrectionResult>(corrected, 201);
    const retried = await fixture.app.request(path, { token: fixture.token, body: correctionBody });
    expect(io(retried)).toEqual([]); expect(await json(retried)).toEqual({ correction: saved.correction, replayed: true });
  });

  it.each(['event', 'correction'] as const)('rechecks native %s insert conflicts against archived evidence after an earlier unused-ID snapshot', async kind => {
    const record = kind === 'event' ? event : correction;
    const fixture = await restore({ receiptRace: { requestId: record.key, ...(kind === 'event' ? { observationClock: new Date(Date.parse(String(event.row.observed_at)) + 1000).toISOString() } : {}) } });
    const before = await protectedRows(fixture), response = await post(fixture, record);
    expect(io(response)).toEqual(await selectedKeys(fixture, record)); expect(await json(response)).toEqual(expected(record));
    expect(JSON.parse(response.headers.get('x-isolated-receipt-race')!)).toMatchObject({ hiddenSnapshots: 1, insertBatches: 1, insertErrors: 1, nativeReplaySnapshots: 2 });
    expect(await protectedRows(fixture)).toEqual(before);
  });

  it('rechecks archived correction ownership when its current visit is absent', async () => {
    const fixture = await restore({ omitVisits: true, receiptRace: { requestId: correction.key } });
    expect((await fixture.app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const before = await protectedRows(fixture), response = await post(fixture, correction);
    expect(io(response)).toEqual(await selectedKeys(fixture, correction)); expect(await json(response)).toEqual(expected(correction));
    expect(JSON.parse(response.headers.get('x-isolated-receipt-race')!)).toMatchObject({ hiddenSnapshots: 1, insertBatches: 0, insertErrors: 0, missingRowBatches: 0, nativeReplaySnapshots: 2 });
    expect(await protectedRows(fixture)).toEqual(before);
  });
});
