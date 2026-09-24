import { digest } from './backup-crypto';
import { claimArchiveBudgetAttempt, reserveArchiveBudgetAttempt, settleArchiveBudgetAttempt, type ArchiveBudgetReceipt } from './archive-budget-ledger';
import { takeArchiveBudgetDispatchGrant } from './archive-budget-dispatch-grant';
import { createArchiveBudgetUsage, readArchiveBudgetUsage, type ArchiveBudgetCost, type ArchiveBudgetUsageEvidence } from './archive-budget-usage';
import { advanceMonthlySemanticVerification, type MonthlySemanticAdvance, type MonthlySemanticRunHandle, type MonthlySemanticRunSelection } from './archive-semantic-runner';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import { createArchiveBudgetInvocation, CONTROL_TERMINAL_TAIL, type ArchiveBudgetControlGrant, type ArchiveBudgetInvocationMetrics } from './archive-budget-control-usage';
import { finalizeArchiveBudgetControl } from './archive-budget-control-store';

export const BUDGETED_MONTHLY_STEP_LIMITS = Object.freeze({ statements: 40, workStatements: 26 });
export type BudgetedMonthlyTarget = Readonly<{ handle: MonthlySemanticRunHandle; selection: MonthlySemanticRunSelection }>;
export type BudgetedMonthlyReservation = Omit<Parameters<typeof reserveArchiveBudgetAttempt>[1], 'workKeySha256' | 'targetRevision' | 'maximumStatements'>;
export type BudgetedMonthlyStepInput = Readonly<{
  target: BudgetedMonthlyTarget;
  policyVersion: string;
  reservation: BudgetedMonthlyReservation;
  claimOperationId: string;
  settleOperationId: string;
 controlOperationId: string;
}>;
export type BudgetedMonthlyMetrics = ArchiveBudgetInvocationMetrics;
export type BudgetedMonthlyStepResult = Readonly<{
 status: 'advanced' | 'paused' | 'busy' | 'replayed' | 'stopped';
 advance?: MonthlySemanticAdvance;
 failureCode?: string;
 receipt?: ArchiveBudgetReceipt;
 controlReceipt?: ArchiveBudgetReceipt;
 statementCount: number;
 accounting: Readonly<{
  control: BudgetedMonthlyMetrics;
  work: BudgetedMonthlyMetrics;
  terminal: BudgetedMonthlyMetrics;
  prepaidControl: ArchiveBudgetCost | null;
  prepaidTerminalTail: typeof CONTROL_TERMINAL_TAIL | null;
  controlStatus: 'prefix_observed_tail_prepaid' | 'unresolved';
  workEvidence?: ArchiveBudgetUsageEvidence;
 }>;
}>;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const fail = (code: string): never => { throw new Error(`ARCHIVE_BUDGET_RUN_${code}`); };

function captureTarget(input: BudgetedMonthlyTarget): BudgetedMonthlyTarget {
  const handle = Object.freeze({ runId: input?.handle?.runId, verificationId: input?.handle?.verificationId, generation: input?.handle?.generation, commitToken: input?.handle?.commitToken, graphSha256: input?.handle?.graphSha256 });
  const selection = Object.freeze({ revision: input?.selection?.revision, phase: input?.selection?.phase });
  if (![handle.runId, handle.verificationId, handle.generation, handle.commitToken].every(identifier) || typeof handle.graphSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(handle.graphSha256) || !nonnegative(selection.revision) || !['records','visits','reviews','complete'].includes(selection.phase)) fail('TARGET_INVALID');
  return Object.freeze({ handle, selection });
}
export async function monthlyBudgetWorkKey(target: BudgetedMonthlyTarget, policyVersion: string): Promise<string> {
  const copy = captureTarget(target); if (!identifier(policyVersion)) fail('POLICY_INVALID');
  return digest(new TextEncoder().encode(JSON.stringify({ kind: 'monthly-semantic-step-v1', policyVersion, handle: copy.handle, selection: copy.selection })));
}
function failureCode(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  const semantic = /^Invalid historical evidence: ([A-Z_]+)$/.exec(text);
  if (semantic) return `INVALID_HISTORICAL_EVIDENCE_${semantic[1]}`;
  const match = /\b(ARCHIVE_(?:BUDGET(?:_USAGE|_RUN|_CONTROL)?|SEMANTIC_RUN|SEMANTIC|STAGING)_[A-Z_]+)\b/.exec(text);
  return match?.[1] ?? (text.includes('backup_maintenance') ? 'BACKUP_MAINTENANCE' : 'NATIVE_FAILURE');
}

