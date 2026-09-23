import {
  ARCHIVE_FORMAT, ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS as LIMIT, ARCHIVE_TABLES,
  type ArchiveCounts, type ArchiveCoverage, type ArchiveManifest, type ArchiveMetadata,
  type ArchivePartDescriptor, type ArchiveRecord, type ArchiveRecordPosition,
  type ArchiveReference, type ArchiveStagingSink, type ArchiveTable,
} from '../shared/archive-format';
import { bytes64, digest, from64, newHeader, openPart, sealPart } from './backup-crypto';
import { verifyArchiveSemantics } from './archive-semantics';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const metadataKeys = ['archiveId', 'centerId', 'month', 'timezone', 'kind', 'createdAt', 'applicationVersion', 'schemaVersions', 'references'];
const coverageKeys = ['originalFrom', 'originalTo', 'effectiveFrom', 'effectiveTo', 'recordedThrough'];
const descriptorKeys = ['index', 'fileName', 'objectKey', 'recordCount', 'recordCounts', 'first', 'last', 'coverage', 'plaintextBytes', 'plaintextSha256', 'compressedBytes', 'compressedSha256', 'encryptedBytes', 'encryptedSha256'];
const manifestKeys = [...metadataKeys, 'format', 'compression', 'recordEncoding', 'periodFrom', 'periodTo', 'coverage', 'recordCount', 'recordCounts', 'plaintextBytes', 'compressedBytes', 'parts'];

function fail(message: string): never { throw new Error(`Invalid historical archive: ${message}`); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object.');
}
function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  object(value);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('unexpected or missing fields.');
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('integer outside supported bounds.');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) fail('unsafe identifier.');
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('timestamp must be a canonical UTC ISO date.');
}
function table(value: unknown): asserts value is ArchiveTable {
  if (!(ARCHIVE_TABLES as readonly unknown[]).includes(value)) fail('unrecognized table.');
}
export function emptyArchiveCounts(): ArchiveCounts {
  return Object.fromEntries(ARCHIVE_TABLES.map(name => [name, 0])) as ArchiveCounts;
}
export function emptyArchiveCoverage(): ArchiveCoverage {
  return { originalFrom: null, originalTo: null, effectiveFrom: null, effectiveTo: null, recordedThrough: null };
}
function validateCounts(value: unknown, expected: number): asserts value is ArchiveCounts {
  exactKeys(value, ARCHIVE_TABLES);
  let count = 0;
  for (const name of ARCHIVE_TABLES) { integer(value[name], 0, LIMIT.parts * LIMIT.recordsPerPart); count += value[name] as number; }
  if (count !== expected) fail('record counts disagree.');
}
function validateCoverage(value: unknown): asserts value is ArchiveCoverage {
  exactKeys(value, coverageKeys);
  for (const key of coverageKeys) if (value[key] !== null) timestamp(value[key]);
  for (const [start, end] of [['originalFrom', 'originalTo'], ['effectiveFrom', 'effectiveTo']]) {
    if ((value[start] === null) !== (value[end] === null) || (value[start] !== null && (value[start] as string) > (value[end] as string))) fail('invalid date coverage.');
  }
}
function mergeCoverage(target: ArchiveCoverage, source: ArchiveCoverage): void {
  for (const key of ['originalFrom', 'effectiveFrom'] as const) if (source[key] !== null && (target[key] === null || source[key]! < target[key]!)) target[key] = source[key];
  for (const key of ['originalTo', 'effectiveTo', 'recordedThrough'] as const) if (source[key] !== null && (target[key] === null || source[key]! > target[key]!)) target[key] = source[key];
}
function equalCoverage(a: ArchiveCoverage, b: ArchiveCoverage): boolean { return coverageKeys.every(key => a[key as keyof ArchiveCoverage] === b[key as keyof ArchiveCoverage]); }
function equalCounts(a: ArchiveCounts, b: ArchiveCounts): boolean { return ARCHIVE_TABLES.every(name => a[name] === b[name]); }

