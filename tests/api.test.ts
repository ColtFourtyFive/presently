import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { createDatabase, type Database } from '../server/db.js';
import { initializeDatabase } from '../server/seed.js';
import { tokenHash } from '../server/auth.js';
import type { Bootstrap, Student } from '../shared/types.js';

// These credentials exist only in this ephemeral test database.
const password = `Test-only-${randomUUID()}!`;
const ownerEmail = 'owner@test.invalid';
let db: Database;
let server: Server;
let baseUrl: string;
let ownerCookie: string;
let centerId: string;

interface ApiResponse<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

async function request<T = any>(path: string, options: {
  method?: string;
  body?: unknown;
  cookie?: string | null;
  headers?: Record<string, string>;
} = {}): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.cookie === null ? {} : { Cookie: options.cookie ?? ownerCookie }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: T;
  try { body = JSON.parse(text) as T; } catch { body = text as T; }
  return { status: response.status, body, text, headers: response.headers };
}

async function login(email = ownerEmail): Promise<string> {
  const result = await request('/auth/login', { body: { email, password }, cookie: null });
  expect(result.status).toBe(200);
  const cookie = result.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toMatch(/^kumon_session=/);
  return cookie!;
}

async function bootstrap(cookie = ownerCookie): Promise<Bootstrap> {
  const result = await request<Bootstrap>('/bootstrap', { cookie });
  expect(result.status).toBe(200);
  return result.body;
}

async function student(): Promise<Student> {
  const firstName = `Test-${randomUUID().slice(0, 8)}`;
  const result = await request('/students', { body: {
    firstName,
    lastName: 'Student',
    grade: '3',
    subjects: ['Math'],
    guardianName: 'Test Guardian',
    guardianEmail: 'guardian@test.invalid',
    guardianPhone: '2025550100',
  } });
  expect(result.status).toBeGreaterThanOrEqual(200);
  expect(result.status).toBeLessThan(300);
  const created = (await bootstrap()).students.find(item => item.firstName === firstName);
  expect(created).toBeDefined();
  return created!;
}

async function staff(role: 'manager' | 'front_desk' | 'instructor', targetCenter = centerId) {
  const id = randomUUID();
  const email = `${id}@test.invalid`;
  await db.query(`INSERT INTO staff (id, center_id, name, email, role, password_hash)
    SELECT $1, $2, $3, $4, $5, password_hash FROM staff WHERE email=$6`,
  [id, targetCenter, `Test ${role}`, email, role, ownerEmail]);
  return { id, email, cookie: await login(email) };
}

function attendance(studentId: string, action: 'check_in' | 'check_out' | 'exceptional_departure', extra: Record<string, unknown> = {}) {
  return request('/attendance', { body: { eventId: randomUUID(), studentId, action, ...extra } });
}

