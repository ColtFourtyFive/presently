import { afterEach, describe, expect, it } from 'vitest';
import { createArchiveBudgetUsage, issueArchiveBudgetExecutionGrant, readArchiveBudgetUsage, type ArchiveBudgetExecutionIdentity, type ArchiveBudgetFenceFactory } from '../worker/archive-budget-usage';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import type { ArchiveStagingResult } from '../worker/archive-staging-admission';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

class Statement {
  constructor(readonly sql: string, readonly args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Statement(this.sql, args); }
}
const identity = (): ArchiveBudgetExecutionIdentity => ({ attemptId: crypto.randomUUID(), epochId: crypto.randomUUID(), executionGeneration: 'test-generation', utcDay: '2026-09-16', executionTokenSha256: 'a'.repeat(64), envelope: { reads: 1000, writes: 1000 }, maximumStatements: 40 });
const fence: ArchiveBudgetFenceFactory = db => db.prepare('SELECT 1 AS test_fence');
const result = (reads = 0, writes = 0): ArchiveStagingResult => ({ results: [], meta: { rows_read: reads, rows_written: writes, served_by_primary: true } });
function fake(run: (statements: Statement[]) => Promise<ArchiveStagingResult[]>): ArchiveStagingDatabase<Statement> {
  return { prepare: sql => new Statement(sql), async batch<T>(statements: Statement[]) { return await run(statements) as ArchiveStagingResult<T>[]; } };
}
let app: TestRuntime | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
async function native() {
  app = await createRuntime({ bindings: {} });
  await app.db.exec(`CREATE TABLE usage_fence(id INTEGER PRIMARY KEY,allowed INTEGER NOT NULL); INSERT INTO usage_fence VALUES(1,1);
    CREATE TABLE usage_work(id INTEGER PRIMARY KEY,value TEXT); CREATE TABLE usage_audit(id INTEGER PRIMARY KEY,work_id INTEGER);
    CREATE TRIGGER usage_work_audit AFTER INSERT ON usage_work BEGIN INSERT INTO usage_audit(work_id) VALUES(NEW.id); END;`);
  return app;
}
const nativeFence: ArchiveBudgetFenceFactory = db => db.prepare("SELECT CASE WHEN (SELECT allowed FROM usage_fence WHERE id=1)=1 THEN 1 ELSE json('ARCHIVE_BUDGET_EXECUTION_STALE') END AS allowed");

