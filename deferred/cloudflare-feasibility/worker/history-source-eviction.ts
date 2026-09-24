import type { RetentionStorage } from './history-retention';
import { verifyRetentionEvictionEvidence } from './history-retention';
import { now } from './util';

type EvictionPolicy = {
  enabled: number;
  revision: number;
};

type RetentionItem = {
  sequence: number;
  visit_id: string;
};

type SourceCounts = {
  visit_count: number;
  event_count: number;
  correction_count: number;
  review_count: number;
  audit_count: number;
  legacy_hold_count: number;
};

export type EvidenceExpiryScheduleResult = Readonly<{
  jobId: string;
  scheduled: number;
  total: number;
  deleteEnabled: false;
}>;

export type SourceEvictionResult = Readonly<{
  receiptId: string;
  jobId: string;
  visitId: string;
  sourceCounts: Readonly<{
    visits: number;
    events: number;
    corrections: number;
    reviews: number;
    audits: number;
    legacyHolds: number;
  }>;
  alreadyComplete: boolean;
}>;

function fail(code: string): never {
  throw new Error(code);
}

export async function scheduleRetentionEvidenceExpiry(
  db: D1Database,
  jobId: string,
  actorId: string,
  at = now(),
): Promise<EvidenceExpiryScheduleResult> {
  const job = await db.prepare(`SELECT j.job_id,j.center_id,j.generation,j.policy_revision,
      j.authority_digest,j.evidence_retention_days,p.evidence_expiry_enabled
    FROM history_retention_jobs j
    JOIN history_retention_policies p ON p.center_id=j.center_id AND p.revision=j.policy_revision
    JOIN history_runtime h ON h.id=1 AND h.generation=j.generation AND h.state='ready'
    WHERE j.job_id=? AND j.status='complete'`).bind(jobId).first<Record<string, unknown>>();
  if (!job) fail('EVIDENCE_EXPIRY_JOB_INVALID');
  if (Number(job.evidence_expiry_enabled) !== 1) fail('EVIDENCE_EXPIRY_DISABLED');
  if (typeof job.authority_digest !== 'string') fail('EVIDENCE_EXPIRY_JOB_INVALID');
  const items = await db.prepare(`SELECT sequence,visit_id FROM history_retention_items
    WHERE job_id=? ORDER BY sequence`).bind(jobId).all<RetentionItem>();
  const statements = items.results.map(item => db.prepare(`INSERT OR IGNORE INTO history_evidence_expiry_schedules(
      schedule_id,job_id,sequence,visit_id,center_id,generation,policy_revision,evidence_expires_at,
      base_publication_id,authority_digest,delete_enabled,status,created_at,created_by
    )
    SELECT ?,j.job_id,i.sequence,i.visit_id,j.center_id,j.generation,j.policy_revision,
      strftime('%Y-%m-%dT%H:%M:%fZ',i.effective_check_out_at,'+'||j.evidence_retention_days||' days'),
      i.base_publication_id,j.authority_digest,0,'scheduled',?,?
    FROM history_retention_jobs j JOIN history_retention_items i ON i.job_id=j.job_id
    WHERE j.job_id=? AND i.sequence=? AND i.visit_id=?`)
    .bind(`expiry_${crypto.randomUUID()}`, at, actorId, jobId, item.sequence, item.visit_id));
  let scheduled = 0;
  if (statements.length) {
    const results = await db.batch(statements);
    scheduled = results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
  }
  const total = Number(await db.prepare('SELECT count(*) AS n FROM history_evidence_expiry_schedules WHERE job_id=?')
    .bind(jobId).first('n'));
  return Object.freeze({ jobId, scheduled, total, deleteEnabled: false });
}

async function loadCounts(db: D1Database, visitId: string, closureJson: string): Promise<SourceCounts> {
  const [visits, events, corrections, reviews, audits, holds] = await db.batch<{ n: number }>([
    db.prepare('SELECT count(*) AS n FROM visits WHERE id=?').bind(visitId),
    db.prepare('SELECT count(*) AS n FROM attendance_events WHERE visit_id=?').bind(visitId),
    db.prepare('SELECT count(*) AS n FROM attendance_corrections WHERE visit_id=?').bind(visitId),
    db.prepare('SELECT count(*) AS n FROM reviews WHERE visit_id=?').bind(visitId),
    db.prepare(`SELECT count(*) AS n FROM audit_entries a WHERE EXISTS(
      SELECT 1 FROM json_each(?,'$.audits') x WHERE json_extract(x.value,'$.id')=a.id
    )`).bind(closureJson),
    db.prepare('SELECT count(*) AS n FROM archive_holds WHERE visit_id=?').bind(visitId),
  ]);
  return {
    visit_count: Number(visits.results[0]?.n ?? 0),
    event_count: Number(events.results[0]?.n ?? 0),
    correction_count: Number(corrections.results[0]?.n ?? 0),
    review_count: Number(reviews.results[0]?.n ?? 0),
    audit_count: Number(audits.results[0]?.n ?? 0),
    legacy_hold_count: Number(holds.results[0]?.n ?? 0),
  };
}

function resultFromReceipt(row: Record<string, unknown>, alreadyComplete: boolean): SourceEvictionResult {
  return Object.freeze({
    receiptId: String(row.receipt_id),
    jobId: String(row.job_id),
    visitId: String(row.visit_id),
    sourceCounts: Object.freeze({
      visits: Number(row.visit_count),
      events: Number(row.event_count),
      corrections: Number(row.correction_count),
      reviews: Number(row.review_count),
      audits: Number(row.audit_count),
      legacyHolds: Number(row.legacy_hold_count),
    }),
    alreadyComplete,
  });
}

