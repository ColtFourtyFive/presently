import type { ArchiveSemanticCleanup, ArchiveSemanticHandle, ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import type { ArchiveStagingLifecycle } from './archive-staging-lifecycle';
import { digest } from './backup-crypto';

export const ARCHIVE_STAGING_CLEANUP_LEASE_SECONDS = 30;
export const ARCHIVE_STAGING_MAX_RENEWAL_DAYS = 14;
export type ArchiveStagingPauseReason = 'maintenance' | 'daily_budget' | 'capacity' | 'size_unavailable';
export interface ArchiveStagingControlledLifecycle extends ArchiveStagingLifecycle {
  pause_reason: ArchiveStagingPauseReason | null; paused_at: string | null; next_eligible_at: string | null;
  resume_grace_until: string | null; renewed_at: string | null; renewal_count: number; cleanup_lease_until: string | null;
}
export interface ArchiveStagingControlIdentity extends ArchiveSemanticHandle { executionGeneration: string; expectedRevision: number }
export interface ArchiveStagingControlOperation extends ArchiveStagingControlIdentity { operationId: string; actorId?: string | null }
export interface ArchiveStagingControlReceipt {
  operationId: string; revision: number; renewalDeadlineAt: string; renewalCount: number;
  pauseReason: ArchiveStagingPauseReason | null; pausedAt: string | null; nextEligibleAt: string | null; resumeGraceUntil: string | null;
}
type ControlKind = 'pause' | 'resume' | 'renew';
type Snapshot = ArchiveStagingControlledLifecycle & { status: string; current_generation: string; clock_now: string; active_lease: number; root_archive_id: string; root_manifest_sha256: string };
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const encoder = new TextEncoder();
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const renewalCutoff = "max(l.renewal_deadline_at,coalesce(l.migration_grace_until,''))";
const noRunner = `NOT EXISTS(SELECT 1 FROM archive_semantic_runs r WHERE r.verification_id=l.verification_id AND r.generation=l.generation AND r.status='running' AND r.lease_expires_at>${now})`;
function fail(code: string): never { throw new Error(`ARCHIVE_STAGING_CONTROL_${code}`); }
function validId(value: unknown): value is string { return typeof value === 'string' && idPattern.test(value); }
function capturedIdentity(value: ArchiveStagingControlIdentity): ArchiveStagingControlIdentity {
  const result = { verificationId: value.verificationId, generation: value.generation, executionGeneration: value.executionGeneration, expectedRevision: value.expectedRevision };
  if (![result.verificationId, result.generation, result.executionGeneration].every(validId) || !Number.isSafeInteger(result.expectedRevision) || result.expectedRevision < 0) fail('IDENTITY_INVALID');
  return Object.freeze(result);
}
export function encodeArchiveControlJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || encoder.encode(text).length > 4096) fail('JSON_BOUND');
  return text;
}
export async function hashArchiveControlRequest(value: unknown): Promise<string> { return digest(encoder.encode(encodeArchiveControlJson(value))); }
export async function archiveCleanupReceiptIdentity(input: ArchiveSemanticCleanup, kind: 'cleanup_claim' | 'cleanup_complete' = 'cleanup_complete'): Promise<{ eventId: string; requestSha256: string; tokenSha256: string }> {
  const handle = { verificationId: input.verificationId, generation: input.generation, cleanupGeneration: input.cleanupGeneration, cleanupToken: input.cleanupToken };
  if (!Object.values(handle).every(validId) || !['cleanup_claim', 'cleanup_complete'].includes(kind)) fail('IDENTITY_INVALID');
  const tokenSha256 = await digest(encoder.encode(handle.cleanupToken));
  const requestSha256 = await hashArchiveControlRequest({ kind, verificationId: handle.verificationId, generation: handle.generation, executionGeneration: handle.cleanupGeneration, tokenSha256 });
  return { eventId: `${kind === 'cleanup_complete' ? 'cleanup-complete' : 'cleanup-claim'}-${tokenSha256}`, requestSha256, tokenSha256 };
}
async function snapshot<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, value: ArchiveSemanticHandle): Promise<Snapshot> {
  const read = await db.batch<Snapshot>([db.prepare(`SELECT l.*,s.status,s.root_archive_id,s.root_manifest_sha256,h.generation AS current_generation,${now} AS clock_now,
    EXISTS(SELECT 1 FROM archive_semantic_runs r WHERE r.verification_id=l.verification_id AND r.generation=l.generation AND r.status='running' AND r.lease_expires_at>${now}) AS active_lease
    FROM archive_semantic_lifecycle l JOIN archive_semantic_sessions s USING(verification_id,generation) JOIN history_runtime h ON h.id=1
    WHERE l.verification_id=? AND l.generation=?`).bind(value.verificationId, value.generation)]);
  const row = read[0].results[0]; if (!row) fail('STALE'); return row;
}
const runnerErrorSql = `(SELECT CASE WHEN error_code NOT GLOB '*[^A-Z0-9_]*' AND length(error_code) BETWEEN 1 AND 120 THEN error_code ELSE NULL END
  FROM archive_semantic_runs r WHERE r.verification_id=l.verification_id AND r.generation=l.generation AND error_code IS NOT NULL ORDER BY run_id LIMIT 1)`;
