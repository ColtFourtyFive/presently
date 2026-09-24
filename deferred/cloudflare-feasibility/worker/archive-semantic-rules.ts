import { ARCHIVE_LIMITS as LIMIT, type ArchiveManifest, type ArchiveRecord, type ArchiveRow, type ArchiveTable } from '../shared/archive-format';
import { decodeAttendanceReceipt } from './attendance-receipt';
import type { VisitSummary } from '../shared/types';

const encoder = new TextEncoder();
const columns: Record<ArchiveTable, readonly string[]> = {
  centers: ['id', 'name', 'timezone', 'created_at'],
  students: ['id', 'center_id', 'student_code', 'first_name', 'last_name', 'active', 'subjects', 'created_at', 'updated_at'],
  guardians: ['id', 'center_id', 'display_name', 'created_at'],
  student_guardians: ['student_id', 'guardian_id', 'relationship', 'pickup_authority', 'authority_note'],
  staff: ['id', 'center_id', 'display_name', 'role', 'active', 'created_at', 'updated_at'],
  visits: ['id', 'center_id', 'student_id', 'check_in_at', 'check_out_at', 'original_check_in_at', 'original_check_out_at', 'check_in_by', 'check_out_by', 'guardian_id', 'departure_type', 'review_status', 'version'],
  attendance_events: ['id', 'center_id', 'student_id', 'visit_id', 'action', 'observed_at', 'received_at', 'actor_id', 'actor_name', 'channel', 'device_id', 'guardian_id', 'reason', 'payload_hash', 'insertion_nonce', 'result_visit'],
  attendance_corrections: ['id', 'center_id', 'visit_id', 'expected_version', 'prior_check_in_at', 'prior_check_out_at', 'check_in_at', 'check_out_at', 'reason', 'actor_id', 'actor_name', 'recorded_at', 'payload_hash'],
  reviews: ['id', 'center_id', 'event_id', 'visit_id', 'student_id', 'reason', 'status', 'created_at', 'resolved_at', 'resolved_by', 'resolution'],
  audit_entries: ['id', 'center_id', 'actor_id', 'actor_name', 'action', 'entity_type', 'entity_id', 'detail', 'created_at'],
};
const nullable = new Set(['check_out_at', 'original_check_out_at', 'check_out_by', 'guardian_id', 'departure_type', 'visit_id', 'device_id', 'reason', 'prior_check_out_at', 'resolved_at', 'resolved_by', 'resolution']);
function fail(code: string): never { throw new Error(`Invalid historical evidence: ${code}`); }
function canonical(value: unknown, depth = 0): string {
  if (depth > 16) fail('JSON_DEPTH');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}
function jsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return fail('INVALID_JSON');
  let value: unknown; try { value = JSON.parse(text); } catch { return fail('INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_JSON');
  return value as Record<string, unknown>;
}
function shape(record: ArchiveRecord, manifest: SemanticContext, table = record.table, key = record.key): void {
  if (!record || record.table !== table || record.key !== key || !record.row || typeof record.row !== 'object' || Array.isArray(record.row)) fail('STAGED_RECORD_IDENTITY');
  const row = record.row, expected = columns[table];
  if (!expected || Object.keys(row).length !== expected.length || expected.some(name => !Object.hasOwn(row, name))) fail('UNSUPPORTED_COLUMNS');
  if (encoder.encode(JSON.stringify(record)).length > LIMIT.recordBytes) fail('STAGED_RECORD_TOO_LARGE');
  if (key !== (table === 'student_guardians' ? JSON.stringify([row.student_id, row.guardian_id]) : row.id)) fail('STAGED_RECORD_KEY');
  if (table === 'centers' ? row.id !== manifest.centerId || row.timezone !== manifest.timezone : table !== 'student_guardians' && row.center_id !== manifest.centerId) fail('CENTER_SCOPE');
  for (const [name, value] of Object.entries(row)) {
    if (name === 'active') { if (value !== 0 && value !== 1) fail('INVALID_ACTIVE'); continue; }
    if (name === 'version' || name === 'expected_version') { if (!Number.isSafeInteger(value) || Number(value) < 1) fail('INVALID_VERSION'); continue; }
    if (value === null && (nullable.has(name) || table === 'audit_entries' && name === 'actor_id')) continue;
    if (typeof value !== 'string') fail('INVALID_FIELD_TYPE');
    if (name === 'id' || name.endsWith('_id') || name === 'check_in_by' || name === 'check_out_by' || name === 'resolved_by') {
      if (name === 'id' && table === 'audit_entries') { if (!/^[A-Za-z0-9_:-]{1,200}$/.test(value)) fail('INVALID_AUDIT_ID'); }
      else if (name === 'id' && (table === 'attendance_events' || table === 'attendance_corrections')) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('INVALID_REQUEST_ID'); }
      else if (name !== 'entity_id' && !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INVALID_REFERENCE');
    }
    if (name.endsWith('_at')) {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_TIME');
      if (['created_at', 'updated_at', 'received_at', 'recorded_at', 'resolved_at'].includes(name) && value > manifest.createdAt) fail('CAPTURE_TIME');
    }
  }
  if (table === 'students') { let subjects: unknown; try { subjects = JSON.parse(String(row.subjects)); } catch { fail('INVALID_SUBJECTS'); } if (!Array.isArray(subjects) || subjects.some(v => typeof v !== 'string')) fail('INVALID_SUBJECTS'); }
  if (table === 'staff' && !['owner', 'manager', 'front_desk', 'instructor'].includes(String(row.role))) fail('INVALID_ROLE');
  if (table === 'student_guardians' && !['unverified', 'allowed', 'denied'].includes(String(row.pickup_authority))) fail('INVALID_AUTHORITY');
}

async function fingerprint(row: ArchiveRow, correction: boolean, manifest: SemanticContext) {
  // These key orders are the existing API contract. No old hash is rewritten.
  const input = correction
    ? { visitId: row.visit_id, expectedVersion: row.expected_version, checkInAt: row.check_in_at, checkOutAt: row.check_out_at, reason: row.reason }
    : { studentId: row.student_id, action: row.action, observedAt: row.observed_at, guardianId: row.guardian_id, reason: row.reason };
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(input))));
  const base64 = btoa(String.fromCharCode(...bytes));
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  if (row.payload_hash !== base64 && !(manifest.semanticProof!.payloadHashEncoding === 'base64-or-hex' && row.payload_hash === hex)) fail('REQUEST_FINGERPRINT');
}
function receipt(row: ArchiveRow): VisitSummary | null {
  let value: unknown; try { value = JSON.parse(String(row.result_visit)); } catch { return fail('UNSEALED_RECEIPT'); }
  if (value && !Array.isArray(value) && typeof value === 'object') {
    const fields = ['id', 'studentId', 'studentName', 'studentCode', 'active', 'checkInAt', 'checkOutAt', 'originalCheckInAt', 'originalCheckOutAt', 'checkInBy', 'checkOutBy', 'guardianName', 'departureType', 'reviewStatus', 'version'];
    if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail('RECEIPT_COLUMNS');
  }
  let decoded: VisitSummary | null;
  try { decoded = decodeAttendanceReceipt({ visit_id: row.visit_id, student_id: row.student_id, action: row.action, observed_at: row.observed_at, result_visit: row.result_visit }); } catch { return fail('INVALID_RECEIPT'); }
  if (decoded ? decoded.id !== row.visit_id || decoded.studentId !== row.student_id : row.visit_id !== null || row.action !== 'exceptional_departure') fail('RECEIPT_REFERENCE');
  return decoded;
}


/** Authenticated, bounded header fields required by record and visit rules. */
export type SemanticContext = Pick<ArchiveManifest, 'centerId' | 'timezone' | 'createdAt' | 'periodFrom' | 'periodTo' | 'semanticProof'>;
/** Both lookups return authenticated records shaped against their source header.
 * find searches the applicable graph; localGet only the current publication. */