/** Exact calendar month boundary, including daylight-saving changes and midnight jumps. */
export function calendarMonthBounds(month: string, timezone: string): { periodFrom: string; periodTo: string } {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) fail('month must be YYYY-MM in 2000–2099.');
  if (typeof timezone !== 'string' || timezone.length > 100) fail('invalid timezone.');
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { return fail('invalid IANA timezone.'); }
  const dateAt = (time: number) => {
    const p = Object.fromEntries(format.formatToParts(time).map(p => [p.type, p.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const start = (year: number, m: number): string => {
    const nominal = Date.UTC(year, m - 1, 1);
    const target = new Date(nominal).toISOString().slice(0, 10);
    let lo = nominal - 36 * 60 * 60 * 1000, hi = nominal + 36 * 60 * 60 * 1000;
    while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (dateAt(mid) >= target) hi = mid; else lo = mid; }
    if (dateAt(hi) !== target || dateAt(hi - 1) >= target) fail('unsupported calendar boundary.');
    return new Date(hi).toISOString();
  };
  const [year, m] = month.split('-').map(Number);
  return { periodFrom: start(year, m), periodTo: start(m === 12 ? year + 1 : year, m === 12 ? 1 : m + 1) };
}

export function archiveObjectPrefix(metadata: Pick<ArchiveMetadata, 'centerId' | 'month' | 'archiveId'>): string {
  identifier(metadata.centerId); identifier(metadata.archiveId);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(metadata.month)) fail('invalid month.');
  return `archives/${metadata.centerId}/${metadata.month}/${metadata.archiveId}/`;
}

function validateReference(ref: unknown, metadata: ArchiveMetadata): asserts ref is ArchiveReference {
  exactKeys(ref, ['archiveId', 'kind', 'manifestObjectKey', 'manifestSha256']);
  identifier(ref.archiveId);
  if (ref.archiveId === metadata.archiveId || !['monthly', 'addendum'].includes(ref.kind as string) || typeof ref.manifestSha256 !== 'string' || !HASH.test(ref.manifestSha256)) fail('invalid immutable reference.');
  if (ref.manifestObjectKey !== `${archiveObjectPrefix({ ...metadata, archiveId: ref.archiveId })}manifest-${ref.manifestSha256}.kca`) fail('reference key is outside archive scope.');
}

export function validateArchiveMetadata(metadata: ArchiveMetadata): void {
  if (metadata.semanticProof !== undefined) {
    exactKeys(metadata.semanticProof, ['version', 'payloadHashEncoding', 'deviceContexts']);
    const proof = metadata.semanticProof;
    if (proof.version !== 1 || !['base64', 'base64-or-hex'].includes(proof.payloadHashEncoding) || !Array.isArray(proof.deviceContexts) || proof.deviceContexts.length > LIMIT.deviceContexts || encoder.encode(JSON.stringify(proof)).length > LIMIT.semanticProofBytes) fail('unsupported or oversized semantic proof.');
    const devices = new Set<string>();
    for (const device of proof.deviceContexts) {
      exactKeys(device, ['id', 'centerId']); identifier(device.id);
      if (device.centerId !== metadata.centerId || devices.has(device.id)) fail('invalid device ownership context.');
      devices.add(device.id);
    }
  }
  identifier(metadata.archiveId); identifier(metadata.centerId);
  calendarMonthBounds(metadata.month, metadata.timezone); timestamp(metadata.createdAt);
  if (typeof metadata.applicationVersion !== 'string' || !/^[A-Za-z0-9._+-]{1,128}$/.test(metadata.applicationVersion)) fail('invalid application version.');
  if (!['monthly', 'addendum'].includes(metadata.kind) || !Array.isArray(metadata.schemaVersions) || !metadata.schemaVersions.length || metadata.schemaVersions.length > 256) fail('invalid schema metadata.');
  let prior = 0;
  for (const version of metadata.schemaVersions) { integer(version, 1, 1000000); if (version <= prior) fail('schema versions must be unique and ordered.'); prior = version; }
  if (!Array.isArray(metadata.references) || metadata.references.length > LIMIT.references || (metadata.kind === 'monthly' ? metadata.references.length !== 0 : metadata.references.length === 0)) fail('invalid parent/addendum references.');
  const seen = new Set<string>();
  for (const reference of metadata.references) { validateReference(reference, metadata); if (seen.has(reference.archiveId)) fail('duplicate reference.'); seen.add(reference.archiveId); }
}

export function archiveRecordKey(tableName: ArchiveTable, row: Record<string, unknown>, metadata?: Pick<ArchiveMetadata, 'semanticProof'>): string {
  table(tableName);
  if (tableName === 'student_guardians') { identifier(row.student_id); identifier(row.guardian_id); return JSON.stringify([row.student_id, row.guardian_id]); }
  if (tableName === 'audit_entries' && metadata?.semanticProof) { if (typeof row.id !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(row.id)) fail('unsafe audit identifier.'); return row.id; }
  identifier(row.id); return row.id;
}
export function compareArchiveRecords(a: ArchiveRecordPosition, b: ArchiveRecordPosition): number {
  const order = ARCHIVE_TABLES.indexOf(a.table) - ARCHIVE_TABLES.indexOf(b.table);
  return order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function validatePosition(value: unknown, metadata: ArchiveMetadata): asserts value is ArchiveRecordPosition {
  exactKeys(value, ['table', 'key']); table(value.table);
  if (value.table === 'student_guardians') {
    if (typeof value.key !== 'string' || value.key.length > 210) fail('invalid composite key.');
    let parts: unknown; try { parts = JSON.parse(value.key); } catch { return fail('invalid composite key.'); }
    if (!Array.isArray(parts) || parts.length !== 2) fail('invalid composite key.');
    parts.forEach(identifier); if (JSON.stringify(parts) !== value.key) fail('noncanonical composite key.');
  } else if (value.table === 'audit_entries' && metadata.semanticProof) { if (typeof value.key !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(value.key)) fail('unsafe audit position.'); }
  else identifier(value.key);
}
function validateJson(value: unknown, depth = 0): void {
  if (depth > 16) fail('record nesting exceeds limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('nonfinite number.'); return; }
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1); return; }
  object(value);
  for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe property.'); validateJson(item, depth + 1); }
}

/** Preserves all supplied row columns; a producer must supply the complete evidence row. */
export function validateArchiveRecord(record: unknown, metadata: ArchiveMetadata): asserts record is ArchiveRecord {
  exactKeys(record, ['table', 'key', 'row']); table(record.table); object(record.row);
  const row = record.row;
  for (const name of Object.keys(row)) if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) fail('unsafe column name.');
  validateJson(row);
  if (record.key !== archiveRecordKey(record.table, row, metadata)) fail('record key does not match primary key.');
  if (record.table === 'centers') { if (row.id !== metadata.centerId || row.timezone !== metadata.timezone) fail('center context mismatch.'); }
  else if (record.table !== 'student_guardians' && row.center_id !== metadata.centerId) fail('record belongs to another center.');
  for (const [name, value] of Object.entries(row)) {
    if ((name.endsWith('_at') || name === 'recorded_at') && value !== null) timestamp(value);
    if ((name.endsWith('_id') && name !== 'entity_id') && value !== null) identifier(value);
  }
  const required: Partial<Record<ArchiveTable, string[]>> = {
    centers: ['name', 'timezone'], students: ['student_code', 'first_name', 'last_name'], guardians: ['display_name'], staff: ['display_name'],
    visits: ['student_id', 'check_in_at', 'original_check_in_at', 'check_in_by'],
    attendance_events: ['student_id', 'action', 'observed_at', 'received_at', 'actor_id', 'actor_name', 'payload_hash'],
    attendance_corrections: ['visit_id', 'prior_check_in_at', 'check_in_at', 'reason', 'actor_id', 'actor_name', 'recorded_at', 'payload_hash'],
    reviews: ['event_id', 'student_id', 'reason', 'status', 'created_at'], audit_entries: ['actor_name', 'action', 'entity_type', 'entity_id', 'detail', 'created_at'],
  };
  for (const name of required[record.table] || []) if (typeof row[name] !== 'string') fail(`missing ${record.table}.${name}.`);
  if (record.table === 'visits') {
    for (const name of ['check_out_at', 'original_check_out_at']) if (!Object.hasOwn(row, name)) fail('visit omits original/effective departure.');
    integer(row.version, 1, Number.MAX_SAFE_INTEGER);
  }
  if (record.table === 'attendance_events' || record.table === 'attendance_corrections') {
    const hash = row.payload_hash as string;
    // Current attendance hashes use standard base64; earlier exports may use hex.
    // Preserve either representation verbatim so replay comparison remains exact.
    if (!HASH.test(hash) && (!/^[A-Za-z0-9+/]{43}=$/.test(hash) || from64(hash).length !== 32 || bytes64(from64(hash)) !== hash)) fail('invalid immutable payload hash.');
  }
  if (record.table === 'attendance_events' && (!Object.hasOwn(row, 'result_visit') || !['check_in', 'check_out', 'exceptional_departure'].includes(row.action as string))) fail('event omits replay evidence.');
  if (record.table === 'attendance_corrections') {
    for (const name of ['prior_check_out_at', 'check_out_at']) if (!Object.hasOwn(row, name)) fail('correction omits prior/effective departure.');
    integer(row.expected_version, 1, Number.MAX_SAFE_INTEGER);
  }
  if (encoder.encode(JSON.stringify(record) + '\n').length > LIMIT.recordBytes) fail('record exceeds size limit.');
}

