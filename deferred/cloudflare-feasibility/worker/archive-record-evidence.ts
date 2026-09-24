import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, ARCHIVE_TABLES, type ArchiveRecord, type ArchiveReference, type ArchiveTable } from '../shared/archive-format';
import { archiveObjectPrefix, compareArchiveRecords, openArchiveManifest, verifyArchivePart } from './archive-codec';
import { digest } from './backup-crypto';
import { validateSemanticShape } from './archive-semantic-rules';

/** A locator is supplied only by trusted publication code after authorization.
 * Hashes are lowercase hex SHA-256. Header, descriptor and record hashes cover
 * UTF-8 JSON.stringify with original property order, without a JSONL newline.
 * The header is the authenticated manifest with only `parts` omitted. */
export type ArchiveRecordEvidenceLocator = {
  reference: ArchiveReference;
  centerId: string;
  month: string;
  timezone: string;
  headerSha256: string;
  partIndex: number;
  descriptorSha256: string;
  table: ArchiveTable;
  recordKey: string;
  recordSha256: string;
  recordBytes: number;
};
/** A trusted publication root and exact identity, without a SQL part/row locator. */
export type ArchiveManifestRecordSelection = Pick<ArchiveRecordEvidenceLocator,
  'reference' | 'centerId' | 'month' | 'timezone' | 'headerSha256' | 'table' | 'recordKey'>;
/** Only the streaming operations used by the evidence reader are required.
 * This also permits actual local R2 bindings without platform-type casts. */
export type ArchiveEvidenceObject = {
  size: number;
  body: {
    cancel(reason?: unknown): Promise<void>;
    getReader(): {
      read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
      releaseLock(): void;
    };
  };
};
export type ArchiveRecordEvidenceStorage = { bucket: { get(key: string): Promise<ArchiveEvidenceObject | null> }; masterKey: string };
const encoder = new TextEncoder();
function unavailable(): never { throw new Error('ARCHIVE_RECORD_EVIDENCE_UNAVAILABLE'); }
const hash = (value: unknown) => digest(encoder.encode(JSON.stringify(value)));
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validateLocator(value: ArchiveRecordEvidenceLocator): void {
  const identifier = (item: unknown) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item);
  const sha256 = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (!exact(value, ['reference', 'centerId', 'month', 'timezone', 'headerSha256', 'partIndex', 'descriptorSha256', 'table', 'recordKey', 'recordSha256', 'recordBytes'])
    || !exact(value.reference, ['archiveId', 'kind', 'manifestObjectKey', 'manifestSha256'])
    || !identifier(value.reference.archiveId) || value.reference.kind !== 'monthly' || !sha256(value.reference.manifestSha256)
    || !identifier(value.centerId) || typeof value.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)
    || typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > 100
    || !sha256(value.headerSha256) || !sha256(value.descriptorSha256) || !sha256(value.recordSha256)
    || !Number.isSafeInteger(value.partIndex) || value.partIndex < 0 || value.partIndex >= ARCHIVE_LIMITS.parts
    || !(ARCHIVE_TABLES as readonly string[]).includes(value.table) || typeof value.recordKey !== 'string' || !value.recordKey || value.recordKey.length > 1024
    || !Number.isSafeInteger(value.recordBytes) || value.recordBytes < 1 || value.recordBytes > ARCHIVE_LIMITS.recordBytes) unavailable();
  // Reject out-of-scope object requests before even fetching ciphertext. The
  // codec repeats this check against the authenticated manifest identity.
  if (value.reference.manifestObjectKey !== `${archiveObjectPrefix({ centerId: value.centerId, month: value.month, archiveId: value.reference.archiveId })}manifest-${value.reference.manifestSha256}.kca`) unavailable();
}
export async function readArchiveEvidenceObject(bucket: ArchiveRecordEvidenceStorage['bucket'], key: string, maximum: number, expectedBytes?: number): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) unavailable();
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > maximum || expectedBytes !== undefined && object.size !== expectedBytes) {
    await object.body.cancel();
    unavailable();
  }
  const bytes = new Uint8Array(object.size), reader = object.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (received + next.value.byteLength > maximum || received + next.value.byteLength > bytes.length) unavailable();
      bytes.set(next.value, received); received += next.value.byteLength;
    }
    if (received !== object.size) unavailable();
  } catch (error) {
    try { await reader.cancel(); } catch { /* The enclosing API returns one bounded error. */ }
    throw error;
  } finally { reader.releaseLock(); }
  return bytes;
}

/** Loads exact authenticated evidence, not authority. No database, current
 * profile, R2 listing or month scan is consulted. A trusted caller must obtain
 * an immutable published locator, authorize its owner, and recheck publication
 * availability and runtime generation after this await before returning data.
 * This does not independently establish whole-graph semantic verification. */
