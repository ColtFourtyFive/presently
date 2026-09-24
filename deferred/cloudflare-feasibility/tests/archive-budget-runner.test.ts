import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { monthlyBudgetWorkKey, reserveAndAdvanceBudgetedMonthlyVerification, type BudgetedMonthlyStepInput } from '../worker/archive-budget-runner';
import { readArchiveBudgetRuntime } from '../worker/archive-budget-ledger';
import { pauseArchiveStaging } from '../worker/archive-staging-controls';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { createBudgetRunnerFixture, privateSourceFingerprint, readBudgetRunnerSelection } from './archive-budget-runner-fixture';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

let app: TestRuntime, fixture: Awaited<ReturnType<typeof createBudgetRunnerFixture>>;
let source: Awaited<ReturnType<typeof nativeSemanticFixture>>;
beforeAll(async () => { source = await nativeSemanticFixture(1); });
beforeEach(async () => { app = await createRuntime({ bindings: {} }); fixture = await createBudgetRunnerFixture(app, source); });
afterEach(async () => { await app.close(); });

async function input(): Promise<BudgetedMonthlyStepInput> {
  return {
    target: { handle: { ...fixture.handle }, selection: await readBudgetRunnerSelection(app, fixture.handle) }, policyVersion: 'synthetic-test-policy',
    reservation: { ...fixture.identity, operationId: crypto.randomUUID(), attemptId: crypto.randomUUID(), pool: 'work',
      envelope: { reads: 1_000_000, writes: 100_000 }, overhead: { reads: 10_000, writes: 1_000 } },
    claimOperationId: crypto.randomUUID(), settleOperationId: crypto.randomUUID(), controlOperationId: crypto.randomUUID(),
  };
}
const workBatch = (statements: IsolatedStatement[]) => statements.some(statement => statement.sql.includes('AS archive_budget_allowed'));
const reserveBatch = (statements: IsolatedStatement[]) => statements.some(statement => statement.sql.startsWith('INSERT INTO archive_budget_attempts'));
const settlementBatch = (statements: IsolatedStatement[]) => statements.some(statement => statement.sql.startsWith('UPDATE archive_budget_attempts SET state=?,execution_token_sha256=NULL'));
const saved = () => app.db.prepare('SELECT * FROM archive_semantic_runs WHERE run_id=?').bind(fixture.handle.runId).first<Record<string, unknown>>();
const attempt = (attemptId: string) => app.db.prepare('SELECT * FROM archive_budget_attempts WHERE attempt_id=?').bind(attemptId).first<Record<string, unknown>>();
const countAttempts = () => app.db.prepare('SELECT count(*) n FROM archive_budget_attempts').first<number>('n');

