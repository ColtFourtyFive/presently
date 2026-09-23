import type { Context } from 'hono';
import {
  REPORT_LIMITS,
  REPORT_PHASES,
  attendanceCsv,
  compareReportKeys,
  type ReportCounts,
  type ReportEvidence,
  type ReportItem,
  type ReportPage,
  type ReportPhase,
  type ReportRange,
  type ReportRow,
} from '../shared/attendance-report';
import type { ArchiveRecord, ArchiveTable } from '../shared/archive-format';
import { archiveReceiptStorage } from './archive-receipt-storage';
import { verifiedVisitRows } from './archive-visit-history';
import {
  ArchiveRangeUnavailableError,
  assertArchiveRangeAuthority,
  readArchiveRange,
  type ArchiveRangeQuery,
  type ArchiveRangeResult,
  type ArchiveRangeScope,
} from './archive-range-reader';
import { digest } from './backup-crypto';
import type { AppEnv } from './types';
import { ApiProblem, audit, centerId, id, now } from './util';

type PageInput = {
  phase: ReportPhase;
  epoch?: number;
  generation?: string;
  after?: string[];
};

type QueryShape = {
  select: string;
  from: string;
  scope: string;
  order: string[];
  keys: string[];
};

type Row = Record<string, unknown>;

const encoder = new TextEncoder();
const cursor = (value: string[]) => btoa(JSON.stringify(value));

function invalid(): never {
  throw new ApiProblem(
    400,
    'INVALID_REPORT_CURSOR',
    'Restart attendance export. Its page information is invalid.',
  );
}

export function reportPageInput(c: Context<AppEnv>): PageInput {
  const phase = (c.req.query('phase') || 'visits') as ReportPhase;
  if (!(REPORT_PHASES as readonly string[]).includes(phase)) invalid();
  const rawEpoch = c.req.query('epoch');
  const epoch = rawEpoch === undefined ? undefined : Number(rawEpoch);
  if (
    rawEpoch !== undefined &&
    (!/^\d{1,16}$/.test(rawEpoch) || !Number.isSafeInteger(epoch) || epoch! < 0)
  ) invalid();
  const generation = c.req.query('generation');
  if (
    (generation !== undefined && !/^[a-f0-9]{32}$/.test(generation)) ||
    (epoch === undefined) !== (generation === undefined)
  ) invalid();
  const encoded = c.req.query('after');
  let after: string[] | undefined;
  if (encoded !== undefined) {
    if (!encoded || encoded.length > 1024) invalid();
    try {
      after = JSON.parse(atob(encoded)) as string[];
    } catch {
      invalid();
    }
    const length = phase === 'visits' || phase === 'unmatched' ? 2 : 4;
    if (
      !Array.isArray(after) ||
      after.length !== length ||
      after.some((part, index) =>
        typeof part !== 'string' ||
        (index % 2
          ? !/^[A-Za-z0-9_-]{1,100}$/.test(part)
          : !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(part)))
    ) invalid();
  }
  if (epoch === undefined && (phase !== 'visits' || after !== undefined)) invalid();
  return { phase, epoch, generation, after };
}

const archivedClaim = (requestAlias: string) => `NOT EXISTS(
  SELECT 1 FROM archive_compact_requests aq
  JOIN archive_compact_availability aa ON aa.publication_id=aq.publication_id
  JOIN history_runtime ah ON ah.id=1 AND ah.generation=aa.generation AND ah.state='ready'
  WHERE aq.request_id=${requestAlias}.id AND aa.status='ready'
)`;

