/** Private direct publication only. Compact reads and restore reconciliation
 * are separate authorities and are not enabled by this builder. */
export const COMPACT_PUBLICATION_LIMITS = Object.freeze({ pageRecords: 8, records: 20_000, leaseMilliseconds: 30_000 });
export type CompactPublicationPhase = 'events' | 'corrections' | 'audit' | 'complete';
export type CompactPublicationBuild = {
  publication_id: string; verification_id: string; generation: string; run_id: string;
  snapshot_commit_token: string; graph_sha256: string; validator_version: 1;
  archive_id: string; center_id: string; month: string; timezone: string;
  root_reference_json: string; header_json: string; header_sha256: string;
  part_count: number; record_count: number; catalog_version: 2;
  state: 'building' | 'published' | 'invalid'; phase: CompactPublicationPhase; after_key: string;
  verified_events: number; verified_corrections: number; verified_audits: number;
  revision: number; lease_token: string | null; lease_expires_at: string | null;
  created_at: string; updated_at: string;
};
function alias(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('ARCHIVE_COMPACT_SQL_ALIAS_INVALID');
  return value;
}
export const COMPACT_PROOF_COLUMNS = ['publication_id','verification_id','generation','run_id','snapshot_commit_token','graph_sha256','validator_version','archive_id','center_id','month','timezone','root_reference_json','header_json','header_sha256','part_count','record_count','catalog_version'] as const;
export const COMPACT_SOURCE_COLUMNS = {
  attendance_events: ['id','center_id','student_id','visit_id','action','observed_at','received_at','actor_id','actor_name','channel','device_id','guardian_id','reason','payload_hash','insertion_nonce','result_visit'],
  attendance_corrections: ['id','center_id','visit_id','expected_version','prior_check_in_at','prior_check_out_at','check_in_at','check_out_at','reason','actor_id','actor_name','recorded_at','payload_hash'],
  audit_entries: ['id','center_id','actor_id','actor_name','action','entity_type','entity_id','detail','created_at'],
} as const;
/** D1 caps expression depth at 100; native page guards nest these predicates. */
export function compactAnd(parts: readonly string[]): string {
  if (!parts.length) return '1';
  if (parts.length === 1) return parts[0];
  const middle = Math.floor(parts.length / 2);
  return `(${compactAnd(parts.slice(0,middle))} AND ${compactAnd(parts.slice(middle))})`;
}
/** Same supported proof as v1, with a balanced expression tree for page guards. */
export function compactProofSql(buildAlias = 'b'): string {
  const b = alias(buildAlias);
  return `EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation WHERE ${compactAnd([
      `pr.run_id=${b}.run_id`, `pr.verification_id=${b}.verification_id`, `pr.generation=${b}.generation`,
      `pr.snapshot_commit_token=${b}.snapshot_commit_token`, `pr.graph_sha256=${b}.graph_sha256`, `pr.validator_version=${b}.validator_version`, 'pr.validator_version=1',
      "pr.status='complete'", "pr.phase='complete'", `pr.archive_id=${b}.archive_id`, `pr.header_json=${b}.header_json`,
      "ps.status='verified'", `ps.commit_token=${b}.snapshot_commit_token`, `ps.graph_sha256=${b}.graph_sha256`,
      `ps.root_archive_id=${b}.archive_id`, `ps.root_reference_json=${b}.root_reference_json`,
      'pm.manifest_sha256=ps.root_manifest_sha256', `pm.manifest_sha256=json_extract(${b}.root_reference_json,'$.manifestSha256')`,
      `pm.part_count=${b}.part_count`, `pm.record_count=${b}.record_count`, `json_remove(pm.manifest_json,'$.parts')=${b}.header_json`,
      "ph.state='ready'", 'pl.pause_reason IS NULL', "pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    ])})`;
}
export function compactMaintenanceSql(): string {
  return "NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
}
export function compactLeaseSql(buildAlias = 'b'): string {
  const b = alias(buildAlias);
  return compactAnd([`${b}.state='building'`, `${b}.lease_token IS NOT NULL`, `${b}.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`, compactProofSql(b), compactMaintenanceSql()]);
}
export function compactPhaseTableSql(buildAlias = 'b'): string {
  const b = alias(buildAlias);
  return `CASE ${b}.phase WHEN 'events' THEN 'attendance_events' WHEN 'corrections' THEN 'attendance_corrections' WHEN 'audit' THEN 'audit_entries' END`;
}
/** Exact immutable row equality inherits sealed receipt validation from the
 * completed supported semantic proof; SQL NULL is never an accepted receipt. */
