import { CONTROL_TERMINAL_TAIL, issueArchiveBudgetControlGrant, type ArchiveBudgetControlGrant } from './archive-budget-control-usage';
import { issueArchiveBudgetDispatchGrant, type ArchiveBudgetDispatchGrant } from './archive-budget-dispatch-grant';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import { digest } from './backup-crypto';
import { issueArchiveBudgetExecutionGrant, readArchiveBudgetUsage, type ArchiveBudgetCost } from './archive-budget-usage';

/** Internal primitives only. Account allocation and cost envelopes are trusted policy inputs.
 * No archive operation or scheduler uses this ledger yet. */
export type ArchiveBudgetPool = 'work' | 'cleanup' | 'control';
export interface ArchiveBudgetIdentity { epochId: string; executionGeneration: string; utcDay: string }
export interface ArchiveBudgetOperation extends ArchiveBudgetIdentity { operationId: string }
export interface ArchiveBudgetExecutionIdentity extends ArchiveBudgetIdentity {
  attemptId: string; executionTokenSha256: string; envelope: ArchiveBudgetCost; maximumStatements: number;
}
export type ArchiveBudgetClaimTarget = Readonly<{ workKeySha256: string; targetRevision: number; envelope: ArchiveBudgetCost; maximumStatements: number }>;
export interface ArchiveBudgetReceipt { operationId: string; kind: string; result: Record<string, unknown>; replayed: boolean }
type Database<S extends ArchiveStagingStatement<S>> = ArchiveStagingDatabase<S>;
type Runtime = { epoch_id: string; execution_generation: string; state: string; current_day: string | null; revision: number; close_reason: string | null; dispatchBlocked: boolean; pendingControlOwner: string | null };
type Attempt = {
  attempt_id: string; epoch_id: string; execution_generation: string; utc_day: string; state: string; revision: number;
  reads_envelope: number; writes_envelope: number; maximum_statements: number; execution_token_sha256: string | null;
};
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const today = "strftime('%Y-%m-%d','now')";
const maxPolicyCost = 1_000_000_000_000;
const encoder = new TextEncoder();
function fail(code: string): never { throw new Error(`ARCHIVE_BUDGET_${code}`); }
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INPUT_INVALID'); return value; }
function sha(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INPUT_INVALID'); return value; }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail('INPUT_INVALID'); return value; }
function day(value: unknown): string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('INPUT_INVALID'); return value; }
function reason(value: unknown): string { if (typeof value !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(value)) fail('INPUT_INVALID'); return value; }
function cost(value: ArchiveBudgetCost): ArchiveBudgetCost { return Object.freeze({ reads: integer(value?.reads, maxPolicyCost), writes: integer(value?.writes, maxPolicyCost) }); }
function operation(input: ArchiveBudgetOperation): ArchiveBudgetOperation { return Object.freeze({ operationId: id(input.operationId), epochId: id(input.epochId), executionGeneration: id(input.executionGeneration), utcDay: day(input.utcDay) }); }
function json(value: unknown): string { const text = JSON.stringify(value); if (!text || encoder.encode(text).length > 4096) fail('JSON_BOUND'); return text; }
const hash = (value: unknown): Promise<string> => digest(encoder.encode(json(value)));

async function replay<S extends ArchiveStagingStatement<S>>(db: Database<S>, op: ArchiveBudgetOperation, requestSha256: string, opening = false): Promise<ArchiveBudgetReceipt | null> {
  const result = await db.batch<{ kind: string | null; result_json: string; request_sha256: string; epoch_id: string; execution_generation: string; current_generation: string; current_epoch: string; utc_day: string }>([
    db.prepare(`SELECT r.kind,r.result_json,r.request_sha256,r.epoch_id,r.execution_generation,h.generation AS current_generation,b.epoch_id AS current_epoch,${today} AS utc_day
      FROM archive_budget_runtime b JOIN history_runtime h ON h.id=1 LEFT JOIN archive_budget_receipts r ON r.operation_id=? WHERE b.id=1`).bind(op.operationId),
  ]);
  const row = result[0].results[0];
  if (!row || row.current_generation !== op.executionGeneration || row.utc_day !== op.utcDay || (!opening && row.current_epoch !== op.epochId)) fail('STALE');
  if (!row.kind) return null;
  if (row.request_sha256 !== requestSha256) fail('OPERATION_CONFLICT');
  if (row.epoch_id !== row.current_epoch || row.execution_generation !== row.current_generation) fail('STALE');
  return { operationId: op.operationId, kind: row.kind, result: JSON.parse(row.result_json) as Record<string, unknown>, replayed: true };
}

