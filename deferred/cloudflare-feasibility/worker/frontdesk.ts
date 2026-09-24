import { Hono } from 'hono';
import type { AppEnv } from './types';
import { getCenter, localMidnight } from './records';
import { ApiProblem, attendanceRoles, centerId, now, requireRole } from './util';
import { frontDeskViews, type DailyObservation, type DepartedStudent, type FrontDeskCounts, type FrontDeskDay, type FrontDeskResponse, type FrontDeskStudent, type FrontDeskView, type PlannedStudent } from '../shared/frontdesk';
import type { FollowUpTask } from '../shared/inquiries';

type Row = Record<string, unknown>;
export function frontDeskDay(timezone: string, asOf = now()): FrontDeskDay {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(asOf)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`, calendar = new Date(`${date}T00:00:00.000Z`);
  const tomorrow = new Date(calendar.getTime() + 86400000).toISOString().slice(0, 10);
  return { date, dayOfWeek: calendar.getUTCDay(), fromISO: localMidnight(date, timezone), toISO: localMidnight(tomorrow, timezone), timezone, asOf };
}
const rosterCtes = `WITH scope AS (SELECT ? AS center_id,? AS weekday,? AS from_at,? AS to_at),
 expected AS (
  SELECT s.id AS student_id,s.first_name||' '||s.last_name AS student_name,s.student_code,s.active,
   min(sc.start_time) AS first_lesson_time,count(sc.id) AS lesson_count,group_concat(DISTINCT sc.subject) AS subjects
  FROM schedules sc JOIN students s ON s.id=sc.student_id AND s.center_id=sc.center_id JOIN scope q ON q.center_id=sc.center_id
  WHERE sc.active=1 AND sc.day_of_week=q.weekday AND s.active=1
   AND EXISTS(SELECT 1 FROM json_each(s.subjects) WHERE value=sc.subject)
  GROUP BY s.id
 ), arrivals AS MATERIALIZED (
  SELECT DISTINCT v.student_id FROM visits v JOIN scope q ON q.center_id=v.center_id WHERE v.check_in_at>=q.from_at AND v.check_in_at<q.to_at
 ), observed AS MATERIALIZED (
 SELECT DISTINCT e.student_id FROM attendance_events e JOIN scope q ON q.center_id=e.center_id
 WHERE (e.visit_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM observation_effective_times p WHERE p.event_id=e.id))
 AND e.observed_at>=q.from_at AND e.observed_at<q.to_at
 UNION
 SELECT DISTINCT e.student_id FROM observation_effective_times p
 JOIN scope q ON q.center_id=p.center_id JOIN attendance_events e ON e.id=p.event_id
 WHERE p.effective_observed_at>=q.from_at AND p.effective_observed_at<q.to_at
 ), open_visits AS MATERIALIZED (
  SELECT v.student_id,v.review_status FROM visits v JOIN scope q ON q.center_id=v.center_id WHERE v.check_out_at IS NULL
 ), planned AS (
  SELECT e.*,a.student_id IS NOT NULL AS arrival_recorded,o.student_id IS NOT NULL AS observation_recorded,
   v.student_id IS NOT NULL AS open_visit_recorded,coalesce(v.review_status='pending',0) AS open_visit_needs_review
  FROM expected e LEFT JOIN arrivals a ON a.student_id=e.student_id LEFT JOIN observed o ON o.student_id=e.student_id LEFT JOIN open_visits v ON v.student_id=e.student_id
 ), departures AS (
 SELECT v.student_id,v.check_out_at AS departed_at,0 AS unmatched,v.review_status='pending' AS needs_review
 FROM visits v JOIN scope q ON q.center_id=v.center_id WHERE v.check_out_at>=q.from_at AND v.check_out_at<q.to_at
 UNION ALL
 SELECT e.student_id,p.effective_observed_at,1,
 NOT EXISTS(SELECT 1 FROM reviews r WHERE r.center_id=e.center_id AND r.event_id=e.id AND r.status='resolved')
 OR EXISTS(SELECT 1 FROM reviews r WHERE r.center_id=e.center_id AND r.event_id=e.id AND r.status='pending')
 FROM observation_effective_times p JOIN scope q ON q.center_id=p.center_id JOIN attendance_events e ON e.id=p.event_id
 WHERE e.visit_id IS NULL AND e.action!='check_in' AND p.effective_observed_at>=q.from_at AND p.effective_observed_at<q.to_at
 UNION ALL
 SELECT e.student_id,e.observed_at,1,
 NOT EXISTS(SELECT 1 FROM reviews r WHERE r.center_id=e.center_id AND r.event_id=e.id AND r.status='resolved')
 OR EXISTS(SELECT 1 FROM reviews r WHERE r.center_id=e.center_id AND r.event_id=e.id AND r.status='pending')
 FROM attendance_events e JOIN scope q ON q.center_id=e.center_id
 WHERE e.visit_id IS NULL AND e.action!='check_in'
 AND NOT EXISTS(SELECT 1 FROM observation_effective_times p WHERE p.event_id=e.id)
 AND e.observed_at>=q.from_at AND e.observed_at<q.to_at
 ), departed AS (
  SELECT s.id AS student_id,s.first_name||' '||s.last_name AS student_name,s.student_code,s.active,
   max(d.departed_at) AS last_departure_at,count(*) AS departure_count,max(d.unmatched) AS includes_unmatched,max(d.needs_review) AS needs_review
  FROM departures d JOIN students s ON s.id=d.student_id JOIN scope q ON q.center_id=s.center_id LEFT JOIN open_visits v ON v.student_id=s.id
  WHERE v.student_id IS NULL GROUP BY s.id
 )`;
const awaiting = 'arrival_recorded=0 AND observation_recorded=0 AND open_visit_recorded=0';
const rosterCounts = `${rosterCtes} SELECT
 (SELECT count(*) FROM planned) AS expected_students,
 (SELECT coalesce(sum(lesson_count),0) FROM planned) AS expected_lessons,
 (SELECT count(*) FROM planned WHERE ${awaiting}) AS awaiting_students,
 (SELECT count(*) FROM schedules sc JOIN students s ON s.id=sc.student_id AND s.center_id=sc.center_id JOIN scope q ON q.center_id=sc.center_id WHERE sc.active=1 AND sc.day_of_week=q.weekday AND s.active=0) AS excluded_inactive_lessons,
 (SELECT count(*) FROM schedules sc JOIN students s ON s.id=sc.student_id AND s.center_id=sc.center_id JOIN scope q ON q.center_id=sc.center_id WHERE sc.active=1 AND sc.day_of_week=q.weekday AND s.active=1 AND NOT EXISTS(SELECT 1 FROM json_each(s.subjects) WHERE value=sc.subject)) AS excluded_subject_lessons`;
const studentView = (row: Row): FrontDeskStudent => ({ studentId: String(row.student_id), studentName: String(row.student_name), studentCode: String(row.student_code), active: !!row.active });
const plannedView = (row: Row): PlannedStudent => ({ ...studentView(row), firstLessonTime: String(row.first_lesson_time), lessonCount: Number(row.lesson_count), subjects: String(row.subjects).split(',').sort(), arrivalRecorded: !!row.arrival_recorded, observationRecorded: !!row.observation_recorded, openVisitRecorded: !!row.open_visit_recorded, openVisitNeedsReview: !!row.open_visit_needs_review });
const departedView = (row: Row): DepartedStudent => ({ ...studentView(row), lastDepartureAt: String(row.last_departure_at), departureCount: Number(row.departure_count), includesUnmatched: !!row.includes_unmatched, needsReview: !!row.needs_review });

/** Native SQL counts and LIMIT/OFFSET keep every response bounded. Read only. */
export async function readFrontDeskPage(db: D1Database, center: string, day: FrontDeskDay, view: FrontDeskView, page: number, pageSize: number): Promise<FrontDeskResponse> {
  if (!frontDeskViews.includes(view) || !Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50)
    throw new ApiProblem(400, 'INVALID_PAGE', 'Choose a valid view, positive page, and page size from 1 to 50.');
  const offset = (page - 1) * pageSize, timezone = db.prepare('SELECT timezone FROM centers WHERE id=?').bind(center);
  const base = { view, day, page, pageSize };
  if (view === 'expected' || view === 'awaiting' || view === 'departed') {
    const args = [center, day.dayOfWeek, day.fromISO, day.toISO];
    const selected = view === 'departed' ? 'departed' : 'planned';
    const order = view === 'departed' ? 'last_departure_at DESC,student_id' : 'first_lesson_time,student_name,student_id';
    const results = await db.batch<Row>([
      db.prepare(`${rosterCtes} SELECT * FROM ${selected}${view === 'awaiting' ? ` WHERE ${awaiting}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, pageSize, offset),
      db.prepare(view === 'departed' ? `${rosterCtes} SELECT count(*) AS n FROM departed` : rosterCounts).bind(...args), timezone,
    ]);
    checkTimezone(results[2].results[0], day);
    const row = results[1].results[0];
    if (view === 'departed') return { ...base, items: results[0].results.map(departedView), total: Number(row.n) };
    const counts: FrontDeskCounts = { expectedStudents: Number(row.expected_students), expectedLessons: Number(row.expected_lessons), awaitingStudents: Number(row.awaiting_students), excludedInactiveLessons: Number(row.excluded_inactive_lessons), excludedSubjectLessons: Number(row.excluded_subject_lessons) };
    return { ...base, items: results[0].results.map(plannedView), counts, total: view === 'awaiting' ? counts.awaitingStudents : counts.expectedStudents };
  }
  if (view === 'observations') {
    const where = `e.center_id=? AND (CASE WHEN e.visit_id IS NULL THEN coalesce(p.effective_observed_at,e.observed_at) ELSE e.observed_at END)>=? AND (CASE WHEN e.visit_id IS NULL THEN coalesce(p.effective_observed_at,e.observed_at) ELSE e.observed_at END)<?`, args = [center, day.fromISO, day.toISO];
    const results = await db.batch<Row>([
      db.prepare(`SELECT e.id,e.student_id,e.action,e.observed_at AS original_observed_at,
 (CASE WHEN e.visit_id IS NULL THEN coalesce(p.effective_observed_at,e.observed_at) ELSE e.observed_at END) AS observed_at,
 coalesce(p.version,1) AS observation_version,e.received_at,e.actor_name,e.channel,e.visit_id,
 s.first_name||' '||s.last_name AS student_name,s.student_code,s.active
 FROM attendance_events e JOIN students s ON s.id=e.student_id AND s.center_id=e.center_id
 LEFT JOIN observation_effective_times p ON p.event_id=e.id
 WHERE ${where} ORDER BY observed_at DESC,e.id DESC LIMIT ? OFFSET ?`).bind(...args, pageSize, offset),
      db.prepare(`SELECT count(*) AS n FROM attendance_events e LEFT JOIN observation_effective_times p ON p.event_id=e.id WHERE ${where}`).bind(...args), timezone,
    ]);
    checkTimezone(results[2].results[0], day);
    const items: DailyObservation[] = results[0].results.map(row => ({ ...studentView(row), id: String(row.id), action: row.action as DailyObservation['action'], observedAt: String(row.observed_at), originalObservedAt: String(row.original_observed_at), observationVersion: Number(row.observation_version), receivedAt: String(row.received_at), actorName: String(row.actor_name), channel: row.channel as DailyObservation['channel'], unmatched: row.visit_id == null }));
    return { ...base, items, total: Number(results[1].results[0].n) };
  }
  const results = await db.batch<Row>([
    db.prepare('SELECT id,title,detail,due_at,type,inquiry_id FROM tasks WHERE center_id=? AND completed_at IS NULL AND due_at<? ORDER BY due_at,id LIMIT ? OFFSET ?').bind(center, day.toISO, pageSize, offset),
    db.prepare('SELECT count(*) AS n FROM tasks WHERE center_id=? AND completed_at IS NULL AND due_at<?').bind(center, day.toISO), timezone,
  ]);
  checkTimezone(results[2].results[0], day);
  const items: FollowUpTask[] = results[0].results.map(row => ({ id: String(row.id), title: String(row.title), detail: String(row.detail), dueAt: String(row.due_at), type: row.type as FollowUpTask['type'], inquiryId: row.inquiry_id as string | null, completedAt: null }));
  return { ...base, items, total: Number(results[1].results[0].n) };
}
function checkTimezone(row: Row | undefined, day: FrontDeskDay) {
  if (row?.timezone !== day.timezone) throw new ApiProblem(409, 'DAY_CHANGED', 'The center timezone changed. Refresh the front desk.');
}
export const frontdeskRouter = new Hono<AppEnv>();
frontdeskRouter.get('/frontdesk/today', async c => {
  if (c.var.actor?.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace.');
  requireRole(c, attendanceRoles);
  const view = c.req.query('view') || 'expected', page = Number(c.req.query('page') || 1), pageSize = Number(c.req.query('pageSize') || 25);
  if (!frontDeskViews.includes(view as FrontDeskView)) throw new ApiProblem(400, 'INVALID_VIEW', 'Choose a valid front-desk view.');
  const center = await getCenter(c), day = frontDeskDay(center.timezone);
  return c.json(await readFrontDeskPage(c.env.CRM_DB, centerId(c), day, view as FrontDeskView, page, pageSize));
});
