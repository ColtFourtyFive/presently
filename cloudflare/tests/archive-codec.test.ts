import { describe, expect, it } from 'vitest';
import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveMetadata, type ArchiveRecord, type ArchiveStagingSink } from '../shared/archive-format';
import { archiveRecordKey, calendarMonthBounds, compareArchiveRecords, createArchive, finalizeArchiveManifest, openArchiveManifest, sealArchiveManifest, sealArchivePart, validateArchiveManifest, verifyArchiveGraph, verifyArchivePart } from '../worker/archive-codec';
import { bytes64, digest, from64, newHeader, openPart, sealPart } from '../worker/backup-crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const key = bytes64(crypto.getRandomValues(new Uint8Array(32)));
const metadata = (extra: Partial<ArchiveMetadata> = {}): ArchiveMetadata => ({ archiveId: 'archive-1', centerId: 'center-1', month: '2026-03', timezone: 'America/Los_Angeles', kind: 'monthly', createdAt: '2026-04-02T10:00:00.000Z', applicationVersion: 'test-1', schemaVersions: [1, 2, 7], references: [], ...extra });
const record = (table: ArchiveRecord['table'], row: ArchiveRecord['row']): ArchiveRecord => ({ table, key: archiveRecordKey(table, row), row });
const student = (id: string): ArchiveRecord => record('students', { id, center_id: 'center-1', student_code: id, first_name: 'Synthetic', last_name: 'Fixture' });
const correction = (id: string, at = '2026-04-01T15:00:00.000Z'): ArchiveRecord => record('attendance_corrections', { id, center_id: 'center-1', visit_id: 'visit-1', expected_version: 1, prior_check_in_at: '2026-04-01T06:30:00.000Z', prior_check_out_at: '2026-04-01T07:10:00.000Z', check_in_at: '2026-04-01T06:25:00.000Z', check_out_at: '2026-04-01T07:15:00.000Z', reason: 'Clock correction', actor_id: 'staff-1', actor_name: 'Synthetic Staff', recorded_at: at, payload_hash: 'f'.repeat(64) });
const fixture = (): ArchiveRecord[] => [
  record('centers', { id: 'center-1', name: 'Synthetic Center', timezone: 'America/Los_Angeles' }), student('student-1'),
  record('guardians', { id: 'guardian-1', center_id: 'center-1', display_name: 'Synthetic Guardian' }),
  record('student_guardians', { student_id: 'student-1', guardian_id: 'guardian-1', relationship: 'Parent', pickup_authority: 'allowed' }),
  record('staff', { id: 'staff-1', center_id: 'center-1', display_name: 'Synthetic Staff' }),
  record('visits', { id: 'visit-1', center_id: 'center-1', student_id: 'student-1', check_in_at: '2026-04-01T06:25:00.000Z', check_out_at: '2026-04-01T07:15:00.000Z', original_check_in_at: '2026-04-01T06:30:00.000Z', original_check_out_at: '2026-04-01T07:10:00.000Z', check_in_by: 'staff-1', guardian_id: 'guardian-1', version: 2 }),
  record('attendance_events', { id: 'event-1', center_id: 'center-1', student_id: 'student-1', visit_id: 'visit-1', action: 'check_out', observed_at: '2026-04-01T07:10:00.000Z', received_at: '2026-04-01T07:10:02.000Z', actor_id: 'staff-1', actor_name: 'Synthetic Staff', payload_hash: 'a'.repeat(64), result_visit: '{"id":"visit-1","version":1}' }),
  correction('correction-1'),
  record('reviews', { id: 'review-1', center_id: 'center-1', event_id: 'event-1', student_id: 'student-1', reason: 'Exception', status: 'resolved', created_at: '2026-04-01T07:10:02.000Z', resolved_at: '2026-04-01T15:01:00.000Z' }),
  record('audit_entries', { id: 'audit-1', center_id: 'center-1', actor_name: 'Synthetic Staff', action: 'attendance.correct', entity_type: 'visit', entity_id: 'visit-1', detail: '{"reason":"Clock correction"}', created_at: '2026-04-01T15:00:00.000Z' }),
];