function insertReceipt<S extends ArchiveStagingStatement<S>>(db: Database<S>, kind: string, op: ArchiveBudgetOperation, requestSha256: string, attemptId: string | null, result: unknown): S {
  return db.prepare(`INSERT INTO archive_budget_receipts(operation_id,request_sha256,kind,attempt_id,utc_day,epoch_id,execution_generation,result_json,created_at)
    SELECT ?,?,?,?,?,?,?,?,${now} WHERE changes()=1`).bind(op.operationId, requestSha256, kind, attemptId, op.utcDay, op.epochId, op.executionGeneration, json(result));
}
function selectReceipt<S extends ArchiveStagingStatement<S>>(db: Database<S>, op: ArchiveBudgetOperation, requestSha256: string): S {
  return db.prepare(`SELECT r.kind,r.result_json,changes() AS applied FROM archive_budget_receipts r JOIN archive_budget_runtime b ON b.id=1 AND b.epoch_id=r.epoch_id
    JOIN history_runtime h ON h.id=1 AND h.generation=r.execution_generation WHERE r.operation_id=? AND r.request_sha256=? AND r.epoch_id=? AND r.execution_generation=? AND r.utc_day=${today}`)
    .bind(op.operationId, requestSha256, op.epochId, op.executionGeneration);
}
type Applied = { kind: string; result_json: string; applied: number };
function fromApplied(row: Applied | undefined, op: ArchiveBudgetOperation): ArchiveBudgetReceipt {
  if (!row) fail('STALE');
  return { operationId: op.operationId, kind: row.kind, result: JSON.parse(row.result_json) as Record<string, unknown>, replayed: row.applied === 0 };
}
async function attempt<S extends ArchiveStagingStatement<S>>(db: Database<S>, attemptId: string): Promise<Attempt> {
  const found = await db.batch<Attempt>([db.prepare('SELECT * FROM archive_budget_attempts WHERE attempt_id=?').bind(attemptId)]);
  if (!found[0].results[0]) fail('STALE');
  return found[0].results[0];
}

