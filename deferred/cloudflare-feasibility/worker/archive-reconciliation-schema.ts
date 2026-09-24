import type { ArchiveCounts } from '../shared/archive-format';

/** Internal archive recovery authority. Original publication provenance stays immutable. */
export const ARCHIVE_RECONCILIATION_LIMITS = Object.freeze({
  descriptorBytes: 131_072, cursorBytes: 8_192, countersBytes: 4_096,
  pageRecords: 8, pageBytes: 262_144, leaseMilliseconds: 30_000,
});
export type ArchiveReconciliationPhase = 'records' | 'catalog_parts' | 'catalog_records' | 'catalog_requests' | 'complete';
export type ArchiveReconciliationCursor = {
  version: 1; nextPart: number; nextOffset: number; partAfter: number;
  recordPart: number; recordOffset: number; requestAfter: string;
};
export type ArchiveReconciliationCounters = {
  parts: number; records: number; requests: number;
  catalogParts: number; catalogRecords: number; catalogRequests: number; counts: ArchiveCounts;
};
export type ArchiveReconciliationIdentity = {
  reconciliation_id: string; publication_id: string; execution_generation: string;
  verification_id: string; run_id: string; snapshot_commit_token: string;
  graph_sha256: string; validator_version: 1; descriptor_json: string;
  descriptor_sha256: string; expected_parts: number;
};
export type ArchiveReconciliationJobRow = ArchiveReconciliationIdentity & {
  state: 'pending' | 'running' | 'complete' | 'invalid'; phase: ArchiveReconciliationPhase;
  revision: number; lease_token: string | null; lease_expires_at: string | null;
  cursor_json: string; counters_json: string; locator_digest: string;
  created_at: string; updated_at: string;
};
export type ArchiveReconciliationReceiptRow = ArchiveReconciliationIdentity & {
  counters_json: string; locator_digest: string; completed_at: string;
};
function alias(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('ARCHIVE_RECONCILIATION_SQL_ALIAS_INVALID');
  return value;
}
/** Binds a fresh current-generation proof to the original immutable descriptor. */
export function archiveReconciliationProofSql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return `EXISTS(SELECT 1 FROM archive_publications rp
    JOIN archive_semantic_runs rr ON rr.run_id=${j}.run_id
    JOIN archive_semantic_sessions rs ON rs.verification_id=rr.verification_id AND rs.generation=rr.generation
    JOIN archive_semantic_manifests rm ON rm.verification_id=rs.verification_id AND rm.generation=rs.generation AND rm.archive_id=rr.archive_id
    JOIN archive_semantic_lifecycle rl ON rl.verification_id=rs.verification_id AND rl.generation=rs.generation
    JOIN history_runtime rh ON rh.id=1 AND rh.generation=rs.generation
    WHERE rp.publication_id=${j}.publication_id
      AND rr.verification_id=${j}.verification_id AND rr.generation=${j}.execution_generation
      AND rr.snapshot_commit_token=${j}.snapshot_commit_token AND rr.graph_sha256=${j}.graph_sha256
      AND rr.validator_version=${j}.validator_version AND rr.validator_version=1 AND rr.status='complete' AND rr.phase='complete'
      AND rr.archive_id=rp.archive_id AND rr.header_json=rp.header_json
      AND rs.status='verified' AND rs.commit_token=${j}.snapshot_commit_token AND rs.graph_sha256=${j}.graph_sha256
      AND rs.root_archive_id=rp.archive_id AND rs.root_reference_json=rp.root_reference_json
      AND rm.manifest_sha256=rs.root_manifest_sha256 AND rm.manifest_sha256=rp.manifest_sha256
      AND rm.part_count=${j}.expected_parts AND rm.record_count=rp.record_count
      AND json_remove(rm.manifest_json,'$.parts')=rp.header_json
      AND rh.state='ready' AND rl.pause_reason IS NULL AND rl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}
export function archiveReconciliationLeaseSql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return `${j}.state='running' AND ${j}.lease_token IS NOT NULL AND ${j}.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${archiveReconciliationProofSql(j)} AND NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}
