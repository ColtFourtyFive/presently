import type { ArchiveRecord, ArchiveReference } from '../shared/archive-format';
import { readPublishedCorrectionAddendum, type AddendumDatabase, type AddendumStorage } from './archive-correction-addendum';
import { loadManifestRecordEvidence, type ArchiveRecordEvidenceStorage } from './archive-record-evidence';
import type { Env } from './types';
import { id, now, sha256 } from './util';

type Statement = D1PreparedStatement;
type Database = D1Database & AddendumDatabase<Statement>;

type RetentionJob = {
  job_id: string;
  center_id: string;
  generation: string;
  policy_revision: number;
  live_tier_days: number;
  evidence_retention_days: number;
  evidence_expiry_enabled: number;
  live_cutoff: string;
  evidence_cutoff: string;
  candidate_limit: number;
  status: 'planning' | 'complete' | 'blocked' | 'invalid';
  cursor_time: string;
  cursor_visit_id: string;
  candidate_count: number;
  blocked_count: number;
  authority_digest: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  revision: number;
  error_code: string | null;
};

type Candidate = {
  visit_id: string;
  center_id: string;
  student_id: string;
  original_check_in_at: string;
  original_check_out_at: string;
  check_in_at: string;
  check_out_at: string;
  version: number;
  review_status: string;
  residency: string;
  source_revision: number;
  closure_json: string;
};

type BaseAuthority = {
  publication_id: string;
  generation: string;
  archive_id: string;
  center_id: string;
  month: string;
  timezone: string;
  root_reference_json: string;
  header_sha256: string;
  manifest_sha256: string;
  availability_generation: string;
  availability_status: string;
  runtime_generation: string;
  runtime_state: string;
};

type AddendumAuthority = {
  publication_id: string;
  correction_id: string;
  generation: string;
  archive_id: string;
  visit_id: string;
  expected_version: number;
  resulting_version: number;
  parent_kind: string;
  parent_publication_id: string;
  chain_depth: number;
  manifest_sha256: string;
  records_sha256: string;
  availability_generation: string;
  availability_status: string;
  runtime_generation: string;
  runtime_state: string;
};

type CheckpointAuthority = {
  publication_id: string;
  generation: string;
  archive_id: string;
  visit_id: string;
  base_publication_id: string;
  starting_version: number;
  resulting_version: number;
  correction_count: number;
  member_digest: string;
  manifest_sha256: string;
  records_sha256: string;
  availability_generation: string;
  availability_status: string;
  runtime_generation: string;
  runtime_state: string;
};

export type RetentionStorage = ArchiveRecordEvidenceStorage & AddendumStorage;

export type RetentionAdvance = Readonly<{
  jobId: string;
  status: RetentionJob['status'] | 'missing';
  revision: number;
  candidateCount: number;
  processed: number;
  busy: boolean;
  errorCode?: string;
}>;

type RetentionItem = {
  job_id: string;
  sequence: number;
  visit_id: string;
  student_id: string;
  original_check_in_at: string;
  effective_check_out_at: string;
  head_version: number;
  head_residency: string;
  source_closure_json: string;
  source_closure_sha256: string;
  base_publication_id: string;
  base_manifest_sha256: string;
  addendum_authority_json: string;
  addendum_authority_sha256: string;
  evidence_closure_sha256: string;
  verified_at: string;
  source_revision: number;
};

export type RetentionEvictionEvidence = Readonly<{
  jobId: string;
  sequence: number;
  visitId: string;
  centerId: string;
  generation: string;
  policyRevision: number;
  sourceClosureJson: string;
  sourceClosureSha256: string;
  evidenceClosureSha256: string;
  sourceRevision: number;
  verifiedAt: string;
}>;

const leaseMs = 60_000;
const maximumClosureBytes = 512 * 1024;

function asDatabase(db: D1Database): Database {
  return db as Database;
}

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString();
}

function fail(code: string): never {
  throw new Error(code);
}

function same(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}

function visitMatches(record: ArchiveRecord, candidate: Candidate): boolean {
  if (record.table !== 'visits' || record.key !== candidate.visit_id) return false;
  const row = record.row as Record<string, unknown>;
  return row.id === candidate.visit_id
    && row.center_id === candidate.center_id
    && row.student_id === candidate.student_id
    && row.original_check_in_at === candidate.original_check_in_at
    && same(row.original_check_out_at, candidate.original_check_out_at)
    && row.check_in_at === candidate.check_in_at
    && same(row.check_out_at, candidate.check_out_at)
    && Number(row.version) === Number(candidate.version)
    && row.review_status === candidate.review_status;
}

