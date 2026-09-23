import {
  ARCHIVE_FORMAT_V2,
  ARCHIVE_LIMITS,
  ARCHIVE_TABLES,
  type ArchiveCounts,
  type ArchiveManifest,
  type ArchiveRecord,
  type ArchiveReference,
} from '../shared/archive-format';
import { emptyArchiveCounts, openArchiveManifest, verifyArchivePart } from './archive-codec';
import { partitionPage } from './archive-publication-locators';
import { digest } from './backup-crypto';
import { readArchiveEvidenceObject, type ArchiveRecordEvidenceStorage } from './archive-record-evidence';
import { readCompletedMonthlySemanticProof, type MonthlySemanticRunHandle } from './archive-semantic-runner';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import {
  compactReconciliationLeaseSql,
  type CompactReconciliationCounters,
  type CompactReconciliationCursor,
  type CompactReconciliationJobRow,
  type CompactReconciliationPhase,
} from './archive-compact-reconciliation-schema';

export const COMPACT_DESCRIPTOR_COLUMNS = [
  'publication_id', 'verification_id', 'generation', 'run_id', 'snapshot_commit_token',
  'graph_sha256', 'validator_version', 'archive_id', 'center_id', 'month', 'timezone',
  'root_reference_json', 'header_json', 'header_sha256', 'part_count', 'record_count',
  'catalog_version', 'request_count', 'counts_json', 'published_at',
] as const;

type CompactDescriptor = {
  publication_id: string;
  verification_id: string;
  generation: string;
  run_id: string;
  snapshot_commit_token: string;
  graph_sha256: string;
  validator_version: number;
  archive_id: string;
  center_id: string;
  month: string;
  timezone: string;
  root_reference_json: string;
  header_json: string;
  header_sha256: string;
  part_count: number;
  record_count: number;
  catalog_version: number;
  request_count: number;
  counts_json: string;
  published_at: string;
};

type CatalogRow = Record<string, unknown> & {
  expected_table: string;
  expected_key: string;
  expected_json: string;
  request_id: string | null;
  claim_publication: string | null;
  owner_kind: string | null;
  owner_center: string | null;
  owner_hash: string | null;
  hash_encoding: string | null;
  canonicalization: string | null;
  staged_record_json: string | null;
};

export type CompactReconciliationHandle = { reconciliationId: string; generation: string };
export type CompactReconciliationAdvance = {
  state: CompactReconciliationJobRow['state'];
  phase: CompactReconciliationPhase;
  revision: number;
  processed: number;
  busy: boolean;
  ready: boolean;
};

const encoder = new TextEncoder();
const INITIAL_EVIDENCE_DIGEST = '0'.repeat(64);
const hash = (text: string) => digest(encoder.encode(text));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const initialCursor = (): CompactReconciliationCursor => ({ version: 1, nextPart: 0, nextOffset: 0, requestAfter: '' });
const initialCounters = (): CompactReconciliationCounters => ({ parts: 0, records: 0, requests: 0, catalogRequests: 0, counts: emptyArchiveCounts() });
function fail(code: string): never { throw new Error(`ARCHIVE_COMPACT_RECONCILIATION_${code}`); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function integer(value: unknown, maximum: number, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function encodingOf(value: string): string {
  if (/^[a-fA-F0-9]{64}$/.test(value)) return 'hex-sha256';
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return 'base64-sha256';
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) return 'base64url-sha256';
  return 'opaque';
}
function descriptorJson(row: CompactDescriptor): string {
  return JSON.stringify(Object.fromEntries(COMPACT_DESCRIPTOR_COLUMNS.map(column => [column, row[column]])));
}
function validateHandle(handle: CompactReconciliationHandle): Readonly<CompactReconciliationHandle> {
  const frozen = Object.freeze({ ...handle });
  if (!identifier(frozen.reconciliationId) || !identifier(frozen.generation)) fail('HANDLE_INVALID');
  return frozen;
}
function outcome(row: CompactReconciliationJobRow, processed: number, busy = false, ready = false): CompactReconciliationAdvance {
  return { state: row.state, phase: row.phase, revision: row.revision, processed, busy, ready };
}
async function appendEvidence(prior: string, phase: 'records' | 'catalog_requests', records: readonly ArchiveRecord[]): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(prior) || !records.length || records.length > 8) fail('EVIDENCE_INVALID');
  const entries = records.map(record => ({
    phase,
    table: record.table,
    key: record.key,
    payloadHash: record.table === 'attendance_events' || record.table === 'attendance_corrections'
      ? record.row.payload_hash
      : null,
  }));
  return hash(JSON.stringify({ prior, entries }));
}

