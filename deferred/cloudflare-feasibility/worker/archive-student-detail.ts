import type { Context } from 'hono';
import type { ReportRange } from '../shared/attendance-report';
import type { Correction, VisitSummary } from '../shared/types';
import { archiveReceiptStorage } from './archive-receipt-storage';
import {
  ArchiveRangeUnavailableError,
  assertArchiveRangeAuthority,
  readArchiveRange,
  type ArchiveRangeQuery,
  type ArchiveRangeResult,
} from './archive-range-reader';
import { verifiedVisitRows } from './archive-visit-history';
import type { AppEnv } from './types';
import { ApiProblem, centerId } from './util';

const VISIT_LIMIT = 20;
const CORRECTION_LIMIT = 100;
type Row = Record<string, unknown>;

const headSelect = `SELECT h.*,s.first_name||' '||s.last_name AS student_name,
  s.student_code,s.active
  FROM history_visit_heads h JOIN students s ON s.id=h.student_id`;

const liveVisitSelect = `SELECT v.*,s.first_name||' '||s.last_name AS student_name,
  s.student_code,s.active,si.display_name AS in_name,so.display_name AS out_name,
  g.display_name AS guardian_name
  FROM visits v
  JOIN students s ON s.id=v.student_id
  JOIN staff si ON si.id=v.check_in_by
  LEFT JOIN staff so ON so.id=v.check_out_by
  LEFT JOIN guardians g ON g.id=v.guardian_id`;

const correctionFields = [
  'id', 'center_id', 'visit_id', 'expected_version', 'prior_check_in_at',
  'prior_check_out_at', 'check_in_at', 'check_out_at', 'reason', 'actor_id',
  'actor_name', 'recorded_at', 'payload_hash',
] as const;

function unavailable(error: unknown): never {
  if (
    error instanceof ArchiveRangeUnavailableError &&
    ['publication-limit', 'object-limit', 'record-limit'].includes(error.reason)
  ) {
    throw new ApiProblem(
      422,
      'HISTORY_RANGE_TOO_LARGE',
      'This profile spans too much archived history. Use attendance history for a shorter date range.',
    );
  }
  throw new ApiProblem(
    503,
    'HISTORY_EVIDENCE_UNAVAILABLE',
    'Recent attendance details cannot be verified right now.',
  );
}

function rangeForHeads(heads: Row[], timezone: string): ReportRange {
  const times = heads.map(row => String(row.check_in_at)).sort();
  const fromISO = times[0];
  const upper = Date.parse(times.at(-1)!);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fromISO) ||
    !Number.isFinite(upper)
  ) return unavailable(new Error('visit-time'));
  const toISO = new Date(upper + 1).toISOString();
  return {
    from: fromISO.slice(0, 10),
    to: times.at(-1)!.slice(0, 10),
    fromISO,
    toISO,
    timezone,
  };
}

function archiveQuery(c: Context<AppEnv>, range: ReportRange): ArchiveRangeQuery {
  return {
    centerId: centerId(c),
    timezone: range.timezone,
    fromISO: range.fromISO,
    toISO: range.toISO,
    scope: 'visit-effective',
    tables: ['visits', 'attendance_corrections'],
  };
}

function correctionMatches(left: Row, right: Row): boolean {
  return correctionFields.every(field => left[field] === right[field]);
}

function correctionView(row: Row): Correction {
  return {
    id: String(row.id),
    visitId: String(row.visit_id),
    priorCheckInAt: String(row.prior_check_in_at),
    priorCheckOutAt: row.prior_check_out_at === null ? null : String(row.prior_check_out_at),
    checkInAt: String(row.check_in_at),
    checkOutAt: row.check_out_at === null ? null : String(row.check_out_at),
    reason: String(row.reason),
    actorName: String(row.actor_name),
    recordedAt: String(row.recorded_at),
  };
}

function visitView(row: Row): VisitSummary {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    studentName: String(row.student_name),
    studentCode: String(row.student_code),
    active: !!row.active,
    checkInAt: String(row.check_in_at),
    checkOutAt: row.check_out_at === null ? null : String(row.check_out_at),
    originalCheckInAt: String(row.original_check_in_at),
    originalCheckOutAt: row.original_check_out_at === null ? null : String(row.original_check_out_at),
    checkInBy: String(row.in_name),
    checkOutBy: row.out_name === null ? null : String(row.out_name),
    guardianName: row.guardian_name === null ? null : String(row.guardian_name),
    departureType: row.departure_type as VisitSummary['departureType'],
    reviewStatus: row.review_status as VisitSummary['reviewStatus'],
    version: Number(row.version),
  };
}

async function archiveEvidence(c: Context<AppEnv>, range: ReportRange): Promise<ArchiveRangeResult> {
  try {
    return await readArchiveRange(
      c.env.CRM_DB,
      archiveReceiptStorage(c.env),
      archiveQuery(c, range),
    );
  } catch (error) {
    return unavailable(error);
  }
}