export function compactSourceSql(table: keyof typeof COMPACT_SOURCE_COLUMNS, buildAlias = 'b', rowAlias = 'sr'): string {
  const b = alias(buildAlias), r = alias(rowAlias);
  const equal = compactAnd(COMPACT_SOURCE_COLUMNS[table].map(column => `s.${column} IS json_extract(${r}.record_json,'$.row.${column}')`));
  const base = compactAnd([`s.id=${r}.record_key`, `s.center_id=${b}.center_id`, equal]);
  if (table === 'audit_entries') {
    const field = (name: string) => `json_extract(${r}.record_json,'$.row.${name}')`;
    const common = (sourceAlias: string) => compactAnd([
      `${sourceAlias}.id=${r}.record_key`, `${sourceAlias}.center_id=${b}.center_id`,
      `${field('id')} IS ${sourceAlias}.id`, `${field('center_id')} IS ${sourceAlias}.center_id`,
      `${field('actor_id')} IS ${sourceAlias}.actor_id`, `${field('actor_name')} IS ${sourceAlias}.actor_name`,
    ]);
    const generatedEvent = compactAnd([
      common('e'), `${field('action')} IS e.action`, `${field('entity_type')} IS 'attendance_event'`,
      `${field('entity_id')} IS e.id`,
      `${field('detail')} IS CAST(json_object('studentId',e.student_id,'observedAt',e.observed_at,'receivedAt',e.received_at,'channel',e.channel,'deviceId',e.device_id) AS TEXT)`,
      `${field('created_at')} IS e.received_at`,
    ]);
    const generatedCorrection = compactAnd([
      common('c'), `${field('action')} IS 'attendance_correction'`, `${field('entity_type')} IS 'visit'`,
      `${field('entity_id')} IS c.visit_id`,
      `${field('detail')} IS CAST(json_object('reason',c.reason,'priorCheckInAt',c.prior_check_in_at,'priorCheckOutAt',c.prior_check_out_at,'checkInAt',c.check_in_at,'checkOutAt',c.check_out_at) AS TEXT)`,
      `${field('created_at')} IS c.recorded_at`,
    ]);
    const physical = `EXISTS(SELECT 1 FROM audit_entries s WHERE ${base})`;
    const noPhysical = `NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=${r}.record_key)`;
    const event = `EXISTS(SELECT 1 FROM attendance_events e WHERE ${generatedEvent})`;
    const correction = `EXISTS(SELECT 1 FROM attendance_corrections c WHERE ${generatedCorrection})`;
    const outbox = `EXISTS(SELECT 1 FROM history_correction_outbox c WHERE ${generatedCorrection})`;
    return `(${physical} OR (${noPhysical} AND (${event} OR ${correction} OR ${outbox})))`;
  }
  const source = table;
  const kind = table === 'attendance_events' ? 'event' : 'correction';
  const from = `json_extract(${b}.header_json,'$.periodFrom')`, to = `json_extract(${b}.header_json,'$.periodTo')`;
  const linked = `EXISTS(SELECT 1 FROM visits v WHERE v.id=s.visit_id AND v.center_id=s.center_id AND v.original_check_in_at>=${from} AND v.original_check_in_at<${to})`;
  const membership = kind === 'event' ? `(${linked} OR (s.visit_id IS NULL AND s.action='exceptional_departure' AND s.observed_at>=${from} AND s.observed_at<${to} AND NOT EXISTS(SELECT 1 FROM observation_effective_times p WHERE p.event_id=s.id AND p.version>1)))` : linked;
  const encoding = `CASE WHEN length(s.payload_hash)=64 AND s.payload_hash NOT GLOB '*[^a-fA-F0-9]*' THEN 'hex-sha256'
    WHEN length(s.payload_hash)=44 AND substr(s.payload_hash,44,1)='=' AND substr(s.payload_hash,1,43) NOT GLOB '*[^A-Za-z0-9+/]*' THEN 'base64-sha256'
    WHEN length(s.payload_hash)=43 AND s.payload_hash NOT GLOB '*[^A-Za-z0-9_-]*' THEN 'base64url-sha256' ELSE 'opaque' END`;
  const sealed = kind === 'event' ? " AND s.result_visit IS NOT NULL AND json_valid(s.result_visit) AND (s.result_visit!='null' OR (s.visit_id IS NULL AND s.action='exceptional_departure'))" : '';
  return `EXISTS(SELECT 1 FROM ${source} s JOIN history_request_keys k ON k.request_id=s.id WHERE ${base} AND ${membership}${sealed}
    AND k.source_kind='${kind}' AND k.center_id=s.center_id AND k.payload_hash IS s.payload_hash AND k.hash_encoding=(${encoding}) AND k.canonicalization='legacy-unverified')`;
}