function queryParts(phase: ReportPhase): QueryShape {
  const visitScope = 'v.center_id=? AND v.check_in_at>=? AND v.check_in_at<?';
  if (phase === 'visits') return {
    select: `SELECT v.id,v.student_id,v.original_check_in_at,v.original_check_out_at,
      v.check_in_at,v.check_out_at,v.departure_type,v.review_status,
      s.student_code,s.first_name||' '||s.last_name AS student_name,
      si.display_name AS in_name,so.display_name AS out_name,g.display_name AS guardian_name`,
    from: `FROM visits v JOIN students s ON s.id=v.student_id
      JOIN staff si ON si.id=v.check_in_by
      LEFT JOIN staff so ON so.id=v.check_out_by
      LEFT JOIN guardians g ON g.id=v.guardian_id`,
    scope: visitScope,
    order: ['v.check_in_at', 'v.id'],
    keys: ['check_in_at', 'id'],
  };
  if (phase === 'corrections') return {
    select: `SELECT ac.id,ac.visit_id,ac.prior_check_in_at,ac.prior_check_out_at,
      ac.check_in_at,ac.check_out_at,ac.reason,ac.actor_name,ac.recorded_at,
      v.check_in_at AS report_visit_at`,
      from: `FROM (SELECT visit_id AS id,* FROM history_visit_heads) v
        JOIN attendance_correction_records ac ON ac.visit_id=v.id`,
    scope: `${visitScope} AND ${archivedClaim('ac')}`,
    order: ['v.check_in_at', 'v.id', 'ac.recorded_at', 'ac.id'],
    keys: ['report_visit_at', 'visit_id', 'recorded_at', 'id'],
  };
  if (phase === 'observations') return {
    select: `SELECT e.id,e.visit_id,e.observed_at,e.received_at,e.actor_name,
      e.action,e.channel,e.reason,v.check_in_at AS report_visit_at`,
    from: 'FROM visits v JOIN attendance_events e ON e.visit_id=v.id',
    scope: `${visitScope} AND ${archivedClaim('e')}`,
    order: ['v.check_in_at', 'v.id', 'e.received_at', 'e.id'],
    keys: ['report_visit_at', 'visit_id', 'received_at', 'id'],
  };
  return {
    select: `SELECT e.id,e.student_id,e.visit_id,e.observed_at,e.received_at,
      e.actor_name,e.action,e.channel,e.reason,s.student_code,
      s.first_name||' '||s.last_name AS student_name,r.status AS review_status,
      coalesce(p.effective_observed_at,e.observed_at) AS effective_observed_at,coalesce(p.version,1) AS observation_version,
      coalesce((SELECT json_group_array(json(item)) FROM (
        SELECT json_object(
          'id',oc.id,'eventId',oc.event_id,
          'priorEffectiveObservedAt',oc.prior_effective_observed_at,
          'effectiveObservedAt',oc.effective_observed_at,
          'expectedVersion',oc.expected_version,'resultingVersion',oc.resulting_version,
          'reason',oc.reason,'actorId',oc.actor_id,'actorName',oc.actor_name,
          'recordedAt',oc.recorded_at
        ) AS item FROM observation_corrections oc
        WHERE oc.event_id=e.id ORDER BY oc.resulting_version,oc.id
      )),'[]') AS observation_corrections_json`,
    from: `FROM attendance_events e JOIN students s ON s.id=e.student_id
      LEFT JOIN observation_effective_times p ON p.event_id=e.id
      LEFT JOIN reviews r ON r.event_id=e.id`,
    scope: `e.center_id=? AND e.visit_id IS NULL
      AND coalesce(p.effective_observed_at,e.observed_at)>=? AND coalesce(p.effective_observed_at,e.observed_at)<?
      AND ${archivedClaim('e')}`,
    order: ['coalesce(p.effective_observed_at,e.observed_at)', 'e.id'],
    keys: ['effective_observed_at', 'id'],
  };
}

function archivePlan(input: PageInput): {
  scope: ArchiveRangeScope;
  tables: ArchiveTable[];
} {
  if (input.epoch === undefined) {
    return {
      scope: 'any',
      tables: ['visits', 'attendance_events', 'attendance_corrections', 'reviews'],
    };
  }
  if (input.phase === 'corrections') {
    return { scope: 'visit-effective', tables: ['attendance_corrections'] };
  }
  if (input.phase === 'observations') {
    return { scope: 'visit-effective', tables: ['attendance_events'] };
  }
  if (input.phase === 'unmatched') {
    return { scope: 'observed', tables: ['attendance_events', 'reviews'] };
  }
  return { scope: 'visit-effective', tables: ['visits'] };
}

