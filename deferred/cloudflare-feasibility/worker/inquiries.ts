import { Hono, type Context } from 'hono';
import type { AppEnv } from './types';
import { inquiryStages, type Inquiry, type InquiryInput, type FollowUpTask } from '../shared/inquiries';
import { getCenter, studentView } from './records';
import { ApiProblem, body, centerId, id, now, requireRole, sha256, uuidValue } from './util';

type Row = Record<string, unknown>;
const active = "('New','Contacted','Assessment scheduled','Assessment completed')";
const writable = ['owner', 'manager', 'front_desk'] as const;
function text(value: unknown, field: string, max = 200, required = true) {
  if (!required && value == null) return '';
  if (typeof value !== 'string' || value.trim().length > max || required && !value.trim())
    throw new ApiProblem(422, 'INVALID_INQUIRY', `${field} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  return value.trim();
}
function timestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new ApiProblem(422, 'INVALID_DUE_DATE', 'Due date must be a valid date and time with a time zone.');
  const day = value.slice(0, 10), parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day)
    throw new ApiProblem(422, 'INVALID_DUE_DATE', 'Due date must use a valid calendar date.');
  return new Date(value).toISOString();
}
function input(value: Row): Omit<InquiryInput, 'inquiryId'> {
  const email = text(value.email, 'Email', 254, false).toLowerCase(), phone = text(value.phone, 'Phone', 40, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiProblem(422, 'INVALID_EMAIL', 'Enter a valid email address.');
  if (!email && !phone) throw new ApiProblem(422, 'CONTACT_REQUIRED', 'Provide an email address or phone number.');
  if (!Array.isArray(value.subjects) || value.subjects.some(subject => subject !== 'Math' && subject !== 'Reading'))
    throw new ApiProblem(422, 'INVALID_SUBJECT', 'Choose Math or Reading.');
  return { contactName: text(value.contactName, 'Contact name'), studentName: text(value.studentName, 'Student name'), email, phone,
    subjects: [...new Set(value.subjects)] as InquiryInput['subjects'], source: text(value.source, 'Source'),
    nextAction: text(value.nextAction, 'Next action', 300, false), dueAt: timestamp(value.dueAt), notes: text(value.notes, 'Notes', 2000, false) };
}
export function inquiryView(row: Row): Inquiry {
  return { id: String(row.id), contactName: String(row.contact_name), studentName: String(row.student_name), email: String(row.email), phone: String(row.phone),
    subjects: JSON.parse(String(row.subjects)), stage: row.stage as Inquiry['stage'], source: String(row.source), ownerName: String(row.owner_name),
    nextAction: String(row.next_action), dueAt: row.due_at as string | null, notes: String(row.notes), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), convertedStudentId: row.converted_student_id as string | null, version: Number(row.version) };
}
function taskView(row: Row): FollowUpTask {
  return { id: String(row.id), title: String(row.title), detail: String(row.detail), dueAt: String(row.due_at), completedAt: row.completed_at as string | null,
    type: row.type as FollowUpTask['type'], inquiryId: row.inquiry_id as string | null };
}
function pagination(c: Context<AppEnv>) {
  const page = Number(c.req.query('page') || 1), pageSize = Number(c.req.query('pageSize') || 25);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50)
    throw new ApiProblem(400, 'INVALID_PAGE', 'Use a positive page and pageSize from 1 to 50.');
  return { page, pageSize };
}
async function find(c: Context<AppEnv>, inquiryId: string) {
  const row = await c.env.CRM_DB.prepare('SELECT * FROM inquiries WHERE id=? AND center_id=?').bind(inquiryId, centerId(c)).first();
  if (!row) throw new ApiProblem(404, 'INQUIRY_NOT_FOUND', 'Inquiry was not found.');
  return row;
}
function failure(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('INQUIRY_REASON_REQUIRED')) throw new ApiProblem(422, 'REASON_REQUIRED', 'Add a reason in notes before closing this inquiry.');
  if (message.includes('INQUIRY_ALREADY_ENROLLED')) throw new ApiProblem(409, 'ALREADY_ENROLLED', 'This inquiry is linked to an enrolled student. Manage the student record instead.');
  if (message.includes('INQUIRY_CLOSED')) throw new ApiProblem(409, 'INQUIRY_CLOSED', 'Reopen the inquiry before enrollment.');
  throw error;
}
export const inquiriesRouter = new Hono<AppEnv>();
// Match Railway's private CRM boundary: instructors receive neither family
// inquiry contacts nor follow-up tasks. Kiosk credentials never grant access.
inquiriesRouter.use('/inquiries*', async (c, next) => { if (c.var.actor?.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace.'); requireRole(c, [...writable]); await next(); });
inquiriesRouter.use('/tasks*', async (c, next) => { if (c.var.actor?.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace.'); requireRole(c, [...writable]); await next(); });

inquiriesRouter.get('/inquiries', async c => {
  const { page, pageSize } = pagination(c), view = c.req.query('view') || 'active', stage = c.req.query('stage');
  if (!['active', 'closed', 'all'].includes(view) || stage && !inquiryStages.includes(stage as Inquiry['stage'])) throw new ApiProblem(400, 'INVALID_FILTER', 'Choose a valid inquiry view and stage.');
  const where = ['center_id=?'], args: (string | number)[] = [centerId(c)];
  if (view !== 'all') where.push(`stage ${view === 'active' ? 'IN' : 'NOT IN'} ${active}`);
  if (stage) { where.push('stage=?'); args.push(stage); }
  const query = (c.req.query('q') || '').trim();
  if (query.length > 200) throw new ApiProblem(400, 'INVALID_QUERY', 'Search must be 200 characters or fewer.');
  if (query) { where.push("instr(lower(contact_name||' '||student_name||' '||email||' '||phone),lower(?))>0"); args.push(query); }
  const result = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(`SELECT * FROM inquiries WHERE ${where.join(' AND ')} ORDER BY created_at,id LIMIT ? OFFSET ?`).bind(...args, pageSize, (page - 1) * pageSize),
    c.env.CRM_DB.prepare(`SELECT count(*) AS n FROM inquiries WHERE ${where.join(' AND ')}`).bind(...args),
    c.env.CRM_DB.prepare(`SELECT coalesce(sum(stage IN ${active}),0) AS active,coalesce(sum(stage='Enrolled'),0) AS enrolled FROM inquiries WHERE center_id=?`).bind(centerId(c)),
  ]);
  return c.json({ items: result[0].results.map(inquiryView), total: Number(result[1].results[0].n), page, pageSize,
    counts: { active: Number(result[2].results[0].active), enrolled: Number(result[2].results[0].enrolled) }, timezone: (await getCenter(c)).timezone });
});
inquiriesRouter.get('/inquiries/:id', async c => c.json({ inquiry: inquiryView(await find(c, uuidValue(c.req.param('id'), 'inquiryId'))) }));
inquiriesRouter.get('/inquiries/:id/history', async c => {
  const inquiryId = uuidValue(c.req.param('id'), 'inquiryId'); await find(c, inquiryId); const { page, pageSize } = pagination(c);
  const result = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare('SELECT * FROM inquiry_stage_history WHERE center_id=? AND inquiry_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(centerId(c), inquiryId, pageSize, (page - 1) * pageSize),
    c.env.CRM_DB.prepare('SELECT count(*) AS n FROM inquiry_stage_history WHERE center_id=? AND inquiry_id=?').bind(centerId(c), inquiryId),
  ]);
  return c.json({ items: result[0].results.map(row => ({ id: row.id, fromStage: row.from_stage, toStage: row.to_stage, actorName: row.actor_name, createdAt: row.created_at })), total: Number(result[1].results[0].n), page, pageSize });
});
inquiriesRouter.post('/inquiries', async c => {
  const value = await body(c), data = input(value), inquiryId = value.inquiryId ? uuidValue(value.inquiryId, 'inquiryId') : id();
  const hash = await sha256(JSON.stringify(data)), timestamp = now();
  const result = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(`INSERT INTO inquiries(id,center_id,contact_name,student_name,email,phone,subjects,source,owner_name,next_action,due_at,notes,created_at,updated_at,creation_hash,created_by,last_actor_id,last_actor_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(inquiryId, centerId(c), data.contactName, data.studentName, data.email, data.phone, JSON.stringify(data.subjects), data.source, c.var.actor.displayName, data.nextAction, data.dueAt ?? null, data.notes ?? '', timestamp, timestamp, hash, c.var.actor.id, c.var.actor.id, c.var.actor.displayName),
    c.env.CRM_DB.prepare('SELECT * FROM inquiries WHERE id=? AND center_id=?').bind(inquiryId, centerId(c)),
  ]);
  const row = result[1].results[0];
  if (!row || row.creation_hash !== hash || row.created_by !== c.var.actor.id) throw new ApiProblem(409, 'INQUIRY_ID_REUSED', 'This inquiry request ID has already been used for different details.');
  const replayed = !result[0].meta.changes;
  return c.json({ inquiry: inquiryView(row), replayed }, replayed ? 200 : 201);
});
inquiriesRouter.patch('/inquiries/:id', async c => {
  const inquiryId = uuidValue(c.req.param('id'), 'inquiryId'), value = await body(c); await find(c, inquiryId);
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) throw new ApiProblem(422, 'VERSION_REQUIRED', 'Refresh the inquiry before saving changes.');
  const updates: Row = {};
  if ('stage' in value) {
    if (!inquiryStages.includes(value.stage as Inquiry['stage'])) throw new ApiProblem(422, 'INVALID_STAGE', 'Choose a valid inquiry stage.');
    updates.stage = value.stage;
  }
  for (const [key, column, max] of [['nextAction', 'next_action', 300], ['notes', 'notes', 2000], ['ownerName', 'owner_name', 200]] as const)
    if (key in value) updates[column] = text(value[key], key, max, false);
  if ('dueAt' in value) updates.due_at = timestamp(value.dueAt);
  if (!Object.keys(updates).length) throw new ApiProblem(422, 'NO_CHANGES', 'Provide inquiry fields to update.');
  // Stage checks use the fresh row inside the same transaction, not a pre-read.
  if (updates.stage === 'Enrolled') {
    const current = await find(c, inquiryId);
    if (!current.converted_student_id) throw new ApiProblem(422, 'CONVERSION_REQUIRED', 'Use Enroll student to create a linked enrollment.');
  }
  const keys = Object.keys(updates);
  try {
    const result = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare(`UPDATE inquiries SET ${keys.map(key => `${key}=?`).join(',')},version=version+1,updated_at=?,last_actor_id=?,last_actor_name=? WHERE id=? AND center_id=? AND version=? RETURNING id`)
        .bind(...keys.map(key => updates[key]), now(), c.var.actor.id, c.var.actor.displayName, inquiryId, centerId(c), value.expectedVersion),
      c.env.CRM_DB.prepare('SELECT * FROM inquiries WHERE id=? AND center_id=?').bind(inquiryId, centerId(c)),
    ]);
    if (!result[0].results.length) throw new ApiProblem(409, 'STALE_INQUIRY', 'This inquiry changed. Reload it before saving.');
    return c.json({ inquiry: inquiryView(result[1].results[0]) });
  } catch (error) { return failure(error); }
});
inquiriesRouter.post('/inquiries/:id/convert', async c => {
  const inquiryId = uuidValue(c.req.param('id'), 'inquiryId'), value = await body(c), current = await find(c, inquiryId);
  if (!current.converted_student_id && ['Closed lost', 'Do not contact'].includes(String(current.stage))) throw new ApiProblem(409, 'INQUIRY_CLOSED', 'Reopen the inquiry before enrollment.');
  // A replay returns the saved grade and never overwrites the created student.
  const grade = current.converted_student_id ? '' : text(value.grade, 'Grade', 30, false);
  const studentId = id(), guardianId = id(), timestamp = now();
  const parts = String(current.student_name).trim().split(/\s+/), firstName = parts[0], lastName = parts.slice(1).join(' ');
  const eligible = "id=? AND center_id=? AND converted_student_id IS NULL AND stage NOT IN ('Closed lost','Do not contact')";
  const args = [inquiryId, centerId(c)];
  try {
    const result = await c.env.CRM_DB.batch<Row>([
      // D1 serializes the batch. Include imported/manual K-numbers before issuing
      // the next one; a global unique key remains the final collision guard.
      c.env.CRM_DB.prepare(`UPDATE centers SET student_sequence=max(student_sequence,coalesce((SELECT max(CAST(substr(student_code,3) AS INTEGER)) FROM students WHERE center_id=? AND student_code GLOB 'K-[0-9]*' AND substr(student_code,3) NOT GLOB '*[^0-9]*'),0))+1 WHERE id=? AND EXISTS(SELECT 1 FROM inquiries WHERE ${eligible})`).bind(centerId(c), centerId(c), ...args),
      c.env.CRM_DB.prepare(`INSERT INTO students(id,center_id,student_code,first_name,last_name,grade,subjects,created_at,updated_at)
        SELECT ?,center_id,'K-'||printf('%04d',(SELECT student_sequence FROM centers WHERE id=inquiries.center_id)),?,?,?,CASE WHEN json_array_length(subjects)>0 THEN subjects ELSE '["Math"]' END,?,? FROM inquiries WHERE ${eligible}`)
        .bind(studentId, firstName, lastName, grade, timestamp, timestamp, ...args),
      c.env.CRM_DB.prepare(`INSERT INTO guardians(id,center_id,display_name,email,phone,created_at) SELECT ?,center_id,contact_name,email,phone,? FROM inquiries WHERE ${eligible}`).bind(guardianId, timestamp, ...args),
      c.env.CRM_DB.prepare(`INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note) SELECT ?,?,'Parent / guardian','unverified','' FROM inquiries WHERE ${eligible}`).bind(studentId, guardianId, ...args),
      c.env.CRM_DB.prepare(`UPDATE inquiries SET stage='Enrolled',converted_student_id=?,next_action='',due_at=NULL,version=version+1,updated_at=?,last_actor_id=?,last_actor_name=? WHERE ${eligible} RETURNING id`)
        .bind(studentId, timestamp, c.var.actor.id, c.var.actor.displayName, ...args),
      c.env.CRM_DB.prepare('SELECT * FROM inquiries WHERE id=? AND center_id=?').bind(...args),
      c.env.CRM_DB.prepare('SELECT s.* FROM students s JOIN inquiries i ON i.converted_student_id=s.id AND i.center_id=s.center_id WHERE i.id=? AND i.center_id=?').bind(...args),
    ]);
    if (!result[5].results[0]?.converted_student_id) throw new ApiProblem(409, 'INQUIRY_CLOSED', 'Reopen the inquiry before enrollment.');
    return c.json({ studentId: String(result[5].results[0].converted_student_id), student: studentView(result[6].results[0]), inquiry: inquiryView(result[5].results[0]), replayed: !result[4].results.length });
  } catch (error) { return failure(error); }
});
inquiriesRouter.get('/tasks', async c => {
  const { page, pageSize } = pagination(c), status = c.req.query('status') || 'pending';
  if (!['pending', 'completed', 'all'].includes(status)) throw new ApiProblem(400, 'INVALID_FILTER', 'Choose pending, completed, or all tasks.');
  const where = ['center_id=?'], args: (string | number)[] = [centerId(c)];
  if (status !== 'all') where.push(`completed_at IS ${status === 'pending' ? '' : 'NOT '}NULL`);
  if (c.req.query('inquiryId')) { where.push('inquiry_id=?'); args.push(uuidValue(c.req.query('inquiryId'), 'inquiryId')); }
  const result = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY due_at,id LIMIT ? OFFSET ?`).bind(...args, pageSize, (page - 1) * pageSize),
    c.env.CRM_DB.prepare(`SELECT count(*) AS n FROM tasks WHERE ${where.join(' AND ')}`).bind(...args),
  ]);
  return c.json({ items: result[0].results.map(taskView), total: Number(result[1].results[0].n), page, pageSize });
});
inquiriesRouter.post('/tasks/:id/complete', async c => {
  const taskId = uuidValue(c.req.param('id'), 'taskId');
  const result = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare('UPDATE tasks SET completed_at=?,completed_by=?,completed_by_name=? WHERE id=? AND center_id=? AND completed_at IS NULL').bind(now(), c.var.actor.id, c.var.actor.displayName, taskId, centerId(c)),
    c.env.CRM_DB.prepare('SELECT * FROM tasks WHERE id=? AND center_id=?').bind(taskId, centerId(c)),
  ]);
  if (!result[1].results.length) throw new ApiProblem(404, 'TASK_NOT_FOUND', 'Task was not found.');
  return c.json({ task: taskView(result[1].results[0]) });
});