export async function loadArchiveRecordEvidence(storage: ArchiveRecordEvidenceStorage, suppliedLocator: ArchiveRecordEvidenceLocator): Promise<ArchiveRecord> {
  try {
    const locator = Object.freeze({ ...suppliedLocator, reference: Object.freeze({ ...suppliedLocator.reference }) });
    validateLocator(locator);
    const { bucket, masterKey } = storage;
    const manifest = await openArchiveManifest(masterKey,
      await readArchiveEvidenceObject(bucket, locator.reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes), locator.reference);
    if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.kind !== 'monthly' || manifest.references.length
      || manifest.centerId !== locator.centerId || manifest.month !== locator.month || manifest.timezone !== locator.timezone) unavailable();
    const { parts, ...header } = manifest;
    if (await hash(header) !== locator.headerSha256) unavailable();
    const descriptor = parts[locator.partIndex];
    if (!descriptor || descriptor.index !== locator.partIndex || await hash(descriptor) !== locator.descriptorSha256) unavailable();
    const records = await verifyArchivePart(masterKey, manifest, descriptor,
      await readArchiveEvidenceObject(bucket, descriptor.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, descriptor.encryptedBytes));
    const selected = records.filter(record => record.table === locator.table && record.key === locator.recordKey);
    if (selected.length !== 1) unavailable();
    const record = selected[0];
    validateSemanticShape(record, manifest, locator.table, locator.recordKey);
    const bytes = encoder.encode(JSON.stringify(record));
    if (bytes.length !== locator.recordBytes || await digest(bytes) !== locator.recordSha256) unavailable();
    return record;
  } catch { return unavailable(); }
}

/** Loads evidence from one authenticated manifest and its unique matching part.
 * The caller must authorize the owner, supply a committed semantically verified
 * publication, and recheck current availability/proof/runtime after this await.
 * This function does not establish publication or current-state authority. */
export async function loadManifestRecordEvidence(storage: ArchiveRecordEvidenceStorage, suppliedSelection: ArchiveManifestRecordSelection): Promise<ArchiveRecord> {
  try {
    const selection = Object.freeze({ ...suppliedSelection, reference: Object.freeze({ ...suppliedSelection.reference }) });
    const identifier = (item: unknown) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item);
    const sha256 = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
    if (!exact(selection, ['reference', 'centerId', 'month', 'timezone', 'headerSha256', 'table', 'recordKey'])
      || !exact(selection.reference, ['archiveId', 'kind', 'manifestObjectKey', 'manifestSha256'])
      || !identifier(selection.reference.archiveId) || selection.reference.kind !== 'monthly' || !sha256(selection.reference.manifestSha256)
      || !identifier(selection.centerId) || typeof selection.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(selection.month)
      || typeof selection.timezone !== 'string' || !selection.timezone || selection.timezone.length > 100 || !sha256(selection.headerSha256)
      || !(ARCHIVE_TABLES as readonly string[]).includes(selection.table) || typeof selection.recordKey !== 'string' || !selection.recordKey || selection.recordKey.length > 1024
      || selection.reference.manifestObjectKey !== `${archiveObjectPrefix({ centerId: selection.centerId, month: selection.month, archiveId: selection.reference.archiveId })}manifest-${selection.reference.manifestSha256}.kca`) unavailable();
    const { bucket, masterKey } = storage;
    const manifest = await openArchiveManifest(masterKey,
      await readArchiveEvidenceObject(bucket, selection.reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes), selection.reference);
    if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.kind !== 'monthly' || manifest.references.length
      || manifest.centerId !== selection.centerId || manifest.month !== selection.month || manifest.timezone !== selection.timezone) unavailable();
    const { parts, ...header } = manifest;
    if (await hash(header) !== selection.headerSha256) unavailable();
    // openArchiveManifest validates strict global part ordering and no overlap.
    // At most 512 authenticated descriptors are considered; no object listing.
    const position = { table: selection.table, key: selection.recordKey };
    const matches = parts.filter(part => compareArchiveRecords(part.first, position) <= 0 && compareArchiveRecords(part.last, position) >= 0);
    if (matches.length !== 1) unavailable();
    const descriptor = matches[0];
    const records = await verifyArchivePart(masterKey, manifest, descriptor,
      await readArchiveEvidenceObject(bucket, descriptor.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, descriptor.encryptedBytes));
    const selected = records.filter(record => record.table === selection.table && record.key === selection.recordKey);
    if (selected.length !== 1) unavailable();
    validateSemanticShape(selected[0], manifest, selection.table, selection.recordKey);
    return selected[0];
  } catch { return unavailable(); }
}
