import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, startApp, type App } from './helpers';

/**
 * Storage budget. A typical center (about 200 students attending twice a
 * week) records about 20,000 visits a year. Measure the database growth per
 * visit, including the arrival and departure observations, the visit, and
 * every index, so the D1 Free plan's 500 MB limit can be projected.
 */
describe('storage footprint', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => { await app?.close(); });

  it('stays under 600 bytes per completed visit', async () => {
    const STUDENTS = 200;
    const VISITS_PER_STUDENT = 25;
    const db = app.db;
    const now = Date.now();
    const staff = app.actor.id;
    await db.batch(Array.from({ length: STUDENTS }, (_, i) => db.prepare(
      "INSERT INTO students (location_id, student_code, first_name, last_name, subjects, created_at, updated_at) VALUES (?, ?, 'Student', ?, '[\"Math\",\"Reading\"]', ?, ?)",
    ).bind(app.locationId, `K${100000 + i}`, `Number${i}`, new Date().toISOString(), new Date().toISOString())));
    await db.batch([
      db.prepare("INSERT INTO guardians (display_name, phone, email, created_at) VALUES ('Parent', '555-0100', 'parent@example.test', ?)").bind(new Date().toISOString()),
      db.prepare("INSERT INTO student_guardians (student_id, guardian_id, relationship, pickup_authority, authority_note) SELECT id, (SELECT max(id) FROM guardians), 'Parent', 'allowed', 'Verified ID' FROM students"),
    ]);
    const guardian = (await db.prepare('SELECT max(id) AS id FROM guardians').first<{ id: number }>())!.id;
    const students = (await db.prepare('SELECT id FROM students ORDER BY id').all<{ id: number }>()).results.map(r => r.id);
    const sizeBefore = (await db.prepare('SELECT 1').all()).meta.size_after!;

    const insert = 'INSERT INTO attendance_events (request_id, location_id, student_id, visit_id, action, observed_at, received_at, actor_id, device_id, guardian_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)';
    for (let day = 0; day < VISITS_PER_STUDENT; day++) {
      const arrivals = students.map(id => {
        const at = now - (400 - day * 14) * 86400000 + (id % 60) * 60000;
        return db.prepare(insert).bind(crypto.randomUUID(), app.locationId, id, null, 'check_in', at, at + 2000, staff, null);
      });
      await db.batch(arrivals);
      const open = (await db.prepare('SELECT id, student_id, check_in_at FROM visits WHERE check_out_at IS NULL').all<{ id: number; student_id: number; check_in_at: number }>()).results;
      await db.batch(open.map(v => db.prepare(insert).bind(crypto.randomUUID(), app.locationId, v.student_id, v.id, 'check_out', v.check_in_at + 3600000, v.check_in_at + 3602000, staff, guardian)));
    }
    const visits = STUDENTS * VISITS_PER_STUDENT;
    const counted = await db.prepare('SELECT count(*) AS n FROM visits WHERE check_out_at IS NOT NULL').first<{ n: number }>();
    expect(counted!.n).toBe(visits);
    const sizeAfter = (await db.prepare('SELECT 1').all()).meta.size_after!;
    const perVisit = (sizeAfter - sizeBefore) / visits;
    console.log(`Storage: ${visits} visits added ${(sizeAfter - sizeBefore).toLocaleString()} bytes = ${perVisit.toFixed(0)} bytes per visit; ` +
      `20,000 visits/year ≈ ${((perVisit * 20000) / 1e6).toFixed(1)} MB/year; 500 MB ≈ ${(500e6 / (perVisit * 20000)).toFixed(0)} location-years`);
    expect(perVisit).toBeLessThan(600);

    // The history and roster queries stay responsive at this volume.
    const roster = await app.admin('/roster');
    const metrics = JSON.parse(roster.headers.get('x-test-d1-metrics')!);
    expect(roster.status).toBe(200);
    expect(metrics.rowsRead).toBeLessThan(50);
    const history = await app.admin('/history?from=2020-01-01&to=2020-12-31');
    expect(history.status).toBe(200);
    await json(await app.admin(`/students/${students[0]}`));
  }, 120_000);
});
