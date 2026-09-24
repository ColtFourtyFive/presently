import { ARCHIVE_FORMAT_V2 } from '../shared/archive-format';
import { loadArchiveRecordEvidence, loadManifestRecordEvidence, type ArchiveManifestRecordSelection, type ArchiveRecordEvidenceLocator, type ArchiveRecordEvidenceStorage } from './archive-record-evidence';
import { MONTHLY_SEMANTIC_VALIDATOR_VERSION } from './archive-semantic-runner';
import { ARCHIVE_PUBLICATION_LIMITS } from './archive-publication-schema';
import { digest } from './backup-crypto';

export type HistoryReadStatement<S> = { bind(...values: unknown[]): S };
export type HistoryReadDatabase<S extends HistoryReadStatement<S>> = {
  prepare(sql: string): S;
  batch<T = Record<string, unknown>>(statements: S[]): Promise<{ results: T[] }[]>;
};
export type PublishedRequestSelection = Record<string, unknown>;
export type CompactPublishedRequestSelection = Record<string, unknown>;

/** Candidate claims are visible to this private query, but only a committed
 * descriptor and current-generation availability authorize object reads. */
export function publishedRequestStatement<S extends HistoryReadStatement<S>>(db: HistoryReadDatabase<S>, requestId: string): S {
  return db.prepare(`SELECT
    q.request_id AS claim_request_id,q.source_kind AS claim_source_kind,q.center_id AS claim_center_id,
    q.payload_hash AS claim_payload_hash,q.table_name AS claim_table_name,q.record_key AS claim_record_key,
    q.publication_id,p.publication_id AS committed_publication_id,p.verification_id,p.generation AS proof_generation,
    p.run_id,p.snapshot_commit_token,p.graph_sha256,p.validator_version,p.archive_id,p.center_id,p.month,p.timezone,
    p.root_reference_json,p.header_json,p.header_sha256,p.manifest_object_key,p.manifest_sha256,p.format,p.locator_version,
    p.record_count,p.request_count,p.counts_json,p.locator_digest,p.published_at,
    r.table_name AS record_table_name,r.record_key,r.part_index,r.part_offset,r.descriptor_sha256,r.record_sha256,r.record_bytes,
    a.generation AS availability_generation,a.status AS availability_status,a.reconciliation_id AS availability_reconciliation_id
    FROM archive_publication_requests q
    LEFT JOIN archive_publications p ON p.publication_id=q.publication_id
    LEFT JOIN archive_publication_records r ON r.publication_id=q.publication_id AND r.table_name=q.table_name AND r.record_key=q.record_key
    LEFT JOIN archive_publication_availability a ON a.publication_id=q.publication_id
    WHERE q.request_id=?`).bind(requestId);
}

/** A private candidate claim remains observable even when it has no descriptor.
 * Only one committed direct identity with current ready availability can read R2. */
export function compactPublishedRequestStatement<S extends HistoryReadStatement<S>>(db: HistoryReadDatabase<S>, requestId: string): S {
  return db.prepare(`SELECT
    q.request_id AS claim_request_id,q.publication_id,
    i.publication_id AS identity_publication_id,i.origin,
    p.publication_id AS committed_publication_id,p.verification_id,p.generation AS proof_generation,
    p.run_id,p.snapshot_commit_token,p.graph_sha256,p.validator_version,p.archive_id,p.center_id,p.month,p.timezone,
  p.root_reference_json,p.header_json,p.header_sha256,p.part_count,p.record_count,p.catalog_version,p.request_count,p.counts_json,p.published_at,
  a.generation AS availability_generation,a.status AS availability_status,a.reconciliation_id AS availability_reconciliation_id,
  r.reconciliation_id AS receipt_reconciliation_id,r.publication_id AS receipt_publication_id,r.execution_generation AS receipt_generation,
  r.verification_id AS receipt_verification_id,r.run_id AS receipt_run_id,r.snapshot_commit_token AS receipt_commit_token,
  r.graph_sha256 AS receipt_graph_sha256,r.validator_version AS receipt_validator_version,
  r.descriptor_json AS receipt_descriptor_json,r.descriptor_sha256 AS receipt_descriptor_sha256,
  r.expected_parts AS receipt_expected_parts,r.counters_json AS receipt_counters_json,r.evidence_digest AS receipt_evidence_digest
  FROM archive_compact_requests q
  LEFT JOIN archive_compact_identities i ON i.publication_id=q.publication_id
  LEFT JOIN archive_compact_publications p ON p.publication_id=q.publication_id
  LEFT JOIN archive_compact_availability a ON a.publication_id=q.publication_id
  LEFT JOIN archive_compact_reconciliation_receipts r ON r.reconciliation_id=a.reconciliation_id AND r.publication_id=q.publication_id
  WHERE q.request_id=?`).bind(requestId);
}

