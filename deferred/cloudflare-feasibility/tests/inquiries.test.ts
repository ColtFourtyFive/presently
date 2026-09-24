import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Inquiry, InquiryConversion, InquiryHistory, InquiryList, FollowUpTask } from '../shared/inquiries.js';
import type { Page, Staff, StudentDetail } from '../shared/types.js';
import { CookieJar, createStudent, json, startApp, type App } from './helpers.js';

describe('inquiries, follow-up tasks, and enrollment in the Worker/D1 runtime', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const payload = (extra: Record<string, unknown> = {}) => ({ inquiryId: crypto.randomUUID(), contactName: 'Synthetic Guardian', studentName: 'Casey Example', email: 'family@example.test', phone: '555-0171', subjects: ['Math', 'Reading'], source: 'Website', nextAction: 'Call the family', dueAt: '2027-02-18T16:00:00-08:00', notes: 'Asks about afternoon lessons.', ...extra });
  const create = (value = payload(), token = app.token) => app.request('/api/admin/inquiries', { token, body: value });
  async function inquiry(extra: Record<string, unknown> = {}) { return (await json<{ inquiry: Inquiry }>(await create(payload(extra)), 201)).inquiry; }
  const patch = (row: Inquiry, value: Record<string, unknown>, token = app.token) => app.request(`/api/admin/inquiries/${row.id}`, { token, method: 'PATCH', body: { expectedVersion: row.version, ...value } });
  const convert = (row: Inquiry, value: Record<string, unknown> = {}, token = app.token) => app.request(`/api/admin/inquiries/${row.id}/convert`, { token, body: value });
  const tasks = (row: Inquiry, status = 'all') => app.request(`/api/admin/tasks?inquiryId=${row.id}&status=${status}`, { token: app.token }).then(response => json<Page<FollowUpTask>>(response));
  async function staff(role: Staff['role']) {
    const email = `${crypto.randomUUID()}@example.test`;
    const result = await json<{ staff: Staff }>(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: `Inquiry ${role}`, role } }), 201);
    return { ...result.staff, token: await app.signer.token({ email }) };
  }

  it('retains all inquiry fields and attributes the first stage and follow-up', async () => {
    const row = await inquiry({ email: 'Family@EXAMPLE.test' });
    expect(row).toMatchObject({ contactName: 'Synthetic Guardian', studentName: 'Casey Example', email: 'family@example.test', phone: '555-0171', subjects: ['Math', 'Reading'], source: 'Website', ownerName: app.actor.displayName, stage: 'New', nextAction: 'Call the family', dueAt: '2027-02-19T00:00:00.000Z', notes: 'Asks about afternoon lessons.', convertedStudentId: null, version: 1 });
    expect((await tasks(row)).items).toEqual([expect.objectContaining({ title: row.nextAction, detail: 'Synthetic Guardian · Casey Example', dueAt: row.dueAt, completedAt: null, inquiryId: row.id })]);
    const history = await json<Page<InquiryHistory>>(await app.request(`/api/admin/inquiries/${row.id}/history`, { token: app.token }));
    expect(history.items).toEqual([expect.objectContaining({ fromStage: null, toStage: 'New', actorName: app.actor.displayName })]);
    const audit = await app.db.prepare("SELECT actor_id,action FROM audit_entries WHERE entity_id=?").bind(row.id).all();
    expect(audit.results).toEqual([{ actor_id: app.actor.id, action: 'inquiry_created' }]);
  });
  it('makes concurrent creation replay safe and rejects changed payloads or a different actor', async () => {
    const value = payload();
    const responses = await Promise.all([create(value), create(value)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const rows = await Promise.all(responses.map(response => response.json())) as { inquiry: Inquiry; replayed: boolean }[];
    expect(rows[0].inquiry.id).toBe(rows[1].inquiry.id);
    expect(rows.filter(result => result.replayed)).toHaveLength(1);
    expect((await create({ ...value, phone: '555-0188' })).status).toBe(409);
    const other = await staff('front_desk'); expect((await create(value, other.token)).status).toBe(409);
    expect((await tasks(rows[0].inquiry)).total).toBe(1);
    expect(await app.db.prepare('SELECT count(*) AS n FROM inquiry_stage_history WHERE inquiry_id=?').bind(value.inquiryId).first('n')).toBe(1);
  });
  it('validates inputs, explicit timezone dates, and calendar dates', async () => {
    for (const bad of [{ contactName: '' }, { studentName: '' }, { email: '', phone: '' }, { email: 'invalid' }, { source: '' }, { subjects: ['Science'] }, { subjects: 'Math' }, { nextAction: 'a'.repeat(301) }, { notes: 'a'.repeat(2001) }, { dueAt: '2027-02-30T12:00:00Z' }, { dueAt: '2027-02-18T12:00:00' }, { dueAt: 'not a date' }]) expect((await create(payload(bad))).status).toBe(422);
    const row = await inquiry({ subjects: [], nextAction: '', dueAt: null });
    expect((await tasks(row)).total).toBe(0);
    expect((await patch(row, { stage: 'Unknown' })).status).toBe(422);
    expect((await patch(row, { stage: 'Enrolled' })).status).toBe(422);
    expect((await patch(row, { notes: 'No version', expectedVersion: null })).status).toBe(422);
  });
  it('defaults an undated follow-up to one day after creation and preserves it when inquiry date clears', async () => {
    let row = await inquiry({ dueAt: null }); const initial = (await tasks(row)).items[0];
    expect(new Date(initial.dueAt).getTime() - new Date(row.createdAt).getTime()).toBe(86_400_000);
    row = (await json<{ inquiry: Inquiry }>(await patch(row, { nextAction: 'Confirm assessment', dueAt: '2027-03-02T12:00:00Z', ownerName: 'Front desk team', stage: 'Contacted' }))).inquiry;
    expect((await tasks(row)).items[0]).toMatchObject({ title: 'Confirm assessment', dueAt: '2027-03-02T12:00:00.000Z' });
    row = (await json<{ inquiry: Inquiry }>(await patch(row, { dueAt: null }))).inquiry;
    expect(row.dueAt).toBeNull(); expect(row.ownerName).toBe('Front desk team');
    expect((await tasks(row)).items[0].dueAt).toBe('2027-03-02T12:00:00.000Z');
  });
  it('rejects stale competing edits without duplicate history or lost updates', async () => {
    const row = await inquiry(); const responses = await Promise.all([patch(row, { stage: 'Contacted' }), patch(row, { stage: 'Assessment scheduled' })]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await app.db.prepare('SELECT count(*) AS n FROM inquiry_stage_history WHERE inquiry_id=?').bind(row.id).first('n')).toBe(2);
    const fresh = (await json<{ inquiry: Inquiry }>(await app.request(`/api/admin/inquiries/${row.id}`, { token: app.token }))).inquiry;
    expect(fresh.version).toBe(2);
  });
  it('requires a loss reason, respects do-not-contact, completes pending tasks, and permits reopening', async () => {
    let row = await inquiry({ notes: '' }); expect((await patch(row, { stage: 'Closed lost' })).status).toBe(422);
    row = (await json<{ inquiry: Inquiry }>(await patch(row, { stage: 'Closed lost', notes: 'Schedule does not fit.' }))).inquiry;
    expect((await tasks(row, 'pending')).total).toBe(0); expect((await tasks(row)).items[0].completedAt).not.toBeNull();
    expect((await convert(row)).status).toBe(409);
    row = (await json<{ inquiry: Inquiry }>(await patch(row, { stage: 'Contacted' }))).inquiry;
    expect((await tasks(row, 'pending')).total).toBe(0); // Reopening does not undo completed work.
    expect((await convert(row)).status).toBe(200);
    const doNotContact = await inquiry(); const blocked = (await json<{ inquiry: Inquiry }>(await patch(doNotContact, { stage: 'Do not contact' }))).inquiry;
    expect((await convert(blocked)).status).toBe(409); expect((await tasks(blocked, 'pending')).total).toBe(0);
  });
  it('completes a task idempotently with one audit record', async () => {
    const row = await inquiry(), task = (await tasks(row)).items[0];
    const responses = await Promise.all([1, 2].map(() => app.request(`/api/admin/tasks/${task.id}/complete`, { token: app.token, body: {} })));
    const results = await Promise.all(responses.map(response => json<{ task: FollowUpTask }>(response)));
    expect(results[0].task.completedAt).not.toBeNull(); expect(results[1]).toEqual(results[0]);
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE entity_id=? AND action='task_completed'").bind(task.id).first('n')).toBe(1);
    expect((await tasks(row, 'pending')).total).toBe(0);
  });
  it('converts concurrently once, retains grade/contact/subjects, and starts with unverified pickup authority', async () => {
    const row = await inquiry({ studentName: '  Avery  Example Family  ' });
    const before = Number(await app.db.prepare('SELECT count(*) AS n FROM students').first('n'));
    const responses = await Promise.all([convert(row, { grade: '3' }), convert(row, { grade: '3' })]);
    const results = await Promise.all(responses.map(response => json<InquiryConversion>(response)));
    expect(results[0].studentId).toBe(results[1].studentId); expect(results.filter(result => result.replayed)).toHaveLength(1);
    expect(results[0].student).toMatchObject({ firstName: 'Avery', lastName: 'Example Family', grade: '3', active: true, subjects: ['Math', 'Reading'] });
    const detail = await json<StudentDetail>(await app.request(`/api/admin/students/${results[0].studentId}`, { token: app.token }));
    expect(detail.guardians).toEqual([expect.objectContaining({ displayName: row.contactName, email: row.email, phone: row.phone, pickupAuthority: 'unverified', authorityNote: '' })]);
    expect(detail.visits).toEqual([]); expect((await tasks(row, 'pending')).total).toBe(0);
    expect(Number(await app.db.prepare('SELECT count(*) AS n FROM students').first('n'))).toBe(before + 1);
    const replay = await json<InquiryConversion>(await convert(row, { grade: 'New value must not overwrite' }));
    expect(replay.replayed).toBe(true); expect(replay.student.grade).toBe('3');
    expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE entity_id=? AND action='inquiry_enrolled'").bind(row.id).first('n')).toBe(1);
    expect((await patch(results[0].inquiry, { stage: 'Contacted' })).status).toBe(409);
  });
  it('allocates unique stable references above manual numbers and defaults empty subjects to Math', async () => {
    await createStudent(app, { studentCode: 'K-9000' });
    const one = await inquiry({ studentName: 'Solo', subjects: [] }), two = await inquiry();
    const results = await Promise.all([convert(one), convert(two)]).then(responses => Promise.all(responses.map(response => json<InquiryConversion>(response))));
    expect(results.map(result => result.student.studentCode).sort()).toEqual(['K-9001', 'K-9002']);
    expect(results[0].student).toMatchObject({ firstName: 'Solo', lastName: '', subjects: ['Math'], grade: '' });
    const sequence = await app.db.prepare("SELECT student_sequence FROM centers WHERE id='test-center'").first('student_sequence');
    await json(await convert(one)); expect(await app.db.prepare("SELECT student_sequence FROM centers WHERE id='test-center'").first('student_sequence')).toBe(sequence);
  });
  it('filters and paginates inquiries, tasks, and history without exposing internal hashes', async () => {
    const marker = crypto.randomUUID(); let first = await inquiry({ studentName: marker }); await inquiry({ studentName: marker }); await inquiry({ studentName: marker });
    first = (await json<{ inquiry: Inquiry }>(await patch(first, { stage: 'Contacted' }))).inquiry;
    const query = `/api/admin/inquiries?q=${marker}&pageSize=1`;
    const page1 = await json<InquiryList>(await app.request(query, { token: app.token }));
    const page2 = await json<InquiryList>(await app.request(`${query}&page=2`, { token: app.token }));
    expect(page1.total).toBe(3); expect(page1.items).toHaveLength(1); expect(page1.items[0].id).not.toBe(page2.items[0].id);
    expect(JSON.stringify(page1)).not.toMatch(/creationHash|creation_hash|last_actor|created_by/);
    expect((await json<InquiryList>(await app.request(`${query}&stage=Contacted`, { token: app.token }))).total).toBe(1);
    const history = await json<Page<InquiryHistory>>(await app.request(`/api/admin/inquiries/${first.id}/history?pageSize=1`, { token: app.token })); expect(history.total).toBe(2); expect(history.items).toHaveLength(1);
    const taskPage = await json<Page<FollowUpTask>>(await app.request('/api/admin/tasks?pageSize=1', { token: app.token })); expect(taskPage.items).toHaveLength(1); expect(taskPage.total).toBeGreaterThan(1);
    for (const endpoint of ['/inquiries?pageSize=51', '/inquiries?view=bad', '/inquiries?stage=bad', '/tasks?status=bad', '/tasks?page=0']) expect((await app.request(`/api/admin${endpoint}`, { token: app.token })).status).toBe(400);
  });
  it('keeps instructor, revoked, unauthenticated, and foreign-center access outside every endpoint', async () => {
    const row = await inquiry(), desk = await staff('front_desk'), instructor = await staff('instructor');
    const deskRow = (await json<{ inquiry: Inquiry }>(await create(payload(), desk.token), 201)).inquiry;
    expect((await convert(deskRow, {}, desk.token)).status).toBe(200);
    for (const endpoint of ['/inquiries', `/inquiries/${row.id}`, `/inquiries/${row.id}/history`, '/tasks']) {
      expect((await app.request(`/api/admin${endpoint}`, { token: instructor.token })).status).toBe(403);
      expect((await app.request(`/api/admin${endpoint}`)).status).toBe(401);
    }
    expect((await create(payload(), instructor.token)).status).toBe(403);
    expect((await patch(row, { notes: 'No access' }, instructor.token)).status).toBe(403);
    expect((await convert(row, {}, instructor.token)).status).toBe(403);
    expect((await app.request(`/api/admin/tasks/${row.id}/complete`, { token: instructor.token, body: {} })).status).toBe(403);
    await json(await app.request(`/api/admin/staff/${desk.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    expect((await create(payload(), desk.token)).status).toBe(403);
    const center = crypto.randomUUID(), foreign = crypto.randomUUID(), actor = crypto.randomUUID(), timestamp = new Date().toISOString();
    await app.db.batch([
      app.db.prepare('INSERT INTO centers(id,name,created_at) VALUES(?,?,?)').bind(center, 'Foreign center', timestamp),
      app.db.prepare("INSERT INTO staff(id,center_id,email,display_name,role,created_at,updated_at) VALUES(?,?,?,'Foreign staff','owner',?,?)").bind(actor, center, 'other@example.test', timestamp, timestamp),
      app.db.prepare("INSERT INTO inquiries(id,center_id,contact_name,student_name,email,source,owner_name,next_action,created_at,updated_at,creation_hash,created_by,last_actor_id,last_actor_name) VALUES(?,?,'Foreign contact','Foreign student','foreign@example.test','Test','Foreign staff','Call',?,?,'hash',?,?,'Foreign staff')").bind(foreign, center, timestamp, timestamp, actor, actor),
    ]);
    expect((await app.request(`/api/admin/inquiries/${foreign}`, { token: app.token })).status).toBe(404);
    expect((await app.request(`/api/admin/inquiries/${foreign}/convert`, { token: app.token, body: {} })).status).toBe(404);
    expect((await app.request(`/api/admin/inquiries/${foreign}`, { token: app.token, method: 'PATCH', body: { expectedVersion: 1, notes: 'Wrong center' } })).status).toBe(404);
    expect((await app.request(`/api/admin/tasks/${foreign}/complete`, { token: app.token, body: {} })).status).toBe(404);
    expect((await json<InquiryList>(await app.request('/api/admin/inquiries?q=Foreign&view=all', { token: app.token }))).total).toBe(0);
  });
  it('does not expose CRM endpoints to an enrolled and unlocked kiosk', async () => {
    await json(await app.request(`/api/admin/staff/${app.actor.id}`, { token: app.token, method: 'PATCH', body: { kioskEnabled: true, pin: '48271639' } }));
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201), jar = new CookieJar();
    await json(await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Inquiry boundary' } }), 201);
    await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: app.actor.id, pin: '48271639' } }));
    for (const endpoint of ['/inquiries', '/tasks']) {
      expect((await jar.request(app, `/api/kiosk${endpoint}`)).status).toBe(404);
      expect((await jar.request(app, `/api/admin${endpoint}`)).status).toBe(401);
    }
  });
  it('honors backup locks and rolls back conversion, sequence, tasks, and history if audit fails', async () => {
    const row = await inquiry(), before = await app.db.prepare("SELECT student_sequence FROM centers WHERE id='test-center'").first('student_sequence');
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=? WHERE id=1').bind(new Date(Date.now() + 60000).toISOString()).run();
    try {
      expect((await create()).status).toBe(503); expect((await patch(row, { notes: 'Locked' })).status).toBe(503); expect((await convert(row)).status).toBe(503);
      expect((await app.request(`/api/admin/tasks/${row.id}/complete`, { token: app.token, body: {} })).status).toBe(503);
      expect((await app.request('/api/admin/inquiries', { token: app.token })).status).toBe(200);
    } finally { await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run(); }
    const studentsBefore = await app.db.prepare('SELECT count(*) AS n FROM students').first('n'), guardiansBefore = await app.db.prepare('SELECT count(*) AS n FROM guardians').first('n');
    await app.db.prepare("CREATE TRIGGER test_inquiry_audit_failure BEFORE INSERT ON audit_entries WHEN NEW.action='inquiry_enrolled' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END").run();
    try {
      expect((await convert(row, { grade: '2' })).status).toBe(500);
      expect(await app.db.prepare('SELECT count(*) AS n FROM students').first('n')).toBe(studentsBefore);
      expect(await app.db.prepare('SELECT count(*) AS n FROM guardians').first('n')).toBe(guardiansBefore);
      expect(await app.db.prepare("SELECT student_sequence FROM centers WHERE id='test-center'").first('student_sequence')).toBe(before);
      expect((await tasks(row, 'pending')).total).toBe(1);
      expect(await app.db.prepare('SELECT count(*) AS n FROM inquiry_stage_history WHERE inquiry_id=?').bind(row.id).first('n')).toBe(1);
      expect(await app.db.prepare('SELECT converted_student_id FROM inquiries WHERE id=?').bind(row.id).first('converted_student_id')).toBeNull();
    } finally { await app.db.prepare('DROP TRIGGER test_inquiry_audit_failure').run(); }
  });
});