function staging() {
  const pending: ArchiveRecord[] = [], published: ArchiveRecord[] = []; let discarded = false;
  const sink: ArchiveStagingSink = {
    async stagePart(records) { pending.push(...records); },
    async publish() { published.push(...pending); pending.length = 0; },
    async discard() { pending.length = 0; discarded = true; },
  };
  return { pending, published, sink, get discarded() { return discarded; } };
}
async function bundle(meta = metadata(), records = fixture()) {
  const objects = new Map<string, Uint8Array>();
  const result = await createArchive(key, meta, records, async (part, encrypted) => { objects.set(part.objectKey, encrypted); });
  objects.set(result.objectKey, result.encrypted);
  const read = async (name: string, maximum: number) => { const value = objects.get(name); if (!value) throw new Error('Missing object'); if (value.length > maximum) throw new Error('Too large'); return value; };
  return { ...result, objects, read };
}

// Build a genuinely authenticated malformed payload, to test post-authentication validation.
async function customSeal(id: string, index: number, plaintext: Uint8Array) {
  const master = await crypto.subtle.importKey('raw', from64(key) as BufferSource, 'HKDF', false, ['deriveBits']);
  const domain = bytes64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(ARCHIVE_FORMAT), info: new TextEncoder().encode('history-only-encryption-domain') }, master, 256)));
  return sealPart(domain, plaintext, newHeader(id, index));
}

