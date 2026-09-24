import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { ReportRange } from '../shared/attendance-report';
import type { AttendanceDay, AttendanceSummary } from '../shared/report-summary';
import { historyRange, localMidnight } from './records';
import { ApiProblem, centerId, managementRoles, now, requireRole } from './util';

/** At most 366 calendar days. UTC boundaries vary across daylight saving time. */
export function attendanceDayBoundaries(range: ReportRange) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: range.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const offset = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86400000).toISOString().slice(0, 10);
  const count = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
  if (!Number.isInteger(count) || count < 1 || count > 366) throw new ApiProblem(400, 'INVALID_RANGE', 'Choose a date range of at most 366 days.');
  let start = range.fromISO;
  return Array.from({ length: count }, (_, index) => {
    const date = offset(range.from, index), end = index === count - 1 ? range.toISO : localMidnight(offset(date, 1), range.timezone, formatter);
    const value = { date, start, end }; start = end; return value;
  });
}

export const reportSummaryRouter = new Hono<AppEnv>();
reportSummaryRouter.get('/reports/attendance/summary', async c => {
  if (c.var.actor?.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace.');
  requireRole(c, managementRoles);
  const range = await historyRange(c), boundaries = attendanceDayBoundaries(range), db = c.env.CRM_DB, center = centerId(c);
  // Aggregate in SQL. Only one row per local day leaves D1; no visit/identity
  // collection is loaded into the Worker or browser to calculate these metrics.
  const result = await db.batch<Record<string, unknown>>([
    db.prepare(`WITH days AS (SELECT json_extract(value,'$.date') AS date,json_extract(value,'$.start') AS start,json_extract(value,'$.end') AS end FROM json_each(?))
      SELECT d.date,count(v.id) AS visits,count(DISTINCT v.student_id) AS students,
       sum(CASE WHEN v.check_out_at IS NOT NULL THEN 1 ELSE 0 END) AS closed_visits,
       sum(CASE WHEN v.check_out_at IS NOT NULL AND v.review_status!='pending' THEN 1 ELSE 0 END) AS verified_closed_visits,
       sum(CASE WHEN v.review_status='pending' THEN 1 ELSE 0 END) AS pending_review_visits,
       coalesce(sum(CASE WHEN v.check_out_at IS NOT NULL AND v.review_status!='pending' THEN max(0,(julianday(v.check_out_at)-julianday(v.check_in_at))*1440) ELSE 0 END),0) AS verified_minutes
      FROM days d LEFT JOIN visits v ON v.center_id=? AND v.check_in_at>=d.start AND v.check_in_at<d.end
      GROUP BY d.date ORDER BY d.date`).bind(JSON.stringify(boundaries), center),
    db.prepare('SELECT count(DISTINCT student_id) AS students FROM visits WHERE center_id=? AND check_in_at>=? AND check_in_at<?').bind(center, range.fromISO, range.toISO),
    db.prepare(`SELECT sum(active=1) AS active_students,sum(active=0) AS inactive_students,
       coalesce(sum(active=1 AND EXISTS(SELECT 1 FROM json_each(students.subjects) WHERE value='Math')),0) AS math,
       coalesce(sum(active=1 AND EXISTS(SELECT 1 FROM json_each(students.subjects) WHERE value='Reading')),0) AS reading,
       coalesce(sum(active=1 AND EXISTS(SELECT 1 FROM json_each(students.subjects) WHERE value='Math') AND EXISTS(SELECT 1 FROM json_each(students.subjects) WHERE value='Reading')),0) AS both
      FROM students WHERE center_id=?`).bind(center),
    db.prepare('SELECT timezone FROM centers WHERE id=?').bind(center),
  ]);
  if (result[3].results[0]?.timezone !== range.timezone) throw new ApiProblem(409, 'REPORT_CHANGED', 'The center timezone changed. Refresh the report.');
  const days: AttendanceDay[] = result[0].results.map(row => ({ date: String(row.date), visits: Number(row.visits), students: Number(row.students), closedVisits: Number(row.closed_visits), verifiedClosedVisits: Number(row.verified_closed_visits), pendingReviewVisits: Number(row.pending_review_visits), verifiedMinutes: Number(row.verified_minutes) }));
  const totals = days.reduce((sum, day) => ({ visits: sum.visits + day.visits, closedVisits: sum.closedVisits + day.closedVisits, verifiedClosedVisits: sum.verifiedClosedVisits + day.verifiedClosedVisits, pendingReviewVisits: sum.pendingReviewVisits + day.pendingReviewVisits, verifiedMinutes: sum.verifiedMinutes + day.verifiedMinutes }), { visits: 0, closedVisits: 0, verifiedClosedVisits: 0, pendingReviewVisits: 0, verifiedMinutes: 0 });
  const enrollment = result[2].results[0];
  const summary: AttendanceSummary = { range, asOf: now(), days,
    totals: { ...totals, uniqueStudents: Number(result[1].results[0].students), averageVerifiedMinutes: totals.verifiedClosedVisits ? totals.verifiedMinutes / totals.verifiedClosedVisits : null },
    enrollment: { activeStudents: Number(enrollment.active_students || 0), inactiveStudents: Number(enrollment.inactive_students || 0), math: Number(enrollment.math), reading: Number(enrollment.reading), both: Number(enrollment.both) } };
  return c.json(summary);
});