function readProgress(job: CompactReconciliationJobRow, publication: CompactDescriptor): {
  cursor: CompactReconciliationCursor;
  counters: CompactReconciliationCounters;
} {
  if (encoder.encode(job.cursor_json).length > 2_048 || encoder.encode(job.counters_json).length > 4_096) fail('CURSOR_BOUND');
  let cursor: unknown;
  let counters: unknown;
  try { cursor = JSON.parse(job.cursor_json); counters = JSON.parse(job.counters_json); } catch { fail('CURSOR_INVALID'); }
  if (!exact(cursor, Object.keys(initialCursor())) || cursor.version !== 1
    || !integer(cursor.nextPart, job.expected_parts) || !integer(cursor.nextOffset, ARCHIVE_LIMITS.recordsPerPart)
    || typeof cursor.requestAfter !== 'string' || (cursor.requestAfter !== '' && !identifier(cursor.requestAfter))
    || !exact(counters, Object.keys(initialCounters())) || !exact(counters.counts, ARCHIVE_TABLES)) fail('CURSOR_INVALID');
  const parsedCursor = cursor as CompactReconciliationCursor;
  const parsedCounters = counters as CompactReconciliationCounters;
  if (!integer(parsedCounters.parts, job.expected_parts)
    || !integer(parsedCounters.records, publication.record_count)
    || !integer(parsedCounters.requests, publication.request_count)
    || !integer(parsedCounters.catalogRequests, publication.request_count)) fail('CURSOR_INVALID');
  const expectedCounts = JSON.parse(publication.counts_json) as ArchiveCounts;
  for (const table of ARCHIVE_TABLES) {
    if (!integer(parsedCounters.counts[table], Number(expectedCounts[table]))) fail('CURSOR_INVALID');
  }
  const total = ARCHIVE_TABLES.reduce((sum, table) => sum + parsedCounters.counts[table], 0);
  if (total !== parsedCounters.records
    || parsedCounters.requests !== parsedCounters.counts.attendance_events + parsedCounters.counts.attendance_corrections
    || parsedCursor.nextPart !== parsedCounters.parts
    || (parsedCursor.nextPart === job.expected_parts && parsedCursor.nextOffset !== 0)
    || !/^[a-f0-9]{64}$/.test(job.evidence_digest)) fail('CURSOR_INVALID');
  if (job.phase === 'records' && (parsedCounters.catalogRequests !== 0 || parsedCursor.requestAfter !== '')) fail('CURSOR_INVALID');
  if ((job.phase === 'catalog_requests' || job.phase === 'complete')
    && (parsedCounters.parts !== job.expected_parts || parsedCounters.records !== publication.record_count
      || parsedCounters.requests !== publication.request_count || parsedCursor.nextPart !== job.expected_parts || parsedCursor.nextOffset !== 0)) fail('CURSOR_INVALID');
  if (job.phase === 'complete' && parsedCounters.catalogRequests !== publication.request_count) fail('CURSOR_INVALID');
  return { cursor: parsedCursor, counters: parsedCounters };
}

