import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, type ArchiveCounts, type ArchiveRecord, type ArchiveReference } from '../shared/archive-format';
import { calendarMonthBounds, emptyArchiveCounts, openArchiveManifest, verifyArchivePart } from './archive-codec';
import { digest } from './backup-crypto';
import { readCompletedMonthlySemanticProof, type MonthlySemanticRunHandle } from './archive-semantic-runner';
import type { ArchiveSemanticHeader, ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import { validateSemanticShape } from './archive-semantic-rules';
import { archivePublicationLeaseSql, type ArchivePublicationBuildRow } from './archive-publication-schema';
import type { ArchiveRecordEvidenceStorage } from './archive-record-evidence';
import { requireSealedEvent } from './history-request';
import { INITIAL_LOCATOR_DIGEST, partitionPage, buildLocator, appendLocatorDigest, type PublicationLocator } from './archive-publication-locators';

export type MonthlyPublicationHandle = { publicationId: string; generation: string };
export type MonthlyPublicationSelection = { expectedRevision: number };
export type MonthlyPublicationAdvance = { state: 'building' | 'published' | 'invalid'; revision: number; processed: number; busy: boolean };
const encoder = new TextEncoder();
const hash = (value: unknown) => digest(encoder.encode(JSON.stringify(value)));
function fail(code: string): never { throw new Error(`ARCHIVE_PUBLICATION_${code}`); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value); }
function handleCopy(value: MonthlyPublicationHandle): Readonly<MonthlyPublicationHandle> {
  const result = Object.freeze({ ...value });
  if (!identifier(result.publicationId) || !identifier(result.generation)) fail('HANDLE_INVALID');
  return result;
}
function result(row: ArchivePublicationBuildRow, processed = 0, busy = false): MonthlyPublicationAdvance {
  return { state: row.state, revision: row.revision, processed, busy };
}

/** Internal foundation only. No route, scheduler, live lookup activation, or
 * source deletion. Completed supported semantic proof is mandatory. */
export async function startMonthlyPublication<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, supplied: MonthlySemanticRunHandle, publicationId: string = crypto.randomUUID()): Promise<MonthlyPublicationHandle> {
  if (!identifier(publicationId)) fail('HANDLE_INVALID');
  const { handle, header, rootReferenceJson } = await readCompletedMonthlySemanticProof(db, supplied);
  if (header.recordCount > 20_000) fail('RECORD_BOUND');
  const headerJson = JSON.stringify(header), headerSha = await hash(header);
  const initialDigest = INITIAL_LOCATOR_DIGEST;
  const rows = await db.batch<ArchivePublicationBuildRow>([db.prepare(`INSERT INTO archive_publication_builds
    (publication_id,verification_id,generation,run_id,snapshot_commit_token,graph_sha256,validator_version,
     archive_id,center_id,month,timezone,root_reference_json,header_json,header_sha256,part_count,record_count,
     state,revision,lease_token,lease_expires_at,next_part,next_offset,indexed_count,request_count,counts_json,locator_digest,created_at,updated_at)
    SELECT ?,?,?,?,?,?,1,?,?,?,?,?,?,?,m.part_count,?,'building',0,NULL,NULL,0,0,0,0,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM archive_semantic_manifests m WHERE m.verification_id=? AND m.generation=? AND m.archive_id=? AND NOT EXISTS(SELECT 1 FROM archive_publication_builds WHERE publication_id=?) RETURNING *`).bind(publicationId, handle.verificationId, handle.generation, handle.runId, handle.commitToken, handle.graphSha256,
      header.archiveId, header.centerId, header.month, header.timezone, rootReferenceJson, headerJson, headerSha, header.recordCount,
      JSON.stringify(emptyArchiveCounts()), initialDigest, handle.verificationId, handle.generation, header.archiveId, publicationId),
    db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(publicationId)]);
  const row = rows[1].results[0];
  if (!row || row.generation !== handle.generation || row.run_id !== handle.runId || row.header_json !== headerJson || row.root_reference_json !== rootReferenceJson || row.snapshot_commit_token !== handle.commitToken || row.graph_sha256 !== handle.graphSha256 || row.state === 'invalid') fail('START_CONFLICT');
  return { publicationId, generation: handle.generation };
}