export function archiveRecordCoverage(record: ArchiveRecord): ArchiveCoverage {
  const result = emptyArchiveCoverage(), row = record.row;
  const original = (names: string[]) => {
    const times = names.map(name => row[name]).filter((value): value is string => typeof value === 'string').sort();
    if (times.length) { result.originalFrom = times[0]; result.originalTo = times[times.length - 1]; }
  };
  const effective = (names: string[]) => {
    const times = names.map(name => row[name]).filter((value): value is string => typeof value === 'string').sort();
    if (times.length) { result.effectiveFrom = times[0]; result.effectiveTo = times[times.length - 1]; }
  };
  if (record.table === 'visits') { original(['original_check_in_at', 'original_check_out_at']); effective(['check_in_at', 'check_out_at']); }
  if (record.table === 'attendance_events') { original(['observed_at']); result.recordedThrough = row.received_at as string; }
  if (record.table === 'attendance_corrections') { effective(['prior_check_in_at', 'prior_check_out_at', 'check_in_at', 'check_out_at']); result.recordedThrough = row.recorded_at as string; }
  if (record.table === 'reviews') result.recordedThrough = (row.resolved_at || row.created_at) as string;
  if (record.table === 'audit_entries') result.recordedThrough = row.created_at as string;
  return result;
}

