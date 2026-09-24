import type { AttendanceAction, VisitSummary } from '../shared/types';

/** Version 2 freezes only values that cannot be recovered from the immutable event.
 * The tuple order is also defined in migration 0007 and must not change in place. */
export type CompactAttendanceReceipt = [
  2, string, string, 0 | 1, string, string, string, string | null, string | null, number,
];
export type ReceiptEvent = {
  visit_id: unknown; student_id: unknown; action: unknown; observed_at: unknown; result_visit: unknown;
};
const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown): value is string | null => value === null || text(value);

function visitShape(value: unknown): value is VisitSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['id','studentId','studentName','studentCode','checkInAt','originalCheckInAt','checkInBy'].every(key => text(row[key]))
    && ['checkOutAt','originalCheckOutAt','checkOutBy','guardianName'].every(key => nullableText(row[key]))
    && typeof row.active === 'boolean' && Number.isInteger(row.version) && Number(row.version) >= 1
    && (row.departureType === null || row.departureType === 'check_out' || row.departureType === 'exceptional_departure')
    && ['none','pending','resolved'].includes(String(row.reviewStatus));
}

export function decodeAttendanceReceipt(event: ReceiptEvent): VisitSummary | null {
  // SQL NULL means the atomic insert has not sealed its receipt. Text "null" is
  // the sealed, valid receipt for an observed departure with no matching visit.
  if (!text(event.result_visit)) throw new Error('Attendance receipt is not sealed.');
  const value: unknown = JSON.parse(event.result_visit);
  if (value === null) return null;
  if (!Array.isArray(value)) {
    if (!visitShape(value)) throw new Error('Invalid legacy attendance receipt.');
    return value;
  }
  if (value.length !== 10 || value[0] !== 2 || ![1,2,4,5,6].every(index => text(value[index]))
    || ![0,1].includes(value[3]) || !nullableText(value[7]) || !nullableText(value[8])
    || !Number.isInteger(value[9]) || value[9] < 1 || !text(event.visit_id) || !text(event.student_id)
    || !text(event.observed_at) || !['check_in','check_out','exceptional_departure'].includes(String(event.action))) {
    throw new Error('Unsupported or invalid compact attendance receipt.');
  }
  const receipt = value as CompactAttendanceReceipt;
  const action = event.action as AttendanceAction, departure = action !== 'check_in';
  return {
    id: event.visit_id, studentId: event.student_id, studentName: receipt[1], studentCode: receipt[2], active: receipt[3] === 1,
    checkInAt: receipt[4], checkOutAt: departure ? event.observed_at : null,
    originalCheckInAt: receipt[5], originalCheckOutAt: departure ? event.observed_at : null,
    checkInBy: receipt[6], checkOutBy: receipt[7], guardianName: receipt[8],
    departureType: departure ? action : null, reviewStatus: action === 'exceptional_departure' ? 'pending' : 'none', version: receipt[9],
  };
}
