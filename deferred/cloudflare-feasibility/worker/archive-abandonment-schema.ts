/** Private bounded cleanup of never-published invalid candidates. */
export const ARCHIVE_ABANDONMENT_LIMITS = Object.freeze({ pageKeys: 8, leaseMilliseconds: 30_000, buildBytes: 131_072, progressBytes: 8_192 });
export const ARCHIVE_ABANDONMENT_ZERO_SUM = '0'.repeat(64);
export type ArchiveAbandonmentPhase = 'inventory_requests' | 'inventory_records' | 'inventory_parts' | 'delete_requests' | 'delete_records' | 'delete_parts' | 'complete';
export type ArchiveAbandonmentTotals = { requests: number; records: number; parts: number; requestSum: string; recordSum: string; partSum: string };
export type ArchiveAbandonmentCursor = { request: string; recordPart: number; recordOffset: number; part: number };
export type ArchiveAbandonmentJobRow = {
  abandonment_id: string; publication_id: string; build_json: string; build_sha256: string;
  admission_generation: string; execution_generation: string; reason: 'invalid_unpublished';
  state: 'pending' | 'running' | 'paused' | 'complete'; phase: ArchiveAbandonmentPhase; mode: 'initial' | 'resume';
  revision: number; lease_token: string | null; lease_expires_at: string | null;
  cursor_json: string; observed_json: string; inventory_json: string | null; removed_json: string;
  progress_json: string; selection_json: string; pause_reason: 'generation_reset' | null;
  created_at: string; updated_at: string; completed_at: string | null;
};
export const PUBLICATION_ABANDONMENT_BUILD_COLUMNS = ['publication_id','verification_id','generation','run_id','snapshot_commit_token','graph_sha256','validator_version','archive_id','center_id','month','timezone','root_reference_json','header_json','header_sha256','part_count','record_count','state','revision','lease_token','lease_expires_at','next_part','next_offset','indexed_count','request_count','counts_json','locator_digest','created_at','updated_at'] as const;
function alias(value: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('ARCHIVE_ABANDONMENT_SQL_ALIAS_INVALID'); return value; }
function andSql(terms: string[]): string {
  if (terms.length === 1) return terms[0];
  const middle = Math.floor(terms.length / 2);
  return `(${andSql(terms.slice(0, middle))} AND ${andSql(terms.slice(middle))})`;
}
export function archiveAbandonmentBuildSql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return `EXISTS(SELECT 1 FROM archive_publication_builds ab WHERE ab.publication_id=${j}.publication_id AND ab.state='invalid' AND ab.lease_token IS NULL AND ab.lease_expires_at IS NULL AND ${andSql(PUBLICATION_ABANDONMENT_BUILD_COLUMNS.map(column => `json_extract(${j}.build_json,'$.${column}') IS ab.${column}`))} AND (SELECT count(*) FROM json_each(${j}.build_json))=28 AND NOT EXISTS(SELECT 1 FROM json_each(${j}.build_json) pin WHERE pin.type!=CASE WHEN pin.key IN ('validator_version','part_count','record_count','revision','next_part','next_offset','indexed_count','request_count') THEN 'integer' WHEN pin.key IN ('lease_token','lease_expires_at') THEN 'null' ELSE 'text' END) AND json_remove(${j}.build_json,${PUBLICATION_ABANDONMENT_BUILD_COLUMNS.map(column => `'$.${column}'`).join(',')})='{}') AND NOT EXISTS(SELECT 1 FROM archive_publications WHERE publication_id=${j}.publication_id) AND NOT EXISTS(SELECT 1 FROM archive_publication_availability WHERE publication_id=${j}.publication_id) AND NOT EXISTS(SELECT 1 FROM archive_publication_reconciliation_jobs WHERE publication_id=${j}.publication_id) AND NOT EXISTS(SELECT 1 FROM archive_publication_reconciliation_receipts WHERE publication_id=${j}.publication_id)`;
}
export function archiveAbandonmentAuthoritySql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return andSql([archiveAbandonmentBuildSql(j), archiveAbandonmentLedgerSql(j), `EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND state='ready' AND generation=${j}.execution_generation)`, "NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))"]);
}
/** A copied job without its immutable control history grants no work authority. */
export function archiveAbandonmentLedgerSql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return andSql([
    `EXISTS(SELECT 1 FROM archive_publication_abandonment_diagnostics d WHERE d.abandonment_id=${j}.abandonment_id AND d.kind='admitted' AND d.revision=0 AND d.execution_generation=${j}.admission_generation AND d.build_sha256=${j}.build_sha256)`,
    `(${j}.mode='initial' OR EXISTS(SELECT 1 FROM archive_publication_abandonment_diagnostics d WHERE d.abandonment_id=${j}.abandonment_id AND d.kind='rebound' AND d.execution_generation=${j}.execution_generation AND d.build_sha256=${j}.build_sha256 AND d.revision<=${j}.revision))`,
    `(${j}.phase NOT IN ('delete_requests','delete_records','delete_parts','complete') OR EXISTS(SELECT 1 FROM archive_publication_abandonment_diagnostics d WHERE d.abandonment_id=${j}.abandonment_id AND d.kind='inventoried' AND d.execution_generation=${j}.execution_generation AND d.build_sha256=${j}.build_sha256 AND d.inventory_json IS ${j}.inventory_json AND d.revision<=${j}.revision))`,
  ]);
}
export function archiveAbandonmentLeaseSql(jobAlias = 'j'): string {
  const j = alias(jobAlias);
  return `${j}.state='running' AND ${j}.lease_token IS NOT NULL AND ${j}.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${archiveAbandonmentAuthoritySql(j)}`;
}
/** Exact native selection, arrays contain request ID; table/key/part/offset; or part index. */
export function archiveAbandonmentSelectionSql(phase: ArchiveAbandonmentPhase, jobAlias = 'j'): string {
  const j = alias(jobAlias), inventory = phase.startsWith('inventory_');
  if (phase.endsWith('_requests')) return `(SELECT json_group_array(json_array(request_id)) FROM (SELECT request_id FROM archive_publication_requests INDEXED BY archive_publication_requests_publication_request WHERE publication_id=${j}.publication_id${inventory ? ` AND request_id>json_extract(${j}.cursor_json,'$.request')` : ''} ORDER BY request_id LIMIT 8))`;
  if (phase.endsWith('_records')) return `(SELECT json_group_array(json_array(table_name,record_key,part_index,part_offset)) FROM (SELECT table_name,record_key,part_index,part_offset FROM archive_publication_records WHERE publication_id=${j}.publication_id${inventory ? ` AND (part_index,part_offset)>(json_extract(${j}.cursor_json,'$.recordPart'),json_extract(${j}.cursor_json,'$.recordOffset'))` : ''} ORDER BY part_index,part_offset LIMIT 8))`;
  if (phase.endsWith('_parts')) return `(SELECT json_group_array(json_array(part_index)) FROM (SELECT part_index FROM archive_publication_parts WHERE publication_id=${j}.publication_id${inventory ? ` AND part_index>json_extract(${j}.cursor_json,'$.part')` : ''} ORDER BY part_index LIMIT 8))`;
  if (phase === 'complete') return "'[]'";
  throw new Error('ARCHIVE_ABANDONMENT_PHASE_INVALID');
}
