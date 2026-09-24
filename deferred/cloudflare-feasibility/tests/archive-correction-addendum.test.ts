import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  publishCorrectionAddendum,
  maintainCorrectionAddenda,
  readPublishedCorrectionAddendum,
  reconcileCorrectionAddendum,
  startCorrectionAddendumPublication,
  startCorrectionAddendumReconciliation,
  type AddendumStorage,
} from '../worker/archive-correction-addendum';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { startBackup } from '../worker/backup';
import { BACKUP_TABLES } from '../worker/backup';
import {
  advancePublicationReconciliation,
  startPublicationReconciliation,
} from '../worker/archive-publication-reconciliation';
import {
  createPublicationFixture,
  createPublicationSeed,
  refreshPublicationProof,
  restorePublicationDatabase,
  snapshotPublicationDatabase,
} from './archive-publication-fixture';
import type { ArchiveRecord, ArchiveReference } from '../shared/archive-format';
import { createRuntime, projectRoot, type TestRuntime } from './runtime';
import type { Env } from '../worker/types';

type Base = {
  sql: string;
  key: string;
  objects: Map<string, Uint8Array>;
  reference: ArchiveReference;
  publicationId: string;
  visit: ArchiveRecord;
  actorName: string;
};

let base: Base;

beforeAll(async () => {
  const fixture = await createPublicationFixture(await createPublicationSeed());
  try {
    const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
    let revision = 0;
    for (let step = 0; step < 200; step += 1) {
      const result = await advanceMonthlyPublication(
        fixture.app.db,
        { bucket: fixture.bucket, masterKey: fixture.key },
        handle,
        { expectedRevision: revision },
      );
      revision = result.revision;
      if (result.state === 'published') break;
      if (step === 199) throw new Error('Monthly publication fixture did not finish');
    }
    const visit = fixture.records.find(record => record.table === 'visits');
    if (!visit) throw new Error('Monthly publication fixture has no visit');
    const staff = fixture.records.find(record => record.table === 'staff' && record.key === visit.row.check_in_by);
    if (!staff || typeof staff.row.display_name !== 'string') throw new Error('Monthly publication actor missing');
    base = {
      sql: await snapshotPublicationDatabase(fixture.app, { omitTables: ['visits', 'attendance_events', 'attendance_corrections', 'reviews', 'audit_entries'] }),
      key: fixture.key,
      objects: new Map(fixture.objects),
      reference: fixture.reference,
      publicationId: handle.publicationId,
      visit,
      actorName: staff.row.display_name,
    };
  } finally {
    await fixture.app.close();
  }
}, 120_000);

async function restored(): Promise<{ app: TestRuntime; storage: AddendumStorage }> {
  const app = await restorePublicationDatabase(base.sql, { r2: true });
  const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  for (const [key, bytes] of base.objects) await bucket.put(key, bytes);
  return { app, storage: { bucket, masterKey: base.key } };
}

