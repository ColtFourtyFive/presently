import type { Context } from 'hono';
import type { ReportRange } from '../shared/attendance-report';
import type { VisitSummary } from '../shared/types';
import type { AppEnv } from './types';
import { archiveReceiptStorage } from './archive-receipt-storage';
import {
  ArchiveRangeUnavailableError,
  assertArchiveRangeAuthority,
  readArchiveRange,
  type ArchiveRangeQuery,
  type ArchiveRangeResult,
} from './archive-range-reader';
import { ApiProblem, centerId } from './util';

type Row = Record<string, unknown>;
type Pagination = { page: number; pageSize: number; offset: number };

const liveVisitSelect = `SELECT v.*,s.first_name||' '||s.last_name AS student_name,
  s.student_code,s.active,si.display_name AS in_name,so.display_name AS out_name,
  g.display_name AS guardian_name
  FROM visits v
  JOIN students s ON s.id=v.student_id
  JOIN staff si ON si.id=v.check_in_by
  LEFT JOIN staff so ON so.id=v.check_out_by
  LEFT JOIN guardians g ON g.id=v.guardian_id`;

const headSelect = `SELECT h.*,s.first_name||' '||s.last_name AS student_name,
  s.student_code,s.active
  FROM history_visit_heads h JOIN students s ON s.id=h.student_id`;

function problem(error: unknown): never {
  if (
    error instanceof ArchiveRangeUnavailableError &&
    ['publication-limit', 'object-limit', 'record-limit'].includes(error.reason)
  ) {
    throw new ApiProblem(
      422,
      'HISTORY_RANGE_TOO_LARGE',
      'Choose a shorter date range so every archived visit can be verified.',
    );
  }
  throw new ApiProblem(
    503,
    'HISTORY_EVIDENCE_UNAVAILABLE',
    'Archived visit details cannot be verified right now. This is not an empty history result.',
  );
}

function query(c: Context<AppEnv>, range: ReportRange): ArchiveRangeQuery {
  return {
    centerId: centerId(c),
    timezone: range.timezone,
    fromISO: range.fromISO,
    toISO: range.toISO,
    scope: 'visit-effective',
    tables: ['visits'],
  };
}

function same(left: unknown, right: unknown): boolean {
  return left === right;
}

function liveMatchesHead(live: Row, head: Row, center: string): boolean {
  return (
    live.id === head.visit_id &&
    live.center_id === center &&
    live.student_id === head.student_id &&
    same(live.original_check_in_at, head.original_check_in_at) &&
    same(live.original_check_out_at, head.original_check_out_at) &&
    same(live.check_in_at, head.check_in_at) &&
    same(live.check_out_at, head.check_out_at) &&
    same(live.version, head.version) &&
    same(live.review_status, head.review_status)
  );
}

function archiveMatchesHead(archived: Row, head: Row, center: string): boolean {
  return (
    archived.id === head.visit_id &&
    archived.center_id === center &&
    archived.student_id === head.student_id &&
    same(archived.original_check_in_at, head.original_check_in_at) &&
    same(archived.original_check_out_at, head.original_check_out_at) &&
    same(archived.check_in_at, head.check_in_at) &&
    same(archived.check_out_at, head.check_out_at) &&
    same(archived.version, head.version) &&
    same(archived.review_status, head.review_status)
  );
}