const candidateSql = `
  SELECT h.visit_id,h.center_id,h.student_id,h.original_check_in_at,h.original_check_out_at,
         h.check_in_at,h.check_out_at,h.version,h.review_status,h.residency,
         sr.revision AS source_revision,c.closure_json
  FROM history_visit_heads h
  JOIN history_retention_source_closures c ON c.visit_id=h.visit_id AND c.center_id=h.center_id
  JOIN history_source_revisions sr ON sr.visit_id=h.visit_id
  WHERE h.center_id=? AND h.residency='live'
    AND h.original_check_out_at IS NOT NULL AND h.original_check_out_at<?
    AND h.check_out_at IS NOT NULL AND h.check_out_at<?
    AND h.review_status!='pending'
    AND (h.original_check_in_at>? OR (h.original_check_in_at=? AND h.visit_id>?))
    AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.visit_id=h.visit_id AND r.status='pending')
    AND NOT EXISTS(
      SELECT 1 FROM history_holds x
      WHERE x.center_id=h.center_id AND (x.visit_id=h.visit_id OR x.student_id=h.student_id)
        AND NOT EXISTS(SELECT 1 FROM history_hold_releases z WHERE z.hold_id=x.hold_id)
    )
    AND NOT EXISTS(SELECT 1 FROM history_retention_items i WHERE i.job_id=? AND i.visit_id=h.visit_id)
  ORDER BY h.original_check_in_at,h.visit_id
  LIMIT 1`;

async function nextCandidate(db: Database, job: RetentionJob): Promise<Candidate | null> {
  return db.prepare(candidateSql).bind(
    job.center_id,
    job.live_cutoff,
    job.live_cutoff,
    job.cursor_time,
    job.cursor_time,
    job.cursor_visit_id,
    job.job_id,
  ).first<Candidate>();
}

async function baseAuthority(db: Database, visitId: string, generation: string): Promise<BaseAuthority> {
  const rows = await db.prepare(`
    SELECT * FROM (
      SELECT p.publication_id,p.generation,p.archive_id,p.center_id,p.month,p.timezone,
        p.root_reference_json,p.header_sha256,p.manifest_sha256,
        a.generation AS availability_generation,a.status AS availability_status,
        h.generation AS runtime_generation,h.state AS runtime_state,p.published_at
      FROM archive_publication_records r
      JOIN archive_publications p ON p.publication_id=r.publication_id
      JOIN archive_publication_availability a ON a.publication_id=p.publication_id
      JOIN history_runtime h ON h.id=1
      WHERE r.table_name='visits' AND r.record_key=?
      UNION ALL
      SELECT p.publication_id,p.generation,p.archive_id,p.center_id,p.month,p.timezone,
        p.root_reference_json,p.header_sha256,json_extract(p.root_reference_json,'$.manifestSha256') AS manifest_sha256,
        a.generation AS availability_generation,a.status AS availability_status,
        h.generation AS runtime_generation,h.state AS runtime_state,p.published_at
      FROM history_visit_heads v
      JOIN archive_compact_publications p ON p.center_id=v.center_id
        AND v.original_check_in_at>=json_extract(p.header_json,'$.periodFrom')
        AND v.original_check_in_at<json_extract(p.header_json,'$.periodTo')
      JOIN archive_compact_availability a ON a.publication_id=p.publication_id
      JOIN history_runtime h ON h.id=1
      WHERE v.visit_id=?
    ) ORDER BY published_at,publication_id LIMIT 2`).bind(visitId, visitId).all<BaseAuthority>();
  if (rows.results.length !== 1) fail(rows.results.length ? 'RETENTION_BASE_AMBIGUOUS' : 'RETENTION_BASE_MISSING');
  const row = rows.results[0];
  if (row.availability_generation !== generation
      || row.runtime_generation !== generation || row.availability_status !== 'ready'
      || row.runtime_state !== 'ready') fail('RETENTION_BASE_UNAVAILABLE');
  return row;
}

