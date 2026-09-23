import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { emptyArchiveCounts } from '../worker/archive-codec';
import { startMonthlyPublication, advanceMonthlyPublication } from '../worker/archive-publication';
import { advancePublicationAbandonment } from '../worker/archive-publication-abandonment';
import { ARCHIVE_ABANDONMENT_ZERO_SUM, PUBLICATION_ABANDONMENT_BUILD_COLUMNS, archiveAbandonmentBuildSql, archiveAbandonmentLeaseSql, archiveAbandonmentSelectionSql, type ArchiveAbandonmentJobRow, type ArchiveAbandonmentPhase } from '../worker/archive-abandonment-schema';
import type { ArchivePublicationBuildRow } from '../worker/archive-publication-schema';
import { createPublicationFixture, createPublicationSeed, snapshotPublicationDatabase, restorePublicationDatabase } from './archive-publication-fixture';
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const zero = () => ({ requests: 0, records: 0, parts: 0, requestSum: ARCHIVE_ABANDONMENT_ZERO_SUM, recordSum: ARCHIVE_ABANDONMENT_ZERO_SUM, partSum: ARCHIVE_ABANDONMENT_ZERO_SUM });
const initialProgress = () => ({ version: 1, locatorDigest: ARCHIVE_ABANDONMENT_ZERO_SUM, locatorPage: [], counts: emptyArchiveCounts(), partRecords: 0 });
const initialCursor = () => ({ request: '', recordPart: -1, recordOffset: -1, part: -1 });
let seed: Awaited<ReturnType<typeof createPublicationSeed>>, fixture: Awaited<ReturnType<typeof createPublicationFixture>>, publicationId: string;
const readBuild = () => fixture.app.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(publicationId).first<ArchivePublicationBuildRow>();
const readJob = (id: string) => fixture.app.db.prepare('SELECT * FROM archive_publication_abandonment_jobs WHERE abandonment_id=?').bind(id).first<ArchiveAbandonmentJobRow>();
beforeAll(async () => { seed = await createPublicationSeed(); });
beforeEach(async () => {
  fixture = await createPublicationFixture(seed);
  const handle = await startMonthlyPublication(fixture.app.db, fixture.handle); publicationId = handle.publicationId;
  for (let step = 0; step < 100; step++) {
    const build = (await readBuild())!;
    if (build.request_count > 0) break;
    await advanceMonthlyPublication(fixture.app.db, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: build.revision });
  }
  expect((await readBuild())!.state).toBe('building');
  await fixture.app.db.prepare("UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL WHERE run_id=?").bind(fixture.handle.runId).run();
});
afterEach(async () => { await fixture?.app.close(); });
async function candidate(overrides: Record<string, unknown> = {}) {
  const build = (await readBuild())!, buildJson = JSON.stringify(Object.fromEntries(PUBLICATION_ABANDONMENT_BUILD_COLUMNS.map(key => [key, build[key]])));
  return { abandonment_id: crypto.randomUUID(), publication_id: publicationId, build_json: buildJson,
    build_sha256: createHash('sha256').update(buildJson).digest('hex'), admission_generation: fixture.handle.generation, execution_generation: fixture.handle.generation,
    reason: 'invalid_unpublished', state: 'pending', phase: 'inventory_requests', mode: 'initial', revision: 0,
    lease_token: null, lease_expires_at: null, cursor_json: JSON.stringify(initialCursor()), observed_json: JSON.stringify(zero()), inventory_json: null,
    removed_json: JSON.stringify(zero()), progress_json: JSON.stringify(initialProgress()), selection_json: '[]', pause_reason: null, completed_at: null, ...overrides };
}
async function insert(row: Awaited<ReturnType<typeof candidate>>, replace = false) {
  const keys = Object.keys(row);
  await fixture.app.db.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO archive_publication_abandonment_jobs(${keys.join(',')},created_at,updated_at) VALUES(${keys.map(() => '?').join(',')},${now},${now})`).bind(...Object.values(row)).run();
  return row.abandonment_id;
}
async function begin() { return insert(await candidate()); }
async function claim(id: string, phase?: ArchiveAbandonmentPhase, override = '') {
  const job = (await readJob(id))!;
  await fixture.app.db.prepare(`UPDATE archive_publication_abandonment_jobs AS j SET state='running',lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),selection_json=${archiveAbandonmentSelectionSql(phase ?? job.phase)},revision=revision+1,updated_at=${now}${override} WHERE abandonment_id=?`).bind(crypto.randomUUID(), id).run();
}
const update = (id: string, assignment: string) => fixture.app.db.prepare(`UPDATE archive_publication_abandonment_jobs SET ${assignment},revision=revision+1,updated_at=${now} WHERE abandonment_id=?`).bind(id).run();
async function until(id: string, phase: ArchiveAbandonmentPhase) {
  for (let step = 0; step < 200; step++) {
    const job = (await readJob(id))!;
    if (job.phase === phase) return;
    await advancePublicationAbandonment(fixture.app.db, { abandonmentId: id, generation: job.execution_generation }, { expectedRevision: job.revision });
  }
  throw new Error(`Did not reach ${phase}`);
}

describe('schema27 invalid publication abandonment authority', () => {
  it('admits an exact invalid-build fingerprint and retains immutable diagnostics', async () => {
    expect(await fixture.app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(42);
    const build = (await readBuild())!;
    expect(build.state).toBe('invalid'); expect(build.request_count).toBeGreaterThan(0); expect(build.indexed_count).toBeGreaterThan(8);
    const row = await candidate();
    await expect(insert({ ...row, execution_generation: 'stale' })).rejects.toThrow('ADMISSION_INVALID');
    await expect(insert({ ...row, build_json: JSON.stringify({ ...JSON.parse(row.build_json), revision: build.revision - 1 }) })).rejects.toThrow('ADMISSION_INVALID');
    const missingNullable = JSON.parse(row.build_json); delete missingNullable.lease_token;
    await expect(insert({ ...row, build_json: JSON.stringify(missingNullable) })).rejects.toThrow('ADMISSION_INVALID');
    await expect(insert({ ...row, build_json: JSON.stringify({ ...JSON.parse(row.build_json), validator_version: true }) })).rejects.toThrow('ADMISSION_INVALID');
    await expect(insert({ ...row, inventory_json: JSON.stringify(zero()) as never })).rejects.toThrow('ADMISSION_INVALID');
    const id = await insert(row);
    expect(await fixture.app.db.prepare(`SELECT ${archiveAbandonmentBuildSql()} AS valid FROM archive_publication_abandonment_jobs j WHERE abandonment_id=?`).bind(id).first('valid')).toBe(1);
    expect((await fixture.app.db.prepare('SELECT kind,revision FROM archive_publication_abandonment_diagnostics').all()).results).toEqual([{ kind: 'admitted', revision: 0 }]);
    await expect(insert({ ...row, abandonment_id: crypto.randomUUID() }, true)).rejects.toThrow('ADMISSION_INVALID');
    await expect(update(id, "build_sha256='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'")).rejects.toThrow('JOB_INVALID');
    await expect(fixture.app.db.prepare('DELETE FROM archive_publication_abandonment_jobs').run()).rejects.toThrow('IMMUTABLE');
    await expect(fixture.app.db.prepare('UPDATE archive_publication_abandonment_diagnostics SET revision=10').run()).rejects.toThrow('IMMUTABLE');
    await expect(fixture.app.db.prepare('DELETE FROM archive_publication_abandonment_diagnostics').run()).rejects.toThrow('IMMUTABLE');
    expect(() => archiveAbandonmentBuildSql('bad;DELETE')).toThrow('SQL_ALIAS_INVALID');
  });
  it('requires database-time leases and an exact native selection before progress', async () => {
    const id = await begin();
    await expect(claim(id, undefined, ",lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+31 seconds')")).rejects.toThrow('JOB_INVALID');
    await expect(claim(id, undefined, ",selection_json='[]'")).rejects.toThrow('JOB_INVALID');
    await claim(id);
    const job = (await readJob(id))!;
    expect(JSON.parse(job.selection_json).length).toBeGreaterThan(0);
    expect(JSON.parse(job.selection_json).length).toBeLessThanOrEqual(8);
    expect(await fixture.app.db.prepare(`SELECT ${archiveAbandonmentLeaseSql()} AS valid FROM archive_publication_abandonment_jobs j WHERE abandonment_id=?`).bind(id).first('valid')).toBe(1);
    await expect(claim(id)).rejects.toThrow('JOB_INVALID');
    await expect(update(id, "state='pending',phase='delete_requests',lease_token=NULL,lease_expires_at=NULL,selection_json='[]'")).rejects.toThrow('JOB_INVALID');
    await expect(update(id, "state='pending',cursor_json='{}',lease_token=NULL,lease_expires_at=NULL,selection_json='[]'")).rejects.toThrow();
    await update(id, "state='pending',lease_token=NULL,lease_expires_at=NULL,selection_json='[]'");
    expect((await readJob(id))!.revision).toBe(job.revision + 1);
  });
  it('keeps every delete guard closed while a valid job only inventories', async () => {
    const id = await begin(); await claim(id);
    for (const table of ['archive_publication_requests','archive_publication_records','archive_publication_parts','archive_publication_builds','history_request_keys']) {
      await expect(fixture.app.db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow();
    }
    expect((await readBuild())!.state).toBe('invalid');
  });
  it('pauses and clears leases on reset, requires explicit current ready-generation rebind, and preserves checkpoints', async () => {
    const id = await begin(); await claim(id);
    const before = (await readJob(id))!;
    await fixture.app.db.prepare("UPDATE history_runtime SET generation='restored-generation',state='backfilling' WHERE id=1").run();
    const paused = (await readJob(id))!;
    expect(paused).toMatchObject({ state: 'paused', phase: before.phase, revision: before.revision + 1, execution_generation: before.execution_generation, inventory_json: before.inventory_json, removed_json: before.removed_json, lease_token: null, selection_json: '[]', pause_reason: 'generation_reset' });
    const resume = "state='pending',phase='inventory_requests',mode='resume',execution_generation='restored-generation',pause_reason=NULL";
    await expect(update(id, resume)).rejects.toThrow('JOB_INVALID');
    await fixture.app.db.prepare("UPDATE history_runtime SET state='ready' WHERE id=1").run();
    await expect(claim(id)).rejects.toThrow('JOB_INVALID');
    await update(id, resume);
    const rebound = (await readJob(id))!;
    expect(rebound).toMatchObject({ state: 'pending', execution_generation: 'restored-generation', admission_generation: before.admission_generation, build_json: before.build_json });
    expect((await fixture.app.db.prepare('SELECT kind,execution_generation FROM archive_publication_abandonment_diagnostics ORDER BY revision').all()).results).toEqual([
      { kind: 'admitted', execution_generation: before.execution_generation }, { kind: 'paused', execution_generation: before.execution_generation }, { kind: 'rebound', execution_generation: 'restored-generation' },
    ]);
  });
  it('blocks admission, claim, checkpoint, and diagnostics during maintenance', async () => {
    const id = await begin(); await claim(id);
    const before = await readJob(id);
    await fixture.app.db.prepare("UPDATE backup_runtime SET write_locked_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=1").run();
    await expect(insert(await candidate())).rejects.toThrow('backup_maintenance');
    await expect(update(id, "state='pending',lease_token=NULL,lease_expires_at=NULL,selection_json='[]'")).rejects.toThrow('backup_maintenance');
    expect(await readJob(id)).toEqual(before);
    await fixture.app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    await update(id, "state='pending',lease_token=NULL,lease_expires_at=NULL,selection_json='[]'");
  });
  it('limits deletion to eight exact keys and rolls all deletes back when the owned checkpoint changes zero rows', async () => {
    const id = await begin(), db = fixture.app.db;
    await until(id, 'delete_records'); await claim(id);
    const job = (await readJob(id))!, selected = JSON.parse(job.selection_json) as [string, string, number, number][];
    expect(selected).toHaveLength(8);
    const rows = await db.prepare('SELECT * FROM archive_publication_records WHERE publication_id=? ORDER BY part_index,part_offset').bind(publicationId).all();
    expect(rows.results.length).toBeGreaterThan(8);
    await expect(db.prepare('DELETE FROM archive_publication_records WHERE publication_id=?').bind(publicationId).run()).rejects.toThrow('IMMUTABLE_ARCHIVE_PUBLICATION');
    await expect(db.prepare('DELETE FROM archive_publication_parts WHERE publication_id=?').bind(publicationId).run()).rejects.toThrow('IMMUTABLE_ARCHIVE_PUBLICATION');
    await expect(db.batch([
      ...selected.map(([table, key]) => db.prepare('DELETE FROM archive_publication_records WHERE publication_id=? AND table_name=? AND record_key=?').bind(publicationId, table, key)),
      db.prepare(`UPDATE archive_publication_abandonment_jobs SET state='pending',selection_json='[]',lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=${now} WHERE abandonment_id=? AND lease_token='not-the-owner'`).bind(id),
      db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('STALE_CHECKPOINT','$') END"),
    ])).rejects.toThrow();
    expect((await db.prepare('SELECT * FROM archive_publication_records WHERE publication_id=? ORDER BY part_index,part_offset').bind(publicationId).all()).results).toEqual(rows.results);
    expect(await readJob(id)).toEqual(job);
    await update(id, "state='pending',lease_token=NULL,lease_expires_at=NULL,selection_json='[]'");
    await until(id, 'complete');
    expect(await db.prepare('SELECT count(*) AS n FROM archive_publication_records WHERE publication_id=?').bind(publicationId).first('n')).toBe(0);
  });
  it('keeps permanent owners and the original invalid build unchanged through terminal cleanup', async () => {
    const id = await begin(), db = fixture.app.db, original = await readBuild();
    const owners = (await db.prepare('SELECT * FROM history_request_keys ORDER BY request_id').all()).results;
    await until(id, 'delete_requests');
    await claim(id);
    const before = await readJob(id);
    await db.prepare("UPDATE backup_runtime SET write_locked_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=1").run();
    await expect(db.prepare('DELETE FROM archive_publication_requests WHERE publication_id=?').bind(publicationId).run()).rejects.toThrow('backup_maintenance');
    expect(await readJob(id)).toEqual(before);
    await db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    await update(id, "state='pending',lease_token=NULL,lease_expires_at=NULL,selection_json='[]'");
    await until(id, 'complete');
    const complete = (await readJob(id))!;
    expect(complete).toMatchObject({ state: 'complete', phase: 'complete', lease_token: null, selection_json: '[]', completed_at: expect.any(String) });
    expect(JSON.parse(complete.inventory_json!)).toEqual(JSON.parse(complete.removed_json));
    expect(await readBuild()).toEqual(original);
    expect((await db.prepare('SELECT * FROM history_request_keys ORDER BY request_id').all()).results).toEqual(owners);
    expect((await db.prepare('SELECT kind FROM archive_publication_abandonment_diagnostics WHERE abandonment_id=? ORDER BY revision').bind(id).all()).results).toEqual([{ kind: 'admitted' }, { kind: 'inventoried' }, { kind: 'completed' }]);
    await expect(update(id, "state='pending',phase='delete_parts',completed_at=NULL")).rejects.toThrow('JOB_INVALID');
    await expect(db.prepare('DELETE FROM archive_publication_builds WHERE publication_id=?').bind(publicationId).run()).rejects.toThrow('IMMUTABLE');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it.each(['admitted', 'inventoried'])('rejects copied delete authority with its %s diagnostic missing', async missing => {
    const id = await begin(); await until(id, missing === 'inventoried' ? 'delete_requests' : 'delete_records');
    const job = (await readJob(id))!;
    const snapshot = await snapshotPublicationDatabase(fixture.app, { transformRow: (table, row) =>
      table === 'archive_publication_abandonment_diagnostics' && row.kind === missing ? null : row });
    const restored = await restorePublicationDatabase(snapshot);
    try {
      const before = (await restored.db.prepare('SELECT * FROM archive_publication_records WHERE publication_id=? ORDER BY part_index,part_offset').bind(publicationId).all()).results;
      await expect(restored.db.prepare(`INSERT INTO archive_publication_abandonment_diagnostics(diagnostic_id,abandonment_id,kind,execution_generation,revision,phase,inventory_json,removed_json,build_sha256,recorded_at) SELECT ?,abandonment_id,?,execution_generation,revision,phase,inventory_json,removed_json,build_sha256,${now} FROM archive_publication_abandonment_jobs WHERE abandonment_id=?`).bind(crypto.randomUUID(), missing, id).run()).rejects.toThrow('DIAGNOSTIC_INVALID');
      await expect(advancePublicationAbandonment(restored.db, { abandonmentId: id, generation: job.execution_generation }, { expectedRevision: job.revision })).rejects.toThrow('AUTHORITY_UNAVAILABLE');
      await expect(restored.db.prepare(`UPDATE archive_publication_abandonment_jobs AS j SET state='running',lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),selection_json=${archiveAbandonmentSelectionSql(job.phase)},revision=revision+1,updated_at=${now} WHERE abandonment_id=?`).bind(crypto.randomUUID(), id).run()).rejects.toThrow('JOB_INVALID');
      expect((await restored.db.prepare('SELECT * FROM archive_publication_records WHERE publication_id=? ORDER BY part_index,part_offset').bind(publicationId).all()).results).toEqual(before);
      expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally { await restored.close(); }
  });
});