export type SemanticLookup = {
  find(table: ArchiveTable, key: unknown): Promise<ArchiveRecord | null>;
  localGet(table: ArchiveTable, key: string): Promise<ArchiveRecord | null>;
};
export type SemanticOperation = { visitId: string; requestId: string; table: 'attendance_events' | 'attendance_corrections'; key: string; version: number; bytes: number };
export type SemanticRecordResult = { operation: SemanticOperation | null; resolutionWitness: { reviewId: string; auditKey: string } | null };
export type VisitFoldState = {
  version: number; bytes: number; start: ArchiveRow[string]; end: ArchiveRow[string];
  originalStart: ArchiveRow[string]; originalEnd: ArchiveRow[string];
  inBy: ArchiveRow[string]; outBy: ArchiveRow[string]; guardian: ArchiveRow[string]; departure: ArchiveRow[string];
};
export { fail as failSemantic, canonical as canonicalSemanticValue, shape as validateSemanticShape };

/** Called only on shaped operations. Sealed null observations have no visit fold. */
export function semanticOperation(record: ArchiveRecord): SemanticOperation | null {
  if (record.table !== 'attendance_events' && record.table !== 'attendance_corrections') return null;
  const decoded = record.table === 'attendance_events' ? receipt(record.row) : null;
  if (record.row.visit_id === null) return null;
  const version = record.table === 'attendance_events' ? decoded?.version || 0 : Number(record.row.expected_version) + 1;
  if (!Number.isSafeInteger(version) || version < 1) fail('INVALID_VERSION');
  return { visitId: String(record.row.visit_id), requestId: String(record.row.id), table: record.table, key: record.key, version, bytes: encoder.encode(JSON.stringify(record)).length };
}

/** Exact winning resolution witness. Later valid repeat attempts remain evidence
 * but cannot stand in for the audit that produced the retained review state. */
export function matchesResolutionWitness(audit: ArchiveRow, review: ArchiveRow): boolean {
  return audit.action === 'review_resolved' && audit.entity_type === 'review' && audit.entity_id === review.id
    && audit.actor_id === review.resolved_by && audit.created_at === review.resolved_at
    && jsonObject(audit.detail).resolution === review.resolution;
}

export function initialVisitFold(): VisitFoldState {
  return { version: 0, bytes: 0, start: null, end: null, originalStart: null, originalEnd: null, inBy: null, outBy: null, guardian: null, departure: null };
}

/** Replay one authenticated operation in increasing accepted-version order.
 * The returned state is JSON serializable and contains no names or receipts. */
export function applyVisitOperation(state: VisitFoldState, visit: ArchiveRow, record: ArchiveRecord): VisitFoldState {
  const operation = semanticOperation(record);
  if (!operation) fail('MISSING_ARRIVAL');
  if (operation.visitId !== String(visit.id)) fail('VISIT_EVENT_REFERENCE');
  const row = record.row;
  if (state.version === 0 && (operation.version !== 1 || record.table !== 'attendance_events' || row.action !== 'check_in')) fail('MISSING_ARRIVAL');
  if (state.version >= LIMIT.semanticVisitOperations || state.bytes + operation.bytes > LIMIT.semanticVisitBytes) fail('VISIT_CLOSURE_BOUND');
  if (operation.version !== state.version + 1) fail('VISIT_VERSION_CHAIN');
  const next = { ...state, bytes: state.bytes + operation.bytes };
  if (record.table === 'attendance_corrections') {
    if (row.expected_version !== state.version || row.prior_check_in_at !== state.start || row.prior_check_out_at !== state.end) fail('CORRECTION_PRIOR_STATE');
    if (String(row.check_in_at) > String(row.recorded_at) || row.check_out_at !== null && String(row.check_out_at) > String(row.recorded_at)) fail('FUTURE_CORRECTION');
    next.start = row.check_in_at; next.end = row.check_out_at;
  } else {
    if (row.student_id !== visit.student_id || row.visit_id !== visit.id) fail('VISIT_EVENT_REFERENCE');
    if (state.version === 0) {
      next.start = row.observed_at; next.originalStart = row.observed_at; next.inBy = row.actor_id;
    } else {
      if (row.action === 'check_in' || state.end !== null) fail('VISIT_DEPARTURE_STATE');
      next.end = row.observed_at; next.originalEnd = next.end; next.outBy = row.actor_id; next.guardian = row.guardian_id; next.departure = row.action;
    }
    const result = receipt(row)!;
    if (result.checkInAt !== next.start || result.checkOutAt !== next.end || result.originalCheckInAt !== next.originalStart || result.originalCheckOutAt !== next.originalEnd || result.departureType !== next.departure || result.reviewStatus !== (row.action === 'exceptional_departure' ? 'pending' : 'none')) fail('RECEIPT_ACCEPTED_STATE');
  }
  if (next.end !== null && String(next.end) < String(next.start)) fail('INVALID_INTERVAL');
  next.version++;
  return next;
}