function unavailable(): never { throw new Error('ARCHIVE_PUBLICATION_EVIDENCE_UNAVAILABLE'); }

/** The caller checks global ownership first and re-reads its complete authority
 * snapshot after the asynchronous object reads finish. */
export async function loadPublishedRequestEvidence(
  storage: ArchiveRecordEvidenceStorage,
  selected: PublishedRequestSelection,
  expected: { requestId: string; sourceKind: 'event' | 'correction'; centerId: string; payloadHash: string; generation: string },
): Promise<Record<string, unknown>> {
  try {
    const table = expected.sourceKind === 'event' ? 'attendance_events' : 'attendance_corrections';
    if (selected.claim_request_id !== expected.requestId || selected.claim_source_kind !== expected.sourceKind ||
      selected.claim_center_id !== expected.centerId || selected.claim_payload_hash !== expected.payloadHash ||
      selected.claim_table_name !== table || selected.claim_record_key !== expected.requestId ||
      selected.publication_id !== selected.committed_publication_id || typeof selected.committed_publication_id !== 'string' ||
      selected.center_id !== expected.centerId || selected.record_table_name !== table || selected.record_key !== expected.requestId ||
      selected.availability_generation !== expected.generation || selected.availability_status !== 'ready' ||
      selected.format !== ARCHIVE_FORMAT_V2 || selected.locator_version !== 1 || selected.validator_version !== MONTHLY_SEMANTIC_VALIDATOR_VERSION ||
      typeof selected.root_reference_json !== 'string' || typeof selected.header_json !== 'string' ||
      new TextEncoder().encode(selected.header_json).length > ARCHIVE_PUBLICATION_LIMITS.headerBytes ||
      new TextEncoder().encode(selected.root_reference_json).length > 4096 ||
      !Number.isInteger(selected.part_offset) || Number(selected.part_offset) < 0 || Number(selected.part_offset) >= ARCHIVE_PUBLICATION_LIMITS.partRecords) unavailable();
    const reference = JSON.parse(selected.root_reference_json), header = JSON.parse(selected.header_json);
    if (reference.archiveId !== selected.archive_id || reference.kind !== 'monthly' || reference.manifestObjectKey !== selected.manifest_object_key ||
      reference.manifestSha256 !== selected.manifest_sha256 || header.archiveId !== selected.archive_id || header.centerId !== selected.center_id ||
      header.month !== selected.month || header.timezone !== selected.timezone || header.format !== ARCHIVE_FORMAT_V2 || header.kind !== 'monthly' ||
      !Array.isArray(header.references) || header.references.length !== 0 ||
      await digest(new TextEncoder().encode(JSON.stringify(header))) !== selected.header_sha256) unavailable();
    const locator: ArchiveRecordEvidenceLocator = {
      reference, centerId: selected.center_id as string, month: selected.month as string, timezone: selected.timezone as string,
      headerSha256: selected.header_sha256 as string, partIndex: selected.part_index as number, descriptorSha256: selected.descriptor_sha256 as string,
      table, recordKey: expected.requestId, recordSha256: selected.record_sha256 as string, recordBytes: selected.record_bytes as number,
    };
    const record = await loadArchiveRecordEvidence(storage, locator);
    if (record.row.id !== expected.requestId || record.row.center_id !== expected.centerId || record.row.payload_hash !== expected.payloadHash) unavailable();
    return record.row;
  } catch { unavailable(); }
}

/** Reads one direct compact request through the authenticated manifest. The
 * caller validates permanent ownership and rechecks its complete D1 snapshot. */
