import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArchiveRecord } from '../shared/archive-format';
import type { AttendanceResult, Device, Staff } from '../shared/types';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { CookieJar, json } from './helpers';
import { createPublicationFixture, createPublicationSeed, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSnapshotOptions } from './archive-publication-fixture';
import { testAudience, testIssuer, type TestRuntime } from './runtime';

type Source = Awaited<ReturnType<typeof createPublicationFixture>>;
type Fixture = Awaited<ReturnType<typeof restore>>;
const instances: TestRuntime[] = [];
const ioEvidence: { test: string | undefined; status: number; d1: Record<string, number>; r2Keys: string[] }[] = [];
const liveReceipts = new Map<string, AttendanceResult>();
let source: Source, liveSql: string, archivedSql: string, event: ArchiveRecord, unmatched: ArchiveRecord, correction: ArchiveRecord;

beforeAll(async () => {
  source = await createPublicationFixture(await createPublicationSeed());
  try {
    const handle = await startMonthlyPublication(source.app.db, source.handle);
    for (let step = 0; ; step++) {
      if (step > 500) throw new Error('Publication fixture did not finish');
      const state = await source.app.db.prepare('SELECT revision,state FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<{ revision: number; state: string }>();
      if (state?.state === 'published') break;
      if (!state || state.state !== 'building') throw new Error('Publication fixture stopped');
      await advanceMonthlyPublication(source.app.db, { bucket: source.bucket, masterKey: source.key }, handle, { expectedRevision: state.revision });
    }
    correction = source.records.find(record => record.table === 'attendance_corrections')!;
    event = source.records.find(record => record.table === 'attendance_events' && record.row.action === 'check_in' && record.row.visit_id === correction.row.visit_id)!;
    unmatched = source.records.find(record => record.table === 'attendance_events' && record.row.visit_id === null)!;
    const jobs = await source.app.db.prepare("SELECT id FROM archive_jobs WHERE status IN ('parts','verify')").all<{ id: string }>();
    for (const job of jobs.results) await json(await source.app.request(`/api/admin/archives/${job.id}/cancel`, { token: source.app.token, body: {} }));
    for (const record of [event, unmatched]) liveReceipts.set(record.key, await json<AttendanceResult>(await source.app.request(`/api/admin/attendance/events/${record.key}`, { token: source.app.token })));
    await source.app.db.prepare('INSERT INTO centers(id,name,timezone,created_at) VALUES(?,?,?,?)').bind('another-center', 'Synthetic Other Center', 'America/Los_Angeles', new Date().toISOString()).run();
    liveSql = await snapshotPublicationDatabase(source.app);
    // Test-only restored snapshots emulate absent details; no operating DB eviction.
    archivedSql = await snapshotPublicationDatabase(source.app, { omitTables: ['attendance_events', 'attendance_corrections', 'reviews'] });
  } finally { await source.app.close(); }
}, 60_000);

afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.close())); });
afterAll(() => {
  if (process.env.ARCHIVE_RECEIPT_EVIDENCE_PATH) writeFileSync(process.env.ARCHIVE_RECEIPT_EVIDENCE_PATH, JSON.stringify(ioEvidence, null, 2) + '\n');
});

async function restore(options: { live?: boolean; bindings?: Record<string, string>; r2?: boolean; transformRow?: PublicationSnapshotOptions['transformRow'] } = {}) {
  const runtimeOptions = { metrics: true, r2: options.r2 ?? true, bindings: {
    APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'public-event-receipt-test',
    ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
    ARCHIVE_ENABLED: 'true', BACKUP_KEY: source.key, ...options.bindings,
  } };
  let app = await restorePublicationDatabase(options.live ? liveSql : archivedSql, runtimeOptions);
  if (options.transformRow) {
    const sql = await snapshotPublicationDatabase(app, { transformRow: options.transformRow });
    await app.close();
    app = await restorePublicationDatabase(sql, runtimeOptions);
  }
  instances.push(app);
  const token = await app.signer.token();
  const bucket = options.r2 === false ? undefined : await app.runtime.getR2Bucket('BACKUP_BUCKET');
  if (bucket) for (const [key, bytes] of source.objects) await bucket.put(key, bytes);
  return { app, token, bucket };
}

function expectedReceipt(record: ArchiveRecord): AttendanceResult {
  const receipt = liveReceipts.get(record.key);
  if (!receipt) throw new Error('Original API receipt was not captured');
  return receipt;
}

function io(response: Response | Awaited<ReturnType<TestRuntime['request']>>) {
  const reads = JSON.parse(response.headers.get('x-isolated-r2-reads') ?? 'null') as string[];
  const metrics = JSON.parse(response.headers.get('x-isolated-d1-metrics') ?? 'null') as Record<string, number>;
  ioEvidence.push({ test: expect.getState().currentTestName, status: response.status, d1: metrics, r2Keys: reads });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(metrics.rowsWritten).toBe(0);
  return reads;
}

