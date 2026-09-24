import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { Correction, Guardian, KioskGuardian, Student, StudentListItem, VisitSummary } from '../shared/types';
import {
  ApiProblem, attendanceRoles, audit, body, iso, isoRequired, managementRoles, now, pagination, paramId,
  requireAdmin, requireRole, staffRoles, textValue, type Ctx, type Row,
} from './util';

export const visitSelect = `SELECT v.*, s.first_name || ' ' || s.last_name AS student_name, s.student_code, s.active,
  ei.observed_at AS original_check_in_at, eo.observed_at AS original_check_out_at,
  si.display_name AS in_name, so.display_name AS out_name, g.display_name AS guardian_name
FROM visits v
JOIN students s ON s.id = v.student_id
JOIN attendance_events ei ON ei.id = v.id
JOIN staff si ON si.id = ei.actor_id
LEFT JOIN attendance_events eo ON eo.id = v.out_event_id
LEFT JOIN staff so ON so.id = eo.actor_id
LEFT JOIN guardians g ON g.id = eo.guardian_id`;

/** Same columns, reading only open visits through the small partial index rather than all history. */
export const openVisitSelect = visitSelect.replace('FROM visits v', 'FROM visits v INDEXED BY visits_open_location');

export function visitView(r: Row): VisitSummary {
  const closed = r.out_event_id !== null && r.out_event_id !== undefined;
  return {
    id: Number(r.id), locationId: Number(r.location_id), studentId: Number(r.student_id), studentName: String(r.student_name),
    studentCode: String(r.student_code), active: !!r.active,
    checkInAt: isoRequired(r.check_in_at), checkOutAt: iso(r.check_out_at),
    originalCheckInAt: isoRequired(r.original_check_in_at), originalCheckOutAt: iso(r.original_check_out_at),
    checkInBy: String(r.in_name), checkOutBy: (r.out_name as string | null) ?? null, guardianName: (r.guardian_name as string | null) ?? null,
    departureType: (r.departure as VisitSummary['departureType']) ?? null, reviewStatus: r.review as VisitSummary['reviewStatus'],
    version: Number(r.version), corrected: Number(r.version) > (closed ? 2 : 1),
  };
}
export function studentView(r: Row): Student {
  return {
    id: Number(r.id), locationId: Number(r.location_id), studentCode: String(r.student_code), firstName: String(r.first_name),
    lastName: String(r.last_name), displayName: `${r.first_name} ${r.last_name}`, grade: String(r.grade ?? ''),
    subjects: JSON.parse(String(r.subjects)), pickupAlert: String(r.pickup_alert), active: !!r.active,
    revision: Number(r.revision), createdAt: String(r.created_at),
  };
}
export function guardianView(r: Row): Guardian {
  return {
    id: Number(r.id), displayName: String(r.display_name), relationship: String(r.relationship), phone: String(r.phone),
    email: String(r.email), pickupAuthority: r.pickup_authority as Guardian['pickupAuthority'], authorityNote: String(r.authority_note),
  };
}
function kioskGuardianView(r: Row): KioskGuardian {
  return { id: Number(r.id), displayName: String(r.display_name), relationship: String(r.relationship), pickupAuthority: r.pickup_authority as Guardian['pickupAuthority'] };
}
export function correctionView(r: Row): Correction {
  return {
    id: Number(r.id), visitId: Number(r.visit_id), priorCheckInAt: isoRequired(r.prior_check_in_at), priorCheckOutAt: iso(r.prior_check_out_at),
    checkInAt: isoRequired(r.check_in_at), checkOutAt: iso(r.check_out_at), reason: String(r.reason), actorName: String(r.actor_name),
    recordedAt: isoRequired(r.recorded_at),
  };
}

function expectedRevision(value: unknown) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ApiProblem(400, 'INVALID_REVISION', 'Provide the revision of the student record you reviewed.');
  return Number(value);
}

export function parseStudent(input: Row, partial = false) {
  const fields: Record<string, string | number> = {};
  for (const [name, column, max] of [['studentCode', 'student_code', 60], ['firstName', 'first_name', 100], ['lastName', 'last_name', 100]] as const)
    if (name in input || !partial) fields[column] = textValue(input[name], name, max);
  if ('pickupAlert' in input || !partial) fields.pickup_alert = textValue(input.pickupAlert ?? '', 'pickupAlert', 1000, false);
  if ('grade' in input || !partial) fields.grade = textValue(input.grade ?? '', 'grade', 30, false);
  if ('active' in input || !partial) {
    if (input.active !== undefined && typeof input.active !== 'boolean') throw new ApiProblem(400, 'INVALID_INPUT', 'active must be true or false.');
    fields.active = input.active === false ? 0 : 1;
  }
  if ('subjects' in input || !partial) {
    const subjects = input.subjects ?? [];
    if (!Array.isArray(subjects) || subjects.length > 10 || subjects.some(s => typeof s !== 'string' || !s.trim() || s.length > 60))
      throw new ApiProblem(400, 'INVALID_INPUT', 'subjects must contain at most 10 short names.');
    fields.subjects = JSON.stringify([...new Set(subjects.map(s => String(s).trim()))]);
  }
  return fields;
}