function correctionSql(): string {
  return `SELECT * FROM attendance_correction_records
    WHERE center_id=? AND id IN (SELECT value FROM json_each(?))
    ORDER BY recorded_at DESC,id LIMIT ${CORRECTION_LIMIT}`;
}

function correctionGapSql(): string {
  return `SELECT (
      EXISTS(
        SELECT 1
        FROM visits v INDEXED BY visits_student_history
        CROSS JOIN attendance_corrections ac INDEXED BY corrections_visit
        LEFT JOIN history_correction_heads ch ON ch.correction_id=ac.id
        WHERE v.center_id=? AND v.student_id=?
          AND ac.center_id=? AND ac.visit_id=v.id
          AND ch.correction_id IS NULL
        LIMIT 1
      ) OR EXISTS(
        SELECT 1
        FROM history_correction_outbox o INDEXED BY history_correction_outbox_student_time
        LEFT JOIN history_correction_heads ch ON ch.correction_id=o.id
        WHERE o.center_id=? AND o.student_id=? AND ch.correction_id IS NULL
        LIMIT 1
      )
    ) AS missing`;
}

const correctionHeadSql = `SELECT ch.*,h.check_in_at AS visit_check_in_at
  FROM history_correction_heads ch
  LEFT JOIN history_visit_heads h ON h.visit_id=ch.visit_id
  WHERE ch.center_id=? AND ch.student_id=?
  ORDER BY ch.recorded_at DESC,ch.correction_id LIMIT ?`;

async function liveStudentDetail(
  c: Context<AppEnv>,
  studentId: string,
): Promise<{ visits: VisitSummary[]; corrections: Correction[] }> {
  const result = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(
      `${liveVisitSelect} WHERE v.center_id=? AND v.student_id=?
       ORDER BY v.check_in_at DESC,v.id LIMIT ?`,
    ).bind(centerId(c), studentId, VISIT_LIMIT),
    c.env.CRM_DB.prepare(
      `SELECT ac.*
         FROM visits v INDEXED BY visits_student_history
         CROSS JOIN attendance_corrections ac INDEXED BY corrections_visit
         WHERE v.center_id=? AND v.student_id=?
           AND ac.center_id=? AND ac.visit_id=v.id
         ORDER BY ac.recorded_at DESC,ac.id LIMIT ?`,
    ).bind(centerId(c), studentId, centerId(c), CORRECTION_LIMIT),
  ]);
  return {
    visits: result[0].results.map(visitView),
    corrections: result[1].results.map(correctionView),
  };
}

