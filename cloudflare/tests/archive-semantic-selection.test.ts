import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification, type MonthlySemanticRunHandle, type MonthlySemanticRunSelection } from '../worker/archive-semantic-runner';
import type { ArchiveRecord } from '../shared/archive-format';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

let app: TestRuntime, handle: MonthlySemanticRunHandle;
beforeEach(async () => {
  app = await createRuntime({ bindings: {} });
  const at = '2025-01-01T00:00:00.000Z', key = randomBytes(32).toString('base64'), parts = new Map<string, Uint8Array>();
  const records: ArchiveRecord[] = [
    { table: 'centers', key: 'selection-center', row: { id: 'selection-center', name: 'Synthetic selection', timezone: 'UTC', created_at: at } },
    { table: 'students', key: 'selection-student', row: { id: 'selection-student', center_id: 'selection-center', student_code: 'SELECT', first_name: 'Synthetic', last_name: 'Selection', subjects: '["Math"]', active: 1, created_at: at, updated_at: at } },
  ];
  const source = await createArchive(key, { archiveId: crypto.randomUUID(), centerId: 'selection-center', month: '2025-01', timezone: 'UTC', kind: 'monthly',
    createdAt: '2025-02-01T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [23], references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] } }, records,
    async (part, bytes) => { parts.set(part.objectKey, bytes); });
  const reference = { archiveId: source.manifest.archiveId, kind: source.manifest.kind, manifestObjectKey: source.objectKey, manifestSha256: source.sha256 };
  const target = await D1ArchiveSemanticStaging.create(app.db, key, reference);
  await target.registerManifest(reference, source.encrypted);
  for (const part of source.manifest.parts) await target.stageEncryptedPart(reference.archiveId, part.index, parts.get(part.objectKey)!);
  const snapshot = await target.freeze();
  handle = await startMonthlySemanticVerification(app.db, { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
});
afterEach(async () => { await app.close(); });

const saved = () => app.db.prepare('SELECT * FROM archive_semantic_runs WHERE run_id=?').bind(handle.runId).first<Record<string, unknown>>();
const life = () => app.db.prepare('SELECT * FROM archive_semantic_lifecycle WHERE verification_id=? AND generation=?').bind(handle.verificationId, handle.generation).first();

describe('monthly runner expected selection', () => {
  it('rejects malformed selection before any database preparation or query', async () => {
    let touched = false;
    const untouched: ArchiveStagingDatabase<IsolatedStatement> = { prepare() { touched = true; throw new Error('Unexpected database preparation'); }, async batch<T>() { touched = true; return [] as { results: T[] }[]; } };
    const invalid = [{ revision: -1, phase: 'records' }, { revision: 0.5, phase: 'records' }, { revision: Number.MAX_SAFE_INTEGER + 1, phase: 'records' }, { revision: 0, phase: 'other' }, null];
    for (const selection of invalid) await expect(advanceMonthlySemanticVerification(untouched, handle, selection as MonthlySemanticRunSelection)).rejects.toThrow('SELECTION_INVALID');
    expect(touched).toBe(false);
  });

  it.each([{ revision: 1, phase: 'records' }, { revision: 0, phase: 'visits' } satisfies MonthlySemanticRunSelection])('rejects stale initial revision/phase without lease, progress, or invalidation: %s', async selection => {
    const before = await saved(), priorLife = await life();
    await expect(advanceMonthlySemanticVerification(app.db, handle, selection as MonthlySemanticRunSelection)).rejects.toThrow('STALE_SELECTION');
    expect(await saved()).toEqual(before);
    expect(await life()).toEqual(priorLife);
    expect(await app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(handle.verificationId).first('status')).toBe('frozen');
  });

  it('copies a matching selection before awaiting and preserves callers that omit it', async () => {
    const selection: MonthlySemanticRunSelection = { revision: 0, phase: 'records' };
    const pending = advanceMonthlySemanticVerification(app.db, handle, selection);
    selection.revision = 999; selection.phase = 'complete';
    const first = await pending;
    expect(first).toMatchObject({ status: 'pending', revision: 1 });
    expect(first.queries).toBeLessThanOrEqual(40);
    const next = await advanceMonthlySemanticVerification(app.db, handle);
    expect(next).toMatchObject({ status: 'pending', revision: 2 });
    expect(next.queries).toBeLessThanOrEqual(40);
  });

  it.each(['revision', 'phase'])('rejects a competing %s change between selection read and lease CAS without advancing the newer step', async change => {
    let winner: Record<string, unknown> | null = null, winnerLife: unknown;
    const raced: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (!winner && statements.some(statement => statement.sql.startsWith("UPDATE archive_semantic_runs SET status='running'"))) {
        if (change === 'revision') expect((await advanceMonthlySemanticVerification(app.db, handle)).revision).toBe(1);
        else await app.db.prepare("UPDATE archive_semantic_runs SET phase='visits' WHERE run_id=?").bind(handle.runId).run();
        winner = await saved(); winnerLife = await life();
      }
      return app.db.batch<T>(statements);
    } };
    await expect(advanceMonthlySemanticVerification(raced, handle, { revision: 0, phase: 'records' })).rejects.toThrow('STALE_SELECTION');
    expect(winner).not.toBeNull();
    expect(await saved()).toEqual(winner);
    expect(await life()).toEqual(winnerLife);
  });

  it('returns busy for a current selection with an existing live lease', async () => {
    await app.db.prepare("UPDATE archive_semantic_runs SET status='running',lease_token='selection-live-lease',lease_expires_at=? WHERE run_id=?")
      .bind(new Date(Date.now() + 30_000).toISOString(), handle.runId).run();
    const before = await saved();
    expect(await advanceMonthlySemanticVerification(app.db, handle, { revision: 0, phase: 'records' })).toMatchObject({ status: 'busy', revision: 0, phase: 'records' });
    expect(await saved()).toEqual(before);
  });
});