async function archiveDomainKey(master: string): Promise<string> {
  const raw = from64(master); if (raw.length !== 32) fail('recovery key must be 32 bytes.');
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveBits']);
  return bytes64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(ARCHIVE_FORMAT), info: encoder.encode('history-only-encryption-domain') }, key, 256)));
}
async function transformBounded(input: Uint8Array, decompress: boolean, maximum: number): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(decompress ? new DecompressionStream('gzip') : new CompressionStream('gzip'));
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > maximum) { await reader.cancel(); fail(decompress ? 'decompressed part exceeds limit.' : 'compressed part exceeds limit.'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(length); let at = 0; for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; } return output;
}

export async function sealArchivePart(master: string, metadata: ArchiveMetadata, index: number, records: readonly ArchiveRecord[]): Promise<{ descriptor: ArchivePartDescriptor; encrypted: Uint8Array }> {
  validateArchiveMetadata(metadata); integer(index, 0, LIMIT.parts - 1); integer(records.length, 1, LIMIT.recordsPerPart);
  let previous: ArchiveRecord | undefined, byteCount = 0; const counts = emptyArchiveCounts(), coverage = emptyArchiveCoverage();
  const lines: string[] = [];
  for (const record of records) {
    validateArchiveRecord(record, metadata);
    if (previous && compareArchiveRecords(previous, record) >= 0) fail('records must be unique and strictly ordered.');
    const line = JSON.stringify(record) + '\n'; byteCount += encoder.encode(line).length;
    if (byteCount > LIMIT.plaintextPartBytes) fail('part exceeds plaintext limit.');
    previous = record; counts[record.table]++; mergeCoverage(coverage, archiveRecordCoverage(record)); lines.push(line);
  }
  const plaintext = encoder.encode(lines.join('')); if (plaintext.length > LIMIT.plaintextPartBytes) fail('part exceeds plaintext limit.');
  const compressed = await transformBounded(plaintext, false, LIMIT.compressedPartBytes);
  const encrypted = await sealPart(await archiveDomainKey(master), compressed, newHeader(metadata.archiveId, index));
  if (encrypted.length > LIMIT.encryptedPartBytes) fail('part exceeds encrypted limit.');
  const encryptedSha256 = await digest(encrypted), fileName = `part-${String(index).padStart(5, '0')}-${encryptedSha256}.kca`;
  const position = (record: ArchiveRecord): ArchiveRecordPosition => ({ table: record.table, key: record.key });
  return { encrypted, descriptor: {
    index, fileName, objectKey: archiveObjectPrefix(metadata) + fileName, recordCount: records.length, recordCounts: counts,
    first: position(records[0]), last: position(records[records.length - 1]), coverage,
    plaintextBytes: plaintext.length, plaintextSha256: await digest(plaintext),
    compressedBytes: compressed.length, compressedSha256: await digest(compressed), encryptedBytes: encrypted.length, encryptedSha256,
  } };
}