async function objectBytes(bucket: ArchiveRecordEvidenceStorage['bucket'], key: string, maximum: number, expected?: number): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) fail('OBJECT_UNAVAILABLE');
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > maximum || expected !== undefined && object.size !== expected) {
    await object.body.cancel(); fail('OBJECT_BOUND');
  }
  const bytes = new Uint8Array(object.size), reader = object.body.getReader(); let offset = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; if (offset + item.value.byteLength > bytes.length) fail('OBJECT_BOUND'); bytes.set(item.value, offset); offset += item.value.byteLength; }
    if (offset !== bytes.length) fail('OBJECT_BOUND');
  } catch (error) { try { await reader.cancel(); } catch { /* Preserve evidence error. */ } throw error; }
  finally { reader.releaseLock(); }
  return bytes;
}
function encodingOf(value: unknown): string {
  if (typeof value !== 'string') fail('REQUEST_HASH_INVALID');
  return /^[a-fA-F0-9]{64}$/.test(value) ? 'hex-sha256' : /^[A-Za-z0-9+/]{43}=$/.test(value) ? 'base64-sha256' : /^[A-Za-z0-9_-]{43}$/.test(value) ? 'base64url-sha256' : 'opaque';
}

/** Source comparisons are immutable evidence only. Mutable captured profiles,
 * visits and reviews retain their verified snapshot versions. */
function sourceFence(record: ArchiveRecord, header: ArchiveSemanticHeader): { sql: string; values: unknown[]; kind: 'event' | 'correction' | null } {
  const table = record.table, row = record.row;
  if (table !== 'attendance_events' && table !== 'attendance_corrections' && table !== 'audit_entries') return { sql: '1', values: [], kind: null };
  const source = table === 'audit_entries' ? 'audit_timeline' : table;
  const equal = Object.keys(row).map(column => `s."${column}" IS json_extract(payload.j,'$.${column}')`).join(' AND ');
  const kind = table === 'attendance_events' ? 'event' : table === 'attendance_corrections' ? 'correction' : null;
  if (!kind) return { sql: `EXISTS(SELECT 1 FROM ${source} s,payload WHERE s.id=? AND ${equal})`, values: [record.key], kind };
  if (kind === 'event') requireSealedEvent(row);
  const bounds = calendarMonthBounds(header.month, header.timezone);
  const member = kind === 'event' ? `((s.visit_id IS NULL AND s.action='exceptional_departure' AND s.observed_at>=? AND s.observed_at<? AND NOT EXISTS(SELECT 1 FROM observation_effective_times p WHERE p.event_id=s.id AND p.version>1)) OR EXISTS(SELECT 1 FROM visits v WHERE v.id=s.visit_id AND v.center_id=s.center_id AND v.original_check_in_at>=? AND v.original_check_in_at<?))`
    : `EXISTS(SELECT 1 FROM visits v WHERE v.id=s.visit_id AND v.center_id=s.center_id AND v.original_check_in_at>=? AND v.original_check_in_at<?)`;
  return { sql: `EXISTS(SELECT 1 FROM ${source} s,payload JOIN history_request_keys k ON k.request_id=s.id WHERE s.id=? AND ${equal} AND ${member}
      AND k.source_kind=? AND k.center_id=s.center_id AND k.payload_hash IS s.payload_hash AND k.hash_encoding=? AND k.canonicalization='legacy-unverified')`,
    values: [record.key, ...(kind === 'event' ? [bounds.periodFrom, bounds.periodTo, bounds.periodFrom, bounds.periodTo] : [bounds.periodFrom, bounds.periodTo]), kind, encodingOf(row.payload_hash)], kind };
}

