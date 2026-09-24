import type { Context } from 'hono';
import type { ReportRange } from '../shared/attendance-report';
import type { AppEnv } from './types';
import { archiveReceiptStorage } from './archive-receipt-storage';
import {
  ArchiveRangeUnavailableError,
  assertArchiveRangeAuthority,
  readArchiveRange,
  type ArchiveRangeQuery,
} from './archive-range-reader';
import { ApiProblem, centerId } from './util';

type Row = Record<string, unknown>;

type Pagination = {
  page: number;
  pageSize: number;
  offset: number;
};

export type AttendanceEventView = {
  id: string;
  studentId: string;
  visitId: string | null;
  action: unknown;
  observedAt: string;
  receivedAt: string;
  actorId: string;
  actorName: string;
  channel: unknown;
  guardianId: string | null;
  reason: string | null;
  effectiveObservedAt: string;
  observationVersion: number;
  observationCorrections: Record<string, unknown>[];
  studentName?: string;
  studentCode?: string;
};

const eventView = (row: Row): AttendanceEventView => ({
  id: String(row.id),
  studentId: String(row.student_id),
  visitId: row.visit_id === null ? null : String(row.visit_id),
  action: row.action,
  observedAt: String(row.observed_at),
  receivedAt: String(row.received_at),
  actorId: String(row.actor_id),
  actorName: String(row.actor_name),
  channel: row.channel,
  guardianId: row.guardian_id === null ? null : String(row.guardian_id),
  reason: row.reason === null ? null : String(row.reason),
  effectiveObservedAt: String(row.effective_observed_at ?? row.observed_at),
  observationVersion: Number(row.observation_version ?? 1),
  observationCorrections: (() => {
    try {
      const value = JSON.parse(String(row.observation_corrections_json ?? '[]'));
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  })(),
  ...(row.student_name === undefined ? {} : { studentName: String(row.student_name) }),
  ...(row.student_code === undefined ? {} : { studentCode: String(row.student_code) }),
});

function archiveProblem(error: unknown): never {
  if (
    error instanceof ArchiveRangeUnavailableError &&
    ['publication-limit', 'object-limit', 'record-limit'].includes(error.reason)
  ) {
    throw new ApiProblem(
      422,
      'HISTORY_RANGE_TOO_LARGE',
      'Choose a shorter date range for archived attendance.',
    );
  }
  throw new ApiProblem(
    503,
    'HISTORY_EVIDENCE_UNAVAILABLE',
    'Archived attendance cannot be verified right now. Try again before using these records.',
  );
}

const liveOnly = `NOT EXISTS(
  SELECT 1 FROM archive_compact_requests q
  JOIN archive_compact_availability a ON a.publication_id=q.publication_id
  JOIN history_runtime h ON h.id=1 AND h.generation=a.generation AND h.state='ready'
  WHERE q.request_id=e.id AND a.status='ready'
)`;

export async function attendanceEventHistory(
  c: Context<AppEnv>,
  range: ReportRange,
  pagination: Pagination,
  studentId: string,
) {
  const center = centerId(c);
  const archiveQuery: ArchiveRangeQuery = {
    centerId: center,
    timezone: range.timezone,
    fromISO: range.fromISO,
    toISO: range.toISO,
    scope: 'observed',
    tables: ['attendance_events'],
  };
  let archive;
  try {
    archive = await readArchiveRange(
      c.env.CRM_DB,
      archiveReceiptStorage(c.env),
      archiveQuery,
    );
  } catch (error) {
    return archiveProblem(error);
  }

  const archived = archive.records
    .map(record => record.row as Row)
    .filter(row =>
      row.center_id === center &&
      typeof row.observed_at === 'string' &&
      row.observed_at >= range.fromISO &&
      row.observed_at < range.toISO &&
      (!studentId || row.student_id === studentId));
  const where = `e.center_id=? AND e.observed_at>=? AND e.observed_at<?\n    AND (?='' OR e.student_id=?) AND ${liveOnly}`;
  const args = [center, range.fromISO, range.toISO, studentId, studentId];
  // At most archived.length rows can precede a live row in the merged order.
  // Skip the live prefix that cannot reach this page and keep the materialized
  // merge bounded by the authenticated archive cap plus one page.
  const liveOffset = Math.max(0, pagination.offset - archived.length);
  const liveLimit = archived.length + pagination.pageSize;
  const results = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(
      `SELECT e.*,p.effective_observed_at,p.version AS observation_version,
        coalesce((SELECT json_group_array(json_object(
          'id',c.id,'eventId',c.event_id,
          'priorEffectiveObservedAt',c.prior_effective_observed_at,
          'effectiveObservedAt',c.effective_observed_at,
          'expectedVersion',c.expected_version,'resultingVersion',c.resulting_version,
          'reason',c.reason,'actorId',c.actor_id,'actorName',c.actor_name,'recordedAt',c.recorded_at
        )) FROM observation_corrections c WHERE c.event_id=e.id ORDER BY c.resulting_version,c.id),'[]') AS observation_corrections_json,
        s.student_code,s.first_name||' '||s.last_name AS student_name
      FROM attendance_events e
      JOIN students s ON s.id=e.student_id AND s.center_id=e.center_id
      LEFT JOIN observation_effective_times p ON p.event_id=e.id
      WHERE ${where}
      ORDER BY e.observed_at DESC,e.id LIMIT ? OFFSET ?`,
    ).bind(...args, liveLimit, liveOffset),
    c.env.CRM_DB.prepare(
      `SELECT count(*) AS n FROM attendance_events e WHERE ${where}`,
    ).bind(...args),
  ]);

  const live = results[0].results;
  const seen = new Set<string>();
  for (const row of [...live, ...archived]) {
    const key = String(row.id);
    if (seen.has(key)) {
      throw new ApiProblem(
        503,
        'HISTORY_EVIDENCE_UNAVAILABLE',
        'Attendance history contains overlapping live and archived authority.',
      );
    }
    seen.add(key);
  }

  const items = [...live, ...archived]
    .sort((left, right) => {
      const byTime = String(right.observed_at).localeCompare(String(left.observed_at));
      return byTime || String(left.id).localeCompare(String(right.id));
    })
    .slice(
      pagination.offset - liveOffset,
      pagination.offset - liveOffset + pagination.pageSize,
    )
    .map(eventView);

  try {
    await assertArchiveRangeAuthority(c.env.CRM_DB, archiveQuery, archive.authoritySha256);
  } catch (error) {
    return archiveProblem(error);
  }

  return {
    items,
    total: Number(results[1].results[0]?.n || 0) + archived.length,
    page: pagination.page,
    pageSize: pagination.pageSize,
    ...range,
  };
}
