import type { ArchiveBudgetCost } from './archive-budget-usage';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import type { ArchiveStagingResult } from './archive-staging-admission';

/** Provisional local bounds: deployment must measure and approve this policy before activation.
 * The terminal statement cannot observe its own cost before committing its receipt. */
export const CONTROL_TERMINAL_TAIL = Object.freeze({ version: 'archive-control-terminal-v1', reads: 64, writes: 16, statements: 1 });
export const ARCHIVE_BUDGET_INVOCATION_STATEMENT_LIMIT = 40;
export type ArchiveBudgetControlIdentity = Readonly<{
 attemptId: string; epochId: string; executionGeneration: string; utcDay: string; prepaid: ArchiveBudgetCost;
}>;
export type ArchiveBudgetControlGrant = Readonly<{ attemptId: string }>;
export type ArchiveBudgetControlUsage = Readonly<{ attemptId: string }>;
export type ArchiveBudgetInvocationMetrics = Readonly<{
 rowsRead: number; rowsWritten: number; statements: number; batches: number; coverageComplete: boolean;
}>;
export type ArchiveBudgetControlEvidence = Readonly<{
 identity: ArchiveBudgetControlIdentity;
 prefix: ArchiveBudgetInvocationMetrics;
 tail: typeof CONTROL_TERMINAL_TAIL;
}>;
type GrantRecord = { database: object; identity: ArchiveBudgetControlIdentity; consumed: boolean };
type UsageRecord = { database: object; evidence: ArchiveBudgetControlEvidence; consumed: boolean };
const grants = new WeakMap<object, GrantRecord>();
const usages = new WeakMap<object, UsageRecord>();
const invalid = (): never => { throw new Error('ARCHIVE_BUDGET_CONTROL_USAGE_INVALID'); };

/** Internal reservation authority; a replay must never issue this grant. */
export function issueArchiveBudgetControlGrant(database: object, input: ArchiveBudgetControlIdentity): ArchiveBudgetControlGrant {
 const identity = Object.freeze({ attemptId: input.attemptId, epochId: input.epochId, executionGeneration: input.executionGeneration,
  utcDay: input.utcDay, prepaid: Object.freeze({ reads: input.prepaid.reads, writes: input.prepaid.writes }) });
 const grant = Object.freeze({ attemptId: identity.attemptId });
 grants.set(grant, { database, identity, consumed: false });
 return grant;
}

/** Consume synchronously before the terminal store performs any await or SQL. */
export function takeArchiveBudgetControlUsage(database: object, value: unknown): ArchiveBudgetControlEvidence {
 const record = value && typeof value === 'object' ? usages.get(value) : undefined;
 if (!record || record.consumed || record.database !== database) return invalid();
 record.consumed = true;
 return record.evidence;
}

type Statement = { bind(...values: unknown[]): Statement };
type Metrics = { rowsRead: number; rowsWritten: number; statements: number; batches: number; coverageComplete: boolean };
const initial = (): Metrics => ({ rowsRead: 0, rowsWritten: 0, statements: 0, batches: 0, coverageComplete: true });
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const fail = (code: string): never => { throw new Error(`ARCHIVE_BUDGET_RUN_${code}`); };

/** Native observations stay private. No caller can submit a numeric healthy prefix.
 * Sealing freezes the observed prefix and leaves exactly one terminal SQL statement. */
class Invocation<S extends ArchiveStagingStatement<S>> implements ArchiveStagingDatabase<Statement> {
 readonly #db: ArchiveStagingDatabase<S>;
 readonly #statements = new WeakMap<object, S>();
 readonly #control = initial();
 readonly #work = initial();
 readonly #terminal = initial();
 #phase: 'control' | 'work' = 'control';
 #inFlight = false;
 #sealed = false;
 constructor(db: ArchiveStagingDatabase<S>) { this.#db = db; }
 phase(value: 'control' | 'work') {
  if (this.#inFlight) fail('IN_FLIGHT');
  if (this.#sealed) fail('SEALED');
  if (value !== 'control' && value !== 'work') fail('PHASE_INVALID');
  this.#phase = value;
 }
 get submitted() { return this.#control.statements + this.#work.statements + this.#terminal.statements; }
 metrics(phase: 'control' | 'work' | 'terminal'): ArchiveBudgetInvocationMetrics {
  return Object.freeze({ ...(phase === 'control' ? this.#control : phase === 'work' ? this.#work : this.#terminal) });
 }
 sealControlUsage(value: unknown): ArchiveBudgetControlUsage {
  if (this.#inFlight) fail('IN_FLIGHT');
  const record = value && typeof value === 'object' ? grants.get(value) : undefined;
  if (this.#sealed || this.#phase !== 'control' || !record || record.consumed || record.database !== this) return invalid();
  record.consumed = true;
  this.#sealed = true;
  const usage = Object.freeze({ attemptId: record.identity.attemptId });
  const evidence = Object.freeze({ identity: record.identity, prefix: this.metrics('control'), tail: CONTROL_TERMINAL_TAIL });
  usages.set(usage, { database: this, evidence, consumed: false });
  return usage;
 }
 #wrap(native: S): Statement {
  const statement: Statement = Object.freeze({ bind: (...values: unknown[]) => this.#wrap(native.bind(...values)) });
  this.#statements.set(statement, native);
  return statement;
 }
 prepare(sql: string): Statement { return this.#wrap(this.#db.prepare(sql)); }
 async batch<T = Record<string, unknown>>(input: Statement[]): Promise<ArchiveStagingResult<T>[]> {
  if (this.#inFlight) fail('IN_FLIGHT');
  if (!input.length || input.length > ARCHIVE_BUDGET_INVOCATION_STATEMENT_LIMIT - this.submitted) fail('STATEMENT_LIMIT');
  if (this.#sealed && (input.length !== 1 || this.#terminal.statements !== 0)) fail('TERMINAL_STATEMENT_LIMIT');
  const native = input.map(statement => { const found = this.#statements.get(statement); if (!found) return fail('STATEMENT_INVALID'); return found; });
  const metric = this.#sealed ? this.#terminal : this.#phase === 'control' ? this.#control : this.#work;
  metric.statements += native.length; metric.batches++; this.#inFlight = true;
  try {
   const results = await this.#db.batch<T>(native);
   if (!Array.isArray(results) || results.length !== native.length) metric.coverageComplete = false;
   for (const result of Array.isArray(results) ? results : []) {
    if (!result || !Array.isArray(result.results) || (result as ArchiveStagingResult<T> & { success?: boolean }).success === false || result.meta?.served_by_primary === false) metric.coverageComplete = false;
    for (const [field, key] of [['rows_read', 'rowsRead'], ['rows_written', 'rowsWritten']] as const) {
     const value = result?.meta?.[field];
     if (!nonnegative(value)) { metric.coverageComplete = false; continue; }
     if (value > Number.MAX_SAFE_INTEGER - metric[key]) { metric[key] = Number.MAX_SAFE_INTEGER; metric.coverageComplete = false; }
     else metric[key] += value;
    }
   }
   return results;
  } catch (error) { metric.coverageComplete = false; throw error; }
  finally { this.#inFlight = false; }
 }
}

export function createArchiveBudgetInvocation<S extends ArchiveStagingStatement<S>>(database: ArchiveStagingDatabase<S>) {
 return new Invocation(database);
}