export function parseGuardian(input: Row) {
  const authority = input.pickupAuthority ?? 'unverified';
  if (!['unverified', 'allowed', 'denied'].includes(String(authority))) throw new ApiProblem(400, 'INVALID_INPUT', 'Pickup authority must be unverified, allowed, or denied.');
  const authorityNote = textValue(input.authorityNote ?? '', 'authorityNote', 1000, false);
  if (authority === 'allowed' && authorityNote.length < 5) throw new ApiProblem(400, 'AUTHORITY_EVIDENCE_REQUIRED', 'Record how pickup authority was verified.');
  const email = textValue(input.email ?? '', 'email', 200, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiProblem(400, 'INVALID_EMAIL', 'Guardian email is not valid.');
  return {
    displayName: textValue(input.displayName, 'displayName', 150), relationship: textValue(input.relationship ?? '', 'relationship', 100, false),
    phone: textValue(input.phone ?? '', 'phone', 50, false), email, pickupAuthority: authority as Guardian['pickupAuthority'], authorityNote,
  };
}

/** Insert a guardian and link it to a student looked up by code within the location. */
function guardianStatements(c: Ctx, studentCode: string, g: ReturnType<typeof parseGuardian>) {
  const key = `new:${crypto.randomUUID()}`;
  const db = c.env.CRM_DB;
  return [
    db.prepare('INSERT INTO guardians (display_name, phone, email, import_ref, created_at) VALUES (?, ?, ?, ?, ?)').bind(g.displayName, g.phone, g.email, key, now()),
    db.prepare(`INSERT INTO student_guardians (student_id, guardian_id, relationship, pickup_authority, authority_note)
      SELECT s.id, g.id, ?, ?, ? FROM students s, guardians g WHERE s.location_id = ? AND s.student_code = ? AND g.import_ref = ?`)
      .bind(g.relationship, g.pickupAuthority, g.authorityNote, c.var.locationId, studentCode, key),
    db.prepare('UPDATE guardians SET import_ref = NULL WHERE import_ref = ?').bind(key),
  ];
}

async function requireStudent(c: Ctx, id: number) {
  const student = await c.env.CRM_DB.prepare('SELECT * FROM students WHERE id = ? AND location_id = ?').bind(id, c.var.locationId).first<Row>();
  if (!student) throw new ApiProblem(404, 'STUDENT_NOT_FOUND', 'Student was not found.');
  return student;
}

export function createRecordsRouter() {
  const app = new Hono<AppEnv>();

  /** Student directory. Contact details only for the back office and roles that record attendance. */
  app.get('/students', async c => {
    requireRole(c, staffRoles);
    const { page, pageSize, offset } = pagination(c);
    const q = textValue(c.req.query('q') || '', 'Search', 100, false);
    const status = c.req.query('status') || 'active';
    const subject = c.req.query('subject') || 'all';
    if (!['active', 'inactive', 'all'].includes(status)) throw new ApiProblem(400, 'INVALID_FILTER', 'Choose active, inactive, or all.');
    if (subject.length > 60) throw new ApiProblem(400, 'INVALID_FILTER', 'Choose a valid subject.');
    const contacts = c.var.actor.channel === 'admin' && attendanceRoles.includes(c.var.actor.role);
    const where = `s.location_id = ?1 AND (?2 = 'all' OR s.active = ?3)
      AND (?4 = 'all' OR EXISTS (SELECT 1 FROM json_each(s.subjects) WHERE value = ?4))
      AND (?5 = '' OR instr(lower(s.first_name || ' ' || s.last_name), lower(?5)) > 0 OR instr(lower(s.student_code), lower(?5)) > 0
        ${contacts ? `OR EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id
          AND (instr(lower(g.display_name), lower(?5)) > 0 OR instr(lower(g.email), lower(?5)) > 0 OR instr(g.phone, ?5) > 0))` : ''})`;
    const args = [c.var.locationId, status, status === 'active' ? 1 : 0, subject, q];
    const contactSelect = contacts
      ? `, (SELECT json_object('displayName', g.display_name, 'phone', g.phone, 'email', g.email) FROM student_guardians sg
           JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id ORDER BY sg.pickup_authority = 'allowed' DESC, g.display_name, g.id LIMIT 1) AS contact`
      : '';
    const [rows, count] = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare(`SELECT s.*, EXISTS (SELECT 1 FROM visits v WHERE v.student_id = s.id AND v.check_out_at IS NULL) AS present ${contactSelect}
        FROM students s WHERE ${where} ORDER BY s.last_name, s.first_name, s.id LIMIT ?6 OFFSET ?7`).bind(...args, pageSize, offset),
      c.env.CRM_DB.prepare(`SELECT count(*) AS n FROM students s WHERE ${where}`).bind(...args),
    ]);
    const items: StudentListItem[] = rows.results.map(row => ({
      ...studentView(row), present: !!row.present, contact: typeof row.contact === 'string' ? JSON.parse(row.contact) : null,
    }));
    return c.json({ items, total: Number(count.results[0].n), page, pageSize });
  });

  app.get('/students/:id', async c => {
    requireRole(c, attendanceRoles);
    const student = await requireStudent(c, paramId(c));
    if (c.var.actor.channel === 'kiosk') {
      // A shared kiosk shows who may collect the student, never how to contact them.
      const [guardians, open] = await c.env.CRM_DB.batch<Row>([
        c.env.CRM_DB.prepare('SELECT g.id, g.display_name, sg.relationship, sg.pickup_authority FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? ORDER BY g.display_name LIMIT 20').bind(student.id),
        c.env.CRM_DB.prepare(`${visitSelect} WHERE v.student_id = ? AND v.check_out_at IS NULL`).bind(student.id),
      ]);
      return c.json({ student: studentView(student), guardians: guardians.results.map(kioskGuardianView), openVisit: open.results[0] ? visitView(open.results[0]) : null });
    }
    const { pageSize, offset, page } = pagination(c);
    const [guardians, visits, count] = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare('SELECT g.*, sg.relationship, sg.pickup_authority, sg.authority_note FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? ORDER BY g.display_name LIMIT 20').bind(student.id),
      c.env.CRM_DB.prepare(`${visitSelect} WHERE v.student_id = ? ORDER BY v.check_in_at DESC, v.id DESC LIMIT ? OFFSET ?`).bind(student.id, pageSize, offset),
      c.env.CRM_DB.prepare('SELECT count(*) AS n FROM visits WHERE student_id = ?').bind(student.id),
    ]);
    const visitIds = visits.results.map(row => Number(row.id));
    const corrections = visitIds.length
      ? await c.env.CRM_DB.prepare(`SELECT ac.*, st.display_name AS actor_name FROM attendance_corrections ac JOIN staff st ON st.id = ac.actor_id
          WHERE ac.visit_id IN (SELECT value FROM json_each(?)) ORDER BY ac.recorded_at, ac.id`).bind(JSON.stringify(visitIds)).all<Row>()
      : { results: [] as Row[] };
    return c.json({
      student: studentView(student), guardians: guardians.results.map(guardianView), visits: visits.results.map(visitView),
      corrections: corrections.results.map(correctionView), visitTotal: Number(count.results[0].n), page,
    });
  });

  app.post('/students', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const input = await body(c);
    const student = parseStudent(input);
    const guardians = input.guardians ?? [];
    if (!Array.isArray(guardians) || guardians.length > 5 || guardians.some(g => !g || typeof g !== 'object' || Array.isArray(g)))
      throw new ApiProblem(400, 'INVALID_INPUT', 'Provide at most 5 guardians when creating a student; add more from the profile.');
    const timestamp = now();
    const db = c.env.CRM_DB;
    const result = await db.batch<Row>([
      db.prepare(`INSERT INTO students (location_id, student_code, first_name, last_name, grade, subjects, pickup_alert, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .bind(c.var.locationId, student.student_code, student.first_name, student.last_name, student.grade, student.subjects, student.pickup_alert, student.active, timestamp, timestamp),
      ...guardians.flatMap(g => guardianStatements(c, String(student.student_code), parseGuardian(g as Row))),
    ]);
    const created = studentView(result[0].results[0]);
    await audit(c, 'student_created', 'student', created.id, { studentCode: created.studentCode }, c.var.locationId).run();
    return c.json({ student: created }, 201);
  });

  app.patch('/students/:id', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const value = await body(c);
    const revision = expectedRevision(value.expectedRevision);
    const input = parseStudent(value, true);
    const keys = Object.keys(input);
    if (!keys.length) throw new ApiProblem(400, 'INVALID_INPUT', 'Provide at least one student field.');
    const existing = await requireStudent(c, paramId(c));
    const db = c.env.CRM_DB;
    const [updated] = await db.batch<Row>([
      db.prepare(`UPDATE students SET ${keys.map(k => `${k} = ?`).join(', ')}, revision = revision + 1, updated_at = ?
        WHERE id = ? AND location_id = ? AND (? IS NULL OR revision = ?) RETURNING *`)
        .bind(...keys.map(k => input[k]), now(), existing.id, c.var.locationId, revision, revision),
    ]);
    if (!updated.results.length) throw new ApiProblem(409, 'STALE_STUDENT', 'This student record changed. Reload it before saving.');
    await audit(c, 'student_updated', 'student', Number(existing.id), { fields: keys.map(k => k.replace(/_(\w)/g, (_, x: string) => x.toUpperCase())) }, c.var.locationId).run();
    return c.json({ student: studentView(updated.results[0]) });
  });

  app.post('/students/:id/guardians', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const student = await requireStudent(c, paramId(c));
    const count = await c.env.CRM_DB.prepare('SELECT count(*) AS n FROM student_guardians WHERE student_id = ?').bind(student.id).first<{ n: number }>();
    if (Number(count?.n) >= 20) throw new ApiProblem(409, 'GUARDIAN_LIMIT', 'A student may have at most 20 guardians.');
    const guardian = parseGuardian(await body(c));
    await c.env.CRM_DB.batch([
      ...guardianStatements(c, String(student.student_code), guardian),
      c.env.CRM_DB.prepare('UPDATE students SET revision = revision + 1, updated_at = ? WHERE id = ?').bind(now(), student.id),
      audit(c, 'guardian_added', 'student', Number(student.id), { displayName: guardian.displayName, authority: guardian.pickupAuthority }, c.var.locationId),
    ]);
    return c.json({ ok: true }, 201);
  });

  app.patch('/students/:id/guardians/:guardianId', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const studentId = paramId(c);
    const guardianId = paramId(c, 'guardianId');
    const existing = await c.env.CRM_DB.prepare(
      `SELECT g.*, sg.relationship, sg.pickup_authority, sg.authority_note, s.revision AS student_revision
       FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id
       WHERE s.location_id = ? AND s.id = ? AND g.id = ?`,
    ).bind(c.var.locationId, studentId, guardianId).first<Row>();
    if (!existing) throw new ApiProblem(404, 'GUARDIAN_NOT_FOUND', 'Linked guardian was not found.');
    const value = await body(c);
    const revision = expectedRevision(value.expectedRevision) ?? Number(existing.student_revision);
    const g = parseGuardian({ ...guardianView(existing), ...value });
    const db = c.env.CRM_DB;
    // The revision check runs first. Each later statement runs only when the
    // statement before it changed a row (changes() reports the previous statement).
    const result = await db.batch<Row>([
      db.prepare('UPDATE students SET revision = revision + 1, updated_at = ? WHERE id = ? AND location_id = ? AND revision = ? RETURNING id').bind(now(), studentId, c.var.locationId, revision),
      db.prepare('UPDATE guardians SET display_name = ?, phone = ?, email = ? WHERE id = ? AND changes() = 1')
        .bind(g.displayName, g.phone, g.email, guardianId),
      db.prepare('UPDATE student_guardians SET relationship = ?, pickup_authority = ?, authority_note = ? WHERE student_id = ? AND guardian_id = ? AND changes() = 1')
        .bind(g.relationship, g.pickupAuthority, g.authorityNote, studentId, guardianId),
    ]);
    if (!result[0].results.length) throw new ApiProblem(409, 'STALE_STUDENT', 'This student or guardian record changed. Reload it before saving pickup authority.');
    await audit(c, 'guardian_updated', 'student', studentId, { guardianId, authority: g.pickupAuthority, authorityNote: g.authorityNote }, c.var.locationId).run();
    return c.json({ guardian: { id: guardianId, ...g } });
  });

  /** Who is here now. Clients poll with their last revision and receive a small "unchanged" reply when nothing moved. */
  app.get('/roster', async c => {
    requireRole(c, staffRoles);
    const requested = c.req.query('revision');
    if (requested !== undefined && !/^[1-9]\d{0,14}$/.test(requested)) throw new ApiProblem(400, 'INVALID_ROSTER_REVISION', 'Use a positive roster revision.');
    const current = await c.env.CRM_DB.prepare('SELECT roster_version FROM locations WHERE id = ?').bind(c.var.locationId).first<{ roster_version: number }>();
    if (!current) throw new ApiProblem(404, 'LOCATION_NOT_FOUND', 'Location was not found.');
    if (requested !== undefined && Number(requested) === current.roster_version)
      return c.json({ unchanged: true as const, revision: current.roster_version, asOf: now() });
    const [rows, revision] = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare(`${openVisitSelect} WHERE v.location_id = ? AND v.check_out_at IS NULL ORDER BY v.check_in_at LIMIT 301`).bind(c.var.locationId),
      c.env.CRM_DB.prepare('SELECT roster_version FROM locations WHERE id = ?').bind(c.var.locationId),
    ]);
    return c.json({
      items: rows.results.slice(0, 300).map(visitView), asOf: now(), limit: 300, truncated: rows.results.length > 300,
      revision: Number(revision.results[0].roster_version),
    });
  });

  return app;
}
