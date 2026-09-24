import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportPreview } from '../shared/import';
import type { StudentDetail, StudentListItem } from '../shared/types';
import { createStudent, json, startApp, type App } from './helpers';

const mapping = {
  studentCode: 'ID', firstName: 'First', lastName: 'Last', grade: 'Grade', subjects: 'Subjects',
  guardianReference: 'Family', guardianName: 'Parent', guardianPhone: 'Phone', guardianEmail: 'Email',
  guardianRelationship: 'Relationship', pickupAuthority: 'Pickup', pickupAuthorityNote: 'Verified',
};
const header = 'ID,First,Last,Grade,Subjects,Family,Parent,Phone,Email,Relationship,Pickup,Verified';

async function commitAll(app: App, preview: ImportPreview, overrides: Record<number, 'create' | 'update' | 'skip'> = {}) {
  const pending = preview.rows.filter(r => r.status === 'pending');
  let result = preview;
  for (let i = 0; i < pending.length; i += 8) {
    const rows = pending.slice(i, i + 8).map(r => ({ row: r.row, action: overrides[r.row] ?? r.action }));
    result = await json<ImportPreview>(await app.admin(`/imports/${preview.importId}/commit`, { body: { rows } }));
  }
  return result;
}

describe('roster import', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => { await app?.close(); });

  it('previews without changing records, then applies reviewed rows once', async () => {
    const csv = [
      header,
      'K-1,Ana,Lopez,3,Math;Reading,FAM-1,Rosa Lopez,555-1000,rosa@example.test,Mother,allowed,Checked ID',
      'K-2,Ben,Lopez,5,Math,FAM-1,Rosa Lopez,555-1000,rosa@example.test,Mother,allowed,Checked ID',
      'K-3,Cy,Smith,1,Reading,,,,,,,',
      ',No,Code,2,Math,,,,,,,',
      'K-1,Ana,Duplicate,3,Math,,,,,,,',
    ].join('\n');
    const preview = await json<ImportPreview>(await app.admin('/imports/preview', { body: { csv, mapping, sourceName: 'roster.csv' } }), 201);
    expect(preview.rows.map(r => r.action)).toEqual(['create', 'create', 'create', 'reject', 'reject']);
    expect((await json<{ total: number }>(await app.admin('/students?status=all'))).total).toBe(0);

    const done = await commitAll(app, preview);
    expect(done.status).toBe('completed');
    expect(done.rows.filter(r => r.status === 'applied')).toHaveLength(3);
    // Retrying a commit after completion changes nothing.
    const again = await app.admin(`/imports/${preview.importId}/commit`, { body: { rows: [{ row: 2, action: 'create' }] } });
    expect(again.status).toBe(409);

    const list = await json<{ items: StudentListItem[] }>(await app.admin('/students?q=Lopez'));
    expect(list.items).toHaveLength(2);
    // Siblings share one guardian record, found through the family reference.
    const guardians = await app.db.prepare("SELECT count(*) AS n FROM guardians WHERE display_name = 'Rosa Lopez'").first<{ n: number }>();
    expect(guardians!.n).toBe(1);
    const ana = await json<StudentDetail>(await app.admin(`/students/${list.items.find(s => s.studentCode === 'K-1')!.id}`));
    expect(ana.student.subjects).toEqual(['Math', 'Reading']);
    expect(ana.guardians[0]).toMatchObject({ pickupAuthority: 'allowed', phone: '555-1000' });
  });

  it('updates existing students by code and holds possible duplicates by name for review', async () => {
    await createStudent(app, { studentCode: 'EX-9', firstName: 'Dana', lastName: 'Kim' });
    const csv = [header, 'K-3,Cyrus,Smith,2,Reading,,,,,,,', 'NEW-7,Dana,Kim,4,Math,,,,,,,', 'NEW-8,Eve,Stone,4,Math,,,,,,,'].join('\n');
    const preview = await json<ImportPreview>(await app.admin('/imports/preview', { body: { csv, mapping } }), 201);
    expect(preview.rows.map(r => r.action)).toEqual(['update', 'skip', 'create']);
    expect(preview.rows[1].problem).toContain('EX-9');
    const done = await commitAll(app, preview);
    expect(done.rows.map(r => r.status)).toEqual(['applied', 'skipped', 'applied']);
    const smith = (await json<{ items: StudentListItem[] }>(await app.admin('/students?q=K-3'))).items[0];
    expect(smith.firstName).toBe('Cyrus');
    expect((await json<{ total: number }>(await app.admin('/students?q=NEW-7'))).total).toBe(0);
  });

  it('rejects invalid mappings and malformed files', async () => {
    const missing = await app.admin('/imports/preview', { body: { csv: `${header}\nA,B,C,,,,,,,,,`, mapping: { firstName: 'First', lastName: 'Last' } } });
    expect((await json<{ error: { code: string } }>(missing, 400)).error.code).toBe('MAPPING_REQUIRED');
    const malformed = await app.admin('/imports/preview', { body: { csv: 'ID,First\n"unclosed,x', mapping: { studentCode: 'ID', firstName: 'First', lastName: 'First' } } });
    expect(malformed.status).toBe(400);
  });

  it('is limited to owners and managers', async () => {
    await json(await app.admin('/staff', { location: null, body: { email: 'desk@example.test', displayName: 'Desk', role: 'front_desk', locationIds: [app.locationId] } }), 201);
    const token = await app.signer.token({ email: 'desk@example.test', sub: 'desk' });
    expect((await app.admin('/imports', { token })).status).toBe(403);
  });
});