describe('budgeted monthly runner integration', () => {
  it.each([false, true])('completes a native month within forty total statements with exceptional guardian=%s', async exceptionalGuardian => {
    if (exceptionalGuardian) { await app.close(); app = await createRuntime({ bindings: {} }); fixture = await createBudgetRunnerFixture(app, await nativeSemanticFixture(1, true)); }
    let maximumStatements = 0, maximumWork = 0, terminalReads = 0, terminalWrites = 0;
    const phases = new Set<string>(), fingerprint = await privateSourceFingerprint(app, fixture.handle);
    let complete = false, calls = 0;
    for (; calls < 200; calls++) {
      const request = await input(); phases.add(request.target.selection.phase);
      let submitted = 0;
      const measured: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
        submitted += statements.length;
        return app.db.batch<T>(statements);
      } };
      const result = await reserveAndAdvanceBudgetedMonthlyVerification(measured, request);
      expect(result.status, JSON.stringify({ selected: request.target.selection, result })).toBe('advanced');
      expect(result.statementCount).toBe(submitted);
      maximumStatements = Math.max(maximumStatements, result.statementCount); maximumWork = Math.max(maximumWork, result.accounting.work.statements);
      terminalReads = Math.max(terminalReads, result.accounting.terminal.rowsRead); terminalWrites = Math.max(terminalWrites, result.accounting.terminal.rowsWritten);
      expect(result.accounting.terminal).toMatchObject({ statements: 1, coverageComplete: true });
      expect(result.controlReceipt).toMatchObject({ kind: 'control', result: { state: 'settled', observedPrefix: result.accounting.control,
        prepaidTail: { version: 'archive-control-terminal-v1', reads: 64, writes: 16, statements: 1 } } });
      expect(result.receipt).not.toHaveProperty('controlGrant');
      expect(result.statementCount).toBeLessThanOrEqual(40);
      expect(result.accounting.control.statements + result.accounting.work.statements + result.accounting.terminal.statements).toBe(submitted);
      expect(result.accounting.work.statements).toBeLessThanOrEqual(26);
      expect(result.accounting.controlStatus).toBe('prefix_observed_tail_prepaid');
      expect(result.accounting.work.coverageComplete).toBe(true);
      expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'settled', target_revision: request.target.selection.revision, maximum_statements: 26 });
      if (result.advance?.status === 'complete') { complete = true; phases.add('complete'); break; }
    }
    expect(complete).toBe(true);
    expect(phases).toEqual(new Set(['records', 'visits', 'reviews', 'complete']));
    expect(calls).toBeGreaterThan(10);
    if (exceptionalGuardian) expect(maximumStatements).toBeGreaterThanOrEqual(37);
    console.info('schema24-native-budgeted-month', JSON.stringify({ exceptionalGuardian, calls: calls + 1, maximumStatements, maximumWork, terminalReads, terminalWrites }));
    expect(await privateSourceFingerprint(app, fixture.handle)).toBe(fingerprint);
    expect(await app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(fixture.handle.verificationId).first('status')).toBe('verified');
    expect(await app.db.prepare("SELECT held_reads,held_writes FROM archive_budget_pools WHERE pool='work'").first()).toEqual({ held_reads: 0, held_writes: 0 });
  });

  it('binds work to the exact handle, selection and policy and makes reserve replays read-only', async () => {
    const request = await input(), expectedWorkKey = await monthlyBudgetWorkKey(request.target, request.policyVersion);
    const first = await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request);
    expect(first.status).toBe('advanced');
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ work_key_sha256: expectedWorkKey, target_revision: 0, state: 'settled' });
    const before = await saved();
    const replay = await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request);
    expect(replay).toMatchObject({ status: 'replayed', accounting: { work: { statements: 0 }, prepaidControl: null, controlStatus: 'unresolved' } });
    expect(await saved()).toEqual(before);
    for (const changed of [
      { ...request, target: { ...request.target, selection: { ...request.target.selection, revision: 1 } } },
      { ...request, target: { ...request.target, handle: { ...request.target.handle, runId: 'different-run' } } },
      { ...request, policyVersion: 'different-policy' },
    ]) {
      const conflict = await reserveAndAdvanceBudgetedMonthlyVerification(app.db, changed);
      expect(conflict).toMatchObject({ status: 'stopped', failureCode: 'ARCHIVE_BUDGET_OPERATION_CONFLICT', accounting: { work: { statements: 0 } } });
    }
    expect(await countAttempts()).toBe(1);
    expect(await saved()).toEqual(before);
  });

  it('copies target and reservation inputs before asynchronous hashing or SQL', async () => {
    const original = await input();
    const mutable = { ...original, target: { handle: { ...original.target.handle }, selection: { ...original.target.selection } },
      reservation: { ...original.reservation, envelope: { ...original.reservation.envelope }, overhead: { ...original.reservation.overhead } } };
    const expected = await monthlyBudgetWorkKey(original.target, original.policyVersion);
    const pending = reserveAndAdvanceBudgetedMonthlyVerification(app.db, mutable);
    mutable.target.selection.revision = 999; mutable.target.handle.runId = 'changed-run'; mutable.policyVersion = 'changed-policy';
    mutable.reservation.envelope.reads = 1; mutable.reservation.overhead.writes = 1;
    expect((await pending).status).toBe('advanced');
    expect(await attempt(original.reservation.attemptId)).toMatchObject({ work_key_sha256: expected, reads_envelope: 1_000_000, overhead_writes: 1_000, target_revision: 0 });
  });

  it.each(['paused', 'busy'] as const)('reports %s without proof progress and settles only observed work usage', async status => {
    if (status === 'paused') {
      const expectedRevision = (await app.db.prepare('SELECT revision FROM archive_semantic_lifecycle WHERE verification_id=? AND generation=?')
        .bind(fixture.handle.verificationId, fixture.handle.generation).first<number>('revision'))!;
      await pauseArchiveStaging(app.db, { verificationId: fixture.handle.verificationId, generation: fixture.handle.generation,
        executionGeneration: fixture.identity.executionGeneration, expectedRevision, operationId: crypto.randomUUID(), reason: 'maintenance', nextEligibleAt: new Date(Date.now() + 3_600_000).toISOString() });
    } else {
      await app.db.prepare("UPDATE archive_semantic_runs SET status='running',lease_token='preexisting-budget-runner-lease',lease_expires_at=? WHERE run_id=?")
        .bind(new Date(Date.now() + 30_000).toISOString(), fixture.handle.runId).run();
    }
    const request = await input(), before = await saved(), fingerprint = await privateSourceFingerprint(app, fixture.handle);
    const result = await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request);
    expect(result).toMatchObject({ status, advance: { status, revision: request.target.selection.revision }, accounting: { controlStatus: 'prefix_observed_tail_prepaid', work: { coverageComplete: true } } });
    expect(result.statementCount).toBeLessThanOrEqual(40);
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'settled', charge_reads: result.accounting.work.rowsRead, charge_writes: result.accounting.work.rowsWritten });
    expect(await saved()).toEqual(before);
    expect(await privateSourceFingerprint(app, fixture.handle)).toBe(fingerprint);
    expect(await app.db.prepare("SELECT held_reads,held_writes FROM archive_budget_pools WHERE pool='work'").first()).toEqual({ held_reads: 0, held_writes: 0 });
  });

  it('does not claim or execute a reservation whose committed response was lost', async () => {
    const request = await input(), before = await saved();
    let lost = false;
    const broken: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const result = await app.db.batch<T>(statements);
      if (!lost && reserveBatch(statements)) { lost = true; throw new Error('Synthetic reservation response loss'); }
      return result;
    } };
    const stopped = await reserveAndAdvanceBudgetedMonthlyVerification(broken, request);
    expect(stopped).toMatchObject({ status: 'stopped', accounting: { prepaidControl: null, controlStatus: 'unresolved', work: { statements: 0 } } });
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'reserved', revision: 0 });
    expect((await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request)).status).toBe('replayed');
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'reserved', revision: 0 });
    expect(await saved()).toEqual(before);
    expect(await countAttempts()).toBe(1);
  });

  it.each(['missing', 'overrun'])('returns no execution capability when control accounting is %s after claim', async kind => {
    const request = await input(), before = await saved();
    let affected = false;
    const broken: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const results = await app.db.batch<T>(statements);
      if (!affected && statements.some(statement => statement.sql.startsWith("UPDATE archive_budget_attempts SET state='executing'"))) {
        affected = true;
        return results.map((row, index) => index ? row : kind === 'missing' ? { ...row, meta: undefined }
          : { ...row, meta: { ...row.meta, rows_written: request.reservation.overhead.writes + 1 } });
      }
      return results;
    } };
    const result = await reserveAndAdvanceBudgetedMonthlyVerification(broken, request);
    expect(affected).toBe(true);
    expect(result).toMatchObject({ status: 'stopped', failureCode: 'CONTROL_ACCOUNTING_UNRESOLVED', accounting: { controlStatus: 'unresolved', prepaidControl: request.reservation.overhead, work: { statements: 0 } } });
    expect(result.receipt).not.toHaveProperty('grant');
    expect(result.receipt).not.toHaveProperty('dispatchGrant');
    expect(Object.keys(result.receipt!).sort()).toEqual(['kind', 'operationId', 'replayed', 'result']);
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'executing', charge_reads: 0, charge_writes: 0 });
    expect(await saved()).toEqual(before);
    expect(await app.db.prepare('SELECT state FROM archive_budget_controls WHERE attempt_id=?').bind(request.reservation.attemptId).first('state')).toBe(kind === 'missing' ? 'unknown' : 'overrun');
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', dispatchBlocked: true });
    expect((await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request)).status).toBe('replayed');
    expect(await saved()).toEqual(before);
  });

  it.each(['claim', 'lease'])('fences old-generation work after the %s commits without advancing source evidence', async point => {
    const request = await input(), fingerprint = await privateSourceFingerprint(app, fixture.handle);
    let rotated = false;
    const raced: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const results = await app.db.batch<T>(statements);
      const match = statements.some(statement => statement.sql.startsWith(point === 'claim' ? "UPDATE archive_budget_attempts SET state='executing'" : "UPDATE archive_semantic_runs SET status='running'"));
      if (!rotated && match) { rotated = true; await app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run(); }
      return results;
    } };
    const result = await reserveAndAdvanceBudgetedMonthlyVerification(raced, request);
    expect(rotated).toBe(true);
    expect(result.status).toBe('stopped');
    expect((await saved())!.revision).toBe(0);
    expect((await saved())!.status).not.toBe('invalid');
    expect(await privateSourceFingerprint(app, fixture.handle)).toBe(fingerprint);
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'restore_unreconciled' });
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'executing', charge_reads: 0, charge_writes: 0 });
    expect((await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request)).status).toBe('stopped');
  });

  it.each(['metadata', 'transport'])('retains the full reservation when work has incomplete %s evidence', async kind => {
    const request = await input(), before = await saved();
    let interrupted = false;
    const broken: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (!interrupted && workBatch(statements)) {
        interrupted = true;
        if (kind === 'transport') throw new Error('Synthetic work transport failure');
        const results = await app.db.batch<T>(statements);
        return results.map((result, index) => index ? { ...result, meta: undefined } : result);
      }
      return app.db.batch<T>(statements);
    } };
    const result = await reserveAndAdvanceBudgetedMonthlyVerification(broken, request);
    expect(result.status).toBe('stopped');
    expect(interrupted).toBe(true);
    expect(result.accounting.work.coverageComplete).toBe(false);
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'unknown', charge_reads: request.reservation.envelope.reads, charge_writes: request.reservation.envelope.writes });
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'unknown_usage' });
    expect(await saved()).toEqual(before);
  });

  it('retains uncertain cost after a committed work response is lost and does not repeat the step', async () => {
    const request = await input(), fingerprint = await privateSourceFingerprint(app, fixture.handle);
    let lost = false;
    const broken: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const results = await app.db.batch<T>(statements);
      if (!lost && statements.some(statement => statement.sql.startsWith('UPDATE archive_semantic_runs SET revision=CASE'))) {
        lost = true; throw new Error('Synthetic committed work response loss');
      }
      return results;
    } };
    const result = await reserveAndAdvanceBudgetedMonthlyVerification(broken, request);
    expect(lost).toBe(true);
    expect(result).toMatchObject({ status: 'stopped', accounting: { work: { coverageComplete: false } } });
    expect(await saved()).toMatchObject({ revision: 1, status: 'pending' });
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'unknown', charge_reads: request.reservation.envelope.reads, charge_writes: request.reservation.envelope.writes });
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'unknown_usage' });
    const committed = await saved();
    expect((await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request)).status).toBe('replayed');
    expect(await saved()).toEqual(committed);
    expect(await privateSourceFingerprint(app, fixture.handle)).toBe(fingerprint);
  });

  it.each(['before', 'after'])('stops on a settlement response failure %s commit and never advances twice on retry', async timing => {
    const request = await input();
    let failed = false;
    const broken: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (!failed && settlementBatch(statements)) {
        failed = true;
        if (timing === 'after') await app.db.batch<T>(statements);
        throw new Error('Synthetic settlement transport failure');
      }
      return app.db.batch<T>(statements);
    } };
    const result = await reserveAndAdvanceBudgetedMonthlyVerification(broken, request);
    expect(failed).toBe(true);
    expect(result).toMatchObject({ status: 'stopped', advance: { revision: 1 }, accounting: { controlStatus: 'unresolved' } });
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: timing === 'before' ? 'executing' : 'settled' });
    const committed = await saved();
    expect((await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request)).status).toBe('replayed');
    expect(await saved()).toEqual(committed);
    expect(await countAttempts()).toBe(1);
  });
  it.each(['before', 'after'])('retains the durable terminal outcome when response is lost %s commit', async timing => {
    const request = await input();
    let terminalCalls = 0;
    const broken: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (statements.some(statement => statement.sql.includes('UPDATE archive_budget_controls AS c'))) {
        terminalCalls++;
        expect(statements).toHaveLength(1);
        if (timing === 'after') await app.db.batch<T>(statements);
        throw new Error('Synthetic terminal reply loss');
      }
      return app.db.batch<T>(statements);
    } };
    const stopped = await reserveAndAdvanceBudgetedMonthlyVerification(broken, request);
    expect(stopped).toMatchObject({ status: 'stopped', advance: { revision: 1 }, accounting: {
      control: { coverageComplete: true }, terminal: { statements: 1, coverageComplete: false }, controlStatus: 'unresolved' } });
    expect(terminalCalls).toBe(1);
    expect(await attempt(request.reservation.attemptId)).toMatchObject({ state: 'settled' });
    const row = await app.db.prepare('SELECT * FROM archive_budget_controls WHERE attempt_id=?').bind(request.reservation.attemptId).first();
    expect(row).toMatchObject({ state: timing === 'before' ? 'pending' : 'settled' });
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ dispatchBlocked: timing === 'before', pendingControlOwner: timing === 'before' ? request.reservation.attemptId : null });
    const revision = (await saved())!.revision;
    expect((await reserveAndAdvanceBudgetedMonthlyVerification(app.db, request)).status).toBe('replayed');
    expect((await saved())!.revision).toBe(revision);
    expect(await app.db.prepare('SELECT * FROM archive_budget_controls WHERE attempt_id=?').bind(request.reservation.attemptId).first()).toEqual(row);
    if (timing === 'before') {
      expect((await reserveAndAdvanceBudgetedMonthlyVerification(app.db, await input())).status).toBe('stopped');
      expect(await countAttempts()).toBe(1);
    }
  });

  it('captures the terminal operation before awaiting and rejects overlapping operation IDs before SQL', async () => {
    const request = await input(), originalOperation = request.controlOperationId;
    const mutable = { ...request };
    const running = reserveAndAdvanceBudgetedMonthlyVerification(app.db, mutable);
    mutable.controlOperationId = 'changed-after-call';
    const completed = await running;
    expect(completed.controlReceipt?.operationId).toBe(originalOperation);
    let calls = 0;
    const watched: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      calls++; return app.db.batch<T>(statements);
    } };
    for (const overlapping of [request.claimOperationId, request.settleOperationId, request.reservation.operationId]) {
      await expect(reserveAndAdvanceBudgetedMonthlyVerification(watched, { ...request, controlOperationId: overlapping })).rejects.toThrow('INPUT_INVALID');
    }
    expect(calls).toBe(0);
  });

  it('reports a terminal policy-bound breach without pretending its committed prefix receipt includes the extra cost', async () => {
    const request = await input();
    let calls = 0;
    const native: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const result = await app.db.batch<T>(statements);
      if (statements.some(statement => statement.sql.includes('UPDATE archive_budget_controls AS c'))) {
        calls++;
        return result.map(row => ({ ...row, meta: { ...row.meta, rows_read: 65, rows_written: 17 } }));
      }
      return result;
    } };
    const result = await reserveAndAdvanceBudgetedMonthlyVerification(native, request);
    expect(result).toMatchObject({ status: 'stopped', failureCode: 'CONTROL_TERMINAL_TAIL_BOUND_EXCEEDED',
      controlReceipt: { result: { state: 'settled', prepaidTail: { reads: 64, writes: 16 } } },
      accounting: { controlStatus: 'unresolved', terminal: { rowsRead: 65, rowsWritten: 17 } } });
    expect(calls).toBe(1);
    // Document the policy assumption: the last statement cannot persist its own
    // later observed overrun. No public dispatcher is allowed to rely on this
    // policy until its deployed bound and external containment are approved.
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ dispatchBlocked: false });
  });

});
