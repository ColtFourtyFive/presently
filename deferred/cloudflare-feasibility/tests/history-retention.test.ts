import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { advancePublicationReconciliation, startPublicationReconciliation } from '../worker/archive-publication-reconciliation';
import { advanceRetentionDryRun, startRetentionDryRun } from '../worker/history-retention';
import { BACKUP_TABLES } from '../worker/backup';
import {
  createPublicationFixture,
  createPublicationSeed,
  refreshPublicationProof,
  type PublicationSeed,
} from './archive-publication-fixture';
import { json } from './helpers';

let seed: PublicationSeed;

async function publishedFixture() {
  const fixture = await createPublicationFixture(seed);
  const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
  const storage = { bucket: fixture.bucket, masterKey: fixture.key };
  let revision = 0;
  for (let step = 0; step < 100; step++) {
    const result = await advanceMonthlyPublication(fixture.app.db, storage, handle, { expectedRevision: revision });
    revision = result.revision;
    if (result.state === 'published') return { ...fixture, storage, publicationId: handle.publicationId };
  }
  await fixture.app.close();
  throw new Error('Monthly publication did not finish');
}


const nativeDb = (fixture: Awaited<ReturnType<typeof publishedFixture>>) => fixture.app.db as unknown as D1Database;

async function count(fixture: Awaited<ReturnType<typeof publishedFixture>>, table: string) {
  return Number(await fixture.app.db.prepare(`SELECT count(*) FROM "${table}"`).first('count(*)'));
}

