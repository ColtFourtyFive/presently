import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { AttendanceDay, AttendanceSummary } from '../shared/types';
import { REQUIREMENTS, type EvidenceItem, type EvidenceReport, type RequirementNumber } from '../shared/evidence';
import { getBusiness, getLocation } from './admin';
import { historyRange } from './attendance';
import { correctionView, visitSelect, visitView } from './records';
import {
  ApiProblem, addDays, audit, body, idValue, localMidnight, localParts, managementRoles, now, requireAdmin, requireRole,
  textValue, type Ctx, type Row,
} from './util';

/** Arrivals and departures recorded more than this long after they were observed count as late entries. */
const LATE_ENTRY_MS = 5 * 60000;
const EXPORT_PAGE = 500;

function dayBoundaries(from: string, to: string, timezone: string) {
  const count = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(from, i);
    return { date, start: localMidnight(date, timezone), end: localMidnight(addDays(date, 1), timezone) };
  });
}

export const reportsRouter = new Hono<AppEnv>();

/** One page of visits with their corrections. The browser assembles the CSV so large exports never run in one Worker invocation. */
reportsRouter.get('/reports/attendance', async c => {
  requireAdmin(c); requireRole(c, managementRoles);
  const range = await historyRange(c);
  const page = Number(c.req.query('page') || 1);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApiProblem(400, 'INVALID_PAGE', 'Choose a positive export page.');
  const db = c.env.CRM_DB;
  const studentId = c.req.query('studentId') ? idValue(c.req.query('studentId'), 'studentId') : null;
  const where = 'v.location_id = ?1 AND v.check_in_at >= ?2 AND v.check_in_at < ?3 AND (?4 IS NULL OR v.student_id = ?4)';
  const args = [c.var.locationId, range.fromMs, range.toMs, studentId];
  const [rows, count] = await db.batch<Row>([
    db.prepare(`${visitSelect} WHERE ${where} ORDER BY v.check_in_at, v.id LIMIT ?5 OFFSET ?6`).bind(...args, EXPORT_PAGE, (page - 1) * EXPORT_PAGE),
    db.prepare(`SELECT count(*) AS n FROM visits v WHERE ${where}`).bind(...args),
  ]);
  const ids = rows.results.map(row => Number(row.id));
  const corrections = ids.length
    ? await db.prepare('SELECT ac.*, st.display_name AS actor_name FROM attendance_corrections ac JOIN staff st ON st.id = ac.actor_id WHERE ac.visit_id IN (SELECT value FROM json_each(?)) ORDER BY ac.recorded_at, ac.id')
      .bind(JSON.stringify(ids)).all<Row>()
    : { results: [] as Row[] };
  const total = Number(count.results[0].n);
  if (page === 1) await audit(c, 'attendance_exported', 'report', `${range.from}..${range.to}`, { from: range.from, to: range.to, studentId, visits: total }, c.var.locationId).run();
  return c.json({
    range: { from: range.from, to: range.to, timezone: range.timezone }, page, pageSize: EXPORT_PAGE, total,
    visits: rows.results.map(visitView), corrections: corrections.results.map(correctionView), exportedAt: now(), exportedBy: c.var.actor.displayName,
  });
});

