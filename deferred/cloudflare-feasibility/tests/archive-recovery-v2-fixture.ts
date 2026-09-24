import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { digest, newHeader, sealPart, type BackupManifest } from '../worker/backup-crypto';
import type { ArchiveMetadata, ArchiveRecord, ArchiveReference } from '../shared/archive-format';
import type { nativeSemanticFixture } from './archive-semantic-fixture';

export type RecoveryV2Seed = Awaited<ReturnType<typeof nativeSemanticFixture>>;
export async function recoveryV2Fixture(seed: RecoveryV2Seed, options: { addendum?: boolean; extraStudents?: number; mutate?: (records: ArchiveRecord[]) => void } = {}) {
  // nativeSemanticFixture disposes its native runtime and deletes its source
  // directory before returning. Only detached records enter this packager.
  const root = await mkdtemp(join(tmpdir(), 'kumon-recovery-v2-'));
  const bundle = join(root, 'encrypted-history'), backup = join(root, 'encrypted-sql'), keyFile = join(root, 'private-key.txt');
  await mkdir(bundle, { mode: 0o700 }); await mkdir(backup, { mode: 0o700 });
  await writeFile(keyFile, seed.key + '\n', { mode: 0o600 });
  const records = structuredClone(seed.records);
  if (options.extraStudents) {
    const student = records.find(record => record.table === 'students')!;
    for (let index = 0; index < options.extraStudents; index++) {
      const id = `recovery-student-${String(index).padStart(6, '0')}`;
      records.push({ ...structuredClone(student), key: id, row: { ...student.row, id, student_code: id } });
    }
  }
  options.mutate?.(records); records.sort(compareArchiveRecords);
  const objects = new Map<string, Uint8Array>();
  const metadata: ArchiveMetadata = { ...seed.metadata, archiveId: 'independent-v2-base' };
  const base = await createArchive(seed.key, metadata, records, async (part, bytes) => { objects.set(part.objectKey, bytes); });
  objects.set(base.objectKey, base.encrypted);
  const reference = (archive: typeof base): ArchiveReference => ({ archiveId: archive.manifest.archiveId, kind: archive.manifest.kind, manifestObjectKey: archive.objectKey, manifestSha256: archive.sha256 });
  let entry = base;
  const expected = new Map<string, ArchiveRecord[]>([[metadata.archiveId, records]]), manifests = [base.manifest];
  if (options.addendum) {
    const original = records.find(record => record.table === 'audit_entries' && record.row.action === 'review_resolved')!;
    const id = 'later-review-attempt';
    const record: ArchiveRecord = { ...structuredClone(original), key: id, row: { ...original.row, id, created_at: new Date(Date.parse(metadata.createdAt) + 1000).toISOString(), detail: JSON.stringify({ resolution: 'Later legitimate review resolution attempt' }) } };
    entry = await createArchive(seed.key, { ...metadata, archiveId: 'independent-v2-addendum', kind: 'addendum', createdAt: new Date(Date.parse(metadata.createdAt) + 2000).toISOString(), references: [reference(base)] }, [record], async (part, bytes) => { objects.set(part.objectKey, bytes); });
    objects.set(entry.objectKey, entry.encrypted); expected.set(entry.manifest.archiveId, [record]); manifests.push(entry.manifest);
  }
  for (const [name, bytes] of objects) {
    const path = join(bundle, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 });
  }
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const sql = 'CREATE TABLE recovered_evidence(table_name TEXT,record_key TEXT,record_json TEXT);\n' + records.map(record => `INSERT INTO recovered_evidence VALUES(${literal(record.table)},${literal(record.key)},${literal(JSON.stringify(record))});`).join('\n') + '\n';
  const bytes = new TextEncoder().encode(sql), backupId = crypto.randomUUID(), parts: BackupManifest['parts'] = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += 256 * 1024, index++) {
    const plain = bytes.slice(offset, offset + 256 * 1024), encrypted = await sealPart(seed.key, plain, newHeader(backupId, index));
    const fileName = `part-${String(index).padStart(5, '0')}.kcrm`; await writeFile(join(backup, fileName), encrypted, { mode: 0o600 });
    parts.push({ index, fileName, plaintextBytes: plain.length, plaintextSha256: await digest(plain), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) });
  }
  const backupManifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId, applicationVersion: 'independent-v2-recovery-test', schemaVersions: seed.metadata.schemaVersions, createdAt: entry.manifest.createdAt, snapshotBookmark: 'SYNTHETIC_SQL_NO_PROVIDER_EXPORT', recordCounts: { recovered_evidence: records.length }, sqlBytes: bytes.length, parts, archiveReferences: [reference(entry)] };
  await writeFile(join(backup, 'manifest.kcrm'), await sealPart(seed.key, new TextEncoder().encode(JSON.stringify(backupManifest)), newHeader(backupId, -1)), { mode: 0o600 });
  return { root, bundle, backup, keyFile, key: seed.key, base, entry, objects, expected, manifests, sql, backupManifest };
}