/** Start reconciliation only from a fresh proof of the committed archive root. */
export async function startCompactPublicationReconciliation<S extends ArchiveStagingStatement<S>>(
  db: ArchiveStagingDatabase<S>,
  publicationId: string,
  suppliedProof: MonthlySemanticRunHandle,
  reconciliationId: string = crypto.randomUUID(),
): Promise<CompactReconciliationHandle> {
  if (!identifier(publicationId) || !identifier(reconciliationId)) fail('HANDLE_INVALID');
  const proof = await readCompletedMonthlySemanticProof(db, suppliedProof);
  const selected = await db.batch<CompactDescriptor>([
    db.prepare(`SELECT ${COMPACT_DESCRIPTOR_COLUMNS.join(',')} FROM archive_compact_publications WHERE publication_id=?`).bind(publicationId),
  ]);
  const publication = selected[0].results[0];
  if (!publication || publication.catalog_version !== 2 || publication.validator_version !== 1
    || publication.record_count > 20_000 || publication.request_count > publication.record_count
    || publication.header_json !== JSON.stringify(proof.header) || publication.root_reference_json !== proof.rootReferenceJson) fail('PUBLICATION_MISMATCH');
  const json = descriptorJson(publication);
  const fingerprint = await hash(json);
  const rows = await db.batch<CompactReconciliationJobRow>([
    db.prepare(`INSERT INTO archive_compact_reconciliation_jobs(
      reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,
      descriptor_json,descriptor_sha256,expected_parts,state,phase,revision,lease_token,lease_expires_at,cursor_json,counters_json,evidence_digest,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,1,?,?,m.part_count,'pending','records',0,NULL,NULL,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM archive_semantic_manifests m
      WHERE m.verification_id=? AND m.generation=? AND m.archive_id=?
        AND NOT EXISTS(SELECT 1 FROM archive_compact_reconciliation_jobs WHERE reconciliation_id=?)`)
      .bind(reconciliationId, publicationId, proof.handle.generation, proof.handle.verificationId, proof.handle.runId,
        proof.handle.commitToken, proof.handle.graphSha256, json, fingerprint,
        JSON.stringify(initialCursor()), JSON.stringify(initialCounters()), INITIAL_EVIDENCE_DIGEST,
        proof.handle.verificationId, proof.handle.generation, proof.header.archiveId, reconciliationId),
    db.prepare('SELECT * FROM archive_compact_reconciliation_jobs WHERE reconciliation_id=?').bind(reconciliationId),
  ]);
  const row = rows[1].results[0];
  if (!row || row.publication_id !== publicationId || row.execution_generation !== proof.handle.generation
    || row.verification_id !== proof.handle.verificationId || row.run_id !== proof.handle.runId
    || row.snapshot_commit_token !== proof.handle.commitToken || row.graph_sha256 !== proof.handle.graphSha256
    || row.descriptor_json !== json || row.descriptor_sha256 !== fingerprint || row.state === 'invalid') fail('START_CONFLICT');
  return { reconciliationId, generation: row.execution_generation };
}

async function authenticateManifest(
  storage: ArchiveRecordEvidenceStorage,
  publication: CompactDescriptor,
  job: CompactReconciliationJobRow,
): Promise<ArchiveManifest> {
  const reference = JSON.parse(publication.root_reference_json) as ArchiveReference;
  const manifest = await openArchiveManifest(
    storage.masterKey,
    await readArchiveEvidenceObject(storage.bucket, reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes),
    reference,
  );
  const { parts, ...header } = manifest;
  if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.kind !== 'monthly' || manifest.references.length !== 0
    || JSON.stringify(header) !== publication.header_json || await hash(JSON.stringify(header)) !== publication.header_sha256
    || parts.length !== job.expected_parts) fail('MANIFEST_MISMATCH');
  return manifest;
}

