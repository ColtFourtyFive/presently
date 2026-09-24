import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abandonArchiveBudgetAttempt, archiveBudgetExecutionFence, claimArchiveBudgetAttempt, closeArchiveBudgetEpoch, openArchiveBudgetDay, readArchiveBudgetRuntime, reserveArchiveBudgetAttempt, settleArchiveBudgetAttempt } from '../worker/archive-budget-ledger';
import { createArchiveBudgetUsage, readArchiveBudgetUsage } from '../worker/archive-budget-usage';
import { createArchiveBudgetInvocation } from '../worker/archive-budget-control-usage';
import { finalizeArchiveBudgetControl } from '../worker/archive-budget-control-store';
import { installBudgetControlMigration, legacyBudgetFixture } from './archive-budget-legacy-fixture';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { budgetReservation, openBudgetFixture } from './archive-budget-fixture';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

let app: TestRuntime;
beforeEach(async () => { app = await createRuntime({ bindings: {} }); });
afterEach(async () => { await app.close(); });
const pool = (name = 'work') => app.db.prepare('SELECT * FROM archive_budget_pools WHERE pool=?').bind(name).first<Record<string, number | string>>();
const receiptCount = () => app.db.prepare('SELECT count(*) n FROM archive_budget_receipts').first<number>('n');
async function reserved() {
  const setup = await openBudgetFixture(app), input = budgetReservation(setup.identity);
  await reserveArchiveBudgetAttempt(app.db, input);
  return { ...setup, input };
}