/** The same exact prefix is used by the native insert/checkpoint guards and
 * writer selection. No caller-supplied maximum key defines a page. */
export function compactPageSql(buildAlias = 'b'): string {
  const b = alias(buildAlias);
  return `SELECT sr.record_key,sr.table_name,CASE sr.table_name
      WHEN 'attendance_events' THEN ${compactSourceSql('attendance_events',b)}
      WHEN 'attendance_corrections' THEN ${compactSourceSql('attendance_corrections',b)}
      WHEN 'audit_entries' THEN ${compactSourceSql('audit_entries',b)} ELSE 0 END AS source_valid
    FROM archive_semantic_rows sr JOIN archive_semantic_parts sp ON sp.verification_id=sr.verification_id AND sp.generation=sr.generation AND sp.archive_id=sr.archive_id AND sp.part_index=sr.part_index AND sp.commit_token=sr.part_commit_token
    WHERE sr.verification_id=${b}.verification_id AND sr.generation=${b}.generation AND sr.archive_id=${b}.archive_id
      AND sr.table_name=(${compactPhaseTableSql(b)}) AND sr.record_key>${b}.after_key ORDER BY sr.record_key LIMIT 8`;
}
export function compactMembershipSql(buildAlias = 'b'): string {
  const b = alias(buildAlias);
  return `NOT EXISTS(SELECT 1 FROM archive_semantic_rows sr WHERE sr.verification_id=${b}.verification_id AND sr.generation=${b}.generation AND sr.archive_id=${b}.archive_id AND sr.table_name IN ('attendance_events','attendance_corrections')
    AND NOT EXISTS(SELECT 1 FROM archive_compact_requests q WHERE q.request_id=sr.record_key AND q.publication_id=${b}.publication_id))
    AND NOT EXISTS(SELECT 1 FROM archive_compact_requests q JOIN history_request_keys k ON k.request_id=q.request_id
      WHERE q.publication_id=${b}.publication_id AND NOT (k.center_id=${b}.center_id AND (
        (k.source_kind='event' AND EXISTS(SELECT 1 FROM archive_semantic_rows sr
          WHERE sr.verification_id=${b}.verification_id AND sr.generation=${b}.generation AND sr.archive_id=${b}.archive_id
          AND sr.table_name='attendance_events' AND sr.record_key=q.request_id AND k.payload_hash IS json_extract(sr.record_json,'$.row.payload_hash')))
        OR (k.source_kind='correction' AND EXISTS(SELECT 1 FROM archive_semantic_rows sr
          WHERE sr.verification_id=${b}.verification_id AND sr.generation=${b}.generation AND sr.archive_id=${b}.archive_id
          AND sr.table_name='attendance_corrections' AND sr.record_key=q.request_id AND k.payload_hash IS json_extract(sr.record_json,'$.row.payload_hash'))))))
    AND (SELECT count(*) FROM archive_compact_requests q WHERE q.publication_id=${b}.publication_id)=${b}.verified_events+${b}.verified_corrections`;
}
