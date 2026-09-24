import type { ArchiveBudgetCost } from './archive-budget-usage';

export type ArchiveBudgetDispatchIdentity = Readonly<{
  reservationOperationId: string;
  attemptId: string;
  epochId: string;
  executionGeneration: string;
  utcDay: string;
  pool: 'work' | 'cleanup' | 'control';
  workKeySha256: string;
  targetRevision: number;
  envelope: ArchiveBudgetCost;
  overhead: ArchiveBudgetCost;
  maximumStatements: number;
}>;
export type ArchiveBudgetDispatchGrant = Readonly<{ attemptId: string }>;
type Record = { database: object; identity: ArchiveBudgetDispatchIdentity; consumed: boolean };
const grants = new WeakMap<object, Record>();

/** Internal ledger authority. Only a fresh winning reservation issues a grant. */
export function issueArchiveBudgetDispatchGrant(database: object, input: ArchiveBudgetDispatchIdentity): ArchiveBudgetDispatchGrant {
  const identity = Object.freeze({ ...input, envelope: Object.freeze({ ...input.envelope }), overhead: Object.freeze({ ...input.overhead }) });
  const grant = Object.freeze({ attemptId: identity.attemptId });
  grants.set(grant, { database, identity, consumed: false });
  return grant;
}

/** Synchronous consumption precedes hashing, target reads and every database call. */
export function takeArchiveBudgetDispatchGrant(database: object, value: unknown): ArchiveBudgetDispatchIdentity {
  const record = value && typeof value === 'object' ? grants.get(value) : undefined;
  if (!record || record.consumed || record.database !== database) throw new Error('ARCHIVE_BUDGET_DISPATCH_GRANT_INVALID');
  record.consumed = true;
  return record.identity;
}
