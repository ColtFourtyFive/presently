import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DailyObservation, DepartedStudent, FrontDeskView, PlannedStudent } from '../shared/frontdesk';
import type { FollowUpTask } from '../shared/inquiries';
import type { StudentDetail } from '../shared/types';
import { frontDeskDay, readFrontDeskPage } from '../worker/frontdesk';
import { CookieJar, createStudent, json, seedHistoricalVisit, startApp, type App } from './helpers';
import type { IsolatedStatement, QueryResult } from './runtime';

describe('bounded front-desk plans and recorded activity in native D1', () => {
  let app: App;
  beforeEach(async () => { app = await startApp(); });
  afterEach(async () => app?.close());
  const sunday = () => frontDeskDay('America/Los_Angeles', '2025-03-09T20:00:00.000Z');
  const read = (view: FrontDeskView, page = 1, pageSize = 25, day = sunday()) => readFrontDeskPage(app.db as unknown as D1Database, 'test-center', day, view, page, pageSize);
  async function schedule(detail: StudentDetail, extra: Record<string, unknown> = {}) {
    const result = await json<{ schedule: { id: string } }>(await app.request('/api/admin/schedules', { token: app.token, body: { studentId: detail.student.id, dayOfWeek: 0, startTime: '09:00', durationMinutes: 30, subject: 'Math', ...extra } }), 201);
    return result.schedule.id;
  }
  async function open(detail: StudentDetail, at: string) {
    const eventId = crypto.randomUUID(), visitId = crypto.randomUUID();
    await app.db.prepare("INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,payload_hash,insertion_nonce) VALUES(?,'test-center',?,?,'check_in',?,?,?,'Synthetic owner','admin',?,?)")
      .bind(eventId, detail.student.id, visitId, at, at, app.actor.id, eventId, eventId).run();
    return visitId;
  }
  async function unmatched(detail: StudentDetail, at = '2025-03-09T20:00:00.000Z') {
    const eventId = crypto.randomUUID();
    await app.db.prepare("INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,reason,payload_hash,insertion_nonce) VALUES(?,'test-center',?,NULL,'exceptional_departure',?,?,?,'Synthetic owner','admin','No matching arrival was recorded',?,?)")
      .bind(eventId, detail.student.id, at, at, app.actor.id, eventId, eventId).run();
    return eventId;
  }
  it('uses center-local weekdays and exact spring/fall midnight boundaries', async () => {
    const spring = frontDeskDay('America/Los_Angeles', '2025-03-10T06:30:00.000Z');
    expect(spring).toMatchObject({ date: '2025-03-09', dayOfWeek: 0, fromISO: '2025-03-09T08:00:00.000Z', toISO: '2025-03-10T07:00:00.000Z' });
    const fall = frontDeskDay('America/Los_Angeles', '2025-11-03T07:30:00.000Z');
    expect(fall).toMatchObject({ date: '2025-11-02', dayOfWeek: 0, fromISO: '2025-11-02T07:00:00.000Z', toISO: '2025-11-03T08:00:00.000Z' });
    expect((Date.parse(spring.toISO) - Date.parse(spring.fromISO)) / 3600000).toBe(23);
    expect((Date.parse(fall.toISO) - Date.parse(fall.fromISO)) / 3600000).toBe(25);
    const detail = await createStudent(app); await schedule(detail);
    await schedule(detail, { dayOfWeek: 1, startTime: '10:00' });
    expect((await read('expected', 1, 25, spring)).total).toBe(1);
    const before = await createStudent(app), start = await createStudent(app), end = await createStudent(app);
    await unmatched(before, '2025-03-09T07:59:59.999Z'); await unmatched(start, spring.fromISO); await unmatched(end, spring.toISO);
    const observations = await read('observations', 1, 25, spring);
    expect(observations.total).toBe(1); expect((observations.items[0] as DailyObservation).studentId).toBe(start.student.id);
  });
  it('groups valid weekly lessons by student and never derives an arrival from a schedule', async () => {
    const awaiting = await createStudent(app); await schedule(awaiting); await schedule(awaiting, { startTime: '10:00', subject: 'Reading' });
    const arrived = await createStudent(app); await schedule(arrived, { startTime: '11:00' });
    await seedHistoricalVisit(app, arrived, '2025-03-09T18:00:00.000Z', '2025-03-09T18:30:00.000Z');
    const overnight = await createStudent(app); await schedule(overnight, { startTime: '12:00' });
    const overnightVisit = await open(overnight, '2025-03-08T20:00:00.000Z');
    await app.db.prepare("UPDATE visits SET review_status='pending' WHERE id=?").bind(overnightVisit).run();
    const exception = await createStudent(app); await schedule(exception, { startTime: '13:00' }); await unmatched(exception);
    const inactive = await createStudent(app); await schedule(inactive); await app.db.prepare('UPDATE students SET active=0 WHERE id=?').bind(inactive.student.id).run();
    const removed = await createStudent(app); await schedule(removed, { subject: 'Reading' }); await app.db.prepare("UPDATE students SET subjects='[\"Math\"]' WHERE id=?").bind(removed.student.id).run();
    const canceled = await createStudent(app), canceledId = await schedule(canceled); await app.db.prepare('UPDATE schedules SET active=0 WHERE id=?').bind(canceledId).run();
    const before = await app.db.prepare('SELECT (SELECT count(*) FROM visits) AS visits,(SELECT count(*) FROM attendance_events) AS observations').first();
    const planned = await read('expected', 1, 2), next = await read('expected', 2, 2);
    expect(planned.counts).toEqual({ expectedStudents: 4, expectedLessons: 5, awaitingStudents: 1, excludedInactiveLessons: 1, excludedSubjectLessons: 1 });
    expect(planned.items).toHaveLength(2); expect(next.items).toHaveLength(2);
    const rows = [...planned.items, ...next.items] as PlannedStudent[];
    expect(new Set(rows.map(row => row.studentId)).size).toBe(4);
    expect(rows.find(row => row.studentId === awaiting.student.id)).toMatchObject({ lessonCount: 2, firstLessonTime: '09:00', subjects: ['Math', 'Reading'], arrivalRecorded: false, openVisitRecorded: false });
    expect(rows.find(row => row.studentId === overnight.student.id)).toMatchObject({ arrivalRecorded: false, openVisitRecorded: true, openVisitNeedsReview: true });
    expect((await read('awaiting')).items.map(row => (row as PlannedStudent).studentId)).toEqual([awaiting.student.id]);
    expect(await app.db.prepare('SELECT (SELECT count(*) FROM visits) AS visits,(SELECT count(*) FROM attendance_events) AS observations').first()).toEqual(before);
  });
  it('shows repeated and inactive departures, flags unmatched departures, and excludes reentered students', async () => {
    const repeated = await createStudent(app);
    await seedHistoricalVisit(app, repeated, '2025-03-09T07:00:00.000Z', '2025-03-09T08:30:00.000Z');
    await seedHistoricalVisit(app, repeated, '2025-03-09T18:00:00.000Z', '2025-03-09T18:45:00.000Z');
    const returned = await createStudent(app);
    await seedHistoricalVisit(app, returned, '2025-03-09T16:00:00.000Z', '2025-03-09T16:30:00.000Z'); await open(returned, '2025-03-09T17:00:00.000Z');
    const inactive = await createStudent(app); await seedHistoricalVisit(app, inactive, '2025-03-09T18:00:00.000Z', '2025-03-09T18:15:00.000Z');
    await app.db.prepare('UPDATE students SET active=0 WHERE id=?').bind(inactive.student.id).run();
    const exception = await createStudent(app); await unmatched(exception);
    const response = await read('departed'), items = response.items as DepartedStudent[];
    expect(response.total).toBe(3); expect(items.some(row => row.studentId === returned.student.id)).toBe(false);
    expect(items.find(row => row.studentId === repeated.student.id)).toMatchObject({ departureCount: 2, lastDepartureAt: '2025-03-09T18:45:00.000Z', includesUnmatched: false });
    expect(items.find(row => row.studentId === inactive.student.id)).toMatchObject({ active: false, departureCount: 1 });
    expect(items.find(row => row.studentId === exception.student.id)).toMatchObject({ includesUnmatched: true, needsReview: true });
  });
  it('seeks departures by checkout date and avoids historical departure work during scheduled polling', async () => {
    const detail = await createStudent(app); await schedule(detail);
    const guardian = detail.guardians.find(item => item.pickupAuthority === 'allowed')!;
    await app.db.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<4000)
      INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce)
      SELECT 'frontdesk-history-event-'||n,'test-center',?,'frontdesk-history-visit-'||((n+1)/2),iif(n%2=1,'check_in','check_out'),
       strftime('%Y-%m-%dT%H:%M:%fZ','2024-02-12T12:00:00.000Z','+'||n||' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ','2024-02-12T12:00:00.000Z','+'||n||' seconds'),?,'Synthetic owner','admin',iif(n%2=1,NULL,?),'hash-'||n,'nonce-'||n
      FROM seq`).bind(detail.student.id, app.actor.id, guardian.id).run();
    await seedHistoricalVisit(app, detail, '2025-03-09T18:00:00.000Z', '2025-03-09T18:30:00.000Z');
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits').first('n')).toBe(2001);
    const captured: { statements: IsolatedStatement[]; results: QueryResult[] }[] = [];
    const measured = {
      prepare: (sql: string) => app.db.prepare(sql),
      async batch(statements: IsolatedStatement[]) {
        const results = await app.db.batch(statements); captured.push({ statements, results }); return results;
      },
    };
    const evidence: Record<string, { rowsRead: number; rowsWritten: number; plans: string[] }> = {};
    for (const view of ['departed', 'expected'] as const) {
      const response = await readFrontDeskPage(measured as unknown as D1Database, 'test-center', sunday(), view, 1, 25);
      expect(response.total).toBe(1);
      const batch = captured.at(-1)!;
      const plans = await Promise.all(batch.statements.slice(0, 2).map(async statement => {
        const plan = await app.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.args).all();
        return plan.results.map(row => String(row.detail)).join('\n');
      }));
      const rowsRead = batch.results.reduce((sum, result) => sum + result.meta.rows_read, 0);
      const rowsWritten = batch.results.reduce((sum, result) => sum + result.meta.rows_written, 0);
      evidence[view] = { rowsRead, rowsWritten, plans };
      expect(rowsWritten).toBe(0);
      expect(rowsRead).toBeLessThan(250);
      for (const plan of plans) {
        if (view === 'departed') expect(plan).toMatch(/visits_center_departures \(center_id=\? AND check_out_at>\? AND check_out_at<\?\)/);
        else expect(plan).not.toMatch(/departed|departures/);
      }
    }
    console.log('Front desk native query evidence', JSON.stringify({ historicalVisits: 2000, currentDayVisits: 1, ...evidence }));
  });
  it('keeps original daily observations separate from corrected effective departure dates', async () => {
    const detail = await createStudent(app), recorded = await seedHistoricalVisit(app, detail, '2025-03-09T06:30:00.000Z', '2025-03-09T08:30:00.000Z');
    expect((await read('departed')).total).toBe(1); expect((await read('observations')).total).toBe(1);
    await json(await app.request(`/api/admin/visits/${recorded.visitId}/corrections`, { token: app.token, body: { correctionId: crypto.randomUUID(), expectedVersion: 2, checkInAt: '2025-03-09T06:30:00.000Z', checkOutAt: '2025-03-09T07:30:00.000Z', reason: 'Manager checked the previous evening paper departure time.' } }), 201);
    expect((await read('departed')).total).toBe(0);
    const observations = await read('observations'); expect(observations.total).toBe(1);
    expect(observations.items[0]).toMatchObject({ observedAt: '2025-03-09T08:30:00.000Z', action: 'check_out' });
    expect(JSON.stringify(observations)).not.toMatch(/guardian|phone|email|payload_hash|insertion_nonce|pickup_alert/);
  });
  it('pages only pending follow-ups due before the local-day end and reuses idempotent completion', async () => {
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    const due = ['2025-03-08T18:00:00.000Z', '2025-03-10T06:59:59.999Z', '2025-03-10T07:00:00.000Z', '2025-03-08T19:00:00.000Z'];
    await app.db.batch(ids.map((id, index) => app.db.prepare("INSERT INTO tasks(id,center_id,title,detail,due_at,completed_at) VALUES(?,'test-center',?,'Synthetic follow-up',?,?)").bind(id, `Follow-up ${index}`, due[index], index === 3 ? '2025-03-09T10:00:00.000Z' : null)));
    const first = await read('followups', 1, 1), second = await read('followups', 2, 1);
    expect(first.total).toBe(2); expect((first.items[0] as FollowUpTask).id).toBe(ids[0]); expect((second.items[0] as FollowUpTask).id).toBe(ids[1]);
    for (let retry = 0; retry < 2; retry++) await json(await app.request(`/api/admin/tasks/${ids[0]}/complete`, { token: app.token, body: {} }));
    expect((await read('followups')).total).toBe(1);
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE entity_id=? AND action='task_completed'").bind(ids[0]).first('n')).toBe(1);
  });
  it('keeps all views bounded, validates pages, and returns honest empty results', async () => {
    for (const view of ['expected', 'awaiting', 'departed', 'observations', 'followups'] as const) {
      const result = await read(view); expect(result.total).toBe(0); expect(result.items).toEqual([]);
      expect(result.day.date).toBe('2025-03-09');
    }
    for (const query of ['view=invalid', 'page=0', 'pageSize=51', 'pageSize=1.5', 'page=10001'])
      expect((await app.request(`/api/admin/frontdesk/today?${query}`, { token: app.token })).status).toBe(400);
    const detail = await createStudent(app);
    for (let index = 0; index < 4; index++) await seedHistoricalVisit(app, detail, `2025-03-09T${String(12 + index).padStart(2, '0')}:00:00.000Z`, `2025-03-09T${String(12 + index).padStart(2, '0')}:30:00.000Z`);
    const one = await read('observations', 1, 5), two = await read('observations', 2, 5);
    expect(one.total).toBe(8); expect(one.items).toHaveLength(5); expect(two.items).toHaveLength(3);
    expect(new Set([...one.items, ...two.items].map(row => (row as DailyObservation).id)).size).toBe(8);
  });
  it('restricts front-desk data to active admin operators and keeps foreign centers and kiosk credentials out', async () => {
    for (const role of ['owner', 'manager', 'front_desk', 'instructor']) {
      const email = `${role}-frontdesk@example.test`;
      const { staff } = await json<{ staff: { id: string } }>(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: role, role } }), 201);
      const token = await app.signer.token({ email });
      for (const view of ['expected', 'awaiting', 'departed', 'observations', 'followups'])
        expect((await app.request(`/api/admin/frontdesk/today?view=${view}`, { token })).status).toBe(role === 'instructor' ? 403 : 200);
      if (role === 'front_desk') { await app.db.prepare('UPDATE staff SET active=0 WHERE id=?').bind(staff.id).run(); expect((await app.request('/api/admin/frontdesk/today', { token })).status).toBe(403); }
    }
    expect((await app.request('/api/admin/frontdesk/today')).status).toBe(401);
    const foreignCenter = crypto.randomUUID(), foreignStudent = crypto.randomUUID(), timestamp = new Date().toISOString();
    await app.db.batch([
      app.db.prepare('INSERT INTO centers(id,name,created_at) VALUES(?,?,?)').bind(foreignCenter, 'Foreign center', timestamp),
      app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,subjects,created_at,updated_at) VALUES(?,?,'FOREIGN','Other','Student','[\"Math\"]',?,?)").bind(foreignStudent, foreignCenter, timestamp, timestamp),
      app.db.prepare("INSERT INTO schedules(id,center_id,student_id,day_of_week,start_time,start_minute,duration_minutes,subject,created_at,updated_at) VALUES(?,?,?,0,'09:00',540,30,'Math',?,?)").bind(crypto.randomUUID(), foreignCenter, foreignStudent, timestamp, timestamp),
      app.db.prepare("INSERT INTO tasks(id,center_id,title,due_at) VALUES(?,?,'Foreign family','2025-03-09T12:00:00.000Z')").bind(crypto.randomUUID(), foreignCenter),
    ]);
    expect((await read('expected')).total).toBe(0); expect((await read('followups')).total).toBe(0);
    await json(await app.request(`/api/admin/staff/${app.actor.id}`, { token: app.token, method: 'PATCH', body: { kioskEnabled: true, pin: '48271639' } }));
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201), jar = new CookieJar();
    await json(await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Front desk privacy test' } }), 201);
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: app.actor.id, pin: '48271639' } }));
    expect((await jar.request(app, '/api/kiosk/frontdesk/today')).status).toBe(404); expect((await jar.request(app, '/api/admin/frontdesk/today')).status).toBe(401);
  });
});