function archiveProblem(error: unknown): never {
  if (
    error instanceof ArchiveRangeUnavailableError &&
    ['publication-limit', 'object-limit', 'record-limit'].includes(error.reason)
  ) {
    throw new ApiProblem(
      422,
      'EXPORT_ARCHIVE_RANGE_TOO_LARGE',
      'Choose a shorter date range so every archived record can be verified.',
    );
  }
  throw new ApiProblem(
    503,
    'HISTORY_EVIDENCE_UNAVAILABLE',
    'Archived attendance cannot be verified right now. Start the export again later.',
  );
}

async function archivedEvidence(
  c: Context<AppEnv>,
  range: ReportRange,
  input: PageInput,
): Promise<ArchiveRangeResult> {
  const query = archiveQuery(c, range, input);
  try {
    return await readArchiveRange(c.env.CRM_DB, archiveReceiptStorage(c.env), query);
  } catch (error) {
    return archiveProblem(error);
  }
}

function archiveQuery(
  c: Context<AppEnv>,
  range: ReportRange,
  input: PageInput,
): ArchiveRangeQuery {
  const plan = archivePlan(input);
  return {
    centerId: centerId(c),
    timezone: range.timezone,
    fromISO: range.fromISO,
    toISO: range.toISO,
    scope: plan.scope,
    tables: plan.tables,
  };
}

async function assertArchivedEvidence(
  c: Context<AppEnv>,
  range: ReportRange,
  input: PageInput,
  archive: ArchiveRangeResult,
): Promise<void> {
  try {
    await assertArchiveRangeAuthority(
      c.env.CRM_DB,
      archiveQuery(c, range, input),
      archive.authoritySha256,
    );
  } catch (error) {
    return archiveProblem(error);
  }
}

function rowKey(phase: ReportPhase, row: Row, visits: Map<string, string>): string[] | null {
  if (phase === 'visits') return [String(row.check_in_at), String(row.id)];
  if (phase === 'unmatched') {
    if (row.visit_id !== null) return null;
    return [String(row.effective_observed_at ?? row.observed_at), String(row.id)];
  }
  if (typeof row.visit_id !== 'string') return null;
  const visitAt = visits.get(row.visit_id);
  if (!visitAt) return null;
  return [
    visitAt,
    row.visit_id,
    String(row[phase === 'corrections' ? 'recorded_at' : 'received_at']),
    String(row.id),
  ];
}

async function archiveItems(
  c: Context<AppEnv>,
  range: ReportRange,
  phase: ReportPhase,
  records: readonly ArchiveRecord[],
  visits: Map<string, string>,
): Promise<ReportItem[]> {
  const center = centerId(c);
  const reviewByEvent = new Map<string, Row>();
  for (const record of records) {
    if (record.table !== 'reviews') continue;
    const eventId = String(record.row.event_id);
    if (reviewByEvent.has(eventId)) {
      throw new ApiProblem(503, 'HISTORY_EVIDENCE_UNAVAILABLE', 'Archived review evidence is ambiguous.');
    }
    reviewByEvent.set(eventId, record.row as Row);
  }

  const eventRows = records
    .filter(record => record.table === 'attendance_events')
    .map(record => record.row as Row);
  const unmatchedStudentIds = [...new Set(eventRows
    .filter(row => row.visit_id === null && typeof row.observed_at === 'string' &&
      row.observed_at >= range.fromISO && row.observed_at < range.toISO)
    .map(row => String(row.student_id)))];
  const students = new Map<string, Row>();
  if (unmatchedStudentIds.length) {
    const rows = await c.env.CRM_DB.prepare(
      `SELECT id,student_code,first_name,last_name FROM students
       WHERE center_id=? AND id IN (SELECT value FROM json_each(?))`,
    ).bind(center, JSON.stringify(unmatchedStudentIds)).all<Row>();
    for (const row of rows.results) students.set(String(row.id), row);
  }

  const items: ReportItem[] = [];
  for (const record of records) {
    const row = record.row as Row;
    if (row.center_id !== center) {
      throw new ApiProblem(503, 'HISTORY_EVIDENCE_UNAVAILABLE', 'Archived attendance scope is invalid.');
    }
    if (phase === 'corrections' && record.table !== 'attendance_corrections') continue;
    if ((phase === 'observations' || phase === 'unmatched') && record.table !== 'attendance_events') continue;
    if (phase === 'observations' && row.visit_id === null) continue;
    if (phase === 'unmatched' && (
      row.visit_id !== null ||
      typeof row.observed_at !== 'string' ||
      row.observed_at < range.fromISO ||
      row.observed_at >= range.toISO
    )) continue;
    const key = rowKey(phase, row, visits);
    if (!key) continue;

    let data: ReportRow;
    if (phase === 'unmatched') {
      const student = students.get(String(row.student_id));
      const review = reviewByEvent.get(String(row.id));
      if (!student || !review || review.status !== 'resolved') {
        throw new ApiProblem(503, 'HISTORY_EVIDENCE_UNAVAILABLE', 'Archived unmatched attendance is incomplete.');
      }
      data = {
        id: String(row.id),
        student_id: row.student_id,
        visit_id: null,
        observed_at: row.observed_at,
          effective_observed_at: row.observed_at,
          observation_version: 1,
          observation_corrections_json: '[]',
        received_at: row.received_at,
        actor_name: row.actor_name,
        action: row.action,
        channel: row.channel,
        reason: row.reason,
        student_code: student.student_code,
        student_name: `${student.first_name} ${student.last_name}`,
        review_status: review.status,
      };
    } else if (phase === 'corrections') {
      data = {
        id: String(row.id), visit_id: row.visit_id,
        prior_check_in_at: row.prior_check_in_at,
        prior_check_out_at: row.prior_check_out_at,
        check_in_at: row.check_in_at,
        check_out_at: row.check_out_at,
        reason: row.reason,
        actor_name: row.actor_name,
        recorded_at: row.recorded_at,
      };
    } else {
      data = {
        id: String(row.id), visit_id: row.visit_id,
        observed_at: row.observed_at,
        received_at: row.received_at,
        actor_name: row.actor_name,
        action: row.action,
        channel: row.channel,
        reason: row.reason,
      };
    }
    items.push({ key, data });
  }
  return items.sort((left, right) => compareReportKeys(left.key, right.key));
}

