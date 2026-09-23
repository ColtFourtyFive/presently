import { Hono } from 'hono';
import { attendanceReportPage, reportPageInput, smallAttendanceCsv } from './attendance-report';
import { attendanceEventHistory } from './archive-attendance-history';
import { attendanceVisitHistory } from './archive-visit-history';
import { studentAttendanceDetail } from './archive-student-detail';
import type { Context } from 'hono';
import type { Center, Correction, Guardian, Student, VisitSummary } from '../shared/types';
import type { AppEnv } from './types';
import { ApiProblem, attendanceRoles, audit, body, centerId, id, managementRoles, now, requireRole, textValue } from './util';

type Row = Record<string, unknown>;
export const visitSelect = `SELECT v.*,s.first_name||' '||s.last_name AS student_name,s.student_code,s.active,si.display_name AS in_name,so.display_name AS out_name,g.display_name AS guardian_name FROM visits v JOIN students s ON s.id=v.student_id JOIN staff si ON si.id=v.check_in_by LEFT JOIN staff so ON so.id=v.check_out_by LEFT JOIN guardians g ON g.id=v.guardian_id`;
export function studentView(r: Row): Student { return { id: String(r.id), studentCode: String(r.student_code), firstName: String(r.first_name), lastName: String(r.last_name), displayName: `${r.first_name} ${r.last_name}`, active: !!r.active, grade: String(r.grade ?? ''), revision: Number(r.revision ?? 1), subjects: JSON.parse(String(r.subjects)), pickupAlert: String(r.pickup_alert), createdAt: String(r.created_at) }; }
export function guardianView(r: Row): Guardian { return { id: String(r.id), displayName: String(r.display_name), relationship: String(r.relationship), phone: String(r.phone), email: String(r.email), pickupAuthority: r.pickup_authority as Guardian['pickupAuthority'], authorityNote: String(r.authority_note) }; }
export function visitView(r: Row): VisitSummary { return { id: String(r.id), studentId: String(r.student_id), studentName: String(r.student_name), studentCode: String(r.student_code), active: !!r.active, checkInAt: String(r.check_in_at), checkOutAt: r.check_out_at as string | null, originalCheckInAt: String(r.original_check_in_at), originalCheckOutAt: r.original_check_out_at as string | null, checkInBy: String(r.in_name), checkOutBy: r.out_name as string | null, guardianName: r.guardian_name as string | null, departureType: r.departure_type as VisitSummary['departureType'], reviewStatus: r.review_status as VisitSummary['reviewStatus'], version: Number(r.version) }; }
export function correctionView(r: Row): Correction { return { id: String(r.id), visitId: String(r.visit_id), priorCheckInAt: String(r.prior_check_in_at), priorCheckOutAt: r.prior_check_out_at as string | null, checkInAt: String(r.check_in_at), checkOutAt: r.check_out_at as string | null, reason: String(r.reason), actorName: String(r.actor_name), recordedAt: String(r.recorded_at) }; }
export async function getCenter(c: Context<AppEnv>): Promise<Center> { const row = await c.env.CRM_DB.prepare('SELECT * FROM centers WHERE id=?').bind(centerId(c)).first(); return { id: centerId(c), name: String(row?.name ?? 'My Kumon Center'), timezone: String(row?.timezone ?? 'America/Los_Angeles'), location: String(row?.location ?? ''), operatingHours: String(row?.operating_hours ?? '') }; }
function expectedRevision(value: unknown) { if (value === undefined) return null; if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ApiProblem(400, 'INVALID_REVISION', 'Provide the revision of the student record you reviewed.'); return Number(value); }
function changedAudit(c: Context<AppEnv>, action: string, studentId: string, detail: unknown) { return c.env.CRM_DB.prepare('INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()>0').bind(id(), centerId(c), c.var.actor.id, c.var.actor.displayName, action, 'student', studentId, JSON.stringify(detail), now()); }
function adminOnly(c: Context<AppEnv>) { if (c.var.actor.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace for this action.'); }
function pagination(c: Context<AppEnv>) { const page = Number(c.req.query('page') || 1); const pageSize = Number(c.req.query('pageSize') || 25); if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new ApiProblem(400, 'INVALID_PAGE', 'Use a positive page number and a page size of 1–50.'); return { page, pageSize, offset: (page - 1) * pageSize }; }
export function parseStudent(input: Row, partial = false) {
  const fields: Record<string, unknown> = {};
  for (const [name, column, max] of [['studentCode', 'student_code', 60], ['firstName', 'first_name', 100], ['lastName', 'last_name', 100], ['pickupAlert', 'pickup_alert', 1000]] as const) {
    if (name in input || !partial) fields[column] = textValue(input[name] ?? (name === 'pickupAlert' ? '' : undefined), name, max, name !== 'pickupAlert');
  }
  if ('grade' in input || !partial) fields.grade = textValue(input.grade ?? '', 'grade', 30, false);
  if ('active' in input || !partial) { if (input.active !== undefined && typeof input.active !== 'boolean') throw new ApiProblem(400, 'INVALID_INPUT', 'active must be true or false.'); fields.active = input.active === false ? 0 : 1; }
  if ('subjects' in input || !partial) { const subjects = input.subjects ?? []; if (!Array.isArray(subjects) || subjects.length > 10 || subjects.some(s => typeof s !== 'string' || s.length > 60)) throw new ApiProblem(400, 'INVALID_INPUT', 'subjects must contain at most 10 short names.'); fields.subjects = JSON.stringify(subjects); }
  return fields;
}
export function parseGuardian(input: Row) {
  const authority = input.pickupAuthority ?? 'unverified';
  if (!['unverified', 'allowed', 'denied'].includes(String(authority))) throw new ApiProblem(400, 'INVALID_INPUT', 'Pickup authority must be unverified, allowed, or denied.');
  const authorityNote = textValue(input.authorityNote ?? '', 'authorityNote', 1000, false);
  if (authority === 'allowed' && authorityNote.length < 5) throw new ApiProblem(400, 'AUTHORITY_EVIDENCE_REQUIRED', 'Record how pickup authority was verified.');
  return { displayName: textValue(input.displayName, 'displayName', 150), relationship: textValue(input.relationship ?? '', 'relationship', 100, false), phone: textValue(input.phone ?? '', 'phone', 50, false), email: textValue(input.email ?? '', 'email', 200, false), pickupAuthority: authority as Guardian['pickupAuthority'], authorityNote };
}
function guardianStatements(c: Context<AppEnv>, studentId: string, g: ReturnType<typeof parseGuardian>) { const guardianId = id(); return [c.env.CRM_DB.prepare('INSERT INTO guardians(id,center_id,display_name,phone,email,created_at) VALUES(?,?,?,?,?,?)').bind(guardianId, centerId(c), g.displayName, g.phone, g.email, now()), c.env.CRM_DB.prepare('INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note) VALUES(?,?,?,?,?)').bind(studentId, guardianId, g.relationship, g.pickupAuthority, g.authorityNote)]; }
export function createRecordsRouter() {
  const app = new Hono<AppEnv>();
  app.get('/students', async c => {
    requireRole(c, attendanceRoles); const { page, pageSize, offset } = pagination(c); const q = textValue(c.req.query('q') || '', 'Search', 100, false);
    const where = "center_id=? AND (?='' OR instr(lower(first_name||' '||last_name),lower(?))>0 OR instr(lower(student_code),lower(?))>0)";
    const args = [centerId(c), q, q, q];
    const result = await c.env.CRM_DB.batch<Record<string, unknown>>([c.env.CRM_DB.prepare(`SELECT * FROM students WHERE ${where} ORDER BY last_name,first_name,id LIMIT ? OFFSET ?`).bind(...args, pageSize, offset), c.env.CRM_DB.prepare(`SELECT count(*) AS n FROM students WHERE ${where}`).bind(...args)]);
    return c.json({ items: result[0].results.map(studentView), total: Number(result[1].results[0].n), page, pageSize });
  });
  app.get('/students/:id', async c => {
    requireRole(c, attendanceRoles); const student = await c.env.CRM_DB.prepare('SELECT * FROM students WHERE id=? AND center_id=?').bind(c.req.param('id'), centerId(c)).first();
    if (!student) throw new ApiProblem(404, 'STUDENT_NOT_FOUND', 'Student was not found.');
    const [guardians, attendance] = await Promise.all([
      c.env.CRM_DB.prepare('SELECT g.*,sg.relationship,sg.pickup_authority,sg.authority_note FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id WHERE sg.student_id=? ORDER BY g.display_name LIMIT 20').bind(student.id).all<Record<string, unknown>>(),
      studentAttendanceDetail(c, String(student.id)),
    ]);
    return c.json({ student: studentView(student), guardians: guardians.results.map(guardianView), ...attendance });
  });
  app.post('/students', async c => {
    adminOnly(c); requireRole(c, managementRoles); const input = await body(c); const student = parseStudent(input); const studentId = id(); const timestamp = now();
    const guardians = input.guardians ?? []; if (!Array.isArray(guardians) || guardians.length > 20 || guardians.some(g => !g || typeof g !== 'object' || Array.isArray(g))) throw new ApiProblem(400, 'INVALID_INPUT', 'Provide at most 20 guardians.');
    const result = await c.env.CRM_DB.batch<Record<string, unknown>>([
      c.env.CRM_DB.prepare('INSERT INTO students(id,center_id,student_code,first_name,last_name,active,subjects,pickup_alert,created_at,updated_at,grade) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(studentId, centerId(c), student.student_code, student.first_name, student.last_name, student.active, student.subjects, student.pickup_alert, timestamp, timestamp, student.grade),
      ...guardians.flatMap(g => guardianStatements(c, studentId, parseGuardian(g))), audit(c, 'student_created', 'student', studentId),
      c.env.CRM_DB.prepare('SELECT * FROM students WHERE id=? AND center_id=?').bind(studentId, centerId(c)),
    ]);
    return c.json({ student: studentView(result[result.length - 1].results[0]) }, 201);
  });
  app.patch('/students/:id', async c => {
    adminOnly(c); requireRole(c, managementRoles); const value = await body(c), revision = expectedRevision(value.expectedRevision), input = parseStudent(value, true); const keys = Object.keys(input); if (!keys.length) throw new ApiProblem(400, 'INVALID_INPUT', 'Provide at least one student field.');
    const existing = await c.env.CRM_DB.prepare('SELECT id FROM students WHERE id=? AND center_id=?').bind(c.req.param('id'), centerId(c)).first(); if (!existing) throw new ApiProblem(404, 'STUDENT_NOT_FOUND', 'Student was not found.');
    const result = await c.env.CRM_DB.batch<Record<string, unknown>>([
      c.env.CRM_DB.prepare(`UPDATE students SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=? AND center_id=? AND (? IS NULL OR revision=?) RETURNING id`).bind(...keys.map(k => input[k]), now(), existing.id, centerId(c), revision, revision),
      changedAudit(c, 'student_updated', String(existing.id), { fields: keys }),
      c.env.CRM_DB.prepare('SELECT * FROM students WHERE id=? AND center_id=?').bind(existing.id, centerId(c)),
    ]);
    if (!result[0].results.length) throw new ApiProblem(409, 'STALE_STUDENT', 'This student record changed. Reload it before saving.');
    return c.json({ student: studentView(result[2].results[0]) });
  });
  app.post('/students/:id/guardians', async c => {
    adminOnly(c); requireRole(c, managementRoles); const student = await c.env.CRM_DB.prepare('SELECT id FROM students WHERE id=? AND center_id=?').bind(c.req.param('id'), centerId(c)).first(); if (!student) throw new ApiProblem(404, 'STUDENT_NOT_FOUND', 'Student was not found.');
    const count = await c.env.CRM_DB.prepare('SELECT count(*) AS n FROM student_guardians WHERE student_id=?').bind(student.id).first<{ n: number }>(); if ((count?.n || 0) >= 20) throw new ApiProblem(409, 'GUARDIAN_LIMIT', 'A student may have at most 20 guardians.');
    await c.env.CRM_DB.batch<Record<string, unknown>>([...guardianStatements(c, String(student.id), parseGuardian(await body(c))), audit(c, 'guardian_added', 'student', String(student.id))]); return c.json({ ok: true }, 201);
  });
  app.patch('/students/:id/guardians/:guardianId', async c => {
    adminOnly(c); requireRole(c, managementRoles); const existing = await c.env.CRM_DB.prepare('SELECT g.*,sg.relationship,sg.pickup_authority,sg.authority_note,s.revision AS student_revision FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id JOIN students s ON s.id=sg.student_id WHERE s.center_id=? AND s.id=? AND g.id=?').bind(centerId(c), c.req.param('id'), c.req.param('guardianId')).first(); if (!existing) throw new ApiProblem(404, 'GUARDIAN_NOT_FOUND', 'Linked guardian was not found.');
    const value = await body(c), revision = expectedRevision(value.expectedRevision) ?? Number(existing.student_revision), g = parseGuardian({ ...guardianView(existing), ...value });
    // Each dependent write is conditional on the preceding write. changes()
    // excludes trigger updates; a stale guardian edit changes no contact,
    // authority, linked-student revision, or audit record.
    const result = await c.env.CRM_DB.batch<Record<string, unknown>>([
      c.env.CRM_DB.prepare('UPDATE guardians SET display_name=?,phone=?,email=? WHERE id=? AND center_id=? AND EXISTS(SELECT 1 FROM students s JOIN student_guardians sg ON sg.student_id=s.id WHERE s.id=? AND s.center_id=? AND s.revision=? AND sg.guardian_id=guardians.id) RETURNING id').bind(g.displayName, g.phone, g.email, existing.id, centerId(c), c.req.param('id'), centerId(c), revision),
      c.env.CRM_DB.prepare('UPDATE student_guardians SET relationship=?,pickup_authority=?,authority_note=? WHERE student_id=? AND guardian_id=? AND changes()>0').bind(g.relationship, g.pickupAuthority, g.authorityNote, c.req.param('id'), existing.id),
      changedAudit(c, 'guardian_authority_updated', c.req.param('id'), { guardianId: existing.id, authority: g.pickupAuthority, authorityNote: g.authorityNote }),
    ]);
    if (!result[0].results.length) throw new ApiProblem(409, 'STALE_STUDENT', 'This student or guardian record changed. Reload it before saving pickup authority.');
    return c.json({ guardian: { id: existing.id, ...g } });
  });
  app.get('/roster', async c => {
    const requestedValue = c.req.query('revision');
    let requestedRevision: number | null = null;
    if (requestedValue !== undefined) {
      if (!/^[1-9]\d*$/.test(requestedValue)) throw new ApiProblem(400, 'INVALID_ROSTER_REVISION', 'Use a positive roster revision.');
      requestedRevision = Number(requestedValue);
      if (!Number.isSafeInteger(requestedRevision)) throw new ApiProblem(400, 'INVALID_ROSTER_REVISION', 'Use a positive roster revision.');
    }
    const current = await c.env.CRM_DB.prepare('SELECT version FROM roster_revisions WHERE center_id=?').bind(centerId(c)).first<{ version: number }>();
    if (!current || !Number.isSafeInteger(current.version) || current.version < 1) throw new ApiProblem(503, 'ROSTER_REVISION_UNAVAILABLE', 'The current roster revision is unavailable.');
    if (requestedRevision === current.version) return c.json({ unchanged: true as const, revision: current.version, asOf: now() }, 200, { 'Cache-Control': 'no-store' });
    const [rows, revision] = await c.env.CRM_DB.batch<Record<string, unknown>>([
      c.env.CRM_DB.prepare(`${visitSelect} WHERE v.center_id=? AND v.check_out_at IS NULL ORDER BY v.check_in_at LIMIT 251`).bind(centerId(c)),
      c.env.CRM_DB.prepare('SELECT version FROM roster_revisions WHERE center_id=?').bind(centerId(c)),
    ]);
    const version = Number(revision.results[0]?.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new ApiProblem(503, 'ROSTER_REVISION_UNAVAILABLE', 'The current roster revision is unavailable.');
    return c.json({ items: rows.results.slice(0, 250).map(visitView), asOf: now(), limit: 250, truncated: rows.results.length > 250, revision: version }, 200, { 'Cache-Control': 'no-store' });
  });
  return app;
}

export function localMidnight(day: string, timezone: string, sharedFormatter?: Intl.DateTimeFormat) {
  const target = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== day) throw new ApiProblem(400, 'INVALID_DATE', 'Use a valid calendar date.');
  let candidate = target;
  const formatter = sharedFormatter || new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(candidate).map(p => [p.type, p.value]));
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`);
    candidate += target - local;
  }
  return new Date(candidate).toISOString();
}
export async function historyRange(c: Context<AppEnv>) { const center = await getCenter(c); const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: center.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); const todayParts = Object.fromEntries(formatter.formatToParts(new Date()).map(p => [p.type, p.value])); const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`; const from = c.req.query('from') || new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10); const to = c.req.query('to') || today; if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to)) throw new ApiProblem(400, 'INVALID_RANGE', 'Use dates in YYYY-MM-DD format.'); const fromISO = localMidnight(from, center.timezone, formatter); localMidnight(to, center.timezone, formatter); const days = (Date.parse(to) - Date.parse(from)) / 86400000; if (days < 0 || days > 365) throw new ApiProblem(400, 'INVALID_RANGE', 'Choose a date range of at most 366 days.'); const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); return { from, to, fromISO, toISO: localMidnight(next, center.timezone, formatter), timezone: center.timezone }; }
export function createHistoryRouter() {
  const app = new Hono<AppEnv>();
  app.get('/history', async c => { requireRole(c, managementRoles); const range = await historyRange(c); const paging = pagination(c); const studentId = c.req.query('studentId') || ''; return c.json(await attendanceVisitHistory(c, range, paging, studentId)); });
  app.get('/history/events', async c => {
    requireRole(c, managementRoles);
    const range = await historyRange(c);
    const paging = pagination(c);
    const studentId = c.req.query('studentId') || '';
    return c.json(await attendanceEventHistory(c, range, paging, studentId));
  });
  app.get('/reports/attendance/pages', async c => {
    requireRole(c, managementRoles); const range = await historyRange(c);
    const page = await attendanceReportPage(c, range, reportPageInput(c));
    if (page.initial) await audit(c, 'attendance_export_started', 'report', id(), { from: range.from, to: range.to, counts: page.initial.counts, epoch: page.epoch }).run();
    if (page.phase === 'unmatched' && page.next === null) await audit(c, 'attendance_exported', 'report', id(), { from: range.from, to: range.to, epoch: page.epoch }).run();
    return c.json(page, 200, { 'Cache-Control': 'no-store' });
  });
  app.get('/reports/attendance.csv', async c => {
    requireRole(c, managementRoles);
    return smallAttendanceCsv(c, await historyRange(c));
  });
  app.get('/reviews', async c => { requireRole(c, managementRoles); const rows = await c.env.CRM_DB.prepare("SELECT r.*,s.first_name||' '||s.last_name AS student_name FROM reviews r JOIN students s ON s.id=r.student_id WHERE r.center_id=? AND r.status='pending' ORDER BY r.created_at LIMIT 251").bind(centerId(c)).all(); return c.json({ items: rows.results.slice(0, 250).map(r => ({ id: r.id, eventId: r.event_id, visitId: r.visit_id, studentId: r.student_id, studentName: r.student_name, reason: r.reason, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at, resolution: r.resolution })), truncated: rows.results.length > 250 }); });
  app.post('/reviews/:id/resolve', async c => { requireRole(c, managementRoles); const resolution = textValue((await body(c)).resolution, 'resolution', 2000); if (resolution.length < 5) throw new ApiProblem(400, 'REASON_REQUIRED', 'Provide a meaningful review resolution.'); const review = await c.env.CRM_DB.prepare('SELECT * FROM reviews WHERE id=? AND center_id=?').bind(c.req.param('id'), centerId(c)).first(); if (!review) throw new ApiProblem(404, 'REVIEW_NOT_FOUND', 'Review was not found.'); const resolvedAt = now(); await c.env.CRM_DB.batch<Record<string, unknown>>([c.env.CRM_DB.prepare("UPDATE reviews SET status='resolved',resolved_at=?,resolved_by=?,resolution=? WHERE id=? AND status='pending'").bind(resolvedAt, c.var.actor.id, resolution, review.id), c.env.CRM_DB.prepare("UPDATE visits SET review_status='resolved' WHERE id=? AND review_status='pending'").bind(review.visit_id), audit(c, 'review_resolved', 'review', String(review.id), { resolution }, resolvedAt)]); return c.json({ ok: true }); });
  return app;
}
