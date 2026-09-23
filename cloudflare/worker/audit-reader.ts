import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { AuditActivityEntry, AuditActivityPage, AuditFilters, AuditSource } from '../shared/audit-reader';
import { getCenter, localMidnight } from './records';
import { ApiProblem, body, centerId, managementRoles, now, requireRole, sha256, textValue } from './util';

const SCAN_LIMIT = 200, DETAIL_CHARACTERS = 4000, ITEM_BYTES = 96 * 1024;
const allowed = ['from', 'to', 'actor', 'action', 'entityType', 'entityId', 'limit', 'cursor'];
const invalid = (message = 'Use valid audit filters and the cursor returned for this search.') => new ApiProblem(400, 'AUDIT_QUERY_INVALID', message);
type Cursor = { version: 1; filter: string; asOf: string; recordedAt: string; id: string };
type AuditRow = { id: string; actor_id: string | null; actor_name: string; action: string; entity_type: string; entity_id: string; created_at: string; detail: string; detail_truncated: number; source: AuditSource };
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const encode = (cursor: Cursor) => btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function decode(value: unknown): Cursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  try {
    const parsed = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) as Cursor;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join() !== 'asOf,filter,id,recordedAt,version' || parsed.version !== 1 || typeof parsed.filter !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(parsed.filter) || !iso(parsed.asOf) || !iso(parsed.recordedAt) || typeof parsed.id !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(parsed.id) || parsed.recordedAt > parsed.asOf) throw invalid();
    return parsed;
  } catch { throw invalid(); }
}

// Keep this query on the logical view. In particular, a retained legacy audit
// row takes precedence over its projection, exactly as audit_timeline defines.
export function auditPageSql(mode: 'range' | 'as-of' | 'same-time' = 'range') {
  return `SELECT a.id,a.actor_id,a.actor_name,a.action,a.entity_type,a.entity_id,a.created_at,
    substr(a.detail,1,${DETAIL_CHARACTERS}) AS detail,length(a.detail)>${DETAIL_CHARACTERS} AS detail_truncated,
    CASE WHEN EXISTS(SELECT 1 FROM audit_entries physical WHERE physical.id=a.id) THEN 'stored-audit'
      WHEN a.action='attendance_correction' THEN 'attendance-correction-projection' ELSE 'attendance-event-projection' END AS source
    FROM audit_timeline_live a WHERE a.center_id=?
    ${mode === 'same-time' ? 'AND a.created_at=? AND a.id<?' : `AND a.created_at>=? AND a.created_at${mode === 'as-of' ? '<=' : '<'}?`}
    ORDER BY a.created_at DESC,a.id DESC LIMIT ?`;
}

export function archivedCorrectionAuditPageSql(mode: 'range' | 'as-of' | 'same-time' = 'range') {
  const detail = "json_object('reason',c.reason,'priorCheckInAt',c.prior_check_in_at,'priorCheckOutAt',c.prior_check_out_at,'checkInAt',c.check_in_at,'checkOutAt',c.check_out_at)";
  return `SELECT c.id,c.actor_id,c.actor_name,'attendance_correction' AS action,
    'visit' AS entity_type,c.visit_id AS entity_id,c.recorded_at AS created_at,
    substr(${detail},1,${DETAIL_CHARACTERS}) AS detail,
    length(${detail})>${DETAIL_CHARACTERS} AS detail_truncated,
    'attendance-correction-projection' AS source
    FROM history_correction_outbox c WHERE c.center_id=?
    ${mode === 'same-time' ? 'AND c.recorded_at=? AND c.id<?' : `AND c.recorded_at>=? AND c.recorded_at${mode === 'as-of' ? '<=' : '<'}?`}
    AND NOT EXISTS(SELECT 1 FROM audit_entries physical WHERE physical.id=c.id)
    ORDER BY c.recorded_at DESC,c.id DESC LIMIT ?`;
}