beforeAll(async () => {
  db = await createDatabase({ url: '', dataDir: 'memory://' });
  await initializeDatabase(db, { seed: false, adminEmail: ownerEmail, adminPassword: password });
  server = createServer(createApp({ db, secureCookies: false }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ownerCookie = await login();
  centerId = (await bootstrap()).center.id;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (db) await db.close();
});

describe('authentication and center scope', () => {
  it('requires a named staff session and rejects an incorrect password', async () => {
    expect((await request('/bootstrap', { cookie: null })).status).toBe(401);
    const invalid = await request('/auth/login', { cookie: null, body: { email: ownerEmail, password: 'incorrect' } });
    expect(invalid.status).toBe(401);
  });

  it('sets an HttpOnly session cookie and invalidates it on logout', async () => {
    const result = await request('/auth/login', { cookie: null, body: { email: ownerEmail, password } });
    const setCookie = result.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=(Lax|Strict)/i);
    const cookie = setCookie.split(';')[0];
    expect((await request('/auth/logout', { method: 'POST', cookie })).status).toBeLessThan(300);
    expect((await request('/bootstrap', { cookie })).status).toBe(401);
  });

  it('expires a session after 15 minutes without activity', async () => {
    const cookie = await login();
    const hash = tokenHash(cookie.slice(cookie.indexOf('=') + 1));
    await db.query("UPDATE sessions SET last_seen_at=NOW()-INTERVAL '16 minutes' WHERE token_hash=$1", [hash]);
    expect((await request('/bootstrap', { cookie })).status).toBe(401);
  });

  it('does not extend an idle session through background roster polling', async () => {
    const cookie = await login();
    const hash = tokenHash(cookie.slice(cookie.indexOf('=') + 1));
    const inactiveSince = new Date(Date.now() - 10 * 60_000).toISOString();
    await db.query('UPDATE sessions SET last_seen_at=$1 WHERE token_hash=$2', [inactiveSince, hash]);
    const background = await request('/bootstrap', { cookie, headers: { 'X-Background-Request': '1' } });
    expect(background.status).toBe(200);
    let session = await db.query('SELECT last_seen_at FROM sessions WHERE token_hash=$1', [hash]);
    expect(new Date(session.rows[0].last_seen_at).toISOString()).toBe(inactiveSince);
    expect((await request('/bootstrap', { cookie })).status).toBe(200);
    session = await db.query('SELECT last_seen_at FROM sessions WHERE token_hash=$1', [hash]);
    expect(new Date(session.rows[0].last_seen_at).getTime()).toBeGreaterThan(Date.parse(inactiveSince));
  });

  it('blocks an existing session as soon as its staff member is deactivated', async () => {
    const account = await staff('front_desk');
    expect((await request('/bootstrap', { cookie: account.cookie })).status).toBe(200);
    await db.query('UPDATE staff SET active=FALSE WHERE id=$1', [account.id]);
    expect((await request('/bootstrap', { cookie: account.cookie })).status).toBe(401);
  });

  it('does not expose another center through a roster or attendance write', async () => {
    const localStudent = await student();
    const foreignCenter = randomUUID();
    await db.query('INSERT INTO centers (id,name,timezone) VALUES ($1,$2,$3)',
      [foreignCenter, 'Other test center', 'America/New_York']);
    const otherStaff = await staff('manager', foreignCenter);
    const otherData = await bootstrap(otherStaff.cookie);
    expect(otherData.center.id).toBe(foreignCenter);
    expect(otherData.students).not.toContainEqual(expect.objectContaining({ id: localStudent.id }));
    const rejected = await request('/attendance', { cookie: otherStaff.cookie, body: {
      eventId: randomUUID(), studentId: localStudent.id, action: 'check_in', centerId,
    } });
    expect([403, 404]).toContain(rejected.status);
    expect((await bootstrap()).visits.filter(visit => visit.studentId === localStudent.id)).toHaveLength(0);
  });

  it('rejects a write from a different browser origin', async () => {
    const result = await request('/students', { headers: { Origin: 'https://unrelated.invalid' }, body: {
      firstName: 'Cross', lastName: 'Origin', grade: '3', subjects: ['Math'],
      guardianName: 'Test Guardian', guardianEmail: '', guardianPhone: '',
    } });
    expect(result.status).toBe(403);
  });
});

describe('attendance facts and integrity', () => {
  it('returns the same event on retry and rejects reuse of its key for a changed payload', async () => {
    const child = await student();
    const payload = { eventId: randomUUID(), studentId: child.id, action: 'check_in' };
    const first = await request('/attendance', { body: payload });
    expect(first.status).toBeLessThan(300);
    const retry = await request('/attendance', { body: payload });
    expect(retry.status).toBeLessThan(300);
    const conflict = await request('/attendance', { body: { ...payload, action: 'exceptional_departure', reason: 'Observed departure' } });
    expect(conflict.status).toBe(409);
    const data = await bootstrap();
    expect(data.events.filter(event => event.id === payload.eventId)).toHaveLength(1);
    expect(data.visits.filter(visit => visit.studentId === child.id && visit.status === 'open')).toHaveLength(1);
  });

  it('allows only one open visit when two stations check in the same student concurrently', async () => {
    const child = await student();
    const results = await Promise.all([attendance(child.id, 'check_in'), attendance(child.id, 'check_in')]);
    expect(results.filter(result => result.status >= 200 && result.status < 300)).toHaveLength(1);
    expect(results.filter(result => result.status === 409)).toHaveLength(1);
    const data = await bootstrap();
    expect(data.visits.filter(visit => visit.studentId === child.id && visit.status === 'open')).toHaveLength(1);
    expect(data.events.filter(event => event.studentId === child.id && event.action === 'check_in')).toHaveLength(1);
  });

  it('replays the original committed result after the student has subsequently checked out', async () => {
    const child = await student();
    const payload = { eventId: randomUUID(), studentId: child.id, action: 'check_in' };
    const first = await request('/attendance', { body: payload });
    expect(first.status).toBeLessThan(300);
    expect((await attendance(child.id, 'check_out', { guardianId: child.guardians[0].id })).status).toBeLessThan(300);
    const replay = await request('/attendance', { body: payload });
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.event).toEqual(first.body.event);
    expect(replay.body.visit).toEqual(first.body.visit);
    const data = await bootstrap();
    expect(data.visits.find(visit => visit.id === first.body.visit.id)?.status).toBe('closed');
    expect(data.events.filter(event => event.id === payload.eventId)).toHaveLength(1);
  });

  it('blocks a restricted guardian without recording a release, then accepts an authorized guardian', async () => {
    const child = await student();
    const guardian = child.guardians[0];
    expect(guardian).toBeDefined();
    expect((await attendance(child.id, 'check_in')).status).toBeLessThan(300);
    await db.query('UPDATE student_guardians SET can_pickup=FALSE WHERE center_id=$1 AND student_id=$2 AND guardian_id=$3',
      [centerId, child.id, guardian.id]);
    const denied = await attendance(child.id, 'check_out', { guardianId: guardian.id });
    expect([403, 409, 422]).toContain(denied.status);
    let data = await bootstrap();
    expect(data.visits.find(visit => visit.studentId === child.id)?.status).toBe('open');
    expect(data.events.filter(event => event.studentId === child.id && event.action === 'check_out')).toHaveLength(0);
    await db.query('UPDATE student_guardians SET can_pickup=TRUE WHERE center_id=$1 AND student_id=$2 AND guardian_id=$3',
      [centerId, child.id, guardian.id]);
    expect((await attendance(child.id, 'check_out', { guardianId: guardian.id })).status).toBeLessThan(300);
    data = await bootstrap();
    expect(data.visits.find(visit => visit.studentId === child.id)?.status).toBe('closed');
  });

  it('closes an observed exceptional departure, opens an incident, and permits a later return', async () => {
    const child = await student();
    expect((await attendance(child.id, 'check_in')).status).toBeLessThan(300);
    expect((await attendance(child.id, 'exceptional_departure', { reason: 'Student was observed leaving unexpectedly.' })).status).toBeLessThan(300);
    let data = await bootstrap();
    const departed = data.visits.find(visit => visit.studentId === child.id)!;
    expect(departed.status).toBe('closed');
    expect(departed.checkedOutAt).not.toBeNull();
    expect(departed.reconciliationStatus).toBe('review_needed');
    expect(data.incidents.filter(incident => incident.studentId === child.id && incident.status === 'open')).toHaveLength(1);
    expect((await attendance(child.id, 'check_in')).status).toBeLessThan(300);
    data = await bootstrap();
    expect(data.visits.filter(visit => visit.studentId === child.id)).toHaveLength(2);
    expect(data.visits.filter(visit => visit.studentId === child.id && visit.status === 'open')).toHaveLength(1);
  });

  it('retains an unmatched departure without fabricating an arrival', async () => {
    const child = await student();
    expect((await attendance(child.id, 'exceptional_departure', { reason: 'Departure observed, arrival was not recorded.' })).status).toBeLessThan(300);
    const data = await bootstrap();
    const events = data.events.filter(event => event.studentId === child.id);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('exceptional_departure');
    expect(events[0].visitId).toBeNull();
    expect(data.visits.filter(visit => visit.studentId === child.id)).toHaveLength(0);
    expect(data.incidents.some(incident => incident.studentId === child.id && incident.status === 'open')).toBe(true);
  });

  it('does not let instructor sessions record attendance', async () => {
    const child = await student();
    const account = await staff('instructor');
    const result = await request('/attendance', { cookie: account.cookie, body: {
      eventId: randomUUID(), studentId: child.id, action: 'check_in',
    } });
    expect(result.status).toBe(403);
  });
});

