import { openArchiveBudgetDay, readArchiveBudgetRuntime, reserveArchiveBudgetAttempt, type ArchiveBudgetIdentity, type ArchiveBudgetPool } from '../worker/archive-budget-ledger';
import type { ArchiveBudgetCost } from '../worker/archive-budget-usage';
import type { TestRuntime } from './runtime';
import { advanceHistoryBackfill } from '../worker/history-lookup';

export async function openBudgetFixture(app: TestRuntime, pools: Record<ArchiveBudgetPool, ArchiveBudgetCost> = {
  work: { reads: 100_000, writes: 100_000 }, cleanup: { reads: 10_000, writes: 10_000 }, control: { reads: 10_000, writes: 10_000 },
}) {
  const native = await app.runtime.getD1Database('CRM_DB');
  for (let step = 0; (await advanceHistoryBackfill(native)).state !== 'ready'; step++) if (step >= 12) throw new Error('Fixture history backfill did not finish');
  const runtime = await readArchiveBudgetRuntime(app.db);
  const identity: ArchiveBudgetIdentity = { epochId: crypto.randomUUID(), executionGeneration: runtime.execution_generation,
    utcDay: (await app.db.prepare("SELECT strftime('%Y-%m-%d','now') AS day").first<string>('day'))! };
  const input = { ...identity, operationId: crypto.randomUUID(), expectedRevision: runtime.revision, scopeId: 'synthetic-test-account', policyVersion: 'test-policy',
    envelopeVersion: 'test-envelope', allocationSha256: 'a'.repeat(64), actorId: 'test-owner', reasonCode: 'TEST_ALLOCATION', pools, bootstrap: { reads: 1, writes: 1 } };
  const receipt = await openArchiveBudgetDay(app.db, input);
  return { identity, input, receipt };
}

export function budgetReservation(identity: ArchiveBudgetIdentity, overrides: Partial<Parameters<typeof reserveArchiveBudgetAttempt>[1]> = {}) {
  return { ...identity, operationId: String(crypto.randomUUID()), attemptId: String(crypto.randomUUID()), pool: 'work' as const, workKeySha256: 'b'.repeat(64), targetRevision: 0,
    envelope: { reads: 1000, writes: 1000 }, overhead: { reads: 1000, writes: 100 }, maximumStatements: 40, ...overrides };
}
