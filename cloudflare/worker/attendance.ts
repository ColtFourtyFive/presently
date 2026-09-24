import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { AttendanceEvent, Review } from '../shared/types';
import { touchOperator } from './auth';
import { getLocation } from './admin';
import { correctionView, visitSelect, visitView } from './records';
import {
  ApiProblem, addDays, attendanceRoles, audit, body, dateValue, idValue, iso, isoRequired, localMidnight, localParts,
  managementRoles, pagination, paramId, requireAdmin, requireRole, textValue, uuidValue, type Ctx, type Row,
} from './util';

const OBSERVATION_PAST_MS = 24 * 3600000;
const OBSERVATION_FUTURE_MS = 60000;

const eventSelect = 'SELECT e.*, st.display_name AS actor_name FROM attendance_events e JOIN staff st ON st.id = e.actor_id';
function eventView(row: Row): AttendanceEvent {
  return {
    id: Number(row.id), requestId: String(row.request_id), studentId: Number(row.student_id),
    visitId: row.action === 'check_in' ? Number(row.id) : (row.visit_id === null ? null : Number(row.visit_id)),
    action: row.action as AttendanceEvent['action'], observedAt: isoRequired(row.observed_at), receivedAt: isoRequired(row.received_at),
    actorId: Number(row.actor_id), actorName: String(row.actor_name), channel: row.device_id === null ? 'admin' : 'kiosk',
    guardianId: row.guardian_id === null ? null : Number(row.guardian_id), reason: (row.reason as string | null) ?? null,
  };
}

async function eventResult(c: Ctx, row: Row, replayed: boolean) {
  const event = eventView(row);
  const visit = event.visitId === null ? null : await c.env.CRM_DB.prepare(`${visitSelect} WHERE v.id = ?`).bind(event.visitId).first<Row>();
  return { event, visit: visit ? visitView(visit) : null, replayed };
}

/** A request ID may be retried only with the identical observation. */
function sameObservation(row: Row, input: { locationId: number; studentId: number; action: string; observedAt: number; guardianId: number | null; reason: string | null }) {
  return Number(row.location_id) === input.locationId && Number(row.student_id) === input.studentId && row.action === input.action
    && Number(row.observed_at) === input.observedAt && (row.guardian_id === null ? null : Number(row.guardian_id)) === input.guardianId
    && ((row.reason as string | null) ?? null) === input.reason;
}

/** Inclusive local calendar range, at most 366 days, defaulting to the last 30 days. */
export async function historyRange(c: Ctx) {
  const location = await getLocation(c);
  const today = localParts(Date.now(), location.timezone).date;
  const from = c.req.query('from') || addDays(today, -29);
  const to = c.req.query('to') || today;
  if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to)) throw new ApiProblem(400, 'INVALID_RANGE', 'Use dates in YYYY-MM-DD format.');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!Number.isFinite(days) || days < 0 || days > 365) throw new ApiProblem(400, 'INVALID_RANGE', 'Choose a date range of at most 366 days.');
  return { from, to, timezone: location.timezone, fromMs: localMidnight(from, location.timezone), toMs: localMidnight(addDays(to, 1), location.timezone) };
}