/** Internal only: reserve, claim, advance the selected step, settle work and persist
 * control observations. No caller-supplied receipt can authorize runner execution.
 * The terminal tail is prepaid under a versioned bound; it is not observed prefix. */
export async function reserveAndAdvanceBudgetedMonthlyVerification<S extends ArchiveStagingStatement<S>>(database: ArchiveStagingDatabase<S>, input: BudgetedMonthlyStepInput): Promise<BudgetedMonthlyStepResult> {
 const target = captureTarget(input.target), policyVersion = input.policyVersion;
 const reservation = Object.freeze({ ...input.reservation, envelope: Object.freeze({ ...input.reservation.envelope }), overhead: Object.freeze({ ...input.reservation.overhead }) });
 const claimOperationId = input.claimOperationId, settleOperationId = input.settleOperationId, controlOperationId = input.controlOperationId;
 if (![policyVersion, claimOperationId, settleOperationId, controlOperationId].every(identifier) || reservation.pool !== 'work'
   || new Set([reservation.operationId, claimOperationId, settleOperationId, controlOperationId]).size !== 4) fail('INPUT_INVALID');
 const db = createArchiveBudgetInvocation(database), workKeySha256 = await monthlyBudgetWorkKey(target, policyVersion);
 let workEvidence: ArchiveBudgetUsageEvidence | undefined, controlGrant: ArchiveBudgetControlGrant | undefined;
 let controlReceipt: ArchiveBudgetReceipt | undefined;
 let controlPrepaid = false, terminalAttempted = false;
 const controlCovered = () => {
  const value = db.metrics('control');
  return value.coverageComplete && value.rowsRead <= reservation.overhead.reads - CONTROL_TERMINAL_TAIL.reads
   && value.rowsWritten <= reservation.overhead.writes - CONTROL_TERMINAL_TAIL.writes;
 };
 const sanitize = (receipt: ArchiveBudgetReceipt) => Object.freeze({ operationId: receipt.operationId, kind: receipt.kind, result: receipt.result, replayed: receipt.replayed });
 const terminalCovered = () => {
  const value = db.metrics('terminal');
  return value.statements === 1 && value.coverageComplete && value.rowsRead <= CONTROL_TERMINAL_TAIL.reads && value.rowsWritten <= CONTROL_TERMINAL_TAIL.writes;
 };
 type Fields = Pick<BudgetedMonthlyStepResult, 'advance' | 'failureCode' | 'receipt'>;
 const result = (status: BudgetedMonthlyStepResult['status'], fields: Fields = {}): BudgetedMonthlyStepResult => Object.freeze({ status, ...fields,
  ...(fields.receipt ? { receipt: sanitize(fields.receipt) } : {}), ...(controlReceipt ? { controlReceipt: sanitize(controlReceipt) } : {}),
  statementCount: db.submitted, accounting: Object.freeze({ control: db.metrics('control'), work: db.metrics('work'), terminal: db.metrics('terminal'),
   prepaidControl: controlPrepaid ? reservation.overhead : null, prepaidTerminalTail: controlPrepaid ? CONTROL_TERMINAL_TAIL : null,
   controlStatus: controlReceipt?.result.state === 'settled' && controlCovered() && terminalCovered() ? 'prefix_observed_tail_prepaid' : 'unresolved',
   ...(workEvidence ? { workEvidence } : {}) }) });
 const finish = async (status: BudgetedMonthlyStepResult['status'], fields: Fields = {}): Promise<BudgetedMonthlyStepResult> => {
  if (controlGrant && !terminalAttempted) {
   terminalAttempted = true;
   try {
    db.phase('control');
    controlReceipt = await finalizeArchiveBudgetControl(db, { operationId: controlOperationId, usage: db.sealControlUsage(controlGrant) });
   } catch (error) { return result('stopped', { ...fields, failureCode: fields.failureCode ?? failureCode(error) }); }
   const terminal = db.metrics('terminal');
   if (terminal.rowsRead > CONTROL_TERMINAL_TAIL.reads || terminal.rowsWritten > CONTROL_TERMINAL_TAIL.writes) {
    // The receipt has already committed. This observation cannot retroactively
    // amend it; deployment must validate this policy bound before activation.
    return result('stopped', { ...fields, failureCode: 'CONTROL_TERMINAL_TAIL_BOUND_EXCEEDED' });
   }
   if (controlReceipt.result.state !== 'settled' || !controlCovered() || !terminalCovered()) {
    return result('stopped', { ...fields, failureCode: fields.failureCode ?? 'CONTROL_ACCOUNTING_UNRESOLVED' });
   }
  }
  return result(status, fields);
 };
 let receipt: ArchiveBudgetReceipt | undefined;
 try {
  const reserved = await reserveArchiveBudgetAttempt(db, { ...reservation, workKeySha256, targetRevision: target.selection.revision, maximumStatements: BUDGETED_MONTHLY_STEP_LIMITS.workStatements });
  receipt = reserved;
  controlGrant = reserved.controlGrant;
  if (!reserved.dispatchGrant) return await finish('replayed', { receipt });
  controlPrepaid = true;
  // Consume before any further await. Copies/reuse cannot run native work.
  const entry = takeArchiveBudgetDispatchGrant(db, reserved.dispatchGrant);
  if (entry.workKeySha256 !== workKeySha256 || entry.targetRevision !== target.selection.revision) fail('TARGET_INVALID');
  if (!controlGrant || !controlCovered()) return await finish('stopped', { failureCode: 'CONTROL_ACCOUNTING_UNRESOLVED', receipt });
  const claimed = await claimArchiveBudgetAttempt(db, { operationId: claimOperationId, attemptId: entry.attemptId, epochId: entry.epochId, executionGeneration: entry.executionGeneration, utcDay: entry.utcDay, expectedRevision: 0, expectedWork: { workKeySha256, targetRevision: target.selection.revision, envelope: entry.envelope, maximumStatements: entry.maximumStatements } });
  receipt = claimed;
  if (!claimed.grant || !controlCovered()) return await finish('stopped', { failureCode: 'CONTROL_ACCOUNTING_UNRESOLVED', receipt });
  const usage = createArchiveBudgetUsage(db, claimed.grant);
  let advance: MonthlySemanticAdvance | undefined, failure: string | undefined;
  db.phase('work');
  try { advance = await advanceMonthlySemanticVerification(usage, target.handle, target.selection); }
  catch (error) { failure = failureCode(error); }
  const closed = usage.seal(); workEvidence = readArchiveBudgetUsage(closed);
  db.phase('control');
  try { receipt = await settleArchiveBudgetAttempt(db, { operationId: settleOperationId, usage: closed }); }
  catch (error) { return await finish('stopped', { failureCode: failureCode(error), advance, receipt }); }
  return await finish(failure ? 'stopped' : advance?.status === 'paused' ? 'paused' : advance?.status === 'busy' ? 'busy' : 'advanced',
   { advance, ...(failure ? { failureCode: failure } : {}), receipt });
 } catch (error) { return await finish('stopped', { failureCode: failureCode(error), receipt }); }
}