function liveRowItem(shape: QueryShape, row: Row): ReportItem {
  const key = shape.keys.map(name => String(row[name]));
  const { report_visit_at: _positionOnly, ...data } = row;
  return { key, data: data as ReportRow };
}

export async function attendanceReportPage(
  c: Context<AppEnv>,
  range: ReportRange,
  input: PageInput,
): Promise<ReportPage> {
  const center = centerId(c);
  const db = c.env.CRM_DB;
  const scopeArgs = [center, range.fromISO, range.toISO];
  const shape = queryParts(input.phase);
  const afterSql = input.after
    ? ` AND (${shape.order.join(',')})>(${shape.order.map(() => '?').join(',')})`
    : '';
  const archive = await archivedEvidence(c, range, input);

  const epochStatement = () => db.prepare(
    `SELECT coalesce(sum(version),0) AS epoch,
      (SELECT generation FROM report_runtime WHERE id=1) AS generation,
      (SELECT timezone FROM centers WHERE id=?) AS timezone,
      (SELECT display_name FROM staff WHERE id=? AND center_id=?) AS exporter_name
     FROM report_epochs WHERE center_id=? AND (day='*' OR day BETWEEN ? AND ?)`,
  ).bind(
    center,
    c.var.actor.id,
    center,
    center,
    range.fromISO.slice(0, 10),
    range.toISO.slice(0, 10),
  );

  const statements = [
    epochStatement(),
    db.prepare(
      `${shape.select} ${shape.from} WHERE ${shape.scope}${afterSql}
       ORDER BY ${shape.order.join(',')} LIMIT ?`,
    ).bind(...scopeArgs, ...(input.after || []), REPORT_LIMITS.pageRows + 1),
    db.prepare(
      `SELECT h.visit_id,h.check_in_at
       FROM history_visit_heads h
       WHERE h.center_id=? AND h.check_in_at>=? AND h.check_in_at<?
       ORDER BY h.check_in_at,h.visit_id LIMIT ?`,
    ).bind(center, range.fromISO, range.toISO, REPORT_LIMITS.visits + 1),
    db.prepare(
      `SELECT count(*) AS n FROM history_visit_heads h
       WHERE h.center_id=? AND h.check_in_at>=? AND h.check_in_at<?
       AND NOT EXISTS(SELECT 1 FROM visits v WHERE v.id=h.visit_id AND v.center_id=h.center_id)`,
    ).bind(center, range.fromISO, range.toISO),
  ];
  if (input.epoch === undefined) {
    for (const phase of REPORT_PHASES) {
      const countShape = queryParts(phase);
      statements.push(db.prepare(
        `SELECT count(*) AS n FROM (
          SELECT 1 ${countShape.from} WHERE ${countShape.scope} LIMIT ?
        )`,
      ).bind(...scopeArgs, REPORT_LIMITS[phase] + 1));
    }
  }
  const result = await db.batch<Row>(statements);
  const first = result[0].results[0];
  const epoch = Number(first.epoch);
  const rawGeneration = first.generation;
  const generation = typeof rawGeneration === 'string'
    ? (await digest(encoder.encode(JSON.stringify({
        runtimeGeneration: rawGeneration,
        archiveAuthoritySha256: archive.authoritySha256,
        centerId: center,
        fromISO: range.fromISO,
        toISO: range.toISO,
        timezone: range.timezone,
        exporterId: c.var.actor.id,
        exporterName: first.exporter_name,
      })))).slice(0, 32)
    : '';
  if (
    !Number.isSafeInteger(epoch) || epoch < 0 ||
    (input.epoch !== undefined && epoch !== input.epoch) ||
    !/^[a-f0-9]{32}$/.test(generation) ||
    (input.epoch !== undefined && generation !== input.generation) ||
    first.timezone !== range.timezone ||
    typeof first.exporter_name !== 'string'
  ) {
    throw new ApiProblem(
      409,
      'REPORT_CHANGED',
      'Attendance identity details changed during export. Start the export again.',
    );
  }
  const assertEpochUnchanged = (snapshot: Row | null | undefined) => {
    if (
      Number(snapshot?.epoch) !== epoch ||
      snapshot?.generation !== rawGeneration ||
      snapshot?.timezone !== range.timezone ||
      snapshot?.exporter_name !== first.exporter_name
    ) {
      throw new ApiProblem(
        409,
        'REPORT_CHANGED',
        'Attendance identity details changed during export. Start the export again.',
      );
    }
  };

  const headRows = result[2].results;
  if (headRows.length > REPORT_LIMITS.visits) {
    throw new ApiProblem(
      503,
      'HISTORY_EVIDENCE_UNAVAILABLE',
      'Current visit authority is incomplete for this report range.',
    );
  }
  const visits = new Map(headRows.map(row => [String(row.visit_id), String(row.check_in_at)]));
  const archivedByPhase = new Map<ReportPhase, ReportItem[]>();
  const phases = input.epoch === undefined ? REPORT_PHASES.slice(1) : [input.phase];
  for (const phase of phases) {
    if (phase === 'visits') continue;
    archivedByPhase.set(phase, await archiveItems(c, range, phase, archive.records, visits));
  }

  let initial: ReportPage['initial'];
  if (input.epoch === undefined) {
    const counts = Object.fromEntries(REPORT_PHASES.map((phase, index) => [
      phase,
      Number(result[index + 4].results[0].n) + (archivedByPhase.get(phase)?.length || 0),
    ])) as ReportCounts;
    counts.visits = headRows.length;
    if (
      REPORT_PHASES.some(phase => counts[phase] > REPORT_LIMITS[phase]) ||
      counts.visits + counts.unmatched > REPORT_LIMITS.visits
    ) {
      throw new ApiProblem(
        422,
        'EXPORT_TOO_LARGE',
        'Choose a smaller date range to include all attendance evidence.',
      );
    }
    initial = { counts, exportedAt: now() };
  }

  const selectedHeads = input.phase === 'visits'
    ? headRows
      .filter(row => !input.after || compareReportKeys(
        [String(row.check_in_at), String(row.visit_id)],
        input.after,
      ) > 0)
      .slice(0, REPORT_LIMITS.pageRows + 1)
    : [];
  let visitHeads: Row[] = [];
  if (selectedHeads.length) {
    const detailed = await db.prepare(
        `SELECT h.*,s.student_code,s.first_name||' '||s.last_name AS student_name,s.active
         FROM json_each(?) selected
         CROSS JOIN history_visit_heads h ON h.visit_id=selected.value
         JOIN students s ON s.id=h.student_id
         WHERE h.center_id=?`,
      ).bind(JSON.stringify(selectedHeads.map(row => row.visit_id)), center).all<Row>();
    const byId = new Map(detailed.results.map(row => [String(row.visit_id), row]));
    visitHeads = selectedHeads.map(head => {
      const row = byId.get(String(head.visit_id));
      if (!row || String(row.check_in_at) !== String(head.check_in_at)) {
        throw new ApiProblem(503, 'HISTORY_EVIDENCE_UNAVAILABLE', 'Visit authority changed during export.');
      }
      return row;
    });
  }
  const sourceRows = input.phase === 'visits'
    ? await verifiedVisitRows(c, range, visitHeads, archive)
    : result[1].results;
  const liveItems = sourceRows.map(row => liveRowItem(shape, row));
  const archivedItems = archivedByPhase.get(input.phase) || [];
  const filteredArchive = input.after
    ? archivedItems.filter(item => compareReportKeys(item.key, input.after!) > 0)
    : archivedItems;
  const ids = new Set<string>();
  for (const item of [...liveItems, ...filteredArchive]) {
    if (ids.has(item.data.id)) {
      throw new ApiProblem(503, 'HISTORY_EVIDENCE_UNAVAILABLE', 'Report evidence authority overlaps.');
    }
    ids.add(item.data.id);
  }
  const combined = [...liveItems, ...filteredArchive]
    .sort((left, right) => compareReportKeys(left.key, right.key));
  const items = combined.slice(0, REPORT_LIMITS.pageRows);
  const page: ReportPage = {
    phase: input.phase,
    items,
    next: combined.length > REPORT_LIMITS.pageRows ? cursor(items.at(-1)!.key) : null,
    epoch,
    generation,
    range,
    exporter: { id: c.var.actor.id, name: String(first.exporter_name) },
    ...(initial ? { initial } : {}),
  };
  if (encoder.encode(JSON.stringify(page)).length > REPORT_LIMITS.pageBytes) {
    throw new ApiProblem(
      422,
      'EXPORT_PAGE_TOO_LARGE',
      'An attendance export page is too large. Choose a smaller date range.',
    );
  }
  await assertArchivedEvidence(c, range, input, archive);
  assertEpochUnchanged(await epochStatement().first<Row>());
  return page;
}

