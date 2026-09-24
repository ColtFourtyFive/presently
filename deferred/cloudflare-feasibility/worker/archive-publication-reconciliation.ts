import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, ARCHIVE_TABLES, type ArchiveCounts, type ArchiveManifest, type ArchiveRecord, type ArchiveReference } from '../shared/archive-format';
import { emptyArchiveCounts, openArchiveManifest, verifyArchivePart } from './archive-codec';
import { digest } from './backup-crypto';
import { readArchiveEvidenceObject, type ArchiveRecordEvidenceStorage } from './archive-record-evidence';
import { readCompletedMonthlySemanticProof, type MonthlySemanticRunHandle } from './archive-semantic-runner';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import type { ArchivePublicationDescriptorRow } from './archive-publication-schema';
import { archiveReconciliationLeaseSql, type ArchiveReconciliationJobRow } from './archive-reconciliation-schema';
import { INITIAL_LOCATOR_DIGEST, partitionPage, buildLocator, appendLocatorDigest } from './archive-publication-locators';

export const PUBLICATION_DESCRIPTOR_COLUMNS = ['publication_id','verification_id','generation','run_id','snapshot_commit_token','graph_sha256','validator_version','archive_id','center_id','month','timezone','root_reference_json','header_json','header_sha256','manifest_object_key','manifest_sha256','format','locator_version','record_count','request_count','counts_json','locator_digest','published_at'] as const;
export type PublicationReconciliationHandle = { reconciliationId: string; generation: string };
type Phase = 'records' | 'catalog_parts' | 'catalog_records' | 'catalog_requests' | 'complete';
type Cursor = { version: 1; nextPart: number; nextOffset: number; partAfter: number; recordPart: number; recordOffset: number; requestAfter: string };
type Counters = { parts: number; records: number; requests: number; catalogParts: number; catalogRecords: number; catalogRequests: number; counts: ArchiveCounts };
export type PublicationReconciliationAdvance = { state: ArchiveReconciliationJobRow['state']; phase: Phase; revision: number; processed: number; busy: boolean; ready: boolean };
const encoder = new TextEncoder();
const hash = (text: string) => digest(encoder.encode(text));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const initialCursor = (): Cursor => ({ version: 1, nextPart: 0, nextOffset: 0, partAfter: -1, recordPart: -1, recordOffset: -1, requestAfter: '' });
const initialCounters = (): Counters => ({ parts: 0, records: 0, requests: 0, catalogParts: 0, catalogRecords: 0, catalogRequests: 0, counts: emptyArchiveCounts() });
function fail(code: string): never { throw new Error(`ARCHIVE_RECONCILIATION_${code}`); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
const integer = (value: unknown, maximum: number, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
function descriptorJson(row: ArchivePublicationDescriptorRow): string { return JSON.stringify(Object.fromEntries(PUBLICATION_DESCRIPTOR_COLUMNS.map(column => [column, row[column]]))); }
function outcome(row: ArchiveReconciliationJobRow, processed = 0, busy = false, ready = false): PublicationReconciliationAdvance { return { state: row.state, phase: row.phase, revision: row.revision, processed, busy, ready }; }
function checkedHandle(value: PublicationReconciliationHandle) { const handle = Object.freeze({ ...value }); if (!id(handle.reconciliationId) || !id(handle.generation)) fail('HANDLE_INVALID'); return handle; }
function encodingOf(value: unknown): string {
  if (typeof value !== 'string') fail('REGISTRY_INVALID');
  return /^[a-fA-F0-9]{64}$/.test(value) ? 'hex-sha256' : /^[A-Za-z0-9+/]{43}=$/.test(value) ? 'base64-sha256' : /^[A-Za-z0-9_-]{43}$/.test(value) ? 'base64url-sha256' : 'opaque';
}

function readProgress(job: ArchiveReconciliationJobRow, publication: ArchivePublicationDescriptorRow): { cursor: Cursor; counters: Counters } {
  if (encoder.encode(job.cursor_json).length > 2048 || encoder.encode(job.counters_json).length > 4096) fail('CURSOR_BOUND');
  let cursor: unknown, counters: unknown;
  try { cursor = JSON.parse(job.cursor_json); counters = JSON.parse(job.counters_json); } catch { fail('CURSOR_INVALID'); }
  if (!exact(cursor, Object.keys(initialCursor())) || cursor.version !== 1 || !integer(cursor.nextPart, job.expected_parts) || !integer(cursor.nextOffset, 255)
    || !integer(cursor.partAfter, 511, -1) || !integer(cursor.recordPart, 511, -1) || !integer(cursor.recordOffset, 255, -1)
    || typeof cursor.requestAfter !== 'string' || cursor.requestAfter !== '' && !id(cursor.requestAfter)
    || !exact(counters, Object.keys(initialCounters())) || !exact(counters.counts, ARCHIVE_TABLES)) fail('CURSOR_INVALID');
  for (const name of ['parts','catalogParts'] as const) if (!integer(counters[name], job.expected_parts)) fail('CURSOR_INVALID');
  for (const name of ['records','catalogRecords'] as const) if (!integer(counters[name], publication.record_count)) fail('CURSOR_INVALID');
  for (const name of ['requests','catalogRequests'] as const) if (!integer(counters[name], publication.request_count)) fail('CURSOR_INVALID');
  const expected = JSON.parse(publication.counts_json) as ArchiveCounts;
  const parsedCounts = counters.counts as Record<string, unknown>;
  if (ARCHIVE_TABLES.some(table => !integer(parsedCounts[table], expected[table]))) fail('CURSOR_INVALID');
  const c = cursor as Cursor, n = counters as Counters;
  if (ARCHIVE_TABLES.reduce((sum, table) => sum + n.counts[table], 0) !== n.records || n.requests !== n.counts.attendance_events + n.counts.attendance_corrections
    || c.nextPart !== n.parts || c.nextPart === job.expected_parts && c.nextOffset !== 0
    || c.partAfter !== n.catalogParts - 1 || (n.catalogRecords === 0 ? c.recordPart !== -1 || c.recordOffset !== -1 : c.recordPart < 0 || c.recordOffset < 0)
    || (c.requestAfter === '') !== (n.catalogRequests === 0)) fail('CURSOR_INVALID');
  const phases: Phase[] = ['records','catalog_parts','catalog_records','catalog_requests','complete'];
  const phase = phases.indexOf(job.phase);
  if (phase < 0 || phase === 0 && (n.catalogParts || n.catalogRecords || n.catalogRequests)
    || phase > 0 && (n.records !== publication.record_count || n.requests !== publication.request_count || n.parts !== job.expected_parts || c.nextOffset !== 0 || job.locator_digest !== publication.locator_digest)
    || phase === 1 && (n.catalogRecords || n.catalogRequests) || phase > 1 && n.catalogParts !== job.expected_parts
    || phase === 2 && n.catalogRequests || phase > 2 && n.catalogRecords !== publication.record_count
    || phase === 4 && n.catalogRequests !== publication.request_count) fail('CURSOR_INVALID');
  return { cursor: c, counters: n };
}

/** Creates private reconciliation work from fresh, supported current-generation
 * semantic proof. The original publication and request owners are immutable. */
export async function startPublicationReconciliation<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, publicationId: string, suppliedProof: MonthlySemanticRunHandle, reconciliationId: string = crypto.randomUUID()): Promise<PublicationReconciliationHandle> {
  if (!id(publicationId) || !id(reconciliationId)) fail('HANDLE_INVALID');
  const proof = await readCompletedMonthlySemanticProof(db, suppliedProof);
  const selected = await db.batch<ArchivePublicationDescriptorRow>([db.prepare(`SELECT ${PUBLICATION_DESCRIPTOR_COLUMNS.join(',')} FROM archive_publications WHERE publication_id=?`).bind(publicationId)]);
  const publication = selected[0].results[0];
  if (!publication || publication.format !== ARCHIVE_FORMAT_V2 || publication.locator_version !== 1 || publication.validator_version !== 1
    || publication.record_count > 20_000 || publication.header_json !== JSON.stringify(proof.header) || publication.root_reference_json !== proof.rootReferenceJson) fail('PUBLICATION_MISMATCH');
  const json = descriptorJson(publication), fingerprint = await hash(json);
  const rows = await db.batch<ArchiveReconciliationJobRow>([
    db.prepare(`INSERT INTO archive_publication_reconciliation_jobs(reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,
      descriptor_json,descriptor_sha256,expected_parts,state,phase,revision,lease_token,lease_expires_at,cursor_json,counters_json,locator_digest,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,1,?,?,m.part_count,'pending','records',0,NULL,NULL,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM archive_semantic_manifests m WHERE m.verification_id=? AND m.generation=? AND m.archive_id=? AND NOT EXISTS(SELECT 1 FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?)`)
      .bind(reconciliationId, publicationId, proof.handle.generation, proof.handle.verificationId, proof.handle.runId, proof.handle.commitToken, proof.handle.graphSha256,
        json, fingerprint, JSON.stringify(initialCursor()), JSON.stringify(initialCounters()), INITIAL_LOCATOR_DIGEST, proof.handle.verificationId, proof.handle.generation, proof.header.archiveId, reconciliationId),
    db.prepare('SELECT * FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(reconciliationId),
  ]);
  const row = rows[1].results[0];
  if (!row || row.publication_id !== publicationId || row.execution_generation !== proof.handle.generation || row.verification_id !== proof.handle.verificationId || row.run_id !== proof.handle.runId
    || row.snapshot_commit_token !== proof.handle.commitToken || row.graph_sha256 !== proof.handle.graphSha256 || row.descriptor_json !== json || row.descriptor_sha256 !== fingerprint || row.state === 'invalid') fail('START_CONFLICT');
  return { reconciliationId, generation: row.execution_generation };
}

async function authenticateManifest(storage: ArchiveRecordEvidenceStorage, publication: ArchivePublicationDescriptorRow, job: ArchiveReconciliationJobRow): Promise<ArchiveManifest> {
  const reference = JSON.parse(publication.root_reference_json) as ArchiveReference;
  const manifest = await openArchiveManifest(storage.masterKey, await readArchiveEvidenceObject(storage.bucket, reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes), reference);
  const { parts, ...header } = manifest;
  if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.kind !== 'monthly' || manifest.references.length || JSON.stringify(header) !== publication.header_json
    || await hash(JSON.stringify(header)) !== publication.header_sha256 || parts.length !== job.expected_parts) fail('MANIFEST_MISMATCH');
  return manifest;
}

export async function advancePublicationReconciliation<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, suppliedStorage: ArchiveRecordEvidenceStorage, suppliedHandle: PublicationReconciliationHandle, suppliedSelection: { expectedRevision: number }): Promise<PublicationReconciliationAdvance> {
  const handle = checkedHandle(suppliedHandle), selection = Object.freeze({ ...suppliedSelection }), storage = Object.freeze({ bucket: suppliedStorage.bucket, masterKey: suppliedStorage.masterKey });
  if (!integer(selection.expectedRevision, Number.MAX_SAFE_INTEGER)) fail('SELECTION_INVALID');
  const lease = crypto.randomUUID();
  const initial = await db.batch<ArchiveReconciliationJobRow & { current_ready?: number }>([
    db.prepare(`UPDATE archive_publication_reconciliation_jobs SET state='running',revision=revision+1,lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE reconciliation_id=? AND execution_generation=? AND revision=? AND state IN ('pending','running') AND (lease_token IS NULL OR lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`).bind(lease, handle.reconciliationId, handle.generation, selection.expectedRevision),
    db.prepare(`SELECT j.*,EXISTS(SELECT 1 FROM archive_publication_availability a JOIN history_runtime h ON h.id=1 AND h.generation=a.generation WHERE a.publication_id=j.publication_id AND a.generation=j.execution_generation AND a.status='ready' AND a.reconciliation_id=j.reconciliation_id AND h.state='ready') AS current_ready FROM archive_publication_reconciliation_jobs j WHERE j.reconciliation_id=? AND j.execution_generation=?`).bind(handle.reconciliationId, handle.generation),
  ]);
  const job = initial[1].results[0];
  if (!job) fail('STALE');
  if (!initial[0].results.length) return outcome(job, 0, job.state === 'pending' || job.state === 'running', job.state === 'complete' && job.current_ready === 1);
  const identity = [job.reconciliation_id, job.execution_generation, job.revision, lease];
  const guard = `j.reconciliation_id=? AND j.execution_generation=? AND j.revision=? AND j.lease_token=? AND ${archiveReconciliationLeaseSql()}`;
  try {
    const publication = JSON.parse(job.descriptor_json) as ArchivePublicationDescriptorRow;
    if (descriptorJson(publication) !== job.descriptor_json || await hash(job.descriptor_json) !== job.descriptor_sha256) fail('DESCRIPTOR_INVALID');
    const { cursor, counters } = readProgress(job, publication);
    const manifest = await authenticateManifest(storage, publication, job);
    const prefix = (part: number) => manifest.parts.slice(0, part).reduce((sum, item) => sum + item.recordCount, 0);
    if (prefix(cursor.nextPart) + cursor.nextOffset !== counters.records || cursor.nextPart < job.expected_parts && cursor.nextOffset >= manifest.parts[cursor.nextPart].recordCount
      || counters.catalogRecords > 0 && (!manifest.parts[cursor.recordPart] || cursor.recordOffset >= manifest.parts[cursor.recordPart].recordCount || prefix(cursor.recordPart) + cursor.recordOffset + 1 !== counters.catalogRecords)) fail('CURSOR_INVALID');
    let phase = job.phase, processed = 0, locatorDigest = job.locator_digest;
    if (phase === 'records') {
      if (cursor.nextPart === job.expected_parts) {
        if (counters.records !== publication.record_count || counters.requests !== publication.request_count || locatorDigest !== publication.locator_digest
          || ARCHIVE_TABLES.some(table => counters.counts[table] !== manifest.recordCounts[table])) fail('CATALOG_TOTALS');
        phase = 'catalog_parts';
      } else {
        const descriptor = manifest.parts[cursor.nextPart], descriptorJson = JSON.stringify(descriptor), descriptorSha = await hash(descriptorJson);
        const partRecords = await verifyArchivePart(storage.masterKey, manifest, descriptor, await readArchiveEvidenceObject(storage.bucket, descriptor.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, descriptor.encryptedBytes));
        const page = partitionPage(partRecords, cursor.nextOffset);
        if (!page.records.length) fail('CURSOR_INVALID');
        const binds = page.records.flatMap(record => [record.table, record.key]);
        const catalog = await db.batch<Record<string, unknown>>([
          db.prepare('SELECT * FROM archive_publication_parts WHERE publication_id=? AND part_index=?').bind(publication.publication_id, descriptor.index),
          db.prepare(`WITH expected(table_name,record_key) AS (VALUES ${page.records.map(() => '(?,?)').join(',')})
            SELECT e.table_name AS expected_table,e.record_key AS expected_key,r.*,q.request_id AS claim_request_id,q.source_kind AS claim_kind,q.center_id AS claim_center,q.payload_hash AS claim_hash,
              q.publication_id AS claim_publication,q.table_name AS claim_table,q.record_key AS claim_key,k.source_kind AS owner_kind,k.center_id AS owner_center,k.payload_hash AS owner_hash,k.hash_encoding,k.canonicalization,s.record_json AS staged_record_json
            FROM expected e LEFT JOIN archive_publication_records r ON r.publication_id=? AND r.table_name=e.table_name AND r.record_key=e.record_key
            LEFT JOIN archive_publication_requests q ON q.publication_id=r.publication_id AND q.table_name=r.table_name AND q.record_key=r.record_key
            LEFT JOIN history_request_keys k ON k.request_id=q.request_id
            LEFT JOIN archive_semantic_rows s ON s.verification_id=? AND s.generation=? AND s.archive_id=? AND s.table_name=e.table_name AND s.record_key=e.record_key`)
            .bind(...binds, publication.publication_id, job.verification_id, job.execution_generation, publication.archive_id),
        ]);
        const part = catalog[0].results[0];
        if (!part || part.descriptor_json !== descriptorJson || part.descriptor_sha256 !== descriptorSha || part.record_count !== descriptor.recordCount || part.indexed_count !== descriptor.recordCount || part.completed !== 1) fail('PART_CATALOG_MISMATCH');
        if (catalog[1].results.length !== page.records.length) fail('RECORD_CATALOG_MISMATCH');
        const locators = [];
        for (const [index, record] of page.records.entries()) {
          const matches = catalog[1].results.filter(row => row.expected_table === record.table && row.expected_key === record.key);
          const row = matches[0], locator = await buildLocator(record, descriptor.index, cursor.nextOffset + index, descriptorSha);
          if (matches.length !== 1 || row.publication_id !== publication.publication_id || row.table_name !== record.table || row.record_key !== record.key || row.part_index !== locator.part || row.part_offset !== locator.offset
            || row.descriptor_sha256 !== locator.descriptorSha256 || row.record_sha256 !== locator.recordSha256 || row.record_bytes !== locator.recordBytes || row.staged_record_json !== JSON.stringify(record)) fail('RECORD_CATALOG_MISMATCH');
          const kind = record.table === 'attendance_events' ? 'event' : record.table === 'attendance_corrections' ? 'correction' : null;
          if (kind) {
            if (row.claim_request_id !== record.key || row.claim_kind !== kind || row.claim_center !== publication.center_id || row.claim_hash !== record.row.payload_hash
              || row.claim_publication !== publication.publication_id || row.claim_table !== record.table || row.claim_key !== record.key
              || row.owner_kind !== kind || row.owner_center !== publication.center_id || row.owner_hash !== record.row.payload_hash || row.hash_encoding !== encodingOf(record.row.payload_hash) || row.canonicalization !== 'legacy-unverified') fail('REQUEST_CATALOG_MISMATCH');
            counters.requests++;
          } else if (row.claim_request_id !== null) fail('REQUEST_CATALOG_MISMATCH');
          counters.records++; counters.counts[record.table]++; locators.push(locator);
        }
        locatorDigest = await appendLocatorDigest(locatorDigest, locators);
        cursor.nextOffset = page.complete ? 0 : page.nextOffset;
        if (page.complete) { cursor.nextPart++; counters.parts++; }
        processed = page.records.length;
      }
    } else if (phase === 'catalog_parts') {
      const rows = (await db.batch<{ part_index: number }>([db.prepare('SELECT part_index FROM archive_publication_parts WHERE publication_id=? AND part_index>? ORDER BY part_index LIMIT 8').bind(publication.publication_id, cursor.partAfter)]))[0].results;
      if (!rows.length) { if (counters.catalogParts !== job.expected_parts) fail('PART_CATALOG_MISMATCH'); phase = 'catalog_records'; }
      else { for (const row of rows) { if (row.part_index !== counters.catalogParts || !manifest.parts[row.part_index]) fail('PART_CATALOG_MISMATCH'); counters.catalogParts++; cursor.partAfter = row.part_index; } processed = rows.length; }
    } else if (phase === 'catalog_records') {
      const rows = (await db.batch<{ part_index: number; part_offset: number }>([db.prepare('SELECT part_index,part_offset FROM archive_publication_records WHERE publication_id=? AND (part_index,part_offset)>(?,?) ORDER BY part_index,part_offset LIMIT 8').bind(publication.publication_id, cursor.recordPart, cursor.recordOffset)]))[0].results;
      if (!rows.length) { if (counters.catalogRecords !== publication.record_count) fail('RECORD_CATALOG_MISMATCH'); phase = 'catalog_requests'; }
      else {
        for (const row of rows) {
          if (!manifest.parts[row.part_index] || !integer(row.part_offset, manifest.parts[row.part_index].recordCount - 1)
            || manifest.parts.slice(0, row.part_index).reduce((sum, part) => sum + part.recordCount, 0) + row.part_offset !== counters.catalogRecords) fail('RECORD_CATALOG_MISMATCH');
          counters.catalogRecords++; cursor.recordPart = row.part_index; cursor.recordOffset = row.part_offset;
        }
        processed = rows.length;
      }
    } else if (phase === 'catalog_requests') {
      const rows = (await db.batch<{ request_id: string }>([db.prepare('SELECT request_id FROM archive_publication_requests INDEXED BY archive_publication_requests_publication_request WHERE publication_id=? AND request_id>? ORDER BY request_id LIMIT 8').bind(publication.publication_id, cursor.requestAfter)]))[0].results;
      if (!rows.length) { if (counters.catalogRequests !== publication.request_count) fail('REQUEST_CATALOG_MISMATCH'); phase = 'complete'; }
      else { for (const row of rows) { if (!id(row.request_id) || row.request_id <= cursor.requestAfter || ++counters.catalogRequests > publication.request_count) fail('REQUEST_CATALOG_MISMATCH'); cursor.requestAfter = row.request_id; } processed = rows.length; }
    } else fail('CURSOR_INVALID');
    const complete = phase === 'complete';
    const candidate = { ...job, phase, cursor_json: JSON.stringify(cursor), counters_json: JSON.stringify(counters), locator_digest: locatorDigest };
    readProgress(candidate, publication);
    const statements = [db.prepare(`UPDATE archive_publication_reconciliation_jobs AS j SET state=?,phase=?,cursor_json=?,counters_json=?,locator_digest=?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard} RETURNING *`)
      .bind(complete ? 'complete' : 'pending', phase, candidate.cursor_json, candidate.counters_json, locatorDigest, ...identity),
      db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('ARCHIVE_RECONCILIATION_STALE','$') END AS committed")];
    if (complete) {
      statements.push(db.prepare(`INSERT INTO archive_publication_reconciliation_receipts(reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,descriptor_json,descriptor_sha256,expected_parts,counters_json,locator_digest,completed_at)
        SELECT reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,descriptor_json,descriptor_sha256,expected_parts,counters_json,locator_digest,strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=? AND execution_generation=? AND state='complete' AND revision=?`).bind(job.reconciliation_id, job.execution_generation, job.revision + 1));
      statements.push(db.prepare(`UPDATE archive_publication_availability SET generation=?,status='ready',reconciliation_id=? WHERE publication_id=?`).bind(job.execution_generation, job.reconciliation_id, job.publication_id));
      statements.push(db.prepare(`INSERT INTO archive_publication_availability(publication_id,generation,status,reconciliation_id)
        SELECT publication_id,execution_generation,'ready',reconciliation_id FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?
        AND NOT EXISTS(SELECT 1 FROM archive_publication_availability WHERE publication_id=?)`).bind(job.reconciliation_id, job.publication_id));
      statements.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM archive_publication_availability WHERE publication_id=? AND generation=? AND status='ready' AND reconciliation_id=?) THEN 1 ELSE json_extract('ARCHIVE_RECONCILIATION_STALE','$') END AS committed").bind(job.publication_id, job.execution_generation, job.reconciliation_id));
    }
    const written = await db.batch<ArchiveReconciliationJobRow>(statements);
    if (!written[0].results[0]) fail('STALE');
    return outcome(written[0].results[0], processed, false, complete);
  } catch (error) {
    try { await db.batch([db.prepare(`UPDATE archive_publication_reconciliation_jobs SET state='pending',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reconciliation_id=? AND execution_generation=? AND revision=? AND lease_token=? AND state='running'`).bind(...identity)]); } catch { /* Preserve the original cause and do not regain invalidated authority. */ }
    throw error;
  }
}
