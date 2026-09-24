import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { AuditEntry } from '../shared/types';
import { historyRange } from './attendance';
import { ApiProblem, managementRoles, requireAdmin, requireRole, type Row } from './util';

const PAGE = 50;
const toIso = (column: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} / 1000.0, 'unixepoch')`;

export const auditReaderRouter = new Hono<AppEnv>();

/**
 * One timeline of administrative changes, attendance observations and
 * corrections for the selected location. Owners also see business-wide
 * changes such as staff and backup settings.
 */
auditReaderRouter.get('/audit', async c => {
  requireAdmin(c); requireRole(c, managementRoles);
  const range = await historyRange(c);
  const cursor = Number(c.req.query('cursor') || 0);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > 100000) throw new ApiProblem(400, 'INVALID_CURSOR', 'Use the cursor from the previous page.');
  const includeBusiness = c.var.actor.role === 'owner' ? 1 : 0;
  const rows = await c.env.CRM_DB.prepare(`SELECT * FROM (
      SELECT 'admin:' || a.id AS key, a.actor_name, a.action, a.entity_type, a.entity_id, a.created_at AS recorded_at, a.detail, 'admin' AS source
      FROM audit_entries a
      WHERE (a.location_id = ?1 OR (a.location_id IS NULL AND ?4 = 1)) AND a.created_at >= ${toIso('?2')} AND a.created_at < ${toIso('?3')}
      UNION ALL
      SELECT 'event:' || e.id, st.display_name, e.action, 'student', CAST(e.student_id AS TEXT), ${toIso('e.received_at')},
        json_object('observedAt', ${toIso('e.observed_at')}, 'channel', iif(e.device_id IS NULL, 'admin', 'kiosk'), 'reason', e.reason, 'guardianId', e.guardian_id),
        'attendance'
      FROM attendance_events e JOIN staff st ON st.id = e.actor_id
      WHERE e.location_id = ?1 AND e.observed_at >= ?2 AND e.observed_at < ?3
      UNION ALL
      SELECT 'correction:' || ac.id, st.display_name, 'attendance_correction', 'visit', CAST(ac.visit_id AS TEXT), ${toIso('ac.recorded_at')},
        json_object('reason', ac.reason, 'priorCheckInAt', ${toIso('ac.prior_check_in_at')}, 'priorCheckOutAt', ${toIso('ac.prior_check_out_at')},
          'checkInAt', ${toIso('ac.check_in_at')}, 'checkOutAt', ${toIso('ac.check_out_at')}),
        'correction'
      FROM attendance_corrections ac JOIN visits v ON v.id = ac.visit_id JOIN staff st ON st.id = ac.actor_id
      WHERE v.location_id = ?1 AND ac.recorded_at >= ?2 AND ac.recorded_at < ?3
    ) ORDER BY recorded_at DESC, key DESC LIMIT ?5 OFFSET ?6`)
    .bind(c.var.locationId, range.fromMs, range.toMs, includeBusiness, PAGE + 1, cursor).all<Row>();
  const items: AuditEntry[] = rows.results.slice(0, PAGE).map(row => ({
    key: String(row.key), actorName: String(row.actor_name), action: String(row.action), entityType: String(row.entity_type),
    entityId: String(row.entity_id), recordedAt: String(row.recorded_at), detail: String(row.detail), source: row.source as AuditEntry['source'],
  }));
  return c.json({ items, nextCursor: rows.results.length > PAGE ? String(cursor + PAGE) : null, range: { from: range.from, to: range.to, timezone: range.timezone } });
});
