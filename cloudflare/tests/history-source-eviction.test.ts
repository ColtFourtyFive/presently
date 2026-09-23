import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { BACKUP_TABLES } from '../worker/backup';
import { startRetentionDryRun, advanceRetentionDryRun } from '../worker/history-retention';
import { evictRetentionSource, scheduleRetentionEvidenceExpiry } from '../worker/history-source-eviction';
import { resolveHistoryRequest } from '../worker/history-request';
import {
  createPublicationFixture,
  createPublicationSeed,
  restorePublicationDatabase,
  snapshotPublicationDatabase,
  type PublicationSeed,
} from './archive-publication-fixture';
import { json } from './helpers';
import { createRuntime, projectRoot, type TestRuntime } from './runtime';

let seed: PublicationSeed;
const runtimes: TestRuntime[] = [];

beforeAll(async () => { seed = await createPublicationSeed(); }, 120_000);
afterAll(() => { seed = undefined as unknown as PublicationSeed; });
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });

async function publishedFixture() {
  const fixture = await createPublicationFixture(seed);
  runtimes.push(fixture.app);
  const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
  const storage = { bucket: fixture.bucket, masterKey: fixture.key };
  let revision = 0;
  for (let step = 0; step < 100; step += 1) {
    const result = await advanceMonthlyPublication(fixture.app.db, storage, handle, { expectedRevision: revision });
    revision = result.revision;
    if (result.state === 'published') return { ...fixture, storage };
  }
  throw new Error('Monthly publication did not finish');
}

async function completeDryRun(fixture: Awaited<ReturnType<typeof publishedFixture>>) {
  const db = fixture.app.db as unknown as D1Database;
  const jobId = await startRetentionDryRun(db, 'test-center', fixture.app.actor.id, 1);
  for (let step = 0; step < 5; step += 1) {
    const result = await advanceRetentionDryRun(db, fixture.storage, jobId);
    if (result.status === 'complete') return jobId;
    if (result.status !== 'planning') throw new Error(`Retention dry run ended as ${result.status}:${result.errorCode ?? 'unknown'}`);
  }
  throw new Error('Retention dry run did not finish');
}

async function enableEviction(fixture: Awaited<ReturnType<typeof publishedFixture>>) {
  await fixture.app.db.prepare("UPDATE archive_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE status IN ('parts','verify')").run();
  await fixture.app.db.prepare(`UPDATE history_source_eviction_policies
    SET enabled=1,revision=revision+1,updated_at=?,updated_by=? WHERE center_id='test-center'`)
    .bind(new Date(Date.now() + 1000).toISOString(), fixture.app.actor.id).run();
}

async function sourceCounts(fixture: Awaited<ReturnType<typeof publishedFixture>>, visitId: string) {
  const values = await Promise.all(['visits', 'attendance_events', 'attendance_corrections', 'reviews'].map(async table => {
    const where = table === 'visits' ? 'id=?' : 'visit_id=?';
    return Number(await fixture.app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(visitId).first('n'));
  }));
  return values;
}

