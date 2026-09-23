import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveMetadata, type ArchiveRecord } from '../shared/archive-format';
import { archiveObjectPrefix, compareArchiveRecords, createArchive, openArchiveManifest, verifyArchivePart } from '../worker/archive-codec';
import { bytes64, digest, from64, newHeader, sealPart } from '../worker/backup-crypto';
import { loadManifestRecordEvidence, type ArchiveEvidenceObject, type ArchiveManifestRecordSelection, type ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';
import { nativeSemanticFixture } from './archive-semantic-fixture';

const encoder = new TextEncoder(), failure = 'ARCHIVE_RECORD_EVIDENCE_UNAVAILABLE';
const sha = (value: unknown) => digest(encoder.encode(JSON.stringify(value)));
let runtime: Miniflare, bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
let source: Awaited<ReturnType<typeof nativeSemanticFixture>>, base: Awaited<ReturnType<typeof seal>>;

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
async function selection(bundle = base, record = bundle.records.find(record => record.table === 'attendance_events' && record.row.visit_id !== null)!) {
  const { parts: _parts, ...header } = bundle.manifest;
  return {
    reference: { archiveId: bundle.manifest.archiveId, kind: bundle.manifest.kind, manifestObjectKey: bundle.objectKey, manifestSha256: bundle.sha256 },
    centerId: bundle.manifest.centerId, month: bundle.manifest.month, timezone: bundle.manifest.timezone,
    headerSha256: await sha(header), table: record.table, recordKey: record.key,
  } satisfies ArchiveManifestRecordSelection;
}
function selectedPart(selected: ArchiveManifestRecordSelection, bundle = base) {
  const position = { table: selected.table, key: selected.recordKey };
  return bundle.manifest.parts.find(part => compareArchiveRecords(part.first, position) <= 0 && compareArchiveRecords(part.last, position) >= 0)!;
}
function counted(transform?: (object: ArchiveEvidenceObject | null, key: string, count: number) => Promise<ArchiveEvidenceObject | null> | ArchiveEvidenceObject | null) {
  const calls: string[] = [];
  const storage: ArchiveRecordEvidenceStorage = { masterKey: source.key, bucket: {
    async get(key) { calls.push(key); const object = await bucket.get(key); return transform ? transform(object, key, calls.length) : object; },
  } };
  return { calls, storage };
}

// Seal raw JSON with the real archive key domain. Invalid manifests therefore
// pass envelope authentication and reference hashes before schema validation.
async function authenticatedManifest(manifest: ArchiveManifest) {
  const master = await crypto.subtle.importKey('raw', from64(source.key) as BufferSource, 'HKDF', false, ['deriveBits']);
  const domain = bytes64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(ARCHIVE_FORMAT), info: encoder.encode('history-only-encryption-domain') }, master, 256)));
  const encrypted = await sealPart(domain, encoder.encode(JSON.stringify(manifest)), newHeader(manifest.archiveId, -1));
  const sha256 = await digest(encrypted), objectKey = `${archiveObjectPrefix(manifest)}manifest-${sha256}.kca`;
  await bucket.put(objectKey, encrypted);
  return { ...base, manifest, encrypted, sha256, objectKey };
}

beforeAll(async () => {
  source = await nativeSemanticFixture(2);
  runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated manifest evidence"); } };', compatibilityDate: '2026-06-11', r2Buckets: { EVIDENCE: 'isolated-manifest-evidence' } });
  await runtime.ready; bucket = await runtime.getR2Bucket('EVIDENCE');
  const student = source.records.find(record => record.table === 'students')!;
  const extra: ArchiveRecord[] = Array.from({ length: 260 }, (_, index) => {
    const id = `extra-student-${String(index).padStart(3, '0')}`;
    return { table: 'students', key: id, row: { ...student.row, id, student_code: id } };
  });
  base = await seal([...source.records, ...extra]);
}, 60_000);
afterAll(async () => { await runtime?.dispose(); });

