import type { ArchiveCounts } from '../shared/archive-format';

export const COMPACT_RECONCILIATION_LIMITS = Object.freeze({
  descriptorBytes: 131_072,
  cursorBytes: 2_048,
  countersBytes: 4_096,
  pageRecords: 8,
  pageBytes: 262_144,
  leaseMilliseconds: 30_000,
});

export type CompactReconciliationPhase = 'records' | 'catalog_requests' | 'complete';
export type CompactReconciliationCursor = {
  version: 1;
  nextPart: number;
  nextOffset: number;
  requestAfter: string;
};
export type CompactReconciliationCounters = {
  parts: number;
  records: number;
  requests: number;
  catalogRequests: number;
  counts: ArchiveCounts;
};
export type CompactReconciliationIdentity = {
  reconciliation_id: string;
  publication_id: string;
  execution_generation: string;
  verification_id: string;
  run_id: string;
  snapshot_commit_token: string;
  graph_sha256: string;
  validator_version: 1;
  descriptor_json: string;
  descriptor_sha256: string;
  expected_parts: number;
};
export type CompactReconciliationJobRow = CompactReconciliationIdentity & {
  state: 'pending' | 'running' | 'complete' | 'invalid';
  phase: CompactReconciliationPhase;
  revision: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  cursor_json: string;
  counters_json: string;
  evidence_digest: string;
  created_at: string;
  updated_at: string;
  current_ready?: number;
};
export type CompactReconciliationReceiptRow = CompactReconciliationIdentity & {
  counters_json: string;
  evidence_digest: string;
  completed_at: string;
};

function alias(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('ARCHIVE_COMPACT_RECONCILIATION_SQL_ALIAS_INVALID');
  return value;
}

/** A fresh complete semantic proof of the immutable compact publication root. */
export function compactReconciliationProofSql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return `EXISTS(SELECT 1 FROM archive_compact_publications cp
    JOIN archive_semantic_runs rr ON rr.run_id=${j}.run_id
    JOIN archive_semantic_sessions rs ON rs.verification_id=rr.verification_id AND rs.generation=rr.generation
    JOIN archive_semantic_manifests rm ON rm.verification_id=rs.verification_id AND rm.generation=rs.generation AND rm.archive_id=rr.archive_id
    JOIN archive_semantic_lifecycle rl ON rl.verification_id=rs.verification_id AND rl.generation=rs.generation
    JOIN history_runtime rh ON rh.id=1 AND rh.generation=rs.generation
    WHERE cp.publication_id=${j}.publication_id
      AND rr.verification_id=${j}.verification_id AND rr.generation=${j}.execution_generation
      AND rr.snapshot_commit_token=${j}.snapshot_commit_token AND rr.graph_sha256=${j}.graph_sha256
      AND rr.validator_version=${j}.validator_version AND rr.validator_version=1
      AND rr.status='complete' AND rr.phase='complete' AND rr.archive_id=cp.archive_id AND rr.header_json=cp.header_json
      AND rs.status='verified' AND rs.commit_token=${j}.snapshot_commit_token AND rs.graph_sha256=${j}.graph_sha256
      AND rs.root_archive_id=cp.archive_id AND rs.root_reference_json=cp.root_reference_json
      AND rm.manifest_sha256=rs.root_manifest_sha256 AND rm.manifest_sha256=json_extract(cp.root_reference_json,'$.manifestSha256')
      AND rm.part_count=${j}.expected_parts AND rm.part_count=cp.part_count AND rm.record_count=cp.record_count
      AND json_remove(rm.manifest_json,'$.parts')=cp.header_json
      AND rh.state='ready' AND rl.pause_reason IS NULL AND rl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}

export function compactReconciliationLeaseSql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return `${j}.state='running' AND ${j}.lease_token IS NOT NULL
    AND ${j}.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND ${compactReconciliationProofSql(j)}
    AND NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}
