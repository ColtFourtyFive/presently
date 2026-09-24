import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Schedule, SchedulesResponse } from '../shared/schedules.js';
import type { Staff } from '../shared/types.js';
import { CookieJar, createStudent, json, startApp, type App } from './helpers.js';

describe('recurring weekly schedules in the Worker/D1 runtime', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const create = (studentId: string, overrides: Record<string, unknown> = {}, token = app.token) => app.request('/api/admin/schedules', {
    token, body: { studentId, dayOfWeek: 1, startTime: '15:00', durationMinutes: 30, subject: 'Math', ...overrides },
  });
  const change = (scheduleId: string, active: boolean, token = app.token) => app.request(`/api/admin/schedules/${scheduleId}`, { token, method: 'PATCH', body: { active } });
  async function slot(studentId: string, overrides: Record<string, unknown> = {}) {
    return (await json<{ schedule: Schedule }>(await create(studentId, overrides), 201)).schedule;
  }
  async function staff(role: Staff['role']) {
    const email = `${crypto.randomUUID()}@example.test`;
    const result = await json<{ staff: Staff }>(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: `Schedule ${role}`, role } }), 201);
    return { ...result.staff, token: await app.signer.token({ email }) };
  }

  it('records a center-local recurring plan with attribution without inventing attendance', async () => {
    const { student } = await createStudent(app);
    const schedule = await slot(student.id, { dayOfWeek: 0, startTime: '09:15', durationMinutes: 45, subject: 'Reading' });
    expect(schedule).toMatchObject({ studentId: student.id, studentName: student.displayName, studentCode: student.studentCode,
      studentActive: true, dayOfWeek: 0, startTime: '09:15', durationMinutes: 45, subject: 'Reading', active: true });
    const listing = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student.id}`, { token: app.token }));
    expect(listing.timezone).toBe('America/Los_Angeles');
    expect(listing.items).toEqual([schedule]);
    const audit = await app.db.prepare("SELECT * FROM audit_entries WHERE entity_id=? AND action='schedule_created'").bind(schedule.id).first();
    expect(audit).toMatchObject({ actor_id: app.actor.id, actor_name: app.actor.displayName, entity_type: 'schedule' });
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(student.id).first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE student_id=?').bind(student.id).first('n')).toBe(0);
  });

  it('rejects malformed days, times, durations, subjects, and slots extending past midnight', async () => {
    const { student } = await createStudent(app);
    for (const invalid of [{ dayOfWeek: -1 }, { dayOfWeek: 7 }, { dayOfWeek: 1.5 }, { dayOfWeek: '1' },
      { startTime: '9:00' }, { startTime: '24:00' }, { startTime: '12:60' }, { durationMinutes: 14 },
      { durationMinutes: 181 }, { durationMinutes: 30.5 }, { durationMinutes: '30' }, { subject: 'Science' }, { startTime: '23:45', durationMinutes: 30 }]) {
      expect((await create(student.id, invalid)).status).toBe(422);
    }
    expect((await create(student.id, { dayOfWeek: 6, startTime: '23:45', durationMinutes: 15 })).status).toBe(201);
    expect((await app.request(`/api/admin/schedules/${crypto.randomUUID()}`, { token: app.token, method: 'PATCH', body: { active: 'false' } })).status).toBe(422);
  });

  it('allows only one overlapping concurrent creation, across both subjects', async () => {
    const { student } = await createStudent(app);
    const responses = await Promise.all([create(student.id), create(student.id, { subject: 'Reading', startTime: '15:15' })]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const count = await app.db.prepare('SELECT count(*) AS n FROM schedules WHERE student_id=?').bind(student.id).first('n');
    expect(count).toBe(1);
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE action='schedule_created' AND json_extract(detail,'$.studentId')=?").bind(student.id).first('n')).toBe(1);
  });

  it('allows adjacent slots, another day, and another student at the same time', async () => {
    const first = await createStudent(app), second = await createStudent(app);
    await slot(first.student.id);
    expect((await create(first.student.id, { startTime: '15:30', subject: 'Reading' })).status).toBe(201);
    expect((await create(first.student.id, { dayOfWeek: 2 })).status).toBe(201);
    expect((await create(second.student.id)).status).toBe(201);
  });

  it('retains canceled records, checks conflicts on restoration, and changes no attendance facts', async () => {
    const { student } = await createStudent(app);
    const original = await slot(student.id);
    expect((await json<{ schedule: Schedule }>(await change(original.id, false))).schedule.active).toBe(false);
    const replacement = await slot(student.id, { subject: 'Reading' });
    expect((await change(original.id, true)).status).toBe(409);
    await json(await change(replacement.id, false));
    expect((await json<{ schedule: Schedule }>(await change(original.id, true))).schedule.active).toBe(true);
    const all = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student.id}&active=all`, { token: app.token }));
    expect(all.total).toBe(2);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE student_id=?').bind(student.id).first('n')).toBe(0);
    const audit = await app.db.prepare("SELECT action FROM audit_entries WHERE entity_id=? ORDER BY created_at,id").bind(original.id).all<{ action: string }>();
    expect(audit.results.map(row => row.action).sort()).toEqual(['schedule_canceled', 'schedule_created', 'schedule_restored']);
  });

  it('enforces current active subject enrollment when creating or restoring a slot', async () => {
    const { student } = await createStudent(app, { subjects: ['Math'] });
    expect((await create(student.id, { subject: 'Reading' })).status).toBe(409);
    const schedule = await slot(student.id);
    await json(await change(schedule.id, false));
    await json(await app.request(`/api/admin/students/${student.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    expect((await create(student.id)).status).toBe(409);
    expect((await change(schedule.id, true)).status).toBe(409);
    await json(await app.request(`/api/admin/students/${student.id}`, { token: app.token, method: 'PATCH', body: { active: true, subjects: ['Reading'] } }));
    expect((await change(schedule.id, true)).status).toBe(409);
    await json(await app.request(`/api/admin/students/${student.id}`, { token: app.token, method: 'PATCH', body: { subjects: ['Math'] } }));
    expect((await change(schedule.id, true)).status).toBe(200);
    // Match Railway: deactivation does not silently cancel an existing plan.
    await json(await app.request(`/api/admin/students/${student.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    const listing = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student.id}`, { token: app.token }));
    expect(listing.items[0]).toMatchObject({ active: true, studentActive: false });
    expect((await change(schedule.id, false)).status).toBe(200);
  });

  it('permits only one restoration when canceled overlapping plans race', async () => {
    const { student } = await createStudent(app);
    const first = await slot(student.id); await json(await change(first.id, false));
    const second = await slot(student.id); await json(await change(second.id, false));
    const responses = await Promise.all([change(first.id, true), change(second.id, true)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await app.db.prepare('SELECT count(*) AS n FROM schedules WHERE student_id=? AND active=1').bind(student.id).first('n')).toBe(1);
  });

  it('paginates and filters in SQL without returning guardian contact data', async () => {
    const { student } = await createStudent(app);
    const first = await slot(student.id, { dayOfWeek: 0 });
    await slot(student.id, { dayOfWeek: 1, subject: 'Reading' });
    await slot(student.id, { dayOfWeek: 2 });
    const firstPage = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student.id}&pageSize=1`, { token: app.token }));
    const secondPage = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student.id}&pageSize=1&page=2`, { token: app.token }));
    expect(firstPage.total).toBe(3); expect(firstPage.items).toHaveLength(1); expect(secondPage.items).toHaveLength(1);
    expect(firstPage.items[0].id).toBe(first.id); expect(secondPage.items[0].id).not.toBe(first.id);
    await json(await change(first.id, false));
    const canceled = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student.id}&active=false`, { token: app.token }));
    expect(canceled.total).toBe(1); expect(canceled.items[0].id).toBe(first.id);
    const filtered = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student.id}&dayOfWeek=1&subject=Reading`, { token: app.token }));
    expect(filtered.total).toBe(1);
    expect(JSON.stringify(filtered)).not.toMatch(/guardian|phone|email|pickupAuthority/);
    for (const query of ['page=0', 'pageSize=51', 'active=maybe', 'dayOfWeek=7', 'subject=Science'])
      expect((await app.request(`/api/admin/schedules?${query}`, { token: app.token })).status).toBe(400);
  });

  it('allows front-desk scheduling and instructor reads while rejecting unauthorized writes', async () => {
    const { student } = await createStudent(app);
    const desk = await staff('front_desk'), instructor = await staff('instructor');
    const schedule = (await json<{ schedule: Schedule }>(await create(student.id, {}, desk.token), 201)).schedule;
    expect((await change(schedule.id, false, desk.token)).status).toBe(200);
    expect((await change(schedule.id, true, desk.token)).status).toBe(200);
    expect((await app.request('/api/admin/schedules', { token: instructor.token })).status).toBe(200);
    expect((await create(student.id, { dayOfWeek: 3 }, instructor.token)).status).toBe(403);
    expect((await change(schedule.id, false, instructor.token)).status).toBe(403);
    expect((await app.request('/api/admin/schedules')).status).toBe(401);
    await json(await app.request(`/api/admin/staff/${desk.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    expect((await create(student.id, { dayOfWeek: 3 }, desk.token)).status).toBe(403);
  });

  it('scopes reads and writes to the authenticated center', async () => {
    const center = crypto.randomUUID(), student = crypto.randomUUID(), schedule = crypto.randomUUID(), timestamp = new Date().toISOString();
    await app.db.batch([
      app.db.prepare('INSERT INTO centers(id,name,timezone,created_at) VALUES(?,?,?,?)').bind(center, 'Foreign center', 'UTC', timestamp),
      app.db.prepare('INSERT INTO students(id,center_id,student_code,first_name,last_name,subjects,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(student, center, 'FOREIGN', 'Other', 'Student', '["Math"]', timestamp, timestamp),
      app.db.prepare('INSERT INTO schedules(id,center_id,student_id,day_of_week,start_time,start_minute,duration_minutes,subject,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(schedule, center, student, 1, '15:00', 900, 30, 'Math', timestamp, timestamp),
    ]);
    expect((await create(student)).status).toBe(404);
    expect((await change(schedule, false)).status).toBe(404);
    const listing = await json<SchedulesResponse>(await app.request(`/api/admin/schedules?studentId=${student}&active=all`, { token: app.token }));
    expect(listing.total).toBe(0); expect(listing.items).toEqual([]);
    expect(await app.db.prepare('SELECT active FROM schedules WHERE id=?').bind(schedule).first('active')).toBe(1);
  });

  it('keeps schedules outside the enrolled kiosk API', async () => {
    await json(await app.request(`/api/admin/staff/${app.actor.id}`, { token: app.token, method: 'PATCH', body: { kioskEnabled: true, pin: '48271639' } }));
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201);
    const jar = new CookieJar();
    await json(await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Schedule boundary test' } }), 201);
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: app.actor.id, pin: '48271639' } }));
    expect((await jar.request(app, '/api/kiosk/schedules')).status).toBe(404);
    expect((await jar.request(app, '/api/kiosk/schedules', { body: {} })).status).toBe(404);
    expect((await jar.request(app, '/api/admin/schedules')).status).toBe(401);
  });

  it('honors the backup maintenance lock and rolls back an insertion if its audit fails', async () => {
    const { student } = await createStudent(app);
    const schedule = await slot(student.id);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=? WHERE id=1').bind(new Date(Date.now() + 60000).toISOString()).run();
    try {
      expect((await create(student.id, { dayOfWeek: 4 })).status).toBe(503);
      expect((await change(schedule.id, false)).status).toBe(503);
      expect((await app.request('/api/admin/schedules', { token: app.token })).status).toBe(200);
    } finally { await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run(); }
    await app.db.prepare("CREATE TRIGGER test_schedule_audit_failure BEFORE INSERT ON audit_entries WHEN NEW.action='schedule_created' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END").run();
    try {
      expect((await create(student.id, { dayOfWeek: 4 })).status).toBe(500);
      expect(await app.db.prepare('SELECT count(*) AS n FROM schedules WHERE student_id=? AND day_of_week=4').bind(student.id).first('n')).toBe(0);
    } finally { await app.db.prepare('DROP TRIGGER test_schedule_audit_failure').run(); }
  });
});