describe('internal archive budget ledger', () => {
  it('starts closed, allocates protected pools once, and replays exact requests without top-ups', async () => {
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'initial', revision: 0 });
    const setup = await openBudgetFixture(app);
    expect(setup.receipt.replayed).toBe(false);
    expect((await openArchiveBudgetDay(app.db, setup.input)).replayed).toBe(true);
    await expect(openArchiveBudgetDay(app.db, { ...setup.input, pools: { ...setup.input.pools, work: { reads: 1, writes: 1 } } })).rejects.toThrow('OPERATION_CONFLICT');
    expect(await pool('control')).toMatchObject({ charged_reads: 1, charged_writes: 1 });
    await expect(openArchiveBudgetDay(app.db, { ...setup.input, operationId: crypto.randomUUID(), epochId: crypto.randomUUID(), expectedRevision: 1 })).rejects.toThrow();
    expect(await receiptCount()).toBe(1);
  });

  it('atomically rejects vector oversubscription and keeps cleanup/control allocations protected', async () => {
    const { identity } = await openBudgetFixture(app, { work: { reads: 100, writes: 100 }, cleanup: { reads: 50, writes: 50 }, control: { reads: 5000, writes: 500 } });
    const a = budgetReservation(identity, { envelope: { reads: 80, writes: 20 } }), b = budgetReservation(identity, { envelope: { reads: 80, writes: 20 } });
    const contenders = [createArchiveBudgetInvocation(app.db), createArchiveBudgetInvocation(app.db)];
    const results = await Promise.allSettled([reserveArchiveBudgetAttempt(contenders[0], a), reserveArchiveBudgetAttempt(contenders[1], b)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await pool()).toMatchObject({ held_reads: 80, held_writes: 20 });
    expect(await pool('control')).toMatchObject({ charged_reads: 1001, charged_writes: 101 });
    await expect(reserveArchiveBudgetAttempt(app.db, budgetReservation(identity))).rejects.toThrow('CONTROL_PENDING');
    const index = results.findIndex(result => result.status === 'fulfilled'), input = [a, b][index], db = contenders[index];
    const winner = results[index] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveArchiveBudgetAttempt>>>;
    const claim = await claimArchiveBudgetAttempt(db, { ...identity, operationId: crypto.randomUUID(), attemptId: input.attemptId, expectedRevision: 0 });
    db.phase('work');
    const usage = createArchiveBudgetUsage(db, claim.grant!);
    await usage.batch([usage.prepare('SELECT 1')]);
    db.phase('control');
    await settleArchiveBudgetAttempt(db, { operationId: crypto.randomUUID(), usage: usage.seal() });
    await finalizeArchiveBudgetControl(db, { operationId: crypto.randomUUID(), usage: db.sealControlUsage(winner.value.controlGrant!) });
    await expect(reserveArchiveBudgetAttempt(app.db, budgetReservation(identity, { envelope: { reads: 101, writes: 81 } }))).rejects.toThrow('EXHAUSTED');
    const settledWork = await pool();
    await reserveArchiveBudgetAttempt(app.db, budgetReservation(identity, { pool: 'cleanup', envelope: { reads: 50, writes: 50 } }));
    expect(await pool('cleanup')).toMatchObject({ held_reads: 50, held_writes: 50 });
    expect(await pool()).toEqual(settledWork);
    expect(await receiptCount()).toBe(5);
  });

  it('rolls back both pool deltas when the receipt fails and copies caller inputs before awaiting', async () => {
    const { identity } = await openBudgetFixture(app), before = await pool('control');
    await app.db.prepare("CREATE TRIGGER fail_budget_receipt BEFORE INSERT ON archive_budget_receipts WHEN NEW.kind='reserve' BEGIN SELECT RAISE(ABORT,'receipt_failure'); END").run();
    await expect(reserveArchiveBudgetAttempt(app.db, budgetReservation(identity))).rejects.toThrow('receipt_failure');
    expect(await pool('control')).toEqual(before);
    expect(await pool()).toMatchObject({ held_reads: 0, held_writes: 0 });
    await app.db.prepare('DROP TRIGGER fail_budget_receipt').run();
    const input = { ...budgetReservation(identity), envelope: { reads: 1000, writes: 1000 }, overhead: { reads: 1000, writes: 100 } }, originalId = input.attemptId;
    const pending = reserveArchiveBudgetAttempt(app.db, input);
    input.attemptId = 'mutated'; input.envelope.reads = 99999; input.overhead.writes = 9999;
    expect((await pending).result.attemptId).toBe(originalId);
    expect(await pool()).toMatchObject({ held_reads: 1000, held_writes: 1000 });
    expect(await pool('control')).toMatchObject({ charged_writes: 101 });
  });

  it('issues one execution grant and charges only fully observed work while retaining fixed overhead', async () => {
    const { identity, input } = await reserved();
    const claimInput = { ...identity, operationId: crypto.randomUUID(), attemptId: input.attemptId, expectedRevision: 0 };
    const claimed = await claimArchiveBudgetAttempt(app.db, claimInput);
    expect(claimed.grant).toBeDefined();
    expect(await claimArchiveBudgetAttempt(app.db, claimInput)).toMatchObject({ replayed: true });
    expect((await claimArchiveBudgetAttempt(app.db, claimInput)).grant).toBeUndefined();
    const usage = createArchiveBudgetUsage(app.db, claimed.grant!);
    expect(() => createArchiveBudgetUsage(app.db, claimed.grant!)).toThrow('GRANT_CONSUMED_OR_INVALID');
    await app.db.prepare('CREATE TABLE budget_work(id INTEGER PRIMARY KEY)').run();
    await usage.batch([usage.prepare('INSERT INTO budget_work VALUES(1)'), usage.prepare('SELECT * FROM budget_work')]);
    const sealed = usage.seal(), observed = readArchiveBudgetUsage(sealed), operationId = crypto.randomUUID();
    expect(observed.coverageComplete).toBe(true);
    const settled = await settleArchiveBudgetAttempt(app.db, { operationId, usage: sealed });
    expect(settled.result).toMatchObject({ state: 'settled', charged: { reads: observed.rowsRead, writes: observed.rowsWritten } });
    expect(await pool()).toMatchObject({ held_reads: 0, held_writes: 0, charged_reads: observed.rowsRead, charged_writes: observed.rowsWritten });
    expect(await pool('control')).toMatchObject({ charged_reads: 1001, charged_writes: 101 });
    expect((await settleArchiveBudgetAttempt(app.db, { operationId, usage: sealed })).replayed).toBe(true);
    await expect(settleArchiveBudgetAttempt(app.db, { operationId: crypto.randomUUID(), usage: { ...observed } })).rejects.toThrow('UNTRUSTED_EVIDENCE');
    await expect(app.db.batch([archiveBudgetExecutionFence(app.db, observed), app.db.prepare('INSERT INTO budget_work VALUES(2)')])).rejects.toThrow();
    expect(await app.db.prepare('SELECT count(*) n FROM budget_work').first('n')).toBe(1);
  });

  it('does not reissue a grant when an identical claim wins during the original caller snapshot', async () => {
    const { identity, input } = await reserved(), claimInput = { ...identity, operationId: crypto.randomUUID(), attemptId: input.attemptId, expectedRevision: 0 };
    let winner: Awaited<ReturnType<typeof claimArchiveBudgetAttempt>> | undefined;
    const delayed: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (!winner && statements.some(statement => statement.sql.startsWith("UPDATE archive_budget_attempts SET state='executing'"))) winner = await claimArchiveBudgetAttempt(app.db, claimInput);
      return app.db.batch<T>(statements);
    } };
    const result = await claimArchiveBudgetAttempt(delayed, claimInput);
    expect(winner?.grant).toBeDefined();
    expect(result.replayed).toBe(true);
    expect(result.grant).toBeUndefined();
    expect(await receiptCount()).toBe(3);
  });

  it('burns incomplete usage and records concurrent oversized accounting after dispatch closes', async () => {
    await app.close();
    const legacy = await legacyBudgetFixture(['executing', 'executing']); app = legacy.app;
    const { identity } = legacy;
    const exaggerated: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const results = await app.db.batch<T>(statements);
      return results.map((row, index) => ({ ...row, meta: { ...row.meta, rows_read: index ? Number.MAX_SAFE_INTEGER : 0, rows_written: index ? Number.MAX_SAFE_INTEGER : 0 } }));
    } };
    const usages = legacy.grants.map(grant => createArchiveBudgetUsage(exaggerated, grant!));
    for (const usage of usages) await expect(usage.batch([usage.prepare('SELECT 1')])).rejects.toThrow('COST_OVERRUN');
    const closed = usages.map(usage => usage.seal());
    await installBudgetControlMigration(app);
    for (const usage of closed) await settleArchiveBudgetAttempt(app.db, { operationId: crypto.randomUUID(), usage });
    expect(await pool()).toMatchObject({ held_reads: 0, held_writes: 0, charged_reads: Number.MAX_SAFE_INTEGER, charged_writes: Number.MAX_SAFE_INTEGER, accounting_saturated: 1 });
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'accounting_saturated' });
    const rows = await app.db.prepare('SELECT observed_reads,charge_reads FROM archive_budget_attempts').all();
    expect(rows.results).toEqual([{ observed_reads: Number.MAX_SAFE_INTEGER, charge_reads: Number.MAX_SAFE_INTEGER }, { observed_reads: Number.MAX_SAFE_INTEGER, charge_reads: Number.MAX_SAFE_INTEGER }]);
    await expect(reserveArchiveBudgetAttempt(app.db, budgetReservation(identity))).rejects.toThrow('CONTROL_PENDING');
  });

  it('settles missing metadata conservatively and never treats abandonment as a refund', async () => {
    await app.close();
    const legacy = await legacyBudgetFixture(['executing', 'reserved']); app = legacy.app;
    const { identity } = legacy, [input, abandoned] = legacy.attempts;
    const missing: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      const results = await app.db.batch<T>(statements);
      return results.map((row, index) => index ? { ...row, meta: undefined } : row);
    } };
    const usage = createArchiveBudgetUsage(missing, legacy.grants[0]!);
    await expect(usage.batch([usage.prepare('SELECT 1')])).rejects.toThrow('METADATA_UNAVAILABLE');
    await installBudgetControlMigration(app);
    const settled = await settleArchiveBudgetAttempt(app.db, { operationId: crypto.randomUUID(), usage: usage.seal() });
    expect(settled.result).toMatchObject({ state: 'unknown', charged: input.envelope });
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'unknown_usage' });
    await abandonArchiveBudgetAttempt(app.db, { ...identity, operationId: crypto.randomUUID(), attemptId: abandoned.attemptId, expectedRevision: 0, reasonCode: 'LOST_RESPONSE' });
    expect(await pool()).toMatchObject({ held_reads: 0, held_writes: 0, charged_reads: 2000, charged_writes: 2000 });
  });

  it('preserves accounting under maintenance and rejects old-generation claims, receipts and settlement', async () => {
    const { identity, input } = await reserved(), before = await pool();
    const claimInput = { ...identity, operationId: crypto.randomUUID(), attemptId: input.attemptId, expectedRevision: 0 };
    await app.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    await expect(claimArchiveBudgetAttempt(app.db, claimInput)).rejects.toThrow('backup_maintenance');
    expect(await pool()).toEqual(before);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    const claim = await claimArchiveBudgetAttempt(app.db, claimInput), usage = createArchiveBudgetUsage(app.db, claim.grant!);
    await usage.batch([usage.prepare('SELECT 1')]); const sealed = usage.seal();
    await app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'restore_unreconciled' });
    await expect(claimArchiveBudgetAttempt(app.db, claimInput)).rejects.toThrow('STALE');
    await expect(settleArchiveBudgetAttempt(app.db, { operationId: crypto.randomUUID(), usage: sealed })).rejects.toThrow('STALE');
    expect(await pool()).toEqual(before);
  });

  it('rejects non-current UTC allocation and cannot reset a closed day by opening a new epoch', async () => {
    const { input, identity } = await openBudgetFixture(app);
    const runtime = await readArchiveBudgetRuntime(app.db);
    await closeArchiveBudgetEpoch(app.db, { ...identity, operationId: crypto.randomUUID(), expectedRevision: runtime.revision, reasonCode: 'STOP_TEST' });
    const closed = await readArchiveBudgetRuntime(app.db);
    await expect(openArchiveBudgetDay(app.db, { ...input, operationId: crypto.randomUUID(), expectedRevision: closed.revision, epochId: crypto.randomUUID() })).rejects.toThrow();
    const nextDay = new Date(`${input.utcDay}T00:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    await expect(openArchiveBudgetDay(app.db, { ...input, operationId: crypto.randomUUID(), expectedRevision: closed.revision, epochId: crypto.randomUUID(), utcDay: nextDay.toISOString().slice(0, 10) })).rejects.toThrow('STALE');
    expect(await readArchiveBudgetRuntime(app.db)).toEqual(closed);
  });
});