export const auditReaderRouter = new Hono<AppEnv>();
auditReaderRouter.post('/audit/query', async c => {
  if (c.var.actor?.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace.');
  requireRole(c, managementRoles);
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  if (new URL(c.req.url).search) throw invalid('Send audit filters in the request body.');
  const input = await body(c);
  if (Object.keys(input).some(key => !allowed.includes(key) || key !== 'cursor' && input[key] === null)) throw invalid();
  const center = await getCenter(c), today = new Intl.DateTimeFormat('en-CA', { timeZone: center.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const from = input.from ?? new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10), to = input.to ?? today;
  if (typeof from !== 'string' || typeof to !== 'string' || !/^20\d{2}-\d\d-\d\d$/.test(from) || !/^20\d{2}-\d\d-\d\d$/.test(to)) throw invalid('Use dates between 2000 and 2099 in YYYY-MM-DD format.');
  const fromISO = localMidnight(from, center.timezone); localMidnight(to, center.timezone);
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!Number.isInteger(days) || days < 0 || days > 30) throw invalid('Choose an audit date range of at most 31 days.');
  const toISO = localMidnight(new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), center.timezone);
  const filters: AuditFilters = {
    from, to, actor: textValue(input.actor ?? '', 'Actor', 100, false), action: textValue(input.action ?? '', 'Action', 64, false),
    entityType: textValue(input.entityType ?? '', 'Record type', 64, false), entityId: textValue(input.entityId ?? '', 'Record ID', 100, false),
  };
  if ([filters.action, filters.entityType].some(value => value && !/^[a-z][a-z0-9_]*$/.test(value)) || filters.entityId && !/^[A-Za-z0-9_-]+$/.test(filters.entityId)) throw invalid();
  const limit = input.limit ?? 25;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid('Choose a page size from 1 to 50.');
  const fingerprint = await sha256(JSON.stringify({ center: centerId(c), reader: c.var.actor.id, timezone: center.timezone, filters, limit }));
  const cursor = decode(input.cursor);
  if (cursor && (cursor.filter !== fingerprint || cursor.recordedAt < fromISO || cursor.recordedAt >= toISO || cursor.asOf > now())) throw invalid();
  const asOf = cursor?.asOf || now();
  // Split the seek into equal-time IDs followed by older times. With a UNION
  // view SQLite otherwise rescans timestamp ties before applying the tuple.
  // Supply one effective upper bound; multiple competing range predicates can
  // cause SQLite to scan newer rows before evaluating the cursor bound.
  const rangeEnd = toISO <= asOf ? toISO : asOf;
  const readRows = async (mode: 'range' | 'as-of' | 'same-time', values: [string, string, string, number]) => {
    const result = await c.env.CRM_DB.batch<AuditRow>([
      c.env.CRM_DB.prepare(auditPageSql(mode)).bind(...values),
      c.env.CRM_DB.prepare(archivedCorrectionAuditPageSql(mode)).bind(...values),
    ]);
    return result.flatMap(item => item.results)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
      .slice(0, values[3]);
  };
  const rows = cursor
    ? await readRows('same-time', [centerId(c), cursor.recordedAt, cursor.id, SCAN_LIMIT + 1])
    : await readRows(toISO <= asOf ? 'range' : 'as-of', [centerId(c), fromISO, rangeEnd, SCAN_LIMIT + 1]);
  if (cursor && rows.length < SCAN_LIMIT + 1) rows.push(...await readRows(
    'range',
    [centerId(c), fromISO, cursor.recordedAt, SCAN_LIMIT + 1 - rows.length],
  ));
  const items: AuditActivityEntry[] = [], encoder = new TextEncoder(); let consumed = 0, bytes = 0;
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    const matches = (!filters.actor || row.actor_name.toLowerCase().includes(filters.actor.toLowerCase())) && (!filters.action || row.action === filters.action) && (!filters.entityType || row.entity_type === filters.entityType) && (!filters.entityId || row.entity_id === filters.entityId);
    if (matches) {
      const item: AuditActivityEntry = { id: row.id, actorId: row.actor_id, actorName: row.actor_name, action: row.action, entityType: row.entity_type, entityId: row.entity_id, recordedAt: row.created_at, detail: row.detail, detailTruncated: Boolean(row.detail_truncated), source: row.source };
      const size = encoder.encode(JSON.stringify(item)).length;
      if (size > ITEM_BYTES) throw new ApiProblem(503, 'AUDIT_ENTRY_UNAVAILABLE', 'An audit entry cannot be displayed within the response limit. This is not an empty history result.');
      if (items.length >= limit || bytes + size > ITEM_BYTES) break;
      items.push(item); bytes += size;
    }
    consumed++;
  }
  const last = rows[consumed - 1], more = rows.length > consumed;
  const payload: AuditActivityPage = {
    items, scanned: consumed, searchComplete: !more,
    nextCursor: more && last ? encode({ version: 1, filter: fingerprint, asOf, recordedAt: last.created_at, id: last.id }) : null,
    range: { from, to, timezone: center.timezone }, asOf,
    provenance: { view: 'audit_timeline', storage: 'current-database', evictionEnabled: false, snapshot: false },
  };
  return c.json(payload);
});