export async function evictRetentionSource(
  db: D1Database,
  storage: RetentionStorage,
  jobId: string,
  visitId: string,
  actorId: string,
): Promise<SourceEvictionResult> {
  const existing = await db.prepare('SELECT * FROM history_source_eviction_receipts WHERE job_id=? AND visit_id=?')
    .bind(jobId, visitId).first<Record<string, unknown>>();
  if (existing) return resultFromReceipt(existing, true);
  const center = await db.prepare(`SELECT j.center_id FROM history_retention_jobs j
    JOIN history_retention_items i ON i.job_id=j.job_id
    WHERE j.job_id=? AND i.visit_id=?`).bind(jobId, visitId).first<{ center_id: string }>();
  if (!center) fail('SOURCE_EVICTION_ITEM_MISSING');
  const policy = await db.prepare('SELECT enabled,revision FROM history_source_eviction_policies WHERE center_id=?')
    .bind(center.center_id).first<EvictionPolicy>();
  if (!policy || policy.enabled !== 1) fail('SOURCE_EVICTION_DISABLED');

  const evidence = await verifyRetentionEvictionEvidence(db, storage, jobId, visitId);
  const counts = await loadCounts(db, visitId, evidence.sourceClosureJson);
  if (counts.visit_count !== 1) fail('SOURCE_EVICTION_SOURCE_CHANGED');
  const capabilityId = `evictcap_${crypto.randomUUID()}`;
  const receiptId = `eviction_${crypto.randomUUID()}`;
  const bindings = [
    evidence.jobId,
    evidence.sequence,
    evidence.visitId,
    evidence.centerId,
    evidence.generation,
    evidence.policyRevision,
    Number(policy.revision),
    evidence.sourceClosureJson,
    evidence.sourceClosureSha256,
    evidence.evidenceClosureSha256,
    evidence.sourceRevision,
    counts.visit_count,
    counts.event_count,
    counts.correction_count,
    counts.review_count,
    counts.audit_count,
    counts.legacy_hold_count,
    evidence.verifiedAt,
    evidence.verifiedAt,
    actorId,
  ] as const;
  await db.batch([
    db.prepare(`INSERT INTO history_source_eviction_capabilities(
      capability_id,job_id,sequence,visit_id,center_id,generation,retention_policy_revision,eviction_policy_revision,
      source_closure_json,source_closure_sha256,evidence_closure_sha256,source_revision,
      visit_count,event_count,correction_count,review_count,audit_count,legacy_hold_count,
      verified_at,created_at,created_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(capabilityId, ...bindings),
    db.prepare(`DELETE FROM audit_entries WHERE EXISTS(
      SELECT 1 FROM history_source_eviction_capabilities c,json_each(c.source_closure_json,'$.audits') x
      WHERE c.capability_id=? AND json_extract(x.value,'$.id')=audit_entries.id
    )`).bind(capabilityId),
    db.prepare(`DELETE FROM reviews WHERE visit_id=? AND EXISTS(
      SELECT 1 FROM history_source_eviction_capabilities c WHERE c.capability_id=? AND c.visit_id=reviews.visit_id
    )`).bind(visitId, capabilityId),
    db.prepare(`DELETE FROM attendance_corrections WHERE visit_id=? AND EXISTS(
      SELECT 1 FROM history_source_eviction_capabilities c WHERE c.capability_id=? AND c.visit_id=attendance_corrections.visit_id
    )`).bind(visitId, capabilityId),
    db.prepare(`DELETE FROM attendance_events WHERE visit_id=? AND EXISTS(
      SELECT 1 FROM history_source_eviction_capabilities c WHERE c.capability_id=? AND c.visit_id=attendance_events.visit_id
    )`).bind(visitId, capabilityId),
    db.prepare(`DELETE FROM archive_holds WHERE visit_id=? AND EXISTS(
      SELECT 1 FROM history_source_eviction_capabilities c WHERE c.capability_id=? AND c.visit_id=archive_holds.visit_id
    )`).bind(visitId, capabilityId),
    db.prepare(`DELETE FROM visits WHERE id=? AND EXISTS(
      SELECT 1 FROM history_source_eviction_capabilities c WHERE c.capability_id=? AND c.visit_id=visits.id
    )`).bind(visitId, capabilityId),
    db.prepare(`INSERT INTO history_source_eviction_receipts(
      receipt_id,capability_id,job_id,sequence,visit_id,center_id,generation,retention_policy_revision,eviction_policy_revision,
      source_closure_sha256,evidence_closure_sha256,source_revision,visit_count,event_count,correction_count,
      review_count,audit_count,legacy_hold_count,verified_at,evicted_at,evicted_by
    ) SELECT ?,capability_id,job_id,sequence,visit_id,center_id,generation,retention_policy_revision,eviction_policy_revision,
      source_closure_sha256,evidence_closure_sha256,source_revision,visit_count,event_count,correction_count,
      review_count,audit_count,legacy_hold_count,verified_at,?,created_by
    FROM history_source_eviction_capabilities WHERE capability_id=?`)
      .bind(receiptId, evidence.verifiedAt, capabilityId),
    db.prepare('DELETE FROM history_source_eviction_capabilities WHERE capability_id=?').bind(capabilityId),
  ]);
  const receipt = await db.prepare('SELECT * FROM history_source_eviction_receipts WHERE receipt_id=?')
    .bind(receiptId).first<Record<string, unknown>>();
  if (!receipt) fail('SOURCE_EVICTION_RECEIPT_MISSING');
  return resultFromReceipt(receipt, false);
}