export async function openArchiveBudgetDay<S extends ArchiveStagingStatement<S>>(db: Database<S>, input: ArchiveBudgetOperation & {
  expectedRevision: number; scopeId: string; policyVersion: string; envelopeVersion: string; allocationSha256: string;
  actorId: string; reasonCode: string; pools: Record<ArchiveBudgetPool, ArchiveBudgetCost>; bootstrap: ArchiveBudgetCost;
}): Promise<ArchiveBudgetReceipt> {
  const op = operation(input), expectedRevision = integer(input.expectedRevision), scopeId = id(input.scopeId), policyVersion = id(input.policyVersion), envelopeVersion = id(input.envelopeVersion);
  const allocationSha256 = sha(input.allocationSha256), actorId = id(input.actorId), reasonCode = reason(input.reasonCode);
  const pools = Object.freeze({ work: cost(input.pools.work), cleanup: cost(input.pools.cleanup), control: cost(input.pools.control) }), bootstrap = cost(input.bootstrap);
  if (bootstrap.reads > pools.control.reads || bootstrap.writes > pools.control.writes) fail('CONTROL_EXHAUSTED');
  const requestSha256 = await hash({ kind: 'open', ...op, expectedRevision, scopeId, policyVersion, envelopeVersion, allocationSha256, actorId, reasonCode, pools, bootstrap });
  const prior = await replay(db, op, requestSha256, true); if (prior) return prior;
  const statements: S[] = [db.prepare(`INSERT INTO archive_budget_days(utc_day,scope_id,epoch_id,execution_generation,policy_version,envelope_version,allocation_sha256,actor_id,reason_code,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,${now} WHERE EXISTS(SELECT 1 FROM archive_budget_runtime WHERE id=1 AND revision=? AND execution_generation=?)`)
    .bind(op.utcDay, scopeId, op.epochId, op.executionGeneration, policyVersion, envelopeVersion, allocationSha256, actorId, reasonCode, expectedRevision, op.executionGeneration)];
  for (const pool of ['work', 'cleanup', 'control'] as const) statements.push(db.prepare(`INSERT INTO archive_budget_pools(utc_day,pool,allocated_reads,allocated_writes,charged_reads,charged_writes)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM archive_budget_days WHERE utc_day=? AND epoch_id=?) AND EXISTS(SELECT 1 FROM archive_budget_runtime WHERE id=1 AND revision=?)`)
    .bind(op.utcDay, pool, pools[pool].reads, pools[pool].writes, pool === 'control' ? bootstrap.reads : 0, pool === 'control' ? bootstrap.writes : 0, op.utcDay, op.epochId, expectedRevision));
  statements.push(db.prepare(`UPDATE archive_budget_runtime SET state='open',epoch_id=?,scope_id=?,current_day=?,close_reason=NULL,revision=revision+1 WHERE id=1 AND revision=? AND execution_generation=?
    AND EXISTS(SELECT 1 FROM archive_budget_days WHERE utc_day=? AND epoch_id=?)`).bind(op.epochId, scopeId, op.utcDay, expectedRevision, op.executionGeneration, op.utcDay, op.epochId));
  statements.push(insertReceipt(db, 'open', op, requestSha256, null, { state: 'open', epochId: op.epochId, utcDay: op.utcDay, revision: expectedRevision + 1 }), selectReceipt(db, op, requestSha256));
  const results = await db.batch<Applied>(statements);
  return fromApplied(results.at(-1)?.results[0], op);
}

export async function reserveArchiveBudgetAttempt<S extends ArchiveStagingStatement<S>>(db: Database<S>, input: ArchiveBudgetOperation & {
  attemptId: string; pool: ArchiveBudgetPool; workKeySha256: string; targetRevision: number; envelope: ArchiveBudgetCost; overhead: ArchiveBudgetCost; maximumStatements: number;
}): Promise<ArchiveBudgetReceipt & { dispatchGrant?: ArchiveBudgetDispatchGrant; controlGrant?: ArchiveBudgetControlGrant }> {
  const op = operation(input), attemptId = id(input.attemptId), pool = input.pool, workKeySha256 = sha(input.workKeySha256), targetRevision = integer(input.targetRevision);
  const envelope = cost(input.envelope), overhead = cost(input.overhead), maximumStatements = integer(input.maximumStatements, 40);
  if (!['work', 'cleanup', 'control'].includes(pool) || maximumStatements < 2) fail('INPUT_INVALID');
  if (overhead.reads < CONTROL_TERMINAL_TAIL.reads || overhead.writes < CONTROL_TERMINAL_TAIL.writes) fail('CONTROL_TAIL_UNFUNDED');
  const requestSha256 = await hash({ kind: 'reserve', ...op, attemptId, pool, workKeySha256, targetRevision, envelope, overhead, maximumStatements });
  const prior = await replay(db, op, requestSha256); if (prior) return prior;
  const results = await db.batch<Applied>([
    db.prepare(`INSERT INTO archive_budget_attempts(attempt_id,utc_day,epoch_id,execution_generation,pool,request_sha256,work_key_sha256,target_revision,reads_envelope,writes_envelope,overhead_reads,overhead_writes,maximum_statements,state,reserved_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',${now} WHERE NOT EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=?)`)
      .bind(attemptId, op.utcDay, op.epochId, op.executionGeneration, pool, requestSha256, workKeySha256, targetRevision, envelope.reads, envelope.writes, overhead.reads, overhead.writes, maximumStatements, op.operationId),
    insertReceipt(db, 'reserve', op, requestSha256, attemptId, { attemptId, state: 'reserved', revision: 0 }), selectReceipt(db, op, requestSha256),
  ]);
  const receipt = fromApplied(results[2].results[0], op);
  return receipt.replayed ? receipt : { ...receipt, controlGrant: issueArchiveBudgetControlGrant(db, { attemptId, epochId: op.epochId, executionGeneration: op.executionGeneration, utcDay: op.utcDay, prepaid: overhead }), dispatchGrant: issueArchiveBudgetDispatchGrant(db, {
    reservationOperationId: op.operationId, attemptId, epochId: op.epochId, executionGeneration: op.executionGeneration,
    utcDay: op.utcDay, pool, workKeySha256, targetRevision, envelope, overhead, maximumStatements,
  }) };
}

