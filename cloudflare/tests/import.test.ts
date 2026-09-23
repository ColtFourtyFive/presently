import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Staff } from '../shared/types.js';
import { createStudent, json, startApp, type App } from './helpers.js';
import { readCsvFile } from '../client/import-file.js';
import { importCommitStatements } from '../worker/import.js';
import type { IsolatedStatement } from './runtime.js';

type Preview = { importId: string; previewToken: string; totalRows: number; status: string; canCommit?: boolean; summary?: Record<string, number>; alreadyAppliedRows?: number[]; rows: { row?: number; rowNumber?: number; action: string; status?: string; studentId: string; guardianId: string | null; problem?: string | null }[]; remaining?: number };
const columns = ['Code', 'First', 'Last', 'Subjects', 'GuardianRef', 'Guardian', 'Email', 'Phone', 'Relation', 'Authority', 'Evidence', 'Alert'];
const mapping = { studentCode: 'Code', firstName: 'First', lastName: 'Last', subjects: 'Subjects', guardianReference: 'GuardianRef', guardianName: 'Guardian', guardianEmail: 'Email', guardianPhone: 'Phone', guardianRelationship: 'Relation', pickupAuthority: 'Authority', pickupAuthorityNote: 'Evidence', pickupAlert: 'Alert' };
const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
const csv = (rows: string[][]) => '\uFEFF' + [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
const row = (code: string, first = `Student${code}`, last = 'Synthetic Import') => [code, first, last, 'Math|Reading', '', '', '', '', '', '', '', ''];

describe('CSV file decoding before upload', () => {
  it('rejects invalid UTF-8 bytes instead of replacing student names silently', async () => {
    const invalid = new File([new Uint8Array([0x43, 0x6f, 0x64, 0x65, 0x0a, 0x5a, 0x6f, 0xeb])], 'legacy.csv');
    await expect(readCsvFile(invalid)).rejects.toThrow('not valid UTF-8');
    const truncated = new File([new Uint8Array([0xe2, 0x82])], 'truncated.csv');
    await expect(readCsvFile(truncated)).rejects.toThrow('not valid UTF-8');
  });

  it('preserves valid international names and accepts UTF-8 BOM exports', async () => {
    const source = 'Code,First,Last\r\nUTF8,Zoë,王\r\n';
    await expect(readCsvFile(new File(['\uFEFF' + source], 'roster.csv'))).resolves.toBe(source);
  });
});

describe('Generic roster import against actual D1', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => app?.close());
  const preview = (source: string, extra: Record<string, unknown> = {}, token?: string) => app.request('/api/admin/imports/preview', { token: token ?? app.token, body: { csv: source, mapping, ...extra } });
  const commit = (p: Preview, token?: string) => app.request(`/api/admin/imports/${p.importId}/commit`, { token: token ?? app.token, body: { previewToken: p.previewToken } });
  // The adapter transports these exact SQL statements to real workerd/D1.
  const commitBatch = (p: Preview, rows: number[]) => importCommitStatements(
    app.db as unknown as Parameters<typeof importCommitStatements>[0], p.importId,
    'test-center', p.previewToken, rows, new Date().toISOString(),
  ) as unknown as IsolatedStatement[];

  it('imports grade, preserves an unmapped grade, and clears only an explicitly mapped blank', async () => {
    const withGrade = { studentCode: 'Code', firstName: 'First', lastName: 'Last', grade: 'Grade' };
    const created = await json<Preview>(await preview('Code,First,Last,Grade\nIMP-GRADE,Grade,Fixture,Grade 2', { mapping: withGrade }));
    await json(await commit(created));
    const studentId = created.rows[0].studentId;
    expect(await app.db.prepare('SELECT grade FROM students WHERE id=?').bind(studentId).first('grade')).toBe('Grade 2');
    const omitted = await json<Preview>(await preview('Code,First,Last\nIMP-GRADE,Revised,Fixture', { mapping: { studentCode: 'Code', firstName: 'First', lastName: 'Last' }, decisions: { 'IMP-GRADE': 'update' } }));
    await app.db.prepare("UPDATE roster_import_rows SET payload_json=json_set(payload_json,'$.grade','') WHERE import_id=?").bind(omitted.importId).run();
    await json(await commit(omitted));
    expect(await app.db.prepare('SELECT grade FROM students WHERE id=?').bind(studentId).first('grade')).toBe('Grade 2');
    const cleared = await json<Preview>(await preview('Code,First,Last,Grade\nIMP-GRADE,Revised,Fixture,', { mapping: withGrade, decisions: { 'IMP-GRADE': 'update' } }));
    await json(await commit(cleared));
    expect(await app.db.prepare('SELECT grade FROM students WHERE id=?').bind(studentId).first('grade')).toBe('');
  });

  it('rejects overlong grades and conflicting grade rows before applying them', async () => {
    const withGrade = { studentCode: 'Code', firstName: 'First', lastName: 'Last', grade: 'Grade' };
    const rejected = await json<Preview>(await preview(`Code,First,Last,Grade\nIMP-GRADE-LONG,Long,Fixture,${'X'.repeat(31)}`, { mapping: withGrade }));
    expect(rejected.rows[0]).toMatchObject({ action: 'reject', problem: 'Grade must be at most 30 characters.' });
    const conflict = await json<Preview>(await preview('Code,First,Last,Grade\nIMP-GRADE-DUP,Same,Fixture,2\nIMP-GRADE-DUP,Same,Fixture,3', { mapping: withGrade }));
    expect(conflict.rows[1]).toMatchObject({ action: 'reject', problem: 'Repeated student codes have conflicting student information.' });
  });

  it('distinguishes a planned new ID from an existing ID in same-name review', async () => {
    const existing = await createStudent(app, { studentCode: 'IMP-SAME-NAME-OLD', firstName: 'SharedImport', lastName: 'Name' });
    const p = await json<{rows:{studentId:string;existingStudentId:string|null;action:string}[]}>(await preview(csv([row('IMP-SAME-NAME-NEW','SharedImport','Name'),row('IMP-SAME-NAME-OLD','SharedImport','Name')])));
    expect(p.rows[0]).toMatchObject({ action: 'review', existingStudentId: null });
    expect(p.rows[0].studentId).not.toBe(existing.student.id);
    expect(p.rows[1]).toMatchObject({ action: 'review', studentId: existing.student.id, existingStudentId: existing.student.id });
  });

  it('lists bounded saved receipts without payloads or preview tokens', async () => {
    const p = await json<Preview>(await preview(csv([row('IMP-SAVED-LIST')])));
    await json(await commit(p));
    const listed = await json<{imports:Record<string,unknown>[];total:number;pageSize:number}>(await app.request('/api/admin/imports', { token: app.token }));
    expect(listed.pageSize).toBe(25); expect(listed.imports.length).toBeLessThanOrEqual(25);
    expect(listed.imports.find(item=>item.importId===p.importId)).toMatchObject({ status:'completed',totalRows:1,remaining:0 });
    expect(JSON.stringify(listed)).not.toContain(p.previewToken); expect(JSON.stringify(listed)).not.toContain('payload');
    expect((await app.request('/api/admin/imports?page=0',{token:app.token})).status).toBe(400);
    expect((await app.request('/api/admin/imports')).status).toBe(401);
  });

  it('preserves unmapped student fields even when an older preview normalized them to blanks', async () => {
    const detail = await createStudent(app, { studentCode: 'IMP-PRESERVE', pickupAlert: 'Only the court-approved guardian may collect.' });
    const source = 'Code,First,Last\nIMP-PRESERVE,Updated,Student';
    const p = await json<Preview>(await preview(source, { mapping: { studentCode: 'Code', firstName: 'First', lastName: 'Last' }, decisions: { 'IMP-PRESERVE': 'update' } }));
    const payload = JSON.parse(String(await app.db.prepare('SELECT payload_json FROM roster_import_rows WHERE import_id=?').bind(p.importId).first('payload_json')));
    expect(payload).not.toHaveProperty('pickupAlert');
    expect(payload).not.toHaveProperty('subjects');
    // Simulate the old deployed Worker, which included blank values for unmapped fields.
    await app.db.prepare("UPDATE roster_import_rows SET payload_json=json_set(payload_json,'$.pickupAlert','','$.subjects',json('[]')) WHERE import_id=?").bind(p.importId).run();
    await json(await commit(p));
    expect(await app.db.prepare('SELECT first_name,subjects,pickup_alert FROM students WHERE id=?').bind(detail.student.id).first()).toEqual({ first_name: 'Updated', subjects: '["Math","Reading"]', pickup_alert: 'Only the court-approved guardian may collect.' });
  });

  it('clears student fields only when their mapped CSV cells are explicitly blank', async () => {
    const detail = await createStudent(app, { studentCode: 'IMP-CLEAR', pickupAlert: 'Prior instruction explicitly withdrawn in this import.' });
    const source = 'Code,First,Last,Subjects,Alert\nIMP-CLEAR,Updated,Student,,';
    const p = await json<Preview>(await preview(source, { mapping: { studentCode: 'Code', firstName: 'First', lastName: 'Last', subjects: 'Subjects', pickupAlert: 'Alert' }, decisions: { 'IMP-CLEAR': 'update' } }));
    await json(await commit(p));
    expect(await app.db.prepare('SELECT subjects,pickup_alert FROM students WHERE id=?').bind(detail.student.id).first()).toEqual({ subjects: '[]', pickup_alert: '' });
  });

  it('defaults unmapped fields for newly created students and guardians', async () => {
    const p = await json<Preview>(await preview('Code,First,Last,Guardian\nIMP-DEFAULT,New,Student,New Guardian', { mapping: { studentCode: 'Code', firstName: 'First', lastName: 'Last', guardianName: 'Guardian' } }));
    await json(await commit(p));
    expect(await app.db.prepare('SELECT subjects,pickup_alert FROM students WHERE id=?').bind(p.rows[0].studentId).first()).toEqual({ subjects: '[]', pickup_alert: '' });
    expect(await app.db.prepare('SELECT email,phone FROM guardians WHERE id=?').bind(p.rows[0].guardianId).first()).toEqual({ email: '', phone: '' });
    expect(await app.db.prepare('SELECT relationship,pickup_authority,authority_note FROM student_guardians WHERE student_id=? AND guardian_id=?').bind(p.rows[0].studentId, p.rows[0].guardianId).first()).toEqual({ relationship: '', pickup_authority: 'unverified', authority_note: '' });
  });

  it('preserves omitted guardian contacts, relationship, authority, and evidence on an existing link', async () => {
    const detail = await createStudent(app, { studentCode: 'IMP-LINK-PRESERVE' });
    const guardian = detail.guardians[0];
    await app.db.prepare('UPDATE guardians SET import_ref=? WHERE id=?').bind('LINK-PRESERVE-REF', guardian.id).run();
    const subset = { studentCode: 'Code', firstName: 'First', lastName: 'Last', guardianReference: 'Ref', guardianName: 'Guardian' };
    const source = `Code,First,Last,Ref,Guardian\nIMP-LINK-PRESERVE,Revised,Student,LINK-PRESERVE-REF,${guardian.displayName}`;
    const p = await json<Preview>(await preview(source, { mapping: subset, decisions: { 'IMP-LINK-PRESERVE': 'update' } }));
    expect(p.rows[0].action).toBe('update');
    await app.db.prepare("UPDATE roster_import_rows SET payload_json=json_set(payload_json,'$.guardianEmail','','$.guardianPhone','','$.guardianRelationship','','$.pickupAuthority','unverified','$.pickupAuthorityNote','') WHERE import_id=?").bind(p.importId).run();
    await json(await commit(p));
    expect(await app.db.prepare('SELECT email,phone FROM guardians WHERE id=?').bind(guardian.id).first()).toEqual({ email: guardian.email, phone: guardian.phone });
    expect(await app.db.prepare('SELECT relationship,pickup_authority,authority_note FROM student_guardians WHERE student_id=? AND guardian_id=?').bind(detail.student.id, guardian.id).first()).toEqual({ relationship: guardian.relationship, pickup_authority: 'allowed', authority_note: guardian.authorityNote });

    const reset = await json<Preview>(await preview(source.replace('Ref,Guardian', 'Ref,Guardian,Relation,Authority,Evidence') + ',,,', { mapping: { ...subset, guardianRelationship: 'Relation', pickupAuthority: 'Authority', pickupAuthorityNote: 'Evidence' }, decisions: { 'IMP-LINK-PRESERVE': 'update' } }));
    await json(await commit(reset));
    expect(await app.db.prepare('SELECT relationship,pickup_authority,authority_note FROM student_guardians WHERE student_id=? AND guardian_id=?').bind(detail.student.id, guardian.id).first()).toEqual({ relationship: '', pickup_authority: 'unverified', authority_note: '' });
  });

  it('rejects clearing the evidence of preserved allowed pickup authority', async () => {
    const detail = await createStudent(app, { studentCode: 'IMP-EVIDENCE-PRESERVE' });
    const guardian = detail.guardians[0];
    await app.db.prepare('UPDATE guardians SET import_ref=? WHERE id=?').bind('EVIDENCE-PRESERVE-REF', guardian.id).run();
    const p = await json<Preview>(await preview(`Code,First,Last,Ref,Guardian,Evidence\nIMP-EVIDENCE-PRESERVE,Revised,Student,EVIDENCE-PRESERVE-REF,${guardian.displayName},`, { mapping: { studentCode: 'Code', firstName: 'First', lastName: 'Last', guardianReference: 'Ref', guardianName: 'Guardian', pickupAuthorityNote: 'Evidence' }, decisions: { 'IMP-EVIDENCE-PRESERVE': 'update' } }));
    expect(p.rows[0]).toMatchObject({ action: 'reject', problem: 'Allowed pickup requires a verification note.' });
    await json(await commit(p));
    expect(await app.db.prepare('SELECT authority_note FROM student_guardians WHERE student_id=? AND guardian_id=?').bind(detail.student.id, guardian.id).first('authority_note')).toBe(guardian.authorityNote);
  });

  it('parses quoted Unicode/newline fields, links siblings, preserves unknown authority, and accounts for duplicate rows', async () => {
    const one = row('IMP-SIB-1', 'Zoë, "Z"', 'Synthetic Family');
    one.splice(4, 8, 'HOUSEHOLD-A', 'Synthetic Guardian', 'synthetic@example.test', '555-0100', 'Parent', '', '', 'Call manager\nfor the current pickup instruction.');
    const two = [...one]; two[0] = 'IMP-SIB-2'; two[1] = 'Sibling';
    const source = csv([one, two, one]);
    const p = await json<Preview>(await preview(source));
    expect(p.summary).toMatchObject({ create: 2, skip: 1 });
    expect(p.rows[0].guardianId).toBe(p.rows[1].guardianId);
    const receipt = await json<Preview>(await commit(p));
    expect(receipt.status).toBe('completed');
    expect(receipt.rows.map(r => r.status)).toEqual(['applied', 'applied', 'skipped']);
    const students = await app.db.prepare("SELECT * FROM students WHERE student_code IN ('IMP-SIB-1','IMP-SIB-2') ORDER BY student_code").all();
    expect(students.results).toHaveLength(2);
    expect(students.results[0].first_name).toBe('Zoë, "Z"');
    expect(JSON.parse(String(students.results[0].subjects))).toEqual(['Math', 'Reading']);
    expect(students.results[0].pickup_alert).toContain('\n');
    expect(await app.db.prepare('SELECT count(*) AS n FROM guardians WHERE import_ref=?').bind('HOUSEHOLD-A').first('n')).toBe(1);
    const links = await app.db.prepare('SELECT pickup_authority FROM student_guardians WHERE guardian_id=?').bind(p.rows[0].guardianId).all();
    expect(links.results.map(r => r.pickup_authority)).toEqual(['unverified', 'unverified']);
    await json(await commit(p));
    const repeated = await json<Preview>(await preview(source));
    expect(repeated.importId).toBe(p.importId);
    expect(await app.db.prepare('SELECT count(*) AS n FROM roster_import_rows WHERE import_id=? AND payload_json IS NOT NULL').bind(p.importId).first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(0);
  });

  it('requires a reviewed decision for matching codes and same-name students', async () => {
    const existing = await createStudent(app, { studentCode: 'IMP-UPDATE', firstName: 'Original', lastName: 'Identity' });
    const source = csv([row('IMP-UPDATE', 'Revised', 'Identity'), row('IMP-DIFFERENT', 'Original', 'Identity')]);
    const undecided = await json<Preview>(await preview(source));
    expect(undecided.canCommit).toBe(false);
    expect((await commit(undecided)).status).toBe(409);
    const decided = await json<Preview>(await preview(source, { decisions: { 'IMP-UPDATE': 'update', 'IMP-DIFFERENT': 'create' } }));
    expect(decided.rows[0].studentId).toBe(existing.student.id);
    expect(decided.rows[1].studentId).not.toBe(existing.student.id);
    await json(await commit(decided));
    expect(await app.db.prepare('SELECT first_name FROM students WHERE id=?').bind(existing.student.id).first('first_name')).toBe('Revised');
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code IN ('IMP-UPDATE','IMP-DIFFERENT')").first('n')).toBe(2);
  });

  it('keeps same-name students distinct and preserves explicit decisions and repeated-row receipts', async () => {
    const first = await createStudent(app, { studentCode: 'AMBIGUOUS-A', firstName: 'Shared', lastName: 'RosterName' });
    const second = await createStudent(app, { studentCode: 'AMBIGUOUS-B', firstName: 'shared', lastName: 'rostername' });
    const source = 'Code,First,Last\nAMBIGUOUS-A,Shared,RosterName\nAMBIGUOUS-NEW,SHARED,ROSTERNAME\nAMBIGUOUS-NEW,SHARED,ROSTERNAME\nAMBIGUOUS-SKIP,Unique,RosterName';
    const identityOnly = { studentCode: 'Code', firstName: 'First', lastName: 'Last' };
    const undecided = await json<Preview>(await preview(source, { mapping: identityOnly }));
    expect(undecided.rows.map(item => item.action)).toEqual(['review', 'review', 'skip', 'create']);
    expect(undecided.rows[1].problem).toContain('A different student has the same name');
    expect((await commit(undecided)).status).toBe(409);
    const decided = await json<Preview>(await preview(source, { mapping: identityOnly, decisions: { 'AMBIGUOUS-A': 'update', 'AMBIGUOUS-NEW': 'create', 'AMBIGUOUS-SKIP': 'skip' } }));
    expect(decided.rows.map(item => item.action)).toEqual(['update', 'create', 'skip', 'skip']);
    expect(decided.rows[0].studentId).toBe(first.student.id);
    expect(decided.rows[1].studentId).not.toBe(first.student.id); expect(decided.rows[1].studentId).not.toBe(second.student.id);
    expect(decided.rows[2].studentId).toBe(decided.rows[1].studentId);
    const finished = await json<Preview>(await commit(decided));
    expect(finished.rows.map(item => item.status)).toEqual(['applied', 'applied', 'skipped', 'skipped']);
    expect(finished.rows[2].problem).toBe('Duplicate row in this file.');
    expect(await app.db.prepare('SELECT first_name,last_name FROM students WHERE id=?').bind(second.student.id).first()).toEqual({ first_name: 'shared', last_name: 'rostername' });
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='AMBIGUOUS-NEW'").first('n')).toBe(1);
  });

  it('reviews a full 500-row file against 1,000 same-name matches and preserves the preview when the safety cap is exceeded', async () => {
    const students = Array.from({ length: 1000 }, (_, index) => ({ id: `name-cap-${index}`, code: `NAME-CAP-${index}`, first: `Match${Math.floor(index / 2)}`, last: 'BoundedLookup' }));
    const time = new Date().toISOString();
    await app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,created_at,updated_at) SELECT json_extract(value,'$.id'),'test-center',json_extract(value,'$.code'),json_extract(value,'$.first'),json_extract(value,'$.last'),?,? FROM json_each(?)").bind(time,time,JSON.stringify(students)).run();
    const source = 'Code,First,Last\n' + Array.from({ length: 500 }, (_, index) => `NAME-CAP-NEW-${index},MATCH${index},BOUNDEDLOOKUP`).join('\n');
    const identityOnly = { studentCode: 'Code', firstName: 'First', lastName: 'Last' };
    const reviewed = await json<Preview>(await preview(source, { mapping: identityOnly }));
    expect(reviewed.totalRows).toBe(500); expect(reviewed.summary?.review).toBe(500); expect(reviewed.canCommit).toBe(false);
    expect(reviewed.rows.every(item => item.action === 'review' && item.problem?.includes('A different student has the same name'))).toBe(true);
    expect(new Set(reviewed.rows.map(item => item.studentId)).size).toBe(500);
    await app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,created_at,updated_at) VALUES('name-cap-overflow','test-center','NAME-CAP-OVERFLOW','Match0','BoundedLookup',?,?)").bind(time,time).run();
    const rejected = await json<{ error: { code: string } }>(await preview(source, { mapping: identityOnly }),400);
    expect(rejected.error.code).toBe('TOO_MANY_MATCHES');
    const unchanged = await json<Preview>(await app.request(`/api/admin/imports/${reviewed.importId}`, { token: app.token }));
    expect(unchanged.previewToken).toBe(reviewed.previewToken); expect(unchanged.rows).toHaveLength(500); expect(unchanged.rows.every(item => item.status === 'review')).toBe(true);
  });

  it('reviews identical accented and CJK names with consistent ASCII case folding', async () => {
    const accented = await createStudent(app, { studentCode: 'NAME-UNICODE-OLD', firstName: 'Élodie', lastName: 'Smith' });
    const cjk = await createStudent(app, { studentCode: 'NAME-CJK-OLD', firstName: '小明', lastName: '王' });
    const source = csv([row('NAME-UNICODE-NEW', 'ÉLODIE', 'SMITH'), row('NAME-CJK-SKIP', '小明', '王')]);
    const undecided = await json<Preview>(await preview(source));
    expect(undecided.rows.map(item => item.action)).toEqual(['review', 'review']);
    expect(undecided.rows.every(item => item.problem?.includes('A different student has the same name'))).toBe(true);
    expect((await commit(undecided)).status).toBe(409);
    const decided = await json<Preview>(await preview(source, { decisions: { 'NAME-UNICODE-NEW': 'create', 'NAME-CJK-SKIP': 'skip' } }));
    expect(decided.rows[0].studentId).not.toBe(accented.student.id);
    expect(decided.rows[1].studentId).not.toBe(cjk.student.id);
    const finished = await json<Preview>(await commit(decided));
    expect(finished.rows.map(item => item.status)).toEqual(['applied', 'skipped']);
    expect(await app.db.prepare('SELECT first_name,last_name FROM students WHERE id=?').bind(accented.student.id).first()).toEqual({ first_name: 'Élodie', last_name: 'Smith' });
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code IN ('NAME-UNICODE-OLD','NAME-UNICODE-NEW','NAME-CJK-OLD')").first('n')).toBe(3);
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='NAME-CJK-SKIP'").first('n')).toBe(0);
  });

  it('does not imply Unicode case folding or canonical equivalence in name matching', async () => {
    await createStudent(app, { studentCode: 'NAME-FOLD-OLD', firstName: 'Élodie', lastName: 'CaseBoundary' });
    const p = await json<Preview>(await preview(csv([
      row('NAME-FOLD-LOWER', 'élodie', 'CaseBoundary'),
      row('NAME-FOLD-DECOMPOSED', 'E\u0301lodie', 'CaseBoundary'),
    ])));
    expect(p.rows.map(item => item.action)).toEqual(['create', 'create']);
  });

  it('cannot finalize or clear a newer preview with an older commit token', async () => {
    const source = csv([row('IMP-FINALIZE-APPLIED'), row('IMP-FINALIZE-NEW')]);
    const initial = await json<Preview>(await preview(source, { decisions: { 'IMP-FINALIZE-NEW': 'skip' } }));
    const oldBatch = commitBatch(initial, [2]);
    // Reproduce the former interleaving: apply the last pending row, then pause
    // before completion while another request revalidates a skipped source row.
    await app.db.batch(oldBatch.slice(0, -2));
    expect(await app.db.prepare("SELECT count(*) AS n FROM roster_import_rows WHERE import_id=? AND status='pending'").bind(initial.importId).first('n')).toBe(0);
    const fresh = await json<Preview>(await preview(source, { revalidate: true, decisions: { 'IMP-FINALIZE-NEW': 'create' } }));
    expect(fresh.previewToken).not.toBe(initial.previewToken);
    expect(fresh.alreadyAppliedRows).toEqual([2]);
    const untouched = await app.db.batch(oldBatch.slice(-2));
    expect(untouched.map(result => result.meta.changes)).toEqual([0, 0]);
    expect(await app.db.prepare('SELECT status,preview_token FROM roster_imports WHERE id=?').bind(initial.importId).first()).toEqual({ status: 'preview', preview_token: fresh.previewToken });
    const pending = await app.db.prepare('SELECT status,payload_json FROM roster_import_rows WHERE import_id=? AND row_number=3').bind(initial.importId).first<{ status: string; payload_json: string }>();
    expect(pending?.status).toBe('pending');
    expect(JSON.parse(pending!.payload_json).studentCode).toBe('IMP-FINALIZE-NEW');
    expect((await commit(initial)).status).toBe(409);
    const finished = await json<Preview>(await commit(fresh));
    expect(finished.status).toBe('completed');
    expect(finished.rows.map(item => item.status)).toEqual(['applied', 'applied']);
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code IN ('IMP-FINALIZE-APPLIED','IMP-FINALIZE-NEW')").first('n')).toBe(2);
    expect(await app.db.prepare('SELECT count(*) AS n FROM roster_import_rows WHERE import_id=? AND payload_json IS NOT NULL').bind(initial.importId).first('n')).toBe(0);
  });

  it('retains payloads and does not complete while pending or review rows remain', async () => {
    const pending = await json<Preview>(await preview(csv([row('IMP-PENDING-GUARD-A'), row('IMP-PENDING-GUARD-B')])));
    await app.db.batch(commitBatch(pending, [2]));
    expect(await app.db.prepare('SELECT status FROM roster_imports WHERE id=?').bind(pending.importId).first('status')).toBe('committing');
    expect(await app.db.prepare('SELECT count(*) AS n FROM roster_import_rows WHERE import_id=? AND payload_json IS NOT NULL').bind(pending.importId).first('n')).toBe(2);
    expect((await json<Preview>(await commit(pending))).status).toBe('completed');

    await createStudent(app, { studentCode: 'IMP-REVIEW-GUARD-OLD', firstName: 'ReviewGuard', lastName: 'Fixture' });
    const review = await json<Preview>(await preview(csv([row('IMP-REVIEW-GUARD-NEW', 'ReviewGuard', 'Fixture')])));
    expect(review.rows[0].action).toBe('review');
    await app.db.batch(commitBatch(review, []));
    expect(await app.db.prepare('SELECT status FROM roster_imports WHERE id=?').bind(review.importId).first('status')).toBe('committing');
    expect(await app.db.prepare('SELECT count(*) AS n FROM roster_import_rows WHERE import_id=? AND payload_json IS NOT NULL').bind(review.importId).first('n')).toBe(1);
    expect((await commit(review)).status).toBe(409);
  });

  it('rolls back row application and completion together if payload cleanup fails', async () => {
    const p = await json<Preview>(await preview(csv([row('IMP-CLEANUP-ROLLBACK')])));
    await app.db.prepare("CREATE TRIGGER import_test_cleanup_failure BEFORE UPDATE OF payload_json ON roster_import_rows WHEN OLD.payload_json IS NOT NULL AND NEW.payload_json IS NULL AND json_extract(OLD.payload_json,'$.studentCode')='IMP-CLEANUP-ROLLBACK' BEGIN SELECT RAISE(ABORT,'TEST_CLEANUP_FAILURE'); END").run();
    try {
      expect((await commit(p)).status).toBe(500);
      expect(await app.db.prepare('SELECT status FROM roster_imports WHERE id=?').bind(p.importId).first('status')).toBe('preview');
      const saved = await app.db.prepare('SELECT status,payload_json FROM roster_import_rows WHERE import_id=?').bind(p.importId).first<{ status: string; payload_json: string }>();
      expect(saved?.status).toBe('pending');
      expect(JSON.parse(saved!.payload_json).studentCode).toBe('IMP-CLEANUP-ROLLBACK');
      expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='IMP-CLEANUP-ROLLBACK'").first('n')).toBe(0);
    } finally {
      await app.db.prepare('DROP TRIGGER import_test_cleanup_failure').run();
    }
    expect((await json<Preview>(await commit(p))).status).toBe('completed');
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='IMP-CLEANUP-ROLLBACK'").first('n')).toBe(1);
  });

  it('preserves completed batches, rejects stale remaining work, and resumes a revalidated preview without duplicates', async () => {
    const existing = await createStudent(app, { studentCode: 'IMP-STALE', firstName: 'Before', lastName: 'Stale' });
    const source = csv([...Array.from({ length: 11 }, (_, index) => row(`IMP-BATCH-${index}`)), row('IMP-STALE', 'Imported', 'Stale')]);
    const decisions = { 'IMP-STALE': 'update' };
    const p = await json<Preview>(await preview(source, { decisions }));
    const first = await json<Preview>(await commit(p));
    expect(first.remaining).toBe(2);
    expect(first.rows.filter(r => r.status === 'applied')).toHaveLength(10);
    await json(await app.request(`/api/admin/students/${existing.student.id}`, { token: app.token, method: 'PATCH', body: { pickupAlert: 'Changed after preview by a staff member.' } }));
    expect((await commit(p)).status).toBe(409);
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='IMP-BATCH-10'").first('n')).toBe(0);
    const fresh = await json<Preview>(await preview(source, { decisions, revalidate: true }));
    expect(fresh.importId).toBe(p.importId);
    expect(fresh.alreadyAppliedRows).toHaveLength(10);
    expect(await app.db.prepare("SELECT count(*) AS n FROM roster_import_rows WHERE import_id=? AND status='applied'").bind(p.importId).first('n')).toBe(10);
    const final = await json<Preview>(await commit(fresh));
    expect(final.status).toBe('completed');
    expect(final.rows.filter(r => r.status === 'applied')).toHaveLength(12);
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code LIKE 'IMP-BATCH-%'").first('n')).toBe(11);
    expect(await app.db.prepare('SELECT count(*) AS n FROM students WHERE id=?').bind(existing.student.id).first('n')).toBe(1);
  });

  it('rejects malformed CSV, invalid mapping, and files beyond the 500-row bound', async () => {
    for (const source of ['Code,First,Last\nA,"unterminated,Name', 'Code,First,Last\nA,First', 'Code,Code,Last\nA,First,Last']) {
      expect((await preview(source)).status).toBe(400);
    }
    expect((await preview(csv([row('IMP-MAP')]), { mapping: { studentCode: 'Code', firstName: 'Code', lastName: 'Last' } })).status).toBe(400);
    const bounded = await json<Preview>(await preview(csv(Array.from({ length: 500 }, (_, index) => row(`LIMIT-${index}`)))));
    expect(bounded.totalRows).toBe(500);
    expect((await preview(csv(Array.from({ length: 501 }, (_, index) => row(`OVER-${index}`))))).status).toBe(400);
  });

  it('does not grant pickup authority without evidence and reports conflicting source rows', async () => {
    const a = row('IMP-INVALID-A'); a[5] = 'Guardian'; a[9] = 'allowed';
    const b = row('IMP-CONFLICT', 'First');
    const c = row('IMP-CONFLICT', 'Different');
    const p = await json<Preview>(await preview(csv([a, b, c])));
    expect(p.rows[0].action).toBe('reject');
    expect(p.rows[2].action).toBe('reject');
    const receipt = await json<Preview>(await commit(p));
    expect(receipt.rows).toHaveLength(3);
    expect(receipt.rows.map(r => r.status)).toEqual(['rejected', 'applied', 'rejected']);
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='IMP-INVALID-A'").first('n')).toBe(0);
  });

  it('blocks front-desk imports and a manager revoked after preview', async () => {
    const create = async (role: 'front_desk' | 'manager') => (await json<{ staff: Staff }>(await app.request('/api/admin/staff', { token: app.token, body: { email: `${crypto.randomUUID()}@example.test`, displayName: 'Import Staff', role } }), 201)).staff;
    const desk = await create('front_desk');
    const deskToken = await app.signer.token({ email: desk.email, sub: desk.id });
    expect((await preview(csv([row('IMP-NO-DESK')]), {}, deskToken)).status).toBe(403);
    const manager = await create('manager');
    const token = await app.signer.token({ email: manager.email, sub: manager.id });
    const p = await json<Preview>(await preview(csv([row('IMP-REVOKED')]), {}, token));
    await json(await app.request(`/api/admin/staff/${manager.id}`, { token: app.token, method: 'PATCH', body: { active: false } }));
    expect((await commit(p, token)).status).toBe(403);
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='IMP-REVOKED'").first('n')).toBe(0);
  });

  it('invalidates a preview when linked pickup authority changes', async () => {
    const detail = await createStudent(app, { studentCode: 'IMP-GUARDIAN-CHANGE' });
    const p = await json<Preview>(await preview(csv([row('IMP-GUARDIAN-CHANGE', 'Imported', 'Name')]), { decisions: { 'IMP-GUARDIAN-CHANGE': 'update' } }));
    await json(await app.request(`/api/admin/students/${detail.student.id}/guardians/${detail.guardians[0].id}`, { token: app.token, method: 'PATCH', body: { pickupAuthority: 'denied', authorityNote: 'Changed after the import preview was reviewed.' } }));
    expect((await commit(p)).status).toBe(409);
    expect(await app.db.prepare('SELECT first_name FROM students WHERE id=?').bind(detail.student.id).first('first_name')).toBe('Synthetic');
    expect(await app.db.prepare('SELECT pickup_authority FROM student_guardians WHERE student_id=? AND guardian_id=?').bind(detail.student.id, detail.guardians[0].id).first('pickup_authority')).toBe('denied');
  });

  it('permits only the current preview token after concurrent review decisions', async () => {
    const source = csv([row('IMP-CONCURRENT-PREVIEW')]);
    const initial = await json<Preview>(await preview(source));
    const candidates = await Promise.all([
      preview(source, { decisions: { 'IMP-CONCURRENT-PREVIEW': 'create' } }).then(response => json<Preview>(response)),
      preview(source, { decisions: { 'IMP-CONCURRENT-PREVIEW': 'skip' } }).then(response => json<Preview>(response)),
    ]);
    const currentToken = await app.db.prepare('SELECT preview_token FROM roster_imports WHERE id=?').bind(initial.importId).first<string>('preview_token');
    const current = candidates.find(candidate => candidate.previewToken === currentToken)!;
    const results = await Promise.all(candidates.map(candidate => commit(candidate)));
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    const expectedCount = current.rows[0].action === 'create' ? 1 : 0;
    expect(await app.db.prepare("SELECT count(*) AS n FROM students WHERE student_code='IMP-CONCURRENT-PREVIEW'").first('n')).toBe(expectedCount);
  });
});