export async function studentAttendanceDetail(
  c: Context<AppEnv>,
  studentId: string,
): Promise<{ visits: VisitSummary[]; corrections: Correction[] }> {
  const center = centerId(c);
  const schema = await c.env.CRM_DB.prepare('SELECT max(version) AS version FROM schema_versions')
    .first<number>('version');
  if (!Number.isInteger(schema) || Number(schema) < 30) {
    return liveStudentDetail(c, studentId);
  }
  const runtimeState = await c.env.CRM_DB.prepare('SELECT state FROM history_runtime WHERE id=1')
    .first<string>('state');
  if (runtimeState === 'backfilling') return liveStudentDetail(c, studentId);
  if (runtimeState !== 'ready') return unavailable(new Error('history-runtime'));

  const initial = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(
      `${headSelect} WHERE h.center_id=? AND h.student_id=?
       ORDER BY h.check_in_at DESC,h.visit_id LIMIT ?`,
    ).bind(center, studentId, VISIT_LIMIT),
    c.env.CRM_DB.prepare(correctionHeadSql).bind(center, studentId, CORRECTION_LIMIT),
    c.env.CRM_DB.prepare('SELECT timezone FROM centers WHERE id=?').bind(center),
    c.env.CRM_DB.prepare('SELECT state FROM history_runtime WHERE id=1'),
    c.env.CRM_DB.prepare(
      `SELECT EXISTS(
         SELECT 1 FROM visits v
         LEFT JOIN history_visit_heads h ON h.visit_id=v.id
         WHERE v.center_id=? AND v.student_id=? AND h.visit_id IS NULL
         LIMIT 1
       ) AS missing`,
    ).bind(center, studentId),
    c.env.CRM_DB.prepare(correctionGapSql())
      .bind(center, studentId, center, center, studentId),
  ]);
  const recentHeads = initial[0].results;
  const correctionHeads = initial[1].results;
  const state = initial[3].results[0]?.state;
  if (state === 'backfilling') return liveStudentDetail(c, studentId);
  if (state !== 'ready') return unavailable(new Error('history-runtime'));
  if (
    Number(initial[5].results[0]?.missing ?? 0) !== 0 ||
    correctionHeads.some(row => typeof row.visit_check_in_at !== 'string')
  ) return unavailable(new Error('missing-correction-head'));
  if (Number(initial[4].results[0]?.missing ?? 0) !== 0) {
    return unavailable(new Error('missing-visit-head'));
  }
  if (!recentHeads.length && !correctionHeads.length) return { visits: [], corrections: [] };
  const timezone = initial[2].results[0]?.timezone;
  if (typeof timezone !== 'string' || !timezone) return unavailable(new Error('timezone'));

  const visitIds = [...new Set([
    ...recentHeads.map(row => String(row.visit_id)),
    ...correctionHeads.map(row => String(row.visit_id)),
  ])];
  const allHeads = await c.env.CRM_DB.prepare(
    `${headSelect} WHERE h.center_id=? AND h.student_id=?
     AND h.visit_id IN (SELECT value FROM json_each(?))`,
  ).bind(center, studentId, JSON.stringify(visitIds)).all<Row>();
  if (allHeads.results.length !== visitIds.length) {
    return unavailable(new Error('missing-linked-visit-head'));
  }
  const headsById = new Map(allHeads.results.map(row => [String(row.visit_id), row]));
  const visitHeads = recentHeads.map(row => headsById.get(String(row.visit_id))!);
  const correctionIds = correctionHeads.map(row => String(row.correction_id));
  const initialCorrections = await c.env.CRM_DB.prepare(correctionSql())
    .bind(center, JSON.stringify(correctionIds)).all<Row>();
  const range = rangeForHeads(allHeads.results, timezone);
  const liveVisitCount = await c.env.CRM_DB.prepare(
    `SELECT count(*) AS n FROM visits
     WHERE center_id=? AND id IN (SELECT value FROM json_each(?))`,
  ).bind(center, JSON.stringify(visitIds)).first<number>('n');
  const needsArchive = Number(liveVisitCount ?? 0) !== visitIds.length
    || initialCorrections.results.length !== correctionIds.length;
  const archive = needsArchive ? await archiveEvidence(c, range) : undefined;
  const visits = (await verifiedVisitRows(c, range, visitHeads, archive)).map(visitView);

  const selectedCorrections = new Set(correctionIds);
  const archivedById = new Map(
    (archive?.records ?? [])
      .filter(record =>
        record.table === 'attendance_corrections' && selectedCorrections.has(record.key))
      .map(record => [record.key, record.row as Row]),
  );
  const liveById = new Map(initialCorrections.results.map(row => [String(row.id), row]));
  const correctionRows = correctionHeads.map(head => {
    const id = String(head.correction_id);
    const live = liveById.get(id);
    const archived = archivedById.get(id);
    if (live && archived && !correctionMatches(live, archived)) {
      return unavailable(new Error('correction-mismatch'));
    }
    const row = live ?? archived;
    if (
      !row || row.id !== head.correction_id || row.center_id !== center ||
      row.visit_id !== head.visit_id || row.recorded_at !== head.recorded_at
    ) return unavailable(new Error('correction-head-mismatch'));
    return row;
  });
  const corrections = correctionRows.map(correctionView);

  const final = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(
      `${headSelect} WHERE h.center_id=? AND h.student_id=?
       ORDER BY h.check_in_at DESC,h.visit_id LIMIT ?`,
    ).bind(center, studentId, VISIT_LIMIT),
    c.env.CRM_DB.prepare(correctionHeadSql).bind(center, studentId, CORRECTION_LIMIT),
    c.env.CRM_DB.prepare(correctionSql()).bind(center, JSON.stringify(correctionIds)),
    c.env.CRM_DB.prepare(correctionGapSql())
      .bind(center, studentId, center, center, studentId),
    c.env.CRM_DB.prepare(
      `SELECT EXISTS(
         SELECT 1 FROM visits v
         LEFT JOIN history_visit_heads h ON h.visit_id=v.id
         WHERE v.center_id=? AND v.student_id=? AND h.visit_id IS NULL
         LIMIT 1
       ) AS missing`,
    ).bind(center, studentId),
  ]);
  if (
    JSON.stringify(final[0].results) !== JSON.stringify(recentHeads) ||
    JSON.stringify(final[1].results) !== JSON.stringify(correctionHeads) ||
    JSON.stringify(final[2].results) !== JSON.stringify(initialCorrections.results) ||
    Number(final[3].results[0]?.missing ?? 0) !== 0 ||
    Number(final[4].results[0]?.missing ?? 0) !== 0
  ) return unavailable(new Error('student-attendance-changed'));
  if (archive) {
    try {
      await assertArchiveRangeAuthority(
        c.env.CRM_DB,
        archiveQuery(c, range),
        archive.authoritySha256,
      );
    } catch (error) {
      return unavailable(error);
    }
  }
  return { visits, corrections };
}
