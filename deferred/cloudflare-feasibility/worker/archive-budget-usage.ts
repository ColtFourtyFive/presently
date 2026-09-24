import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import type { ArchiveStagingResult } from './archive-staging-admission';

export type ArchiveBudgetCost = Readonly<{ reads: number; writes: number }>;
export type ArchiveBudgetExecutionIdentity = Readonly<{
  attemptId: string;
  epochId: string;
  executionGeneration: string;
  utcDay: string;
  executionTokenSha256: string;
  envelope: ArchiveBudgetCost;
  maximumStatements: number;
}>;
export type ArchiveBudgetFenceFactory = <S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, identity: ArchiveBudgetExecutionIdentity) => S;
export type ArchiveBudgetExecutionGrant = Readonly<{ attemptId: string }>;
export type ArchiveBudgetUsageFailure = 'transport_failure' | 'result_count' | 'native_failure' | 'metadata_missing' | 'metadata_invalid' | 'non_primary_result' | 'counter_overflow' | 'statement_limit' | 'cost_overrun';
export type ArchiveBudgetUsageEvidence = ArchiveBudgetExecutionIdentity & Readonly<{
  rowsRead: number;
  rowsWritten: number;
  statementCount: number;
  observedStatementCount: number;
  batchCount: number;
  coverageComplete: boolean;
  overrun: boolean;
  failureCode: ArchiveBudgetUsageFailure | null;
}>;
export type ArchiveBudgetClosedUsage = Readonly<{ attemptId: string; closed: true }>;
export type ArchiveBudgetUsageStatement = { bind(...values: unknown[]): ArchiveBudgetUsageStatement };

type GrantRecord = { identity: ArchiveBudgetExecutionIdentity; fence: ArchiveBudgetFenceFactory; consumed: boolean };
const grants = new WeakMap<object, GrantRecord>();
const closedUsage = new WeakMap<object, ArchiveBudgetUsageEvidence>();
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
function fail(code: string): never { throw new Error(`ARCHIVE_BUDGET_USAGE_${code}`); }
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function capture(input: ArchiveBudgetExecutionIdentity): ArchiveBudgetExecutionIdentity {
  const envelope = Object.freeze({ reads: input.envelope.reads, writes: input.envelope.writes });
  const identity = Object.freeze({ attemptId: input.attemptId, epochId: input.epochId, executionGeneration: input.executionGeneration, utcDay: input.utcDay, executionTokenSha256: input.executionTokenSha256, envelope, maximumStatements: input.maximumStatements });
  if (![identity.attemptId, identity.epochId, identity.executionGeneration].every(value => typeof value === 'string' && idPattern.test(value)) || typeof identity.executionTokenSha256 !== 'string' || !tokenPattern.test(identity.executionTokenSha256)) fail('IDENTITY_INVALID');
  if (typeof identity.utcDay !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(identity.utcDay) || !Number.isFinite(Date.parse(`${identity.utcDay}T00:00:00.000Z`)) || new Date(`${identity.utcDay}T00:00:00.000Z`).toISOString().slice(0, 10) !== identity.utcDay) fail('IDENTITY_INVALID');
  if (!nonnegative(envelope.reads) || !nonnegative(envelope.writes) || !Number.isInteger(identity.maximumStatements) || identity.maximumStatements < 2 || identity.maximumStatements > 40) fail('ENVELOPE_INVALID');
  return identity;
}

/** Internal issuer. Only a winning fresh ledger claim may call this function.
 * Neither grants nor closed evidence can be reconstructed from request JSON.
 * The issuer supplies the ledger fence; application code receives only a grant.
 */
export function issueArchiveBudgetExecutionGrant(input: ArchiveBudgetExecutionIdentity, fence: ArchiveBudgetFenceFactory): ArchiveBudgetExecutionGrant {
  const identity = capture(input);
  if (typeof fence !== 'function') fail('FENCE_REQUIRED');
  const grant = Object.freeze({ attemptId: identity.attemptId });
  grants.set(grant, { identity, fence, consumed: false });
  return grant;
}

/** Validation is intentionally based on in-process identity, not object shape.
 * A restart that loses native usage cannot reconstruct a refund credential.
 */
export function readArchiveBudgetUsage(value: unknown): ArchiveBudgetUsageEvidence {
  if (!value || typeof value !== 'object') fail('UNTRUSTED_EVIDENCE');
  const evidence = closedUsage.get(value);
  if (!evidence) fail('UNTRUSTED_EVIDENCE');
  return evidence;
}

export function createArchiveBudgetUsage<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, grant: ArchiveBudgetExecutionGrant): D1ArchiveBudgetUsage<S> {
  if (!grant || typeof grant !== 'object') fail('GRANT_INVALID');
  const record = grants.get(grant);
  if (!record || record.consumed) fail('GRANT_CONSUMED_OR_INVALID');
  // Consume before constructing any native statement or yielding to caller code.
  record.consumed = true;
  return new D1ArchiveBudgetUsage(db, record, constructKey);
}
const constructKey = Symbol('archive-budget-usage-constructor');

/** Native accounting for one claimed execution. This is not an account quota
 * guarantee: allocation, failed-call overhead and supported cost envelopes must
 * be established by the ledger/dispatcher. It exposes only prepare/batch so work
 * cannot accidentally bypass accounting through a native statement's run/all.
 */
