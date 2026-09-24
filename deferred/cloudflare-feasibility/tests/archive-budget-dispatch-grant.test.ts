import { afterEach, describe, expect, it } from 'vitest';
import { takeArchiveBudgetDispatchGrant } from '../worker/archive-budget-dispatch-grant';
import { claimArchiveBudgetAttempt, reserveArchiveBudgetAttempt, type ArchiveBudgetClaimTarget } from '../worker/archive-budget-ledger';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { budgetReservation, openBudgetFixture } from './archive-budget-fixture';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

const runtimes: TestRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(app => app.close())); });
async function fixture() {
  const app = await createRuntime({ bindings: {} }); runtimes.push(app);
  const { identity } = await openBudgetFixture(app);
  return { app, identity, input: budgetReservation(identity) };
}
async function evidence(app: TestRuntime) {
  const results = await app.db.batch([
    app.db.prepare('SELECT * FROM archive_budget_attempts ORDER BY attempt_id'),
    app.db.prepare('SELECT * FROM archive_budget_pools ORDER BY utc_day,pool'),
    app.db.prepare('SELECT * FROM archive_budget_receipts ORDER BY operation_id'),
  ]);
  return results.map(result => result.results);
}
function expectedWork(input: ReturnType<typeof budgetReservation>): ArchiveBudgetClaimTarget {
  return { workKeySha256: input.workKeySha256, targetRevision: input.targetRevision, envelope: { ...input.envelope }, maximumStatements: input.maximumStatements };
}