describe('historical archive codec', () => {
  it('roundtrips complete original/effective/correction/identity evidence and uses exact local month bounds', async () => {
    const result = await bundle(); const sink = staging();
    await verifyArchiveGraph(key, result.encrypted, result.read, sink.sink);
    expect(sink.published).toEqual(fixture());
    expect(result.manifest.periodFrom).toBe('2026-03-01T08:00:00.000Z');
    expect(result.manifest.periodTo).toBe('2026-04-01T07:00:00.000Z');
    expect(result.manifest.coverage).toEqual({ originalFrom: '2026-04-01T06:30:00.000Z', originalTo: '2026-04-01T07:10:00.000Z', effectiveFrom: '2026-04-01T06:25:00.000Z', effectiveTo: '2026-04-01T07:15:00.000Z', recordedThrough: '2026-04-01T15:01:00.000Z' });
    expect(result.manifest.compressedBytes).toBeLessThan(result.manifest.plaintextBytes);
    expect(calendarMonthBounds('2026-11', 'America/Los_Angeles')).toEqual({ periodFrom: '2026-11-01T07:00:00.000Z', periodTo: '2026-12-01T08:00:00.000Z' });
    expect(calendarMonthBounds('2026-02', 'Pacific/Kiritimati').periodFrom).toBe('2026-01-31T10:00:00.000Z');
    expect(calendarMonthBounds('2014-08', 'Africa/Cairo').periodFrom).toBe('2014-07-31T22:00:00.000Z');
  });

  it('uses fresh encryption on every retry, binds immutable keys, and does not decrypt in SQL backup domain', async () => {
    const a = await sealArchivePart(key, metadata(), 0, fixture()), b = await sealArchivePart(key, metadata(), 0, fixture());
    expect(a.descriptor.plaintextSha256).toBe(b.descriptor.plaintextSha256);
    expect(a.descriptor.compressedSha256).toBe(b.descriptor.compressedSha256);
    expect(a.descriptor.encryptedSha256).not.toBe(b.descriptor.encryptedSha256);
    expect(a.descriptor.objectKey).toContain(a.descriptor.encryptedSha256);
    await expect(openPart(key, a.encrypted)).rejects.toThrow();
    const x = await sealArchiveManifest(key, metadata(), [a.descriptor]), y = await sealArchiveManifest(key, metadata(), [a.descriptor]);
    expect(x.objectKey).not.toBe(y.objectKey);
    expect(await openArchiveManifest(key, x.encrypted)).toEqual(x.manifest);
  });

  it('bounds parts while streaming and detects a duplicate across part boundaries', async () => {
    const records = Array.from({ length: 600 }, (_, i) => student(`student-${String(i).padStart(5, '0')}`));
    const result = await bundle(metadata(), records);
    expect(result.manifest.parts.map(part => part.recordCount)).toEqual([256, 256, 88]);
    const sink = staging(); await verifyArchiveGraph(key, result.encrypted, result.read, sink.sink); expect(sink.published).toEqual(records);
    await expect(createArchive(key, metadata(), [...records.slice(0, 256), records[255]], async () => {})).rejects.toThrow(/strictly ordered/);
    const duplicate = structuredClone(result.manifest.parts); duplicate[1].first = duplicate[0].last;
    expect(() => finalizeArchiveManifest(metadata(), duplicate)).toThrow(/duplicate/);
  });

  it('fails closed on a corrupt final part after earlier evidence was staged', async () => {
    const result = await bundle(metadata(), Array.from({ length: 300 }, (_, i) => student(`student-${String(i).padStart(5, '0')}`)));
    const final = result.manifest.parts.at(-1)!; const tampered = result.objects.get(final.objectKey)!.slice(); tampered[tampered.length - 1] ^= 1; result.objects.set(final.objectKey, tampered);
    const sink = staging(); await expect(verifyArchiveGraph(key, result.encrypted, result.read, sink.sink)).rejects.toThrow(/checksum/);
    expect(sink.pending).toEqual([]); expect(sink.published).toEqual([]); expect(sink.discarded).toBe(true);
  });

  it('verifies parent/addendum references before publishing and fails if a parent is missing', async () => {
    const base = await bundle();
    const addendum = await bundle(metadata({ archiveId: 'addendum-1', kind: 'addendum', createdAt: '2026-04-03T00:00:00.000Z', references: [{ archiveId: base.manifest.archiveId, kind: 'monthly', manifestObjectKey: base.objectKey, manifestSha256: base.sha256 }] }), [correction('correction-2', '2026-04-02T16:00:00.000Z')]);
    for (const [name, data] of base.objects) addendum.objects.set(name, data);
    const sink = staging(); const manifests = await verifyArchiveGraph(key, addendum.encrypted, addendum.read, sink.sink);
    expect(manifests.map(manifest => manifest.archiveId)).toEqual(['archive-1', 'addendum-1']); expect(sink.published).toHaveLength(11);
    addendum.objects.delete(base.objectKey); const missing = staging();
    await expect(verifyArchiveGraph(key, addendum.encrypted, addendum.read, missing.sink)).rejects.toThrow(/Missing/); expect(missing.published).toEqual([]);
  });

  it('rejects unsafe or incomplete metadata/records, unknown fields, altered counts and record keys', async () => {
    expect(() => calendarMonthBounds('2026-13', 'UTC')).toThrow();
    expect(() => calendarMonthBounds('2026-01', 'Bogus/Timezone')).toThrow();
    await expect(sealArchivePart(key, metadata({ archiveId: '../escape' }), 0, fixture())).rejects.toThrow(/identifier/);
    await expect(sealArchivePart(key, metadata(), 0, [student('student-1'), student('student-1')])).rejects.toThrow(/unique/);
    await expect(sealArchivePart(key, metadata(), 0, [{ ...student('student-1'), key: 'other' }])).rejects.toThrow(/primary key/);
    await expect(sealArchivePart(key, metadata(), 0, [{ ...student('student-1'), table: 'passwords' } as unknown as ArchiveRecord])).rejects.toThrow(/unrecognized/);
    const otherCenter = student('student-1'); otherCenter.row.center_id = 'other'; await expect(sealArchivePart(key, metadata(), 0, [otherCenter])).rejects.toThrow(/another center/);
    const incomplete = correction('correction-1'); delete incomplete.row.prior_check_out_at; await expect(sealArchivePart(key, metadata(), 0, [incomplete])).rejects.toThrow(/prior/);
    const huge = student('student-1'); huge.row.first_name = '🦊'.repeat(ARCHIVE_LIMITS.recordBytes / 2); await expect(sealArchivePart(key, metadata(), 0, [huge])).rejects.toThrow(/size limit/);
    const result = await bundle();
    expect(() => validateArchiveManifest({ ...result.manifest, ignored: true })).toThrow(/fields/);
    expect(() => validateArchiveManifest({ ...result.manifest, recordCount: result.manifest.recordCount + 1 })).toThrow(/counts/);
    const forged = structuredClone(result.manifest); forged.parts[0].objectKey = '../part'; expect(() => validateArchiveManifest(forged)).toThrow(/unsafe/);
    expect(compareArchiveRecords(fixture()[0], fixture()[1])).toBeLessThan(0);
  });

  it('rejects wrong keys, manifest mismatch, truncated/authentication-failed envelopes', async () => {
    const result = await bundle();
    await expect(openArchiveManifest(bytes64(crypto.getRandomValues(new Uint8Array(32))), result.encrypted)).rejects.toThrow();
    await expect(openArchiveManifest(key, result.encrypted.slice(0, 50))).rejects.toThrow();
    const manifest = { ...result.manifest, periodTo: '2026-04-02T07:00:00.000Z' };
    await expect(openArchiveManifest(key, await customSeal(metadata().archiveId, -1, new TextEncoder().encode(JSON.stringify(manifest))))).rejects.toThrow(/totals or date/);
  });

  it('stops gzip expansion at the declared raw size, even for authenticated payloads', async () => {
    const result = await bundle(), part = structuredClone(result.manifest.parts[0]);
    const compressed = new Uint8Array(await new Response(new Blob([new Uint8Array(2 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const envelope = await customSeal(metadata().archiveId, 0, compressed);
    part.compressedBytes = compressed.length; part.compressedSha256 = await digest(compressed); part.encryptedBytes = envelope.length; part.encryptedSha256 = await digest(envelope);
    part.fileName = `part-00000-${part.encryptedSha256}.kca`; part.objectKey = `archives/center-1/2026-03/archive-1/${part.fileName}`;
    await expect(verifyArchivePart(key, result.manifest, part, envelope)).rejects.toThrow(/decompressed part exceeds/);
  });

  it('rejects mismatched reference scope and requires a parent for addenda', async () => {
    const base = await bundle();
    await expect(sealArchiveManifest(key, metadata({ kind: 'addendum' }), [])).rejects.toThrow(/references/);
    await expect(sealArchiveManifest(key, metadata({ archiveId: 'addendum-1', kind: 'addendum', references: [{ archiveId: 'archive-1', kind: 'monthly', manifestObjectKey: base.objectKey.replace('center-1', 'center-2'), manifestSha256: base.sha256 }] }), [])).rejects.toThrow(/scope/);
    const other = await bundle(metadata({ archiveId: 'other', month: '2026-02' }));
    const reference = { archiveId: other.manifest.archiveId, kind: 'monthly' as const, manifestObjectKey: other.objectKey, manifestSha256: other.sha256 };
    await expect(openArchiveManifest(key, base.encrypted, reference)).rejects.toThrow(/checksum/);
  });

  it('preserves current base64 SHA-256 replay hashes exactly', async () => {
    const row = correction('correction-base64'); row.row.payload_hash = bytes64(crypto.getRandomValues(new Uint8Array(32)));
    const result = await bundle(metadata(), [row]), sink = staging();
    await verifyArchiveGraph(key, result.encrypted, result.read, sink.sink);
    expect(sink.published[0].row.payload_hash).toBe(row.row.payload_hash);
  });

  it('runs the gzip/encryption/staged verification pipeline in actual workerd', async () => {
    const source = `
      import { createArchive, verifyArchiveGraph } from './worker/archive-codec.ts';
      export default { async fetch() {
        const objects = new Map(); const source = ${JSON.stringify(fixture())};
        const archive = await createArchive(${JSON.stringify(key)}, ${JSON.stringify(metadata())}, source, async (part, encrypted) => objects.set(part.objectKey, encrypted));
        let published = false, count = 0;
        await verifyArchiveGraph(${JSON.stringify(key)}, archive.encrypted, async (name) => objects.get(name), {
          async stagePart(rows) { if (published) throw new Error('Early publication'); count += rows.length; },
          async publish() { published = true; }, async discard() { throw new Error('Unexpected discard'); }
        });
        return Response.json({ published, count, compressed: archive.manifest.compressedBytes < archive.manifest.plaintextBytes });
      } };`;
    const built = await build({ stdin: { contents: source, resolveDir: resolve('.') }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const runtime = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-06-11' });
    try { const response = await runtime.dispatchFetch('https://archive.test/'); expect(response.status).toBe(200); expect(await response.json()).toEqual({ published: true, count: 10, compressed: true }); }
    finally { await runtime.dispose(); }
  });
});
