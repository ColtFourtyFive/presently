import { describe, expect, it } from 'vitest';
import type { VisitSummary } from '../shared/types.js';
import { changedFields, correctionPayload, editedTime, fieldsMatch, localTimeInput } from '../client/management-state.js';

describe('manager edit state', () => {
  it('sends only edited fields so unrelated newer data is not overwritten', () => {
    expect(changedFields({ grade: '3', subjects: ['Math'], active: true }, { grade: '4', subjects: ['Math'], active: true }, ['grade', 'subjects', 'active'])).toEqual({ grade: '4' });
    expect(fieldsMatch({ grade: '4', subjects: ['Reading'] }, { grade: '4' })).toBe(true);
    expect(fieldsMatch({ grade: '5' }, { grade: '4' })).toBe(false);
  });
  it('preserves exact original instants for untouched fields, including subsecond values', () => {
    const original = '2025-11-02T09:30:01.823Z'; expect(editedTime(localTimeInput(original), original)).toBe(original);
  });
  it('does not invent departure for an open visit and rejects unchanged/future/reversed corrections', () => {
    const visit = { id: 'visit', version: 3, checkInAt: '2025-01-05T12:00:00.823Z', checkOutAt: null } as VisitSummary;
    const changed = localTimeInput('2025-01-05T11:59:00.000Z');
    expect(correctionPayload(visit, changed, '2025-01-05T13:00:00', 'Factual correction.', 'request')).toMatchObject({ expectedVersion: 3, checkOutAt: null });
    expect(() => correctionPayload(visit, localTimeInput(visit.checkInAt), '', 'Factual correction.', 'request')).toThrow('Change at least');
    expect(() => correctionPayload(visit, localTimeInput(new Date(Date.now() + 60000).toISOString()), '', 'Factual correction.', 'request')).toThrow('future');
    expect(() => correctionPayload({ ...visit, checkOutAt: '2025-01-05T13:00:00Z' }, localTimeInput('2025-01-05T14:00:00Z'), localTimeInput('2025-01-05T13:00:00Z'), 'Factual correction.', 'request')).toThrow('before arrival');
  });
});