async function addendumAuthority(db: Database, visitId: string): Promise<AddendumAuthority[]> {
  const rows = await db.prepare(`
    SELECT p.publication_id,p.correction_id,p.generation,p.archive_id,p.visit_id,
           p.expected_version,p.resulting_version,p.parent_kind,p.parent_publication_id,
           p.chain_depth,p.manifest_sha256,p.records_sha256,
           a.generation AS availability_generation,a.status AS availability_status,
           h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_correction_addendum_publications p
    LEFT JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.visit_id=?
    ORDER BY p.resulting_version,p.chain_depth,p.publication_id LIMIT 65`).bind(visitId).all<AddendumAuthority>();
  return rows.results;
}

function authorityValid(rows: AddendumAuthority[], generation: string): boolean {
  return rows.every(row => row.availability_generation === generation
    && row.runtime_generation === generation
    && row.availability_status === 'ready'
    && row.runtime_state === 'ready');
}

async function checkpointAuthority(db: Database, visitId: string): Promise<CheckpointAuthority[]> {
  const rows = await db.prepare(`
    SELECT p.publication_id,p.generation,p.archive_id,p.visit_id,p.base_publication_id,
           p.starting_version,p.resulting_version,p.correction_count,p.member_digest,
           p.manifest_sha256,p.records_sha256,
           a.generation AS availability_generation,a.status AS availability_status,
           h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_correction_checkpoint_publications p
    LEFT JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.visit_id=?
    ORDER BY p.resulting_version,p.publication_id LIMIT 8`).bind(visitId).all<CheckpointAuthority>();
  return rows.results;
}

function checkpointAuthorityValid(rows: CheckpointAuthority[], generation: string): boolean {
  return rows.every(row => row.availability_generation === generation
    && row.runtime_generation === generation
    && row.availability_status === 'ready'
    && row.runtime_state === 'ready');
}

async function readEvidence(
  db: Database,
  storage: RetentionStorage,
  candidate: Candidate,
  base: BaseAuthority,
  addenda: AddendumAuthority[],
  checkpoints: CheckpointAuthority[],
): Promise<{ evidenceDigest: string; addendumJson: string; addendumDigest: string }> {
  let reference: ArchiveReference;
  try { reference = JSON.parse(base.root_reference_json) as ArchiveReference; }
  catch { fail('RETENTION_BASE_REFERENCE_INVALID'); }
  const baseVisit = await loadManifestRecordEvidence(storage, {
    reference,
    centerId: base.center_id,
    month: base.month,
    timezone: base.timezone,
    headerSha256: base.header_sha256,
    table: 'visits',
    recordKey: candidate.visit_id,
  });
  const records: unknown[] = [baseVisit];
  let version = Number((baseVisit.row as Record<string, unknown>).version);
  let finalVisit = baseVisit;
  for (const authority of addenda) {
    if (authority.expected_version !== version || authority.resulting_version !== version + 1) {
      fail('RETENTION_ADDENDUM_SEQUENCE_INVALID');
    }
    const evidence = await readPublishedCorrectionAddendum(db, storage, authority.correction_id);
    if (evidence.generation !== base.runtime_generation) fail('RETENTION_ADDENDUM_GENERATION_CHANGED');
    const visitRow = evidence.visit.row as Record<string, unknown>;
    if (evidence.visit.key !== candidate.visit_id || Number(visitRow.version) !== authority.resulting_version) {
      fail('RETENTION_ADDENDUM_VISIT_INVALID');
    }
    records.push(evidence.visit, evidence.correction, evidence.audit);
    finalVisit = evidence.visit;
    version = authority.resulting_version;
  }
  if (!visitMatches(finalVisit, candidate)) fail('RETENTION_EVIDENCE_HEAD_MISMATCH');
  const addendumJson = JSON.stringify({ addenda, checkpoints });
  return {
    evidenceDigest: await sha256(JSON.stringify(records)),
    addendumJson,
    addendumDigest: await sha256(addendumJson),
  };
}