export async function loadCompactPublishedRequestEvidence(
  storage: ArchiveRecordEvidenceStorage,
  selected: CompactPublishedRequestSelection,
  expected: { requestId: string; sourceKind: 'event' | 'correction'; centerId: string; payloadHash: string; generation: string },
): Promise<Record<string, unknown>> {
  try {
    const table = expected.sourceKind === 'event' ? 'attendance_events' : 'attendance_corrections';
    if (selected.claim_request_id !== expected.requestId ||
      selected.publication_id !== selected.identity_publication_id || selected.publication_id !== selected.committed_publication_id ||
      typeof selected.committed_publication_id !== 'string' || selected.origin !== 'direct' ||
      selected.center_id !== expected.centerId || selected.availability_generation !== expected.generation || selected.availability_status !== 'ready' ||
      selected.catalog_version !== 2 || selected.validator_version !== MONTHLY_SEMANTIC_VALIDATOR_VERSION ||
      typeof selected.root_reference_json !== 'string' || typeof selected.header_json !== 'string' ||
      new TextEncoder().encode(selected.header_json).length > ARCHIVE_PUBLICATION_LIMITS.headerBytes ||
      new TextEncoder().encode(selected.root_reference_json).length > 4096 ||
      !Number.isInteger(selected.part_count) || Number(selected.part_count) < 0 || Number(selected.part_count) > 512 ||
      !Number.isInteger(selected.record_count) || Number(selected.record_count) < 0 || Number(selected.record_count) > 20_000 ||
      !Number.isInteger(selected.request_count) || Number(selected.request_count) < 0 || Number(selected.request_count) > Number(selected.record_count) ||
      typeof selected.counts_json !== 'string') unavailable();
    const directAuthority = selected.availability_reconciliation_id === null && selected.proof_generation === expected.generation;
    const reconciledAuthority = typeof selected.availability_reconciliation_id === 'string'
      && selected.availability_reconciliation_id === selected.receipt_reconciliation_id
      && selected.receipt_publication_id === selected.committed_publication_id
      && selected.receipt_generation === expected.generation
      && selected.receipt_validator_version === MONTHLY_SEMANTIC_VALIDATOR_VERSION
      && selected.receipt_expected_parts === selected.part_count
      && typeof selected.receipt_descriptor_json === 'string'
      && typeof selected.receipt_descriptor_sha256 === 'string'
      && typeof selected.receipt_counters_json === 'string'
      && typeof selected.receipt_evidence_digest === 'string'
      && /^[a-f0-9]{64}$/.test(selected.receipt_evidence_digest);
    if (!directAuthority && !reconciledAuthority) unavailable();
    const reference = JSON.parse(selected.root_reference_json), header = JSON.parse(selected.header_json), counts = JSON.parse(selected.counts_json);
    if (reference.archiveId !== selected.archive_id || reference.kind !== 'monthly' ||
      header.archiveId !== selected.archive_id || header.centerId !== selected.center_id || header.month !== selected.month || header.timezone !== selected.timezone ||
      header.format !== ARCHIVE_FORMAT_V2 || header.kind !== 'monthly' || !Array.isArray(header.references) || header.references.length !== 0 ||
      header.recordCount !== selected.record_count || JSON.stringify(header.recordCounts) !== JSON.stringify(counts) ||
      Number(counts.attendance_events) + Number(counts.attendance_corrections) !== selected.request_count ||
      await digest(new TextEncoder().encode(JSON.stringify(header))) !== selected.header_sha256) unavailable();
    if (reconciledAuthority) {
      const descriptor = {
        publication_id: selected.committed_publication_id,
        verification_id: selected.verification_id,
        generation: selected.proof_generation,
        run_id: selected.run_id,
        snapshot_commit_token: selected.snapshot_commit_token,
        graph_sha256: selected.graph_sha256,
        validator_version: selected.validator_version,
        archive_id: selected.archive_id,
        center_id: selected.center_id,
        month: selected.month,
        timezone: selected.timezone,
        root_reference_json: selected.root_reference_json,
        header_json: selected.header_json,
        header_sha256: selected.header_sha256,
        part_count: selected.part_count,
        record_count: selected.record_count,
        catalog_version: selected.catalog_version,
        request_count: selected.request_count,
        counts_json: selected.counts_json,
        published_at: selected.published_at,
      };
      const descriptorJson = JSON.stringify(descriptor);
      const receiptCounters = JSON.parse(selected.receipt_counters_json as string);
      if (selected.receipt_descriptor_json !== descriptorJson
        || await digest(new TextEncoder().encode(descriptorJson)) !== selected.receipt_descriptor_sha256
        || !receiptCounters || typeof receiptCounters !== 'object' || Array.isArray(receiptCounters)
        || Object.keys(receiptCounters).sort().join(',') !== 'catalogRequests,counts,parts,records,requests'
        || receiptCounters.parts !== selected.part_count || receiptCounters.records !== selected.record_count
        || receiptCounters.requests !== selected.request_count || receiptCounters.catalogRequests !== selected.request_count
        || JSON.stringify(receiptCounters.counts) !== JSON.stringify(counts)) unavailable();
    }
    const selection: ArchiveManifestRecordSelection = {
      reference, centerId: selected.center_id as string, month: selected.month as string, timezone: selected.timezone as string,
      headerSha256: selected.header_sha256 as string, table, recordKey: expected.requestId,
    };
    const record = await loadManifestRecordEvidence(storage, selection);
    if (record.row.id !== expected.requestId || record.row.center_id !== expected.centerId || record.row.payload_hash !== expected.payloadHash) unavailable();
    return record.row;
  } catch { unavailable(); }
}
