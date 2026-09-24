import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttendanceResult, Correction, CorrectionInput } from '../shared/types.js';
import { createStudent, json, startApp, type App } from './helpers.js';

type EventInput = { eventId: string; studentId: string; action: 'check_in' | 'check_out' | 'exceptional_departure'; observedAt: string; guardianId?: string | null; reason?: string | null };
type Encoding = 'base64' | 'hex' | 'base64url' | 'upper-hex' | 'opaque';
type CorrectionResult = { correction: Correction; replayed: boolean; visit?: { version: number } };
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() { const app = await startApp(); apps.push(app); return app; }
const eventPost = (app: App, input: EventInput) => app.request('/api/admin/attendance', { token: app.token, body: input });
const eventStatus = (app: App, id: string) => app.request(`/api/admin/attendance/events/${id}`, { token: app.token });
const correctionPost = (app: App, visitId: string, input: CorrectionInput) => app.request(`/api/admin/visits/${visitId}/corrections`, { token: app.token, body: input });
const shift = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
function fingerprint(value: unknown, encoding: Encoding) {
  if (encoding === 'opaque') return `legacy-unverified:${crypto.randomUUID()}`;
  const digest = createHash('sha256').update(JSON.stringify(value));
  return encoding === 'upper-hex' ? digest.digest('hex').toUpperCase() : digest.digest(encoding);
}
function eventHash(input: EventInput, encoding: Encoding) {
  return fingerprint({ studentId: input.studentId, action: input.action, observedAt: input.observedAt, guardianId: input.guardianId || null, reason: input.reason || null }, encoding);
}
async function insertEvent(app: App, input: EventInput, visitId: string | null, encoding: Encoding = 'base64') {
  const hash = eventHash(input, encoding);
  await app.db.prepare(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,reason,payload_hash,insertion_nonce)
    VALUES(?,'test-center',?,?,?,?,?,?,?,'admin',?,?,?,?)`)
    .bind(input.eventId, input.studentId, visitId, input.action, input.observedAt, input.observedAt, app.actor.id, app.actor.displayName,
      input.guardianId || null, input.reason || null, hash, crypto.randomUUID()).run();
  return hash;
}
async function arrival(app: App, encoding: Encoding = 'base64', at = '2024-02-15T18:00:00.000Z') {
  const detail = await createStudent(app);
  const input: EventInput = { eventId: crypto.randomUUID(), studentId: detail.student.id, action: 'check_in', observedAt: at };
  const visitId = `visit-${input.eventId}`;
  const hash = await insertEvent(app, input, visitId, encoding);
  const receipt = await json<AttendanceResult>(await eventStatus(app, input.eventId));
  return { detail, input, visitId, hash, receipt };
}
function correctionInput(visit: Awaited<ReturnType<typeof arrival>>, extra: Partial<CorrectionInput> = {}): CorrectionInput {
  return { correctionId: crypto.randomUUID(), expectedVersion: 1, checkInAt: shift(visit.input.observedAt, 1), checkOutAt: null,
    reason: 'Confirmed the arrival time against the original staff record.', ...extra };
}
async function insertCorrection(app: App, visitId: string, input: CorrectionInput, encoding: Encoding) {
  const hash = fingerprint({ visitId, expectedVersion: input.expectedVersion, checkInAt: input.checkInAt, checkOutAt: input.checkOutAt, reason: input.reason }, encoding);
  await app.db.prepare(`INSERT INTO attendance_corrections(id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash)
    SELECT ?,'test-center',id,?,check_in_at,check_out_at,?,?,?,?,?,?,? FROM visits WHERE id=?`)
    .bind(input.correctionId, input.expectedVersion, input.checkInAt, input.checkOutAt, input.reason, app.actor.id, app.actor.displayName,
      new Date().toISOString(), hash, visitId).run();
  return hash;
}
async function errorCode(response: Awaited<ReturnType<App['request']>>, expectedStatus: number) {
  return (await json<{ error: { code: string } }>(response, expectedStatus)).error.code;
}
async function removeSource(app: App, table: 'attendance_events' | 'attendance_corrections', id: string) {
  // An isolated fault-injection fixture only. Production keeps every guard.
  const guards = (await app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND upper(sql) LIKE '%BEFORE DELETE%'")
    .bind(table).all<{ name: string; sql: string }>()).results;
  expect(guards.length).toBeGreaterThan(0);
  await app.db.batch([
    ...guards.map(guard => app.db.prepare(`DROP TRIGGER "${guard.name}"`)),
    app.db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id),
    ...guards.map(guard => app.db.prepare(guard.sql)),
  ]);
}
async function alterEventEvidence(app: App, id: string, field: 'result_visit' | 'payload_hash', value: string | null) {
  const guard = await app.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='attendance_no_update'").first<string>('sql');
  expect(guard).toBeTruthy();
  await app.db.batch([
    app.db.prepare('DROP TRIGGER attendance_no_update'),
    app.db.prepare(`UPDATE attendance_events SET ${field}=? WHERE id=?`).bind(value, id),
    app.db.prepare(guard!),
  ]);
}
async function requestKey(app: App, id: string) {
  return app.db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(id).first();
}
async function allSources(app: App) {
  return Promise.all(['attendance_events', 'attendance_corrections', 'visits'].map(async table => (await app.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));
}

describe('permanent attendance and correction receipt resolution', () => {
  it('replays historical receipts before date, student, and current-visit checks while retaining their original snapshots', async () => {
    const app = await setup();
    const first = await arrival(app);
    const correction = correctionInput(first);
    const corrected = await json<CorrectionResult>(await correctionPost(app, first.visitId, correction), 201);
    const departure: EventInput = { eventId: crypto.randomUUID(), studentId: first.detail.student.id, action: 'exceptional_departure',
      observedAt: shift(first.input.observedAt, 60), reason: 'Departure observed while pickup verification was unavailable.' };
    await insertEvent(app, departure, first.visitId);
    const departureReceipt = await json<AttendanceResult>(await eventStatus(app, departure.eventId));
    expect(departureReceipt.visit?.reviewStatus).toBe('pending');
    await json(await app.request(`/api/admin/reviews/${departure.eventId}/resolve`, { token: app.token, body: { resolution: 'Manager confirmed the recorded departure circumstances.' } }));
    await json(await correctionPost(app, first.visitId, correctionInput(first, {
      expectedVersion: 3, checkInAt: shift(first.input.observedAt, 2), checkOutAt: shift(departure.observedAt, 1), reason: 'Later correction based on a second contemporaneous record.',
    })), 201);
    await app.db.batch([
      app.db.prepare("UPDATE students SET first_name='Current renamed student',student_code='CURRENT-ROSTER-CODE' WHERE id=?").bind(first.detail.student.id),
      app.db.prepare("UPDATE staff SET display_name='Current renamed operator' WHERE id=?").bind(app.actor.id),
      app.db.prepare("UPDATE guardians SET display_name='Current renamed guardian' WHERE id=?").bind(first.detail.guardians[0].id),
    ]);
    const next: EventInput = { eventId: crypto.randomUUID(), studentId: first.detail.student.id, action: 'check_in', observedAt: new Date(Date.now() - 60_000).toISOString() };
    await json(await eventPost(app, next), 201);
    await app.db.prepare('UPDATE students SET active=0 WHERE id=?').bind(first.detail.student.id).run();
    const before = await allSources(app);
    const retriedArrival = await json<AttendanceResult>(await eventPost(app, first.input));
    const retriedDeparture = await json<AttendanceResult>(await eventPost(app, departure));
    const retriedCorrection = await json<CorrectionResult>(await correctionPost(app, first.visitId, correction));
    expect(retriedArrival).toEqual({ ...first.receipt, replayed: true });
    expect(retriedDeparture).toEqual({ ...departureReceipt, replayed: true });
    expect(retriedCorrection).toMatchObject({ correction: corrected.correction, replayed: true });
    expect(retriedArrival.visit?.studentName).not.toContain('Current renamed');
    expect(retriedDeparture.visit?.reviewStatus).toBe('pending');
    expect(await allSources(app)).toEqual(before);
  });

  it('returns unavailable for an accepted event whose evidence is missing and rejects a changed payload first', async () => {
    const app = await setup();
    const accepted = await arrival(app);
    const key = await requestKey(app, accepted.input.eventId);
    await removeSource(app, 'attendance_events', accepted.input.eventId);
    expect(await errorCode(await eventStatus(app, accepted.input.eventId), 503)).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    expect(await errorCode(await eventPost(app, accepted.input), 503)).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    const changed = { ...accepted.input, studentId: crypto.randomUUID(), observedAt: '2020-01-01T00:00:00.000Z' };
    expect(await errorCode(await eventPost(app, changed), 409)).toBe('EVENT_ID_REUSED');
    expect(await requestKey(app, accepted.input.eventId)).toEqual(key);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE id=?').bind(accepted.input.eventId).first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE id=?').bind(accepted.visitId).first('n')).toBe(1);
  });

  it('returns unavailable for missing correction evidence before current version checks, and conflict before a changed target is looked up', async () => {
    const app = await setup();
    const accepted = await arrival(app);
    const input = correctionInput(accepted);
    await json<CorrectionResult>(await correctionPost(app, accepted.visitId, input), 201);
    const key = await requestKey(app, input.correctionId);
    await removeSource(app, 'attendance_corrections', input.correctionId);
    expect(await errorCode(await correctionPost(app, accepted.visitId, input), 503)).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    expect(await errorCode(await correctionPost(app, `visit-${crypto.randomUUID()}`, { ...input, checkInAt: '2099-01-01T00:00:00.000Z' }), 409)).toBe('CORRECTION_ID_REUSED');
    expect(await requestKey(app, input.correctionId)).toEqual(key);
    expect(await app.db.prepare('SELECT version FROM visits WHERE id=?').bind(accepted.visitId).first('version')).toBe(2);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_corrections WHERE id=?').bind(input.correctionId).first('n')).toBe(0);
  });

  it('keeps truly unknown event status at 404 and retains validation for an unaccepted old request', async () => {
    const app = await setup();
    const detail = await createStudent(app);
    const unknown: EventInput = { eventId: crypto.randomUUID(), studentId: detail.student.id, action: 'check_in', observedAt: '2020-01-01T00:00:00.000Z' };
    expect(await errorCode(await eventStatus(app, unknown.eventId), 404)).toBe('EVENT_NOT_FOUND');
    expect(await errorCode(await eventPost(app, unknown), 400)).toBe('OBSERVATION_OUT_OF_RANGE');
    expect(await requestKey(app, unknown.eventId)).toBeNull();
  });

  it('rejects cross-type and cross-center request IDs without disclosing another receipt', async () => {
    const app = await setup();
    const accepted = await arrival(app);
    const correction = correctionInput(accepted);
    await json(await correctionPost(app, accepted.visitId, correction), 201);
    const auditId = crypto.randomUUID();
    await app.db.prepare("INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,'test-center',?,?,'retry_fixture','center','test-center','{}',?)")
      .bind(auditId, app.actor.id, app.actor.displayName, new Date().toISOString()).run();
    const foreignId = crypto.randomUUID();
    await app.db.prepare("INSERT INTO centers(id,name,timezone,created_at) VALUES('foreign-retry-center','Foreign retry fixture','UTC',?)").bind(new Date().toISOString()).run();
    await app.db.prepare("INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding) VALUES(?,'event','foreign-retry-center',?,'base64-sha256')")
      .bind(foreignId, accepted.hash).run();
    const before = await allSources(app);
    for (const id of [correction.correctionId, auditId, foreignId]) {
      expect(await errorCode(await eventPost(app, { ...accepted.input, eventId: id }), 409)).toBe('EVENT_ID_REUSED');
      expect(await errorCode(await eventStatus(app, id), 404)).toBe('EVENT_NOT_FOUND');
    }
    for (const id of [accepted.input.eventId, auditId, foreignId]) {
      expect(await errorCode(await correctionPost(app, `visit-${crypto.randomUUID()}`, { ...correction, correctionId: id }), 409)).toBe('CORRECTION_ID_REUSED');
    }
    expect(await allSources(app)).toEqual(before);
  });

  it('fails closed when a source fingerprint disagrees with its permanent request key', async () => {
    const app = await setup();
    const accepted = await arrival(app);
    const key = await requestKey(app, accepted.input.eventId);
    await alterEventEvidence(app, accepted.input.eventId, 'payload_hash', createHash('sha256').update('corrupt retained source').digest('base64'));
    expect(await errorCode(await eventStatus(app, accepted.input.eventId), 503)).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    expect(await errorCode(await eventPost(app, accepted.input), 503)).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    expect(await requestKey(app, accepted.input.eventId)).toEqual(key);
  });

  it('reports corrupt and unsealed event receipts as unavailable instead of returning success or fabricating current state', async () => {
    const app = await setup();
    for (const broken of [null, 'null', '{not valid JSON', '{}', '[2,"incomplete"]']) {
      const accepted = await arrival(app);
      await alterEventEvidence(app, accepted.input.eventId, 'result_visit', broken);
      expect(await errorCode(await eventStatus(app, accepted.input.eventId), 503)).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
      expect(await errorCode(await eventPost(app, accepted.input), 503)).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
      expect(await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(accepted.input.eventId).first('result_visit')).toBe(broken);
    }
  });

  it('continues to replay a sealed null visit for a genuinely unmatched exceptional departure', async () => {
    const app = await setup();
    const detail = await createStudent(app);
    const input: EventInput = { eventId: crypto.randomUUID(), studentId: detail.student.id, action: 'exceptional_departure',
      observedAt: '2024-02-15T18:30:00.000Z', reason: 'Departure observed without an accepted arrival record.' };
    await insertEvent(app, input, null);
    const receipt = await json<AttendanceResult>(await eventStatus(app, input.eventId));
    expect(receipt.visit).toBeNull();
    expect(await json<AttendanceResult>(await eventPost(app, input))).toEqual(receipt);
    expect(await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(input.eventId).first('result_visit')).toBe('null');
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(detail.student.id).first('n')).toBe(0);
  });
});

describe('concurrent accepted-request resolution', () => {
  it('acknowledges one event effect and one replay when an identical concurrent insert is ignored', async () => {
    const app = await setup();
    const detail = await createStudent(app);
    const input: EventInput = { eventId: crypto.randomUUID(), studentId: detail.student.id, action: 'check_in', observedAt: new Date(Date.now() - 60_000).toISOString() };
    const responses = await Promise.all([eventPost(app, input), eventPost(app, input)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(responses.map(response => response.json() as Promise<AttendanceResult>));
    expect(receipts[0].event).toEqual(receipts[1].event);
    expect(receipts[0].visit).toEqual(receipts[1].visit);
    expect(receipts.map(receipt => receipt.replayed).sort()).toEqual([false, true]);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE id=?').bind(input.eventId).first('n')).toBe(1);
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(detail.student.id).first('n')).toBe(1);
  });

  it('rejects an event payload conflict racing under the same permanent ID', async () => {
    const app = await setup();
    const detail = await createStudent(app);
    const input: EventInput = { eventId: crypto.randomUUID(), studentId: detail.student.id, action: 'check_in', observedAt: new Date(Date.now() - 120_000).toISOString() };
    const alternative = { ...input, observedAt: shift(input.observedAt, 1) };
    const responses = await Promise.all([eventPost(app, input), eventPost(app, alternative)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = await json<AttendanceResult>(responses.find(response => response.status === 201)!, 201);
    expect(await errorCode(responses.find(response => response.status === 409)!, 409)).toBe('EVENT_ID_REUSED');
    expect((await json<AttendanceResult>(await eventStatus(app, input.eventId))).event).toEqual(winner.event);
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(detail.student.id).first('n')).toBe(1);
  });

  it('acknowledges a correction insert and its concurrent replay without applying the correction twice', async () => {
    const app = await setup();
    const accepted = await arrival(app);
    const input = correctionInput(accepted);
    const responses = await Promise.all([correctionPost(app, accepted.visitId, input), correctionPost(app, accepted.visitId, input)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(responses.map(response => response.json() as Promise<CorrectionResult>));
    expect(receipts[0].correction).toEqual(receipts[1].correction);
    expect(receipts.map(receipt => receipt.replayed).sort()).toEqual([false, true]);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_corrections WHERE id=?').bind(input.correctionId).first('n')).toBe(1);
    expect(await app.db.prepare('SELECT version FROM visits WHERE id=?').bind(accepted.visitId).first('version')).toBe(2);
  });

  it('rejects a correction payload conflict after another request wins the same ID', async () => {
    const app = await setup();
    const accepted = await arrival(app);
    const input = correctionInput(accepted);
    const alternative = { ...input, reason: 'A different proposed correction sharing the same request identifier.' };
    const responses = await Promise.all([correctionPost(app, accepted.visitId, input), correctionPost(app, accepted.visitId, alternative)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(await errorCode(responses.find(response => response.status === 409)!, 409)).toBe('CORRECTION_ID_REUSED');
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_corrections WHERE id=?').bind(input.correctionId).first('n')).toBe(1);
    expect(await app.db.prepare('SELECT version FROM visits WHERE id=?').bind(accepted.visitId).first('version')).toBe(2);
  });
});

describe('stored request fingerprint compatibility', () => {
  it('compares equivalent SHA-256 encodings without replacing original event or correction evidence', async () => {
    const app = await setup();
    for (const encoding of ['base64', 'hex', 'base64url', 'upper-hex'] as const) {
      const accepted = await arrival(app, encoding);
      const eventKey = await requestKey(app, accepted.input.eventId);
      const input = correctionInput(accepted);
      const hash = await insertCorrection(app, accepted.visitId, input, encoding);
      const correctionKey = await requestKey(app, input.correctionId);
      const before = await allSources(app);
      expect(await json<AttendanceResult>(await eventPost(app, accepted.input))).toEqual({ ...accepted.receipt, replayed: true });
      const receipt = await json<CorrectionResult>(await correctionPost(app, accepted.visitId, input));
      expect(receipt.replayed).toBe(true);
      expect(receipt.correction).toMatchObject({ id: input.correctionId, visitId: accepted.visitId, checkInAt: input.checkInAt, reason: input.reason });
      expect(await requestKey(app, accepted.input.eventId)).toEqual(eventKey);
      expect(await requestKey(app, input.correctionId)).toEqual(correctionKey);
      expect(await app.db.prepare('SELECT payload_hash FROM attendance_events WHERE id=?').bind(accepted.input.eventId).first('payload_hash')).toBe(accepted.hash);
      expect(await app.db.prepare('SELECT payload_hash FROM attendance_corrections WHERE id=?').bind(input.correctionId).first('payload_hash')).toBe(hash);
      expect(await allSources(app)).toEqual(before);
    }
  });

  it('preserves opaque legacy evidence without silently converting its stored fingerprint', async () => {
    const app = await setup();
    const accepted = await arrival(app, 'opaque');
    const input = correctionInput(accepted);
    const correctionHash = await insertCorrection(app, accepted.visitId, input, 'opaque');
    const before = await allSources(app);
    const keys = await Promise.all([requestKey(app, accepted.input.eventId), requestKey(app, input.correctionId)]);
    expect(keys.every(key => key?.hash_encoding === 'opaque')).toBe(true);
    expect(await json<AttendanceResult>(await eventStatus(app, accepted.input.eventId))).toEqual(accepted.receipt);
    const eventReply = await eventPost(app, accepted.input);
    const correctionReply = await correctionPost(app, accepted.visitId, input);
    expect(await errorCode(eventReply, 409)).toBe('EVENT_ID_REUSED');
    expect(await errorCode(correctionReply, 409)).toBe('CORRECTION_ID_REUSED');
    expect(await requestKey(app, accepted.input.eventId)).toEqual(keys[0]);
    expect(await requestKey(app, input.correctionId)).toEqual(keys[1]);
    expect(await app.db.prepare('SELECT payload_hash FROM attendance_corrections WHERE id=?').bind(input.correctionId).first('payload_hash')).toBe(correctionHash);
    expect(await allSources(app)).toEqual(before);
  });
});