async function block(db: Database, job: RetentionJob, leaseToken: string, code: string): Promise<RetentionAdvance> {
  const at = now();
  await db.prepare(`UPDATE history_retention_jobs
    SET status='blocked',blocked_count=blocked_count+1,error_code=?,lease_token=NULL,
        lease_expires_at=NULL,updated_at=?,revision=revision+1
    WHERE job_id=? AND status='planning' AND lease_token=?`).bind(code, at, job.job_id, leaseToken).run();
  const fresh = await db.prepare('SELECT * FROM history_retention_jobs WHERE job_id=?').bind(job.job_id).first<RetentionJob>();
  return Object.freeze({
    jobId: job.job_id,
    status: fresh?.status ?? 'missing',
    revision: fresh?.revision ?? job.revision,
    candidateCount: fresh?.candidate_count ?? job.candidate_count,
    processed: 0,
    busy: false,
    errorCode: fresh?.error_code ?? code,
  });
}

async function finish(db: Database, job: RetentionJob, leaseToken: string): Promise<RetentionAdvance> {
  const items = await db.prepare(`SELECT sequence,visit_id,student_id,head_version,source_closure_sha256,
    base_publication_id,base_manifest_sha256,addendum_authority_sha256,evidence_closure_sha256,verified_at,source_revision
    FROM history_retention_items WHERE job_id=? ORDER BY sequence`).bind(job.job_id).all<Record<string, unknown>>();
  const authorityDigest = await sha256(JSON.stringify(items.results));
  const permitId = id();
  const at = now();
  const result = await db.batch([
    db.prepare(`INSERT INTO history_retention_permits(
      permit_id,job_id,mode,delete_enabled,candidate_count,authority_digest,issued_at
    )
    SELECT ?,j.job_id,'dry_run',0,j.candidate_count,?,?
    FROM history_retention_jobs j
    JOIN history_runtime h ON h.id=1 AND h.generation=j.generation AND h.state='ready'
    WHERE j.job_id=? AND j.status='planning' AND j.lease_token=?
      AND NOT EXISTS(SELECT 1 FROM history_retention_invalidations x WHERE x.job_id=j.job_id)
      AND NOT EXISTS(
        SELECT 1 FROM history_retention_items i
        LEFT JOIN history_visit_heads v ON v.visit_id=i.visit_id
        LEFT JOIN history_retention_source_closures c ON c.visit_id=i.visit_id
      LEFT JOIN archive_publication_availability a ON a.publication_id=i.base_publication_id
      LEFT JOIN archive_compact_availability ca ON ca.publication_id=i.base_publication_id
        WHERE i.job_id=j.job_id AND (
          v.visit_id IS NULL OR c.visit_id IS NULL OR v.version!=i.head_version
          OR v.student_id!=i.student_id OR v.original_check_in_at!=i.original_check_in_at
          OR v.check_out_at!=i.effective_check_out_at OR c.closure_json!=i.source_closure_json
        OR (a.publication_id IS NULL AND ca.publication_id IS NULL)
        OR (a.publication_id IS NOT NULL AND ca.publication_id IS NOT NULL)
        OR COALESCE(a.status,ca.status)!='ready' OR COALESCE(a.generation,ca.generation)!=j.generation
        )
      )`).bind(permitId, authorityDigest, at, job.job_id, leaseToken),
    db.prepare(`UPDATE history_retention_jobs
      SET status='complete',authority_digest=?,completed_at=?,updated_at=?,lease_token=NULL,
          lease_expires_at=NULL,revision=revision+1,error_code=NULL
      WHERE job_id=? AND status='planning' AND lease_token=?
        AND EXISTS(SELECT 1 FROM history_retention_permits p WHERE p.job_id=history_retention_jobs.job_id AND p.permit_id=?)`)
      .bind(authorityDigest, at, at, job.job_id, leaseToken, permitId),
  ]);
  if (result[1].meta.changes !== 1) {
    const fresh = await db.prepare('SELECT * FROM history_retention_jobs WHERE job_id=?').bind(job.job_id).first<RetentionJob>();
    return Object.freeze({
      jobId: job.job_id,
      status: fresh?.status ?? 'missing',
      revision: fresh?.revision ?? job.revision,
      candidateCount: fresh?.candidate_count ?? job.candidate_count,
      processed: 0,
      busy: false,
      errorCode: fresh?.error_code ?? 'RETENTION_DRY_RUN_STALE',
    });
  }
  const fresh = await db.prepare('SELECT * FROM history_retention_jobs WHERE job_id=?').bind(job.job_id).first<RetentionJob>();
  return Object.freeze({
    jobId: job.job_id,
    status: 'complete',
    revision: fresh!.revision,
    candidateCount: fresh!.candidate_count,
    processed: 0,
    busy: false,
  });
}

