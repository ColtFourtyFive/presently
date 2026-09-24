import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceResult, Device, KioskStatus, Staff } from '../shared/types.js';
import { CookieJar, createStudent, json, observation, startApp, type App } from './helpers.js';

describe('Enrolled kiosk and named staff authorization', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const pin = '48271639';

  async function staff(role: Staff['role'] = 'front_desk') {
    const result = await json<{ staff: Staff }>(await app.request('/api/admin/staff', { token: app.token, body: {
      email: `${crypto.randomUUID()}@example.test`, displayName: 'Synthetic Staff', role,
      kioskEnabled: role !== 'instructor', ...(role === 'instructor' ? {} : { pin }),
    } }), 201);
    return result.staff;
  }
  async function enroll() {
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201);
    const jar = new CookieJar();
    const response = await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Synthetic test iPad' } });
    const cookies = response.headers.getSetCookie().join(';');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    const { device } = await json<{ device: Device }>(response, 201);
    return { jar, device, grant };
  }

  it('requires enrollment before PIN entry and a PIN session before attendance', async () => {
    const operator = await staff();
    expect((await app.request('/api/kiosk/unlock', { body: { staffId: operator.id, pin } })).status).toBe(401);
    const { jar } = await enroll();
    expect((await jar.request(app, '/api/kiosk/roster')).status).toBe(401);
    const status = await json<KioskStatus>(await jar.request(app, '/api/kiosk/status'));
    expect(status.enrolled).toBe(true);
    expect(status.operator).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(/pin_hash|pin_salt|token_hash/);
  });

  it('consumes each enrollment token once, including simultaneous enrollment', async () => {
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201);
    const responses = await Promise.all([1, 2].map(() => app.request('/api/kiosk/enroll', { body: { token: grant.token, label: 'Concurrent synthetic kiosk' } })));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(responses.filter(r => [401, 409].includes(r.status))).toHaveLength(1);
  });

  it('attributes attendance to the unlocked staff member and denies back-office escalation', async () => {
    const operator = await staff();
    const { jar, device } = await enroll();
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin } }));
    const detail = await createStudent(app);
    const result = await json<AttendanceResult>(await jar.request(app, '/api/kiosk/attendance', { body: observation(detail.student.id, 'check_in') }), 201);
    expect(result.event.actorId).toBe(operator.id);
    expect(result.event.channel).toBe('kiosk');
    expect(await app.db.prepare('SELECT device_id FROM attendance_events WHERE id=?').bind(result.event.id).first('device_id')).toBe(device.id);
    expect((await jar.request(app, '/api/admin/staff')).status).toBe(401);
    expect((await jar.request(app, '/api/kiosk/students', { body: { studentCode: 'unauthorized', firstName: 'No', lastName: 'Create' } })).status).toBe(403);
    expect((await jar.request(app, '/api/kiosk/reports/attendance.csv')).status).toBe(404);
    await json(await jar.request(app, '/api/kiosk/lock', { body: {} }));
    expect((await jar.request(app, '/api/kiosk/roster')).status).toBe(401);
  });

  it('enforces the PIN attempt limit under concurrent guesses and blocks a correct PIN while locked', async () => {
    const operator = await staff();
    const { jar } = await enroll();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin: '00000000' } })));
    expect(attempts.filter(r => r.status === 401)).toHaveLength(5);
    expect(attempts.filter(r => r.status === 429)).toHaveLength(3);
    expect((await jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin } })).status).toBe(429);
    const past = new Date(Date.now() - 16 * 60_000).toISOString();
    await app.db.prepare('UPDATE pin_throttles SET window_start=?,locked_until=?').bind(past, past).run();
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin } }));
  });

  it('revokes a lost device and invalidates its existing operator session', async () => {
    const operator = await staff();
    const { jar, device } = await enroll();
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin } }));
    await json(await app.request(`/api/admin/devices/${device.id}/revoke`, { token: app.token, body: {} }));
    expect((await jar.request(app, '/api/kiosk/roster')).status).toBe(401);
    expect((await jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin } })).status).toBe(401);
    expect((await json<KioskStatus>(await jar.request(app, '/api/kiosk/status'))).enrolled).toBe(false);
  });

  it('deactivates both an existing PIN session and a previously valid Access identity', async () => {
    const operator = await staff();
    const operatorToken = await app.signer.token({ email: operator.email, sub: operator.id });
    const { jar } = await enroll();
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin } }));
    await json(await app.request(`/api/admin/staff/${operator.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    expect((await jar.request(app, '/api/kiosk/roster')).status).toBe(401);
    expect((await app.request('/api/admin/session', { token: operatorToken })).status).toBe(403);
  });

  it('does not extend the operator session through background roster polling', async () => {
    const operator = await staff();
    const { jar, device } = await enroll();
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: operator.id, pin } }));
    const before = await app.db.prepare('SELECT expires_at,last_activity_at FROM kiosk_sessions WHERE device_id=?').bind(device.id).first();
    await json(await jar.request(app, '/api/kiosk/roster'));
    const after = await app.db.prepare('SELECT expires_at,last_activity_at FROM kiosk_sessions WHERE device_id=?').bind(device.id).first();
    expect(after).toEqual(before);
    await app.db.prepare('UPDATE kiosk_sessions SET expires_at=? WHERE device_id=?').bind(new Date(Date.now() - 1000).toISOString(), device.id).run();
    expect((await jar.request(app, '/api/kiosk/roster')).status).toBe(401);
  });

  it('keeps the last owner and blocks instructor writes and enrollment', async () => {
    expect((await app.request(`/api/admin/staff/${app.actor.id}`, { token: app.token, method: 'PATCH', body: { active: false } })).status).toBe(409);
    const instructor = await staff('instructor');
    const token = await app.signer.token({ email: instructor.email, sub: instructor.id });
    expect((await app.request('/api/admin/roster', { token })).status).toBe(200);
    expect((await app.request('/api/admin/devices/enrollment', { token, body: {} })).status).toBe(403);
    const detail = await createStudent(app);
    expect((await app.request('/api/admin/attendance', { token, body: observation(detail.student.id, 'check_in') })).status).toBe(403);
    expect((await app.request('/api/admin/reports/attendance.csv', { token })).status).toBe(403);
  });
});
