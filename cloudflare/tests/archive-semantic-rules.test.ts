import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveRecord, type ArchiveRow, type ArchiveTable } from '../shared/archive-format';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { decodeAttendanceReceipt } from '../worker/attendance-receipt';
import { applyVisitOperation, finishVisitFold, initialVisitFold, matchesResolutionWitness, semanticOperation, validateSemanticRecord, validateSemanticShape, type SemanticContext, type SemanticLookup } from '../worker/archive-semantic-rules';
import { nativeSemanticFixture } from './archive-semantic-fixture';

let records: ArchiveRecord[], manifest: ArchiveManifest;
beforeAll(async () => {
  const fixture = await nativeSemanticFixture(2);
  records = fixture.records;
  manifest = (await createArchive(fixture.key, fixture.metadata, [...records].sort(compareArchiveRecords), async () => {})).manifest;
}, 60_000);

function lookup(source = records, context: SemanticContext = manifest): SemanticLookup {
  const find = async (table: ArchiveTable, key: unknown) => {
    if (typeof key !== 'string') throw new Error('Invalid historical evidence: INVALID_REFERENCE');
    const record = source.find(record => record.table === table && record.key === key) ?? null;
    if (record) validateSemanticShape(record, context, table, key);
    return record;
  };
  return { find, localGet: find };
}
function selected(table: ArchiveTable, predicate: (record: ArchiveRecord) => boolean = () => true) {
  return structuredClone(records.find(record => record.table === table && predicate(record))!);
}
function operations(visitId: string) {
  return records.filter(record => ['attendance_events', 'attendance_corrections'].includes(record.table) && record.row.visit_id === visitId)
    .map(record => structuredClone(record)).sort((left, right) => semanticOperation(left)!.version - semanticOperation(right)!.version);
}
function decodedReceipt(record: ArchiveRecord) {
  const row = record.row;
  return decodeAttendanceReceipt({ visit_id: row.visit_id, student_id: row.student_id, action: row.action, observed_at: row.observed_at, result_visit: row.result_visit });
}