function validateDescriptor(part: unknown, metadata: ArchiveMetadata, index: number): asserts part is ArchivePartDescriptor {
  exactKeys(part, descriptorKeys);
  if (part.index !== index) fail('part order differs from manifest.');
  integer(part.recordCount, 1, LIMIT.recordsPerPart); validateCounts(part.recordCounts, part.recordCount);
  validatePosition(part.first, metadata); validatePosition(part.last, metadata); validateCoverage(part.coverage);
  if (compareArchiveRecords(part.first, part.last) > 0 || (part.recordCount > 1 && compareArchiveRecords(part.first, part.last) === 0)) fail('invalid part record range.');
  integer(part.plaintextBytes, 1, LIMIT.plaintextPartBytes); integer(part.compressedBytes, 1, LIMIT.compressedPartBytes); integer(part.encryptedBytes, 40, LIMIT.encryptedPartBytes);
  for (const key of ['plaintextSha256', 'compressedSha256', 'encryptedSha256']) if (typeof part[key] !== 'string' || !HASH.test(part[key] as string)) fail('invalid SHA-256.');
  if (part.fileName !== `part-${String(index).padStart(5, '0')}-${part.encryptedSha256}.kca` || part.objectKey !== archiveObjectPrefix(metadata) + part.fileName) fail('part has an unsafe or mutable object key.');
}

export function finalizeArchiveManifest(metadata: ArchiveMetadata, parts: readonly ArchivePartDescriptor[]): ArchiveManifest {
  exactKeys(metadata, metadata.semanticProof === undefined ? metadataKeys : [...metadataKeys, 'semanticProof']); validateArchiveMetadata(metadata);
  if (!Array.isArray(parts) || parts.length > LIMIT.parts) fail('too many parts.');
  const recordCounts = emptyArchiveCounts(), coverage = emptyArchiveCoverage();
  let recordCount = 0, plaintextBytes = 0, compressedBytes = 0, previous: ArchiveRecordPosition | undefined;
  for (const [index, part] of parts.entries()) {
    validateDescriptor(part, metadata, index);
    if (previous && compareArchiveRecords(previous, part.first) >= 0) fail('duplicate or out-of-order records across parts.');
    previous = part.last; recordCount += part.recordCount; plaintextBytes += part.plaintextBytes; compressedBytes += part.compressedBytes;
    for (const name of ARCHIVE_TABLES) recordCounts[name] += part.recordCounts[name]; mergeCoverage(coverage, part.coverage);
  }
  if (plaintextBytes > LIMIT.plaintextArchiveBytes) fail('archive exceeds raw byte limit.');
  if (metadata.kind === 'addendum' && !recordCounts.attendance_corrections && !recordCounts.reviews && !recordCounts.audit_entries) fail('addendum lacks correction or review evidence.');
  return { ...metadata, format: metadata.semanticProof ? ARCHIVE_FORMAT_V2 : ARCHIVE_FORMAT, compression: 'gzip', recordEncoding: 'jsonl', ...calendarMonthBounds(metadata.month, metadata.timezone), recordCount, recordCounts, plaintextBytes, compressedBytes, coverage, parts: [...parts] };
}

export function validateArchiveManifest(value: unknown): asserts value is ArchiveManifest {
  object(value);
  const v2 = value.format === ARCHIVE_FORMAT_V2;
  exactKeys(value, v2 ? [...manifestKeys, 'semanticProof'] : manifestKeys);
  if ((!v2 && value.format !== ARCHIVE_FORMAT) || value.compression !== 'gzip' || value.recordEncoding !== 'jsonl') fail('unsupported format.');
  const metadata = Object.fromEntries([...metadataKeys, ...(v2 ? ['semanticProof'] : [])].map(key => [key, value[key]])) as ArchiveMetadata;
  const expected = finalizeArchiveManifest(metadata, value.parts as ArchivePartDescriptor[]);
  integer(value.recordCount, 0, LIMIT.parts * LIMIT.recordsPerPart); validateCounts(value.recordCounts, value.recordCount); validateCoverage(value.coverage);
  if (value.periodFrom !== expected.periodFrom || value.periodTo !== expected.periodTo || value.recordCount !== expected.recordCount || value.plaintextBytes !== expected.plaintextBytes || value.compressedBytes !== expected.compressedBytes || !equalCoverage(value.coverage, expected.coverage) || !equalCounts(value.recordCounts, expected.recordCounts)) fail('manifest totals or date coverage disagree.');
}