export function finishVisitFold(state: VisitFoldState, visit: ArchiveRow, context: SemanticContext): void {
  if (state.version === 0) fail('MISSING_ARRIVAL');
  if (visit.version !== state.version || visit.check_in_at !== state.start || visit.check_out_at !== state.end || visit.original_check_in_at !== state.originalStart || visit.original_check_out_at !== state.originalEnd || visit.check_in_by !== state.inBy || visit.check_out_by !== state.outBy || visit.guardian_id !== state.guardian || visit.departure_type !== state.departure) fail('VISIT_FINAL_STATE');
  if (state.departure === 'exceptional_departure' ? visit.review_status === 'none' : visit.review_status !== 'none') fail('VISIT_REVIEW_STATE');
  if (String(state.originalStart) < context.periodFrom || String(state.originalStart) >= context.periodTo) fail('ORIGINAL_MONTH_SCOPE');
}

export async function validateSemanticRecord(record: ArchiveRecord, manifest: SemanticContext, lookup: SemanticLookup): Promise<SemanticRecordResult> {
  shape(record, manifest);
  const row = record.row, table = record.table;
  let resolutionWitness: SemanticRecordResult['resolutionWitness'] = null;
  const find = (table: ArchiveTable, key: unknown) => lookup.find(table, key);
  async function requireRecord(table: ArchiveTable, key: unknown): Promise<ArchiveRow> {
    const found = await find(table, key);
    if (!found) return fail('MISSING_RELATION');
    return found.row;
  }
  async function reference(table: ArchiveTable, key: unknown): Promise<void> { if (key !== null) await requireRecord(table, key); }
  async function auditFor(record: ArchiveRecord) {
    const row = record.row, event = record.table === 'attendance_events';
    const audit = await requireRecord('audit_entries', row.id);
    const detail = event
      ? { studentId: row.student_id, observedAt: row.observed_at, receivedAt: row.received_at, channel: row.channel, deviceId: row.device_id }
      : { reason: row.reason, priorCheckInAt: row.prior_check_in_at, priorCheckOutAt: row.prior_check_out_at, checkInAt: row.check_in_at, checkOutAt: row.check_out_at };
    if (audit.actor_id !== row.actor_id || audit.actor_name !== row.actor_name || audit.action !== (event ? row.action : 'attendance_correction') || audit.entity_type !== (event ? 'attendance_event' : 'visit') || audit.entity_id !== (event ? row.id : row.visit_id) || audit.created_at !== (event ? row.received_at : row.recorded_at) || canonical(jsonObject(audit.detail)) !== canonical(detail)) fail('SOURCE_AUDIT_MISMATCH');
  }
  if (table === 'student_guardians') { await reference('students', row.student_id); await reference('guardians', row.guardian_id); }
  if (table === 'visits') {
    await reference('students', row.student_id); await reference('staff', row.check_in_by); await reference('staff', row.check_out_by); await reference('guardians', row.guardian_id);
    if (!['none', 'pending', 'resolved'].includes(String(row.review_status))) fail('INVALID_REVIEW_STATUS');
  }
  if (table === 'attendance_events') {
    await reference('students', row.student_id); await reference('staff', row.actor_id); await reference('guardians', row.guardian_id);
    if (!['check_in', 'check_out', 'exceptional_departure'].includes(String(row.action)) || !['admin', 'kiosk'].includes(String(row.channel))) fail('INVALID_EVENT_ENUM');
    if (row.channel === 'kiosk' ? row.device_id === null || !manifest.semanticProof!.deviceContexts.some(device => device.id === row.device_id && device.centerId === manifest.centerId) : row.device_id !== null) fail('DEVICE_OWNERSHIP');
    if (row.action === 'check_in' && (row.reason !== null || row.guardian_id !== null) || row.action === 'exceptional_departure' && (typeof row.reason !== 'string' || row.reason.trim().length < 5)) fail('EVENT_INPUT');
    if (row.guardian_id !== null) await requireRecord('student_guardians', JSON.stringify([row.student_id, row.guardian_id]));
    if (row.action === 'check_out' && row.guardian_id === null) fail('MISSING_PICKUP_REFERENCE');
    if (row.visit_id !== null) { const visit = await requireRecord('visits', row.visit_id); if (visit.student_id !== row.student_id) fail('VISIT_EVENT_REFERENCE'); if (!await lookup.localGet('visits', String(row.visit_id))) fail('MISSING_RESULTING_VISIT'); }
    if (String(row.received_at) > manifest.createdAt) fail('CAPTURE_TIME');
    await fingerprint(row, false, manifest); receipt(row); await auditFor(record);
    if (await find('attendance_corrections', row.id)) fail('SOURCE_ID_COLLISION');
    if (row.action === 'exceptional_departure') await requireRecord('reviews', row.id);
  }
  if (table === 'attendance_corrections') {
    await reference('visits', row.visit_id); await reference('staff', row.actor_id);
    if (typeof row.reason !== 'string' || row.reason.trim().length < 5 || String(row.recorded_at) > manifest.createdAt) fail('CORRECTION_INPUT');
    await fingerprint(row, true, manifest); await auditFor(record);
    if (await find('attendance_events', row.id)) fail('SOURCE_ID_COLLISION');
    // Every new transition must have a resulting visit snapshot in this publication.
    if (!await lookup.localGet('visits', String(row.visit_id))) fail('MISSING_RESULTING_VISIT');
  }
  if (table === 'reviews') {
    const event = await requireRecord('attendance_events', row.event_id);
    if (row.id !== row.event_id || event.action !== 'exceptional_departure' || row.student_id !== event.student_id || row.visit_id !== event.visit_id || row.reason !== event.reason || row.created_at !== event.received_at) fail('REVIEW_EVENT_REFERENCE');
    if (row.status === 'pending') { if (row.resolved_at !== null || row.resolved_by !== null || row.resolution !== null) fail('PENDING_REVIEW_STATE'); }
    else if (row.status === 'resolved') {
      if (typeof row.resolution !== 'string' || row.resolution.trim().length < 5 || row.resolved_at === null || String(row.resolved_at) < String(row.created_at) || String(row.resolved_at) > manifest.createdAt || row.resolved_by === null) fail('RESOLVED_REVIEW_STATE');
      await reference('staff', row.resolved_by);
    }
    else fail('INVALID_REVIEW_STATUS');
  }
  if (table === 'audit_entries') {
    await reference('staff', row.actor_id); jsonObject(row.detail);
    const target = ({ attendance_event: 'attendance_events', visit: 'visits', review: 'reviews' } as const)[String(row.entity_type) as 'visit'];
    if (!target || String(row.created_at) > manifest.createdAt) fail('AUDIT_SCOPE');
    await reference(target, row.entity_id);
    if (['check_in', 'check_out', 'exceptional_departure'].includes(String(row.action))) {
      const event = await requireRecord('attendance_events', row.id);
      await auditFor({ table: 'attendance_events', key: String(row.id), row: event });
    } else if (row.action === 'attendance_correction') {
      const correction = await requireRecord('attendance_corrections', row.id);
      await auditFor({ table: 'attendance_corrections', key: String(row.id), row: correction });
    }
    if (row.action === 'review_resolved') {
      const review = await requireRecord('reviews', row.entity_id), detail = jsonObject(row.detail);
      // The current route logs repeat resolution attempts even when the
      // already-resolved row does not change. Keep those attempts as evidence.
      if (row.entity_type !== 'review' || review.status !== 'resolved' || Object.keys(detail).length !== 1 || typeof detail.resolution !== 'string' || detail.resolution.trim().length < 5 || String(row.created_at) < String(review.resolved_at)) fail('REVIEW_AUDIT_MISMATCH');
      if (matchesResolutionWitness(row, review)) resolutionWitness = { reviewId: String(review.id), auditKey: record.key };
    }
  }
  return { operation: semanticOperation(record), resolutionWitness };
}