function view(
  head: Row,
  detail: Row,
  names?: { staff: Map<string, string>; guardians: Map<string, string> },
): VisitSummary {
  const row = combinedRow(head, detail, names);
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

function combinedRow(
  head: Row,
  detail: Row,
  names?: { staff: Map<string, string>; guardians: Map<string, string> },
): Row {
  const checkInBy = names
    ? names.staff.get(String(detail.check_in_by))
    : String(detail.in_name);
  const checkOutBy = detail.check_out_by === null
    ? null
    : names
      ? names.staff.get(String(detail.check_out_by))
      : String(detail.out_name);
  const guardianName = detail.guardian_id === null
    ? null
    : names
      ? names.guardians.get(String(detail.guardian_id))
      : String(detail.guardian_name);
  if (!checkInBy || (detail.check_out_by !== null && !checkOutBy) || (detail.guardian_id !== null && !guardianName)) {
    throw new ApiProblem(
      503,
      'HISTORY_EVIDENCE_UNAVAILABLE',
      'A retained visit references profile data that is unavailable.',
    );
  }
  return {
    ...detail,
    id: head.visit_id,
    student_id: head.student_id,
    student_name: head.student_name,
    student_code: head.student_code,
    active: !!head.active,
    check_in_at: head.check_in_at,
    check_out_at: head.check_out_at,
    original_check_in_at: head.original_check_in_at,
    original_check_out_at: head.original_check_out_at,
    in_name: checkInBy,
    out_name: checkOutBy ?? null,
    guardian_name: guardianName ?? null,
    review_status: head.review_status,
    version: Number(head.version),
  };
}

async function readArchive(
  c: Context<AppEnv>,
  range: ReportRange,
): Promise<ArchiveRangeResult> {
  try {
    return await readArchiveRange(
      c.env.CRM_DB,
      archiveReceiptStorage(c.env),
      query(c, range),
    );
  } catch (error) {
    return problem(error);
  }
}

export async function attendanceVisitHistory(
  c: Context<AppEnv>,
  range: ReportRange,
  pagination: Pagination,
  studentId: string,
) {
  const center = centerId(c);
  const where = "h.center_id=? AND h.check_in_at>=? AND h.check_in_at<? AND (?='' OR h.student_id=?)";
  const args = [center, range.fromISO, range.toISO, studentId, studentId];
  const initial = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(
      `${headSelect} WHERE ${where} ORDER BY h.check_in_at DESC,h.visit_id LIMIT ? OFFSET ?`,
    ).bind(...args, pagination.pageSize, pagination.offset),
    c.env.CRM_DB.prepare(
      `SELECT count(*) AS n FROM history_visit_heads h WHERE ${where}`,
    ).bind(...args),
  ]);
  const heads = initial[0].results;
  const total = Number(initial[1].results[0]?.n ?? 0);
  if (!heads.length) {
    return { items: [], total, page: pagination.page, pageSize: pagination.pageSize, ...range };
  }

  const rows = await verifiedVisitRows(c, range, heads);
  const items = rows.map((row, index) => view(heads[index], row));

  const final = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(
      `${headSelect} WHERE ${where} ORDER BY h.check_in_at DESC,h.visit_id LIMIT ? OFFSET ?`,
    ).bind(...args, pagination.pageSize, pagination.offset),
    c.env.CRM_DB.prepare(
      `SELECT count(*) AS n FROM history_visit_heads h WHERE ${where}`,
    ).bind(...args),
  ]);
  if (
    JSON.stringify(final[0].results) !== JSON.stringify(heads) ||
    Number(final[1].results[0]?.n ?? 0) !== total
  ) {
    return problem(new Error('visit-authority-changed'));
  }
  return { items, total, page: pagination.page, pageSize: pagination.pageSize, ...range };
}

