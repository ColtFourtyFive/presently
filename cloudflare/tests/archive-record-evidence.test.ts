import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { ARCHIVE_LIMITS, type ArchiveMetadata, type ArchiveRecord } from '../shared/archive-format';
import { archiveObjectPrefix, compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { digest } from '../worker/backup-crypto';
import { loadArchiveRecordEvidence, type ArchiveRecordEvidenceLocator, type ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';
import { nativeSemanticFixture } from './archive-semantic-fixture';

const encoder = new TextEncoder(), failure = 'ARCHIVE_RECORD_EVIDENCE_UNAVAILABLE';
const sha = (value: unknown) => digest(encoder.encode(JSON.stringify(value)));
let runtime: Miniflare, bucket: R2Bucket, source: Awaited<ReturnType<typeof nativeSemanticFixture>>, base: Awaited<ReturnType<typeof seal>>;
async function seal(records: ArchiveRecord[], override: Partial<ArchiveMetadata> = {}, v1 = false) {
  const metadata: ArchiveMetadata = { ...source.metadata, archiveId: crypto.randomUUID(), ...override };
  if (v1) delete metadata.semanticProof;
  const objects = new Map<string, Uint8Array>();
  const sealed = await createArchive(source.key, metadata, [...records].sort(compareArchiveRecords), async (part, bytes) => {
    objects.set(part.objectKey, bytes); await bucket.put(part.objectKey, bytes);
  });
  objects.set(sealed.objectKey, sealed.encrypted); await bucket.put(sealed.objectKey, sealed.encrypted);
  return { ...sealed, records, objects };
}
async function locator(bundle = base, record = bundle.records.find(record => record.table === 'attendance_events' && record.row.visit_id !== null)!) {
  const { parts, ...header } = bundle.manifest;
  const part = parts.find(part => compareArchiveRecords(part.first, record) <= 0 && compareArchiveRecords(part.last, record) >= 0)!;
  return {
    reference: { archiveId: bundle.manifest.archiveId, kind: bundle.manifest.kind, manifestObjectKey: bundle.objectKey, manifestSha256: bundle.sha256 },
    centerId: bundle.manifest.centerId, month: bundle.manifest.month, timezone: bundle.manifest.timezone,
    headerSha256: await sha(header), partIndex: part.index, descriptorSha256: await sha(part),
    table: record.table, recordKey: record.key, recordSha256: await sha(record), recordBytes: encoder.encode(JSON.stringify(record)).length,
  } satisfies ArchiveRecordEvidenceLocator;
}
function counted(transform?: (object: R2ObjectBody | null, key: string, count: number) => Promise<R2ObjectBody | null> | R2ObjectBody | null) {
  const calls: string[] = [];
  const storage: ArchiveRecordEvidenceStorage = { masterKey: source.key, bucket: {
    get: async (key: string) => { calls.push(key); const object = await bucket.get(key); return transform ? transform(object, key, calls.length) : object; },
  } as Pick<R2Bucket, 'get'> };
  return { calls, storage };
}
beforeAll(async () => {
  source = await nativeSemanticFixture(2);
  runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated archive evidence"); } };', compatibilityDate: '2026-06-11', r2Buckets: { EVIDENCE: 'isolated-record-evidence' } });
  await runtime.ready;
  bucket = await runtime.getR2Bucket('EVIDENCE') as unknown as R2Bucket;
  const student = source.records.find(record => record.table === 'students')!;
  const extra: ArchiveRecord[] = Array.from({ length: 260 }, (_, index) => {
    const id = `extra-student-${String(index).padStart(3, '0')}`;
    return { table: 'students', key: id, row: { ...student.row, id, student_code: id } };
  });
  base = await seal([...source.records, ...extra]);
}, 60_000);
afterAll(async () => { await runtime?.dispose(); });

describe('internal exact archived-record evidence loader with real local R2', () => {
  it('reads only the pinned manifest and indexed part and preserves original event/correction/null evidence', async () => {
    expect(base.manifest.parts.length).toBeGreaterThan(1);
    for (const record of [
      source.records.find(record => record.table === 'attendance_events' && record.row.visit_id !== null)!,
      source.records.find(record => record.table === 'attendance_events' && record.row.visit_id === null)!,
      source.records.find(record => record.table === 'attendance_corrections')!,
    ]) {
      const selected = await locator(base, record), request = counted();
      const loaded = await loadArchiveRecordEvidence(request.storage, selected);
      expect(loaded).toEqual(record);
      expect(request.calls).toEqual([base.objectKey, base.manifest.parts[selected.partIndex].objectKey]);
      expect(selected.partIndex).toBeGreaterThan(0);
      if (record.table === 'attendance_events') expect(loaded.row.result_visit).toBe(record.row.result_visit);
      expect(loaded.row.payload_hash).toBe(record.row.payload_hash);
    }
  });

  it('snapshots locator and nested reference before the first asynchronous fetch', async () => {
    const selected = await locator(), original = structuredClone(selected);
    const expected = base.records.find(record => record.table === selected.table && record.key === selected.recordKey)!;
    const request = counted((object, _key, count) => {
      if (count === 1) {
        selected.reference.archiveId = 'changed'; selected.reference.manifestSha256 = '0'.repeat(64);
        selected.recordKey = 'changed'; selected.recordSha256 = '0'.repeat(64); selected.recordBytes = 1;
        selected.partIndex = 0; selected.headerSha256 = '0'.repeat(64); selected.centerId = 'changed';
      }
      return object;
    });
    expect(await loadArchiveRecordEvidence(request.storage, selected)).toEqual(expected);
    expect(request.calls).toEqual([original.reference.manifestObjectKey, base.manifest.parts[original.partIndex].objectKey]);
  });

  it('rejects malformed locators and out-of-scope root paths before any fetch', async () => {
    const original = await locator();
    const variants: ArchiveRecordEvidenceLocator[] = [
      { ...original, partIndex: -1 }, { ...original, partIndex: ARCHIVE_LIMITS.parts },
      { ...original, recordBytes: ARCHIVE_LIMITS.recordBytes + 1 }, { ...original, recordKey: '' },
      { ...original, recordSha256: original.recordSha256.toUpperCase() },
      { ...original, reference: { ...original.reference, manifestObjectKey: 'private/other-object' } },
      { ...original, centerId: 'other-center' },
      { ...original, reference: { ...original.reference, kind: 'addendum' } },
    ];
    for (const changed of variants) {
      const request = counted();
      await expect(loadArchiveRecordEvidence(request.storage, changed)).rejects.toThrow(failure);
      expect(request.calls).toEqual([]);
    }
  });

  it('checks authenticated scope/header/descriptor before fetching a part', async () => {
    const original = await locator();
    const variants: ArchiveRecordEvidenceLocator[] = [
      { ...original, timezone: 'Pacific/Honolulu' }, { ...original, headerSha256: '0'.repeat(64) },
      { ...original, descriptorSha256: '0'.repeat(64) }, { ...original, partIndex: 511 },
      { ...original, partIndex: 0 },
    ];
    for (const changed of variants) {
      const request = counted();
      await expect(loadArchiveRecordEvidence(request.storage, changed)).rejects.toThrow(failure);
      expect(request.calls).toEqual([base.objectKey]);
    }
    const crossScope = { ...original, centerId: 'other-center', reference: { ...original.reference, manifestObjectKey: `${archiveObjectPrefix({ centerId: 'other-center', month: original.month, archiveId: original.reference.archiveId })}manifest-${original.reference.manifestSha256}.kca` } };
    await bucket.put(crossScope.reference.manifestObjectKey, base.encrypted);
    const request = counted();
    await expect(loadArchiveRecordEvidence(request.storage, crossScope)).rejects.toThrow(failure);
    expect(request.calls).toEqual([crossScope.reference.manifestObjectKey]);
  });

  it('rejects v1 and addendum profiles before part reads and keeps monthly references forbidden', async () => {
    const center = source.records.find(record => record.table === 'centers')!;
    const v1 = await seal([center], {}, true), dependency = (await locator()).reference;
    const addendum = await seal(source.records, { kind: 'addendum', references: [dependency] });
    await expect(seal(source.records, { references: [dependency] })).rejects.toThrow('invalid parent/addendum references');
    for (const bundle of [v1, addendum]) {
      const selected = await locator(bundle, bundle.records[0]);
      // A future publisher only issues monthly locators; an actual addendum
      // cannot be substituted beneath that declared identity.
      selected.reference.kind = 'monthly';
      const request = counted();
      await expect(loadArchiveRecordEvidence(request.storage, selected)).rejects.toThrow(failure);
      expect(request.calls).toEqual([bundle.objectKey]);
    }
  });

  it('fails closed on missing or corrupt ciphertext and incorrect master keys', async () => {
    const selected = await locator(), partKey = base.manifest.parts[selected.partIndex].objectKey;
    for (const key of [base.objectKey, partKey]) {
      const bytes = base.objects.get(key)!;
      try {
        await bucket.delete(key);
        const missing = counted();
        await expect(loadArchiveRecordEvidence(missing.storage, selected)).rejects.toThrow(failure);
        expect(missing.calls).toEqual(key === base.objectKey ? [key] : [base.objectKey, key]);
        const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 1; await bucket.put(key, corrupt);
        const tampered = counted();
        await expect(loadArchiveRecordEvidence(tampered.storage, selected)).rejects.toThrow(failure);
        expect(tampered.calls).toEqual(missing.calls);
      } finally { await bucket.put(key, bytes); }
    }
    const request = counted(); request.storage.masterKey = randomBytes(32).toString('base64');
    await expect(loadArchiveRecordEvidence(request.storage, selected)).rejects.toThrow(failure);
    expect(request.calls).toEqual([base.objectKey]);
  });

  it('rejects absent targets, wrong tables, byte counts and row digests after exactly one part', async () => {
    const original = await locator();
    for (const changed of [
      { ...original, recordKey: crypto.randomUUID() }, { ...original, table: 'students' as const },
      { ...original, recordBytes: original.recordBytes + 1 }, { ...original, recordSha256: '0'.repeat(64) },
      { ...original, recordSha256: await digest(encoder.encode(JSON.stringify(base.records.find(record => record.table === original.table && record.key === original.recordKey)) + '\n')) },
    ]) {
      const request = counted();
      await expect(loadArchiveRecordEvidence(request.storage, changed)).rejects.toThrow(failure);
      expect(request.calls).toEqual([base.objectKey, base.manifest.parts[original.partIndex].objectKey]);
    }
  });

  it('preserves standard-base64 and explicitly declared lowercase-hex request fingerprints without rewriting them', async () => {
    const records = structuredClone(source.records);
    for (const record of records) if (record.table === 'attendance_events' || record.table === 'attendance_corrections') record.row.payload_hash = Buffer.from(String(record.row.payload_hash), 'base64').toString('hex');
    const hex = await seal(records, { semanticProof: { ...source.metadata.semanticProof!, payloadHashEncoding: 'base64-or-hex' } });
    for (const bundle of [base, hex]) for (const table of ['attendance_events', 'attendance_corrections'] as const) {
      const record = bundle.records.find(record => record.table === table)!;
      const request = counted();
      expect(await loadArchiveRecordEvidence(request.storage, await locator(bundle, record))).toEqual(record);
      expect(request.calls).toHaveLength(2);
    }
  });

  it('uses UTF-8 byte lengths and the original compact-header property order', async () => {
    const student = structuredClone(source.records.find(record => record.table === 'students')!);
    student.row.first_name = 'Zoë 学生';
    const bundle = await seal([source.records.find(record => record.table === 'centers')!, student]);
    const selected = await locator(bundle, student), request = counted();
    expect(selected.recordBytes).toBeGreaterThan(JSON.stringify(student).length);
    expect(await loadArchiveRecordEvidence(request.storage, selected)).toEqual(student);
    await expect(loadArchiveRecordEvidence(counted().storage, { ...selected, recordBytes: JSON.stringify(student).length })).rejects.toThrow(failure);
    const { parts: _parts, ...header } = bundle.manifest;
    const reordered = Object.fromEntries(Object.entries(header).reverse());
    const mismatched = counted();
    await expect(loadArchiveRecordEvidence(mismatched.storage, { ...selected, headerSha256: await sha(reordered) })).rejects.toThrow(failure);
    expect(mismatched.calls).toEqual([bundle.objectKey]);
  });

  it('bounds declared sizes and checks actual stream lengths including overflowing chunks', async () => {
    const selected = await locator();
    for (const target of [1, 2]) for (const mode of ['understated', 'overstated', 'over-limit', 'extra-chunk'] as const) {
      let cancelled = false;
      const request = counted(async (object, _key, count) => {
        if (!object || count !== target) return object;
        if (mode === 'extra-chunk') {
          const bytes = new Uint8Array(await object.arrayBuffer()); let step = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) { if (step++ === 0) controller.enqueue(bytes); else controller.enqueue(new Uint8Array([1])); },
            cancel() { cancelled = true; },
          });
          return { size: bytes.length, body } as R2ObjectBody;
        }
        return { size: mode === 'over-limit' ? ARCHIVE_LIMITS.encryptedPartBytes + ARCHIVE_LIMITS.encryptedManifestBytes : object.size + (mode === 'understated' ? -1 : 1), body: object.body } as R2ObjectBody;
      });
      await expect(loadArchiveRecordEvidence(request.storage, selected)).rejects.toThrow(failure);
      expect(request.calls).toHaveLength(target);
      if (mode === 'extra-chunk') expect(cancelled).toBe(true);
    }
  });

  it('uses one clean failure for transport exceptions without leaking object/key details', async () => {
    const selected = await locator(), request = counted(() => { throw new Error(`secret-token ${source.key}`); });
    await expect(loadArchiveRecordEvidence(request.storage, selected)).rejects.toEqual(new Error(failure));
    expect(request.calls).toEqual([base.objectKey]);
  });
});