export async function sealArchiveManifest(master: string, metadata: ArchiveMetadata, parts: readonly ArchivePartDescriptor[]): Promise<{ manifest: ArchiveManifest; encrypted: Uint8Array; objectKey: string; sha256: string }> {
  const manifest = finalizeArchiveManifest(metadata, parts), plaintext = encoder.encode(JSON.stringify(manifest));
  if (plaintext.length > LIMIT.manifestBytes) fail('manifest exceeds size limit.');
  const encrypted = await sealPart(await archiveDomainKey(master), plaintext, newHeader(metadata.archiveId, -1));
  const sha256 = await digest(encrypted);
  return { manifest, encrypted, sha256, objectKey: `${archiveObjectPrefix(metadata)}manifest-${sha256}.kca` };
}

export async function openArchiveManifest(master: string, envelope: Uint8Array, expected?: ArchiveReference): Promise<ArchiveManifest> {
  if (envelope.length > LIMIT.encryptedManifestBytes) fail('encrypted manifest exceeds limit.');
  if (expected && await digest(envelope) !== expected.manifestSha256) fail('referenced manifest checksum mismatch.');
  const opened = await openPart(await archiveDomainKey(master), envelope);
  if (opened.header.part !== -1 || opened.plaintext.length > LIMIT.manifestBytes) fail('invalid manifest envelope.');
  const manifest: unknown = JSON.parse(decoder.decode(opened.plaintext)); validateArchiveManifest(manifest);
  if (manifest.archiveId !== opened.header.backupId || (expected && (manifest.archiveId !== expected.archiveId || manifest.kind !== expected.kind || expected.manifestObjectKey !== `${archiveObjectPrefix(manifest)}manifest-${expected.manifestSha256}.kca`))) fail('manifest identity mismatch.');
  return manifest;
}

export async function verifyArchivePart(master: string, manifest: ArchiveManifest, part: ArchivePartDescriptor, envelope: Uint8Array): Promise<ArchiveRecord[]> {
  validateDescriptor(part, manifest, part.index);
  if (envelope.length !== part.encryptedBytes || await digest(envelope) !== part.encryptedSha256) fail('encrypted part checksum mismatch.');
  const opened = await openPart(await archiveDomainKey(master), envelope);
  if (opened.header.backupId !== manifest.archiveId || opened.header.part !== part.index || opened.plaintext.length !== part.compressedBytes || await digest(opened.plaintext) !== part.compressedSha256) fail('compressed part identity/checksum mismatch.');
  const plaintext = await transformBounded(opened.plaintext, true, part.plaintextBytes);
  if (plaintext.length !== part.plaintextBytes || await digest(plaintext) !== part.plaintextSha256) fail('plaintext part checksum mismatch.');
  const decoded = decoder.decode(plaintext);
  if (!decoded.endsWith('\n')) fail('JSONL must end with a newline.');
  const lines = decoded.slice(0, -1).split('\n'); if (lines.length !== part.recordCount || lines.length > LIMIT.recordsPerPart) fail('part row count mismatch.');
  const records: ArchiveRecord[] = [], counts = emptyArchiveCounts(), coverage = emptyArchiveCoverage();
  for (const line of lines) {
    if (encoder.encode(line + '\n').length > LIMIT.recordBytes) fail('record exceeds limit.');
    const record: unknown = JSON.parse(line); validateArchiveRecord(record, manifest);
    if (records.length && compareArchiveRecords(records[records.length - 1], record) >= 0) fail('duplicate/out-of-order record.');
    records.push(record); counts[record.table]++; mergeCoverage(coverage, archiveRecordCoverage(record));
  }
  if (compareArchiveRecords(records[0], part.first) !== 0 || compareArchiveRecords(records[records.length - 1], part.last) !== 0 || !equalCounts(counts, part.recordCounts) || !equalCoverage(coverage, part.coverage)) fail('part evidence differs from manifest.');
  return records;
}