export async function advanceMonthlyPublication<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, suppliedStorage: ArchiveRecordEvidenceStorage, suppliedHandle: MonthlyPublicationHandle, suppliedSelection: MonthlyPublicationSelection): Promise<MonthlyPublicationAdvance> {
  const handle = handleCopy(suppliedHandle), selection = Object.freeze({ ...suppliedSelection });
  const storage = Object.freeze({ bucket: suppliedStorage.bucket, masterKey: suppliedStorage.masterKey });
  if (!Number.isSafeInteger(selection.expectedRevision) || selection.expectedRevision < 0) fail('SELECTION_INVALID');
  const lease = crypto.randomUUID();
  const initial = await db.batch<ArchivePublicationBuildRow>([
    db.prepare(`UPDATE archive_publication_builds AS b SET revision=revision+1,lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE publication_id=? AND generation=? AND revision=? AND state='building'
      AND (lease_token IS NULL OR lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`).bind(lease, handle.publicationId, handle.generation, selection.expectedRevision),
    db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=? AND generation=?').bind(handle.publicationId, handle.generation),
  ]);
  const build = initial[1].results[0];
  if (!build) fail('STALE');
  if (!initial[0].results.length) return result(build, 0, build.state === 'building');
  const identity = [build.publication_id, build.generation, build.revision, lease];
  const guard = `b.publication_id=? AND b.generation=? AND b.revision=? AND b.lease_token=? AND ${archivePublicationLeaseSql()}`;
  try {
    const header = JSON.parse(build.header_json) as ArchiveSemanticHeader;
    const reference = JSON.parse(build.root_reference_json) as ArchiveReference;
    const manifest = await openArchiveManifest(storage.masterKey, await objectBytes(storage.bucket, reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes), reference);
    const { parts, ...authenticatedHeader } = manifest;
    if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.kind !== 'monthly' || manifest.references.length || JSON.stringify(authenticatedHeader) !== build.header_json || await hash(authenticatedHeader) !== build.header_sha256 || parts.length !== build.part_count) fail('HEADER_CHANGED');
    if (build.next_part === build.part_count) {
      const committed = await db.batch<ArchivePublicationBuildRow>([
        db.prepare(`UPDATE archive_publication_builds AS b SET state='published',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard} RETURNING *`).bind(...identity),
        db.prepare(`INSERT INTO archive_publications (publication_id,verification_id,generation,run_id,snapshot_commit_token,graph_sha256,validator_version,
          archive_id,center_id,month,timezone,root_reference_json,header_json,header_sha256,manifest_object_key,manifest_sha256,format,locator_version,record_count,request_count,counts_json,locator_digest,published_at)
          SELECT publication_id,verification_id,generation,run_id,snapshot_commit_token,graph_sha256,validator_version,archive_id,center_id,month,timezone,root_reference_json,header_json,header_sha256,
          json_extract(root_reference_json,'$.manifestObjectKey'),json_extract(root_reference_json,'$.manifestSha256'),'kumon-history-archive-v2',1,record_count,request_count,counts_json,locator_digest,strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM archive_publication_builds WHERE publication_id=? AND generation=? AND state='published' AND revision=?`).bind(build.publication_id, build.generation, build.revision + 1),
        db.prepare(`INSERT INTO archive_publication_availability(publication_id,generation,status) SELECT publication_id,generation,'ready' FROM archive_publications WHERE publication_id=?`).bind(build.publication_id),
        db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('ARCHIVE_PUBLICATION_STALE','$') END AS committed"),
      ]);
      if (!committed[0].results[0]) fail('STALE');
      return result(committed[0].results[0]);
    }
    const descriptor = parts[build.next_part];
    if (!descriptor || descriptor.index !== build.next_part) fail('PART_INVALID');
    const descriptorJson = JSON.stringify(descriptor), descriptorSha = await hash(descriptor);
    const records = await verifyArchivePart(storage.masterKey, manifest, descriptor, await objectBytes(storage.bucket, descriptor.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, descriptor.encryptedBytes));
    const page = partitionPage(records, build.next_offset).records;
    if (!page.length) fail('CURSOR_INVALID');
    const counts = JSON.parse(build.counts_json) as ArchiveCounts;
    let requestCount = 0;
    const statements: S[] = [];
    if (build.next_offset === 0) statements.push(db.prepare(`INSERT INTO archive_publication_parts(publication_id,part_index,descriptor_json,descriptor_sha256,record_count,indexed_count,completed)
      SELECT b.publication_id,?,?,?,?,0,0 FROM archive_publication_builds b WHERE ${guard}`).bind(descriptor.index, descriptorJson, descriptorSha, descriptor.recordCount, ...identity));
    const locators: PublicationLocator[] = [];
    for (const [index, record] of page.entries()) {
      validateSemanticShape(record, header, record.table, record.key);
      const offset = build.next_offset + index, fence = sourceFence(record, header);
      const locator = await buildLocator(record, descriptor.index, offset, descriptorSha);
      const recordJson = JSON.stringify(record), recordSha = locator.recordSha256, recordBytes = locator.recordBytes;
      statements.push(db.prepare(`WITH payload(j) AS (SELECT ?) INSERT INTO archive_publication_records(publication_id,table_name,record_key,part_index,part_offset,descriptor_sha256,record_sha256,record_bytes)
        SELECT b.publication_id,?,?,?,?,?,?,? FROM archive_publication_builds b WHERE ${guard}
        AND EXISTS(SELECT 1 FROM archive_semantic_parts p JOIN archive_semantic_rows r ON r.verification_id=p.verification_id AND r.generation=p.generation AND r.archive_id=p.archive_id AND r.part_index=p.part_index AND r.part_commit_token=p.commit_token
          WHERE p.verification_id=b.verification_id AND p.generation=b.generation AND p.archive_id=b.archive_id AND p.part_index=? AND p.descriptor_json=? AND p.descriptor_sha256=? AND r.table_name=? AND r.record_key=? AND r.record_json=?) AND ${fence.sql}`)
        .bind(JSON.stringify(record.row), record.table, record.key, descriptor.index, offset, descriptorSha, recordSha, recordBytes, ...identity, descriptor.index, descriptorJson, descriptorSha, record.table, record.key, recordJson, ...fence.values));
      if (fence.kind) {
        requestCount++;
        statements.push(db.prepare(`INSERT INTO archive_publication_requests(request_id,publication_id,source_kind,center_id,payload_hash,table_name,record_key)
          SELECT ?,b.publication_id,?,?,?,?,? FROM archive_publication_builds b WHERE ${guard}`).bind(record.key, fence.kind, header.centerId, record.row.payload_hash, record.table, record.key, ...identity));
      }
      counts[record.table]++;
      locators.push(locator);
    }
    const nextOffset = build.next_offset + page.length, completed = nextOffset === descriptor.recordCount;
    const locatorDigest = await appendLocatorDigest(build.locator_digest, locators);
    statements.push(db.prepare(`UPDATE archive_publication_parts SET indexed_count=?,completed=? WHERE publication_id=? AND part_index=? AND indexed_count=? AND EXISTS(SELECT 1 FROM archive_publication_builds b WHERE ${guard})`).bind(nextOffset, completed ? 1 : 0, build.publication_id, descriptor.index, build.next_offset, ...identity));
    statements.push(db.prepare(`UPDATE archive_publication_builds AS b SET next_part=?,next_offset=?,indexed_count=indexed_count+?,request_count=request_count+?,counts_json=?,locator_digest=?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE ${guard} RETURNING *`).bind(completed ? build.next_part + 1 : build.next_part, completed ? 0 : nextOffset, page.length, requestCount, JSON.stringify(counts), locatorDigest, ...identity));
    // A guard that matches no row is not a SQL error. Assert inside the same
    // native transaction so expired or displaced leases roll back the page.
    statements.push(db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('ARCHIVE_PUBLICATION_STALE','$') END AS committed"));
    if (statements.length + 2 > 40) fail('STATEMENT_BOUND');
    const written = await db.batch<ArchivePublicationBuildRow>(statements);
    const next = written.at(-2)?.results[0];
    if (!next) fail('STALE');
    return result(next, page.length);
  } catch (error) {
    // Transient object/storage failures leave a resumable private candidate. A
    // generation/proof change cannot be repaired by silently relabeling it.
    try { await db.batch([db.prepare(`UPDATE archive_publication_builds SET revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE publication_id=? AND generation=? AND revision=? AND lease_token=? AND state='building'`).bind(...identity)]); } catch { /* Preserve the original cause. */ }
    throw error;
  }
}
