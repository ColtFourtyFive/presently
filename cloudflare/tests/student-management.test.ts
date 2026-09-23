import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceResult, Guardian, Staff, Student, StudentDetail, VisitSummary } from '../shared/types.js';
import { CookieJar, createStudent, json, observation, startApp, type App } from './helpers.js';

describe('manager profile, guardian authority, and visit correction controls', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const detail = (studentId: string) => app.request(`/api/admin/students/${studentId}`, { token: app.token }).then(response => json<StudentDetail>(response));
  const profile = (student: Student, body: Record<string, unknown>, token = app.token) => app.request(`/api/admin/students/${student.id}`, { token, method: 'PATCH', body: { expectedRevision: student.revision, ...body } });
  const guardian = (student: Student, person: Guardian, body: Record<string, unknown>, token = app.token) => app.request(`/api/admin/students/${student.id}/guardians/${person.id}`, { token, method: 'PATCH', body: { expectedRevision: student.revision, ...body } });
  async function staff(role: Staff['role']) {
    const email = `${crypto.randomUUID()}@example.test`;
    const { staff } = await json<{ staff: Staff }>(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: `${role} manager tests`, role } }), 201);
    return { ...staff, token: await app.signer.token({ email }) };
  }
  it('returns the saved revision including newly linked guardians and preserves unrelated profile fields', async () => {
    const created = await json<{ student: Student }>(await app.request('/api/admin/students', { token: app.token, body: { studentCode: crypto.randomUUID(), firstName: 'Manager', lastName: 'Learner', grade: '2', subjects: ['Math'], guardians: [{ displayName: 'New Guardian' }] } }), 201);
    const saved = await detail(created.student.id); expect(created.student.revision).toBe(saved.student.revision); expect(saved.student.revision).toBeGreaterThan(1);
    const changed = await json<{ student: Student }>(await profile(saved.student, { grade: '3' }));
    expect(changed.student).toMatchObject({ grade: '3', firstName: 'Manager', lastName: 'Learner', subjects: ['Math'] });
    expect(changed.student.revision).toBe(saved.student.revision + 1);
  });
  it('lets only one concurrent profile edit win and creates no stale audit record', async () => {
    const { student } = await createStudent(app);
    const results = await Promise.all([profile(student, { grade: '4' }), profile(student, { grade: '5' })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE entity_id=? AND action='student_updated'").bind(student.id).first('n')).toBe(1);
    const saved = await detail(student.id); expect(['4', '5']).toContain(saved.student.grade); expect(saved.student.revision).toBe(student.revision + 1);
  });
  it('does not let a stale pickup authorization overwrite a newer denial or contact edit', async () => {
    const initial = await createStudent(app), contact = initial.guardians.find(item => item.pickupAuthority === 'unverified')!;
    await json(await guardian(initial.student, contact, { pickupAuthority: 'denied', authorityNote: 'Restriction verified with the manager.', phone: '555-0199' }));
    expect((await guardian(initial.student, contact, { pickupAuthority: 'allowed', authorityNote: 'Old screen would approve this contact.', phone: '555-0000' })).status).toBe(409);
    const saved = await detail(initial.student.id), savedContact = saved.guardians.find(item => item.id === contact.id)!;
    expect(savedContact).toMatchObject({ pickupAuthority: 'denied', authorityNote: 'Restriction verified with the manager.', phone: '555-0199' });
    expect(saved.student.revision).toBe(initial.student.revision + 2);
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE entity_id=? AND action='guardian_authority_updated'").bind(initial.student.id).first('n')).toBe(1);
  });
  it('fences concurrent guardian updates and shared-family contact changes through student revisions', async () => {
    const initial = await createStudent(app), sibling = await createStudent(app), contact = initial.guardians[0];
    await app.db.prepare('INSERT INTO student_guardians(student_id,guardian_id) VALUES(?,?)').bind(sibling.student.id, contact.id).run();
    const beforeSibling = await detail(sibling.student.id);
    const results = await Promise.all([
      guardian(initial.student, contact, { phone: '555-0109' }),
      guardian(initial.student, contact, { pickupAuthority: 'denied', authorityNote: 'Concurrent restriction update.' }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const afterSibling = await detail(sibling.student.id); expect(afterSibling.student.revision).toBeGreaterThan(beforeSibling.student.revision);
    expect((await guardian(beforeSibling.student, contact, { email: 'stale@example.test' })).status).toBe(409);
  });
  it('requires verification evidence before normal checkout and keeps deactivated open visits intact', async () => {
    let current = await createStudent(app), contact = current.guardians.find(item => item.pickupAuthority === 'unverified')!;
    await json(await app.request('/api/admin/attendance', { token: app.token, body: observation(current.student.id, 'check_in', { observedAt: new Date(Date.now() - 180000).toISOString() }) }), 201);
    expect((await guardian(current.student, contact, { pickupAuthority: 'allowed', authorityNote: '' })).status).toBe(400);
    await json(await guardian(current.student, contact, { pickupAuthority: 'allowed', authorityNote: 'Verified against the signed pickup authorization.' }));
    current = await detail(current.student.id);
    await json(await profile(current.student, { active: false, subjects: ['Math'], pickupAlert: '' }));
    const inactive = await detail(current.student.id); expect(inactive.student.active).toBe(false); expect(inactive.visits[0].checkOutAt).toBeNull();
    await json(await app.request('/api/admin/attendance', { token: app.token, body: observation(current.student.id, 'check_out', { guardianId: contact.id }) }), 201);
    expect((await detail(current.student.id)).visits[0].checkOutAt).not.toBeNull();
    await json(await profile((await detail(current.student.id)).student, { active: true }));
    expect((await detail(current.student.id)).student.active).toBe(true);
  });
  it('keeps legacy PATCH callers working while rejecting malformed revisions', async () => {
    const current = await createStudent(app);
    expect((await app.request(`/api/admin/students/${current.student.id}`, { token: app.token, method: 'PATCH', body: { grade: '6' } })).status).toBe(200);
    expect((await app.request(`/api/admin/students/${current.student.id}/guardians/${current.guardians[0].id}`, { token: app.token, method: 'PATCH', body: { phone: '555-0144' } })).status).toBe(200);
    for (const expectedRevision of [null, 0, -1, 1.5, '1']) {
      expect((await profile(current.student, { grade: '7', expectedRevision })).status).toBe(400);
      expect((await guardian(current.student, current.guardians[0], { phone: '555-0198', expectedRevision })).status).toBe(400);
    }
  });
  it('preserves owner/manager-only edits and the staff-only correction boundary', async () => {
    const current = await createStudent(app), manager = await staff('manager'), desk = await staff('front_desk'), instructor = await staff('instructor');
    const arrival = await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: observation(current.student.id, 'check_in') }), 201);
    const visit = arrival.visit!;
    expect((await app.request(`/api/admin/visits/${visit.id}`, { token: manager.token })).status).toBe(200);
    for (const staffMember of [desk, instructor]) {
      expect((await profile(current.student, { grade: '8' }, staffMember.token)).status).toBe(403);
      expect((await guardian(current.student, current.guardians[0], { phone: '555-0111' }, staffMember.token)).status).toBe(403);
      expect((await app.request(`/api/admin/visits/${visit.id}`, { token: staffMember.token })).status).toBe(403);
      expect((await app.request(`/api/admin/visits/${visit.id}/corrections`, { token: staffMember.token, body: {} })).status).toBe(403);
    }
    const latest = await detail(current.student.id); expect((await profile(latest.student, { grade: '8' }, manager.token)).status).toBe(200);
    expect((await app.request(`/api/admin/visits/${crypto.randomUUID()}`, { token: app.token })).status).toBe(404);
    expect((await app.request(`/api/admin/visits/${visit.id}`)).status).toBe(401);
    await json(await app.request(`/api/admin/staff/${app.actor.id}`, { token: app.token, method: 'PATCH', body: { kioskEnabled: true, pin: '48371952' } }));
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201), jar = new CookieJar();
    await json(await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Manager control test' } }), 201);
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: app.actor.id, pin: '48371952' } }));
    expect((await jar.request(app, `/api/kiosk/visits/${visit.id}`)).status).toBe(403);
    expect((await jar.request(app, `/api/kiosk/visits/${visit.id}/corrections`, { body: {} })).status).toBe(403);
  });
  it('replays the same correction once, rejects stale visits, and keeps original facts unchanged', async () => {
    const current = await createStudent(app), arrivalAt = new Date(Date.now() - 240000).toISOString();
    const arrival = await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: observation(current.student.id, 'check_in', { observedAt: arrivalAt }) }), 201);
    const visit = (await json<{ visit: VisitSummary }>(await app.request(`/api/admin/visits/${arrival.visit!.id}`, { token: app.token }))).visit;
    const payload = { correctionId: crypto.randomUUID(), expectedVersion: visit.version, checkInAt: new Date(Date.now() - 300000).toISOString(), checkOutAt: null, reason: 'Manager verified original observation against the log.' };
    expect((await app.request(`/api/admin/visits/${visit.id}/corrections`, { token: app.token, body: payload })).status).toBe(201);
    const replay = await json<{ replayed: boolean }>(await app.request(`/api/admin/visits/${visit.id}/corrections`, { token: app.token, body: payload })); expect(replay.replayed).toBe(true);
    expect((await app.request(`/api/admin/visits/${visit.id}/corrections`, { token: app.token, body: { ...payload, correctionId: crypto.randomUUID() } })).status).toBe(409);
    const latest = (await json<{ visit: VisitSummary }>(await app.request(`/api/admin/visits/${visit.id}`, { token: app.token }))).visit;
    expect(latest).toMatchObject({ version: visit.version + 1, originalCheckInAt: arrivalAt, checkInAt: payload.checkInAt, checkOutAt: null });
    expect(await app.db.prepare('SELECT observed_at FROM attendance_events WHERE id=?').bind(arrival.event.id).first('observed_at')).toBe(arrivalAt);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_corrections WHERE visit_id=?').bind(visit.id).first('n')).toBe(1);
  });
  it('rolls back contact, authority, and revisions if the audit write fails', async () => {
    const current = await createStudent(app), contact = current.guardians[0];
    await app.db.prepare("CREATE TRIGGER test_manager_audit_failure BEFORE INSERT ON audit_entries WHEN NEW.action IN ('guardian_authority_updated','student_updated') BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END").run();
    try {
      expect((await guardian(current.student, contact, { phone: '555-0000', pickupAuthority: 'denied', authorityNote: 'Should roll back.' })).status).toBe(500);
      expect((await profile(current.student, { grade: '9' })).status).toBe(500);
      const after = await detail(current.student.id); expect(after.student).toEqual(current.student); expect(after.guardians).toEqual(current.guardians);
    } finally { await app.db.prepare('DROP TRIGGER test_manager_audit_failure').run(); }
  });
});