reportsRouter.get('/reports/attendance/summary', async c => {
  requireAdmin(c); requireRole(c, managementRoles);
  const range = await historyRange(c);
  const db = c.env.CRM_DB;
  const location = c.var.locationId;
  // Aggregate in SQL so only one row per local day leaves D1.
  const [days, unique, enrollment] = await db.batch<Row>([
    db.prepare(`WITH days AS (SELECT json_extract(value, '$.date') AS date, json_extract(value, '$.start') AS start, json_extract(value, '$.end') AS end FROM json_each(?))
      SELECT d.date, count(v.id) AS visits, count(DISTINCT v.student_id) AS students,
        coalesce(sum(v.check_out_at IS NOT NULL), 0) AS closed_visits,
        coalesce(sum(v.check_out_at IS NOT NULL AND v.review != 'pending'), 0) AS verified_closed_visits,
        coalesce(sum(v.review = 'pending'), 0) AS pending_review_visits,
        coalesce(sum(iif(v.check_out_at IS NOT NULL AND v.review != 'pending', (v.check_out_at - v.check_in_at) / 60000.0, 0)), 0) AS verified_minutes
      FROM days d LEFT JOIN visits v ON v.location_id = ? AND v.check_in_at >= d.start AND v.check_in_at < d.end
      GROUP BY d.date ORDER BY d.date`).bind(JSON.stringify(dayBoundaries(range.from, range.to, range.timezone)), location),
    db.prepare('SELECT count(DISTINCT student_id) AS students FROM visits WHERE location_id = ? AND check_in_at >= ? AND check_in_at < ?').bind(location, range.fromMs, range.toMs),
    db.prepare(`SELECT coalesce(sum(active = 1), 0) AS active_students, coalesce(sum(active = 0), 0) AS inactive_students,
        coalesce(sum(active = 1 AND EXISTS (SELECT 1 FROM json_each(students.subjects) WHERE value = 'Math')), 0) AS math,
        coalesce(sum(active = 1 AND EXISTS (SELECT 1 FROM json_each(students.subjects) WHERE value = 'Reading')), 0) AS reading,
        coalesce(sum(active = 1 AND EXISTS (SELECT 1 FROM json_each(students.subjects) WHERE value = 'Math') AND EXISTS (SELECT 1 FROM json_each(students.subjects) WHERE value = 'Reading')), 0) AS both
      FROM students WHERE location_id = ?`).bind(location),
  ]);
  const dayRows: AttendanceDay[] = days.results.map(row => ({
    date: String(row.date), visits: Number(row.visits), students: Number(row.students), closedVisits: Number(row.closed_visits),
    verifiedClosedVisits: Number(row.verified_closed_visits), pendingReviewVisits: Number(row.pending_review_visits), verifiedMinutes: Number(row.verified_minutes),
  }));
  const totals = dayRows.reduce((sum, day) => ({
    visits: sum.visits + day.visits, closedVisits: sum.closedVisits + day.closedVisits, verifiedClosedVisits: sum.verifiedClosedVisits + day.verifiedClosedVisits,
    pendingReviewVisits: sum.pendingReviewVisits + day.pendingReviewVisits, verifiedMinutes: sum.verifiedMinutes + day.verifiedMinutes,
  }), { visits: 0, closedVisits: 0, verifiedClosedVisits: 0, pendingReviewVisits: 0, verifiedMinutes: 0 });
  const e = enrollment.results[0];
  const summary: AttendanceSummary = {
    range: { from: range.from, to: range.to, timezone: range.timezone }, asOf: now(), days: dayRows,
    totals: { ...totals, uniqueStudents: Number(unique.results[0].students), averageVerifiedMinutes: totals.verifiedClosedVisits ? totals.verifiedMinutes / totals.verifiedClosedVisits : null },
    enrollment: { activeStudents: Number(e.active_students), inactiveStudents: Number(e.inactive_students), math: Number(e.math), reading: Number(e.reading), both: Number(e.both) },
  };
  return c.json(summary);
});

const count = (n: unknown) => Number(n).toLocaleString('en-US');
const formatDate = (ms: unknown, timezone: string) => (ms === null || ms === undefined ? 'None' : localParts(Number(ms), timezone).date);

