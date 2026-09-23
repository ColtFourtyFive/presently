import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { AttendanceEvent, AttendanceResult } from '../shared/types';
import { decodeAttendanceReceipt } from './attendance-receipt';
import { archiveReceiptStorage } from './archive-receipt-storage';
import { ApiProblem, attendanceRoles, body, centerId, dateValue, id, managementRoles, now, requireRole, sha256, textValue, uuidValue } from './util';
import { correctionView, visitSelect, visitView } from './records';
import { attendanceVisitDetail } from './archive-visit-history';
import { touchOperator } from './auth';
import { historyEvidenceUnavailable, requireRequestHash, requireSealedEvent, resolveHistoryRequest, type HistoryRequest } from './history-request';

function eventView(row: Record<string, unknown>): AttendanceEvent { return { id: String(row.id), studentId: String(row.student_id), visitId: row.visit_id as string | null, action: row.action as AttendanceEvent['action'], observedAt: String(row.observed_at), receivedAt: String(row.received_at), actorId: String(row.actor_id), actorName: String(row.actor_name), channel: row.channel as AttendanceEvent['channel'], guardianId: row.guardian_id as string | null, reason: row.reason as string | null }; }
function resultView(row: Record<string, unknown>, replayed: boolean): AttendanceResult { return { event: eventView(row), visit: decodeAttendanceReceipt({ visit_id: row.visit_id, student_id: row.student_id, action: row.action, observed_at: row.observed_at, result_visit: row.result_visit }), replayed }; }
export function createAttendanceRouter() {
  const app = new Hono<AppEnv>();
  app.post('/attendance', async c => {
    requireRole(c, attendanceRoles); const input = await body(c); const eventId = uuidValue(input.eventId, 'eventId'); const studentId = uuidValue(input.studentId, 'studentId'); const action = textValue(input.action, 'action', 30); if (!['check_in', 'check_out', 'exceptional_departure'].includes(action)) throw new ApiProblem(400, 'INVALID_ACTION', 'Choose an explicit arrival or departure action.');
    const observedAt = dateValue(input.observedAt, 'observedAt'); const receivedAt = now(); const guardianId = input.guardianId ? uuidValue(input.guardianId, 'guardianId') : null; const reason = input.reason ? textValue(input.reason, 'reason', 2000) : null;
    if (action === 'check_in' && (guardianId || reason)) throw new ApiProblem(400, 'INVALID_INPUT', 'Arrival does not accept pickup guardian or departure reason.');
    if (action === 'exceptional_departure' && (!reason || reason.length < 5)) throw new ApiProblem(400, 'REASON_REQUIRED', 'Record the observed circumstances of the exceptional departure.');
    const payloadHash = await sha256(JSON.stringify({ studentId, action, observedAt, guardianId, reason }));
    const lookup: HistoryRequest = { id: eventId, centerId: centerId(c), kind: 'event', payloadHash };
    const archiveStorage = archiveReceiptStorage(c.env);
    const existing = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
    if (existing) return c.json(resultView(existing, true));
    if (Date.parse(observedAt) > Date.now() + 60000 || Date.parse(observedAt) < Date.now() - 24 * 3600000) throw new ApiProblem(400, 'OBSERVATION_OUT_OF_RANGE', 'Observation time must be within the past 24 hours and no more than one minute ahead. Use a manager correction for older records.');
    const nonce = id();
    let result: D1Result<Record<string, unknown>>[];
    try {
      result = await c.env.CRM_DB.batch<Record<string, unknown>>([
      c.env.CRM_DB.prepare(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce)
        VALUES(?,?,?,CASE WHEN ?='check_in' THEN ? ELSE (SELECT id FROM visits WHERE student_id=? AND center_id=? AND check_out_at IS NULL) END,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(eventId, centerId(c), studentId, action, `visit-${eventId}`, studentId, centerId(c), action, observedAt, receivedAt, c.var.actor.id, c.var.actor.displayName, c.var.actor.channel, c.var.actor.deviceId || null, guardianId, reason, payloadHash, nonce),
      c.env.CRM_DB.prepare('SELECT * FROM attendance_events WHERE id=? AND center_id=?').bind(eventId, centerId(c)),
      ]);
    } catch (error) {
      // A competing acceptance or archive move may win after the initial read.
      // Resolve once; never retry the mutation under a fresh request ID.
      const replay = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
      if (replay) return c.json(resultView(replay, true));
      throw error;
    }
    const row = result[1].results[0];
    if (!row) throw historyEvidenceUnavailable();
    requireRequestHash(row, lookup); requireSealedEvent(row);
    if (c.var.actor.channel === 'kiosk') await touchOperator(c);
    return c.json(resultView(row, row.insertion_nonce !== nonce), row.insertion_nonce === nonce ? 201 : 200);
  });
  app.get('/attendance/events/:id', async c => {
    requireRole(c, attendanceRoles);
    const archiveStorage = archiveReceiptStorage(c.env);
    const row = await resolveHistoryRequest(c.env.CRM_DB, { id: c.req.param('id'), centerId: centerId(c), kind: 'event' }, archiveStorage);
    if (!row) throw new ApiProblem(404, 'EVENT_NOT_FOUND', 'This attendance event has not been accepted.');
    return c.json(resultView(row, true));
  });
  app.get('/visits/:id', async c => {
    if (c.var.actor.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace to review this visit.');
    requireRole(c, managementRoles);
    const visit = await c.env.CRM_DB.prepare(`${visitSelect} WHERE v.id=? AND v.center_id=?`).bind(c.req.param('id'), centerId(c)).first();
    if (visit) return c.json({ visit: visitView(visit) });
    const archived = await attendanceVisitDetail(c, c.req.param('id'));
    if (!archived) throw new ApiProblem(404, 'VISIT_NOT_FOUND', 'Visit was not found.');
    return c.json({ visit: archived.visit });
  });
  app.post('/visits/:id/corrections', async c => {
    if (c.var.actor.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace to correct attendance.'); requireRole(c, managementRoles); const input = await body(c); const correctionId = uuidValue(input.correctionId, 'correctionId'); const expectedVersion = Number(input.expectedVersion); if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new ApiProblem(400, 'INVALID_VERSION', 'Provide the version of the visit you reviewed.');
    const checkInAt = dateValue(input.checkInAt, 'checkInAt'); const checkOutAt = input.checkOutAt === null ? null : dateValue(input.checkOutAt, 'checkOutAt'); const reason = textValue(input.reason, 'reason', 2000); if (reason.length < 5) throw new ApiProblem(400, 'REASON_REQUIRED', 'Record why the attendance needs correction.'); const visitId = c.req.param('id');
    const hash = await sha256(JSON.stringify({ visitId, expectedVersion, checkInAt, checkOutAt, reason }));
    const lookup: HistoryRequest = { id: correctionId, centerId: centerId(c), kind: 'correction', payloadHash: hash };
    const archiveStorage = archiveReceiptStorage(c.env);
    const existing = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
    if (existing) return c.json({ correction: correctionView(existing), replayed: true });
    const liveVisit = await c.env.CRM_DB.prepare(
      'SELECT id FROM visits WHERE id=? AND center_id=?',
    ).bind(visitId, centerId(c)).first();
    if (!liveVisit) {
      // The live visit lookup can race an archive move after the first request
      // snapshot. Recheck permanent request ownership before requiring visit
      // detail so an accepted retry stays replayable even when only its
      // correction receipt is available in an older archive generation.
      const archivedReplay = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
      if (archivedReplay) return c.json({ correction: correctionView(archivedReplay), replayed: true });
      const archived = await attendanceVisitDetail(c, visitId);
      if (!archived) throw new ApiProblem(404, 'VISIT_NOT_FOUND', 'Visit was not found.');
      const recordedAt = now();
      let archivedResult: D1Result<Record<string, unknown>>[];
      try {
        archivedResult = await c.env.CRM_DB.batch<Record<string, unknown>>([
          c.env.CRM_DB.prepare(
            `INSERT INTO history_correction_outbox(
               id,center_id,visit_id,student_id,expected_version,
               prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,
               reason,actor_id,actor_name,recorded_at,payload_hash,
               original_check_in_at,original_check_out_at,check_in_by,check_out_by,
               guardian_id,departure_type,review_status,resulting_version
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO NOTHING RETURNING id`,
          ).bind(
            correctionId, centerId(c), visitId, archived.row.student_id, expectedVersion,
            archived.row.check_in_at, archived.row.check_out_at, checkInAt, checkOutAt,
            reason, c.var.actor.id, c.var.actor.displayName, recordedAt, hash,
            archived.row.original_check_in_at, archived.row.original_check_out_at,
            archived.row.check_in_by, archived.row.check_out_by, archived.row.guardian_id,
            archived.row.departure_type, archived.row.review_status, expectedVersion + 1,
          ),
          c.env.CRM_DB.prepare(
            'SELECT * FROM attendance_correction_records WHERE id=? AND center_id=?',
          ).bind(correctionId, centerId(c)),
        ]);
      } catch (error) {
        const replay = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
        if (replay) return c.json({ correction: correctionView(replay), replayed: true });
        throw error;
      }
      const row = archivedResult[1].results[0];
      if (!row) {
        const replay = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
        if (replay) return c.json({ correction: correctionView(replay), replayed: true });
        throw historyEvidenceUnavailable();
      }
      if (!archivedResult[0].results.length) {
        const replay = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
        if (replay) return c.json({ correction: correctionView(replay), replayed: true });
        throw historyEvidenceUnavailable();
      }
      return c.json({
        correction: correctionView(row),
        visit: {
          ...archived.visit,
          checkInAt,
          checkOutAt,
          version: expectedVersion + 1,
        },
        replayed: false,
      }, 201);
    }
    let result: D1Result<Record<string, unknown>>[];
    try {
      result = await c.env.CRM_DB.batch<Record<string, unknown>>([
      c.env.CRM_DB.prepare('INSERT INTO attendance_corrections(id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash) SELECT ?,center_id,id,?,check_in_at,check_out_at,?,?,?,?,?,?,? FROM visits WHERE id=? AND center_id=? ON CONFLICT(id) DO NOTHING RETURNING id').bind(correctionId, expectedVersion, checkInAt, checkOutAt, reason, c.var.actor.id, c.var.actor.displayName, now(), hash, visitId, centerId(c)),
      c.env.CRM_DB.prepare('SELECT * FROM attendance_corrections WHERE id=? AND center_id=?').bind(correctionId, centerId(c)),
      c.env.CRM_DB.prepare(`${visitSelect} WHERE v.id=? AND v.center_id=?`).bind(visitId, centerId(c)),
      ]);
    } catch (error) {
      const replay = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
      if (replay) return c.json({ correction: correctionView(replay), replayed: true });
      throw error;
    }
    const row = result[1].results[0];
    if (!row) {
      const replay = await resolveHistoryRequest(c.env.CRM_DB, lookup, archiveStorage);
      if (replay) return c.json({ correction: correctionView(replay), replayed: true });
      throw new ApiProblem(404, 'VISIT_NOT_FOUND', 'Visit was not found.');
    }
    requireRequestHash(row, lookup);
    // Trigger work can increment meta.changes even when the insert is ignored.
    if (!result[0].results.length) return c.json({ correction: correctionView(row), replayed: true });
    const visit = result[2].results[0];
    if (!visit) throw historyEvidenceUnavailable();
    return c.json({ correction: correctionView(row), visit: visitView(visit), replayed: false }, 201);
  });
  return app;
}