/** Advance at most eight records and atomically project readiness at completion. */
export async function advanceCompactPublicationReconciliation<S extends ArchiveStagingStatement<S>>(
  db: ArchiveStagingDatabase<S>,
  suppliedStorage: ArchiveRecordEvidenceStorage,
  suppliedHandle: CompactReconciliationHandle,
  selection: { expectedRevision: number },
): Promise<CompactReconciliationAdvance> {
  const handle = validateHandle(suppliedHandle);
  const storage = Object.freeze({ bucket: suppliedStorage.bucket, masterKey: suppliedStorage.masterKey });
  if (!integer(selection.expectedRevision, Number.MAX_SAFE_INTEGER)) fail('SELECTION_INVALID');
  const lease = crypto.randomUUID();
  const initial = await db.batch<CompactReconciliationJobRow>([
    db.prepare(`UPDATE archive_compact_reconciliation_jobs AS j
      SET state='running',revision=revision+1,lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE j.reconciliation_id=? AND j.execution_generation=? AND j.revision=? AND j.state IN ('pending','running')
        AND (j.lease_token IS NULL OR j.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      RETURNING *`).bind(lease, handle.reconciliationId, handle.generation, selection.expectedRevision),
    db.prepare(`SELECT j.*,EXISTS(SELECT 1 FROM archive_compact_availability a
      JOIN history_runtime h ON h.id=1 AND h.generation=a.generation
      WHERE a.publication_id=j.publication_id AND a.generation=j.execution_generation
        AND a.status='ready' AND a.reconciliation_id=j.reconciliation_id AND h.state='ready') AS current_ready
      FROM archive_compact_reconciliation_jobs j WHERE j.reconciliation_id=? AND j.execution_generation=?`)
      .bind(handle.reconciliationId, handle.generation),
  ]);
  const job = initial[1].results[0];
  if (!job) fail('STALE');
  if (!initial[0].results.length) {
    return outcome(job, 0, job.state === 'pending' || job.state === 'running', job.state === 'complete' && job.current_ready === 1);
  }
  const identity = [job.reconciliation_id, job.execution_generation, job.revision, lease];
  const guard = `j.reconciliation_id=? AND j.execution_generation=? AND j.revision=? AND j.lease_token=? AND ${compactReconciliationLeaseSql()}`;
  try {
    const publication = JSON.parse(job.descriptor_json) as CompactDescriptor;
    if (descriptorJson(publication) !== job.descriptor_json || await hash(job.descriptor_json) !== job.descriptor_sha256) fail('DESCRIPTOR_INVALID');
    const { cursor, counters } = readProgress(job, publication);
    const manifest = await authenticateManifest(storage, publication, job);
    const prefix = (part: number) => manifest.parts.slice(0, part).reduce((sum, item) => sum + item.recordCount, 0);
    if (prefix(cursor.nextPart) + cursor.nextOffset !== counters.records
      || (cursor.nextPart < job.expected_parts && cursor.nextOffset >= manifest.parts[cursor.nextPart].recordCount)) fail('CURSOR_INVALID');

    let phase = job.phase;
    let processed = 0;
    let evidenceDigest = job.evidence_digest;
    if (phase === 'records') {
      if (cursor.nextPart === job.expected_parts) {
        const expectedCounts = JSON.parse(publication.counts_json) as ArchiveCounts;
        if (counters.records !== publication.record_count || counters.requests !== publication.request_count
          || ARCHIVE_TABLES.some(table => counters.counts[table] !== manifest.recordCounts[table]
            || counters.counts[table] !== expectedCounts[table])) fail('CATALOG_TOTALS');
        phase = 'catalog_requests';
      } else {
        const descriptor = manifest.parts[cursor.nextPart];
        const records = await verifyArchivePart(
          storage.masterKey,
          manifest,
          descriptor,
          await readArchiveEvidenceObject(storage.bucket, descriptor.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, descriptor.encryptedBytes),
        );
        const page = partitionPage(records, cursor.nextOffset);
        if (!page.records.length) fail('CURSOR_INVALID');
        const values = page.records.map(() => '(?,?,?,?,?)').join(',');
        const bindings = page.records.flatMap(record => {
          const kind = record.table === 'attendance_events' ? 'event'
            : record.table === 'attendance_corrections' ? 'correction' : null;
          return [record.table, record.key, kind, kind ? record.row.payload_hash : null, JSON.stringify(record)];
        });
        const result = await db.batch<CatalogRow>([
          db.prepare(`WITH expected(table_name,record_key,source_kind,payload_hash,record_json) AS (VALUES ${values})
            SELECT e.table_name AS expected_table,e.record_key AS expected_key,e.source_kind AS expected_kind,
              e.payload_hash AS expected_hash,e.record_json AS expected_json,
              q.request_id,q.publication_id AS claim_publication,
              k.source_kind AS owner_kind,k.center_id AS owner_center,k.payload_hash AS owner_hash,
              k.hash_encoding,k.canonicalization,s.record_json AS staged_record_json
            FROM expected e
            LEFT JOIN archive_compact_requests q ON q.request_id=e.record_key
            LEFT JOIN history_request_keys k ON k.request_id=q.request_id
            LEFT JOIN archive_semantic_rows s ON s.verification_id=? AND s.generation=? AND s.archive_id=?
              AND s.table_name=e.table_name AND s.record_key=e.record_key`)
            .bind(...bindings, job.verification_id, job.execution_generation, publication.archive_id),
        ]);
        if (result[0].results.length !== page.records.length) fail('RECORD_CATALOG_MISMATCH');
        for (const record of page.records) {
          const rows = result[0].results.filter(row => row.expected_table === record.table && row.expected_key === record.key);
          const row = rows[0];
          if (rows.length !== 1 || row.expected_json !== JSON.stringify(record) || row.staged_record_json !== JSON.stringify(record)) fail('RECORD_CATALOG_MISMATCH');
          const kind = record.table === 'attendance_events' ? 'event'
            : record.table === 'attendance_corrections' ? 'correction' : null;
          if (kind) {
            if (typeof record.row.payload_hash !== 'string' || row.request_id !== record.key
              || row.claim_publication !== publication.publication_id || row.owner_kind !== kind
              || row.owner_center !== publication.center_id || row.owner_hash !== record.row.payload_hash
              || row.hash_encoding !== encodingOf(record.row.payload_hash) || row.canonicalization !== 'legacy-unverified') fail('REQUEST_CATALOG_MISMATCH');
            counters.requests += 1;
          } else if (row.request_id !== null && (row.claim_publication !== publication.publication_id
            || !['event', 'correction'].includes(String(row.owner_kind)))) fail('REQUEST_CATALOG_MISMATCH');
          counters.records += 1;
          counters.counts[record.table] += 1;
        }
        evidenceDigest = await appendEvidence(evidenceDigest, 'records', page.records);
        cursor.nextOffset = page.complete ? 0 : page.nextOffset;
        if (page.complete) { cursor.nextPart += 1; counters.parts += 1; }
        processed = page.records.length;
      }
    } else if (phase === 'catalog_requests') {
      const rows = (await db.batch<Record<string, unknown>>([
        db.prepare(`SELECT q.request_id,q.publication_id,k.source_kind,k.center_id,k.payload_hash,k.hash_encoding,k.canonicalization,
          s.table_name,s.record_json
          FROM archive_compact_requests q INDEXED BY archive_compact_request_publication
          LEFT JOIN history_request_keys k ON k.request_id=q.request_id
          LEFT JOIN archive_semantic_rows s ON s.verification_id=? AND s.generation=? AND s.archive_id=?
            AND s.record_key=q.request_id
            AND s.table_name=CASE k.source_kind WHEN 'event' THEN 'attendance_events' WHEN 'correction' THEN 'attendance_corrections' ELSE '' END
          WHERE q.publication_id=? AND q.request_id>? ORDER BY q.request_id LIMIT 8`)
          .bind(job.verification_id, job.execution_generation, publication.archive_id, publication.publication_id, cursor.requestAfter),
      ]))[0].results;
      if (!rows.length) {
        if (counters.catalogRequests !== publication.request_count) fail('REQUEST_CATALOG_MISMATCH');
        phase = 'complete';
      } else {
        const records: ArchiveRecord[] = [];
        for (const row of rows) {
          if (!identifier(row.request_id) || row.request_id <= cursor.requestAfter
            || row.publication_id !== publication.publication_id
            || !['event', 'correction'].includes(String(row.source_kind))
            || row.center_id !== publication.center_id || typeof row.payload_hash !== 'string'
            || row.hash_encoding !== encodingOf(row.payload_hash) || row.canonicalization !== 'legacy-unverified'
            || typeof row.record_json !== 'string') fail('REQUEST_CATALOG_MISMATCH');
          let record: ArchiveRecord;
          try { record = JSON.parse(row.record_json) as ArchiveRecord; } catch { fail('REQUEST_CATALOG_MISMATCH'); }
          const table = row.source_kind === 'event' ? 'attendance_events' : 'attendance_corrections';
          if (record.table !== table || record.key !== row.request_id || record.row.id !== row.request_id
            || record.row.center_id !== publication.center_id || record.row.payload_hash !== row.payload_hash) fail('REQUEST_CATALOG_MISMATCH');
          records.push(record);
          counters.catalogRequests += 1;
          if (counters.catalogRequests > publication.request_count) fail('REQUEST_CATALOG_MISMATCH');
          cursor.requestAfter = row.request_id;
        }
        evidenceDigest = await appendEvidence(evidenceDigest, 'catalog_requests', records);
        processed = rows.length;
      }
    } else fail('CURSOR_INVALID');

    const complete = phase === 'complete';
    const candidate = {
      ...job,
      phase,
      cursor_json: JSON.stringify(cursor),
      counters_json: JSON.stringify(counters),
      evidence_digest: evidenceDigest,
    };
    readProgress(candidate, publication);
    const statements = [
      db.prepare(`UPDATE archive_compact_reconciliation_jobs AS j
        SET state=?,phase=?,cursor_json=?,counters_json=?,evidence_digest=?,revision=revision+1,
          lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE ${guard} RETURNING *`)
        .bind(complete ? 'complete' : 'pending', phase, candidate.cursor_json, candidate.counters_json, evidenceDigest, ...identity),
      db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('ARCHIVE_COMPACT_RECONCILIATION_STALE','$') END AS committed"),
    ];
    if (complete) {
      statements.push(db.prepare(`INSERT INTO archive_compact_reconciliation_receipts(
        reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,
        descriptor_json,descriptor_sha256,expected_parts,counters_json,evidence_digest,completed_at)
        SELECT reconciliation_id,publication_id,execution_generation,verification_id,run_id,snapshot_commit_token,graph_sha256,validator_version,
          descriptor_json,descriptor_sha256,expected_parts,counters_json,evidence_digest,strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM archive_compact_reconciliation_jobs
        WHERE reconciliation_id=? AND execution_generation=? AND state='complete' AND revision=?`)
        .bind(job.reconciliation_id, job.execution_generation, job.revision + 1));
      statements.push(db.prepare(`UPDATE archive_compact_availability
        SET generation=?,status='ready',reconciliation_id=? WHERE publication_id=?`)
        .bind(job.execution_generation, job.reconciliation_id, job.publication_id));
      statements.push(db.prepare(`INSERT INTO archive_compact_availability(publication_id,generation,status,reconciliation_id)
        SELECT publication_id,execution_generation,'ready',reconciliation_id
        FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=?
          AND NOT EXISTS(SELECT 1 FROM archive_compact_availability WHERE publication_id=?)`)
        .bind(job.reconciliation_id, job.publication_id));
      statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM archive_compact_availability
        WHERE publication_id=? AND generation=? AND status='ready' AND reconciliation_id=?)
        THEN 1 ELSE json_extract('ARCHIVE_COMPACT_RECONCILIATION_STALE','$') END AS committed`)
        .bind(job.publication_id, job.execution_generation, job.reconciliation_id));
    }
    const written = await db.batch<CompactReconciliationJobRow>(statements);
    if (!written[0].results[0]) fail('STALE');
    return outcome(written[0].results[0], processed, false, complete);
  } catch (error) {
    try {
      await db.batch([
        db.prepare(`UPDATE archive_compact_reconciliation_jobs
          SET state='pending',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE reconciliation_id=? AND execution_generation=? AND revision=? AND lease_token=? AND state='running'`)
          .bind(...identity),
      ]);
    } catch { /* original error wins */ }
    throw error;
  }
}