describe('inquiry conversion', () => {
  it('converts concurrent retries into one student and preserves the originating inquiry', async () => {
    const studentName = `Inquiry ${randomUUID().slice(0, 8)}`;
    const created = await request('/inquiries', { body: {
      contactName: 'Prospective Guardian', studentName,
      email: 'prospective@test.invalid', phone: '2025550101', subjects: ['Math', 'Reading'],
      source: 'Walk-in', nextAction: 'Arrange assessment', notes: 'Synthetic test inquiry.',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    } });
    expect(created.status).toBeLessThan(300);
    const before = await bootstrap();
    const inquiry = before.inquiries.find(item => item.studentName === studentName)!;
    expect(inquiry).toBeDefined();
    const results = await Promise.all([
      request(`/inquiries/${inquiry.id}/convert`, { body: {} }),
      request(`/inquiries/${inquiry.id}/convert`, { body: {} }),
    ]);
    expect(results.every(result => result.status >= 200 && result.status < 300)).toBe(true);
    const after = await bootstrap();
    const converted = after.inquiries.find(item => item.id === inquiry.id)!;
    expect(converted.stage).toBe('Enrolled');
    expect(converted.convertedStudentId).toBeTruthy();
    expect(after.students).toHaveLength(before.students.length + 1);
    expect(after.students.find(item => item.id === converted.convertedStudentId)?.subjects).toEqual(['Math', 'Reading']);
    expect(converted.contactName).toBe('Prospective Guardian');
    expect(converted.notes).toBe('Synthetic test inquiry.');
  });
});