describe('schema 33 holds and retention dry runs', () => {
  beforeAll(async () => { seed = await createPublicationSeed(); }, 120_000);
  afterAll(() => { seed = undefined as unknown as PublicationSeed; });

  it('rereads authenticated R2 evidence, emits one bounded non-delete receipt, and preserves every source row', async () => {
    const fixture = await publishedFixture();
    try {
      const before = {
        visits: await count(fixture, 'visits'),
        events: await count(fixture, 'attendance_events'),
        corrections: await count(fixture, 'attendance_corrections'),
        audits: await count(fixture, 'audit_entries'),
      };
      const jobId = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      const selected = await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, jobId);
      expect(selected).toMatchObject({ status: 'planning', processed: 1, candidateCount: 1 });
      const completed = await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, jobId);
      expect(completed).toMatchObject({ status: 'complete', processed: 0, candidateCount: 1 });
      const item = await fixture.app.db.prepare('SELECT * FROM history_retention_items WHERE job_id=?').bind(jobId).first<Record<string, unknown>>();
      expect(item).toMatchObject({ sequence: 1, head_residency: 'live' });
      expect(String(item!.source_closure_sha256)).toHaveLength(44);
      expect(String(item!.evidence_closure_sha256)).toHaveLength(44);
      expect(await fixture.app.db.prepare('SELECT mode,delete_enabled,candidate_count FROM history_retention_permits WHERE job_id=?').bind(jobId).first())
        .toEqual({ mode: 'dry_run', delete_enabled: 0, candidate_count: 1 });
      expect({
        visits: await count(fixture, 'visits'),
        events: await count(fixture, 'attendance_events'),
        corrections: await count(fixture, 'attendance_corrections'),
        audits: await count(fixture, 'audit_entries'),
      }).toEqual(before);
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('uses reconciled current availability after restore without rewriting immutable publication generations', async () => {
    const fixture = await publishedFixture();
    try {
      const originalGeneration = await fixture.app.db.prepare('SELECT generation FROM archive_publications WHERE publication_id=?')
        .bind(fixture.publicationId).first<string>('generation');
      const reset = await readFile(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8');
      await fixture.app.db.batch(unstable_splitSqlQuery(reset).map(sql => fixture.app.db.prepare(sql)));
      const proof = await refreshPublicationProof(fixture.app, fixture);
      const reconciliation = await startPublicationReconciliation(fixture.app.db, fixture.publicationId, proof.handle);
      let revision = 0;
      for (let step = 0; step < 200; step += 1) {
        const result = await advancePublicationReconciliation(
          fixture.app.db,
          fixture.storage,
          reconciliation,
          { expectedRevision: revision },
        );
        revision = result.revision;
        if (result.state === 'complete') break;
        if (step === 199) throw new Error('Publication reconciliation did not finish');
      }
      const authority = await fixture.app.db.prepare(`SELECT p.generation AS publication_generation,
        a.generation AS availability_generation FROM archive_publications p
        JOIN archive_publication_availability a ON a.publication_id=p.publication_id
        WHERE p.publication_id=?`).bind(fixture.publicationId).first<Record<string, unknown>>();
      expect(authority!.publication_generation).toBe(originalGeneration);
      expect(authority!.availability_generation).not.toBe(originalGeneration);

      const jobId = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      expect(await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, jobId))
        .toMatchObject({ status: 'planning', processed: 1, candidateCount: 1 });
      expect(await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, jobId))
        .toMatchObject({ status: 'complete', candidateCount: 1 });
      expect(await fixture.app.db.prepare('SELECT delete_enabled FROM history_retention_permits WHERE job_id=?')
        .bind(jobId).first('delete_enabled')).toBe(0);
    } finally { await fixture.app.close(); }
  }, 180_000);

  it('blocks a hold before selection and invalidates work when a hold wins after selection', async () => {
    const fixture = await publishedFixture();
    try {
      const first = await fixture.app.db.prepare(`SELECT visit_id,student_id,version,original_check_in_at
        FROM history_visit_heads WHERE center_id='test-center' AND check_out_at IS NOT NULL
        ORDER BY original_check_in_at,visit_id LIMIT 1`).first<Record<string, unknown>>();
      const held = await json<{ holdId: string }>(await fixture.app.request('/api/admin/archives/holds', {
        token: fixture.app.token,
        body: { visitId: first!.visit_id, reason: 'Preserve for active family review' },
      }), 201);
      const firstJob = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      expect((await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, firstJob)).processed).toBe(1);
      expect(await fixture.app.db.prepare('SELECT visit_id FROM history_retention_items WHERE job_id=?').bind(firstJob).first('visit_id'))
        .not.toBe(first!.visit_id);
      await json(await fixture.app.request(`/api/admin/archives/holds/${held.holdId}/release`, {
        token: fixture.app.token,
        body: { reason: 'Family review completed and evidence retained' },
      }));
      expect(await count(fixture, 'visits')).toBeGreaterThan(0);

      await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, firstJob);
      const secondJob = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      const selected = await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, secondJob);
      expect(selected.processed).toBe(1);
      const selectedVisit = await fixture.app.db.prepare('SELECT visit_id FROM history_retention_items WHERE job_id=?').bind(secondJob).first<string>('visit_id');
      await json(await fixture.app.request('/api/admin/archives/holds', {
        token: fixture.app.token,
        body: { visitId: selectedVisit, reason: 'Preserve after dry-run selection' },
      }), 201);
      expect(await fixture.app.db.prepare('SELECT status FROM history_retention_jobs WHERE job_id=?').bind(secondJob).first('status')).toBe('invalid');
      expect(await fixture.app.db.prepare('SELECT reason FROM history_retention_invalidations WHERE job_id=?').bind(secondJob).first('reason')).toBe('hold-added');
      expect(await fixture.app.db.prepare('SELECT count(*) FROM history_retention_permits WHERE job_id=?').bind(secondJob).first('count(*)')).toBe(0);
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('cannot commit a candidate when a hold is added during authenticated R2 readback', async () => {
    const fixture = await publishedFixture();
    try {
      const target = await fixture.app.db.prepare(`SELECT visit_id,student_id,version,original_check_in_at
        FROM history_visit_heads WHERE center_id='test-center' AND check_out_at IS NOT NULL
        ORDER BY original_check_in_at,visit_id LIMIT 1`).first<Record<string, unknown>>();
      const jobId = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      let reads = 0;
      const storage = {
        masterKey: fixture.key,
        bucket: {
          put: (key: string, value: Uint8Array) => fixture.bucket.put(key, value),
          get: async (key: string) => {
            const object = await fixture.bucket.get(key);
            reads += 1;
            if (reads === 2) {
              await fixture.app.db.prepare(`INSERT INTO history_holds(
                hold_id,center_id,target_kind,student_id,visit_id,target_head_version,
                target_original_check_in_at,reason,created_at,created_by,source_schema
              ) VALUES(?,?,?,?,?,?,?,?,?,?,2)`).bind(
                crypto.randomUUID(), 'test-center', 'visit', target!.student_id, target!.visit_id,
                target!.version, target!.original_check_in_at, 'Hold added while R2 evidence is being checked',
                new Date().toISOString(), fixture.app.actor.id,
              ).run();
            }
            return object;
          },
        },
      };
      const result = await advanceRetentionDryRun(nativeDb(fixture), storage, jobId);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ status: 'invalid', processed: 0, candidateCount: 0 });
      expect(await fixture.app.db.prepare('SELECT count(*) FROM history_retention_items WHERE job_id=?').bind(jobId).first('count(*)')).toBe(0);
      expect(await fixture.app.db.prepare('SELECT count(*) FROM history_retention_permits WHERE job_id=?').bind(jobId).first('count(*)')).toBe(0);
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('lets a source-free history head receive and release an immutable hold without deleting evidence', async () => {
    const fixture = await publishedFixture();
    try {
      const row = await fixture.app.db.prepare(`SELECT visit_id FROM history_visit_heads
        WHERE center_id='test-center' ORDER BY original_check_in_at LIMIT 1`).first<{ visit_id: string }>();
      const visitId = row!.visit_id;
      await fixture.app.db.prepare("UPDATE archive_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE status IN ('parts','verify')").run();
      const drops = [
        'attendance_no_delete','correction_no_delete','audit_no_delete','history_visit_no_delete','history_review_no_delete',
        'backup_guard_attendance_events_delete','backup_guard_attendance_corrections_delete',
        'backup_guard_audit_entries_delete','backup_guard_reviews_delete','backup_guard_visits_delete',
      ];
      await fixture.app.db.batch(drops.map(name => fixture.app.db.prepare(`DROP TRIGGER IF EXISTS "${name}"`)));
      await fixture.app.db.prepare('PRAGMA defer_foreign_keys=ON').run();
      await fixture.app.db.batch([
        fixture.app.db.prepare("DELETE FROM audit_entries WHERE entity_id=? OR entity_id IN (SELECT id FROM attendance_events WHERE visit_id=?) OR entity_id IN (SELECT id FROM reviews WHERE visit_id=?)").bind(visitId, visitId, visitId),
        fixture.app.db.prepare('DELETE FROM reviews WHERE visit_id=?').bind(visitId),
        fixture.app.db.prepare('DELETE FROM attendance_corrections WHERE visit_id=?').bind(visitId),
        fixture.app.db.prepare('DELETE FROM attendance_events WHERE visit_id=?').bind(visitId),
        fixture.app.db.prepare('DELETE FROM visits WHERE id=?').bind(visitId),
      ]);
      expect(await fixture.app.db.prepare('SELECT count(*) FROM visits WHERE id=?').bind(visitId).first('count(*)')).toBe(0);
      const hold = await json<{ holdId: string }>(await fixture.app.request('/api/admin/archives/holds', {
        token: fixture.app.token,
        body: { visitId, reason: 'Preserve source-free historical visit' },
      }), 201);
      expect(await fixture.app.db.prepare('SELECT visit_id FROM history_holds WHERE hold_id=?').bind(hold.holdId).first('visit_id')).toBe(visitId);
      expect(await fixture.app.db.prepare('SELECT count(*) FROM archive_holds WHERE id=?').bind(hold.holdId).first('count(*)')).toBe(0);
      await json(await fixture.app.request(`/api/admin/archives/holds/${hold.holdId}/release`, {
        token: fixture.app.token,
        body: { reason: 'Historical review completed safely' },
      }));
      expect(await fixture.app.db.prepare('SELECT release_reason FROM history_hold_releases WHERE hold_id=?').bind(hold.holdId).first('release_reason'))
        .toBe('Historical review completed safely');
      await expect(fixture.app.db.prepare('UPDATE history_holds SET reason=? WHERE hold_id=?').bind('changed', hold.holdId).run())
        .rejects.toThrow('IMMUTABLE_HISTORY_HOLD');
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('invalidates unfinished work on source drift and restoration, resumes expired leases, and respects backup maintenance', async () => {
    const fixture = await publishedFixture();
    try {
      const driftJob = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, driftJob);
      const visitId = await fixture.app.db.prepare('SELECT visit_id FROM history_retention_items WHERE job_id=?').bind(driftJob).first<string>('visit_id');
      await fixture.app.db.prepare(`INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), 'test-center', fixture.app.actor.id, fixture.app.actor.displayName,
        'retention_test_note', 'visit', visitId, '{}', new Date().toISOString()).run();
      expect(await fixture.app.db.prepare('SELECT status FROM history_retention_jobs WHERE job_id=?').bind(driftJob).first('status')).toBe('invalid');

      const restoreJob = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      await fixture.app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1").run();
      expect(await fixture.app.db.prepare('SELECT status FROM history_retention_jobs WHERE job_id=?').bind(restoreJob).first('status')).toBe('invalid');

      // Restore invalidates the publication projection. This check exercises
      // expired-lease reclaim on a fresh empty dry run without claiming R2 authority.
      await fixture.app.db.prepare("UPDATE history_runtime SET state='ready' WHERE id=1").run();
      const emptyJob = await startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1);
      await fixture.app.db.prepare('UPDATE history_retention_jobs SET lease_token=?,lease_expires_at=? WHERE job_id=?')
        .bind('expired-owner', '2000-01-01T00:00:00.000Z', emptyJob).run();
      const reclaimed = await advanceRetentionDryRun(nativeDb(fixture), fixture.storage, emptyJob);
      expect(reclaimed.busy).toBe(false);

      await fixture.app.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1')
        .bind(new Date(Date.now() + 60_000).toISOString(), crypto.randomUUID()).run();
      await expect(startRetentionDryRun(nativeDb(fixture), 'test-center', fixture.app.actor.id, 1)).rejects.toThrow('RETENTION_START_CONFLICT');
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('keeps every retention table in backup inventory and contains no source-delete path', async () => {
    expect(BACKUP_TABLES).toEqual(expect.arrayContaining([
      'history_holds','history_hold_releases','history_retention_policies',
      'history_retention_policy_revisions','history_retention_jobs','history_retention_items',
      'history_retention_invalidations','history_retention_permits',
    ]));
    const [worker, migration] = await Promise.all([
      readFile(new URL('../worker/history-retention.ts', import.meta.url), 'utf8'),
      readFile(new URL('../migrations/0033_history_retention_dry_run.sql', import.meta.url), 'utf8'),
    ]);
    expect(worker).not.toMatch(/DELETE\s+FROM\s+(visits|attendance_events|attendance_corrections|reviews|audit_entries)/i);
    expect(migration).not.toMatch(/CREATE\s+TRIGGER[^;]+BEFORE\s+DELETE[^;]+history_retention_permits[^;]+(?:allow|permit)/i);
    expect(migration).toContain("CHECK(delete_enabled=0)");
    expect(migration).toContain('CREATE TRIGGER history_retention_addendum_insert_drift');
    expect(migration).toContain('CREATE TRIGGER history_retention_addendum_availability_drift');
  });
});