async function evidenceReport(c: Ctx, year: number): Promise<EvidenceReport> {
  const [location, business] = await Promise.all([getLocation(c), getBusiness(c)]);
  const tz = location.timezone;
  const from = `${year}-01-01`;
  const currentYear = localParts(Date.now(), tz).year;
  const to = year === currentYear ? localParts(Date.now(), tz).date : `${year}-12-31`;
  const start = localMidnight(from, tz);
  const end = localMidnight(addDays(to, 1), tz);
  const since30 = Date.now() - 30 * 86400000;
  const db = c.env.CRM_DB;
  const id = location.id;
  const results = await db.batch<Row>([
    /* 0 */ db.prepare(`SELECT count(*) AS events, coalesce(sum(received_at - observed_at > ?), 0) AS late, count(DISTINCT actor_id) AS recorders,
        min(observed_at) AS first_at, max(observed_at) AS last_at,
        count(DISTINCT date(observed_at / 1000, 'unixepoch')) AS days, coalesce(sum(device_id IS NOT NULL), 0) AS kiosk_events
        FROM attendance_events WHERE location_id = ? AND observed_at >= ? AND observed_at < ?`).bind(LATE_ENTRY_MS, id, start, end),
    /* 1 */ db.prepare(`SELECT count(*) AS students, coalesce(sum(active = 1), 0) AS active,
        coalesce(sum(trim(student_code) = ''), 0) AS missing_code FROM students WHERE location_id = ?`).bind(id),
    /* 2 */ db.prepare(`SELECT count(*) AS corrections, count(DISTINCT ac.visit_id) AS visits FROM attendance_corrections ac JOIN visits v ON v.id = ac.visit_id
        WHERE v.location_id = ? AND ac.recorded_at >= ? AND ac.recorded_at < ?`).bind(id, start, end),
    /* 3 */ db.prepare(`SELECT count(*) AS staff, coalesce(sum(kiosk_enabled = 1 AND pin_hash IS NOT NULL), 0) AS kiosk,
        coalesce(sum(role IN ('owner', 'manager')), 0) AS managers FROM staff s
        WHERE active = 1 AND role IN ('owner', 'manager', 'front_desk')
          AND (role = 'owner' OR EXISTS (SELECT 1 FROM staff_locations sl WHERE sl.staff_id = s.id AND sl.location_id = ?))`).bind(id),
    /* 4 */ db.prepare('SELECT count(*) AS present FROM visits WHERE location_id = ? AND check_out_at IS NULL').bind(id),
    /* 5 */ db.prepare(`SELECT max(completed_at) AS last_complete, coalesce(sum(status = 'complete' AND completed_at >= ?), 0) AS recent,
        coalesce(sum(status = 'failed' AND created_at >= ?), 0) AS failed FROM backup_jobs`).bind(new Date(since30).toISOString(), new Date(since30).toISOString()),
    /* 6 */ db.prepare(`SELECT count(*) AS devices FROM kiosk_devices WHERE location_id = ? AND revoked_at IS NULL AND expires_at > ?`).bind(id, now()),
    /* 7 */ db.prepare(`SELECT min(observed_at) AS earliest, count(*) AS total, coalesce(sum(observed_at < ?), 0) AS older_than_two_years
        FROM attendance_events WHERE location_id = ?`).bind(Date.now() - 730 * 86400000, id),
    /* 8 */ db.prepare(`SELECT a.requirement, a.confirmed, a.note, a.attested_at, st.display_name FROM attestations a JOIN staff st ON st.id = a.attested_by
        WHERE a.location_id = ? AND a.year = ? AND a.id IN (SELECT max(id) FROM attestations WHERE location_id = ? AND year = ? GROUP BY requirement)`).bind(id, year, id, year),
    /* 9 */ db.prepare(`SELECT count(*) AS open_reviews FROM reviews WHERE location_id = ? AND status = 'pending'`).bind(id),
  ]);
  const [events, students, corrections, staff, present, backups, devices, retention, , reviews] = results.map(r => r.results[0] ?? {});
  const attested = new Map(results[8].results.map(row => [Number(row.requirement), {
    confirmed: !!row.confirmed, note: String(row.note), attestedBy: String(row.display_name), attestedAt: String(row.attested_at),
  }]));
  const backupEnabled = c.env.BACKUP_ENABLED === 'true';
  const lastBackup = backups.last_complete ? String(backups.last_complete) : null;
  const backupFresh = !!lastBackup && Date.now() - Date.parse(lastBackup) < 26 * 3600000;
  const lateShare = Number(events.events) ? Math.round((Number(events.late) / Number(events.events)) * 1000) / 10 : 0;

  const items: Omit<EvidenceItem, 'attestation'>[] = [
    { number: 1, status: Number(events.events) > 0 ? 'met' : 'attention',
      facts: [
        { label: 'Arrivals and departures recorded', value: count(events.events) },
        { label: 'Days with recorded attendance', value: count(events.days) },
        { label: 'First and last record in period', value: `${formatDate(events.first_at, tz)} to ${formatDate(events.last_at, tz)}` },
        { label: 'Recorded on an enrolled kiosk', value: count(events.kiosk_events) },
      ],
      attention: Number(events.events) ? [] : ['No attendance has been recorded for this location in the period.'] },
    { number: 2, status: Number(students.missing_code) === 0 && Number(students.active) > 0 ? 'met' : 'attention',
      facts: [
        { label: 'Active students', value: count(students.active) },
        { label: 'Students on file', value: count(students.students) },
        { label: 'Student codes', value: 'Required and unique within the location (enforced by the database)' },
      ],
      attention: Number(students.active) ? [] : ['No active students are on the roster.'] },
    { number: 3, status: lateShare <= 5 ? 'met' : 'attention',
      facts: [
        { label: 'Observation time rule', value: 'Entries must be recorded within 24 hours of the observation and cannot be in the future' },
        { label: `Recorded more than ${LATE_ENTRY_MS / 60000} minutes after the observation`, value: `${count(events.late)} (${lateShare}%)` },
        { label: 'Manager corrections, each with a written reason', value: `${count(corrections.corrections)} across ${count(corrections.visits)} visits` },
        { label: 'Original observations', value: 'Kept unchanged; corrections are stored separately' },
      ],
      attention: lateShare > 5 ? ['More than 5% of entries were recorded well after the observation. Review front-desk practice.'] : [] },
    { number: 4, status: Number(staff.staff) > 0 ? 'met' : 'attention',
      facts: [
        { label: 'Active staff who can record attendance', value: count(staff.staff) },
        { label: 'Staff with an individual kiosk PIN', value: count(staff.kiosk) },
        { label: 'Distinct staff who recorded attendance in the period', value: count(events.recorders) },
        { label: 'Attribution', value: 'Every entry records the staff member who made it' },
      ],
      attention: Number(staff.staff) ? [] : ['No active staff are assigned to record attendance here.'] },
    { number: 5, status: 'met',
      facts: [
        { label: 'Students present right now', value: count(present.present) },
        { label: 'Live roster', value: 'Available on the kiosk and in the back office' },
        { label: 'Attendance history', value: 'Searchable by date range and student, exportable to CSV' },
        { label: 'Departures awaiting manager review', value: count(reviews.open_reviews) },
      ],
      attention: Number(reviews.open_reviews) ? [`${count(reviews.open_reviews)} exceptional departures still need manager review.`] : [] },
    { number: 6, status: backupEnabled && backupFresh ? 'met' : 'attention',
      facts: [
        { label: 'Nightly encrypted backups', value: backupEnabled ? 'Enabled' : 'Not enabled' },
        { label: 'Last completed backup', value: lastBackup ? lastBackup.slice(0, 16).replace('T', ' ') + ' UTC' : 'None' },
        { label: 'Completed backups in the last 30 days', value: count(backups.recent) },
        { label: 'Failed backups in the last 30 days', value: count(backups.failed) },
      ],
      attention: [
        ...(!backupEnabled ? ['Enable nightly backups in Settings.'] : []),
        ...(backupEnabled && !backupFresh ? ['No backup has completed in the last 26 hours.'] : []),
      ] },
    { number: 7, status: 'met',
      facts: [
        { label: 'Student information collected', value: 'Name, student code, grade, subjects, pickup notes' },
        { label: 'Guardian information collected', value: 'Name, relationship, phone, email, pickup authority' },
        { label: 'Shared kiosk', value: 'Shows pickup authority only; no guardian phone numbers or email addresses' },
        { label: 'Back-office sign-in', value: 'Named staff accounts through Cloudflare Access; kiosks lock after 15 minutes' },
        { label: 'Enrolled kiosks at this location', value: count(devices.devices) },
      ],
      attention: [] },
    { number: 8, status: 'met',
      facts: [
        { label: 'Earliest attendance record', value: formatDate(retention.earliest, tz) },
        { label: 'Attendance records kept', value: count(retention.total) },
        { label: 'Records older than two years still kept', value: count(retention.older_than_two_years) },
        { label: 'Deletion', value: 'Attendance and corrections cannot be edited or deleted; nothing is removed automatically' },
      ],
      attention: [] },
  ];
  return {
    year, generatedAt: now(), generatedBy: c.var.actor.displayName, business: business.name,
    location: { id: location.id, name: location.name, timezone: tz, address: location.address }, period: { from, to },
    items: items.map(item => ({ ...item, attestation: attested.get(item.number) ?? null })),
  };
}

