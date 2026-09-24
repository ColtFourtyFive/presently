import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminSession, Location, Staff } from '../shared/types';
import { createStudent, json, startApp, type App } from './helpers';

describe('back-office access and locations', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => { await app?.close(); });

  it('bootstraps the business, first location and owner on the owner’s first sign-in', async () => {
    const session = await json<AdminSession>(await app.admin('/session', { location: null }));
    expect(session.actor).toMatchObject({ role: 'owner', email: 'owner@example.test', channel: 'admin' });
    expect(session.locations).toHaveLength(1);
    expect(session.business.name).toBe('My business');
  });

  it('rejects unknown identities and missing or forged Access tokens', async () => {
    const stranger = await app.signer.token({ email: 'stranger@example.test', sub: 'stranger' });
    expect((await app.admin('/session', { token: stranger, location: null })).status).toBe(403);
    expect((await app.request('/api/admin/session')).status).toBe(401);
    const wrongAudience = await app.signer.token({ aud: 'another-app' });
    expect((await app.admin('/session', { token: wrongAudience, location: null })).status).toBe(401);
  });

  it('requires a location for location-scoped routes and refuses locations the staff member is not assigned to', async () => {
    const second = (await json<{ location: Location }>(await app.admin('/locations', { location: null, body: { name: 'North', timezone: 'America/Chicago' } }), 201)).location;
    await json<{ staff: Staff }>(await app.admin('/staff', { location: null, body: { email: 'manager@example.test', displayName: 'Maya Manager', role: 'manager', locationIds: [app.locationId] } }), 201);
    const manager = await app.signer.token({ email: 'manager@example.test', sub: 'manager' });

    const session = await json<AdminSession>(await app.admin('/session', { token: manager, location: null }));
    expect(session.locations.map(l => l.id)).toEqual([app.locationId]);
    expect((await json<{ error: { code: string } }>(await app.admin('/students', { token: manager, location: null }), 400)).error.code).toBe('LOCATION_REQUIRED');
    expect((await json<{ error: { code: string } }>(await app.admin('/students', { token: manager, location: second.id }), 403)).error.code).toBe('LOCATION_FORBIDDEN');
    await json(await app.admin('/students', { token: manager }));

    // Owners reach every active location and switch between them.
    const owner = await json<AdminSession>(await app.admin('/session', { location: null }));
    expect(owner.locations.map(l => l.name).sort()).toEqual(['My center', 'North']);
    const north = await createStudent(app, { studentCode: 'N-1' }, second.id);
    expect(north.student.locationId).toBe(second.id);
    // A student at another location is invisible here.
    expect((await app.admin(`/students/${north.student.id}`, { token: manager })).status).toBe(404);
  });

  it('keeps student codes unique per location but allows the same code at two locations', async () => {
    const other = (await json<{ items: Location[] }>(await app.admin('/locations', { location: null }))).items.find(l => l.name === 'North')!;
    await createStudent(app, { studentCode: 'SHARED-1' });
    await createStudent(app, { studentCode: 'SHARED-1' }, other.id);
    const duplicate = await app.admin('/students', { body: { studentCode: 'SHARED-1', firstName: 'A', lastName: 'B' } });
    expect((await json<{ error: { code: string } }>(duplicate, 409)).error.code).toBe('DUPLICATE_RECORD');
  });

  it('limits staff, location and business settings to the owner', async () => {
    const manager = await app.signer.token({ email: 'manager@example.test', sub: 'manager' });
    expect((await app.admin('/staff', { token: manager, location: null })).status).toBe(403);
    expect((await app.admin('/business', { token: manager, location: null, method: 'PATCH', body: { name: 'X' } })).status).toBe(403);
    expect((await app.admin('/locations', { token: manager, location: null, body: { name: 'Y', timezone: 'UTC' } })).status).toBe(403);
    const updated = await json<{ business: { name: string; backupHour: number } }>(await app.admin('/business', { location: null, method: 'PATCH', body: { name: 'Bright Futures LLC', backupHour: 3 } }));
    expect(updated.business).toMatchObject({ name: 'Bright Futures LLC', backupHour: 3 });
  });

  it('never removes the last active owner and never deletes staff', async () => {
    const staff = await json<{ items: Staff[] }>(await app.admin('/staff', { location: null }));
    const owner = staff.items.find(s => s.role === 'owner')!;
    const demote = await app.admin(`/staff/${owner.id}`, { location: null, method: 'PATCH', body: { role: 'manager', locationIds: [app.locationId] } });
    expect((await json<{ error: { code: string } }>(demote, 409)).error.code).toBe('LAST_OWNER');
    await expect(app.db.prepare('DELETE FROM staff WHERE id = ?').bind(owner.id).run()).rejects.toThrow(/STAFF_DELETE_FORBIDDEN/);
  });

  it('revokes access immediately when a staff member is deactivated', async () => {
    const staff = await json<{ items: Staff[] }>(await app.admin('/staff', { location: null }));
    const manager = staff.items.find(s => s.email === 'manager@example.test')!;
    await json(await app.admin(`/staff/${manager.id}`, { location: null, method: 'PATCH', body: { active: false } }));
    const token = await app.signer.token({ email: 'manager@example.test', sub: 'manager' });
    expect((await app.admin('/session', { token, location: null })).status).toBe(403);
  });

  it('lets instructors see the roster and student names but not contacts, history or edits', async () => {
    await json(await app.admin('/staff', { location: null, body: { email: 'instructor@example.test', displayName: 'Ivy Instructor', role: 'instructor', locationIds: [app.locationId] } }), 201);
    const token = await app.signer.token({ email: 'instructor@example.test', sub: 'instructor' });
    await json(await app.admin('/roster', { token }));
    const list = await json<{ items: { contact: unknown }[] }>(await app.admin('/students?status=all', { token }));
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every(item => item.contact === null)).toBe(true);
    const student = list.items[0] as unknown as { id: number };
    expect((await app.admin(`/students/${student.id}`, { token })).status).toBe(403);
    expect((await app.admin('/history', { token })).status).toBe(403);
    expect((await app.admin('/students', { token, body: { studentCode: 'Z', firstName: 'Z', lastName: 'Z' } })).status).toBe(403);
  });

  it('rejects cross-site writes', async () => {
    const response = await app.request('/api/admin/students', {
      token: app.token, body: { studentCode: 'X', firstName: 'X', lastName: 'X' },
      headers: { origin: 'https://evil.example', 'x-location-id': String(app.locationId) },
    });
    expect(response.status).toBe(403);
  });
});