/** Use this predicate inside each work transaction. A preceding read is not authority. */
export function archiveBudgetExecutionPredicate(input: ArchiveBudgetExecutionIdentity): { sql: string; bindings: string[] } {
  const attemptId = id(input.attemptId), epochId = id(input.epochId), executionGeneration = id(input.executionGeneration), utcDay = day(input.utcDay), tokenSha256 = sha(input.executionTokenSha256);
  return { sql: `EXISTS(SELECT 1 FROM archive_budget_attempts a JOIN archive_budget_runtime b ON b.id=1 AND b.epoch_id=a.epoch_id
    JOIN history_runtime h ON h.id=1 AND h.generation=a.execution_generation WHERE a.attempt_id=? AND a.epoch_id=? AND a.execution_generation=? AND a.utc_day=?
      AND a.execution_token_sha256=? AND a.state='executing' AND EXISTS(SELECT 1 FROM archive_budget_controls c WHERE c.attempt_id=a.attempt_id AND c.state='pending' AND c.epoch_id=a.epoch_id AND c.execution_generation=a.execution_generation AND c.utc_day=a.utc_day) AND b.state='open' AND b.execution_generation=a.execution_generation AND h.state='ready'
      AND b.current_day=a.utc_day AND a.utc_day=${today} AND NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>${now}))`,
    bindings: [attemptId, epochId, executionGeneration, utcDay, tokenSha256] };
}
/** An invalid fence throws inside native D1.batch, rolling back every work statement.
 * The deliberately invalid JSON expression is evaluated only on the rejected branch. */
export function archiveBudgetExecutionFence<S extends ArchiveStagingStatement<S>>(db: Database<S>, identity: ArchiveBudgetExecutionIdentity): S {
  const guard = archiveBudgetExecutionPredicate(identity);
  return db.prepare(`SELECT CASE WHEN ${guard.sql} THEN 1 ELSE json_extract('ARCHIVE_BUDGET_EXECUTION_STALE','$') END AS archive_budget_allowed`).bind(...guard.bindings);
}
export async function assertArchiveBudgetExecution<S extends ArchiveStagingStatement<S>>(db: Database<S>, identity: ArchiveBudgetExecutionIdentity): Promise<void> {
  await db.batch([archiveBudgetExecutionFence(db, identity)]);
}

