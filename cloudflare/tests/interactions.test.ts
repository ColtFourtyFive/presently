import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionPage, InteractionResult } from '../shared/interactions';
import type { Staff } from '../shared/types';
import { CookieJar, createStudent, json, startApp, type App } from './helpers';

describe('immutable student communication history in Worker/D1', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const payload = (extra: Record<string, unknown> = {}) => ({ interactionId: crypto.randomUUID(), channel: 'Phone', summary: 'Spoke with the guardian. Agreed to review the schedule next week.', ...extra });
  const path = (studentId: string) => `/api/admin/students/${studentId}/interactions`;
  const create = (studentId: string, value = payload(), token = app.token) => app.request(path(studentId), { token, body: value });
  async function staff(role: Staff['role']) {
    const email = `${crypto.randomUUID()}@example.test`;
    const result = await json<{ staff: Staff }>(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: `Communication ${role}`, role } }), 201);
    return { ...result.staff, token: await app.signer.token({ email }) };
  }
  it('records every channel with server time, author attribution, original summary, and one audit entry', async () => {
    const detail = await createStudent(app), started = Date.now();
    for (const channel of ['Phone', 'Email', 'Meeting', 'Other']) {
      const value = payload({ channel, summary: '  Discussed reading progress.\nGuardian will call next week.  ', occurredAt: '2000-01-01T00:00:00.000Z', actorName: 'Spoofed' });
      const result = await json<InteractionResult>(await create(detail.student.id, value), 201);
      expect(result).toMatchObject({ replayed: false, interaction: { id: value.interactionId, studentId: detail.student.id, channel, summary: value.summary.trim(), actorId: app.actor.id, actorName: app.actor.displayName } });
      expect(Date.parse(result.interaction.occurredAt)).toBeGreaterThanOrEqual(started);
      const audit = await app.db.prepare("SELECT actor_id,actor_name,detail,created_at FROM audit_entries WHERE action='interaction_logged' AND entity_id=?").bind(value.interactionId).all();
      expect(audit.results).toEqual([{ actor_id: app.actor.id, actor_name: app.actor.displayName, detail: JSON.stringify({ studentId: detail.student.id, channel }), created_at: result.interaction.occurredAt }]);
    }
    const page = await json<InteractionPage>(await app.request(path(detail.student.id), { token: app.token }));
    expect(page.items).toHaveLength(4); expect(page.next).toBeNull(); expect(JSON.stringify(page)).not.toContain('creation_hash');
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(detail.student.id).first('n')).toBe(0);
  });
  it('makes concurrent retries return the same immutable record, rejects reused IDs, and preserves author snapshots', async () => {
    const one = await createStudent(app), two = await createStudent(app), value = payload();
    const responses = await Promise.all([create(one.student.id, value), create(one.student.id, value)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const rows = await Promise.all(responses.map(response => response.json())) as InteractionResult[];
    expect(rows[0].interaction).toEqual(rows[1].interaction); expect(rows.filter(row => row.replayed)).toHaveLength(1);
    expect((await create(one.student.id, { ...value, summary: 'Changed summary' })).status).toBe(409);
    expect((await create(one.student.id, { ...value, channel: 'Email' })).status).toBe(409);
    expect((await create(two.student.id, value)).status).toBe(409);
    const other = await staff('front_desk'); expect((await create(one.student.id, value, other.token)).status).toBe(409);
    await app.db.prepare("UPDATE staff SET display_name='Renamed owner' WHERE id=?").bind(app.actor.id).run();
    expect((await json<InteractionResult>(await create(one.student.id, value))).interaction.actorName).toBe(rows[0].interaction.actorName);
    await app.db.prepare('UPDATE staff SET display_name=? WHERE id=?').bind(app.actor.displayName, app.actor.id).run();
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE entity_id=? AND action='interaction_logged'").bind(value.interactionId).first('n')).toBe(1);
  });
  it('uses bounded stable keyset pages while newer entries arrive', async () => {
    const detail = await createStudent(app), ids = Array.from({ length: 55 }, () => crypto.randomUUID());
    await app.db.batch(ids.map((id, index) => app.db.prepare("INSERT INTO interactions(id,center_id,student_id,channel,summary,actor_id,actor_name,occurred_at,creation_hash) VALUES(?,'test-center',?,'Other',? ,?,'Synthetic author',?,'fixture')")
      .bind(id, detail.student.id, `Historical note ${index}`, app.actor.id, new Date(Date.parse('2025-01-01T00:00:00.000Z') + Math.floor(index / 2) * 1000).toISOString())));
    const initial = await json<InteractionPage>(await app.request(path(detail.student.id), { token: app.token }));
    expect(initial.items).toHaveLength(25); expect(initial.next).not.toBeNull();
    await json<InteractionResult>(await create(detail.student.id), 201);
    const collected = [...initial.items]; let after = initial.next;
    while (after) { const page = await json<InteractionPage>(await app.request(`${path(detail.student.id)}?after=${encodeURIComponent(after)}`, { token: app.token })); expect(page.items.length).toBeLessThanOrEqual(25); collected.push(...page.items); after = page.next; }
    expect(collected).toHaveLength(55); expect(new Set(collected.map(row => row.id))).toEqual(new Set(ids));
    const max = await json<InteractionPage>(await app.request(`${path(detail.student.id)}?limit=50`, { token: app.token })); expect(max.items).toHaveLength(50);
  });
  it('rejects invalid inputs and cursors without writing a log', async () => {
    const detail = await createStudent(app);
    for (const value of [payload({ interactionId: '' }), payload({ interactionId: undefined }), payload({ channel: 'SMS' }), payload({ channel: null }), payload({ summary: '  ' }), payload({ summary: 'x'.repeat(2001) }), payload({ summary: null })])
      expect([400, 422]).toContain((await create(detail.student.id, value)).status);
    for (const query of ['limit=0', 'limit=51', 'limit=1.1', 'after=invalid', `after=${encodeURIComponent(btoa(JSON.stringify(['not-a-date', crypto.randomUUID()])))}`])
      expect((await app.request(`${path(detail.student.id)}?${query}`, { token: app.token })).status).toBe(400);
    expect((await json<InteractionPage>(await app.request(path(detail.student.id), { token: app.token }))).items).toEqual([]);
  });
  it('restricts both methods to active staff operators and the selected center', async () => {
    const detail = await createStudent(app), instructor = await staff('instructor'), desk = await staff('front_desk'), manager = await staff('manager');
    for (const operator of [desk, manager]) {
      expect((await create(detail.student.id, payload(), operator.token)).status).toBe(201);
      expect((await app.request(path(detail.student.id), { token: operator.token })).status).toBe(200);
    }
    expect((await create(detail.student.id, payload(), instructor.token)).status).toBe(403);
    expect((await app.request(path(detail.student.id), { token: instructor.token })).status).toBe(403);
    expect((await app.request(path(detail.student.id))).status).toBe(401);
    expect((await app.request(path(detail.student.id), { body: payload() })).status).toBe(401);
    await json(await app.request(`/api/admin/staff/${desk.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    expect((await create(detail.student.id, payload(), desk.token)).status).toBe(403);
    expect((await app.request(path(detail.student.id), { token: desk.token })).status).toBe(403);
    const center = crypto.randomUUID(), foreign = crypto.randomUUID(), timestamp = new Date().toISOString();
    await app.db.batch([
      app.db.prepare('INSERT INTO centers(id,name,created_at) VALUES(?,?,?)').bind(center, 'Foreign center', timestamp),
      app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,created_at,updated_at) VALUES(?,?,'FOREIGN','Other','Student',?,?)").bind(foreign, center, timestamp, timestamp),
    ]);
    expect((await create(foreign)).status).toBe(404); expect((await app.request(path(foreign), { token: app.token })).status).toBe(404);
    expect((await create(crypto.randomUUID())).status).toBe(404);
    await expect(app.db.prepare("INSERT INTO interactions(id,center_id,student_id,channel,summary,actor_id,actor_name,occurred_at,creation_hash) VALUES(?,'test-center',?,'Phone','Wrong center',?,'Owner',?,'hash')").bind(crypto.randomUUID(), foreign, app.actor.id, timestamp).run()).rejects.toThrow('STUDENT_NOT_FOUND');
    await expect(app.db.prepare("INSERT INTO interactions(id,center_id,student_id,channel,summary,actor_id,actor_name,occurred_at,creation_hash) VALUES(?,'test-center',?,'Phone','Forbidden actor',?,'Instructor',?,'hash')").bind(crypto.randomUUID(), detail.student.id, instructor.id, timestamp).run()).rejects.toThrow('INTERACTION_FORBIDDEN');
  });
  it('does not expose communication to an enrolled and unlocked kiosk', async () => {
    const detail = await createStudent(app);
    await json(await app.request(`/api/admin/staff/${app.actor.id}`, { token: app.token, method: 'PATCH', body: { kioskEnabled: true, pin: '48271639' } }));
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201), jar = new CookieJar();
    await json(await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Communication boundary' } }), 201);
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: app.actor.id, pin: '48271639' } }));
    for (const method of ['GET', 'POST']) {
      expect((await jar.request(app, path(detail.student.id).replace('/api/admin', '/api/kiosk'), { method, ...(method === 'POST' ? { body: payload() } : {}) })).status).toBe(404);
      expect((await jar.request(app, path(detail.student.id), { method, ...(method === 'POST' ? { body: payload() } : {}) })).status).toBe(401);
    }
  });
  it('prevents editing or deleting saved history and rolls back creation if audit fails', async () => {
    const detail = await createStudent(app), value = payload(); await json(await create(detail.student.id, value), 201);
    await expect(app.db.prepare("UPDATE interactions SET summary='Changed' WHERE id=?").bind(value.interactionId).run()).rejects.toThrow('IMMUTABLE_INTERACTION');
    await expect(app.db.prepare('DELETE FROM interactions WHERE id=?').bind(value.interactionId).run()).rejects.toThrow('IMMUTABLE_INTERACTION');
    const failed = payload();
    await app.db.prepare("CREATE TRIGGER test_interaction_audit_failure BEFORE INSERT ON audit_entries WHEN NEW.action='interaction_logged' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END").run();
    try { expect((await create(detail.student.id, failed)).status).toBe(500); expect(await app.db.prepare('SELECT id FROM interactions WHERE id=?').bind(failed.interactionId).first()).toBeNull(); }
    finally { await app.db.prepare('DROP TRIGGER test_interaction_audit_failure').run(); }
  });
  it('honors maintenance locks while preserving reads and permits logging for inactive students', async () => {
    const detail = await createStudent(app), value = payload();
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=? WHERE id=1').bind(new Date(Date.now() + 60000).toISOString()).run();
    try {
      expect((await create(detail.student.id, value)).status).toBe(503);
      expect((await app.request(path(detail.student.id), { token: app.token })).status).toBe(200);
      expect(await app.db.prepare('SELECT id FROM interactions WHERE id=?').bind(value.interactionId).first()).toBeNull();
    } finally { await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run(); }
    await app.db.prepare('UPDATE students SET active=0 WHERE id=?').bind(detail.student.id).run();
    expect((await create(detail.student.id, value)).status).toBe(201);
  });
});
