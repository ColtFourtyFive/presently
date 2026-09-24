import type { CorrectionInput, Guardian, Student, VisitSummary } from '../shared/types';

export const studentFields = ['firstName', 'lastName', 'grade', 'subjects', 'pickupAlert', 'active'] as const;
export const guardianFields = ['displayName', 'relationship', 'phone', 'email', 'pickupAuthority', 'authorityNote'] as const;
export type StudentEdit = Pick<Student, typeof studentFields[number]>;
export type GuardianEdit = Omit<Guardian, 'id'>;
export function changedFields<T extends object>(before: T, after: T, keys: readonly (keyof T)[]): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of keys) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  return patch;
}
export function fieldsMatch<T extends object>(record: T, patch: Partial<T>) {
  return (Object.keys(patch) as (keyof T)[]).every(key => JSON.stringify(record[key]) === JSON.stringify(patch[key]));
}
export function localTimeInput(value: string) {
  const date = new Date(value), pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function editedTime(input: string, original: string) {
  // Preserve subsecond precision and the original DST offset on an unchanged
  // field. A second-field correction must not silently move the first field.
  if (input === localTimeInput(original)) return original;
  const parsed = new Date(input);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(input) || !Number.isFinite(parsed.getTime()) || localTimeInput(parsed.toISOString()) !== (input.length === 16 ? `${input}:00` : input))
    throw new Error('Enter a valid local date and time. Times skipped by daylight saving are not valid.');
  return parsed.toISOString();
}
export function correctionPayload(visit: VisitSummary, arrival: string, departure: string, reason: string, correctionId: string): CorrectionInput {
  const checkInAt = editedTime(arrival, visit.checkInAt), checkOutAt = visit.checkOutAt ? editedTime(departure, visit.checkOutAt) : null;
  if (Date.parse(checkInAt) > Date.now() || checkOutAt && Date.parse(checkOutAt) > Date.now()) throw new Error('Corrected times cannot be in the future.');
  if (checkOutAt && Date.parse(checkOutAt) < Date.parse(checkInAt)) throw new Error('Departure cannot be before arrival.');
  if (Date.parse(checkInAt) === Date.parse(visit.checkInAt) && (checkOutAt === null ? visit.checkOutAt === null : Date.parse(checkOutAt) === Date.parse(visit.checkOutAt!))) throw new Error('Change at least one recorded time.');
  if (reason.trim().length < 5 || reason.trim().length > 2000) throw new Error('Explain the factual correction in 5 to 2,000 characters.');
  return { correctionId, expectedVersion: visit.version, checkInAt, checkOutAt, reason: reason.trim() };
}
