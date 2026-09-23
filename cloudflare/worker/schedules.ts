import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { Schedule, ScheduleInput, ScheduleSubject } from '../shared/schedules';
import { getCenter } from './records';
import { ApiProblem, audit, body, centerId, id, now, requireRole, uuidValue } from './util';

type Row = Record<string, unknown>;
const operators = ['owner', 'manager', 'front_desk'] as const;
const selectSchedule = `SELECT sc.*,s.first_name||' '||s.last_name AS student_name,s.student_code,s.active AS student_active
  FROM schedules sc JOIN students s ON s.id=sc.student_id AND s.center_id=sc.center_id`;

function scheduleView(row: Row): Schedule {
  return {
    id: String(row.id), studentId: String(row.student_id), studentName: String(row.student_name),
    studentCode: String(row.student_code), studentActive: !!row.student_active,
    dayOfWeek: Number(row.day_of_week), startTime: String(row.start_time), durationMinutes: Number(row.duration_minutes),
    subject: row.subject as ScheduleSubject, active: !!row.active, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function scheduleInput(value: Row): ScheduleInput {
  const studentId = uuidValue(value.studentId, 'studentId');
  if (!Number.isInteger(value.dayOfWeek) || Number(value.dayOfWeek) < 0 || Number(value.dayOfWeek) > 6)
    throw new ApiProblem(422, 'INVALID_SCHEDULE', 'Choose a day from Sunday through Saturday.');
  if (typeof value.startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.startTime))
    throw new ApiProblem(422, 'INVALID_SCHEDULE', 'Use a valid HH:mm start time.');
  if (!Number.isInteger(value.durationMinutes) || Number(value.durationMinutes) < 15 || Number(value.durationMinutes) > 180)
    throw new ApiProblem(422, 'INVALID_SCHEDULE', 'Duration must be 15–180 minutes.');
  if (value.subject !== 'Math' && value.subject !== 'Reading')
    throw new ApiProblem(422, 'INVALID_SCHEDULE', 'Choose Math or Reading.');
  const start = minutes(value.startTime);
  if (start + Number(value.durationMinutes) > 1440)
    throw new ApiProblem(422, 'INVALID_SCHEDULE', 'A visit slot cannot extend past midnight.');
  return { studentId, dayOfWeek: Number(value.dayOfWeek), startTime: value.startTime, durationMinutes: Number(value.durationMinutes), subject: value.subject };
}
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

function scheduleError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('SCHEDULE_STUDENT_NOT_FOUND')) throw new ApiProblem(404, 'STUDENT_NOT_FOUND', 'Student was not found.');
  if (message.includes('SCHEDULE_STUDENT_INACTIVE')) throw new ApiProblem(409, 'STUDENT_INACTIVE', 'The student must be active before creating or restoring a slot.');
  if (message.includes('SCHEDULE_SUBJECT_REQUIRED')) throw new ApiProblem(409, 'SUBJECT_NOT_ENROLLED', 'The student must be enrolled in this subject before creating or restoring a slot.');
  if (message.includes('SCHEDULE_OVERLAP')) throw new ApiProblem(409, 'SCHEDULE_OVERLAP', 'This student already has an overlapping active slot.');
  throw error;
}

export const schedulesRouter = new Hono<AppEnv>();
schedulesRouter.use('*', async (c, next) => {
  if (c.var.actor?.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace to view or change schedules.');
  await next();
});
schedulesRouter.get('/schedules', async c => {
  const page = Number(c.req.query('page') || 1), pageSize = Number(c.req.query('pageSize') || 25);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50)
    throw new ApiProblem(400, 'INVALID_PAGE', 'Use a positive page and pageSize from 1–50.');
  const active = c.req.query('active') ?? 'true';
  if (!['true', 'false', 'all'].includes(active)) throw new ApiProblem(400, 'INVALID_FILTER', 'Active must be true, false, or all.');
  const where = ['sc.center_id=?']; const args: (string | number)[] = [centerId(c)];
  if (active !== 'all') { where.push('sc.active=?'); args.push(active === 'true' ? 1 : 0); }
  const studentId = c.req.query('studentId');
  if (studentId) { where.push('sc.student_id=?'); args.push(uuidValue(studentId, 'studentId')); }
  const day = c.req.query('dayOfWeek');
  if (day !== undefined) {
    if (!/^[0-6]$/.test(day)) throw new ApiProblem(400, 'INVALID_FILTER', 'Choose a day from Sunday through Saturday.');
    where.push('sc.day_of_week=?'); args.push(Number(day));
  }
  const subject = c.req.query('subject');
  if (subject !== undefined) {
    if (subject !== 'Math' && subject !== 'Reading') throw new ApiProblem(400, 'INVALID_FILTER', 'Choose Math or Reading.');
    where.push('sc.subject=?'); args.push(subject);
  }
  const results = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(`${selectSchedule} WHERE ${where.join(' AND ')} ORDER BY sc.day_of_week,sc.start_time,sc.id LIMIT ? OFFSET ?`).bind(...args, pageSize, (page - 1) * pageSize),
    c.env.CRM_DB.prepare(`SELECT count(*) AS n FROM schedules sc WHERE ${where.join(' AND ')}`).bind(...args),
  ]);
  const center = await getCenter(c);
  return c.json({ items: results[0].results.map(scheduleView), total: Number(results[1].results[0].n), page, pageSize, timezone: center.timezone });
});
schedulesRouter.post('/schedules', async c => {
  requireRole(c, [...operators]);
  const input = scheduleInput(await body(c)); const scheduleId = id(); const timestamp = now();
  try {
    const result = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare('INSERT INTO schedules(id,center_id,student_id,day_of_week,start_time,start_minute,duration_minutes,subject,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(scheduleId, centerId(c), input.studentId, input.dayOfWeek, input.startTime, minutes(input.startTime), input.durationMinutes, input.subject, timestamp, timestamp),
      audit(c, 'schedule_created', 'schedule', scheduleId, input),
      c.env.CRM_DB.prepare(`${selectSchedule} WHERE sc.id=? AND sc.center_id=?`).bind(scheduleId, centerId(c)),
    ]);
    return c.json({ schedule: scheduleView(result[2].results[0]) }, 201);
  } catch (error) { return scheduleError(error); }
});
schedulesRouter.patch('/schedules/:id', async c => {
  requireRole(c, [...operators]);
  const input = await body(c);
  if (typeof input.active !== 'boolean') throw new ApiProblem(422, 'INVALID_SCHEDULE', 'Active must be true or false.');
  const scheduleId = uuidValue(c.req.param('id'), 'scheduleId');
  const existing = await c.env.CRM_DB.prepare('SELECT id FROM schedules WHERE id=? AND center_id=?').bind(scheduleId, centerId(c)).first();
  if (!existing) throw new ApiProblem(404, 'SCHEDULE_NOT_FOUND', 'Schedule was not found.');
  try {
    const result = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare('UPDATE schedules SET active=?,updated_at=? WHERE id=? AND center_id=?').bind(input.active ? 1 : 0, now(), scheduleId, centerId(c)),
      audit(c, input.active ? 'schedule_restored' : 'schedule_canceled', 'schedule', scheduleId),
      c.env.CRM_DB.prepare(`${selectSchedule} WHERE sc.id=? AND sc.center_id=?`).bind(scheduleId, centerId(c)),
    ]);
    return c.json({ schedule: scheduleView(result[2].results[0]) });
  } catch (error) { return scheduleError(error); }
});