describe('process-local archive dispatch reservation grants', () => {
  it('issues one grant for a fresh reservation and no grant for exact replay', async () => {
    const { app, input } = await fixture();
    const result = await reserveArchiveBudgetAttempt(app.db, input);
    expect(result.replayed).toBe(false);
    expect(result.dispatchGrant).toEqual({ attemptId: input.attemptId });
    expect(Object.isFrozen(result.dispatchGrant)).toBe(true);
    const before = await evidence(app);
    const replay = await reserveArchiveBudgetAttempt(app.db, input);
    expect(replay.replayed).toBe(true);
    expect(replay.dispatchGrant).toBeUndefined();
    expect(await evidence(app)).toEqual(before);

    const captured = takeArchiveBudgetDispatchGrant(app.db, result.dispatchGrant);
    expect(captured).toEqual({ reservationOperationId: input.operationId, attemptId: input.attemptId, epochId: input.epochId, executionGeneration: input.executionGeneration, utcDay: input.utcDay, pool: input.pool, workKeySha256: input.workKeySha256, targetRevision: input.targetRevision, envelope: input.envelope, overhead: input.overhead, maximumStatements: input.maximumStatements });
    expect(() => takeArchiveBudgetDispatchGrant(app.db, result.dispatchGrant)).toThrow('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
    expect((await reserveArchiveBudgetAttempt(app.db, input)).dispatchGrant).toBeUndefined();
  });

  it('issues only one grant when identical reservations race', async () => {
    const { app, input } = await fixture();
    const results = await Promise.all([reserveArchiveBudgetAttempt(app.db, input), reserveArchiveBudgetAttempt(app.db, input)]);
    expect(results.filter(result => result.dispatchGrant)).toHaveLength(1);
    expect(results.filter(result => result.replayed)).toHaveLength(1);
    const winner = results.find(result => result.dispatchGrant)!;
    expect(takeArchiveBudgetDispatchGrant(app.db, winner.dispatchGrant).attemptId).toBe(input.attemptId);
    expect(await app.db.prepare('SELECT count(*) AS n FROM archive_budget_attempts').first('n')).toBe(1);
    expect(await app.db.prepare("SELECT count(*) AS n FROM archive_budget_receipts WHERE kind='reserve'").first('n')).toBe(1);
    expect(await app.db.prepare("SELECT held_reads,held_writes FROM archive_budget_pools WHERE pool='work'").first()).toEqual({ held_reads: input.envelope.reads, held_writes: input.envelope.writes });
  });

  it('rejects serialized, copied, inherited and fabricated grants without consuming the original', async () => {
    const { app, input } = await fixture();
    const result = await reserveArchiveBudgetAttempt(app.db, input);
    const grant = result.dispatchGrant!;
    const before = await evidence(app);
    for (const invalid of [JSON.parse(JSON.stringify(grant)), { ...grant }, Object.create(grant), { attemptId: input.attemptId }, input.attemptId, null, undefined]) {
      expect(() => takeArchiveBudgetDispatchGrant(app.db, invalid)).toThrow('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
    }
    expect(takeArchiveBudgetDispatchGrant(app.db, grant).attemptId).toBe(input.attemptId);
    expect(await evidence(app)).toEqual(before);
  });

  it('rejects another database or adapter identity before consuming the source grant', async () => {
    const { app, input } = await fixture();
    const other = await createRuntime({ bindings: {} }); runtimes.push(other);
    const { dispatchGrant } = await reserveArchiveBudgetAttempt(app.db, input);
    const adapter: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), batch: statements => app.db.batch(statements) };
    expect(() => takeArchiveBudgetDispatchGrant(other.db, dispatchGrant)).toThrow('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
    expect(() => takeArchiveBudgetDispatchGrant(adapter, dispatchGrant)).toThrow('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
    expect(takeArchiveBudgetDispatchGrant(app.db, dispatchGrant).attemptId).toBe(input.attemptId);
    expect(() => takeArchiveBudgetDispatchGrant(app.db, dispatchGrant)).toThrow('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
    expect(await other.db.prepare('SELECT count(*) AS n FROM archive_budget_attempts').first('n')).toBe(0);
  });

  it('captures immutable reservation authority before awaiting caller input mutations', async () => {
    const { app, input: reservation } = await fixture();
    const input = { ...reservation, envelope: { ...reservation.envelope }, overhead: { ...reservation.overhead } };
    const original = structuredClone(input);
    const pending = reserveArchiveBudgetAttempt(app.db, input);
    input.operationId = crypto.randomUUID(); input.attemptId = 'changed-attempt'; input.workKeySha256 = 'c'.repeat(64);
    input.targetRevision++; input.envelope.reads = 1; input.envelope.writes = 2;
    input.overhead.reads = 7; input.overhead.writes = 9; input.maximumStatements = 2; input.pool = 'cleanup';
    const result = await pending;
    const captured = takeArchiveBudgetDispatchGrant(app.db, result.dispatchGrant);
    expect(captured).toEqual({ reservationOperationId: original.operationId, attemptId: original.attemptId, epochId: original.epochId, executionGeneration: original.executionGeneration, utcDay: original.utcDay, pool: original.pool, workKeySha256: original.workKeySha256, targetRevision: original.targetRevision, envelope: original.envelope, overhead: original.overhead, maximumStatements: original.maximumStatements });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.envelope)).toBe(true);
    expect(Object.isFrozen(captured.overhead)).toBe(true);
    expect(Reflect.set(captured, 'attemptId', 'forged')).toBe(false);
    expect(Reflect.set(captured.envelope, 'reads', 0)).toBe(false);
    expect(Reflect.set(captured.overhead, 'writes', 0)).toBe(false);
    expect(await app.db.prepare('SELECT attempt_id,work_key_sha256,target_revision,reads_envelope,writes_envelope,maximum_statements FROM archive_budget_attempts').first()).toEqual({ attempt_id: original.attemptId, work_key_sha256: original.workKeySha256, target_revision: original.targetRevision, reads_envelope: original.envelope.reads, writes_envelope: original.envelope.writes, maximum_statements: original.maximumStatements });
  });

  it('preserves a committed reservation after a lost reply without reconstructing its dispatch grant', async () => {
    const { app, input } = await fixture();
    let loseReply = true;
    const db: ArchiveStagingDatabase<IsolatedStatement> = {
      prepare: sql => app.db.prepare(sql),
      async batch<T>(statements: IsolatedStatement[]) {
        const results = await app.db.batch<T>(statements);
        if (loseReply && statements.some(statement => statement.sql.startsWith('INSERT INTO archive_budget_attempts'))) {
          loseReply = false;
          throw new Error('lost_reservation_reply');
        }
        return results;
      },
    };
    await expect(reserveArchiveBudgetAttempt(db, input)).rejects.toThrow('lost_reservation_reply');
    const before = await evidence(app);
    expect(before[0]).toHaveLength(1);
    expect(before[0][0]).toMatchObject({ attempt_id: input.attemptId, state: 'reserved', revision: 0, execution_token_sha256: null });
    const replay = await reserveArchiveBudgetAttempt(db, input);
    expect(replay).toMatchObject({ replayed: true, result: { attemptId: input.attemptId, state: 'reserved', revision: 0 } });
    expect(replay.dispatchGrant).toBeUndefined();
    expect(() => takeArchiveBudgetDispatchGrant(db, replay.result)).toThrow('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
    expect(() => takeArchiveBudgetDispatchGrant(db, { attemptId: input.attemptId })).toThrow('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
    expect(await evidence(app)).toEqual(before);
  });
});

describe('archive claim exact work binding', () => {
  const mismatches: [string, (target: ArchiveBudgetClaimTarget) => ArchiveBudgetClaimTarget][] = [
    ['work key', target => ({ ...target, workKeySha256: 'c'.repeat(64) })],
    ['target revision', target => ({ ...target, targetRevision: target.targetRevision + 1 })],
    ['read envelope', target => ({ ...target, envelope: { ...target.envelope, reads: target.envelope.reads + 1 } })],
    ['write envelope', target => ({ ...target, envelope: { ...target.envelope, writes: target.envelope.writes + 1 } })],
    ['statement ceiling', target => ({ ...target, maximumStatements: target.maximumStatements - 1 })],
  ];
  it.each(mismatches)('rejects a different %s without changing the reserved attempt or accounting', async (_label, mutate) => {
    const { app, identity, input } = await fixture();
    await reserveArchiveBudgetAttempt(app.db, input);
    const before = await evidence(app), target = expectedWork(input);
    const claim = { ...identity, operationId: crypto.randomUUID(), attemptId: input.attemptId, expectedRevision: 0, expectedWork: target };
    await expect(claimArchiveBudgetAttempt(app.db, { ...claim, expectedWork: mutate(target) })).rejects.toThrow('ARCHIVE_BUDGET_STALE');
    expect(await evidence(app)).toEqual(before);
    const accepted = await claimArchiveBudgetAttempt(app.db, claim);
    expect(accepted.grant).toBeDefined();
    expect(await app.db.prepare('SELECT state,revision FROM archive_budget_attempts WHERE attempt_id=?').bind(input.attemptId).first()).toEqual({ state: 'executing', revision: 1 });
    const after = await evidence(app);
    expect(await claimArchiveBudgetAttempt(app.db, claim)).toMatchObject({ replayed: true });
    expect((await claimArchiveBudgetAttempt(app.db, claim)).grant).toBeUndefined();
    await expect(claimArchiveBudgetAttempt(app.db, { ...claim, expectedWork: mutate(target) })).rejects.toThrow('ARCHIVE_BUDGET_OPERATION_CONFLICT');
    expect(await evidence(app)).toEqual(after);
  });

  it('captures expected work before awaiting and rejects changed work on successful receipt replay', async () => {
    const { app, identity, input } = await fixture();
    await reserveArchiveBudgetAttempt(app.db, input);
    const target = { ...expectedWork(input), envelope: { ...input.envelope } };
    const claim = { ...identity, operationId: crypto.randomUUID(), attemptId: input.attemptId, expectedRevision: 0, expectedWork: target };
    const original = structuredClone(claim), pending = claimArchiveBudgetAttempt(app.db, claim);
    target.workKeySha256 = 'c'.repeat(64); target.targetRevision++; target.envelope.reads = 1; target.envelope.writes = 1; target.maximumStatements = 2;
    expect((await pending).grant).toBeDefined();
    expect((await claimArchiveBudgetAttempt(app.db, original)).replayed).toBe(true);
    const before = await evidence(app);
    await expect(claimArchiveBudgetAttempt(app.db, claim)).rejects.toThrow('ARCHIVE_BUDGET_OPERATION_CONFLICT');
    expect(await evidence(app)).toEqual(before);
  });
});
