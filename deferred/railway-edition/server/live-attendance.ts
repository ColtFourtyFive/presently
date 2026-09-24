import type { Actor } from './auth.js';
import type { Queryable } from './db.js';
import type { LiveAttendance } from '../shared/types.js';
import { iso, publicRow } from './records.js';

const limit = 1000;

export async function liveAttendance(tx: Queryable, actor: Actor): Promise<LiveAttendance | null> {
  const center = (await tx.query(`SELECT CURRENT_TIMESTAMP AS server_time,
    date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE timezone) AT TIME ZONE timezone AS from_time
    FROM centers WHERE id=$1`, [actor.centerId])).rows[0];
  if (!center) return null;
  const from = iso(center.from_time);
  const args = [actor.centerId, from, limit + 1];
  // Include receipt/correction time so a late arrival or a correction into an
  // earlier day updates an existing historical row as well as today's roster.
  const changedVisits = `SELECT visit_id FROM attendance_events WHERE center_id=$1 AND received_at >= $2
    UNION SELECT e.visit_id FROM attendance_corrections c JOIN attendance_events e
    ON e.center_id=c.center_id AND e.id=c.event_id WHERE c.center_id=$1 AND c.created_at >= $2`;
  const visits = (await tx.query(`SELECT * FROM visits WHERE center_id=$1 AND
    (status='open' OR checked_in_at >= $2 OR checked_out_at >= $2 OR id IN (${changedVisits}))
    ORDER BY checked_in_at DESC,id LIMIT $3`, args)).rows.map(publicRow);
  const events = (await tx.query(`SELECT * FROM attendance_events WHERE center_id=$1 AND
    (occurred_at >= $2 OR received_at >= $2 OR id IN
      (SELECT event_id FROM attendance_corrections WHERE center_id=$1 AND created_at >= $2))
    ORDER BY occurred_at DESC,id LIMIT $3`, args)).rows.map(publicRow);
  const incidents = (await tx.query(`SELECT * FROM incidents WHERE center_id=$1 AND
    (status='open' OR created_at >= $2 OR resolved_at >= $2)
    ORDER BY created_at DESC,id LIMIT $3`, args)).rows.map(publicRow);
  const corrections = ['owner', 'manager'].includes(actor.role)
    ? (await tx.query(`SELECT * FROM attendance_corrections WHERE center_id=$1 AND created_at >= $2
        ORDER BY created_at DESC,id LIMIT $3`, args)).rows.map(publicRow)
    : [];
  const { centerId, ...user } = actor;
  return {
    centerId, user, from, serverTime: iso(center.server_time),
    complete: [visits, events, incidents, corrections].every(rows => rows.length <= limit),
    visits, events, incidents, corrections,
  } as LiveAttendance;
}