/** Compatibility download deliberately stays small and never truncates CSV. */
export async function smallAttendanceCsv(
  c: Context<AppEnv>,
  range: ReportRange,
): Promise<Response> {
  const first = await attendanceReportPage(c, range, { phase: 'visits' });
  const counts = first.initial!.counts;
  if (
    counts.visits + counts.unmatched > 25 ||
    counts.corrections > REPORT_LIMITS.pageRows ||
    counts.observations > REPORT_LIMITS.pageRows
  ) {
    throw new ApiProblem(
      422,
      'EXPORT_REQUIRES_PAGES',
      'Use Export attendance in Attendance history to download the report in verified pages.',
    );
  }
  const evidence: ReportEvidence = {
    visits: first.items.map(item => item.data),
    corrections: [],
    observations: [],
    unmatched: [],
  };
  for (const phase of REPORT_PHASES.slice(1)) {
    const page = await attendanceReportPage(c, range, {
      phase,
      epoch: first.epoch,
      generation: first.generation,
    });
    if (page.next || page.items.length !== counts[phase]) {
      throw new ApiProblem(
        409,
        'REPORT_CHANGED',
        'The attendance report could not be completed. Start it again.',
      );
    }
    evidence[phase] = page.items.map(item => item.data);
  }
  await audit(c, 'attendance_exported', 'report', id(), {
    from: range.from,
    to: range.to,
    visits: counts.visits,
    unmatched: counts.unmatched,
    epoch: first.epoch,
  }).run();
  return new Response(
    attendanceCsv(evidence, range, first.initial!.exportedAt, first.exporter.name),
    {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attendance-${range.from}-${range.to}.csv"`,
        'Cache-Control': 'no-store',
      },
    },
  );
}
