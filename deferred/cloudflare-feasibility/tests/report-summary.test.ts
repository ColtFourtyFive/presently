import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStudent, json, seedHistoricalVisit, startApp, type App } from './helpers';
import type { AttendanceSummary } from '../shared/report-summary';
import type { StudentDetail } from '../shared/types';
import { attendanceDayBoundaries } from '../worker/report-summary';

describe('SQL attendance summaries and center-local trends', () => {
  let app: App;
  beforeEach(async () => { app = await startApp(); });
  afterEach(async () => app?.close());
  const read = (from: string, to: string, token = app.token) => app.request(`/api/admin/reports/attendance/summary?from=${from}&to=${to}`, { token }).then(response => json<AttendanceSummary>(response));
  async function visit(arrival: string, departure: string, detail?: StudentDetail) {
    const student = detail || await createStudent(app); return { ...await seedHistoricalVisit(app, student, arrival, departure), detail: student };
  }
  it('keeps spring-forward visits in their arrival day and measures elapsed time through the missing hour', async () => {
    await visit('2025-03-09T07:59:00.000Z', '2025-03-09T08:01:00.000Z'); // March 8, 23:59.
    await visit('2025-03-09T08:00:00.000Z', '2025-03-09T09:00:00.000Z');
    await visit('2025-03-09T09:50:00.000Z', '2025-03-09T10:10:00.000Z'); // 01:50 -> 03:10, 20 elapsed minutes.
    await visit('2025-03-10T06:59:00.000Z', '2025-03-10T07:29:00.000Z'); // March 9, 23:59, finishes next day.
    await visit('2025-03-10T07:00:00.000Z', '2025-03-10T07:15:00.000Z');
    const day = await read('2025-03-09', '2025-03-09');
    expect(day.range).toMatchObject({ fromISO: '2025-03-09T08:00:00.000Z', toISO: '2025-03-10T07:00:00.000Z', timezone: 'America/Los_Angeles' });
    expect(day.totals).toMatchObject({ visits: 3, uniqueStudents: 3, closedVisits: 3, verifiedClosedVisits: 3, pendingReviewVisits: 0 });
    expect(day.totals.verifiedMinutes).toBeCloseTo(110, 5); expect(day.totals.averageVerifiedMinutes).toBeCloseTo(110 / 3, 5);
    const period = await read('2025-03-08', '2025-03-10');
    expect(period.days.map(row => [row.date, row.visits])).toEqual([['2025-03-08', 1], ['2025-03-09', 3], ['2025-03-10', 1]]);
    expect(attendanceDayBoundaries(period.range).map(day => (Date.parse(day.end) - Date.parse(day.start)) / 3600000)).toEqual([24, 23, 24]);
  });
  it('counts both repeated fall-back hours and stops at the next local midnight', async () => {
    await visit('2025-11-02T08:30:00.000Z', '2025-11-02T09:45:00.000Z'); // 01:30 PDT -> 01:45 PST, 75 minutes.
    await visit('2025-11-02T09:30:00.000Z', '2025-11-02T10:00:00.000Z');
    await visit('2025-11-03T07:59:00.000Z', '2025-11-03T08:15:00.000Z');
    await visit('2025-11-03T08:00:00.000Z', '2025-11-03T08:30:00.000Z');
    const period = await read('2025-11-02', '2025-11-02');
    expect(period.range).toMatchObject({ fromISO: '2025-11-02T07:00:00.000Z', toISO: '2025-11-03T08:00:00.000Z' });
    expect(period.totals.visits).toBe(3); expect(period.totals.verifiedMinutes).toBeCloseTo(121, 5); expect(period.totals.averageVerifiedMinutes).toBeCloseTo(121 / 3, 5);
    expect(attendanceDayBoundaries(period.range).map(day => (Date.parse(day.end) - Date.parse(day.start)) / 3600000)).toEqual([25]);
  });
  it('uses distinct students across days and weights only verified closed durations', async () => {
    const student = await createStudent(app);
    await visit('2025-01-10T18:00:00.000Z', '2025-01-10T18:20:00.000Z', student);
    await visit('2025-01-11T18:00:00.000Z', '2025-01-11T18:40:00.000Z', student);
    const pending = await visit('2025-01-11T19:00:00.000Z', '2025-01-11T20:00:00.000Z');
    await app.db.prepare("UPDATE visits SET review_status='pending' WHERE id=?").bind(pending.visitId).run();
    const open = await createStudent(app), eventId = crypto.randomUUID();
    await app.db.prepare("INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,payload_hash,insertion_nonce) VALUES(?,'test-center',?,?,'check_in','2025-01-11T21:00:00.000Z','2025-01-11T21:00:00.000Z',?,'Synthetic owner','admin',?,?)")
      .bind(eventId, open.student.id, crypto.randomUUID(), app.actor.id, eventId, eventId).run();
    const summary = await read('2025-01-10', '2025-01-12');
    expect(summary.days.map(day => day.visits)).toEqual([1, 3, 0]); expect(summary.days.map(day => day.students)).toEqual([1, 3, 0]);
    expect(summary.totals).toMatchObject({ visits: 4, uniqueStudents: 3, closedVisits: 3, verifiedClosedVisits: 2, pendingReviewVisits: 1 });
    expect(summary.totals.averageVerifiedMinutes).toBeCloseTo(30, 5);
    const unresolved = await read('2025-01-12', '2025-01-12'); expect(unresolved.totals.averageVerifiedMinutes).toBeNull();
  });
  it('follows effective corrections while enrollment stays current and independent of attendance dates', async () => {
    const math = await createStudent(app, { subjects: ['Math'] }), reading = await createStudent(app, { subjects: ['Reading'] });
    await createStudent(app, { subjects: ['Math', 'Reading'] }); await createStudent(app, { active: false, subjects: ['Reading'] });
    const recorded = await visit('2025-01-10T07:50:00.000Z', '2025-01-10T08:30:00.000Z', math);
    expect((await read('2025-01-09', '2025-01-09')).totals.visits).toBe(1);
    await json(await app.request(`/api/admin/visits/${recorded.visitId}/corrections`, { token: app.token, body: { correctionId: crypto.randomUUID(), expectedVersion: 2, checkInAt: '2025-01-10T08:00:00.000Z', checkOutAt: '2025-01-10T08:30:00.000Z', reason: 'Paper arrival record was checked by the manager.' } }), 201);
    const previous = await read('2025-01-09', '2025-01-09'), effective = await read('2025-01-10', '2025-01-10');
    expect(previous.totals.visits).toBe(0); expect(effective.totals.visits).toBe(1); expect(effective.totals.averageVerifiedMinutes).toBeCloseTo(30, 5);
    expect(effective.enrollment).toEqual({ activeStudents: 3, inactiveStudents: 1, math: 2, reading: 2, both: 1 }); expect(previous.enrollment).toEqual(effective.enrollment);
    await app.db.prepare('UPDATE students SET active=0 WHERE id=?').bind(reading.student.id).run();
    expect((await read('2025-01-10', '2025-01-10')).enrollment).toEqual({ activeStudents: 2, inactiveStudents: 2, math: 2, reading: 1, both: 1 });
  });
  it('returns every empty day with a bounded yearly response and no invented activity', async () => {
    const summary = await read('2024-01-01', '2024-12-31');
    expect(summary.days).toHaveLength(366); expect(summary.days[59].date).toBe('2024-02-29');
    expect(summary.totals).toEqual({ visits: 0, closedVisits: 0, verifiedClosedVisits: 0, pendingReviewVisits: 0, verifiedMinutes: 0, uniqueStudents: 0, averageVerifiedMinutes: null });
    expect(summary.enrollment).toEqual({ activeStudents: 0, inactiveStudents: 0, math: 0, reading: 0, both: 0 });
    expect(new TextEncoder().encode(JSON.stringify(summary)).length).toBeLessThan(100 * 1024);
    for (const [from, to] of [['2024-01-01', '2025-01-01'], ['2025-02-30', '2025-03-01'], ['2025-02-01', '2025-01-01']])
      expect((await app.request(`/api/admin/reports/attendance/summary?from=${from}&to=${to}`, { token: app.token })).status).toBe(400);
  });
  it('checks staff roles, hides other centers, and uses the center timezone rather than UTC dates', async () => {
    for (const role of ['instructor', 'front_desk', 'manager']) {
      const email = `${role}@example.test`;
      await json(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: role, role } }), 201);
      const token = await app.signer.token({ email });
      expect((await app.request('/api/admin/reports/attendance/summary?from=2025-01-01&to=2025-01-01', { token })).status).toBe(role === 'manager' ? 200 : 403);
    }
    expect((await app.request('/api/admin/reports/attendance/summary')).status).toBe(401);
    const center = crypto.randomUUID(), timestamp = new Date().toISOString();
    await app.db.batch([
      app.db.prepare('INSERT INTO centers(id,name,created_at) VALUES(?,?,?)').bind(center, 'Foreign', timestamp),
      app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,subjects,created_at,updated_at) VALUES(?,?,'FOREIGN','Foreign','Student','[\"Math\"]',?,?)").bind(crypto.randomUUID(), center, timestamp, timestamp),
    ]);
    await app.db.prepare("UPDATE centers SET timezone='Asia/Kolkata' WHERE id='test-center'").run();
    await visit('2025-01-09T18:30:00.000Z', '2025-01-09T19:00:00.000Z');
    const summary = await read('2025-01-10', '2025-01-10');
    expect(summary.range).toMatchObject({ fromISO: '2025-01-09T18:30:00.000Z', toISO: '2025-01-10T18:30:00.000Z', timezone: 'Asia/Kolkata' });
    expect(summary.totals.visits).toBe(1); expect(summary.enrollment.activeStudents).toBe(1);
  });
});