/** Producer retains at most one bounded part. Writes may be retried with fresh random encryption. */
export async function createArchive(master: string, metadata: ArchiveMetadata, source: AsyncIterable<ArchiveRecord> | Iterable<ArchiveRecord>, writePart: (part: ArchivePartDescriptor, encrypted: Uint8Array) => Promise<void>): Promise<Awaited<ReturnType<typeof sealArchiveManifest>>> {
  exactKeys(metadata, metadata.semanticProof === undefined ? metadataKeys : [...metadataKeys, 'semanticProof']); validateArchiveMetadata(metadata);
  const parts: ArchivePartDescriptor[] = []; let pending: ArchiveRecord[] = [], size = 0, previous: ArchiveRecord | undefined;
  const flush = async () => {
    if (!pending.length) return;
    const sealed = await sealArchivePart(master, metadata, parts.length, pending); await writePart(sealed.descriptor, sealed.encrypted); parts.push(sealed.descriptor); pending = []; size = 0;
  };
  for await (const record of source) {
    validateArchiveRecord(record, metadata);
    if (previous && compareArchiveRecords(previous, record) >= 0) fail('input must be strictly ordered with no duplicates.'); previous = record;
    const bytes = encoder.encode(JSON.stringify(record) + '\n').length;
    if (pending.length === LIMIT.recordsPerPart || size + bytes > LIMIT.plaintextPartBytes) await flush();
    pending.push(record); size += bytes;
  }
  await flush(); return sealArchiveManifest(master, metadata, parts);
}

/** Verifies every dependency and every part before publishing. A sink must keep staging private. */
export async function verifyArchiveGraph(master: string, entry: Uint8Array, readObject: (objectKey: string, maximumBytes: number) => Promise<Uint8Array>, sink: ArchiveStagingSink): Promise<ArchiveManifest[]> {
  const visited = new Map<string, string>(), active = new Set<string>(), manifests: ArchiveManifest[] = [];
  let totalBytes = 0, root: ArchiveManifest | undefined;
  const visit = async (envelope: Uint8Array, expected: ArchiveReference | undefined, depth: number, referencedBy?: ArchiveManifest): Promise<void> => {
    if (depth > LIMIT.graphDepth) fail('reference graph is too deep.');
    const manifest = await openArchiveManifest(master, envelope, expected), hash = await digest(envelope);
    if (referencedBy && manifest.createdAt > referencedBy.createdAt) fail('an addendum cannot reference a later archive.');
    if (active.has(manifest.archiveId)) fail('cyclic archive references.');
    const seen = visited.get(manifest.archiveId); if (seen) { if (seen !== hash) fail('archive ID identifies conflicting immutable versions.'); return; }
    if (!root) root = manifest;
    if (manifest.centerId !== root.centerId || manifest.month !== root.month || manifest.timezone !== root.timezone || manifest.createdAt > root.createdAt) fail('reference scope/time mismatch.');
    if (visited.size >= LIMIT.graphArchives) fail('reference graph contains too many archives.');
    visited.set(manifest.archiveId, hash); active.add(manifest.archiveId);
    totalBytes += manifest.plaintextBytes; if (totalBytes > LIMIT.plaintextGraphBytes) fail('reference graph exceeds raw byte limit.');
    for (const reference of manifest.references) await visit(await readObject(reference.manifestObjectKey, LIMIT.encryptedManifestBytes), reference, depth + 1, manifest);
    for (const part of manifest.parts) {
      const records = await verifyArchivePart(master, manifest, part, await readObject(part.objectKey, part.encryptedBytes));
      await sink.stagePart(records, part, manifest);
    }
    active.delete(manifest.archiveId); manifests.push(manifest);
  };
  try {
    await visit(entry, undefined, 0);
    if (manifests.some(manifest => manifest.format === ARCHIVE_FORMAT_V2)) {
      if (manifests.some(manifest => manifest.format !== ARCHIVE_FORMAT_V2) || !sink.semanticStore) fail('v2 requires a complete semantic graph and private staged store.');
      await verifyArchiveSemantics(manifests, sink.semanticStore);
    }
    await sink.publish(manifests); return manifests;
  }
  catch (error) { await sink.discard(); throw error; }
}

/** A monthly archive can be verified alone. Addenda always require graph verification. */
export async function verifyArchive(master: string, entry: Uint8Array, readObject: (objectKey: string, maximumBytes: number) => Promise<Uint8Array>, sink: ArchiveStagingSink): Promise<ArchiveManifest[]> {
  return verifyArchiveGraph(master, entry, readObject, sink);
}
