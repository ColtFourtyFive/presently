import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { startPublicationAbandonment, advancePublicationAbandonment, resumePublicationAbandonment } from '../worker/archive-publication-abandonment';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { createPublicationFixture, refreshPublicationProof, restorePublicationDatabase, snapshotPublicationDatabase } from './archive-publication-fixture';
import type { TestRuntime } from './runtime';

type Handle = Awaited<ReturnType<typeof startPublicationAbandonment>>;
type Fixture = { app: TestRuntime };
const runtimes: TestRuntime[] = [];
const JOBS = 'archive_publication_abandonment_jobs';
let base: {
  invalid: string; building: string; empty: string; partial: string; published: string;
  publicationId: string; evidence: Pick<Awaited<ReturnType<typeof createPublicationFixture>>, 'key' | 'objects' | 'reference'>;
};
const candidateTables = ['archive_publication_requests','archive_publication_records','archive_publication_parts'] as const;
const permanentTables = ['history_request_keys','attendance_events','attendance_corrections','audit_entries','visits','reviews'] as const;

beforeAll(async () => {
  let sourceSql = '';
  const seed = await nativeSemanticFixture(10, true, async app => { sourceSql = await snapshotPublicationDatabase(app); });
  const source = await createPublicationFixture({ ...seed, sourceSql });
  let committed: TestRuntime | undefined;
  try {
    const publication = await startMonthlyPublication(source.app.db, source.handle);
    const empty = await snapshotPublicationDatabase(source.app);
    const storage = { bucket: source.bucket, masterKey: source.key };
    await advanceMonthlyPublication(source.app.db, storage, publication, { expectedRevision: 0 });
    const partial = await snapshotPublicationDatabase(source.app);
    for (let step = 0; step < 100; step++) {
      const row = (await source.app.db.prepare('SELECT next_part,part_count,revision FROM archive_publication_builds WHERE publication_id=?').bind(publication.publicationId).first<{ next_part: number; part_count: number; revision: number }>())!;
      if (row.next_part === row.part_count) break;
      await advanceMonthlyPublication(source.app.db, storage, publication, { expectedRevision: row.revision });
      if (step === 99) throw new Error('Abandonment fixture did not finish indexing');
    }
    expect(await source.app.db.prepare('SELECT count(*) AS n FROM archive_publication_requests').first<number>('n')).toBeGreaterThan(8);
    const building = await snapshotPublicationDatabase(source.app);
    await source.staging.discard();
    expect(await source.app.db.prepare('SELECT state FROM archive_publication_builds WHERE publication_id=?').bind(publication.publicationId).first('state')).toBe('invalid');
    const invalid = await snapshotPublicationDatabase(source.app);
    committed = await restorePublicationDatabase(building);
    const bucket = await committed.runtime.getR2Bucket('BACKUP_BUCKET');
    for (const [key, bytes] of source.objects) await bucket.put(key, bytes);
    const revision = (await committed.db.prepare('SELECT revision FROM archive_publication_builds WHERE publication_id=?').bind(publication.publicationId).first<number>('revision'))!;
    expect((await advanceMonthlyPublication(committed.db, { bucket, masterKey: source.key }, publication, { expectedRevision: revision })).state).toBe('published');
    base = { invalid, building, empty, partial, published: await snapshotPublicationDatabase(committed), publicationId: publication.publicationId, evidence: { key: source.key, objects: source.objects, reference: source.reference } };
  } finally { await committed?.close(); await source.app.close(); }
}, 120_000);
afterEach(async () => { await Promise.all(runtimes.splice(0).map(app => app.close())); });