describe('manifest-selected exact evidence with real local R2', () => {
  it('preserves native events, corrections, and literal-null receipts with exactly two GETs', async () => {
    const records = source.records.filter(record => record.table === 'attendance_events' || record.table === 'attendance_corrections');
    expect(records.some(record => record.table === 'attendance_corrections')).toBe(true);
    expect(records.some(record => record.row.result_visit === 'null')).toBe(true);
    for (const record of records) {
      const selected = await selection(base, record), request = counted();
      expect(await loadManifestRecordEvidence(request.storage, selected)).toEqual(record);
      expect(request.calls).toEqual([base.objectKey, selectedPart(selected).objectKey]);
    }
  });

  it('includes exact first and last keys in every part, including both sides of a boundary', async () => {
    expect(base.manifest.parts.length).toBeGreaterThan(1);
    for (const part of base.manifest.parts) for (const position of [part.first, part.last]) {
      const record = base.records.find(record => compareArchiveRecords(record, position) === 0)!;
      const request = counted();
      expect(await loadManifestRecordEvidence(request.storage, await selection(base, record))).toEqual(record);
      expect(request.calls).toEqual([base.objectKey, part.objectKey]);
    }
  });

  it('snapshots all selection fields and the nested reference before the first fetch', async () => {
    const selected = await selection(), original = structuredClone(selected), part = selectedPart(selected);
    const expected = base.records.find(record => record.table === selected.table && record.key === selected.recordKey)!;
    const request = counted((object, _key, count) => {
      if (count === 1) {
        selected.reference.archiveId = 'changed'; selected.reference.manifestSha256 = '0'.repeat(64);
        selected.reference.manifestObjectKey = 'untrusted/object'; selected.reference.kind = 'addendum';
        selected.recordKey = 'changed'; selected.table = 'students'; selected.headerSha256 = '0'.repeat(64);
        selected.centerId = 'changed'; selected.month = '2026-09'; selected.timezone = 'UTC';
      }
      return object;
    });
    expect(await loadManifestRecordEvidence(request.storage, selected)).toEqual(expected);
    expect(request.calls).toEqual([original.reference.manifestObjectKey, part.objectKey]);
  });

  it('rejects malformed selections and out-of-scope object paths before I/O', async () => {
    const original = await selection();
    const variants: unknown[] = [
      null, { ...original, ignored: true }, { ...original, recordKey: '' }, { ...original, recordKey: 'a'.repeat(1025) },
      { ...original, table: 'passwords' }, { ...original, month: '2025-13' }, { ...original, timezone: '' },
      { ...original, timezone: 'x'.repeat(101) }, { ...original, centerId: '../escape' },
      { ...original, headerSha256: 'A'.repeat(64) }, { ...original, reference: null },
      { ...original, reference: { ...original.reference, ignored: true } },
      { ...original, reference: { ...original.reference, archiveId: '../escape' } },
      { ...original, reference: { ...original.reference, manifestSha256: 'A'.repeat(64) } },
      { ...original, reference: { ...original.reference, manifestObjectKey: 'private/other-object' } },
      { ...original, reference: { ...original.reference, kind: 'addendum' } },
      { ...original, centerId: 'other-center' },
    ];
    for (const changed of variants) {
      const request = counted();
      await expect(loadManifestRecordEvidence(request.storage, changed as ArchiveManifestRecordSelection)).rejects.toEqual(new Error(failure));
      expect(request.calls).toEqual([]);
    }
  });

  it('checks authenticated header and scope before fetching a part', async () => {
    const original = await selection(), { parts: _parts, ...header } = base.manifest;
    for (const changed of [
      { ...original, timezone: 'Pacific/Honolulu' }, { ...original, headerSha256: '0'.repeat(64) },
      { ...original, headerSha256: await sha(Object.fromEntries(Object.entries(header).reverse())) },
    ]) {
      const request = counted();
      await expect(loadManifestRecordEvidence(request.storage, changed)).rejects.toThrow(failure);
      expect(request.calls).toEqual([base.objectKey]);
    }
    for (const override of [{ centerId: 'other-center' }, { month: '2025-02' }]) {
      const changed = { ...original, ...override, reference: { ...original.reference } };
      changed.reference.manifestObjectKey = `${archiveObjectPrefix({ ...changed, archiveId: changed.reference.archiveId })}manifest-${changed.reference.manifestSha256}.kca`;
      await bucket.put(changed.reference.manifestObjectKey, base.encrypted);
      const request = counted();
      await expect(loadManifestRecordEvidence(request.storage, changed)).rejects.toThrow(failure);
      expect(request.calls).toEqual([changed.reference.manifestObjectKey]);
    }
  });

  it('rejects v1 and an authenticated addendum beneath a monthly reference before part reads', async () => {
    const v1 = await seal([source.records.find(record => record.table === 'centers')!], {}, true);
    const addendum = await seal(source.records, { kind: 'addendum', references: [(await selection()).reference] });
    for (const bundle of [v1, addendum]) {
      const selected = await selection(bundle, bundle.records[0]); selected.reference.kind = 'monthly';
      const request = counted();
      await expect(loadManifestRecordEvidence(request.storage, selected)).rejects.toThrow(failure);
      expect(request.calls).toEqual([bundle.objectKey]);
    }
  });

  it('reads one candidate part for an absent key inside its range and no part outside every range', async () => {
    const original = await selection();
    const inside = { ...original, table: 'students' as const, recordKey: 'extra-student-000a' };
    expect(base.records.some(record => record.key === inside.recordKey)).toBe(false);
    expect(selectedPart(inside)).toBeDefined();
    const request = counted();
    await expect(loadManifestRecordEvidence(request.storage, inside)).rejects.toThrow(failure);
    expect(request.calls).toEqual([base.objectKey, selectedPart(inside).objectKey]);
    for (const changed of [
      { ...original, table: 'centers' as const, recordKey: 'aaa-before-center' },
      { ...original, table: 'audit_entries' as const, recordKey: 'zzzz-after-last' },
    ]) {
      expect(selectedPart(changed)).toBeUndefined();
      const outside = counted();
      await expect(loadManifestRecordEvidence(outside.storage, changed)).rejects.toThrow(failure);
      expect(outside.calls).toEqual([base.objectKey]);
    }
  });

  it.each(['overlap', 'reversed-range', 'unknown-descriptor-field', 'monthly-reference', 'too-many-parts'] as const)('rejects authenticated malformed %s directories before a part fetch', async mode => {
    const manifest = structuredClone(base.manifest);
    if (mode === 'overlap') manifest.parts[1].first = structuredClone(manifest.parts[0].last);
    if (mode === 'reversed-range') [manifest.parts[0].first, manifest.parts[0].last] = [manifest.parts[0].last, manifest.parts[0].first];
    if (mode === 'unknown-descriptor-field') Object.assign(manifest.parts[0], { ignored: true });
    if (mode === 'monthly-reference') manifest.references.push((await selection()).reference);
    if (mode === 'too-many-parts') manifest.parts = Array.from({ length: ARCHIVE_LIMITS.parts + 1 }, () => structuredClone(manifest.parts[0]));
    const bundle = await authenticatedManifest(manifest), selected = await selection(bundle), request = counted();
    // A second independent codec open pins this to an authenticated schema or
    // ordering rejection rather than a substituted ciphertext checksum.
    await expect(openArchiveManifest(source.key, bundle.encrypted, selected.reference)).rejects.toThrow(/duplicate|range|fields|references|too many parts/);
    await expect(loadManifestRecordEvidence(request.storage, selected)).rejects.toThrow(failure);
    expect(request.calls).toEqual([bundle.objectKey]);
  });

  it('rejects a codec-valid target with an unsupported semantic row shape', async () => {
    const student = structuredClone(source.records.find(record => record.table === 'students')!);
    delete student.row.updated_at;
    const bundle = await seal([student]), selected = await selection(bundle, student), part = selectedPart(selected, bundle);
    expect(await verifyArchivePart(source.key, bundle.manifest, part, bundle.objects.get(part.objectKey)!)).toEqual([student]);
    const request = counted();
    await expect(loadManifestRecordEvidence(request.storage, selected)).rejects.toThrow(failure);
    expect(request.calls).toEqual([bundle.objectKey, part.objectKey]);
  });

  it('fails closed on absent, corrupted, and truncated manifest or part ciphertext', async () => {
    const selected = await selection(), partKey = selectedPart(selected).objectKey;
    for (const key of [base.objectKey, partKey]) {
      const bytes = base.objects.get(key)!;
      try {
        for (const mode of ['absent', 'corrupt', 'truncated'] as const) {
          if (mode === 'absent') await bucket.delete(key);
          else {
            const altered = mode === 'truncated' ? bytes.slice(0, bytes.length - 1) : bytes.slice();
            if (mode === 'corrupt') altered[altered.length - 1] ^= 1;
            await bucket.put(key, altered);
          }
          const request = counted();
          await expect(loadManifestRecordEvidence(request.storage, selected)).rejects.toEqual(new Error(failure));
          expect(request.calls).toEqual(key === base.objectKey ? [key] : [base.objectKey, key]);
        }
      } finally { await bucket.put(key, bytes); }
    }
  });

  it.each(['invalid-size', 'over-limit', 'declared-short', 'declared-long', 'stream-short', 'stream-extra'] as const)('bounds manifest and part objects for %s', async mode => {
    const selected = await selection();
    for (const target of [1, 2]) {
      let bodyCancelled = false, readerCancelled = false, released = false, opened = false;
      const request = counted(async (object, key, count) => {
        if (!object || count !== target) return object;
        await object.body.cancel();
        const bytes = base.objects.get(key)!;
        const chunks = mode === 'stream-short' ? [bytes.slice(0, bytes.length - 1)] : mode === 'stream-extra' ? [bytes, new Uint8Array([1])] : [bytes];
        let index = 0;
        return {
          size: mode === 'invalid-size' ? NaN : mode === 'over-limit' ? (target === 1 ? ARCHIVE_LIMITS.encryptedManifestBytes : ARCHIVE_LIMITS.encryptedPartBytes) + 1 : bytes.length + (mode === 'declared-short' ? -1 : mode === 'declared-long' ? 1 : 0),
          body: {
            async cancel() { bodyCancelled = true; },
            getReader() { opened = true; return {
              async read() { return index < chunks.length ? { done: false as const, value: chunks[index++] } : { done: true as const }; },
              async cancel() { readerCancelled = true; },
              releaseLock() { released = true; },
            }; },
          },
        };
      });
      await expect(loadManifestRecordEvidence(request.storage, selected)).rejects.toEqual(new Error(failure));
      expect(request.calls).toHaveLength(target);
      const rejectedSize = mode === 'invalid-size' || mode === 'over-limit' || target === 2 && (mode === 'declared-short' || mode === 'declared-long');
      expect(bodyCancelled).toBe(rejectedSize); expect(opened).toBe(!rejectedSize);
      expect(readerCancelled).toBe(!rejectedSize); expect(released).toBe(!rejectedSize);
    }
  });

  it('normalizes transport and wrong-key failures without exposing storage details', async () => {
    const selected = await selection();
    for (const target of [1, 2]) {
      const request = counted((_object, _key, count) => { if (count === target) throw new Error(`secret-token ${source.key}`); return _object; });
      await expect(loadManifestRecordEvidence(request.storage, selected)).rejects.toEqual(new Error(failure));
      expect(request.calls).toHaveLength(target);
    }
    const wrongKey = counted(); wrongKey.storage.masterKey = randomBytes(32).toString('base64');
    await expect(loadManifestRecordEvidence(wrongKey.storage, selected)).rejects.toEqual(new Error(failure));
    expect(wrongKey.calls).toEqual([base.objectKey]);
  });
});