export class D1ArchiveBudgetUsage<S extends ArchiveStagingStatement<S>> implements ArchiveStagingDatabase<ArchiveBudgetUsageStatement> {
  readonly #statements = new WeakMap<object, S>();
  #rowsRead = 0;
  #rowsWritten = 0;
  #statementCount = 0;
  #observedStatementCount = 0;
  #batchCount = 0;
  #coverageComplete = true;
  #failureCode: ArchiveBudgetUsageFailure | null = null;
  #overrun = false;
  #inFlight = false;
  #sealed: ArchiveBudgetClosedUsage | undefined;
  readonly #db: ArchiveStagingDatabase<S>;
  readonly #grant: GrantRecord;
  constructor(db: ArchiveStagingDatabase<S>, grant: GrantRecord, key: symbol) {
    if (key !== constructKey) fail('CONSTRUCTOR_PRIVATE');
    this.#db = db;
    this.#grant = grant;
  }
  #available() {
    if (this.#sealed) fail('CLOSED');
    if (this.#failureCode) fail('HALTED');
  }
  #wrap(inner: S): ArchiveBudgetUsageStatement {
    const statement: ArchiveBudgetUsageStatement = Object.freeze({ bind: (...values: unknown[]) => {
      this.#available();
      return this.#wrap(inner.bind(...values));
    } });
    this.#statements.set(statement, inner);
    return statement;
  }
  prepare(sql: string): ArchiveBudgetUsageStatement {
    this.#available();
    return this.#wrap(this.#db.prepare(sql));
  }
  #problem(code: ArchiveBudgetUsageFailure, unknown: boolean) {
    this.#failureCode ??= code;
    if (unknown) this.#coverageComplete = false;
  }
  #add(current: number, next: number): number {
    if (next > Number.MAX_SAFE_INTEGER - current) {
      this.#problem('counter_overflow', true);
      // Saturation preserves a representable lower bound; never wrap to zero.
      return Number.MAX_SAFE_INTEGER;
    }
    return current + next;
  }
  #consume(results: unknown, expected: number) {
    if (!Array.isArray(results)) { this.#problem('result_count', true); return; }
    if (results.length !== expected) this.#problem('result_count', true);
    this.#observedStatementCount += results.length;
    // Visit every returned result even after malformed metadata. A later valid
    // observation may already exceed the envelope and must not be hidden.
    for (const result of results) {
      if (!result || typeof result !== 'object') { this.#problem('native_failure', true); continue; }
      if (result.success === false || !Array.isArray(result.results)) this.#problem('native_failure', true);
      const meta = result.meta;
      if (!meta || typeof meta !== 'object') { this.#problem('metadata_missing', true); continue; }
      if (meta.served_by_primary === false) this.#problem('non_primary_result', true);
      for (const [field, add] of [
        ['rows_read', (value: number) => { this.#rowsRead = this.#add(this.#rowsRead, value); }],
        ['rows_written', (value: number) => { this.#rowsWritten = this.#add(this.#rowsWritten, value); }],
      ] as const) {
        if (meta[field] === undefined) this.#problem('metadata_missing', true);
        else if (!nonnegative(meta[field])) this.#problem('metadata_invalid', true);
        else add(meta[field]);
      }
    }
    this.#overrun = this.#rowsRead > this.#grant.identity.envelope.reads || this.#rowsWritten > this.#grant.identity.envelope.writes;
    if (this.#overrun) this.#problem('cost_overrun', false);
  }
  async batch<T = Record<string, unknown>>(input: ArchiveBudgetUsageStatement[]): Promise<ArchiveStagingResult<T>[]> {
    this.#available();
    if (this.#inFlight) fail('IN_FLIGHT');
    if (!Array.isArray(input) || input.length < 1) fail('BATCH_INVALID');
    const statements = input.slice().map(statement => {
      const inner = statement && typeof statement === 'object' ? this.#statements.get(statement) : undefined;
      if (!inner) fail('STATEMENT_INVALID');
      return inner;
    });
    const count = statements.length + 1;
    if (count > this.#grant.identity.maximumStatements - this.#statementCount) {
      this.#problem('statement_limit', false);
      fail('STATEMENT_LIMIT');
    }
    // The guard is in the same atomic native batch as all submitted work.
    const guarded = [this.#grant.fence(this.#db, this.#grant.identity), ...statements];
    this.#inFlight = true;
    this.#statementCount += count;
    this.#batchCount++;
    let results: ArchiveStagingResult<T>[];
    try { results = await this.#db.batch<T>(guarded); }
    catch (cause) { this.#problem('transport_failure', true); throw cause; }
    finally { this.#inFlight = false; }
    this.#consume(results, count);
    if (this.#failureCode) fail(this.#overrun ? 'COST_OVERRUN' : 'METADATA_UNAVAILABLE');
    return results.slice(1);
  }
  seal(): ArchiveBudgetClosedUsage {
    if (this.#inFlight) fail('IN_FLIGHT');
    if (this.#sealed) return this.#sealed;
    const evidence: ArchiveBudgetUsageEvidence = Object.freeze({ ...this.#grant.identity, rowsRead: this.#rowsRead, rowsWritten: this.#rowsWritten, statementCount: this.#statementCount, observedStatementCount: this.#observedStatementCount, batchCount: this.#batchCount, coverageComplete: this.#coverageComplete, overrun: this.#overrun, failureCode: this.#failureCode });
    this.#sealed = Object.freeze({ attemptId: evidence.attemptId, closed: true });
    closedUsage.set(this.#sealed, evidence);
    return this.#sealed;
  }
}