reportsRouter.get('/evidence', async c => {
  requireAdmin(c); requireRole(c, managementRoles);
  const year = Number(c.req.query('year') || new Date().getUTCFullYear());
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new ApiProblem(400, 'INVALID_YEAR', 'Choose a valid year.');
  return c.json(await evidenceReport(c, year));
});

reportsRouter.post('/attestations', async c => {
  requireAdmin(c); requireRole(c, managementRoles);
  const input = await body(c);
  const requirement = Number(input.requirement);
  if (!REQUIREMENTS.some(r => r.number === requirement)) throw new ApiProblem(400, 'INVALID_REQUIREMENT', 'Choose a requirement from 1 to 8.');
  const year = Number(input.year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new ApiProblem(400, 'INVALID_YEAR', 'Choose a valid year.');
  if (typeof input.confirmed !== 'boolean') throw new ApiProblem(400, 'INVALID_INPUT', 'confirmed must be true or false.');
  const note = textValue(input.note ?? '', 'note', 1000, false);
  const at = now();
  await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare('INSERT INTO attestations (location_id, requirement, year, confirmed, note, attested_by, attested_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(c.var.locationId, requirement, year, input.confirmed ? 1 : 0, note, c.var.actor.id, at),
    audit(c, 'attestation_recorded', 'attestation', `${year}:${requirement}`, { requirement, year, confirmed: input.confirmed }, c.var.locationId),
  ]);
  return c.json({ attestation: { requirement: requirement as RequirementNumber, confirmed: input.confirmed, note, attestedBy: c.var.actor.displayName, attestedAt: at } }, 201);
});