describe('shared authenticated archive semantic rules', () => {
  it('validates every native record and derives only actual operations and exact resolution witnesses', async () => {
    let operationCount = 0, witnessCount = 0;
    for (const record of records) {
      const result = await validateSemanticRecord(record, manifest, lookup());
      if (result.operation) {
        operationCount++;
        expect(result.operation).toMatchObject({ requestId: record.key, table: record.table, key: record.key, visitId: record.row.visit_id });
        expect(result.operation.bytes).toBe(new TextEncoder().encode(JSON.stringify(record)).length);
      }
      if (result.resolutionWitness) {
        witnessCount++;
        const review = records.find(row => row.table === 'reviews' && row.key === result.resolutionWitness!.reviewId)!;
        expect(matchesResolutionWitness(record.row, review.row)).toBe(true);
      }
    }
    expect(operationCount).toBe(records.filter(record => ['attendance_events', 'attendance_corrections'].includes(record.table) && record.row.visit_id !== null).length);
    expect(witnessCount).toBe(records.filter(record => record.table === 'reviews' && record.row.status === 'resolved').length);
  });

  it('retains sealed null observations while rejecting absent, malformed and wrongly attached null receipts', async () => {
    const unmatched = selected('attendance_events', record => record.row.visit_id === null);
    expect(unmatched.row.result_visit).toBe('null');
    expect((await validateSemanticRecord(unmatched, manifest, lookup())).operation).toBeNull();
    await expect(validateSemanticRecord({ ...unmatched, row: { ...unmatched.row, result_visit: null } }, manifest, lookup())).rejects.toThrow('INVALID_FIELD_TYPE');
    await expect(validateSemanticRecord({ ...unmatched, row: { ...unmatched.row, result_visit: '{' } }, manifest, lookup())).rejects.toThrow('UNSEALED_RECEIPT');
    const matched = selected('attendance_events', record => record.row.visit_id !== null);
    await expect(validateSemanticRecord({ ...matched, row: { ...matched.row, result_visit: 'null' } }, manifest, lookup())).rejects.toThrow('RECEIPT_REFERENCE');
    const decoded = decodedReceipt(matched)!;
    const original = await validateSemanticRecord(matched, manifest, lookup());
    matched.row.result_visit = JSON.stringify(decoded);
    expect((await validateSemanticRecord(matched, manifest, lookup())).operation).toMatchObject({ visitId: original.operation!.visitId, version: original.operation!.version });
    matched.row.result_visit = JSON.stringify({ ...decoded, extra: true });
    await expect(validateSemanticRecord(matched, manifest, lookup())).rejects.toThrow('RECEIPT_COLUMNS');
  });

  it('preserves declared fingerprint encoding and rejects versions that cannot be represented by a visit', async () => {
    const correction = selected('attendance_corrections');
    const hash = () => createHash('sha256').update(JSON.stringify({ visitId: correction.row.visit_id, expectedVersion: correction.row.expected_version, checkInAt: correction.row.check_in_at, checkOutAt: correction.row.check_out_at, reason: correction.row.reason })).digest('hex');
    correction.row.payload_hash = hash();
    await expect(validateSemanticRecord(correction, manifest, lookup())).rejects.toThrow('REQUEST_FINGERPRINT');
    const context = { ...manifest, semanticProof: { ...manifest.semanticProof!, payloadHashEncoding: 'base64-or-hex' as const } };
    expect((await validateSemanticRecord(correction, context, lookup(records, context))).operation?.version).toBe(Number(correction.row.expected_version) + 1);
    correction.row.expected_version = Number.MAX_SAFE_INTEGER;
    correction.row.payload_hash = hash();
    await expect(validateSemanticRecord(correction, context, lookup(records, context))).rejects.toThrow('INVALID_VERSION');
  });

  it('replays corrected visits through serializable checkpoints without changing receipt or final-state rules', () => {
    const visit = selected('visits', record => records.some(source => source.table === 'attendance_corrections' && source.row.visit_id === record.key));
    const steps = operations(visit.key);
    let state = initialVisitFold();
    for (const step of steps) state = JSON.parse(JSON.stringify(applyVisitOperation(state, visit.row, step)));
    expect(state.version).toBe(steps.length);
    expect(state.bytes).toBe(steps.reduce((total, step) => total + semanticOperation(step)!.bytes, 0));
    expect(() => finishVisitFold(state, visit.row, manifest)).not.toThrow();
    expect(() => finishVisitFold(state, { ...visit.row, version: Number(visit.row.version) + 1 }, manifest)).toThrow('VISIT_FINAL_STATE');
    expect(() => finishVisitFold(state, visit.row, { ...manifest, periodFrom: '2025-02-01T00:00:00.000Z' })).toThrow('ORIGINAL_MONTH_SCOPE');
    expect(() => finishVisitFold(initialVisitFold(), visit.row, manifest)).toThrow('MISSING_ARRIVAL');
    expect(() => applyVisitOperation(initialVisitFold(), visit.row, steps.at(-1)!)).toThrow('MISSING_ARRIVAL');
    const first = applyVisitOperation(initialVisitFold(), visit.row, steps[0]);
    const beforeCorrection = applyVisitOperation(first, visit.row, steps[1]);
    const correction = structuredClone(steps[2]);
    expect(() => applyVisitOperation(beforeCorrection, { ...visit.row, id: 'another-visit' }, correction)).toThrow('VISIT_EVENT_REFERENCE');
    correction.row.prior_check_in_at = '2025-01-10T17:59:00.000Z';
    expect(() => applyVisitOperation(beforeCorrection, visit.row, correction)).toThrow('CORRECTION_PRIOR_STATE');
    correction.row = { ...steps[2].row, expected_version: Number(steps[2].row.expected_version) + 1 };
    expect(() => applyVisitOperation(beforeCorrection, visit.row, correction)).toThrow('VISIT_VERSION_CHAIN');
    const departure = structuredClone(steps[1]), receipt = decodedReceipt(departure)!;
    departure.row.result_visit = JSON.stringify({ ...receipt, originalCheckInAt: '2025-01-10T17:59:00.000Z' });
    expect(() => applyVisitOperation(first, visit.row, departure)).toThrow('RECEIPT_ACCEPTED_STATE');
    expect(() => applyVisitOperation({ ...beforeCorrection, bytes: ARCHIVE_LIMITS.semanticVisitBytes }, visit.row, steps[2])).toThrow('VISIT_CLOSURE_BOUND');
    expect(() => applyVisitOperation({ ...beforeCorrection, version: ARCHIVE_LIMITS.semanticVisitOperations }, visit.row, steps[2])).toThrow('VISIT_CLOSURE_BOUND');
  });

  it('distinguishes the winning review resolution from later legitimate attempts and mismatched witnesses', async () => {
    const review = selected('reviews', record => record.row.status === 'resolved');
    const audit = selected('audit_entries', record => matchesResolutionWitness(record.row, review.row));
    expect((await validateSemanticRecord(audit, manifest, lookup())).resolutionWitness).toEqual({ reviewId: review.key, auditKey: audit.key });
    const changes: ArchiveRow[] = [{ actor_id: 'someone-else' }, { created_at: '2098-01-01T00:00:00.000Z' }, { detail: JSON.stringify({ resolution: 'Different valid explanation' }) }];
    for (const change of changes) {
      expect(matchesResolutionWitness({ ...audit.row, ...change }, review.row)).toBe(false);
    }
    const context = { ...manifest, createdAt: '2099-01-01T00:00:00.000Z' };
    const repeat = { ...audit, key: 'later-resolution', row: { ...audit.row, id: 'later-resolution', created_at: '2098-01-01T00:00:00.000Z', detail: JSON.stringify({ resolution: 'A later resolution attempt' }) } };
    expect((await validateSemanticRecord(repeat, context, lookup(records, context))).resolutionWitness).toBeNull();
    repeat.row.created_at = '2025-01-01T00:00:00.000Z';
    await expect(validateSemanticRecord(repeat, context, lookup(records, context))).rejects.toThrow('REVIEW_AUDIT_MISMATCH');
  });
});