describe('attributed attendance corrections', () => {
  it('appends manager corrections, updates the visit, and preserves the original event in history and export', async () => {
    const child = await student();
    const manager = await staff('manager');
    const arrival = await attendance(child.id, 'check_in');
    expect(arrival.status).toBeLessThan(300);
    const original = arrival.body.event;
    const firstCorrectedAt = new Date(Date.parse(original.occurredAt) - 120_000).toISOString();
    const secondCorrectedAt = new Date(Date.parse(original.occurredAt) - 60_000).toISOString();
    const first = await request(`/attendance/${original.id}/corrections`, { cookie: manager.cookie, body: {
      occurredAt: firstCorrectedAt, reason: 'Staff verified the recorded arrival was two minutes late.',
    } });
    expect(first.status).toBeLessThan(300);
    const second = await request(`/attendance/${original.id}/corrections`, { cookie: manager.cookie, body: {
      occurredAt: secondCorrectedAt, reason: 'Manager confirmed the arrival against the contemporaneous note.',
    } });
    expect(second.status).toBeLessThan(300);
    const data = await bootstrap();
    expect(data.events.find(event => event.id === original.id)?.occurredAt).toBe(original.occurredAt);
    expect(data.visits.find(visit => visit.id === original.visitId)?.checkedInAt).toBe(secondCorrectedAt);
    const corrections = await db.query('SELECT * FROM attendance_corrections WHERE center_id=$1 AND event_id=$2 ORDER BY created_at,id',
      [centerId, original.id]);
    expect(corrections.rows).toHaveLength(2);
    expect(corrections.rows.every(row => row.actor_id === manager.id && row.reason && row.created_at)).toBe(true);
    const storedOriginal = await db.query('SELECT occurred_at FROM attendance_events WHERE center_id=$1 AND id=$2', [centerId, original.id]);
    expect(new Date(storedOriginal.rows[0].occurred_at).toISOString()).toBe(original.occurredAt);
    const report = await request(`/reports/attendance.csv?from=2020-01-01&to=2030-12-31&studentId=${child.id}`);
    expect(report.status).toBe(200);
    expect(report.text).toContain(original.occurredAt);
    expect(report.text).toContain(secondCorrectedAt);
    expect(report.text).toContain('Manager confirmed the arrival against the contemporaneous note.');
  });

  it('prevents front desk staff from modifying attendance through the correction route', async () => {
    const child = await student();
    const frontDesk = await staff('front_desk');
    const arrival = await attendance(child.id, 'check_in');
    const original = arrival.body.event;
    const result = await request(`/attendance/${original.id}/corrections`, { cookie: frontDesk.cookie, body: {
      occurredAt: new Date(Date.parse(original.occurredAt) - 60_000).toISOString(), reason: 'Test correction request.',
    } });
    expect(result.status).toBe(403);
    const corrections = await db.query('SELECT id FROM attendance_corrections WHERE center_id=$1 AND event_id=$2', [centerId, original.id]);
    expect(corrections.rows).toHaveLength(0);
    expect((await bootstrap()).events.find(event => event.id === original.id)?.occurredAt).toBe(original.occurredAt);
  });

  it('rejects a correction that would place departure before arrival', async () => {
    const child = await student();
    const arrival = await attendance(child.id, 'check_in');
    const departure = await attendance(child.id, 'check_out', { guardianId: child.guardians[0].id });
    const result = await request(`/attendance/${departure.body.event.id}/corrections`, { body: {
      occurredAt: new Date(Date.parse(arrival.body.event.occurredAt) - 60_000).toISOString(), reason: 'Invalid chronology test.',
    } });
    expect(result.status).toBe(422);
    const data = await bootstrap();
    expect(data.events.find(event => event.id === departure.body.event.id)?.occurredAt).toBe(departure.body.event.occurredAt);
    expect(data.visits.find(visit => visit.id === arrival.body.event.visitId)?.checkedOutAt).toBe(departure.body.event.occurredAt);
  });
});

