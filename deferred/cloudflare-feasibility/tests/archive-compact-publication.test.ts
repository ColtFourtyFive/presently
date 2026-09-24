import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advanceCompactMonthlyPublication, startCompactMonthlyPublication } from '../worker/archive-compact-publication';
import { COMPACT_PUBLICATION_LIMITS, type CompactPublicationBuild } from '../worker/archive-compact-schema';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { createPublicationFixture, createPublicationSeed, refreshPublicationProof, restorePublicationDatabase, snapshotPublicationDatabase, type PublicationSnapshotOptions } from './archive-publication-fixture';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import type { TestRuntime } from './runtime';

type DB = TestRuntime['db'];
type Handle = Awaited<ReturnType<typeof startCompactMonthlyPublication>>;
let fixture: Awaited<ReturnType<typeof createPublicationFixture>>, verifiedSql: string;
const opened: TestRuntime[] = [];
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const events = () => fixture.records.filter(record => record.table === 'attendance_events').sort((a, b) => a.key.localeCompare(b.key));
const corrections = () => fixture.records.filter(record => record.table === 'attendance_corrections');
const audits = () => fixture.records.filter(record => record.table === 'audit_entries');

beforeAll(async () => {
  fixture = await createPublicationFixture(await createPublicationSeed());
  verifiedSql = await snapshotPublicationDatabase(fixture.app);
}, 120_000);
afterAll(async () => { await fixture?.app.close(); });
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function restore(sql = verifiedSql) {
  const app = await restorePublicationDatabase(sql, { r2: false }); opened.push(app); return app;
}
const build = (db: DB, handle: Handle) => db.prepare('SELECT * FROM archive_compact_builds WHERE publication_id=?').bind(handle.publicationId).first<CompactPublicationBuild>();
const maps = async (db: DB, handle: Handle) => ({ results: (await db.prepare('SELECT request_id,publication_id FROM archive_compact_requests WHERE publication_id=? ORDER BY request_id').bind(handle.publicationId).all<{ request_id: string; publication_id: string }>()).results });
const descriptorCount = (db: DB) => db.prepare('SELECT count(*) n FROM archive_compact_publications').first<number>('n');
async function start(db: DB) { return startCompactMonthlyPublication(db, fixture.handle); }
async function step(db: DB, handle: Handle) { return advanceCompactMonthlyPublication(db, handle, { expectedRevision: (await build(db, handle))!.revision }); }
async function reachComplete(db: DB, handle: Handle) {
  for (let count = 0; count < 100; count++) {
    const before = (await build(db, handle))!;
    expect(before.state).toBe('building');
    if (before.phase === 'complete') return before;
    const result = await step(db, handle);
    expect(result.busy).toBe(false); expect(result.processed).toBeLessThanOrEqual(COMPACT_PUBLICATION_LIMITS.pageRecords);
    expect(await descriptorCount(db)).toBe(0);
  }
  throw new Error('Compact fixture failed to reach the terminal phase');
}
async function publish(db: DB, handle: Handle) { await reachComplete(db, handle); const result = await step(db, handle); expect(result.state).toBe('published'); return result; }
async function claim(db: DB, handle: Handle) {
  await db.prepare(`UPDATE archive_compact_builds SET lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),revision=revision+1,updated_at=${now} WHERE publication_id=?`).bind(crypto.randomUUID(), handle.publicationId).run();
}
function mapInsert(db: DB, handle: Handle, requestId: string) {
  return db.prepare('INSERT INTO archive_compact_requests(request_id,publication_id) VALUES(?,?)').bind(requestId, handle.publicationId);
}
function checkpointEvents(db: DB, handle: Handle, afterKey: string, amount: number) {
  return db.prepare(`UPDATE archive_compact_builds SET after_key=?,verified_events=verified_events+?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now} WHERE publication_id=?`).bind(afterKey, amount, handle.publicationId);
}
async function corruptedSnapshot(app: TestRuntime, options: PublicationSnapshotOptions) {
  // Test-only restore corruption: original native triggers are recreated by
  // the exporter after data insertion. No operating-database guard is removed.
  return restore(await snapshotPublicationDatabase(app, options));
}
async function standaloneAudit(db: DB) {
  const ids = new Set((await db.prepare("SELECT k.request_id FROM history_request_keys k JOIN audit_entries a ON a.id=k.request_id WHERE k.source_kind='audit'").all<{ request_id: string }>()).results.map(row => row.request_id));
  const record = audits().find(record => ids.has(record.key));
  if (!record) throw new Error('Native compact fixture needs a standalone archived audit');
  return record;
}

