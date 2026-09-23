import type { ArchiveTable } from '../shared/archive-format';

/** Internal publication foundation. No source eviction, scheduler, or route. */
export const ARCHIVE_PUBLICATION_LIMITS = Object.freeze({ records: 20_000, parts: 512, partRecords: 256, pageRecords: 64, statements: 40, leaseMilliseconds: 30_000, headerBytes: 49_152, descriptorBytes: 8_192 });
export type ArchivePublicationProofIdentity = {
  verification_id: string; generation: string; run_id: string; snapshot_commit_token: string; graph_sha256: string; validator_version: 1;
};
export type ArchivePublicationBuildRow = ArchivePublicationProofIdentity & {
  publication_id: string; archive_id: string; center_id: string; month: string; timezone: string;
  root_reference_json: string; header_json: string; header_sha256: string;
  part_count: number; record_count: number; state: 'building' | 'published' | 'invalid'; revision: number;
  lease_token: string | null; lease_expires_at: string | null; next_part: number; next_offset: number;
  indexed_count: number; request_count: number; counts_json: string; locator_digest: string; created_at: string; updated_at: string;
};
export type ArchivePublicationPartRow = {
  publication_id: string; part_index: number; descriptor_json: string; descriptor_sha256: string; record_count: number; indexed_count: number; completed: 0 | 1;
};
export type ArchivePublicationRecordRow = {
  publication_id: string; table_name: ArchiveTable; record_key: string; part_index: number; part_offset: number;
  descriptor_sha256: string; record_sha256: string; record_bytes: number;
};
export type ArchivePublicationRequestRow = {
  request_id: string; publication_id: string; source_kind: 'event' | 'correction'; center_id: string; payload_hash: string;
  table_name: 'attendance_events' | 'attendance_corrections'; record_key: string;
};
export type ArchivePublicationDescriptorRow = ArchivePublicationProofIdentity & {
  publication_id: string; archive_id: string; center_id: string; month: string; timezone: string;
  root_reference_json: string; header_json: string; header_sha256: string; manifest_object_key: string; manifest_sha256: string;
  format: 'kumon-history-archive-v2'; locator_version: 1; record_count: number; request_count: number; counts_json: string; locator_digest: string; published_at: string;
};
export type ArchivePublicationAvailabilityRow = { publication_id: string; generation: string; status: 'ready' | 'unavailable' };

function alias(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('ARCHIVE_PUBLICATION_SQL_ALIAS_INVALID');
  return value;
}

/** Alias names are trusted code identifiers, never bound user data. Mirrors the
 * migration25 proof predicate; use inside the same native transaction as writes. */
export function archivePublicationProofSql(buildAlias = 'b'): string {
  const b = alias(buildAlias);
  return `EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=${b}.run_id AND pr.verification_id=${b}.verification_id AND pr.generation=${b}.generation
      AND pr.snapshot_commit_token=${b}.snapshot_commit_token AND pr.graph_sha256=${b}.graph_sha256 AND pr.validator_version=${b}.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=${b}.archive_id AND pr.header_json=${b}.header_json
      AND ps.status='verified' AND ps.commit_token=${b}.snapshot_commit_token AND ps.graph_sha256=${b}.graph_sha256
      AND ps.root_archive_id=${b}.archive_id AND ps.root_reference_json=${b}.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(${b}.root_reference_json,'$.manifestSha256')
      AND pm.part_count=${b}.part_count AND pm.record_count=${b}.record_count AND json_remove(pm.manifest_json,'$.parts')=${b}.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}

export function archivePublicationLeaseSql(buildAlias = 'b'): string {
  const b = alias(buildAlias);
  return `${b}.state='building' AND ${b}.lease_token IS NOT NULL AND ${b}.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND ${archivePublicationProofSql(b)}
    AND NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}

/** Availability is a current-generation projection. Descriptor generation remains
 * original proof provenance and must never be relabeled by restoration. */
export function archivePublicationVisibleSql(publicationAlias = 'p', availabilityAlias = 'a', historyAlias = 'h'): string {
  const p = alias(publicationAlias), a = alias(availabilityAlias), h = alias(historyAlias);
  return `${a}.publication_id=${p}.publication_id AND ${a}.status='ready' AND ${a}.generation=${h}.generation AND ${h}.id=1 AND ${h}.state='ready'`;
}