const detailSql = `json_object('admittedAt',l.admitted_at,'lastProgressAt',l.last_progress_at,'progressRevision',l.progress_revision,'verifiedAt',l.verified_at,
  'renewalDeadlineAt',l.renewal_deadline_at,'renewalCount',l.renewal_count,'renewedAt',l.renewed_at,'pauseReason',l.pause_reason,'pausedAt',l.paused_at,'nextEligibleAt',l.next_eligible_at,'resumeGraceUntil',l.resume_grace_until)`;
const diagnosticColumns = 'event_id,verification_id,generation,execution_generation,kind,reason_code,actor_id,request_sha256,created_at,lifecycle_revision,archive_id,manifest_sha256,runner_error_code,cleanup_token_sha256,detail_json,result_json';

async function control<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, kind: ControlKind, input: ArchiveStagingControlOperation & { reason?: string; nextEligibleAt?: string }): Promise<ArchiveStagingControlReceipt & { replayed: boolean }> {
  // All caller-controlled primitives are copied and checked before the first await.
  const identity = capturedIdentity(input), operationId = input.operationId, actorId = input.actorId ?? null;
  const reason = input.reason ?? (kind === 'resume' ? 'RESUMED' : 'RENEWED'), nextEligibleAt = input.nextEligibleAt ?? null;
  if (!validId(operationId) || (actorId !== null && !validId(actorId))) fail('INPUT_INVALID');
  if (kind === 'pause') {
    if (!['maintenance', 'daily_budget', 'capacity', 'size_unavailable'].includes(reason) || typeof nextEligibleAt !== 'string' || !Number.isFinite(Date.parse(nextEligibleAt)) || new Date(nextEligibleAt).toISOString() !== nextEligibleAt) fail('INPUT_INVALID');
  } else if (kind === 'renew' && (actorId === null || !/^[A-Z0-9_]{1,64}$/.test(reason))) fail('INPUT_INVALID');
  const request = { kind, ...identity, operationId, actorId, reason, nextEligibleAt };
  const requestSha256 = await hashArchiveControlRequest(request);
  const replay = await db.batch<{ event_id: string | null; request_sha256: string; result_json: string; current_generation: string }>([db.prepare(`SELECT d.event_id,d.request_sha256,d.result_json,h.generation AS current_generation
    FROM history_runtime h LEFT JOIN archive_semantic_diagnostics d ON d.event_id=? WHERE h.id=1`).bind(operationId)]);
  if (replay[0].results[0]?.current_generation !== identity.executionGeneration) fail('STALE');
  if (replay[0].results[0]?.event_id) {
    if (replay[0].results[0].request_sha256 !== requestSha256) fail('OPERATION_CONFLICT');
    return { ...JSON.parse(replay[0].results[0].result_json) as ArchiveStagingControlReceipt, replayed: true };
  }
  const before = await snapshot(db, identity);
  if (before.current_generation !== identity.executionGeneration || identity.generation !== identity.executionGeneration || before.revision !== identity.expectedRevision || !['staging', 'frozen'].includes(before.status)) fail('STALE');
  if (before.active_lease) fail('BUSY');
  const common = `verification_id=? AND generation=? AND revision=? AND EXISTS(SELECT 1 FROM history_runtime h WHERE h.id=1 AND h.generation=?)
    AND EXISTS(SELECT 1 FROM archive_semantic_sessions s WHERE s.verification_id=l.verification_id AND s.generation=l.generation AND s.status IN ('staging','frozen')) AND ${noRunner}`;
  const args = [identity.verificationId, identity.generation, identity.expectedRevision, identity.executionGeneration];
  let update: S;
  if (kind === 'pause') update = db.prepare(`UPDATE archive_semantic_lifecycle AS l SET pause_reason=?,paused_at=${now},next_eligible_at=?,due_at=?,revision=revision+1
    WHERE ${common} AND pause_reason IS NULL AND ?>${now} AND ?<=${renewalCutoff} AND ${renewalCutoff}>${now}`)
    .bind(reason, nextEligibleAt, nextEligibleAt, ...args, nextEligibleAt, nextEligibleAt);
  else if (kind === 'resume') update = db.prepare(`UPDATE archive_semantic_lifecycle AS l SET pause_reason=NULL,paused_at=NULL,next_eligible_at=NULL,
    resume_grace_until=min(${renewalCutoff},strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')),
    due_at=max(coalesce(migration_grace_until,''),min(renewal_deadline_at,max(strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(last_progress_at,admitted_at),'+1 day'),min(${renewalCutoff},strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))))),revision=revision+1
    WHERE ${common} AND pause_reason IS NOT NULL AND next_eligible_at<=${now} AND ${renewalCutoff}>${now}`).bind(...args);
  else update = db.prepare(`UPDATE archive_semantic_lifecycle AS l SET renewed_at=${now},renewal_count=renewal_count+1,renewal_deadline_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+14 days'),
    due_at=CASE WHEN pause_reason IS NOT NULL THEN next_eligible_at ELSE max(coalesce(migration_grace_until,''),min(strftime('%Y-%m-%dT%H:%M:%fZ','now','+14 days'),max(coalesce(resume_grace_until,''),strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(last_progress_at,admitted_at),'+1 day')))) END,revision=revision+1
    WHERE ${common} AND renewal_deadline_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','+14 days')`).bind(...args);
  const receipt = `json_object('operationId',?,'revision',l.revision,'renewalDeadlineAt',l.renewal_deadline_at,'renewalCount',l.renewal_count,
    'pauseReason',l.pause_reason,'pausedAt',l.paused_at,'nextEligibleAt',l.next_eligible_at,'resumeGraceUntil',l.resume_grace_until)`;
  const result = await db.batch<{ result_json: string; applied: number }>([
    update,
    db.prepare(`INSERT INTO archive_semantic_diagnostics(${diagnosticColumns}) SELECT ?,l.verification_id,l.generation,?,?,?, ?,?,${now},l.revision,s.root_archive_id,s.root_manifest_sha256,${runnerErrorSql},NULL,
      json_set(${detailSql},'$.priorRenewalDeadlineAt',?,'$.newRenewalDeadlineAt',l.renewal_deadline_at),${receipt}
      FROM archive_semantic_lifecycle l JOIN archive_semantic_sessions s USING(verification_id,generation)
      WHERE changes()=1 AND l.verification_id=? AND l.generation=? AND l.revision=?`)
      .bind(operationId, identity.executionGeneration, kind, reason.toUpperCase(), actorId, requestSha256, before.renewal_deadline_at, operationId, identity.verificationId, identity.generation, identity.expectedRevision + 1),
    db.prepare(`SELECT d.result_json,changes() AS applied FROM archive_semantic_diagnostics d JOIN history_runtime h ON h.id=1 AND h.generation=?
      WHERE d.event_id=? AND d.request_sha256=? AND d.execution_generation=h.generation`).bind(identity.executionGeneration, operationId, requestSha256),
  ]);
  const applied = result[2].results[0]; if (!applied) fail('STALE');
  return { ...JSON.parse(applied.result_json) as ArchiveStagingControlReceipt, replayed: applied.applied === 0 };
}
export function pauseArchiveStaging<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, input: ArchiveStagingControlOperation & { reason: ArchiveStagingPauseReason; nextEligibleAt: string }) { return control(db, 'pause', input); }
export function resumeArchiveStaging<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, input: ArchiveStagingControlOperation) { return control(db, 'resume', input); }
export function renewArchiveStaging<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, input: ArchiveStagingControlOperation & { actorId: string; reason: string }) { return control(db, 'renew', input); }