export async function claimArchiveBudgetAttempt<S extends ArchiveStagingStatement<S>>(db: Database<S>, input: ArchiveBudgetOperation & { attemptId: string; expectedRevision: number; expectedWork?: ArchiveBudgetClaimTarget }): Promise<ArchiveBudgetReceipt & { grant?: ReturnType<typeof issueArchiveBudgetExecutionGrant> }> {
  const op = operation(input), attemptId = id(input.attemptId), expectedRevision = integer(input.expectedRevision);
  const expectedWork = input.expectedWork ? Object.freeze({ workKeySha256: sha(input.expectedWork.workKeySha256), targetRevision: integer(input.expectedWork.targetRevision), envelope: cost(input.expectedWork.envelope), maximumStatements: integer(input.expectedWork.maximumStatements, 40) }) : undefined;
  if (expectedWork && expectedWork.maximumStatements < 2) fail('INPUT_INVALID');
  const requestSha256 = await hash({ kind: 'claim', ...op, attemptId, expectedRevision, ...(expectedWork ? { expectedWork } : {}) });
  const prior = await replay(db, op, requestSha256); if (prior) return prior;
  const before = await attempt(db, attemptId);
  const tokenSha256 = await digest(encoder.encode(crypto.randomUUID()));
  const results = await db.batch<Applied>([
    db.prepare(`UPDATE archive_budget_attempts SET state='executing',execution_token_sha256=?,claimed_at=${now},revision=revision+1
      WHERE attempt_id=? AND epoch_id=? AND execution_generation=? AND utc_day=? AND revision=? AND state='reserved'
      AND NOT EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=?)
      ${expectedWork ? 'AND work_key_sha256=? AND target_revision=? AND reads_envelope=? AND writes_envelope=? AND maximum_statements=?' : ''}`)
      .bind(tokenSha256, attemptId, op.epochId, op.executionGeneration, op.utcDay, expectedRevision, op.operationId,
        ...(expectedWork ? [expectedWork.workKeySha256, expectedWork.targetRevision, expectedWork.envelope.reads, expectedWork.envelope.writes, expectedWork.maximumStatements] : [])),
    insertReceipt(db, 'claim', op, requestSha256, attemptId, { attemptId, state: 'executing', revision: expectedRevision + 1 }), selectReceipt(db, op, requestSha256),
  ]);
  const receipt = fromApplied(results[2].results[0], op);
  if (receipt.replayed) return receipt;
  const identity: ArchiveBudgetExecutionIdentity = { ...op, attemptId, executionTokenSha256: tokenSha256, envelope: { reads: before.reads_envelope, writes: before.writes_envelope }, maximumStatements: before.maximum_statements };
  return { ...receipt, grant: issueArchiveBudgetExecutionGrant(identity, archiveBudgetExecutionFence) };
}

export async function settleArchiveBudgetAttempt<S extends ArchiveStagingStatement<S>>(db: Database<S>, input: { operationId: string; usage: unknown }): Promise<ArchiveBudgetReceipt> {
  const operationId = id(input.operationId), usage = readArchiveBudgetUsage(input.usage);
  const op = operation({ operationId, epochId: usage.epochId, executionGeneration: usage.executionGeneration, utcDay: usage.utcDay });
  const attemptId = id(usage.attemptId), tokenSha256 = sha(usage.executionTokenSha256), envelope = cost(usage.envelope);
  const observedReads = integer(usage.rowsRead), observedWrites = integer(usage.rowsWritten), complete = usage.coverageComplete;
  const chargeReads = complete ? observedReads : Math.max(envelope.reads, observedReads), chargeWrites = complete ? observedWrites : Math.max(envelope.writes, observedWrites);
  const state = complete ? 'settled' : 'unknown';
  const requestSha256 = await hash({ kind: 'settle', ...op, attemptId, tokenSha256, envelope, observedReads, observedWrites, complete, maximumStatements: usage.maximumStatements, statementCount: usage.statementCount });
  const prior = await replay(db, op, requestSha256); if (prior) return prior;
  const results = await db.batch<Applied>([
    db.prepare(`UPDATE archive_budget_attempts SET state=?,execution_token_sha256=NULL,settled_at=${now},observed_reads=?,observed_writes=?,charge_reads=?,charge_writes=?,settle_operation_id=?,unknown_reason=?,revision=revision+1
      WHERE attempt_id=? AND epoch_id=? AND execution_generation=? AND utc_day=? AND state='executing' AND execution_token_sha256=?
      AND reads_envelope=? AND writes_envelope=? AND maximum_statements=? AND NOT EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=?)`)
      .bind(state, observedReads, observedWrites, chargeReads, chargeWrites, operationId, complete ? null : 'INCOMPLETE_USAGE', attemptId, op.epochId, op.executionGeneration, op.utcDay, tokenSha256, envelope.reads, envelope.writes, usage.maximumStatements, operationId),
    insertReceipt(db, 'settle', op, requestSha256, attemptId, { attemptId, state, observed: { reads: observedReads, writes: observedWrites }, charged: { reads: chargeReads, writes: chargeWrites } }), selectReceipt(db, op, requestSha256),
  ]);
  return fromApplied(results[2].results[0], op);
}