async function fixture(sql = base.invalid): Promise<Fixture> {
  const app = await restorePublicationDatabase(sql, { metrics: true }); runtimes.push(app); return { app };
}
async function rows(app: TestRuntime, tables: readonly string[]) {
  const entries = await Promise.all(tables.map(async table => [table, (await app.db.prepare(`SELECT * FROM ${table}`).all()).results.map(row => JSON.stringify(row)).sort()] as const));
  return Object.fromEntries(entries);
}
async function counts(app: TestRuntime) {
  const entries = await Promise.all(candidateTables.map(async table => [table, (await app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE publication_id=?`).bind(base.publicationId).first<number>('n'))!] as const));
  return Object.fromEntries(entries) as Record<typeof candidateTables[number], number>;
}
async function job(app: TestRuntime, handle: Handle) {
  return (await app.db.prepare(`SELECT * FROM ${JOBS} WHERE abandonment_id=?`).bind(handle.abandonmentId).first<{ state: string; phase: string; revision: number; execution_generation: string; lease_token: string | null; [key: string]: unknown }>())!;
}
async function advance(f: Fixture, handle: Handle, db = f.app.db) { return advancePublicationAbandonment(db, handle, { expectedRevision: (await job(f.app, handle)).revision }); }
async function finish(f: Fixture, handle: Handle) {
  for (let step = 0; step < 250; step++) {
    const current = await job(f.app, handle);
    if (current.state === 'complete') return current;
    if (current.state === 'blocked' || current.state === 'invalid' || current.state === 'paused') throw new Error(`Abandonment stopped: ${current.state}`);
    await advance(f, handle);
  }
  throw new Error('Abandonment did not finish');
}
async function untilPhase(f: Fixture, handle: Handle, phase: string) {
  for (let step = 0; step < 250; step++) {
    if ((await job(f.app, handle)).phase === phase) return;
    await advance(f, handle);
  }
  throw new Error(`Abandonment did not reach ${phase}`);
}
async function invalidate(app: TestRuntime) {
  await app.db.prepare("UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL").run();
}

// Independent worker-level contracts. Native DDL guard tests live separately.
describe('bounded invalid publication abandonment', () => {
  it('admits only an existing invalid never-published candidate', async () => {
    const f = await fixture(base.building), original = await rows(f.app, [...candidateTables, 'archive_publication_builds']);
    await expect(startPublicationAbandonment(f.app.db, base.publicationId)).rejects.toThrow();
    await expect(startPublicationAbandonment(f.app.db, 'missing-publication')).rejects.toThrow();
    expect(await rows(f.app, [...candidateTables, 'archive_publication_builds'])).toEqual(original);
    await invalidate(f.app);
    const handle = await startPublicationAbandonment(f.app.db, base.publicationId);
    expect(await startPublicationAbandonment(f.app.db, base.publicationId, handle.abandonmentId)).toEqual(handle);
    await expect(startPublicationAbandonment(f.app.db, base.publicationId, 'competing-abandonment')).rejects.toThrow();
    expect((await job(f.app, handle)).state).toBe('pending');
  });

  it('deletes only eight selected rows per page in foreign-key order and retains original ownership/provenance', async () => {
    const f = await fixture(), db = f.app.db;
    const original = await rows(f.app, [...permanentTables, 'archive_publication_builds']);
    const initial = await counts(f.app), removed = Object.fromEntries(candidateTables.map(table => [table, 0])) as Record<typeof candidateTables[number], number>;
    const handle = await startPublicationAbandonment(db, base.publicationId);
    const observedPhases: string[] = [];
    for (let step = 0; step < 250; step++) {
      const current = await job(f.app, handle); if (current.state === 'complete') break;
      const before = await counts(f.app); let prepared = 0;
      const measured: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = { prepare(sql) { prepared++; return db.prepare(sql); }, batch: db.batch.bind(db) };
      await advancePublicationAbandonment(measured, handle, { expectedRevision: current.revision });
      expect(prepared).toBeLessThanOrEqual(40);
      const after = await counts(f.app), delta = candidateTables.map(table => before[table] - after[table]);
      expect(delta.every(count => count >= 0)).toBe(true);
      expect(delta.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(8);
      expect(delta.filter(Boolean).length).toBeLessThanOrEqual(1);
      for (const [index, table] of candidateTables.entries()) if (delta[index]) { removed[table] += delta[index]; observedPhases.push(table); }
      if (delta[1]) expect(before.archive_publication_requests).toBe(0);
      if (delta[2]) { expect(before.archive_publication_requests).toBe(0); expect(before.archive_publication_records).toBe(0); }
      if (step === 249) throw new Error('Bounded abandonment did not finish');
    }
    expect(removed).toEqual(initial);
    expect(observedPhases.filter(table => table === 'archive_publication_requests').length).toBeGreaterThan(1);
    expect((await job(f.app, handle)).state).toBe('complete');
    expect(await rows(f.app, [...permanentTables, 'archive_publication_builds'])).toEqual(original);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await (await f.app.runtime.getR2Bucket('BACKUP_BUCKET')).list()).objects).toEqual([]);
  });

  it.each(['empty', 'partial'] as const)('handles a %s invalid candidate without changing its diagnostic build', async kind => {
    const f = await fixture(base[kind]); await invalidate(f.app);
    const original = await rows(f.app, ['archive_publication_builds','history_request_keys']);
    const handle = await startPublicationAbandonment(f.app.db, base.publicationId); await finish(f, handle);
    expect(Object.values(await counts(f.app))).toEqual([0, 0, 0]);
    expect(await rows(f.app, ['archive_publication_builds','history_request_keys'])).toEqual(original);
  });

  it('allows a fresh replacement candidate to claim the same archived requests after cleanup', async () => {
    const f = await fixture(), db = f.app.db, permanent = await rows(f.app, ['history_request_keys']);
    const abandonment = await startPublicationAbandonment(db, base.publicationId); await finish(f, abandonment);
    const fresh = await refreshPublicationProof(f.app, base.evidence);
    const bucket = await f.app.runtime.getR2Bucket('BACKUP_BUCKET'); for (const [key, bytes] of base.evidence.objects) await bucket.put(key, bytes);
    const replacement = await startMonthlyPublication(db, fresh.handle); expect(replacement.publicationId).not.toBe(base.publicationId);
    let revision = 0;
    for (let step = 0; step < 100; step++) {
      const result = await advanceMonthlyPublication(db, { bucket, masterKey: base.evidence.key }, replacement, { expectedRevision: revision }); revision = result.revision;
      if (result.state === 'published') break;
      if (step === 99) throw new Error('Replacement did not publish');
    }
    expect(await db.prepare('SELECT count(*) AS n FROM archive_publication_requests WHERE publication_id=?').bind(replacement.publicationId).first<number>('n')).toBeGreaterThan(8);
    expect(await db.prepare('SELECT status FROM archive_publication_availability WHERE publication_id=?').bind(replacement.publicationId).first('status')).toBe('ready');
    expect(await rows(f.app, ['history_request_keys'])).toEqual(permanent);
    expect(await db.prepare('SELECT state FROM archive_publication_builds WHERE publication_id=?').bind(base.publicationId).first('state')).toBe('invalid');
    const current = await job(f.app, abandonment);
    const before = await rows(f.app, [...candidateTables, 'archive_publications','archive_publication_availability']);
    expect(await advancePublicationAbandonment(db, abandonment, { expectedRevision: current.revision })).toMatchObject({ state: 'complete' });
    expect(await rows(f.app, [...candidateTables, 'archive_publications','archive_publication_availability'])).toEqual(before);
  }, 120_000);

  it('cannot clean committed evidence, including when its availability is unavailable or missing', async () => {
    const f = await fixture(base.published), db = f.app.db;
    const permanent = await rows(f.app, [...candidateTables,'archive_publications','history_request_keys']);
    await db.prepare("UPDATE archive_publication_availability SET status='unavailable' WHERE publication_id=?").bind(base.publicationId).run();
    await expect(startPublicationAbandonment(db, base.publicationId)).rejects.toThrow();
    for (const table of candidateTables) await expect(db.prepare(`DELETE FROM ${table} WHERE publication_id=?`).bind(base.publicationId).run()).rejects.toThrow();
    const missing = await fixture(await snapshotPublicationDatabase(f.app, { omitTables: ['archive_publication_availability'] }));
    await expect(startPublicationAbandonment(missing.app.db, base.publicationId)).rejects.toThrow();
    expect(await rows(f.app, [...candidateTables,'archive_publications','history_request_keys'])).toEqual(permanent);
    expect(await rows(missing.app, [...candidateTables,'archive_publications','history_request_keys'])).toEqual(permanent);
  });

  it.each(['claims missing', 'registry conflict', 'contradictory publication'] as const)('refuses %s without deleting any candidate row', async kind => {
    const pristine = await fixture(kind === 'contradictory publication' ? base.published : base.invalid);
    const sql = await snapshotPublicationDatabase(pristine.app, {
      omitTables: kind === 'claims missing' ? ['archive_publication_requests'] : [],
      transformRow(table, row) {
        if (kind === 'registry conflict' && table === 'history_request_keys' && row.source_kind !== 'audit') return { ...row, payload_hash: 'contradictory-permanent-fingerprint' };
        if (kind === 'contradictory publication' && table === 'archive_publication_builds') return { ...row, state: 'invalid' };
        return row;
      },
    });
    const f = await fixture(sql), original = await rows(f.app, [...candidateTables, ...permanentTables, 'archive_publication_builds','archive_publications']);
    await expect((async () => { const handle = await startPublicationAbandonment(f.app.db, base.publicationId); await finish(f, handle); })()).rejects.toThrow();
    expect(await rows(f.app, [...candidateTables, ...permanentTables, 'archive_publication_builds','archive_publications'])).toEqual(original);
  });

  it('ignores stale selections and requires an explicit generation rebind before resuming deletion', async () => {
    const f = await fixture(), db = f.app.db, handle = await startPublicationAbandonment(db, base.publicationId);
    await untilPhase(f, handle, 'delete_requests');
    const selected = await job(f.app, handle);
    await advancePublicationAbandonment(db, handle, { expectedRevision: selected.revision });
    const after = await rows(f.app, candidateTables);
    expect(await advancePublicationAbandonment(db, handle, { expectedRevision: selected.revision })).toMatchObject({ processed: 0 });
    expect(await rows(f.app, candidateTables)).toEqual(after);
    await db.prepare('UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1').run();
    const paused = await job(f.app, handle);
    expect(paused).toMatchObject({ state: 'paused', lease_token: null });
    expect(paused.execution_generation).toBe(handle.generation);
    await advancePublicationAbandonment(db, handle, { expectedRevision: paused.revision }).catch(() => undefined);
    expect(await rows(f.app, candidateTables)).toEqual(after);
    const resumed = await resumePublicationAbandonment(db, handle, { expectedRevision: paused.revision });
    expect(resumed.abandonmentId).toBe(handle.abandonmentId);
    expect(resumed.generation).not.toBe(handle.generation);
    expect(await job(f.app, resumed)).toMatchObject({ phase: 'inventory_requests', execution_generation: resumed.generation });
    expect(await rows(f.app, candidateTables)).toEqual(after);
    await advancePublicationAbandonment(db, handle, { expectedRevision: (await job(f.app, resumed)).revision }).catch(() => undefined);
    expect(await rows(f.app, candidateTables)).toEqual(after);
    await finish(f, resumed);
    expect(Object.values(await counts(f.app))).toEqual([0, 0, 0]);
  });

  it('rejects a same-count remaining-row substitution after partial deletion and reset', async () => {
    const original = await fixture(), handle = await startPublicationAbandonment(original.app.db, base.publicationId);
    await untilPhase(original, handle, 'delete_records'); await advance(original, handle);
    const remaining = await counts(original.app);
    expect(remaining.archive_publication_requests).toBe(0);
    expect(remaining.archive_publication_records).toBeGreaterThan(0);
    await original.app.db.prepare('UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1').run();
    let changed = false;
    const alteredSql = await snapshotPublicationDatabase(original.app, { transformRow(table, row) {
      if (table === 'archive_publication_records' && !changed) { changed = true; return { ...row, record_sha256: 'f'.repeat(64) }; }
      return row;
    } });
    expect(changed).toBe(true);
    const f = await fixture(alteredSql), before = await rows(f.app, [...candidateTables,...permanentTables,'archive_publication_builds']);
    expect(await counts(f.app)).toEqual(remaining);
    const resumed = await resumePublicationAbandonment(f.app.db, handle, { expectedRevision: (await job(f.app, handle)).revision });
    await expect(finish(f, resumed)).rejects.toThrow('REMAINING_INVENTORY_MISMATCH');
    expect(await rows(f.app, [...candidateTables,...permanentTables,'archive_publication_builds'])).toEqual(before);
    expect((await job(f.app, resumed)).phase).toBe('inventory_records');
  });

  it('rolls back a native deletion page when the final conditional checkpoint changes no row', async () => {
    const f = await fixture(), db = f.app.db, handle = await startPublicationAbandonment(db, base.publicationId);
    await untilPhase(f, handle, 'delete_requests');
    const before = await rows(f.app, [...candidateTables,'history_request_keys']);
    let intercepted = false;
    const fenced: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = {
      prepare: db.prepare.bind(db),
      async batch<T>(statements: ReturnType<typeof db.prepare>[]) {
        const destructive = statements.some(statement => /DELETE FROM archive_publication_(requests|records|parts)/.test(statement.sql));
        if (!destructive) return db.batch<T>(statements);
        let checkpoint = -1;
        statements.forEach((statement, index) => { if (statement.sql.includes(`UPDATE ${JOBS}`)) checkpoint = index; });
        if (checkpoint < 0) throw new Error('Test did not find atomic abandonment checkpoint');
        const statement = statements[checkpoint];
        const rewritten = statement.sql.replace(/WHERE (\w+\.)?abandonment_id=\?/, match => `WHERE 0 AND ${match.slice(6)}`);
        expect(rewritten).not.toBe(statement.sql); intercepted = true;
        const replaced = [...statements]; replaced[checkpoint] = db.prepare(rewritten).bind(...statement.args);
        return db.batch<T>(replaced);
      },
    };
    await expect(advancePublicationAbandonment(fenced, handle, { expectedRevision: (await job(f.app, handle)).revision })).rejects.toThrow();
    expect(intercepted).toBe(true);
    expect(await rows(f.app, [...candidateTables,'history_request_keys'])).toEqual(before);
    expect((await job(f.app, handle)).state).toBe('pending');
    await finish(f, handle);
  });

  it('returns saved progress after a lost deletion reply without deleting a second page on replay', async () => {
    const f = await fixture(), db = f.app.db, handle = await startPublicationAbandonment(db, base.publicationId);
    await untilPhase(f, handle, 'delete_requests');
    const selected = await job(f.app, handle), before = await counts(f.app); let drop = true;
    const lost: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = {
      prepare: db.prepare.bind(db),
      async batch<T>(statements: ReturnType<typeof db.prepare>[]) {
        const result = await db.batch<T>(statements);
        if (drop && statements.some(statement => /DELETE FROM archive_publication_(requests|records|parts)/.test(statement.sql))) { drop = false; throw new Error('simulated abandonment lost reply'); }
        return result;
      },
    };
    await expect(advancePublicationAbandonment(lost, handle, { expectedRevision: selected.revision })).rejects.toThrow('lost reply');
    const saved = await job(f.app, handle), committed = await rows(f.app, candidateTables), after = await counts(f.app);
    expect(before.archive_publication_requests - after.archive_publication_requests).toBe(8);
    expect(saved.revision).toBeGreaterThan(selected.revision);
    expect(await advancePublicationAbandonment(db, handle, { expectedRevision: selected.revision })).toMatchObject({ revision: saved.revision, processed: 0 });
    expect(await rows(f.app, candidateTables)).toEqual(committed);
    await finish(f, handle);
  });

  it('preserves one immutable completion diagnostic after a lost terminal reply', async () => {
    const f = await fixture(), db = f.app.db, handle = await startPublicationAbandonment(db, base.publicationId);
    await untilPhase(f, handle, 'delete_parts');
    for (let step = 0; step < 100 && (await counts(f.app)).archive_publication_parts; step++) await advance(f, handle);
    const selected = await job(f.app, handle); let dropped = false;
    const lost: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = {
      prepare: db.prepare.bind(db),
      async batch<T>(statements: ReturnType<typeof db.prepare>[]) {
        const result = await db.batch<T>(statements);
        if (!dropped && result.some(item => item.results.some(row => (row as Record<string, unknown>).state === 'complete'))) {
          dropped = true; throw new Error('simulated terminal lost reply');
        }
        return result;
      },
    };
    await expect(advancePublicationAbandonment(lost, handle, { expectedRevision: selected.revision })).rejects.toThrow('terminal lost reply');
    expect(dropped).toBe(true);
    expect((await job(f.app, handle)).state).toBe('complete');
    const saved = await rows(f.app, ['archive_publication_abandonment_diagnostics']);
    expect(await db.prepare("SELECT count(*) AS n FROM archive_publication_abandonment_diagnostics WHERE abandonment_id=? AND kind='completed'").bind(handle.abandonmentId).first('n')).toBe(1);
    expect(await advancePublicationAbandonment(db, handle, { expectedRevision: selected.revision })).toMatchObject({ state: 'complete', processed: 0 });
    expect(await rows(f.app, ['archive_publication_abandonment_diagnostics'])).toEqual(saved);
  });

  it.each(['generation', 'maintenance'] as const)('fences an in-flight deletion after %s changes', async kind => {
    const f = await fixture(), db = f.app.db, handle = await startPublicationAbandonment(db, base.publicationId);
    await untilPhase(f, handle, 'delete_requests');
    const before = await rows(f.app, [...candidateTables,'history_request_keys']); let switched = false;
    const raced: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = {
      prepare: db.prepare.bind(db),
      async batch<T>(statements: ReturnType<typeof db.prepare>[]) {
        if (!switched && statements.some(statement => /DELETE FROM archive_publication_(requests|records|parts)/.test(statement.sql))) {
          switched = true;
          await db.prepare(kind === 'generation' ? 'UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1' : "UPDATE backup_runtime SET write_locked_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=1").run();
        }
        return db.batch<T>(statements);
      },
    };
    await expect(advancePublicationAbandonment(raced, handle, { expectedRevision: (await job(f.app, handle)).revision })).rejects.toThrow();
    expect(switched).toBe(true);
    expect(await rows(f.app, [...candidateTables,'history_request_keys'])).toEqual(before);
    if (kind === 'generation') expect((await job(f.app, handle)).state).toBe('paused');
    else await db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
  });
});