describe('schema 36 evidence expiry and atomic source eviction', () => {
  it('installs atomically and extends the closed backup inventory to all 96 tables', async () => {
    const app = await createRuntime({ migrate: false, bindings: {} });
    runtimes.push(app);
    const names = (await readdir(join(projectRoot, 'migrations'))).filter(name => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of names.filter(name => Number(name.slice(0, 4)) <= 35)) {
      const statements = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
      await app.db.batch(statements.map(sql => app.db.prepare(sql)));
    }
    const migration = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations/0036_evidence_expiry_source_eviction.sql'), 'utf8'));
    await expect(app.db.batch([
      ...migration.map(sql => app.db.prepare(sql)),
      app.db.prepare('INSERT INTO schema_versions(version) VALUES(35)'),
    ])).rejects.toThrow();
    expect(await app.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'history_source_eviction_%' OR name='history_evidence_expiry_schedules'").first('n')).toBe(0);
    expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(35);
    await app.db.batch(migration.map(sql => app.db.prepare(sql)));
    expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(36);
    expect(new Set(BACKUP_TABLES).size).toBe(96);
    for (const table of [
      'history_evidence_expiry_schedules', 'history_source_revisions', 'history_source_eviction_policies',
      'history_source_eviction_policy_revisions', 'history_source_eviction_capabilities',
      'history_source_eviction_receipts',
    ]) expect(BACKUP_TABLES).toContain(table);
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }, 120_000);

  it('creates explicit immutable expiry schedules only when the retained policy enables scheduling', async () => {
    const fixture = await publishedFixture();
    await fixture.app.db.prepare(`UPDATE history_retention_policies
      SET evidence_expiry_enabled=1,revision=revision+1,updated_at=?,updated_by=? WHERE center_id='test-center'`)
      .bind(new Date(Date.now() + 1000).toISOString(), fixture.app.actor.id).run();
    const jobId = await completeDryRun(fixture);
    const managerEmail = `expiry-manager-${crypto.randomUUID()}@example.test`;
    await json(await fixture.app.request('/api/admin/staff', {
      token: fixture.app.token,
      body: { email: managerEmail, displayName: 'Expiry Manager', role: 'manager', kioskEnabled: false },
    }), 201);
    const manager = await fixture.app.signer.token({ email: managerEmail });
    expect((await fixture.app.request(`/api/admin/archives/retention/${jobId}/schedule-expiry`, {
      token: manager, body: {},
    })).status).toBe(403);
    const first = await json<Awaited<ReturnType<typeof scheduleRetentionEvidenceExpiry>>>(
      await fixture.app.request(`/api/admin/archives/retention/${jobId}/schedule-expiry`, {
        token: fixture.app.token, body: {},
      }), 201,
    );
    expect(first).toEqual({ jobId, scheduled: 1, total: 1, deleteEnabled: false });
    const second = await scheduleRetentionEvidenceExpiry(fixture.app.db as unknown as D1Database, jobId, fixture.app.actor.id);
    expect(second).toEqual({ jobId, scheduled: 0, total: 1, deleteEnabled: false });
    const row = await fixture.app.db.prepare('SELECT * FROM history_evidence_expiry_schedules WHERE job_id=?').bind(jobId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ delete_enabled: 0, status: 'scheduled', policy_revision: 2 });
    expect(Date.parse(String(row!.evidence_expires_at))).toBeGreaterThan(Date.now());
    await expect(fixture.app.db.prepare('UPDATE history_evidence_expiry_schedules SET status=? WHERE schedule_id=?')
      .bind('cancelled', row!.schedule_id).run()).rejects.toThrow('IMMUTABLE_EVIDENCE_EXPIRY_SCHEDULE');
  }, 120_000);

  it('keeps eviction disabled by default, then atomically removes only verified live source and preserves replay authority', async () => {
    const fixture = await publishedFixture();
    const jobId = await completeDryRun(fixture);
    const item = await fixture.app.db.prepare('SELECT * FROM history_retention_items WHERE job_id=?').bind(jobId).first<Record<string, unknown>>();
    const visitId = String(item!.visit_id);
    const before = await sourceCounts(fixture, visitId);
    await expect(evictRetentionSource(fixture.app.db as unknown as D1Database, fixture.storage, jobId, visitId, fixture.app.actor.id))
      .rejects.toThrow('SOURCE_EVICTION_DISABLED');
    expect(await sourceCounts(fixture, visitId)).toEqual(before);

    await enableEviction(fixture);
    const result = await evictRetentionSource(fixture.app.db as unknown as D1Database, fixture.storage, jobId, visitId, fixture.app.actor.id);
    expect(result).toMatchObject({ jobId, visitId, alreadyComplete: false });
    expect(await sourceCounts(fixture, visitId)).toEqual([0, 0, 0, 0]);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_capabilities').first('n')).toBe(0);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_receipts WHERE visit_id=?').bind(visitId).first('n')).toBe(1);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_visit_heads WHERE visit_id=?').bind(visitId).first('n')).toBe(1);

    const closure = JSON.parse(String(item!.source_closure_json)) as { events: Record<string, unknown>[]; corrections: Record<string, unknown>[] };
    const event = closure.events[0];
    const replay = await resolveHistoryRequest(fixture.app.db, {
      id: String(event.id), centerId: 'test-center', kind: 'event', payloadHash: String(event.payload_hash),
    }, fixture.storage);
    expect(replay).toMatchObject({ id: event.id, visit_id: visitId, payload_hash: event.payload_hash });
    const retry = await evictRetentionSource(fixture.app.db as unknown as D1Database, fixture.storage, jobId, visitId, fixture.app.actor.id);
    expect(retry).toMatchObject({ receiptId: result.receiptId, alreadyComplete: true });
  }, 120_000);

  it('restores expiry and eviction evidence while revoking all live source-eviction authority', async () => {
    const fixture = await publishedFixture();
    await fixture.app.db.prepare(`UPDATE history_retention_policies
      SET evidence_expiry_enabled=1,revision=revision+1,updated_at=?,updated_by=? WHERE center_id='test-center'`)
      .bind(new Date(Date.now() + 1000).toISOString(), fixture.app.actor.id).run();
    const jobId = await completeDryRun(fixture);
    await scheduleRetentionEvidenceExpiry(fixture.app.db as unknown as D1Database, jobId, fixture.app.actor.id);
    const item = await fixture.app.db.prepare('SELECT visit_id,source_revision FROM history_retention_items WHERE job_id=?')
      .bind(jobId).first<{ visit_id: string; source_revision: number }>();
    await enableEviction(fixture);
    await evictRetentionSource(
      fixture.app.db as unknown as D1Database,
      fixture.storage,
      jobId,
      item!.visit_id,
      fixture.app.actor.id,
    );

    const evidenceTables = [
      'history_evidence_expiry_schedules',
      'history_source_revisions',
      'history_source_eviction_policy_revisions',
      'history_source_eviction_receipts',
    ] as const;
    const before = Object.fromEntries(await Promise.all(evidenceTables.map(async table => [
      table,
      (await fixture.app.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results,
    ])));
    const policyBefore = await fixture.app.db.prepare('SELECT * FROM history_source_eviction_policies WHERE center_id=?')
      .bind('test-center').first<Record<string, unknown>>();
    expect(policyBefore!.enabled).toBe(1);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_capabilities').first('n')).toBe(0);

    const restored = await restorePublicationDatabase(await snapshotPublicationDatabase(fixture.app));
    runtimes.push(restored);
    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));

    expect(await restored.db.prepare('SELECT count(*) AS n FROM history_source_eviction_capabilities').first('n')).toBe(0);
    expect(await restored.db.prepare('SELECT source_revision FROM history_retention_items WHERE job_id=?')
      .bind(jobId).first('source_revision')).toBe(item!.source_revision);
    for (const table of evidenceTables) {
      const rows = (await restored.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results;
      if (table === 'history_source_eviction_policy_revisions') {
        expect(rows.slice(0, before[table].length)).toEqual(before[table]);
        expect(rows).toHaveLength(before[table].length + 1);
        expect(rows.at(-1)).toMatchObject({ enabled: 0, revision: Number(policyBefore!.revision) + 1 });
      } else expect(rows, table).toEqual(before[table]);
    }
    expect(await restored.db.prepare('SELECT enabled,revision FROM history_source_eviction_policies WHERE center_id=?')
      .bind('test-center').first()).toEqual({ enabled: 0, revision: Number(policyBefore!.revision) + 1 });
    await restored.db.batch(reset.map(sql => restored.db.prepare(sql)));
    expect(await restored.db.prepare('SELECT count(*) AS n FROM history_source_eviction_capabilities').first('n')).toBe(0);
    expect(await restored.db.prepare('SELECT count(*) AS n FROM history_source_eviction_policy_revisions')
      .first('n')).toBe(before.history_source_eviction_policy_revisions.length + 1);
  }, 120_000);

  it('fails the complete source-eviction batch closed when a backup snapshot lock is active', async () => {
    const fixture = await publishedFixture();
    await fixture.app.db.prepare(`UPDATE history_retention_policies
      SET evidence_expiry_enabled=1,revision=revision+1,updated_at=?,updated_by=? WHERE center_id='test-center'`)
      .bind(new Date(Date.now() + 1000).toISOString(), fixture.app.actor.id).run();
    const jobId = await completeDryRun(fixture);
    const visitId = await fixture.app.db.prepare('SELECT visit_id FROM history_retention_items WHERE job_id=?')
      .bind(jobId).first<string>('visit_id');
    const before = await sourceCounts(fixture, visitId!);
    await enableEviction(fixture);
    await fixture.app.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1')
      .bind(new Date(Date.now() + 60_000).toISOString(), crypto.randomUUID()).run();

    await expect(scheduleRetentionEvidenceExpiry(
      fixture.app.db as unknown as D1Database,
      jobId,
      fixture.app.actor.id,
    )).rejects.toThrow('backup_maintenance');
    await expect(evictRetentionSource(
      fixture.app.db as unknown as D1Database,
      fixture.storage,
      jobId,
      visitId!,
      fixture.app.actor.id,
    )).rejects.toThrow('SOURCE_EVICTION_AUTHORITY_INVALID');
    expect(await sourceCounts(fixture, visitId!)).toEqual(before);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_evidence_expiry_schedules').first('n')).toBe(0);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_capabilities').first('n')).toBe(0);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_receipts').first('n')).toBe(0);
  }, 120_000);

  it('rolls the entire batch back when receipt insertion fails after every source delete', async () => {
    const fixture = await publishedFixture();
    const jobId = await completeDryRun(fixture);
    const visitId = await fixture.app.db.prepare('SELECT visit_id FROM history_retention_items WHERE job_id=?').bind(jobId).first<string>('visit_id');
    const before = await sourceCounts(fixture, visitId!);
    await enableEviction(fixture);
    await fixture.app.db.prepare(`CREATE TRIGGER test_source_eviction_late_failure
      BEFORE INSERT ON history_source_eviction_receipts BEGIN SELECT RAISE(ABORT,'TEST_LATE_FAILURE'); END`).run();
    await expect(evictRetentionSource(fixture.app.db as unknown as D1Database, fixture.storage, jobId, visitId!, fixture.app.actor.id))
      .rejects.toThrow('TEST_LATE_FAILURE');
    expect(await sourceCounts(fixture, visitId!)).toEqual(before);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_capabilities').first('n')).toBe(0);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_receipts').first('n')).toBe(0);
  }, 120_000);

  it('fails closed when a hold arrives during the authenticated R2 recheck', async () => {
    const fixture = await publishedFixture();
    const jobId = await completeDryRun(fixture);
    const head = await fixture.app.db.prepare(`SELECT h.* FROM history_visit_heads h
      JOIN history_retention_items i ON i.visit_id=h.visit_id WHERE i.job_id=?`).bind(jobId).first<Record<string, unknown>>();
    await enableEviction(fixture);
    let reads = 0;
    const racingStorage = {
      masterKey: fixture.key,
      bucket: {
        put: (key: string, value: Uint8Array) => fixture.bucket.put(key, value),
        get: async (key: string) => {
          const object = await fixture.bucket.get(key);
          reads += 1;
          if (reads === 2) await fixture.app.db.prepare(`INSERT INTO history_holds(
            hold_id,center_id,target_kind,student_id,visit_id,target_head_version,
            target_original_check_in_at,reason,created_at,created_by,source_schema
          ) VALUES(?,?,?,?,?,?,?,?,?,?,2)`).bind(
            crypto.randomUUID(), 'test-center', 'visit', head!.student_id, head!.visit_id,
            head!.version, head!.original_check_in_at, 'Hold added during final R2 verification',
            new Date().toISOString(), fixture.app.actor.id,
          ).run();
          return object;
        },
      },
    };
    await expect(evictRetentionSource(fixture.app.db as unknown as D1Database, racingStorage, jobId, String(head!.visit_id), fixture.app.actor.id))
      .rejects.toThrow('SOURCE_EVICTION_AUTHORITY_INVALID');
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM visits WHERE id=?').bind(head!.visit_id).first('n')).toBe(1);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_receipts').first('n')).toBe(0);
  }, 120_000);

  it('fails closed when a correction changes the visit during the authenticated R2 recheck', async () => {
    const fixture = await publishedFixture();
    const jobId = await completeDryRun(fixture);
    const head = await fixture.app.db.prepare(`SELECT h.* FROM history_visit_heads h
      JOIN history_retention_items i ON i.visit_id=h.visit_id WHERE i.job_id=?`).bind(jobId).first<Record<string, unknown>>();
    await enableEviction(fixture);
    let reads = 0;
    const racingStorage = {
      masterKey: fixture.key,
      bucket: {
        put: (key: string, value: Uint8Array) => fixture.bucket.put(key, value),
        get: async (key: string) => {
          const object = await fixture.bucket.get(key);
          reads += 1;
          if (reads === 2) await json(await fixture.app.request(`/api/admin/visits/${String(head!.visit_id)}/corrections`, {
            token: fixture.app.token,
            body: {
              correctionId: crypto.randomUUID(),
              expectedVersion: Number(head!.version),
              checkInAt: new Date(Date.parse(String(head!.check_in_at)) + 1000).toISOString(),
              checkOutAt: head!.check_out_at,
              reason: 'Correction entered while source eviction was verifying R2 evidence.',
            },
          }), 201);
          return object;
        },
      },
    };
    await expect(evictRetentionSource(fixture.app.db as unknown as D1Database, racingStorage, jobId, String(head!.visit_id), fixture.app.actor.id))
      .rejects.toThrow(/SOURCE_EVICTION_|RETENTION_EVIDENCE_HEAD_MISMATCH/);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM visits WHERE id=?').bind(head!.visit_id).first('n')).toBe(1);
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM history_source_eviction_receipts').first('n')).toBe(0);
  }, 120_000);
});