describe('schema28 direct compact publication using native D1', () => {
  it('publishes a complete exact request map without creating v1 catalogs or deleting source rows', async () => {
    const { db } = await restore(), handle = await start(db);
    expect(await db.prepare('SELECT max(version) n FROM schema_versions').first<number>('n')).toBe(42);
    expect(await db.prepare('SELECT origin FROM archive_compact_identities WHERE publication_id=?').bind(handle.publicationId).first('origin')).toBe('direct');
    expect(await build(db, handle)).toMatchObject({ state: 'building', phase: 'events', catalog_version: 2, after_key: '', verified_events: 0, verified_corrections: 0, verified_audits: 0, revision: 0 });
    const initialCounts = await db.prepare('SELECT (SELECT count(*) FROM attendance_events) events,(SELECT count(*) FROM attendance_corrections) corrections,(SELECT count(*) FROM audit_timeline) audits').first();
    await publish(db, handle);
    const sealedNull = events().find(record => record.row.result_visit === 'null');
    expect(sealedNull).toBeDefined();
    expect(await db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(sealedNull!.key).first('result_visit')).toBe('null');
    expect((await maps(db, handle)).results).toEqual([...events(), ...corrections()].map(record => ({ request_id: record.key, publication_id: handle.publicationId })).sort((a, b) => a.request_id.localeCompare(b.request_id)));
    expect(await build(db, handle)).toMatchObject({ state: 'published', phase: 'complete', verified_events: events().length, verified_corrections: corrections().length, verified_audits: audits().length, lease_token: null, lease_expires_at: null });
    expect(await db.prepare('SELECT catalog_version,record_count FROM archive_compact_publications WHERE publication_id=?').bind(handle.publicationId).first()).toEqual({ catalog_version: 2, record_count: fixture.records.length });
    expect(await db.prepare('SELECT generation,status FROM archive_compact_availability WHERE publication_id=?').bind(handle.publicationId).first()).toEqual({ generation: handle.generation, status: 'ready' });
    expect(await db.prepare('SELECT (SELECT count(*) FROM attendance_events) events,(SELECT count(*) FROM attendance_corrections) corrections,(SELECT count(*) FROM audit_timeline) audits').first()).toEqual(initialCounts);
    for (const table of ['archive_publication_builds', 'archive_publication_parts', 'archive_publication_records', 'archive_publication_requests', 'archive_publications']) expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
  });

  it('keeps exact retries stable and returns stale revisions without progress', async () => {
    const { db } = await restore(), handle = await start(db);
    expect(await startCompactMonthlyPublication(db, fixture.handle, handle.publicationId)).toEqual(handle);
    const first = await step(db, handle), afterFirst = await build(db, handle), mapAfterFirst = await maps(db, handle);
    expect(first.processed).toBeGreaterThan(0);
    expect(await advanceCompactMonthlyPublication(db, handle, { expectedRevision: 0 })).toMatchObject({ state: 'building', revision: first.revision, processed: 0, busy: true });
    expect(await build(db, handle)).toEqual(afterFirst); expect(await maps(db, handle)).toEqual(mapAfterFirst);
    const final = await publish(db, handle), immutable = await build(db, handle);
    expect(await startCompactMonthlyPublication(db, fixture.handle, handle.publicationId)).toEqual(handle);
    expect(await advanceCompactMonthlyPublication(db, handle, { expectedRevision: 0 })).toMatchObject({ state: 'published', revision: final.revision, processed: 0, busy: false });
    expect(await build(db, handle)).toEqual(immutable);
  });

  it('requires a still-complete supported validator run even if the session stays verified', async () => {
    const { db } = await restore();
    await db.prepare("UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL WHERE run_id=?").bind(fixture.handle.runId).run();
    expect(await db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(fixture.handle.verificationId).first('status')).toBe('verified');
    await expect(start(db)).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) n FROM archive_compact_builds').first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM archive_compact_identities').first('n')).toBe(0);
  });

  it('reports durable progress after a lost reply without repeating committed request inserts', async () => {
    const { db } = await restore(), handle = await start(db); let dropped = false;
    const lostReply: ArchiveStagingDatabase<ReturnType<DB['prepare']>> = {
      prepare: db.prepare.bind(db),
      async batch<T>(statements: ReturnType<DB['prepare']>[]) {
        const results = await db.batch<T>(statements);
        if (!dropped && statements.some(statement => statement.sql.startsWith('INSERT INTO archive_compact_requests'))) {
          dropped = true; throw new Error('simulated compact reply loss after commit');
        }
        return results;
      },
    };
    await expect(advanceCompactMonthlyPublication(lostReply, handle, { expectedRevision: 0 })).rejects.toThrow('simulated compact reply loss after commit');
    expect(dropped).toBe(true);
    const saved = (await build(db, handle))!, savedMaps = await maps(db, handle);
    expect(saved.verified_events).toBeGreaterThan(0); expect(saved.lease_token).toBeNull();
    expect(await advanceCompactMonthlyPublication(db, handle, { expectedRevision: 0 })).toMatchObject({ revision: saved.revision, processed: 0, busy: true });
    expect(await build(db, handle)).toEqual(saved); expect(await maps(db, handle)).toEqual(savedMaps);
  });

  it('fences a generation reset after page selection before native map writes', async () => {
    const { db } = await restore(), handle = await start(db); let reset = false;
    const changed: ArchiveStagingDatabase<ReturnType<DB['prepare']>> = {
      prepare: db.prepare.bind(db),
      async batch<T>(statements: ReturnType<DB['prepare']>[]) {
        if (!reset && statements.some(statement => statement.sql.startsWith('INSERT INTO archive_compact_requests'))) {
          reset = true; await db.prepare('UPDATE history_runtime SET generation=? WHERE id=1').bind(crypto.randomUUID()).run();
        }
        return db.batch<T>(statements);
      },
    };
    await expect(advanceCompactMonthlyPublication(changed, handle, { expectedRevision: 0 })).rejects.toThrow();
    expect(reset).toBe(true);
    expect(await build(db, handle)).toMatchObject({ state: 'invalid', verified_events: 0, after_key: '', lease_token: null, lease_expires_at: null });
    expect((await maps(db, handle)).results).toEqual([]); expect(await descriptorCount(db)).toBe(0);
  });

  it('does not grant a second live lease or let a concurrent stale call advance twice', async () => {
    const { db } = await restore(), handle = await start(db);
    await claim(db, handle); const leased = (await build(db, handle))!;
    await expect(claim(db, handle)).rejects.toThrow();
    expect(await advanceCompactMonthlyPublication(db, handle, { expectedRevision: leased.revision })).toMatchObject({ busy: true, processed: 0, revision: leased.revision });
    expect(await maps(db, handle)).toMatchObject({ results: [] });
  });

  it('rejects native maps without a lease, outside the current phase, and for unknown owners', async () => {
    const { db } = await restore(), handle = await start(db);
    await expect(mapInsert(db, handle, events()[0].key).run()).rejects.toThrow('ARCHIVE_COMPACT_REQUEST_INVALID');
    await claim(db, handle);
    for (const requestId of [crypto.randomUUID(), corrections()[0].key, (await standaloneAudit(db)).key]) await expect(mapInsert(db, handle, requestId).run()).rejects.toThrow('ARCHIVE_COMPACT_REQUEST_INVALID');
    expect((await maps(db, handle)).results).toEqual([]); expect(await descriptorCount(db)).toBe(0);
  });

  it('rejects skipped event prefixes and rolls back every map inserted in that checkpoint batch', async () => {
    const { db } = await restore(), handle = await start(db), page = events().slice(0, COMPACT_PUBLICATION_LIMITS.pageRecords);
    expect(page.length).toBeGreaterThan(1); await claim(db, handle);
    const before = await build(db, handle);
    await expect(db.batch([...page.slice(1).map(record => mapInsert(db, handle, record.key)), checkpointEvents(db, handle, page.at(-1)!.key, page.length)])).rejects.toThrow('ARCHIVE_COMPACT_BUILD_INVALID');
    expect((await maps(db, handle)).results).toEqual([]); expect(await build(db, handle)).toEqual(before);
  });

  it('rejects the ninth valid same-phase key and advances across exact eight-record prefixes', async () => {
    let sourceSql = '';
    const source = await nativeSemanticFixture(9, true, async app => { sourceSql = await snapshotPublicationDatabase(app); });
    const larger = await createPublicationFixture({ ...source, sourceSql }); opened.push(larger.app);
    const db = larger.app.db, handle = await startCompactMonthlyPublication(db, larger.handle);
    const ordered = larger.records.filter(record => record.table === 'attendance_corrections').sort((a, b) => a.key.localeCompare(b.key));
    expect(ordered.length).toBeGreaterThan(8); expect(ordered.length).toBeLessThanOrEqual(16);
    for (let count = 0; (await build(db, handle))!.phase !== 'corrections'; count++) { expect(count).toBeLessThan(5); await step(db, handle); }
    const originalMaps = await maps(db, handle), ids = new Set(ordered.map(record => record.key));
    await claim(db, handle);
    await expect(mapInsert(db, handle, ordered[8].key).run()).rejects.toThrow('ARCHIVE_COMPACT_REQUEST_INVALID');
    expect(await maps(db, handle)).toEqual(originalMaps);
    await db.prepare(`UPDATE archive_compact_builds SET revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now} WHERE publication_id=?`).bind(handle.publicationId).run();
    expect(await step(db, handle)).toMatchObject({ phase: 'corrections', processed: 8, busy: false });
    expect(await build(db, handle)).toMatchObject({ verified_corrections: 8, after_key: ordered[7].key });
    expect((await maps(db, handle)).results.filter(row => ids.has(row.request_id)).map(row => row.request_id)).toEqual(ordered.slice(0, 8).map(record => record.key));
    expect(await step(db, handle)).toMatchObject({ phase: 'corrections', processed: ordered.length - 8, busy: false });
    expect(await build(db, handle)).toMatchObject({ verified_corrections: ordered.length, after_key: ordered.at(-1)!.key });
    expect((await maps(db, handle)).results.filter(row => ids.has(row.request_id)).map(row => row.request_id)).toEqual(ordered.map(record => record.key));
    expect((await maps(db, handle)).results.filter(row => !ids.has(row.request_id))).toEqual(originalMaps.results);
    expect(await descriptorCount(db)).toBe(0);
  }, 120_000);

  it('rejects a forged cursor, inflated verified count, and an early phase transition', async () => {
    const { db } = await restore(), handle = await start(db); await claim(db, handle);
    const before = await build(db, handle), page = events().slice(0, 8);
    await expect(db.batch([...page.map(record => mapInsert(db, handle, record.key)), checkpointEvents(db, handle, 'zzzz-skips-all-events', page.length)])).rejects.toThrow('ARCHIVE_COMPACT_BUILD_INVALID');
    expect((await maps(db, handle)).results).toEqual([]);
    await expect(db.batch([...page.map(record => mapInsert(db, handle, record.key)), checkpointEvents(db, handle, page.at(-1)!.key, page.length + 1)])).rejects.toThrow('ARCHIVE_COMPACT_BUILD_INVALID');
    expect((await maps(db, handle)).results).toEqual([]);
    await expect(db.prepare(`UPDATE archive_compact_builds SET phase='corrections',after_key='',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now} WHERE publication_id=?`).bind(handle.publicationId).run()).rejects.toThrow('ARCHIVE_COMPACT_BUILD_INVALID');
    expect(await build(db, handle)).toEqual(before); expect(await descriptorCount(db)).toBe(0);
  });

  it.each(['kind', 'hash', 'encoding'] as const)('rejects test-restored %s corruption in immutable request ownership', async mode => {
    const app = await restore(), handle = await start(app.db), target = events()[0];
    const altered = await corruptedSnapshot(app, { transformRow(table, row) {
      if (table !== 'history_request_keys' || row.request_id !== target.key) return row;
      return { ...row, ...(mode === 'kind' ? { source_kind: 'correction' } : mode === 'hash' ? { payload_hash: `${String(row.payload_hash)[0] === 'A' ? 'B' : 'A'}${String(row.payload_hash).slice(1)}` } : { hash_encoding: 'hex-sha256' }) };
    } });
    await expect(step(altered.db, handle)).rejects.toThrow();
    expect((await maps(altered.db, handle)).results).toEqual([]); expect(await descriptorCount(altered.db)).toBe(0);
  });

  it('rejects test-restored ownership by a different existing center', async () => {
    const app = await restore(), handle = await start(app.db), target = events()[0];
    const center = (await app.db.prepare('SELECT * FROM centers LIMIT 1').first<Record<string, unknown>>())!;
    const foreign = { ...center, id: 'other-center', name: 'Other test center' }, columns = Object.keys(foreign);
    await app.db.prepare(`INSERT INTO centers(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).bind(...Object.values(foreign)).run();
    const altered = await corruptedSnapshot(app, { transformRow(table, row) { return table === 'history_request_keys' && row.request_id === target.key ? { ...row, center_id: foreign.id } : row; } });
    await expect(step(altered.db, handle)).rejects.toThrow();
    expect((await maps(altered.db, handle)).results).toEqual([]); expect(await descriptorCount(altered.db)).toBe(0);
  });

  it.each(['event', 'correction', 'audit'] as const)('rejects test-restored %s source changes after semantic verification', async kind => {
    const app = await restore(), handle = await start(app.db);
    const table = kind === 'event' ? 'attendance_events' : kind === 'correction' ? 'attendance_corrections' : 'audit_entries';
    const sourceTable = table;
    const target = kind === 'audit' ? await standaloneAudit(app.db) : fixture.records.find(record => record.table === table)!;
    const altered = await corruptedSnapshot(app, { transformRow(name, row) {
      if (name !== sourceTable || row.id !== target.key) return row;
      return { ...row, ...(kind === 'event' ? { insertion_nonce: 'test-only-corrupted-source' } : kind === 'correction' ? { reason: 'test-only-corrupted-source' } : { detail: 'test-only-corrupted-source' }) };
    } });
    let rejected = false;
    for (let count = 0; count < 100; count++) {
      const before = (await build(altered.db, handle))!;
      try { expect((await step(altered.db, handle)).state).not.toBe('published'); }
      catch (error) {
        if (!(error instanceof Error) || error.name === 'AssertionError') throw error;
        expect(before.phase).toBe(kind === 'event' ? 'events' : kind === 'correction' ? 'corrections' : 'audit');
        expect(error.message).toContain(kind === 'audit' ? 'ARCHIVE_COMPACT_BUILD_INVALID' : 'ARCHIVE_COMPACT_REQUEST_INVALID');
        rejected = true; break;
      }
    }
    expect(rejected).toBe(true); expect(await descriptorCount(altered.db)).toBe(0);
  });

  it.each(['missing', 'unsealed-sql-null'] as const)('rejects a test-restored %s event source before committing its map', async mode => {
    const app = await restore(), handle = await start(app.db);
    const target = events().find(record => mode === 'missing' ? record.row.action === 'check_in' : record.row.result_visit === 'null')!;
    expect(target).toBeDefined();
    const altered = await corruptedSnapshot(app, { transformRow(table, row) {
      if (table !== 'attendance_events' || row.id !== target.key) return row;
      return mode === 'missing' ? null : { ...row, result_visit: null };
    } });
    expect((await build(altered.db, handle))!.phase).toBe('events');
    await expect(step(altered.db, handle)).rejects.toThrow('ARCHIVE_COMPACT_REQUEST_INVALID');
    expect((await maps(altered.db, handle)).results).toEqual([]);
    expect(await build(altered.db, handle)).toMatchObject({ phase: 'events', after_key: '', verified_events: 0 });
    expect(await descriptorCount(altered.db)).toBe(0);
  });

  it('blocks conflicting audit aliases natively and rejects test-restored alias corruption at the audit checkpoint', async () => {
    const app = await restore(), db = app.db, handle = await start(db), event = events()[0];
    const alias = audits().find(record => record.key === event.key)!;
    expect(alias).toBeDefined();
    expect(await db.prepare('SELECT count(*) n FROM audit_entries WHERE id=?').bind(alias.key).first('n')).toBe(0);
    const owner = await db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(event.key).first();
    const row = { ...alias.row, detail: '{"testOnly":"conflicting alias"}' }, columns = Object.keys(row);
    const insert = db.prepare(`INSERT INTO audit_entries(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    await expect(insert.bind(...Object.values(row)).run()).rejects.toThrow('AUDIT_ID_CONFLICT');
    // Test-only restore corruption: insert the shadow row into the export's
    // data section, before its original triggers are recreated. No operating
    // database trigger is removed or disabled.
    const statements = unstable_splitSqlQuery(await snapshotPublicationDatabase(app));
    const firstTrigger = statements.findIndex(sql => /^CREATE TRIGGER\b/i.test(sql.trimStart()));
    expect(firstTrigger).toBeGreaterThan(0);
    const values = Object.values(row).map(value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`);
    statements.splice(firstTrigger, 0, `INSERT INTO audit_entries(${columns.join(',')}) VALUES(${values.join(',')})`);
    const altered = await restore(statements.join(';\n'));
    for (let count = 0; (await build(altered.db, handle))!.phase !== 'audit'; count++) { expect(count).toBeLessThan(8); await step(altered.db, handle); }
    const prior = (await build(altered.db, handle))!, beforeMaps = await maps(altered.db, handle);
    await expect(step(altered.db, handle)).rejects.toThrow('ARCHIVE_COMPACT_BUILD_INVALID');
    expect(await build(altered.db, handle)).toMatchObject({ phase: 'audit', after_key: prior.after_key, verified_audits: prior.verified_audits });
    expect(await maps(altered.db, handle)).toEqual(beforeMaps);
    expect(await altered.db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(event.key).first()).toEqual(owner);
    expect(await descriptorCount(altered.db)).toBe(0);
  });

  it.each(['expired', 'paused'] as const)('denies native progress and fresh admission for a test-restored %s lifecycle', async mode => {
    const app = await restore(), handle = await start(app.db); await step(app.db, handle);
    const previous = (await build(app.db, handle))!, previousMaps = await maps(app.db, handle);
    // A completed verified session cannot be paused through the control API.
    // These restored lifecycle snapshots exercise the proof boundary directly.
    const altered = await corruptedSnapshot(app, { transformRow(table, row) {
      if (table !== 'archive_semantic_lifecycle' || row.verification_id !== fixture.handle.verificationId) return row;
      return mode === 'expired' ? { ...row, due_at: '2000-01-01T00:00:00.000Z' } : { ...row, pause_reason: 'maintenance', paused_at: new Date().toISOString(), next_eligible_at: row.due_at };
    } });
    await expect(claim(altered.db, handle)).rejects.toThrow('ARCHIVE_COMPACT_BUILD_INVALID');
    expect(await step(altered.db, handle)).toMatchObject({ state: 'invalid', processed: 0, busy: false });
    expect(await build(altered.db, handle)).toMatchObject({ phase: previous.phase, after_key: previous.after_key, verified_events: previous.verified_events, verified_corrections: previous.verified_corrections, verified_audits: previous.verified_audits });
    expect(await maps(altered.db, handle)).toEqual(previousMaps);
    await expect(start(altered.db)).rejects.toThrow();
    expect(await altered.db.prepare('SELECT count(*) n FROM archive_compact_builds').first('n')).toBe(1);
    expect(await descriptorCount(altered.db)).toBe(0);
  });

  it.each(['omission', 'equal-count-pollution'] as const)('rechecks complete map membership at publication after test-restored %s', async mode => {
    const app = await restore(), handle = await start(app.db); await reachComplete(app.db, handle);
    const target = events()[0].key, extra = (await standaloneAudit(app.db)).key;
    const altered = await corruptedSnapshot(app, { transformRow(table, row) {
      if (table !== 'archive_compact_requests' || row.request_id !== target) return row;
      return mode === 'omission' ? null : { ...row, request_id: extra };
    } });
    expect((await maps(altered.db, handle)).results).toHaveLength(events().length + corrections().length - (mode === 'omission' ? 1 : 0));
    await expect(step(altered.db, handle)).rejects.toThrow();
    expect(await descriptorCount(altered.db)).toBe(0);
    expect(await altered.db.prepare('SELECT count(*) n FROM archive_compact_availability').first('n')).toBe(0);
  });

  it('blocks admission and progress during backup maintenance and resumes after unlock', async () => {
    const { db } = await restore();
    await db.prepare("UPDATE backup_runtime SET write_locked_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=1").run();
    await expect(start(db)).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) n FROM archive_compact_identities').first('n')).toBe(0);
    await db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    const handle = await start(db), before = await build(db, handle);
    await db.prepare("UPDATE backup_runtime SET write_locked_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=1").run();
    await expect(claim(db, handle)).rejects.toThrow('backup_maintenance');
    expect(await step(db, handle)).toMatchObject({ state: 'building', processed: 0 });
    expect(await build(db, handle)).toEqual(before); expect((await maps(db, handle)).results).toEqual([]);
    await db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    await publish(db, handle);
  });

  it('invalidates unfinished progress on generation reset and keeps live source rows', async () => {
    const { db } = await restore(), handle = await start(db); await step(db, handle);
    const before = (await build(db, handle))!, priorMaps = await maps(db, handle), sourceCount = await db.prepare('SELECT count(*) n FROM attendance_events').first('n');
    await db.prepare('UPDATE history_runtime SET generation=? WHERE id=1').bind(crypto.randomUUID()).run();
    expect(await build(db, handle)).toMatchObject({ state: 'invalid', revision: before.revision + 1, lease_token: null, lease_expires_at: null });
    expect(await step(db, handle)).toMatchObject({ state: 'invalid', processed: 0, busy: false });
    expect(await maps(db, handle)).toEqual(priorMaps); expect(await descriptorCount(db)).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM attendance_events').first('n')).toBe(sourceCount);
  });

  it('keeps restored descriptors and ownership while permanently disabling initial availability', async () => {
    const { db } = await restore(), handle = await start(db); await publish(db, handle);
    const descriptor = await db.prepare('SELECT * FROM archive_compact_publications WHERE publication_id=?').bind(handle.publicationId).first(), priorMaps = await maps(db, handle);
    await db.batch(unstable_splitSqlQuery(await readFile('scripts/recovery-access-reset.sql', 'utf8')).map(sql => db.prepare(sql)));
    expect(await db.prepare('SELECT * FROM archive_compact_publications WHERE publication_id=?').bind(handle.publicationId).first()).toEqual(descriptor);
    expect(await maps(db, handle)).toEqual(priorMaps);
    expect(await db.prepare('SELECT status FROM archive_compact_availability WHERE publication_id=?').bind(handle.publicationId).first('status')).toBe('unavailable');
    await expect(db.prepare("UPDATE archive_compact_availability SET status='ready' WHERE publication_id=?").bind(handle.publicationId).run()).rejects.toThrow();
    await expect(db.prepare('DELETE FROM archive_compact_availability WHERE publication_id=?').bind(handle.publicationId).run()).rejects.toThrow();
    await expect(db.prepare("INSERT OR REPLACE INTO archive_compact_availability(publication_id,generation,status) VALUES(?,?,'ready')").bind(handle.publicationId, handle.generation).run()).rejects.toThrow();
  });

  it('protects committed descriptors, request maps, identities, and build state from mutation or replacement', async () => {
    const { db } = await restore(), handle = await start(db); await publish(db, handle);
    for (const table of ['archive_compact_publications', 'archive_compact_requests', 'archive_compact_identities']) {
      await expect(db.prepare(`DELETE FROM ${table} WHERE publication_id=?`).bind(handle.publicationId).run()).rejects.toThrow();
      await expect(db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE publication_id=?`).bind(handle.publicationId).run()).rejects.toThrow();
    }
    await expect(db.prepare("UPDATE archive_compact_publications SET header_json='{}' WHERE publication_id=?").bind(handle.publicationId).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE archive_compact_builds SET state='building',revision=revision+1,updated_at=${now} WHERE publication_id=?`).bind(handle.publicationId).run()).rejects.toThrow();
  });

  it.each(['v1-first', 'compact-first'] as const)('reserves the center/month reciprocally when %s admission wins', async first => {
    const { db } = await restore();
    if (first === 'v1-first') {
      await startMonthlyPublication(db, fixture.handle);
      await expect(start(db)).rejects.toThrow('ARCHIVE_COMPACT_CROSS_FORMAT_CONFLICT');
      expect(await db.prepare('SELECT count(*) n FROM archive_compact_builds').first('n')).toBe(0);
      expect(await db.prepare('SELECT count(*) n FROM archive_compact_identities').first('n')).toBe(0);
    } else {
      await start(db);
      await expect(startMonthlyPublication(db, fixture.handle)).rejects.toThrow('ARCHIVE_COMPACT_CROSS_FORMAT_CONFLICT');
      expect(await db.prepare('SELECT count(*) n FROM archive_publication_builds').first('n')).toBe(0);
    }
    expect(await descriptorCount(db)).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM archive_compact_requests').first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM archive_publication_requests').first('n')).toBe(0);
  });

  it.each(['v1-first', 'compact-first'] as const)('preserves retained claims and rolls back the other format when %s is invalidated', async first => {
    const app = await restore(), db = app.db, storage = { bucket: fixture.bucket, masterKey: fixture.key };
    const winnerTable = first === 'v1-first' ? 'archive_publication_requests' : 'archive_compact_requests';
    const winner = first === 'v1-first' ? await startMonthlyPublication(db, fixture.handle) : await start(db);
    for (let count = 0; count < 100; count++) {
      if (await db.prepare(`SELECT count(*) n FROM ${winnerTable} WHERE publication_id=?`).bind(winner.publicationId).first<number>('n')) break;
      const table = first === 'v1-first' ? 'archive_publication_builds' : 'archive_compact_builds';
      const revision = (await db.prepare(`SELECT revision FROM ${table} WHERE publication_id=?`).bind(winner.publicationId).first<number>('revision'))!;
      const result = first === 'v1-first' ? await advanceMonthlyPublication(db, storage, winner, { expectedRevision: revision }) : await advanceCompactMonthlyPublication(db, winner, { expectedRevision: revision });
      expect(result.state).toBe('building'); expect(count).toBeLessThan(99);
    }
    const retained = (await db.prepare(`SELECT * FROM ${winnerTable} WHERE publication_id=? ORDER BY request_id`).bind(winner.publicationId).all()).results;
    expect(retained.length).toBeGreaterThan(0);
    const ownership = (await db.prepare('SELECT * FROM history_request_keys ORDER BY request_id').all()).results;
    const sources = (await db.prepare('SELECT * FROM attendance_events ORDER BY id').all()).results;
    await db.batch(unstable_splitSqlQuery(await readFile('scripts/recovery-access-reset.sql', 'utf8')).map(sql => db.prepare(sql)));
    const current = await refreshPublicationProof(app, { key: fixture.key, reference: fixture.reference, objects: fixture.objects });
    const restoredOwnership = (await db.prepare('SELECT * FROM history_request_keys ORDER BY request_id').all()).results;
    const originalIds = new Set(ownership.map(row => row.request_id));
    expect(restoredOwnership.filter(row => originalIds.has(row.request_id))).toEqual(ownership);
    const resetOwners = restoredOwnership.filter(row => !originalIds.has(row.request_id));
    expect(resetOwners).toHaveLength(1);
    expect(resetOwners[0]).toMatchObject({ source_kind: 'audit', payload_hash: null, hash_encoding: 'none', center_id: fixture.metadata.centerId });
    expect(await db.prepare('SELECT action FROM audit_entries WHERE id=?').bind(resetOwners[0].request_id).first('action')).toBe('recovery_access_reset');
    const loser = first === 'v1-first' ? await startCompactMonthlyPublication(db, current.handle) : await startMonthlyPublication(db, current.handle);
    const loserTables = first === 'v1-first' ? ['archive_compact_requests'] : ['archive_publication_parts', 'archive_publication_records', 'archive_publication_requests'];
    const progress = async () => first === 'v1-first'
      ? db.prepare('SELECT phase,after_key,verified_events,verified_corrections,verified_audits FROM archive_compact_builds WHERE publication_id=?').bind(loser.publicationId).first()
      : db.prepare('SELECT next_part,next_offset,indexed_count,request_count,counts_json,locator_digest FROM archive_publication_builds WHERE publication_id=?').bind(loser.publicationId).first();
    const children = async () => Promise.all(loserTables.map(table => db.prepare(`SELECT * FROM ${table} WHERE publication_id=?`).bind(loser.publicationId).all().then(result => result.results)));
    const advanceLoser = async () => {
      const table = first === 'v1-first' ? 'archive_compact_builds' : 'archive_publication_builds';
      const revision = (await db.prepare(`SELECT revision FROM ${table} WHERE publication_id=?`).bind(loser.publicationId).first<number>('revision'))!;
      return first === 'v1-first' ? advanceCompactMonthlyPublication(db, loser, { expectedRevision: revision }) : advanceMonthlyPublication(db, storage, loser, { expectedRevision: revision });
    };
    let rejected = false;
    for (let count = 0; count < 100; count++) {
      const beforeProgress = await progress(), beforeChildren = await children();
      try { expect((await advanceLoser()).state).toBe('building'); }
      catch (error) {
        if (!(error instanceof Error) || error.name === 'AssertionError') throw error;
        expect(error.message).toContain(first === 'v1-first' ? 'ARCHIVE_COMPACT_REQUEST_INVALID' : 'ARCHIVE_COMPACT_CROSS_FORMAT_CONFLICT');
        expect(await progress()).toEqual(beforeProgress); expect(await children()).toEqual(beforeChildren);
        await expect(advanceLoser()).rejects.toThrow();
        expect(await progress()).toEqual(beforeProgress); expect(await children()).toEqual(beforeChildren);
        rejected = true; break;
      }
    }
    expect(rejected).toBe(true);
    expect((await db.prepare(`SELECT * FROM ${winnerTable} WHERE publication_id=? ORDER BY request_id`).bind(winner.publicationId).all()).results).toEqual(retained);
    expect((await db.prepare('SELECT * FROM history_request_keys ORDER BY request_id').all()).results).toEqual(restoredOwnership);
    expect((await db.prepare('SELECT * FROM attendance_events ORDER BY id').all()).results).toEqual(sources);
    expect(await descriptorCount(db)).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM archive_publications').first('n')).toBe(0);
  }, 120_000);
});