export async function abandonArchiveBudgetAttempt<S extends ArchiveStagingStatement<S>>(db: Database<S>, input: ArchiveBudgetOperation & { attemptId: string; expectedRevision: number; reasonCode: string }): Promise<ArchiveBudgetReceipt> {
  const op = operation(input), attemptId = id(input.attemptId), expectedRevision = integer(input.expectedRevision), reasonCode = reason(input.reasonCode);
  const requestSha256 = await hash({ kind: 'abandon', ...op, attemptId, expectedRevision, reasonCode });
  const prior = await replay(db, op, requestSha256); if (prior) return prior;
  const before = await attempt(db, attemptId);
  const results = await db.batch<Applied>([
    db.prepare(`UPDATE archive_budget_attempts SET state='unknown',execution_token_sha256=NULL,settled_at=${now},charge_reads=reads_envelope,charge_writes=writes_envelope,settle_operation_id=?,unknown_reason=?,revision=revision+1
      WHERE attempt_id=? AND epoch_id=? AND execution_generation=? AND utc_day=? AND revision=? AND state IN ('reserved','executing')
      AND NOT EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=?)`).bind(op.operationId, reasonCode, attemptId, op.epochId, op.executionGeneration, op.utcDay, expectedRevision, op.operationId),
    insertReceipt(db, 'abandon', op, requestSha256, attemptId, { attemptId, state: 'unknown', charged: { reads: before.reads_envelope, writes: before.writes_envelope }, reasonCode }), selectReceipt(db, op, requestSha256),
  ]);
  return fromApplied(results[2].results[0], op);
}

export async function closeArchiveBudgetEpoch<S extends ArchiveStagingStatement<S>>(db: Database<S>, input: ArchiveBudgetOperation & { expectedRevision: number; reasonCode: string }): Promise<ArchiveBudgetReceipt> {
  const op = operation(input), expectedRevision = integer(input.expectedRevision), reasonCode = reason(input.reasonCode);
  const requestSha256 = await hash({ kind: 'close', ...op, expectedRevision, reasonCode });
  const prior = await replay(db, op, requestSha256); if (prior) return prior;
  const results = await db.batch<Applied>([
    db.prepare(`UPDATE archive_budget_runtime SET state='closed',close_reason='operator_closed',revision=revision+1 WHERE id=1 AND state='open' AND epoch_id=? AND execution_generation=? AND current_day=? AND revision=?
      AND NOT EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=?)`).bind(op.epochId, op.executionGeneration, op.utcDay, expectedRevision, op.operationId),
    insertReceipt(db, 'close', op, requestSha256, null, { state: 'closed', reasonCode, revision: expectedRevision + 1 }), selectReceipt(db, op, requestSha256),
  ]);
  return fromApplied(results[2].results[0], op);
}

export async function readArchiveBudgetRuntime<S extends ArchiveStagingStatement<S>>(db: Database<S>): Promise<Runtime> {
  const result = await db.batch<Runtime & { control_blocked: number }>([db.prepare(`SELECT b.*,
    (b.state!='open' OR b.current_day IS NOT strftime('%Y-%m-%d','now') OR b.execution_generation IS NOT h.generation OR h.state!='ready'
      OR EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR EXISTS(SELECT 1 FROM archive_budget_controls WHERE state IN ('pending','unknown','overrun','legacy_unresolved'))) AS control_blocked,
    (SELECT attempt_id FROM archive_budget_controls WHERE state='pending' ORDER BY attempt_id LIMIT 1) AS pendingControlOwner
    FROM archive_budget_runtime b JOIN history_runtime h ON h.id=1 WHERE b.id=1`)]);
  const row = result[0].results[0];
  if (!row) fail('STALE');
  const { control_blocked, ...runtime } = row;
  return { ...runtime, dispatchBlocked: control_blocked === 1 };
}