async function selectedKeys(fixture: Fixture, record = event) {
  const locator = await fixture.app.db.prepare('SELECT r.part_index FROM archive_publication_records r JOIN archive_publication_requests q ON q.publication_id=r.publication_id AND q.table_name=r.table_name AND q.record_key=r.record_key WHERE q.request_id=?').bind(record.key).first<{ part_index: number }>();
  return [source.archive.objectKey, source.archive.manifest.parts[locator!.part_index].objectKey];
}

async function expectUnavailable(fixture: Fixture, expectedReads?: number) {
  const response = await fixture.app.request(`/api/admin/attendance/events/${event.key}`, { token: fixture.token });
  const reads = io(response);
  if (expectedReads !== undefined) expect(reads).toHaveLength(expectedReads);
  expect(await json(response, 503)).toMatchObject({ error: { code: 'HISTORY_EVIDENCE_UNAVAILABLE' } });
}

async function enroll(fixture: Fixture) {
  const pin = '48271639';
  const { staff } = await json<{ staff: Staff }>(await fixture.app.request('/api/admin/staff', { token: fixture.token, body: {
    email: `${crypto.randomUUID()}@example.test`, displayName: 'Synthetic Receipt Operator', role: 'front_desk', kioskEnabled: true, pin,
  } }), 201);
  const grant = await json<{ token: string }>(await fixture.app.request('/api/admin/devices/enrollment', { token: fixture.token, body: {} }), 201);
  const jar = new CookieJar();
  const { device } = await json<{ device: Device }>(await jar.request(fixture.app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Synthetic receipt iPad' } }), 201);
  return { jar, staff, device, pin };
}

describe('Authenticated public event receipt archive fallback', () => {
  it('returns the same original sealed DTO over admin, including a literal null receipt', async () => {
    const fixture = await restore();
    for (const record of [event, unmatched]) {
      const response = await fixture.app.request(`/api/admin/attendance/events/${record.key}`, { token: fixture.token });
      expect(io(response)).toEqual(await selectedKeys(fixture, record));
      expect(await json<AttendanceResult>(response)).toEqual(expectedReceipt(record));
    }
    expect(unmatched.row.result_visit).toBe('null');
    expect(expectedReceipt(unmatched).visit).toBeNull();
    expect(expectedReceipt(event).visit).toMatchObject({ version: 1, checkOutAt: null });
    const currentVisit = await fixture.app.db.prepare('SELECT version FROM visits WHERE id=?').bind(event.row.visit_id).first<{ version: number }>();
    expect(expectedReceipt(event).visit!.version).toBeLessThan(currentVisit!.version);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
  });

  it.each([
    ['enabled', { ARCHIVE_ENABLED: 'true' }, true],
    ['disabled', { ARCHIVE_ENABLED: 'false' }, true],
    ['empty key', { BACKUP_KEY: '' }, true],
    ['malformed key', { BACKUP_KEY: 'not-a-backup-key' }, true],
    ['missing bucket', {}, false],
  ] as const)('prefers retained live evidence with %s archive configuration and performs no R2 reads', async (_name, bindings, r2) => {
    const fixture = await restore({ live: true, bindings, r2 });
    const response = await fixture.app.request(`/api/admin/attendance/events/${event.key}`, { token: fixture.token });
    expect(io(response)).toEqual([]);
    expect(await json<AttendanceResult>(response)).toEqual(expectedReceipt(event));
  });

  it.each([
    ['disabled', { ARCHIVE_ENABLED: 'false' }, true],
    ['unset flag', { ARCHIVE_ENABLED: '' }, true],
    ['noncanonical flag', { ARCHIVE_ENABLED: 'TRUE' }, true],
    ['empty key', { BACKUP_KEY: '' }, true],
    ['missing bucket', {}, false],
  ] as const)('fails closed without R2 IO for known absent detail with %s configuration', async (_name, bindings, r2) => {
    await expectUnavailable(await restore({ bindings, r2 }), 0);
  });

  it.each(['missing manifest', 'missing part', 'tampered manifest', 'tampered part', 'wrong key', 'malformed key'] as const)('fails closed for %s', async failure => {
    const fixture = await restore({ bindings: failure === 'wrong key' ? { BACKUP_KEY: Buffer.alloc(32, 29).toString('base64') } : failure === 'malformed key' ? { BACKUP_KEY: 'invalid' } : {} });
    const keys = await selectedKeys(fixture);
    const key = failure.endsWith('manifest') ? keys[0] : keys[1];
    if (failure.startsWith('missing')) await fixture.bucket!.delete(key);
    if (failure.startsWith('tampered')) {
      const bytes = source.objects.get(key)!.slice(); bytes[bytes.length - 1] ^= 1;
      await fixture.bucket!.put(key, bytes);
    }
    await expectUnavailable(fixture, failure.endsWith('part') ? 2 : 1);
  });

  it.each(['unavailable publication', 'old availability generation', 'changed runtime generation', 'wrong locator hash', 'claim mismatch'] as const)('fails closed for %s', async failure => {
    const fixture = await restore({ transformRow: (table, row) => {
      if (table === 'archive_publication_availability' && failure === 'unavailable publication') return { ...row, status: 'unavailable' };
      if (table === 'archive_publication_availability' && failure === 'old availability generation') return { ...row, generation: 'stale-generation' };
      if (table === 'history_runtime' && failure === 'changed runtime generation') return { ...row, generation: 'restored-generation' };
      if (table === 'archive_publication_records' && row.record_key === event.key && row.table_name === 'attendance_events' && failure === 'wrong locator hash') return { ...row, record_sha256: '0'.repeat(64) };
      if (table === 'archive_publication_requests' && row.request_id === event.key && failure === 'claim mismatch') return { ...row, payload_hash: Buffer.alloc(32, 31).toString('base64') };
      return row;
    } });
    await expectUnavailable(fixture, failure === 'wrong locator hash' ? 2 : 0);
  });

  it.each(['true', 'false'])('leaves unknown, foreign-center and wrong-kind IDs undisclosed when archive reads are %s', async flag => {
    const fixture = await restore({ bindings: { ARCHIVE_ENABLED: flag }, transformRow: (table, row) =>
      table === 'history_request_keys' && row.request_id === event.key ? { ...row, center_id: 'another-center' } : row });
    for (const id of [crypto.randomUUID(), event.key, correction.key]) {
      const response = await fixture.app.request(`/api/admin/attendance/events/${id}`, { token: fixture.token });
      expect(io(response)).toEqual([]);
      expect(await json(response, 404)).toMatchObject({ error: { code: 'EVENT_NOT_FOUND' } });
    }
  });

  it('denies missing/invalid Access JWTs, unlisted staff and instructors before any R2 reads', async () => {
    const fixture = await restore();
    const unlisted = await fixture.app.signer.token({ email: 'unlisted@example.test' });
    for (const [token, status] of [[undefined, 401], ['invalid', 401], [unlisted, 403]] as const) {
      const response = await fixture.app.request(`/api/admin/attendance/events/${event.key}`, { token });
      expect(io(response)).toEqual([]);
      await json(response, status);
    }
    await json(await fixture.app.request('/api/admin/staff', { token: fixture.token, body: {
      email: 'instructor@example.test', displayName: 'Synthetic Instructor', role: 'instructor', kioskEnabled: false,
    } }), 201);
    const instructor = await fixture.app.signer.token({ email: 'instructor@example.test' });
    const response = await fixture.app.request(`/api/admin/attendance/events/${event.key}`, { token: instructor });
    expect(io(response)).toEqual([]);
    expect(await json(response, 403)).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('serves kiosk receipts only after enrollment and named operator unlock, then fences revoked device access', async () => {
    const fixture = await restore();
    const path = `/api/kiosk/attendance/events/${event.key}`;
    const unenrolled = await fixture.app.request(path);
    expect(io(unenrolled)).toEqual([]); await json(unenrolled, 401);
    const kiosk = await enroll(fixture);
    const locked = await kiosk.jar.request(fixture.app, path);
    expect(io(locked)).toEqual([]); await json(locked, 401);
    await json(await kiosk.jar.request(fixture.app, '/api/kiosk/unlock', { body: { staffId: kiosk.staff.id, pin: kiosk.pin } }));
    for (const record of [event, unmatched]) {
      const response = await kiosk.jar.request(fixture.app, `/api/kiosk/attendance/events/${record.key}`);
      expect(io(response)).toEqual(await selectedKeys(fixture, record));
      expect(await json<AttendanceResult>(response)).toEqual(expectedReceipt(record));
    }
    await fixture.app.db.prepare('UPDATE kiosk_devices SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), kiosk.device.id).run();
    const revoked = await kiosk.jar.request(fixture.app, path);
    expect(io(revoked)).toEqual([]); await json(revoked, 401);
  });

  it('rejects a stale kiosk operator session before R2 reads', async () => {
    const fixture = await restore();
    const kiosk = await enroll(fixture);
    await json(await kiosk.jar.request(fixture.app, '/api/kiosk/unlock', { body: { staffId: kiosk.staff.id, pin: kiosk.pin } }));
    await fixture.app.db.prepare('UPDATE staff SET session_version=session_version+1 WHERE id=?').bind(kiosk.staff.id).run();
    const response = await kiosk.jar.request(fixture.app, `/api/kiosk/attendance/events/${event.key}`);
    expect(io(response)).toEqual([]); await json(response, 401);
  });

  it('replays the original POST receipt through the shared read-only archive adapter', async () => {
    const fixture = await restore();
    const response = await fixture.app.request('/api/admin/attendance', { token: fixture.token, body: {
      eventId: event.key, studentId: event.row.student_id, action: event.row.action, observedAt: event.row.observed_at,
      guardianId: event.row.guardian_id, reason: event.row.reason,
    } });
    expect(io(response)).toEqual(await selectedKeys(fixture));
    expect(await json<AttendanceResult>(response)).toEqual(expectedReceipt(event));
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
  });
});
