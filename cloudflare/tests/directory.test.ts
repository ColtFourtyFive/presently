import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { DirectoryResult } from '../shared/directory';
import type { Staff } from '../shared/types';
import { createStudent, json, startApp, type App } from './helpers';

describe('staff directory filters in native D1', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const query = (body: Record<string, unknown> = {}, token = app.token, headers?: Record<string, string>) => app.request('/api/admin/directory/query', { body, token, headers });
  async function staff(role: Staff['role']) {
    const email = `${crypto.randomUUID()}@example.test`;
    await json(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: `Directory ${role}`, role } }), 201);
    return app.signer.token({ email });
  }
  it('starts empty with real zero enrollment counts', async () => {
    expect(await json<DirectoryResult>(await query())).toMatchObject({ items: [], total: 0, counts: { active: 0, math: 0, reading: 0 } });
  });
  it('filters combined subjects and status without changing center-wide enrollment counts', async () => {
    const mark = `Filters${crypto.randomUUID()}`;
    await createStudent(app, { firstName: mark, lastName: 'Able', grade: 'Grade 4', subjects: ['Math', 'Reading'] });
    await createStudent(app, { firstName: mark, lastName: 'Baker', subjects: ['Math'] });
    await createStudent(app, { firstName: mark, lastName: 'Charlie', active: false, subjects: ['Reading'] });
    const all = await json<DirectoryResult>(await query({ q: mark, status: 'all' }));
    expect(all.total).toBe(3); expect(all.counts).toEqual({ active: 2, math: 2, reading: 1 });
    const reading = await json<DirectoryResult>(await query({ q: mark, subject: 'Reading' }));
    expect(reading.items).toHaveLength(1); expect(reading.items[0]).toMatchObject({ lastName: 'Able', grade: 'Grade 4', active: true });
    expect(reading.counts).toEqual(all.counts);
    expect((await json<DirectoryResult>(await query({ q: mark, status: 'inactive', subject: 'Reading' }))).items[0].lastName).toBe('Charlie');
    const page1 = await json<DirectoryResult>(await query({ q: mark, status: 'all', pageSize: 1 }));
    const page2 = await json<DirectoryResult>(await query({ q: mark, status: 'all', pageSize: 1, page: 2 }));
    expect(page1.total).toBe(3); expect(page1.items[0].id).not.toBe(page2.items[0].id);
  });
  it('searches any linked guardian and preserves literal wildcard characters without duplicating students', async () => {
    const marker = crypto.randomUUID();
    const detail = await createStudent(app, { firstName: 'Literal%_Test', guardians: [
      { displayName: 'A contact', email: '', phone: '', relationship: 'Contact', pickupAuthority: 'unverified', authorityNote: '' },
      { displayName: `Second ${marker}`, email: `${marker}@example.test`, phone: `555-${marker}`, relationship: 'Parent', pickupAuthority: 'unverified', authorityNote: '' },
    ] });
    for (const q of [marker, `${marker}@example.test`, `555-${marker}`, 'Literal%_Test', detail.student.studentCode]) {
      const result = await json<DirectoryResult>(await query({ q }));
      expect(result.items.map(student => student.id)).toEqual([detail.student.id]);
      expect(result.items[0].contact).toEqual({ displayName: 'A contact', email: '', phone: '' });
      expect(JSON.stringify(result)).not.toMatch(/payload_hash|pin_hash|authority_note/);
    }
    expect((await json<DirectoryResult>(await query({ q: 'Literal__Test' }))).items).toEqual([]);
  });
  it('keeps foreign center students, contacts and metrics out of the response', async () => {
    const center = crypto.randomUUID(), student = crypto.randomUUID(), guardian = crypto.randomUUID(), timestamp = new Date().toISOString();
    const before = (await json<DirectoryResult>(await query())).counts;
    await app.db.batch([
      app.db.prepare('INSERT INTO centers(id,name,created_at) VALUES(?,?,?)').bind(center, 'Foreign center', timestamp),
      app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,subjects,created_at,updated_at) VALUES(?,?,'PRIVATE','Foreign','Student','[\"Math\"]',?,?)").bind(student, center, timestamp, timestamp),
      app.db.prepare("INSERT INTO guardians(id,center_id,display_name,phone,email,created_at) VALUES(?,?,'Foreign contact','555-9999','foreign@example.test',?)").bind(guardian, center, timestamp),
      app.db.prepare("INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note) VALUES(?,?,'Parent','unverified','')").bind(student, guardian),
    ]);
    expect((await json<DirectoryResult>(await query({ q: 'foreign' }))).items).toEqual([]);
    expect((await json<DirectoryResult>(await query())).counts).toEqual(before);
  });
  it('supports long legitimate references in the front desk lookup', async () => {
    const studentCode = `REFERENCE-${'A'.repeat(45)}`;
    const detail = await createStudent(app, { studentCode, guardians: [] });
    const result = await json<{ items: { id: string }[] }>(await app.request(`/api/admin/students?q=${studentCode}`, { token: app.token }));
    expect(result.items.map(student => student.id)).toEqual([detail.student.id]);
    const directory = await json<DirectoryResult>(await query({ q: studentCode }));
    expect(directory.items[0].contact).toBeNull();
  });
  it('enforces staff roles, same origin, strict bounded inputs and read-only behavior', async () => {
    const desk = await staff('front_desk'), instructor = await staff('instructor');
    const audits = await app.db.prepare('SELECT count(*) AS n FROM audit_timeline').first('n');
    expect((await query({}, desk)).status).toBe(200); expect((await query({}, instructor)).status).toBe(403);
    expect((await app.request('/api/admin/directory/query', { body: {} })).status).toBe(401);
    expect((await app.request('/api/kiosk/directory/query', { body: {} })).status).not.toBe(200);
    expect((await query({}, app.token, { origin: 'https://other.example.test' })).status).toBe(403);
    for (const body of [{ page: 0 }, { page: '1' }, { pageSize: 51 }, { page: 10001 }, { status: 'missing' }, { subject: [] }, { q: 'x'.repeat(101) }, { unknown: 1 }]) expect((await query(body)).status).toBe(400);
    expect((await query({ q: 'x'.repeat(100001) })).status).toBe(413);
    expect(await app.db.prepare('SELECT count(*) AS n FROM audit_timeline').first('n')).toBe(audits);
  });
});