async function addCorrection(app: TestRuntime, sequence = 1): Promise<string> {
  const id = crypto.randomUUID();
  const head = await app.db.prepare(`SELECT h.*,s.display_name AS actor_name
    FROM history_visit_heads h JOIN staff s ON s.id=? WHERE h.visit_id=?`)
    .bind(base.visit.row.check_in_by, base.visit.key).first<Record<string, unknown>>();
  if (!head) throw new Error('Retained visit head missing');
  const checkInAt = new Date(Date.parse(String(head.check_in_at)) + sequence * 1_000).toISOString();
  const checkOutAt = head.check_out_at === null
    ? null
    : new Date(Date.parse(String(head.check_out_at)) + sequence * 1_000).toISOString();
  const recordedAt = new Date(Math.max(Date.parse(checkOutAt ?? checkInAt), Date.now() - 10_000) + 2_000).toISOString();
  await app.db.prepare(`INSERT INTO history_correction_outbox(
    id,center_id,visit_id,student_id,expected_version,prior_check_in_at,prior_check_out_at,
    check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash,
    original_check_in_at,original_check_out_at,check_in_by,check_out_by,guardian_id,
    departure_type,review_status,resulting_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      id, head.center_id, head.visit_id, head.student_id, head.version,
      head.check_in_at, head.check_out_at, checkInAt, checkOutAt,
      `Verified archived correction ${sequence}`,
      base.visit.row.check_in_by, base.actorName, recordedAt, sequence.toString(16).padStart(64, '0'),
      head.original_check_in_at, head.original_check_out_at,
      base.visit.row.check_in_by, base.visit.row.check_out_by,
      base.visit.row.guardian_id, base.visit.row.departure_type,
      head.review_status, Number(head.version) + 1,
    ).run();
  return id;
}

async function publishOne(app: TestRuntime, storage: AddendumStorage, correctionId: string) {
  const handle = await startCorrectionAddendumPublication(app.db, correctionId);
  const result = await publishCorrectionAddendum(app.db, storage, handle, 'addendum-test');
  return { handle, result };
}

async function rotateGeneration(app: TestRuntime) {
  const reset = await readFile(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8');
  await app.db.batch(unstable_splitSqlQuery(reset).map(sql => app.db.prepare(sql)));
}

async function reconcileMonthly(app: TestRuntime, storage: AddendumStorage) {
  const proof = await refreshPublicationProof(app, { key: base.key, reference: base.reference, objects: base.objects });
  const handle = await startPublicationReconciliation(app.db, base.publicationId, proof.handle);
  let revision = 0;
  for (let step = 0; step < 200; step += 1) {
    const result = await advancePublicationReconciliation(app.db, storage, handle, { expectedRevision: revision });
    revision = result.revision;
    if (result.state === 'complete') return;
  }
  throw new Error('Monthly reconciliation did not finish');
}

describe('schema 32 archived correction addenda', () => {
  it('rolls back a failed native migration batch then installs the complete schema atomically', async () => {
    const app = await createRuntime({ migrate: false, bindings: {} });
    try {
      const names = (await readdir(join(projectRoot, 'migrations')))
        .filter(name => /^\d{4}.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 31)
        .sort();
      for (const name of names) {
        const statements = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
        await app.db.batch(statements.map(statement => app.db.prepare(statement)));
      }
      const migration = unstable_splitSqlQuery(
        await readFile(join(projectRoot, 'migrations/0032_archived_correction_addenda.sql'), 'utf8'),
      );
      await expect(app.db.batch([
        ...migration.map(statement => app.db.prepare(statement)),
        app.db.prepare('INSERT INTO schema_versions(version) VALUES(31)'),
      ])).rejects.toThrow();
      expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(31);
      expect(await app.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'archive_correction_addendum_%'")
        .first('n')).toBe(0);
      await app.db.batch(migration.map(statement => app.db.prepare(statement)));
      expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(32);
      expect(await app.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'archive_correction_addendum_%'")
        .first('n')).toBe(5);
      expect(new Set(BACKUP_TABLES).size).toBe(96);
      for (const table of [
        'archive_correction_addendum_builds',
        'archive_correction_addendum_publications',
        'archive_correction_addendum_availability',
        'archive_correction_addendum_reconciliation_jobs',
        'archive_correction_addendum_reconciliation_receipts',
      ]) expect(BACKUP_TABLES).toContain(table);
      expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('publishes immutable source-free R2 evidence, replays safely, and chains the next correction', async () => {
    const { app, storage } = await restored();
    try {
      expect(await app.db.prepare('SELECT count(*) n FROM visits WHERE id=?').bind(base.visit.key).first('n')).toBe(0);
      const firstId = await addCorrection(app, 1);
      const first = await publishOne(app, storage, firstId);
      expect(first.result.replay).toBe(false);
      expect(first.result.records.map(record => record.table)).toEqual(['visits', 'attendance_corrections', 'audit_entries']);
      expect(await publishCorrectionAddendum(app.db, storage, first.handle)).toMatchObject({ replay: true });
      const read = await readPublishedCorrectionAddendum(app.db, storage, firstId);
      expect(read.visit.row.version).toBe(Number(base.visit.row.version) + 1);
      expect(read.correction.key).toBe(firstId);
      expect(read.audit.key).toBe(firstId);
      const secondId = await addCorrection(app, 2);
      const second = await publishOne(app, storage, secondId);
      expect(second.result.replay).toBe(false);
      expect(await app.db.prepare('SELECT parent_kind,chain_depth FROM archive_correction_addendum_publications WHERE publication_id=?')
        .bind(second.handle.publicationId).first()).toEqual({ parent_kind: 'addendum', chain_depth: 2 });
      expect(await app.db.prepare('SELECT count(*) n FROM history_correction_outbox WHERE id IN (?,?)')
        .bind(firstId, secondId).first('n')).toBe(2);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_publications').first('n')).toBe(2);
      expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      await expect(app.db.prepare("UPDATE archive_correction_addendum_publications SET records_sha256=? WHERE publication_id=?")
        .bind('f'.repeat(64), first.handle.publicationId).run()).rejects.toThrow('IMMUTABLE_ARCHIVE_ADDENDUM');
      await expect(app.db.prepare('DELETE FROM archive_correction_addendum_builds WHERE publication_id=?')
        .bind(first.handle.publicationId).run()).rejects.toThrow('IMMUTABLE_ARCHIVE_ADDENDUM');
      const forgedAt = new Date(Date.now() + 1_000).toISOString();
      await expect(app.db.prepare(`INSERT INTO archive_correction_addendum_reconciliation_jobs(
        reconciliation_id,publication_id,execution_generation,descriptor_json,descriptor_sha256,state,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',0,?,?)`)
        .bind(crypto.randomUUID(), first.handle.publicationId, first.handle.generation,
          '{}', 'f'.repeat(64), forgedAt, forgedAt).run())
        .rejects.toThrow('ARCHIVE_ADDENDUM_RECONCILIATION_INVALID');
      await app.db.prepare(`UPDATE archive_publication_availability
        SET status='unavailable',reconciliation_id=NULL WHERE publication_id=?`)
        .bind(base.publicationId).run();
      await expect(readPublishedCorrectionAddendum(app.db, storage, secondId))
        .rejects.toThrow('PARENT_UNAVAILABLE');
      const backupId = await startBackup({
        CRM_DB: app.db,
        BACKUP_BUCKET: storage.bucket,
        BACKUP_KEY: storage.masterKey,
        BACKUP_PROVIDER: 'r2',
        CF_ACCOUNT_ID: 'isolated-account',
        CF_DATABASE_ID: 'isolated-database',
        CF_EXPORT_API_TOKEN: 'isolated-no-network-token',
      } as unknown as Env);
      const pinned = JSON.parse(String(await app.db.prepare('SELECT archives_json FROM backup_jobs WHERE id=?')
        .bind(backupId).first('archives_json'))) as ArchiveReference[];
      expect(pinned).toContainEqual(first.result.reference);
      expect(pinned).toContainEqual(second.result.reference);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('allows one winner when two publishers race and leaves no duplicate authority', async () => {
    const { app, storage } = await restored();
    try {
      const correctionId = await addCorrection(app, 1);
      const [left, right] = await Promise.all([
        startCorrectionAddendumPublication(app.db, correctionId, crypto.randomUUID()),
        startCorrectionAddendumPublication(app.db, correctionId, crypto.randomUUID()),
      ]);
      expect(left).toEqual(right);
      const results = await Promise.all([
        publishCorrectionAddendum(app.db, storage, left),
        publishCorrectionAddendum(app.db, storage, right),
      ]);
      expect(results.filter(result => !result.replay)).toHaveLength(1);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_publications WHERE correction_id=?')
        .bind(correctionId).first('n')).toBe(1);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_availability').first('n')).toBe(1);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('does not publish an interrupted upload or remove retained D1 authority', async () => {
    const { app, storage } = await restored();
    try {
      const correctionId = await addCorrection(app, 1);
      const handle = await startCorrectionAddendumPublication(app.db, correctionId);
      let puts = 0;
      const interrupted: AddendumStorage = {
        masterKey: storage.masterKey,
        bucket: {
          get: storage.bucket.get.bind(storage.bucket),
          async put(key, value) {
            puts += 1;
            if (puts === 2) throw new Error('simulated manifest upload interruption');
            return storage.bucket.put(key, value);
          },
        },
      };
      await expect(publishCorrectionAddendum(app.db, interrupted, handle)).rejects.toThrow('interruption');
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_publications').first('n')).toBe(0);
      expect(await app.db.prepare('SELECT state FROM archive_correction_addendum_builds WHERE publication_id=?')
        .bind(handle.publicationId).first('state')).toBe('pending');
      expect(await app.db.prepare('SELECT count(*) n FROM history_correction_outbox WHERE id=?')
        .bind(correctionId).first('n')).toBe(1);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('invalidates availability after restoration and restores it only after parent and addendum readback', async () => {
    const { app, storage } = await restored();
    try {
      const correctionId = await addCorrection(app, 1);
      const published = await publishOne(app, storage, correctionId);
      await rotateGeneration(app);
      expect(await app.db.prepare('SELECT status FROM archive_correction_addendum_availability WHERE publication_id=?')
        .bind(published.handle.publicationId).first('status')).toBe('unavailable');
      await expect(startCorrectionAddendumReconciliation(app.db, published.handle.publicationId))
        .rejects.toThrow('PARENT_UNAVAILABLE');

      await reconcileMonthly(app, storage);
      const handle = await startCorrectionAddendumReconciliation(app.db, published.handle.publicationId);
      await expect(readPublishedCorrectionAddendum(app.db, storage, correctionId)).rejects.toThrow('UNAVAILABLE');
      expect(await reconcileCorrectionAddendum(app.db, storage, handle)).toEqual({ state: 'complete', ready: true, replay: false });
      expect(await reconcileCorrectionAddendum(app.db, storage, handle)).toEqual({ state: 'complete', ready: true, replay: true });
      expect((await readPublishedCorrectionAddendum(app.db, storage, correctionId)).visit.row.version)
        .toBe(Number(base.visit.row.version) + 1);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_reconciliation_receipts')
        .first('n')).toBe(1);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('restarts an invalidated pre-publication build and publishes one bounded addendum from scheduled maintenance', async () => {
    const { app, storage } = await restored();
    try {
      const correctionId = await addCorrection(app, 1);
      const stale = await startCorrectionAddendumPublication(app.db, correctionId);
      await rotateGeneration(app);
      expect(await app.db.prepare('SELECT state FROM archive_correction_addendum_builds WHERE publication_id=?')
        .bind(stale.publicationId).first('state')).toBe('invalid');
      await reconcileMonthly(app, storage);
      const result = await maintainCorrectionAddenda({
        CRM_DB: app.db,
        BACKUP_BUCKET: storage.bucket,
        BACKUP_KEY: storage.masterKey,
      });
      expect(result.state).toBe('published');
      expect(result.id).not.toBe(stale.publicationId);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_publications WHERE correction_id=?')
        .bind(correctionId).first('n')).toBe(1);
      expect(await app.db.prepare("SELECT count(*) n FROM archive_correction_addendum_builds WHERE correction_id=? AND state='invalid'")
        .bind(correctionId).first('n')).toBe(1);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('rejects an in-flight generation change before a reconciliation receipt can become authority', async () => {
    const { app, storage } = await restored();
    try {
      const correctionId = await addCorrection(app, 1);
      const published = await publishOne(app, storage, correctionId);
      await rotateGeneration(app);
      await reconcileMonthly(app, storage);
      const handle = await startCorrectionAddendumReconciliation(app.db, published.handle.publicationId);
      let switched = false;
      const changing: AddendumStorage = {
        masterKey: storage.masterKey,
        bucket: {
          put: storage.bucket.put.bind(storage.bucket),
          async get(key) {
            const object = await storage.bucket.get(key);
            if (!switched) {
              switched = true;
              await rotateGeneration(app);
            }
            return object;
          },
        },
      };
      await expect(reconcileCorrectionAddendum(app.db, changing, handle)).rejects.toThrow();
      expect(switched).toBe(true);
      expect(await app.db.prepare('SELECT state FROM archive_correction_addendum_reconciliation_jobs WHERE reconciliation_id=?')
        .bind(handle.reconciliationId).first('state')).toBe('invalid');
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_reconciliation_receipts WHERE reconciliation_id=?')
        .bind(handle.reconciliationId).first('n')).toBe(0);
      expect(await app.db.prepare('SELECT status FROM archive_correction_addendum_availability WHERE publication_id=?')
        .bind(published.handle.publicationId).first('status')).toBe('unavailable');
    } finally {
      await app.close();
    }
  }, 120_000);

  it.each(['missing', 'corrupt'] as const)('fails closed when the addendum part is %s during reconciliation', async failure => {
    const { app, storage } = await restored();
    try {
      const correctionId = await addCorrection(app, 1);
      const published = await publishOne(app, storage, correctionId);
      const part = await app.db.prepare('SELECT part_descriptor_json FROM archive_correction_addendum_publications WHERE publication_id=?')
        .bind(published.handle.publicationId).first<string>('part_descriptor_json');
      const objectKey = JSON.parse(String(part)).objectKey as string;
      await rotateGeneration(app);
      await reconcileMonthly(app, storage);
      const handle = await startCorrectionAddendumReconciliation(app.db, published.handle.publicationId);
      const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
      if (failure === 'missing') await bucket.delete(objectKey);
      else {
        const object = await bucket.get(objectKey);
        if (!object) throw new Error('Fixture part missing');
        const bytes = new Uint8Array(await object.arrayBuffer());
        bytes[bytes.length - 1] ^= 1;
        await bucket.put(objectKey, bytes);
      }
      await expect(reconcileCorrectionAddendum(app.db, storage, handle)).rejects.toThrow();
      expect(await app.db.prepare('SELECT state FROM archive_correction_addendum_reconciliation_jobs WHERE reconciliation_id=?')
        .bind(handle.reconciliationId).first('state')).toBe('invalid');
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_reconciliation_receipts').first('n')).toBe(0);
      expect(await app.db.prepare('SELECT status FROM archive_correction_addendum_availability WHERE publication_id=?')
        .bind(published.handle.publicationId).first('status')).toBe('unavailable');
    } finally {
      await app.close();
    }
  }, 120_000);
});