export async function verifiedVisitRows(
  c: Context<AppEnv>,
  range: ReportRange,
  heads: Row[],
  suppliedArchive?: ArchiveRangeResult,
): Promise<Row[]> {
  if (!heads.length) return [];
  const center = centerId(c);
  const ids = heads.map(row => String(row.visit_id));
  const selected = JSON.stringify(ids);
  const source = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(
      `${liveVisitSelect} WHERE v.center_id=? AND v.id IN (SELECT value FROM json_each(?))`,
    ).bind(center, selected),
    c.env.CRM_DB.prepare(
      `SELECT c.visit_id AS id,c.center_id,c.student_id,
              c.original_check_in_at,c.original_check_out_at,
              c.check_in_at,c.check_out_at,c.check_in_by,c.check_out_by,
              c.guardian_id,c.departure_type,c.review_status,
              c.resulting_version AS version
       FROM history_correction_outbox c
       WHERE c.center_id=? AND c.visit_id IN (SELECT value FROM json_each(?))
         AND c.resulting_version=(
           SELECT max(latest.resulting_version)
           FROM history_correction_outbox latest
           WHERE latest.center_id=c.center_id AND latest.visit_id=c.visit_id
         )`,
    ).bind(center, selected),
  ]);
  const liveById = new Map(source[0].results.map(row => [String(row.id), row]));
  const outboxById = new Map(source[1].results.map(row => [String(row.id), row]));
  for (const head of heads) {
    const row = liveById.get(String(head.visit_id));
    if (row && !liveMatchesHead(row, head, center)) return problem(new Error('live-head'));
    const outbox = outboxById.get(String(head.visit_id));
    if (row && outbox) return problem(new Error('duplicate-live-visit-authority'));
    if (outbox && !archiveMatchesHead(outbox, head, center)) {
      return problem(new Error('outbox-head'));
    }
  }

  const missing = heads.filter(head => {
    const id = String(head.visit_id);
    return !liveById.has(id) && !outboxById.has(id);
  });
  let archive: ArchiveRangeResult | null = suppliedArchive ?? null;
  const archivedById = new Map<string, Row>();
  let archivedNames: { staff: Map<string, string>; guardians: Map<string, string> } | undefined;
  if (missing.length) {
    archive ??= await readArchive(c, range);
    for (const record of archive.records) {
      if (record.table !== 'visits') continue;
      archivedById.set(record.key, record.row as Row);
    }
    const details = missing.map(head => archivedById.get(String(head.visit_id)));
    if (details.some((row, index) => !row || !archiveMatchesHead(row, missing[index], center))) {
      return problem(new Error('archive-head'));
    }
  }
  const detached = heads
    .map(head => outboxById.get(String(head.visit_id)) ?? archivedById.get(String(head.visit_id)))
    .filter((row): row is Row => !!row);
  if (detached.length) {
    const staffIds = [...new Set(detached.flatMap(row => [row.check_in_by, row.check_out_by])
      .filter((value): value is string => typeof value === 'string'))];
    const guardianIds = [...new Set(detached.map(row => row.guardian_id)
      .filter((value): value is string => typeof value === 'string'))];
    const dimensions = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare(
        'SELECT id,display_name FROM staff WHERE center_id=? AND id IN (SELECT value FROM json_each(?))',
      ).bind(center, JSON.stringify(staffIds)),
      c.env.CRM_DB.prepare(
        'SELECT id,display_name FROM guardians WHERE center_id=? AND id IN (SELECT value FROM json_each(?))',
      ).bind(center, JSON.stringify(guardianIds)),
    ]);
    archivedNames = {
      staff: new Map(dimensions[0].results.map(row => [String(row.id), String(row.display_name)])),
      guardians: new Map(dimensions[1].results.map(row => [String(row.id), String(row.display_name)])),
    };
  }

  const rows = heads.map(head => {
    const id = String(head.visit_id);
      const liveRow = liveById.get(id);
      return combinedRow(
        head,
        liveRow ?? outboxById.get(id) ?? archivedById.get(id)!,
        liveRow ? undefined : archivedNames,
      );
    });
  if (archive) {
    try {
      await assertArchiveRangeAuthority(c.env.CRM_DB, query(c, range), archive.authoritySha256);
    } catch (error) {
      return problem(error);
    }
  }
  return rows;
}

export async function attendanceVisitDetail(
  c: Context<AppEnv>,
  visitId: string,
): Promise<{ row: Row; visit: VisitSummary } | null> {
  const center = centerId(c);
  const state = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare(`${headSelect} WHERE h.center_id=? AND h.visit_id=?`)
      .bind(center, visitId),
    c.env.CRM_DB.prepare('SELECT timezone FROM centers WHERE id=?').bind(center),
    c.env.CRM_DB.prepare('SELECT state FROM history_runtime WHERE id=1'),
  ]);
  const head = state[0].results[0];
  if (!head) return null;
  if (state[2].results[0]?.state !== 'ready') return problem(new Error('history-runtime'));
  const timezone = state[1].results[0]?.timezone;
  const at = String(head.check_in_at);
  const upper = Date.parse(at);
  if (typeof timezone !== 'string' || !timezone || !Number.isFinite(upper)) {
    return problem(new Error('visit-time'));
  }
  const range: ReportRange = {
    from: at.slice(0, 10),
    to: at.slice(0, 10),
    fromISO: at,
    toISO: new Date(upper + 1).toISOString(),
    timezone,
  };
  const row = (await verifiedVisitRows(c, range, [head]))[0];
  return { row, visit: view(head, row) };
}