export async function claimArchiveStagingCleanup<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, input: ArchiveSemanticHandle): Promise<ArchiveSemanticCleanup> {
  const identity = Object.freeze({ verificationId: input.verificationId, generation: input.generation });
  if (!Object.values(identity).every(validId)) fail('IDENTITY_INVALID');
  const before = await snapshot(db, identity);
  if (before.status !== 'invalid') fail('STALE');
  if (before.active_lease) fail('BUSY');
  const handle = Object.freeze({ ...identity, cleanupGeneration: before.current_generation, cleanupToken: crypto.randomUUID() });
  const receipt = await archiveCleanupReceiptIdentity(handle, 'cleanup_claim');
  const result = await db.batch<{ cleanup_generation: string }>([
    db.prepare(`UPDATE archive_semantic_sessions AS s SET cleanup_generation=?,cleanup_token=? WHERE verification_id=? AND generation=? AND status='invalid'
      AND EXISTS(SELECT 1 FROM history_runtime h JOIN archive_semantic_lifecycle l ON l.verification_id=s.verification_id AND l.generation=s.generation
        WHERE h.id=1 AND h.generation=? AND l.revision=? AND ${noRunner} AND (s.cleanup_generation IS NOT h.generation OR l.cleanup_lease_until IS NULL OR l.cleanup_lease_until<=${now}))`)
      .bind(handle.cleanupGeneration, handle.cleanupToken, identity.verificationId, identity.generation, handle.cleanupGeneration, before.revision),
    db.prepare(`UPDATE archive_semantic_lifecycle AS l SET cleanup_lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),due_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),revision=revision+1
      WHERE verification_id=? AND generation=? AND revision=? AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
        WHERE s.verification_id=l.verification_id AND s.generation=l.generation AND s.status='invalid' AND s.cleanup_token=? AND s.cleanup_generation=?)`)
      .bind(identity.verificationId, identity.generation, before.revision, handle.cleanupToken, handle.cleanupGeneration),
    db.prepare(`INSERT INTO archive_semantic_diagnostics(${diagnosticColumns}) SELECT ?,l.verification_id,l.generation,?,'cleanup_claim','CLEANUP_CLAIMED',NULL,?,${now},l.revision,s.root_archive_id,s.root_manifest_sha256,${runnerErrorSql},?,${detailSql},?
      FROM archive_semantic_lifecycle l JOIN archive_semantic_sessions s USING(verification_id,generation)
      WHERE changes()=1 AND l.verification_id=? AND l.generation=? AND l.revision=? AND s.cleanup_generation=? AND s.cleanup_token=?`)
      .bind(receipt.eventId, handle.cleanupGeneration, receipt.requestSha256, receipt.tokenSha256, encodeArchiveControlJson({ claimed: true, revision: before.revision + 1 }), identity.verificationId, identity.generation, before.revision + 1, handle.cleanupGeneration, handle.cleanupToken),
    db.prepare(`SELECT s.cleanup_generation FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation) JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
      WHERE s.verification_id=? AND s.generation=? AND s.cleanup_token=? AND l.cleanup_lease_until>${now}
        AND EXISTS(SELECT 1 FROM archive_semantic_diagnostics d WHERE d.event_id=? AND d.request_sha256=?)`)
      .bind(identity.verificationId, identity.generation, handle.cleanupToken, receipt.eventId, receipt.requestSha256),
  ]);
  if (!result[3].results.length) fail('BUSY');
  return handle;
}