describe('attendance report access', () => {
  it('exports a selected student for an owner and records export attribution', async () => {
    const child = await student();
    const otherChild = await student();
    await attendance(child.id, 'check_in');
    await attendance(child.id, 'check_out', { guardianId: child.guardians[0].id });
    await attendance(otherChild.id, 'check_in');
    const report = await request(`/reports/attendance.csv?from=2020-01-01&to=2030-12-31&studentId=${child.id}`);
    expect(report.status).toBe(200);
    expect(report.headers.get('content-type')).toContain('text/csv');
    expect(report.text).toContain(child.firstName);
    expect(report.text).not.toContain(otherChild.firstName);
    const audit = await db.query("SELECT actor_id,action FROM audit_entries WHERE center_id=$1 AND LOWER(action) LIKE '%export%'", [centerId]);
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.every(entry => entry.actor_id)).toBe(true);
  });

  it('blocks front desk, instructor, and unauthenticated CSV exports', async () => {
    const frontDesk = await staff('front_desk');
    const instructor = await staff('instructor');
    expect((await request('/reports/attendance.csv', { cookie: frontDesk.cookie })).status).toBe(403);
    expect((await request('/reports/attendance.csv', { cookie: instructor.cookie })).status).toBe(403);
    expect((await request('/reports/attendance.csv', { cookie: null })).status).toBe(401);
  });

  it('does not export a student from a different center even when its ID is supplied', async () => {
    const child = await student();
    await attendance(child.id, 'check_in');
    const foreignCenter = randomUUID();
    await db.query('INSERT INTO centers (id,name,timezone) VALUES ($1,$2,$3)',
      [foreignCenter, 'Report isolation center', 'America/New_York']);
    const account = await staff('manager', foreignCenter);
    const report = await request(`/reports/attendance.csv?from=2020-01-01&to=2030-12-31&studentId=${child.id}`, { cookie: account.cookie });
    expect([200, 403, 404]).toContain(report.status);
    expect(report.text).not.toContain(child.firstName);
  });
});
