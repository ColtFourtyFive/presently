import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceResult, KioskStatus, KioskStudentDetail, Location } from '../shared/types';
import { CookieJar, createStudent, json, observation, startApp, unlockedKiosk, type App } from './helpers';

describe('front-desk kiosk', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => { await app?.close(); });

  it('enrolls once with a short-lived code and binds the device to its location', async () => {
    const { token } = await json<{ token: string }>(await app.admin('/devices/enrollment', { body: { locationId: app.locationId } }), 201);
    const jar = new CookieJar();
    expect((await jar.request(app, '/api/kiosk/enroll', { body: { token: 'wrong', label: 'iPad' } })).status).toBe(401);
    await json(await jar.request(app, '/api/kiosk/enroll', { body: { token, label: 'iPad' } }), 201);
    expect((await new CookieJar().request(app, '/api/kiosk/enroll', { body: { token, label: 'Second iPad' } })).status).toBe(401);
    const status = await json<KioskStatus>(await jar.request(app, '/api/kiosk/status'));
    expect(status).toMatchObject({ enrolled: true, location: { id: app.locationId } });
    expect(status.operator).toBeUndefined();
    expect((await jar.request(app, '/api/kiosk/roster')).status).toBe(401);
  });

  it('unlocks with an individual PIN, stores only a keyed hash, and locks out repeated guesses', async () => {
    const kiosk = await unlockedKiosk(app);
    const stored = await app.db.prepare('SELECT pin_hash FROM staff WHERE id = ?').bind(kiosk.staffId).first<{ pin_hash: string }>();
    expect(stored!.pin_hash).toMatch(/^v1:/);
    expect(stored!.pin_hash).not.toContain(kiosk.pin);
    await json(await kiosk.jar.request(app, '/api/kiosk/roster'));
    await json(await kiosk.jar.request(app, '/api/kiosk/lock', { body: {} }));
    expect((await kiosk.jar.request(app, '/api/kiosk/roster')).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await kiosk.jar.request(app, '/api/kiosk/unlock', { body: { staffId: kiosk.staffId, pin: '00000000' } })).status).toBe(401);
    const locked = await kiosk.jar.request(app, '/api/kiosk/unlock', { body: { staffId: kiosk.staffId, pin: kiosk.pin } });
    expect((await json<{ error: { code: string } }>(locked, 429)).error.code).toBe('PIN_LOCKED');
  });

  it('records attendance attributed to the operator and device', async () => {
    const kiosk = await unlockedKiosk(app);
    const detail = await createStudent(app);
    const result = await json<AttendanceResult>(await kiosk.jar.request(app, '/api/kiosk/attendance', { body: observation(detail.student.id, 'check_in') }), 201);
    expect(result.event.channel).toBe('kiosk');
    expect(result.event.actorId).toBe(kiosk.staffId);
  });

  it('shows pickup authority on the shared kiosk but never guardian phone numbers, emails or notes', async () => {
    const kiosk = await unlockedKiosk(app);
    const detail = await createStudent(app);
    const view = await json<KioskStudentDetail>(await kiosk.jar.request(app, `/api/kiosk/students/${detail.student.id}`));
    expect(view.guardians.length).toBe(3);
    for (const guardian of view.guardians) {
      expect(Object.keys(guardian).sort()).toEqual(['displayName', 'id', 'pickupAuthority', 'relationship']);
    }
    const raw = JSON.stringify(await (await kiosk.jar.request(app, `/api/kiosk/students?q=${encodeURIComponent('Approved')}`)).json());
    expect(raw).not.toContain('555-0101');
    expect(raw).not.toContain('guardian@example.test');
  });

  it('refuses back-office actions from the kiosk', async () => {
    const kiosk = await unlockedKiosk(app);
    const detail = await createStudent(app);
    expect((await kiosk.jar.request(app, '/api/kiosk/students', { body: { studentCode: 'K', firstName: 'K', lastName: 'K' } })).status).toBe(403);
    expect((await kiosk.jar.request(app, '/api/kiosk/history')).status).toBe(403);
    expect((await kiosk.jar.request(app, `/api/kiosk/students/${detail.student.id}`, { method: 'PATCH', body: { firstName: 'X' } })).status).toBe(403);
  });

  it('keeps a kiosk to its own location and its assigned staff', async () => {
    const north = (await json<{ location: Location }>(await app.admin('/locations', { location: null, body: { name: 'North', timezone: 'America/New_York' } }), 201)).location;
    const southKiosk = await unlockedKiosk(app);
    const northStudent = await createStudent(app, {}, north.id);
    expect((await southKiosk.jar.request(app, `/api/kiosk/students/${northStudent.student.id}`)).status).toBe(404);
    const response = await southKiosk.jar.request(app, '/api/kiosk/attendance', { body: observation(northStudent.student.id, 'check_in') });
    expect((await json<{ error: { code: string } }>(response, 404)).error.code).toBe('STUDENT_NOT_FOUND');
    // A front-desk PIN assigned only to the south location cannot unlock a north kiosk.
    const { token } = await json<{ token: string }>(await app.admin('/devices/enrollment', { body: { locationId: north.id } }), 201);
    const northJar = new CookieJar();
    await json(await northJar.request(app, '/api/kiosk/enroll', { body: { token, label: 'North iPad' } }), 201);
    const status = await json<KioskStatus>(await northJar.request(app, '/api/kiosk/status'));
    expect(status.staff.map(s => s.id)).not.toContain(southKiosk.staffId);
    expect((await northJar.request(app, '/api/kiosk/unlock', { body: { staffId: southKiosk.staffId, pin: southKiosk.pin } })).status).toBe(401);
  });

  it('ends kiosk sessions when the device is revoked or the staff member changes', async () => {
    const kiosk = await unlockedKiosk(app);
    await json(await app.admin(`/staff/${kiosk.staffId}`, { location: null, method: 'PATCH', body: { displayName: 'Renamed' } }));
    expect((await kiosk.jar.request(app, '/api/kiosk/roster')).status).toBe(401);
    const other = await unlockedKiosk(app);
    const device = (await json<KioskStatus>(await other.jar.request(app, '/api/kiosk/status'))).device!;
    await json(await app.admin(`/devices/${device.id}/revoke`, { location: null, body: {} }));
    expect((await other.jar.request(app, '/api/kiosk/roster')).status).toBe(401);
    expect((await json<KioskStatus>(await other.jar.request(app, '/api/kiosk/status'))).enrolled).toBe(false);
  });
});