export function createAttendanceRouter() {
  const app = new Hono<AppEnv>();

  app.post('/attendance', async c => {
    requireRole(c, attendanceRoles);
    const input = await body(c);
    const requestId = uuidValue(input.eventId, 'eventId');
    const studentId = idValue(input.studentId, 'studentId');
    const action = textValue(input.action, 'action', 30);
    if (!['check_in', 'check_out', 'exceptional_departure'].includes(action)) throw new ApiProblem(400, 'INVALID_ACTION', 'Choose an explicit arrival or departure action.');
    const observedAt = dateValue(input.observedAt, 'observedAt');
    const guardianId = input.guardianId === undefined || input.guardianId === null ? null : idValue(input.guardianId, 'guardianId');
    const reason = input.reason ? textValue(input.reason, 'reason', 2000) : null;
    if (action === 'check_in' && (guardianId || reason)) throw new ApiProblem(400, 'INVALID_INPUT', 'Arrival does not accept a pickup guardian or departure reason.');
    if (action === 'exceptional_departure' && (!reason || reason.length < 5)) throw new ApiProblem(400, 'REASON_REQUIRED', 'Record the observed circumstances of the exceptional departure.');
    const observation = { locationId: c.var.locationId, studentId, action, observedAt, guardianId, reason };
    const db = c.env.CRM_DB;
    const lookup = db.prepare(`${eventSelect} WHERE e.request_id = ?`).bind(requestId);

    const replay = async () => {
      const existing = await lookup.first<Row>();
      if (!existing) return null;
      if (!sameObservation(existing, observation)) throw new ApiProblem(409, 'REQUEST_ID_REUSED', 'This request reference was already used for a different observation.');
      return c.json(await eventResult(c, existing, true));
    };
    const earlier = await replay();
    if (earlier) return earlier;

    const receivedAt = Date.now();
    if (observedAt > receivedAt + OBSERVATION_FUTURE_MS || observedAt < receivedAt - OBSERVATION_PAST_MS)
      throw new ApiProblem(400, 'OBSERVATION_OUT_OF_RANGE', 'Observation time must be within the past 24 hours and no more than one minute ahead. Use a manager correction for older records.');
    let inserted: Row | undefined;
    try {
      const [result] = await db.batch<Row>([
        db.prepare(`INSERT INTO attendance_events (request_id, location_id, student_id, visit_id, action, observed_at, received_at, actor_id, device_id, guardian_id, reason)
          VALUES (?1, ?2, ?3, iif(?4 = 'check_in', NULL, (SELECT id FROM visits WHERE student_id = ?3 AND location_id = ?2 AND check_out_at IS NULL)), ?4, ?5, ?6, ?7, ?8, ?9, ?10)
          ON CONFLICT (request_id) DO NOTHING RETURNING id`)
          .bind(requestId, c.var.locationId, studentId, action, observedAt, receivedAt, c.var.actor.id, c.var.actor.channel === 'kiosk' ? c.var.deviceId : null, guardianId, reason),
      ]);
      inserted = result.results[0];
    } catch (error) {
      // A concurrent retry of the same request may have won the insert.
      const raced = await replay();
      if (raced) return raced;
      throw error;
    }
    if (!inserted) {
      const raced = await replay();
      if (raced) return raced;
      throw new ApiProblem(500, 'ATTENDANCE_NOT_CONFIRMED', 'The observation could not be confirmed. Retry with the same request.');
    }
    if (c.var.actor.channel === 'kiosk') await touchOperator(c);
    const row = await lookup.first<Row>();
    return c.json(await eventResult(c, row!, false), 201);
  });

  app.get('/attendance/events/:requestId', async c => {
    requireRole(c, attendanceRoles);
    const requestId = uuidValue(c.req.param('requestId'), 'requestId');
    const row = await c.env.CRM_DB.prepare(`${eventSelect} WHERE e.request_id = ? AND e.location_id = ?`).bind(requestId, c.var.locationId).first<Row>();
    if (!row) throw new ApiProblem(404, 'EVENT_NOT_FOUND', 'This attendance observation has not been accepted.');
    return c.json(await eventResult(c, row, true));
  });

  app.get('/visits/:id', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const db = c.env.CRM_DB;
    const id = paramId(c);
    const [visit, corrections] = await db.batch<Row>([
      db.prepare(`${visitSelect} WHERE v.id = ? AND v.location_id = ?`).bind(id, c.var.locationId),
      db.prepare('SELECT ac.*, st.display_name AS actor_name FROM attendance_corrections ac JOIN staff st ON st.id = ac.actor_id WHERE ac.visit_id = ? ORDER BY ac.recorded_at, ac.id').bind(id),
    ]);
    if (!visit.results[0]) throw new ApiProblem(404, 'VISIT_NOT_FOUND', 'Visit was not found.');
    return c.json({ visit: visitView(visit.results[0]), corrections: corrections.results.map(correctionView) });
  });

  app.post('/visits/:id/corrections', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const input = await body(c);
    const visitId = paramId(c);
    const requestId = uuidValue(input.correctionId, 'correctionId');
    const expectedVersion = Number(input.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new ApiProblem(400, 'INVALID_VERSION', 'Provide the version of the visit you reviewed.');
    const checkInAt = dateValue(input.checkInAt, 'checkInAt');
    const checkOutAt = input.checkOutAt === null ? null : dateValue(input.checkOutAt, 'checkOutAt');
    const reason = textValue(input.reason, 'reason', 2000);
    if (reason.length < 5) throw new ApiProblem(400, 'REASON_REQUIRED', 'Record why the attendance needs correction.');
    const db = c.env.CRM_DB;
    const lookup = db.prepare('SELECT ac.*, st.display_name AS actor_name FROM attendance_corrections ac JOIN staff st ON st.id = ac.actor_id WHERE ac.request_id = ?').bind(requestId);
    const replay = async () => {
      const row = await lookup.first<Row>();
      if (!row) return null;
      if (Number(row.visit_id) !== visitId || Number(row.expected_version) !== expectedVersion || Number(row.check_in_at) !== checkInAt
        || (row.check_out_at === null ? null : Number(row.check_out_at)) !== checkOutAt || row.reason !== reason)
        throw new ApiProblem(409, 'REQUEST_ID_REUSED', 'This correction reference was already used for a different correction.');
      return c.json({ correction: correctionView(row), replayed: true });
    };
    const earlier = await replay();
    if (earlier) return earlier;
    const visit = await db.prepare('SELECT id FROM visits WHERE id = ? AND location_id = ?').bind(visitId, c.var.locationId).first();
    if (!visit) throw new ApiProblem(404, 'VISIT_NOT_FOUND', 'Visit was not found.');
    let inserted: Row | undefined;
    try {
      const [result] = await db.batch<Row>([
        db.prepare(`INSERT INTO attendance_corrections (request_id, visit_id, expected_version, prior_check_in_at, prior_check_out_at, check_in_at, check_out_at, reason, actor_id, recorded_at)
          SELECT ?, id, ?, check_in_at, check_out_at, ?, ?, ?, ?, ? FROM visits WHERE id = ? AND location_id = ?
          ON CONFLICT (request_id) DO NOTHING RETURNING id`)
          .bind(requestId, expectedVersion, checkInAt, checkOutAt, reason, c.var.actor.id, Date.now(), visitId, c.var.locationId),
      ]);
      inserted = result.results[0];
    } catch (error) {
      const raced = await replay();
      if (raced) return raced;
      throw error;
    }
    if (!inserted) {
      const raced = await replay();
      if (raced) return raced;
      throw new ApiProblem(500, 'CORRECTION_NOT_CONFIRMED', 'The correction could not be confirmed. Retry with the same request.');
    }
    const [correction, updated] = await db.batch<Row>([lookup, db.prepare(`${visitSelect} WHERE v.id = ?`).bind(visitId)]);
    return c.json({ correction: correctionView(correction.results[0]), visit: visitView(updated.results[0]), replayed: false }, 201);
  });

  app.get('/history', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const range = await historyRange(c);
    const { page, pageSize, offset } = pagination(c);
    const studentId = c.req.query('studentId') ? idValue(c.req.query('studentId'), 'studentId') : null;
    const where = 'v.location_id = ?1 AND v.check_in_at >= ?2 AND v.check_in_at < ?3 AND (?4 IS NULL OR v.student_id = ?4)';
    const args = [c.var.locationId, range.fromMs, range.toMs, studentId];
    const [rows, count] = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare(`${visitSelect} WHERE ${where} ORDER BY v.check_in_at DESC, v.id DESC LIMIT ?5 OFFSET ?6`).bind(...args, pageSize, offset),
      c.env.CRM_DB.prepare(`SELECT count(*) AS n FROM visits v WHERE ${where}`).bind(...args),
    ]);
    return c.json({ items: rows.results.map(visitView), total: Number(count.results[0].n), page, pageSize, range: { from: range.from, to: range.to, timezone: range.timezone } });
  });

  app.get('/reviews', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const rows = await c.env.CRM_DB.prepare(
      `SELECT r.*, e.reason, s.first_name || ' ' || s.last_name AS student_name FROM reviews r
       JOIN attendance_events e ON e.id = r.event_id JOIN students s ON s.id = r.student_id
       WHERE r.location_id = ? AND r.status = 'pending' ORDER BY r.created_at LIMIT 251`,
    ).bind(c.var.locationId).all<Row>();
    const items: Review[] = rows.results.slice(0, 250).map(r => ({
      id: Number(r.id), eventId: Number(r.event_id), visitId: r.visit_id === null ? null : Number(r.visit_id), studentId: Number(r.student_id),
      studentName: String(r.student_name), reason: String(r.reason ?? ''), status: r.status as Review['status'], createdAt: isoRequired(r.created_at),
      resolvedAt: iso(r.resolved_at), resolution: (r.resolution as string | null) ?? null,
    }));
    return c.json({ items, truncated: rows.results.length > 250 });
  });

  app.post('/reviews/:id/resolve', async c => {
    requireAdmin(c); requireRole(c, managementRoles);
    const resolution = textValue((await body(c)).resolution, 'resolution', 2000);
    if (resolution.length < 5) throw new ApiProblem(400, 'REASON_REQUIRED', 'Provide a meaningful review resolution.');
    const db = c.env.CRM_DB;
    const review = await db.prepare('SELECT * FROM reviews WHERE id = ? AND location_id = ?').bind(paramId(c), c.var.locationId).first<Row>();
    if (!review) throw new ApiProblem(404, 'REVIEW_NOT_FOUND', 'Review was not found.');
    const [updated] = await db.batch<Row>([
      db.prepare("UPDATE reviews SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND status = 'pending' RETURNING id")
        .bind(Date.now(), c.var.actor.id, resolution, review.id),
      db.prepare("UPDATE visits SET review = 'resolved' WHERE id = ? AND review = 'pending' AND changes() = 1").bind(review.visit_id),
    ]);
    if (!updated.results.length) throw new ApiProblem(409, 'REVIEW_RESOLVED', 'This review was already resolved.');
    await audit(c, 'review_resolved', 'review', Number(review.id), { resolution }, c.var.locationId).run();
    return c.json({ ok: true });
  });

  return app;
}