export interface ArchiveStagingExpiryCandidate extends ArchiveStagingControlIdentity { dueAt: string }
export async function readNextArchiveStagingExpiry<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>): Promise<ArchiveStagingExpiryCandidate | null> {
  const result = await db.batch<{ verification_id: string; generation: string; current_generation: string; revision: number; due_at: string }>([db.prepare(`SELECT l.verification_id,l.generation,l.revision,l.due_at,h.generation AS current_generation
    FROM archive_semantic_lifecycle l INDEXED BY archive_semantic_lifecycle_due JOIN archive_semantic_sessions s USING(verification_id,generation) JOIN history_runtime h ON h.id=1
    WHERE l.due_at<=${now} AND s.status!='invalid' ORDER BY l.due_at,l.verification_id,l.generation LIMIT 1`)]);
  const row = result[0].results[0]; return row ? { verificationId: row.verification_id, generation: row.generation, executionGeneration: row.current_generation, expectedRevision: row.revision, dueAt: row.due_at } : null;
}
export async function expireArchiveStaging<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, input: ArchiveStagingExpiryCandidate): Promise<{ status: 'expired' | 'stale' | 'busy' | 'resume_due' }> {
  const identity = capturedIdentity(input), dueAt = input.dueAt;
  if (typeof dueAt !== 'string' || !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString() !== dueAt) fail('INPUT_INVALID');
  const before = await snapshot(db, identity);
  if (before.current_generation !== identity.executionGeneration || before.generation !== identity.executionGeneration || before.revision !== identity.expectedRevision || before.due_at !== dueAt || before.status === 'invalid') return { status: 'stale' };
  if (before.active_lease) return { status: 'busy' };
  const eventId = crypto.randomUUID(), requestSha256 = await hashArchiveControlRequest({ kind: 'expired', ...identity, dueAt });
  const result = await db.batch<{ event_id: string }>([
    db.prepare(`UPDATE archive_semantic_sessions AS s SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL
      WHERE verification_id=? AND generation=? AND status!='invalid' AND EXISTS(SELECT 1 FROM history_runtime h JOIN archive_semantic_lifecycle l ON l.verification_id=s.verification_id AND l.generation=s.generation
        WHERE h.id=1 AND h.generation=? AND l.generation=h.generation AND l.revision=? AND l.due_at=? AND l.due_at<=${now} AND ${noRunner}
          AND (l.pause_reason IS NULL OR ${renewalCutoff}<=${now}))`).bind(identity.verificationId, identity.generation, identity.executionGeneration, identity.expectedRevision, dueAt),
    db.prepare(`INSERT INTO archive_semantic_diagnostics(${diagnosticColumns}) SELECT ?,l.verification_id,l.generation,?,'expired','STAGING_EXPIRED',NULL,?,${now},l.revision,s.root_archive_id,s.root_manifest_sha256,${runnerErrorSql},NULL,${detailSql},json_object('status','expired','revision',l.revision)
      FROM archive_semantic_lifecycle l JOIN archive_semantic_sessions s USING(verification_id,generation) WHERE changes()=1 AND l.verification_id=? AND l.generation=? AND l.revision=?`)
      .bind(eventId, identity.executionGeneration, requestSha256, identity.verificationId, identity.generation, identity.expectedRevision + 1),
    db.prepare(`UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL,updated_at=${now}
      WHERE verification_id=? AND generation=? AND status!='invalid' AND EXISTS(SELECT 1 FROM archive_semantic_diagnostics WHERE event_id=? AND request_sha256=?)`)
      .bind(identity.verificationId, identity.generation, eventId, requestSha256),
    db.prepare('SELECT event_id FROM archive_semantic_diagnostics WHERE event_id=? AND request_sha256=?').bind(eventId, requestSha256),
  ]);
  if (result[3].results.length) return { status: 'expired' };
  const after = await snapshot(db, identity);
  if (after.current_generation === identity.executionGeneration && after.generation === identity.executionGeneration && after.revision === identity.expectedRevision
    && after.due_at === dueAt && after.due_at <= after.clock_now && after.pause_reason !== null && ['staging', 'frozen'].includes(after.status)
    && !after.active_lease && (after.renewal_deadline_at > after.clock_now || (after.migration_grace_until ?? '') > after.clock_now)) return { status: 'resume_due' };
  return { status: 'stale' };
}
