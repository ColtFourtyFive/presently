import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceResult, Page, VisitSummary } from '../shared/types.js';
import { createStudent, json, observation, seedHistoricalVisit, startApp, type App } from './helpers.js';

describe('D1 attendance transactions, observations, and retention', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const post = (body: unknown) => app.request('/api/admin/attendance', { token: app.token, body });

  it('keeps the original observation time separate from server receipt', async () => {
    const { student } = await createStudent(app);
    const body = observation(student.id, 'check_in', { observedAt: new Date(Date.now() - 300_000).toISOString() });
    const result = await json<AttendanceResult>(await post(body), 201);
    expect(result.event.observedAt).toBe(body.observedAt);
    expect(Date.parse(result.event.receivedAt)).toBeGreaterThan(Date.parse(body.observedAt));
    expect(result.visit?.originalCheckInAt).toBe(body.observedAt);
    expect(result.event.actorId).toBe(app.actor.id);
  });

  it('permits only one arrival when different event IDs race for the same student', async () => {
    const { student } = await createStudent(app);
    const responses = await Promise.all([post(observation(student.id, 'check_in')), post(observation(student.id, 'check_in'))]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=? AND check_out_at IS NULL').bind(student.id).first('n')).toBe(1);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE student_id=?').bind(student.id).first('n')).toBe(1);
  });

  it('deduplicates simultaneous identical requests and rejects a changed payload', async () => {
    const { student } = await createStudent(app);
    const body = observation(student.id, 'check_in');
    const responses = await Promise.all([post(body), post(body)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
    const results = await Promise.all(responses.map(r => r.json() as Promise<AttendanceResult>));
    expect(results[0].event).toEqual(results[1].event);
    expect(results[0].visit).toEqual(results[1].visit);
    expect((await post({ ...body, observedAt: new Date(Date.parse(body.observedAt) - 1000).toISOString() })).status).toBe(409);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE id=?').bind(body.eventId).first('n')).toBe(1);
  });

  it('resolves an unconsumed successful response without another attendance effect', async () => {
    const { student } = await createStudent(app);
    const body = observation(student.id, 'check_in');
    // The server commits, but the client deliberately discards the response body.
    const lost = await post(body);
    expect(lost.status).toBe(201);
    await lost.body?.cancel();
    const receipt = await json<AttendanceResult>(await app.request(`/api/admin/attendance/events/${body.eventId}`, { token: app.token }));
    const retry = await json<AttendanceResult>(await post(body));
    expect(retry.event).toEqual(receipt.event);
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(student.id).first('n')).toBe(1);
  });

  it('returns the original arrival snapshot after checkout without reopening presence', async () => {
    const detail = await createStudent(app);
    const arrival = observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 120_000).toISOString() });
    const original = await json<AttendanceResult>(await post(arrival), 201);
    await json(await post(observation(detail.student.id, 'check_out', { guardianId: detail.guardians[0].id })), 201);
    const replay = await json<AttendanceResult>(await post(arrival));
    expect(replay.visit).toEqual(original.visit);
    expect(replay.visit?.checkOutAt).toBeNull();
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=? AND check_out_at IS NULL').bind(detail.student.id).first('n')).toBe(0);
  });

  it('does not treat an unverified or denied guardian as pickup permission', async () => {
    const detail = await createStudent(app);
    await json(await post(observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 120_000).toISOString() })), 201);
    for (const guardian of detail.guardians.filter(g => g.pickupAuthority !== 'allowed')) {
      expect((await post(observation(detail.student.id, 'check_out', { guardianId: guardian.id }))).status).toBe(409);
    }
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=? AND check_out_at IS NULL').bind(detail.student.id).first('n')).toBe(1);
    const departure = await json<AttendanceResult>(await post(observation(detail.student.id, 'exceptional_departure', { reason: 'Observed student leave; manager review required.' })), 201);
    expect(departure.visit?.reviewStatus).toBe('pending');
    expect(departure.visit?.departureType).toBe('exceptional_departure');
    expect(await app.db.prepare('SELECT count(*) AS n FROM reviews WHERE event_id=?').bind(departure.event.id).first('n')).toBe(1);
    await json(await post(observation(detail.student.id, 'check_in', { observedAt: new Date().toISOString() })), 201);
  });

  it('retains an unmatched observed departure without fabricating an arrival', async () => {
    const detail = await createStudent(app);
    const result = await json<AttendanceResult>(await post(observation(detail.student.id, 'exceptional_departure', { reason: 'Departure observed without a matching arrival.' })), 201);
    expect(result.visit).toBeNull();
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(detail.student.id).first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) AS n FROM reviews WHERE event_id=?').bind(result.event.id).first('n')).toBe(1);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(result.event.observedAt));
    const events = await json<{ items: { id: string }[] }>(await app.request(`/api/admin/history/events?from=${day}&to=${day}&pageSize=50`, { token: app.token }));
    expect(events.items.some(event => event.id === result.event.id)).toBe(true);
    const exportResponse = await app.request(`/api/admin/reports/attendance.csv?from=${day}&to=${day}`, { token: app.token });
    expect(exportResponse.status).toBe(200);
    expect(await exportResponse.text()).toContain(result.event.id);
  });

  it('serializes simultaneous departures without recording the student leaving twice', async () => {
    const detail = await createStudent(app);
    await json(await post(observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 120_000).toISOString() })), 201);
    const responses = await Promise.all([1, 2].map(() => post(observation(detail.student.id, 'check_out', { guardianId: detail.guardians[0].id }))));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(await app.db.prepare("SELECT count(*) AS n FROM attendance_events WHERE student_id=? AND action='check_out'").bind(detail.student.id).first('n')).toBe(1);
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=? AND check_out_at IS NULL').bind(detail.student.id).first('n')).toBe(0);
  });

  it('rejects another center’s student on both reads and attendance writes', async () => {
    const foreignStudent = crypto.randomUUID(), timestamp = new Date().toISOString();
    await app.db.batch([
      app.db.prepare('INSERT INTO centers(id,name,timezone,created_at) VALUES(?,?,?,?)').bind('other-center', 'Other synthetic center', 'UTC', timestamp),
      app.db.prepare('INSERT INTO students(id,center_id,student_code,first_name,last_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(foreignStudent, 'other-center', 'OTHER-001', 'Other', 'Student', timestamp, timestamp),
    ]);
    expect((await app.request(`/api/admin/students/${foreignStudent}`, { token: app.token })).status).toBe(404);
    expect((await post(observation(foreignStudent, 'check_in'))).status).toBe(404);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE student_id=?').bind(foreignStudent).first('n')).toBe(0);
  });

  it('preserves originals and rejects conflicting concurrent corrections', async () => {
    const detail = await createStudent(app);
    const arrival = await json<AttendanceResult>(await post(observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 300_000).toISOString() })), 201);
    const visit = arrival.visit!;
    const correctedTime = new Date(Date.parse(visit.checkInAt) + 60_000).toISOString();
    const correction = { correctionId: crypto.randomUUID(), expectedVersion: visit.version, checkInAt: correctedTime, checkOutAt: null, reason: 'Corrected from contemporaneous staff observation.' };
    const responses = await Promise.all([correction, { ...correction, correctionId: crypto.randomUUID() }].map(body => app.request(`/api/admin/visits/${visit.id}/corrections`, { token: app.token, body })));
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const stored = await app.db.prepare('SELECT * FROM visits WHERE id=?').bind(visit.id).first();
    expect(stored?.check_in_at).toBe(correctedTime);
    expect(stored?.original_check_in_at).toBe(visit.checkInAt);
    expect(await app.db.prepare('SELECT observed_at FROM attendance_events WHERE id=?').bind(arrival.event.id).first('observed_at')).toBe(visit.checkInAt);
    await expect(app.db.prepare('DELETE FROM attendance_events WHERE id=?').bind(arrival.event.id).run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
  });

  it('keeps older-than-two-year history reviewable after student deactivation', async () => {
    const detail = await createStudent(app);
    const historic = await seedHistoricalVisit(app, detail, '2024-02-29T23:30:00.000Z', '2024-03-01T00:30:00.000Z');
    await json(await app.request(`/api/admin/students/${detail.student.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    const history = await json<Page<VisitSummary>>(await app.request(`/api/admin/history?from=2024-02-29&to=2024-02-29&studentId=${detail.student.id}`, { token: app.token }));
    expect(history.total).toBe(1);
    expect(history.items[0].id).toBe(historic.visitId);
    expect(history.items[0].active).toBe(false);
    const csv = await app.request('/api/admin/reports/attendance.csv?from=2024-02-29&to=2024-02-29', { token: app.token });
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain(historic.arrivalId);
    await expect(app.db.prepare('DELETE FROM students WHERE id=?').bind(detail.student.id).run()).rejects.toThrow();
  });

  it('enforces bounded history requests and rejects nonexistent calendar dates', async () => {
    for (const query of ['from=2024-01-01&to=2026-09-14', 'from=2025-02-29&to=2025-02-29', 'pageSize=10000']) {
      expect((await app.request(`/api/admin/history?${query}`, { token: app.token })).status).toBe(400);
    }
  });
});