describe('one-shot native archive usage evidence', () => {
  it('consumes an opaque grant once, captures identity, rejects foreign statements and serialized evidence', async () => {
    const input = identity();
    const mutable = { ...input, envelope: { ...input.envelope } };
    const seen: ArchiveBudgetExecutionIdentity[] = [];
    const grant = issueArchiveBudgetExecutionGrant(mutable, (db, captured) => { seen.push(captured); return fence(db, captured); });
    mutable.attemptId = 'changed'; mutable.envelope.reads = 0;
    const db = fake(async statements => statements.map(() => result()));
    const usage = createArchiveBudgetUsage(db, grant);
    expect(() => createArchiveBudgetUsage(db, grant)).toThrow('GRANT_CONSUMED_OR_INVALID');
    expect(() => createArchiveBudgetUsage(db, JSON.parse(JSON.stringify(grant)))).toThrow('GRANT_CONSUMED_OR_INVALID');
    await expect(usage.batch([new Statement('SELECT 1')])).rejects.toThrow('STATEMENT_INVALID');
    await usage.batch([usage.prepare('SELECT 1')]);
    expect(seen[0].attemptId).toBe(input.attemptId);
    expect(seen[0].envelope.reads).toBe(1000);
    const closed = usage.seal();
    expect(usage.seal()).toBe(closed);
    expect(readArchiveBudgetUsage(closed)).toMatchObject({ attemptId: input.attemptId, rowsRead: 0, rowsWritten: 0, statementCount: 2, coverageComplete: true });
    expect(() => readArchiveBudgetUsage(JSON.parse(JSON.stringify(closed)))).toThrow('UNTRUSTED_EVIDENCE');
    expect(() => readArchiveBudgetUsage({ ...readArchiveBudgetUsage(closed) })).toThrow('UNTRUSTED_EVIDENCE');
    expect(() => usage.prepare('SELECT 1')).toThrow('CLOSED');
    expect(Object.isFrozen(readArchiveBudgetUsage(closed))).toBe(true);
    expect(Object.isFrozen(readArchiveBudgetUsage(closed).envelope)).toBe(true);
  });

  it('counts actual native fence, read and trigger/index write metrics while hiding only the fence result', async () => {
    const runtime = await native();
    const observed: ArchiveStagingResult[] = [];
    const db: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => runtime.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const results = await runtime.db.batch<T>(statements); observed.push(...results as ArchiveStagingResult[]); return results;
    } };
    const usage = createArchiveBudgetUsage(db, issueArchiveBudgetExecutionGrant(identity(), nativeFence));
    const results = await usage.batch([usage.prepare('INSERT INTO usage_work(id,value) VALUES(?,?)').bind(1, 'synthetic'), usage.prepare('SELECT * FROM usage_work')]);
    expect(results).toHaveLength(2); expect(results[1].results).toEqual([{ id: 1, value: 'synthetic' }]);
    const evidence = readArchiveBudgetUsage(usage.seal());
    expect(evidence.coverageComplete).toBe(true);
    expect(evidence.statementCount).toBe(3);
    expect(evidence.rowsRead).toBe(observed.reduce((n, row) => n + Number(row.meta!.rows_read), 0));
    expect(evidence.rowsWritten).toBe(observed.reduce((n, row) => n + Number(row.meta!.rows_written), 0));
    expect(evidence.rowsWritten).toBeGreaterThanOrEqual(2);
    expect(await runtime.db.prepare('SELECT count(*) n FROM usage_audit').first('n')).toBe(1);
  });

  it('fences inside the native batch and preserves uncertain charge on a lost committed response', async () => {
    const runtime = await native();
    let deny = true;
    const db: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => runtime.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (deny) await runtime.db.prepare('UPDATE usage_fence SET allowed=0 WHERE id=1').run();
      const results = await runtime.db.batch<T>(statements);
      if (!deny) throw new Error('synthetic lost committed response');
      return results;
    } };
    let usage = createArchiveBudgetUsage(db, issueArchiveBudgetExecutionGrant(identity(), nativeFence));
    await expect(usage.batch([usage.prepare('INSERT INTO usage_work(id,value) VALUES(1,\'denied\')')])).rejects.toThrow('malformed JSON');
    expect(await runtime.db.prepare('SELECT count(*) n FROM usage_work').first('n')).toBe(0);
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ coverageComplete: false, failureCode: 'transport_failure', statementCount: 2 });
    deny = false; await runtime.db.prepare('UPDATE usage_fence SET allowed=1 WHERE id=1').run();
    usage = createArchiveBudgetUsage(db, issueArchiveBudgetExecutionGrant(identity(), nativeFence));
    await expect(usage.batch([usage.prepare('INSERT INTO usage_work(id,value) VALUES(2,\'committed\')')])).rejects.toThrow('lost committed response');
    expect(await runtime.db.prepare('SELECT count(*) n FROM usage_work').first('n')).toBe(1);
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ rowsWritten: 0, coverageComplete: false, failureCode: 'transport_failure' });
  });

  it.each([
    ['missing', { rows_written: 2 }],
    ['negative', { rows_read: -1, rows_written: 2 }],
    ['fraction', { rows_read: 0.5, rows_written: 2 }],
    ['unsafe', { rows_read: Number.MAX_SAFE_INTEGER + 1, rows_written: 2 }],
    ['replica', { rows_read: 3, rows_written: 2, served_by_primary: false }],
  ])('never treats %s metadata as complete zero-cost evidence', async (_label, meta) => {
    const usage = createArchiveBudgetUsage(fake(async () => [result(1, 0), { results: [], meta }]), issueArchiveBudgetExecutionGrant(identity(), fence));
    await expect(usage.batch([usage.prepare('SELECT 1')])).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(() => usage.prepare('SELECT 2')).toThrow('HALTED');
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ rowsWritten: 2, coverageComplete: false, statementCount: 2 });
  });

  it('preserves later observed lower bounds after partial metadata and records an overrun', async () => {
    const usage = createArchiveBudgetUsage(fake(async () => [{ results: [] }, result(6000, 7)]), issueArchiveBudgetExecutionGrant(identity(), fence));
    await expect(usage.batch([usage.prepare('SELECT 1')])).rejects.toThrow('COST_OVERRUN');
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ rowsRead: 6000, rowsWritten: 7, coverageComplete: false, overrun: true });
  });

  it('preserves safe observations and flags aggregate counter overflow as a lower bound', async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const usage = createArchiveBudgetUsage(fake(async () => [result(1, 0), result(maximum, maximum)]), issueArchiveBudgetExecutionGrant(identity(), fence));
    await expect(usage.batch([usage.prepare('SELECT 1')])).rejects.toThrow('COST_OVERRUN');
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ rowsRead: maximum, rowsWritten: maximum, coverageComplete: false, overrun: true, failureCode: 'counter_overflow', observedStatementCount: 2 });
    expect(() => usage.prepare('SELECT 2')).toThrow('CLOSED');
  });
  it('halts on complete observed overruns and mismatched result coverage', async () => {
    let usage = createArchiveBudgetUsage(fake(async () => [result(1, 0), result(1000, 1001)]), issueArchiveBudgetExecutionGrant(identity(), fence));
    await expect(usage.batch([usage.prepare('SELECT 1')])).rejects.toThrow('COST_OVERRUN');
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ rowsRead: 1001, rowsWritten: 1001, coverageComplete: true, overrun: true });
    usage = createArchiveBudgetUsage(fake(async () => [result(3, 4)]), issueArchiveBudgetExecutionGrant(identity(), fence));
    await expect(usage.batch([usage.prepare('SELECT 1')])).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ rowsRead: 3, rowsWritten: 4, observedStatementCount: 1, coverageComplete: false });
  });

  it('includes fence statements in the hard limit and rejects concurrent work or sealing before completion', async () => {
    let resolve!: (results: ArchiveStagingResult[]) => void;
    let calls = 0;
    const db = fake(async () => { calls++; return new Promise(done => { resolve = done; }); });
    const usage = createArchiveBudgetUsage(db, issueArchiveBudgetExecutionGrant({ ...identity(), maximumStatements: 3 }, fence));
    const first = usage.batch([usage.prepare('SELECT 1')]);
    expect(() => usage.seal()).toThrow('IN_FLIGHT');
    await expect(usage.batch([usage.prepare('SELECT 2')])).rejects.toThrow('IN_FLIGHT');
    resolve([result(), result()]); await first;
    await expect(usage.batch([usage.prepare('SELECT 3')])).rejects.toThrow('STATEMENT_LIMIT');
    expect(calls).toBe(1);
    expect(readArchiveBudgetUsage(usage.seal())).toMatchObject({ statementCount: 2, batchCount: 1, coverageComplete: true, failureCode: 'statement_limit' });
  });
});
