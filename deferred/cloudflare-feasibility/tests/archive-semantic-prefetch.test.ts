import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ARCHIVE_TABLES, type ArchiveMetadata, type ArchiveRecord } from '../shared/archive-format';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { createMonthlySemanticLookup } from '../worker/archive-semantic-prefetch';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

const key = randomBytes(32).toString('base64'), at = '2025-01-02T00:00:00.000Z';
let app: TestRuntime;
let native: Awaited<ReturnType<typeof nativeSemanticFixture>>;
const base = (): ArchiveRecord[] => [
  { table: 'centers', key: 'test-center', row: { id: 'test-center', name: 'Synthetic center', timezone: 'UTC', created_at: at } },
  ...['a', 'b', 'c'].map((id): ArchiveRecord => ({ table: 'students', key: id, row: { id, center_id: 'test-center', student_code: id, first_name: 'Synthetic', last_name: 'Student', subjects: '["Math"]', active: 1, created_at: at, updated_at: at } })),
];
async function staging(records = base(), meta: Partial<ArchiveMetadata> = {}) {
  const metadata: ArchiveMetadata = { centerId: 'test-center', month: '2025-01', timezone: 'UTC', kind: 'monthly', createdAt: '2025-02-03T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [23], references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] }, ...meta, archiveId: crypto.randomUUID() };
  const objects = new Map<string, Uint8Array>();
  const result = await createArchive(key, metadata, records, async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const reference = { archiveId: metadata.archiveId, kind: metadata.kind, manifestObjectKey: result.objectKey, manifestSha256: result.sha256 };
  const target = await D1ArchiveSemanticStaging.create(app.db, key, reference);
  await target.registerManifest(reference, result.encrypted);
  for (const part of result.manifest.parts) await target.stageEncryptedPart(result.manifest.archiveId, part.index, objects.get(part.objectKey)!);
  const snapshot = await target.freeze();
  return { target, snapshot, reference, identity: { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 } };
}
async function clear(target: Awaited<ReturnType<typeof staging>>['target']) {
  await target.discard();
  const handle = await D1ArchiveSemanticStaging.beginCleanup(app.db, target.handle);
  for (let page = 0; page < 200; page++) if ((await D1ArchiveSemanticStaging.cleanupPage(app.db, handle, 64)).complete) return;
  throw new Error('Cleanup exceeded test bound');
}
beforeAll(async () => { native = await nativeSemanticFixture(1, true); });
beforeEach(async () => { app = await createRuntime({ bindings: {} }); });
afterEach(async () => { await app.close(); });

describe('bounded monthly semantic point lookups', () => {
  it('uses one indexed query per page and batches bounded point reads with ordered missing results', async () => {
    const bundle = await staging(), batches: IsolatedStatement[][] = [];
    const database: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), batch: async statements => { batches.push(statements); return app.db.batch(statements); } };
    const { semanticStore: store } = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(database, bundle.identity);
    batches.length = 0;
    expect((await store.page({ archiveId: bundle.reference.archiveId, table: 'students', after: 'a', limit: 2 })).map(row => row.key)).toEqual(['b', 'c']);
    expect(batches.map(batch => batch.length)).toEqual([1]);
    const page = batches[0][0];
    const plan = await app.db.prepare(`EXPLAIN QUERY PLAN ${page.sql}`).bind(...page.args).all<{ detail: string }>();
    const details = plan.results.map(row => row.detail).join(' ');
    expect(details).toMatch(/SEARCH r USING (?:COVERING )?(?:INDEX|PRIMARY KEY)/);
    expect(details).toContain('verification_id=? AND generation=? AND archive_id=? AND table_name=? AND record_key>?');
    expect(await store.page({ archiveId: bundle.reference.archiveId, table: 'students', after: 'z', limit: 2 })).toEqual([]);
    batches.length = 0;
    const many = await store.getMany(['c', 'missing', 'a', 'c'].map(key => ({ archiveId: bundle.reference.archiveId, table: 'students', key })));
    expect(many.map(row => row?.key ?? null)).toEqual(['c', null, 'a', 'c']);
    expect(batches.map(batch => batch.length)).toEqual([4]);
    const point = batches[0][0];
    const pointPlan = await app.db.prepare(`EXPLAIN QUERY PLAN ${point.sql}`).bind(...point.args).all<{ detail: string }>();
    expect(pointPlan.results.map(row => row.detail).join(' ')).toContain('verification_id=? AND generation=? AND archive_id=? AND table_name=? AND record_key=?');
    batches.length = 0;
    await expect(store.getMany(Array.from({ length: 13 }, () => ({ archiveId: bundle.reference.archiveId, table: 'students' as const, key: 'a' })))).rejects.toThrow('LOOKUP_BOUND');
    expect(await store.getMany([])).toEqual([]);
    expect(batches).toHaveLength(0);
  });

  it('keeps empty-page admission checks, snapshot tokens and session isolation', async () => {
    const first = await staging(), original = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(app.db, first.identity);
    await expect(D1ArchiveSemanticStaging.openFrozenBaseSnapshot(app.db, { ...first.identity, commitToken: crypto.randomUUID() })).rejects.toThrow('STALE');
    const database: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), batch: async <T,>(statements: IsolatedStatement[]) => {
      const result = await app.db.batch<T>(statements);
      return result.map(item => ({ ...item, meta: { ...item.meta, size_after: undefined } }));
    } };
    // Open while metadata is intact, then make the page itself lose its native size metadata.
    let strip = false;
    const guarded: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), batch: statements => strip ? database.batch(statements) : app.db.batch(statements) };
    const guardedStore = (await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(guarded, first.identity)).semanticStore;
    strip = true;
    await expect(guardedStore.page({ archiveId: first.reference.archiveId, table: 'students', after: 'z', limit: 1 })).rejects.toThrow('SIZE_UNAVAILABLE');
    await clear(first.target);
    const changed = base(); changed[1].row.first_name = 'Second session';
    const second = await staging(changed), current = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(app.db, second.identity);
    expect((await current.semanticStore.get(second.reference.archiveId, 'students', 'a'))!.row.first_name).toBe('Second session');
    await expect(original.semanticStore.get(first.reference.archiveId, 'students', 'a')).rejects.toThrow('STALE');
    await expect(original.semanticStore.getMany([{ archiveId: second.reference.archiveId, table: 'students', key: 'a' }])).rejects.toThrow('STALE');
    await app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    await expect(current.semanticStore.page({ archiveId: second.reference.archiveId, table: 'students', after: 'z', limit: 1 })).rejects.toThrow('STALE');
  });

  it('retains validated fallback lookups and memoizes missing rows within one step', async () => {
    const bundle = await staging(), { header, semanticStore } = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(app.db, bundle.identity);
    let gets = 0;
    const lookup = createMonthlySemanticLookup(header, { ...semanticStore, get: async (...args) => { gets++; return semanticStore.get(...args); } });
    await lookup.prefetch(base()[0]);
    expect((await lookup.find('students', 'a'))?.key).toBe('a');
    expect((await lookup.localGet('students', 'a'))?.key).toBe('a');
    expect(await lookup.find('students', 'missing')).toBeNull();
    expect(await lookup.localGet('students', 'missing')).toBeNull();
    expect(gets).toBe(2);
    await expect(lookup.find('students', '')).rejects.toThrow('Invalid historical evidence: INVALID_REFERENCE');
  });

  it('fits every phase including guardian-linked exceptional departure within 27 work statements including batch fences', async () => {
    const exceptional = native.records.find(record => record.table === 'attendance_events' && record.row.action === 'exceptional_departure' && record.row.guardian_id !== null && record.row.visit_id !== null)!;
    expect(exceptional).toBeDefined();
    const bundle = await staging(structuredClone(native.records), native.metadata);
    const handle = await startMonthlySemanticVerification(app.db, bundle.identity);
    let current = 0, maximum = 0, exceptionalCost = 0, finished = false;
    const phases = new Set<string>();
    const database: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), batch: async <T,>(statements: IsolatedStatement[]) => {
      // Execute an extra native SELECT for each collector fence, then preserve
      // the runner's normal result shape. Budget authority has separate tests.
      current += statements.length + 1;
      return (await app.db.batch<T>([app.db.prepare('SELECT 1 AS fence'), ...statements])).slice(1);
    } };
    for (let index = 0; index < 500; index++) {
      const before = await app.db.prepare('SELECT phase,cursor_json FROM archive_semantic_runs WHERE run_id=?').bind(handle.runId).first<{ phase: string; cursor_json: string }>();
      const cursor = JSON.parse(before!.cursor_json);
      const next = native.records.filter(record => record.table === 'attendance_events' && record.key > cursor.after).sort((a, b) => a.key.localeCompare(b.key))[0];
      current = 0;
      const result = await advanceMonthlySemanticVerification(database, handle);
      maximum = Math.max(maximum, current); phases.add(before!.phase);
      if (before!.phase === 'records' && ARCHIVE_TABLES[cursor.tableIndex] === 'attendance_events' && next?.key === exceptional.key) exceptionalCost = current;
      expect(current).toBeLessThanOrEqual(27);
      if (result.status === 'complete') { finished = true; break; }
      expect(result.status).toBe('pending');
    }
    expect(finished).toBe(true); expect(phases).toEqual(new Set(['records', 'visits', 'reviews']));
    expect(exceptionalCost).toBe(23); expect(maximum).toBe(23);
    current = 0; expect((await advanceMonthlySemanticVerification(database, handle)).status).toBe('complete'); expect(current).toBeLessThanOrEqual(27);
    expect(await app.db.prepare('SELECT count(*) n FROM visits').first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) n FROM history_record_locations').first('n')).toBe(0);
  });
});