export async function startRetentionDryRun(
  dbInput: D1Database,
  centerId: string,
  actorId: string,
  requestedLimit?: number,
  at = now(),
): Promise<string> {
  const db = asDatabase(dbInput);
  const policy = await db.prepare(`SELECT p.*,h.generation,h.state
    FROM history_retention_policies p JOIN history_runtime h ON h.id=1
    WHERE p.center_id=?`).bind(centerId).first<Record<string, unknown>>();
  if (!policy || policy.state !== 'ready') fail('RETENTION_HISTORY_NOT_READY');
  const maximum = Number(policy.max_candidates);
  const limit = requestedLimit ?? maximum;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum || limit > 100) fail('RETENTION_LIMIT_INVALID');
  const jobId = id();
  const result = await db.prepare(`INSERT INTO history_retention_jobs(
    job_id,center_id,generation,policy_revision,live_tier_days,evidence_retention_days,
    evidence_expiry_enabled,live_cutoff,evidence_cutoff,candidate_limit,status,
    created_at,created_by,updated_at
  )
  SELECT ?,p.center_id,h.generation,p.revision,p.live_tier_days,p.evidence_retention_days,
         p.evidence_expiry_enabled,?,? ,?,'planning',?,?,?
  FROM history_retention_policies p JOIN history_runtime h ON h.id=1 AND h.state='ready'
  WHERE p.center_id=?
    AND NOT EXISTS(SELECT 1 FROM history_retention_jobs j WHERE j.center_id=p.center_id AND j.status='planning')
    AND NOT EXISTS(SELECT 1 FROM backup_runtime b WHERE b.id=1 AND b.write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .bind(
      jobId,
      daysBefore(at, Number(policy.live_tier_days)),
      daysBefore(at, Number(policy.evidence_retention_days)),
      limit,
      at,
      actorId,
      at,
      centerId,
    ).run();
  if (result.meta.changes !== 1) fail('RETENTION_START_CONFLICT');
  return jobId;
}

export async function advanceRetentionDryRun(
  dbInput: D1Database,
  storage: RetentionStorage,
  jobId: string,
  options: { expectedRevision?: number; clock?: string } = {},
): Promise<RetentionAdvance> {
  const db = asDatabase(dbInput);
  const at = options.clock ?? now();
  const leaseToken = id();
  const expected = options.expectedRevision;
  const claimed = await db.prepare(`UPDATE history_retention_jobs
    SET lease_token=?,lease_expires_at=?,updated_at=?,revision=revision+1
    WHERE job_id=? AND status='planning'
      AND (? IS NULL OR revision=?)
      AND (lease_token IS NULL OR lease_expires_at<=?)
      AND generation=(SELECT generation FROM history_runtime WHERE id=1 AND state='ready')
      AND NOT EXISTS(SELECT 1 FROM backup_runtime b WHERE b.id=1 AND b.write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    RETURNING *`).bind(
      leaseToken,
      new Date(Date.parse(at) + leaseMs).toISOString(),
      at,
      jobId,
      expected ?? null,
      expected ?? null,
      at,
    ).first<RetentionJob>();
  if (!claimed) {
    const current = await db.prepare('SELECT * FROM history_retention_jobs WHERE job_id=?').bind(jobId).first<RetentionJob>();
    return Object.freeze({
      jobId,
      status: current?.status ?? 'missing',
      revision: current?.revision ?? 0,
      candidateCount: current?.candidate_count ?? 0,
      processed: 0,
      busy: current?.status === 'planning',
      ...(current?.error_code ? { errorCode: current.error_code } : {}),
    });
  }
  if (claimed.candidate_count >= claimed.candidate_limit) return finish(db, claimed, leaseToken);
  const candidate = await nextCandidate(db, claimed);
  if (!candidate) return finish(db, claimed, leaseToken);
  if (new TextEncoder().encode(candidate.closure_json).byteLength > maximumClosureBytes) {
    return block(db, claimed, leaseToken, 'RETENTION_CLOSURE_TOO_LARGE');
  }
  try {
    const base = await baseAuthority(db, candidate.visit_id, claimed.generation);
    const [addenda, checkpoints] = await Promise.all([
      addendumAuthority(db, candidate.visit_id),
      checkpointAuthority(db, candidate.visit_id),
    ]);
    if (!authorityValid(addenda, claimed.generation)) fail('RETENTION_ADDENDUM_UNAVAILABLE');
    if (!checkpointAuthorityValid(checkpoints, claimed.generation)) fail('RETENTION_CHECKPOINT_UNAVAILABLE');
    const authorityBefore = JSON.stringify({ base, addenda, checkpoints });
    const evidence = await readEvidence(db, storage, candidate, base, addenda, checkpoints);

    const [freshCandidate, freshBase, freshAddenda, freshCheckpoints] = await Promise.all([
      db.prepare(`SELECT h.visit_id,h.center_id,h.student_id,h.original_check_in_at,h.original_check_out_at,
        h.check_in_at,h.check_out_at,h.version,h.review_status,h.residency,
        sr.revision AS source_revision,c.closure_json
        FROM history_visit_heads h JOIN history_retention_source_closures c ON c.visit_id=h.visit_id
        JOIN history_source_revisions sr ON sr.visit_id=h.visit_id
        WHERE h.visit_id=? AND h.center_id=?`).bind(candidate.visit_id, candidate.center_id).first<Candidate>(),
      baseAuthority(db, candidate.visit_id, claimed.generation),
      addendumAuthority(db, candidate.visit_id),
      checkpointAuthority(db, candidate.visit_id),
    ]);
    if (!freshCandidate || JSON.stringify(freshCandidate) !== JSON.stringify(candidate)
        || JSON.stringify({ base: freshBase, addenda: freshAddenda, checkpoints: freshCheckpoints }) !== authorityBefore) {
      fail('RETENTION_AUTHORITY_CHANGED');
    }
    const sourceDigest = await sha256(candidate.closure_json);
    const verifiedAt = now();
    const write = await db.batch([
      db.prepare(`INSERT INTO history_retention_items(
        job_id,sequence,visit_id,student_id,original_check_in_at,effective_check_out_at,
        head_version,head_residency,source_closure_json,source_closure_sha256,
        base_publication_id,base_manifest_sha256,addendum_authority_json,
        addendum_authority_sha256,evidence_closure_sha256,verified_at,source_revision
      )
      SELECT j.job_id,j.candidate_count+1,h.visit_id,h.student_id,h.original_check_in_at,h.check_out_at,
             h.version,h.residency,c.closure_json,?,?,?,?,?,?,?,sr.revision
      FROM history_retention_jobs j
      JOIN history_visit_heads h ON h.visit_id=? AND h.center_id=j.center_id
      JOIN history_retention_source_closures c ON c.visit_id=h.visit_id AND c.center_id=h.center_id
      JOIN history_source_revisions sr ON sr.visit_id=h.visit_id AND sr.revision=?
      JOIN (
        SELECT publication_id,manifest_sha256 FROM archive_publications
        UNION ALL
        SELECT publication_id,json_extract(root_reference_json,'$.manifestSha256') AS manifest_sha256
        FROM archive_compact_publications
      ) p ON p.publication_id=?
      JOIN (
        SELECT publication_id,generation,status FROM archive_publication_availability
        UNION ALL
        SELECT publication_id,generation,status FROM archive_compact_availability
      ) a ON a.publication_id=p.publication_id
      JOIN history_runtime r ON r.id=1 AND r.generation=j.generation AND r.state='ready'
      WHERE j.job_id=? AND j.status='planning' AND j.lease_token=?
        AND j.candidate_count<j.candidate_limit
        AND h.student_id=? AND h.original_check_in_at=? AND h.original_check_out_at IS ?
        AND h.check_in_at=? AND h.check_out_at IS ? AND h.version=?
        AND h.review_status=? AND h.residency=? AND c.closure_json=?
        AND p.manifest_sha256=?
        AND a.status='ready' AND a.generation=j.generation
        AND NOT EXISTS(
          SELECT 1 FROM archive_correction_addendum_publications ap
          LEFT JOIN archive_correction_addendum_availability aa ON aa.publication_id=ap.publication_id
          WHERE ap.visit_id=h.visit_id
            AND (aa.publication_id IS NULL OR aa.status!='ready' OR aa.generation!=j.generation)
        )
        AND NOT EXISTS(
          SELECT 1 FROM archive_correction_checkpoint_publications cp
          LEFT JOIN archive_correction_checkpoint_availability ca ON ca.publication_id=cp.publication_id
          WHERE cp.visit_id=h.visit_id
            AND (ca.publication_id IS NULL OR ca.status!='ready' OR ca.generation!=j.generation)
        )
        AND NOT EXISTS(SELECT 1 FROM history_retention_invalidations x WHERE x.job_id=j.job_id)
        AND NOT EXISTS(
          SELECT 1 FROM history_holds x WHERE x.center_id=h.center_id
            AND (x.visit_id=h.visit_id OR x.student_id=h.student_id)
            AND NOT EXISTS(SELECT 1 FROM history_hold_releases z WHERE z.hold_id=x.hold_id)
        )
        AND NOT EXISTS(SELECT 1 FROM reviews q WHERE q.visit_id=h.visit_id AND q.status='pending')
        AND NOT EXISTS(
          SELECT 1 FROM history_correction_outbox o
          LEFT JOIN archive_correction_addendum_publications ap ON ap.correction_id=o.id
          LEFT JOIN archive_correction_addendum_availability aa ON aa.publication_id=ap.publication_id
          WHERE o.visit_id=h.visit_id
            AND (ap.publication_id IS NULL OR aa.publication_id IS NULL
              OR aa.status!='ready' OR aa.generation!=j.generation)
        )`)
        .bind(
          sourceDigest,
          base.publication_id,
          base.manifest_sha256,
          evidence.addendumJson,
          evidence.addendumDigest,
          evidence.evidenceDigest,
          verifiedAt,
          candidate.visit_id,
          candidate.source_revision,
          base.publication_id,
          claimed.job_id,
          leaseToken,
          candidate.student_id,
          candidate.original_check_in_at,
          candidate.original_check_out_at,
          candidate.check_in_at,
          candidate.check_out_at,
          candidate.version,
          candidate.review_status,
          candidate.residency,
          candidate.closure_json,
          base.manifest_sha256,
        ),
      db.prepare(`UPDATE history_retention_jobs
        SET cursor_time=?,cursor_visit_id=?,candidate_count=candidate_count+1,
            lease_token=NULL,lease_expires_at=NULL,updated_at=?,revision=revision+1
        WHERE job_id=? AND status='planning' AND lease_token=?
          AND EXISTS(SELECT 1 FROM history_retention_items i
            WHERE i.job_id=history_retention_jobs.job_id
              AND i.sequence=history_retention_jobs.candidate_count+1
              AND i.visit_id=?)`)
        .bind(candidate.original_check_in_at, candidate.visit_id, verifiedAt, claimed.job_id, leaseToken, candidate.visit_id),
    ]);
    if (write[1].meta.changes !== 1) {
      const current = await db.prepare('SELECT * FROM history_retention_jobs WHERE job_id=?').bind(jobId).first<RetentionJob>();
      return Object.freeze({
        jobId,
        status: current?.status ?? 'missing',
        revision: current?.revision ?? claimed.revision,
        candidateCount: current?.candidate_count ?? claimed.candidate_count,
        processed: 0,
        busy: false,
        errorCode: current?.error_code ?? 'RETENTION_AUTHORITY_CHANGED',
      });
    }
    const current = await db.prepare('SELECT * FROM history_retention_jobs WHERE job_id=?').bind(jobId).first<RetentionJob>();
    return Object.freeze({
      jobId,
      status: current!.status,
      revision: current!.revision,
      candidateCount: current!.candidate_count,
      processed: 1,
      busy: false,
    });
  } catch (error) {
    const code = error instanceof Error && /^RETENTION_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : String(error).includes('backup_maintenance')
        ? 'RETENTION_BACKUP_MAINTENANCE'
        : 'RETENTION_EVIDENCE_UNAVAILABLE';
    return block(db, claimed, leaseToken, code);
  }
}

/** Re-reads authenticated R2 evidence immediately before a source-eviction
 * transaction. The returned snapshot is not authority by itself: schema 36
 * compares it again inside the same D1 batch that deletes source rows and emits
 * the immutable receipt. */
export async function verifyRetentionEvictionEvidence(
  dbInput: D1Database,
  storage: RetentionStorage,
  jobId: string,
  visitId: string,
): Promise<RetentionEvictionEvidence> {
  const db = asDatabase(dbInput);
  const job = await db.prepare(`SELECT * FROM history_retention_jobs
    WHERE job_id=? AND status='complete'`).bind(jobId).first<RetentionJob>();
  if (!job) fail('SOURCE_EVICTION_JOB_INVALID');
  const runtime = await db.prepare("SELECT generation,state FROM history_runtime WHERE id=1")
    .first<{ generation: string; state: string }>();
  if (!runtime || runtime.state !== 'ready' || runtime.generation !== job.generation) {
    fail('SOURCE_EVICTION_GENERATION_CHANGED');
  }
  const item = await db.prepare('SELECT * FROM history_retention_items WHERE job_id=? AND visit_id=?')
    .bind(jobId, visitId).first<RetentionItem>();
  if (!item) fail('SOURCE_EVICTION_ITEM_MISSING');
  const candidate = await db.prepare(`SELECT h.visit_id,h.center_id,h.student_id,h.original_check_in_at,
      h.original_check_out_at,h.check_in_at,h.check_out_at,h.version,h.review_status,h.residency,
      sr.revision AS source_revision,c.closure_json
    FROM history_visit_heads h JOIN history_retention_source_closures c ON c.visit_id=h.visit_id AND c.center_id=h.center_id
    JOIN history_source_revisions sr ON sr.visit_id=h.visit_id
    WHERE h.visit_id=? AND h.center_id=?`).bind(visitId, job.center_id).first<Candidate>();
  if (!candidate || candidate.student_id !== item.student_id
      || candidate.original_check_in_at !== item.original_check_in_at
      || candidate.check_out_at !== item.effective_check_out_at
      || Number(candidate.version) !== Number(item.head_version)
      || candidate.residency !== item.head_residency
      || Number(candidate.source_revision) !== Number(item.source_revision)
      || candidate.closure_json !== item.source_closure_json
      || await sha256(candidate.closure_json) !== item.source_closure_sha256) {
    fail('SOURCE_EVICTION_SOURCE_CHANGED');
  }
  const base = await baseAuthority(db, visitId, job.generation);
  const [addenda, checkpoints] = await Promise.all([
    addendumAuthority(db, visitId),
    checkpointAuthority(db, visitId),
  ]);
  if (!authorityValid(addenda, job.generation)) fail('SOURCE_EVICTION_ADDENDUM_UNAVAILABLE');
  if (!checkpointAuthorityValid(checkpoints, job.generation)) fail('SOURCE_EVICTION_CHECKPOINT_UNAVAILABLE');
  if (base.publication_id !== item.base_publication_id || base.manifest_sha256 !== item.base_manifest_sha256) {
    fail('SOURCE_EVICTION_BASE_CHANGED');
  }
  const evidence = await readEvidence(db, storage, candidate, base, addenda, checkpoints);
  if (evidence.addendumJson !== item.addendum_authority_json
      || evidence.addendumDigest !== item.addendum_authority_sha256
      || evidence.evidenceDigest !== item.evidence_closure_sha256) {
    fail('SOURCE_EVICTION_EVIDENCE_CHANGED');
  }
  return Object.freeze({
    jobId,
    sequence: Number(item.sequence),
    visitId,
    centerId: job.center_id,
    generation: job.generation,
    policyRevision: Number(job.policy_revision),
    sourceClosureJson: item.source_closure_json,
    sourceClosureSha256: item.source_closure_sha256,
    evidenceClosureSha256: item.evidence_closure_sha256,
    sourceRevision: Number(item.source_revision),
    verifiedAt: now(),
  });
}

export async function maintainRetentionDryRuns(env: Env): Promise<RetentionAdvance | null> {
  if (!env.BACKUP_BUCKET || typeof env.BACKUP_KEY !== 'string' || !env.BACKUP_KEY) return null;
  const job = await env.CRM_DB.prepare(`SELECT job_id FROM history_retention_jobs
    WHERE status='planning' AND (lease_token IS NULL OR lease_expires_at<=?)
    ORDER BY created_at,job_id LIMIT 1`).bind(now()).first<{ job_id: string }>();
  if (!job) return null;
  return advanceRetentionDryRun(env.CRM_DB, {
    bucket: env.BACKUP_BUCKET as RetentionStorage['bucket'],
    masterKey: env.BACKUP_KEY,
  }, job.job_id);
}
