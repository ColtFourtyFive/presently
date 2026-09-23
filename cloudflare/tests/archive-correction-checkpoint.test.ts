import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ArchiveRecord, ArchiveReference } from '../shared/archive-format';
import {
  maintainCorrectionAddenda,
  publishCorrectionAddendum,
  readPublishedCorrectionAddendum,
  reconcileCorrectionAddendum,
  startCorrectionAddendumPublication,
  startCorrectionAddendumReconciliation,
  type AddendumDatabase,
  type AddendumStatement,
  type AddendumStorage,
} from '../worker/archive-correction-addendum';
import {
  nextCheckpointCandidate,
  publishCorrectionCheckpoint,
  readPublishedCorrectionCheckpoint,
  reconcileCorrectionCheckpoint,
  startCorrectionCheckpoint,
  startCorrectionCheckpointReconciliation,
} from '../worker/archive-correction-checkpoint';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { advancePublicationReconciliation, startPublicationReconciliation } from '../worker/archive-publication-reconciliation';
import { BACKUP_TABLES, startBackup } from '../worker/backup';
import type { Env } from '../worker/types';
import {
  createPublicationFixture,
  createPublicationSeed,
  refreshPublicationProof,
  restorePublicationDatabase,
  snapshotPublicationDatabase,
} from './archive-publication-fixture';
import { createRuntime, projectRoot, type TestRuntime } from './runtime';

type Base = {
  sql: string;
  key: string;
  objects: Map<string, Uint8Array>;
  reference: ArchiveReference;
  publicationId: string;
  visit: ArchiveRecord;
  actorName: string;
};

const checkpointTables = [
  'archive_correction_checkpoint_builds',
  'archive_correction_checkpoint_publications',
  'archive_correction_checkpoint_members',
  'archive_correction_checkpoint_availability',
  'archive_correction_checkpoint_reconciliation_jobs',
  'archive_correction_checkpoint_reconciliation_receipts',
] as const;

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
      sql: await snapshotPublicationDatabase(fixture.app, {
        omitTables: ['visits', 'attendance_events', 'attendance_corrections', 'reviews', 'audit_entries'],
      }),
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

async function addCorrection(app: TestRuntime, sequence: number): Promise<string> {
  const correctionId = crypto.randomUUID();
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
      correctionId, head.center_id, head.visit_id, head.student_id, head.version,
      head.check_in_at, head.check_out_at, checkInAt, checkOutAt,
      `Checkpoint correction ${sequence}`,
      base.visit.row.check_in_by, base.actorName, recordedAt, sequence.toString(16).padStart(64, '0'),
      head.original_check_in_at, head.original_check_out_at,
      base.visit.row.check_in_by, base.visit.row.check_out_by,
      base.visit.row.guardian_id, base.visit.row.departure_type,
      head.review_status, Number(head.version) + 1,
    ).run();
  return correctionId;
}

async function publishCorrection(app: TestRuntime, storage: AddendumStorage, correctionId: string) {
  const handle = await startCorrectionAddendumPublication(app.db, correctionId);
  const result = await publishCorrectionAddendum(app.db, storage, handle, 'checkpoint-test');
  return { handle, result };
}

async function publishCorrections(app: TestRuntime, storage: AddendumStorage, count: number, start = 1) {
  const values: Awaited<ReturnType<typeof publishCorrection>>[] = [];
  const ids: string[] = [];
  for (let sequence = start; sequence < start + count; sequence += 1) {
    const correctionId = await addCorrection(app, sequence);
    ids.push(correctionId);
    values.push(await publishCorrection(app, storage, correctionId));
  }
  return { ids, values };
}

async function publishCheckpoint(app: TestRuntime, storage: AddendumStorage) {
  const handle = await startCorrectionCheckpoint(app.db, base.visit.key);
  const result = await publishCorrectionCheckpoint(
    app.db,
    storage,
    handle,
    correctionId => readPublishedCorrectionAddendum(app.db, storage, correctionId),
    'checkpoint-test',
  );
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

async function checkpointPartKey(app: TestRuntime, publicationId: string): Promise<string> {
  const raw = await app.db.prepare(`SELECT part_descriptors_json
    FROM archive_correction_checkpoint_publications WHERE publication_id=?`)
    .bind(publicationId).first<string>('part_descriptors_json');
  const descriptors = JSON.parse(String(raw)) as { objectKey: string }[];
  if (!descriptors[0]?.objectKey) throw new Error('Checkpoint part descriptor missing');
  return descriptors[0].objectKey;
}

async function cloneObjects(source: TestRuntime, target: TestRuntime) {
  const from = await source.runtime.getR2Bucket('BACKUP_BUCKET');
  const to = await target.runtime.getR2Bucket('BACKUP_BUCKET');
  const listed = await from.list();
  for (const item of listed.objects) {
    const object = await from.get(item.key);
    if (!object) throw new Error(`Missing fixture object ${item.key}`);
    await to.put(item.key, await object.arrayBuffer());
  }
}

describe('schema 34 correction checkpoints', () => {
  it('installs atomically and extends the closed backup inventory', async () => {
    const app = await createRuntime({ migrate: false, bindings: {} });
    try {
      const names = (await readdir(join(projectRoot, 'migrations')))
        .filter(name => /^\d{4}.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 33)
        .sort();
      for (const name of names) {
        const statements = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
        await app.db.batch(statements.map(statement => app.db.prepare(statement)));
      }
      const migration = unstable_splitSqlQuery(
        await readFile(join(projectRoot, 'migrations/0034_correction_addendum_checkpoints.sql'), 'utf8'),
      );
      await expect(app.db.batch([
        ...migration.map(statement => app.db.prepare(statement)),
        app.db.prepare('INSERT INTO schema_versions(version) VALUES(33)'),
      ])).rejects.toThrow();
      expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(33);
      expect(await app.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'archive_correction_checkpoint_%'")
        .first('n')).toBe(0);
      await app.db.batch(migration.map(statement => app.db.prepare(statement)));
      expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(34);
      expect(await app.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'archive_correction_checkpoint_%'")
        .first('n')).toBe(6);
      expect(BACKUP_TABLES).toHaveLength(96);
      expect(new Set(BACKUP_TABLES).size).toBe(96);
      for (const table of checkpointTables) expect(BACKUP_TABLES).toContain(table);
      expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('resets the chain at 12, publishes the 17th correction, replays lost replies, and pins every object in backup', async () => {
    const { app, storage } = await restored();
    try {
      const first = await publishCorrections(app, storage, 12);
      expect(await nextCheckpointCandidate(app.db)).toBe(base.visit.key);
      const handle = await startCorrectionCheckpoint(app.db, base.visit.key);
      let loseReply = true;
      const db = new Proxy(app.db as unknown as AddendumDatabase<AddendumStatement<never>>, {
        get(target, property, receiver) {
          if (property !== 'batch') return Reflect.get(target, property, receiver);
          return async (statements: never[]) => {
            const result = await target.batch(statements);
            if (loseReply) {
              loseReply = false;
              throw new Error('simulated lost checkpoint commit reply');
            }
            return result;
          };
        },
      });
      const checkpoint = await publishCorrectionCheckpoint(
        db,
        storage,
        handle,
        correctionId => readPublishedCorrectionAddendum(app.db, storage, correctionId),
        'checkpoint-test',
      );
      expect(checkpoint.replay).toBe(true);
      expect(await publishCorrectionCheckpoint(
        app.db,
        storage,
        handle,
        correctionId => readPublishedCorrectionAddendum(app.db, storage, correctionId),
      )).toMatchObject({ replay: true });
      expect(await app.db.prepare('SELECT chain_depth,correction_count FROM archive_correction_checkpoint_publications WHERE publication_id=?')
        .bind(handle.publicationId).first()).toEqual({ chain_depth: 1, correction_count: 12 });
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_checkpoint_members WHERE publication_id=?')
        .bind(handle.publicationId).first('n')).toBe(12);

      const later = await publishCorrections(app, storage, 5, 13);
      const thirteenth = later.values[0];
      expect(await app.db.prepare(`SELECT parent_publication_id,chain_depth
        FROM archive_correction_addendum_publications WHERE publication_id=?`)
        .bind(thirteenth.handle.publicationId).first()).toEqual({ parent_publication_id: handle.publicationId, chain_depth: 2 });
      expect(await app.db.prepare('SELECT chain_depth FROM archive_correction_addendum_publications WHERE publication_id=?')
        .bind(later.values.at(-1)!.handle.publicationId).first('chain_depth')).toBe(6);
      const seventeenth = await readPublishedCorrectionAddendum(app.db, storage, later.ids.at(-1)!);
      expect(seventeenth.visit.row.version).toBe(Number(base.visit.row.version) + 17);
      expect(await app.db.prepare('SELECT count(*) n FROM history_correction_outbox WHERE visit_id=?')
        .bind(base.visit.key).first('n')).toBe(17);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_addendum_publications WHERE visit_id=?')
        .bind(base.visit.key).first('n')).toBe(17);

      const backupId = await startBackup({
        CRM_DB: app.db,
        BACKUP_BUCKET: storage.bucket,
        BACKUP_KEY: storage.masterKey,
        BACKUP_PROVIDER: 'r2',
        CF_ACCOUNT_ID: 'isolated-account',
        CF_DATABASE_ID: 'isolated-database',
        CF_EXPORT_API_TOKEN: 'isolated-no-network-token',
      } as unknown as Env);
      const job = await app.db.prepare('SELECT counts_json,archives_json,schema_json FROM backup_jobs WHERE id=?')
        .bind(backupId).first<{ counts_json: string; archives_json: string; schema_json: string }>();
      const counts = JSON.parse(job!.counts_json) as Record<string, number>;
      const references = JSON.parse(job!.archives_json) as ArchiveReference[];
      expect(Object.keys(counts)).toHaveLength(96);
      expect(counts.archive_correction_checkpoint_publications).toBe(1);
      expect(counts.archive_correction_checkpoint_members).toBe(12);
    expect(JSON.parse(job!.schema_json).at(-1)).toBe(42);
      expect(references).toContainEqual(checkpoint.reference);
      for (const published of [...first.values, ...later.values]) expect(references).toContainEqual(published.result.reference);
      for (const reference of references) expect(await storage.bucket.get(reference.manifestObjectKey)).not.toBeNull();
      await expect(app.db.prepare('DELETE FROM archive_correction_checkpoint_publications WHERE publication_id=?')
        .bind(handle.publicationId).run()).rejects.toThrow('IMMUTABLE_ARCHIVE_CHECKPOINT');
      await expect(app.db.prepare('DELETE FROM history_correction_outbox WHERE id=?')
        .bind(first.ids[0]).run()).rejects.toThrow('IMMUTABLE_ARCHIVED_CORRECTION');
      expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      await app.close();
    }
  }, 180_000);

  it('rejects missing, reordered, or substituted source evidence before checkpoint authority is committed', async () => {
    const { app, storage } = await restored();
    try {
      const corrections = await publishCorrections(app, storage, 12);
      const handle = await startCorrectionCheckpoint(app.db, base.visit.key);
      await expect(publishCorrectionCheckpoint(
        app.db,
        storage,
        handle,
        async correctionId => {
          if (correctionId === corrections.ids[0]) throw new Error('simulated missing source evidence');
          return readPublishedCorrectionAddendum(app.db, storage, correctionId);
        },
      )).rejects.toThrow('missing source evidence');
      await expect(publishCorrectionCheckpoint(
        app.db,
        storage,
        handle,
        correctionId => {
          const index = corrections.ids.indexOf(correctionId);
          return readPublishedCorrectionAddendum(app.db, storage, corrections.ids[(index + 1) % corrections.ids.length]);
        },
      )).rejects.toThrow('ARCHIVE_CHECKPOINT_SEMANTIC_INVALID');
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_checkpoint_publications').first('n')).toBe(0);
      const checkpoint = await publishCheckpoint(app, storage);
      expect(checkpoint.result.replay).toBe(false);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_checkpoint_publications').first('n')).toBe(1);
    } finally {
      await app.close();
    }
  }, 180_000);

  it.each(['base', 'head', 'generation'] as const)('commits no checkpoint authority across a %s race', async race => {
    const { app, storage } = await restored();
    try {
      await publishCorrections(app, storage, 12);
      const handle = await startCorrectionCheckpoint(app.db, base.visit.key);
      let changed = false;
      const racing: AddendumStorage = {
        masterKey: storage.masterKey,
        bucket: {
          async get(key) {
            const object = await storage.bucket.get(key);
            if (!changed && race === 'base') {
              changed = true;
              await app.db.prepare(`UPDATE archive_publication_availability
                SET status='unavailable',reconciliation_id=NULL WHERE publication_id=?`)
                .bind(base.publicationId).run();
            }
            return object;
          },
          async put(key, value) {
            if (!changed && race === 'head') {
              changed = true;
              await addCorrection(app, 13);
            } else if (!changed && race === 'generation') {
              changed = true;
              await rotateGeneration(app);
            }
            return storage.bucket.put(key, value);
          },
        },
      };
      await expect(publishCorrectionCheckpoint(
        app.db,
        racing,
        handle,
        correctionId => readPublishedCorrectionAddendum(app.db, racing, correctionId),
      )).rejects.toThrow();
      expect(changed).toBe(true);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_checkpoint_publications').first('n')).toBe(0);
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_checkpoint_availability').first('n')).toBe(0);
      expect(await app.db.prepare('SELECT count(*) n FROM history_correction_outbox WHERE visit_id=?')
        .bind(base.visit.key).first('n')).toBe(race === 'head' ? 13 : 12);
    } finally {
      await app.close();
    }
  }, 180_000);

  it.each(['missing', 'corrupt', 'reordered'] as const)('fails closed when checkpoint evidence is %s during recovery', async failure => {
    const source = await restored();
    let clone: TestRuntime | undefined;
    try {
      await publishCorrections(source.app, source.storage, 12);
      const checkpoint = await publishCheckpoint(source.app, source.storage);
      const sql = await snapshotPublicationDatabase(source.app, failure === 'reordered' ? {
        transformRow(table, row) {
          if (table !== 'archive_correction_checkpoint_publications') return row;
          const correctionIds = JSON.parse(String(row.correction_ids_json)) as string[];
          return { ...row, correction_ids_json: JSON.stringify(correctionIds.reverse()) };
        },
      } : {});
      clone = await restorePublicationDatabase(sql, { r2: true });
      await cloneObjects(source.app, clone);
      const bucket = await clone.runtime.getR2Bucket('BACKUP_BUCKET');
      const storage: AddendumStorage = { bucket, masterKey: base.key };
      await rotateGeneration(clone);
      await reconcileMonthly(clone, storage);
      const reconciliation = await startCorrectionCheckpointReconciliation(clone.db, checkpoint.handle.publicationId);
      const partKey = await checkpointPartKey(clone, checkpoint.handle.publicationId);
      if (failure === 'missing') await bucket.delete(partKey);
      else if (failure === 'corrupt') {
        const object = await bucket.get(partKey);
        if (!object) throw new Error('Checkpoint part missing');
        const bytes = new Uint8Array(await object.arrayBuffer());
        bytes[bytes.length - 1] ^= 1;
        await bucket.put(partKey, bytes);
      }
      await expect(reconcileCorrectionCheckpoint(clone.db, storage, reconciliation)).rejects.toThrow();
      expect(await clone.db.prepare('SELECT state FROM archive_correction_checkpoint_reconciliation_jobs WHERE reconciliation_id=?')
        .bind(reconciliation.reconciliationId).first('state')).toBe('invalid');
      expect(await clone.db.prepare('SELECT count(*) n FROM archive_correction_checkpoint_reconciliation_receipts')
        .first('n')).toBe(0);
      expect(await clone.db.prepare('SELECT status FROM archive_correction_checkpoint_availability WHERE publication_id=?')
        .bind(checkpoint.handle.publicationId).first('status')).toBe('unavailable');
    } finally {
      await clone?.close();
      await source.app.close();
    }
  }, 240_000);

  it('restores checkpoint and dependent addendum authority in parent-first order and round-trips every row', async () => {
    const source = await restored();
    let clone: TestRuntime | undefined;
    try {
      await publishCorrections(source.app, source.storage, 12);
      const checkpoint = await publishCheckpoint(source.app, source.storage);
      const thirteenthId = await addCorrection(source.app, 13);
      const thirteenth = await publishCorrection(source.app, source.storage, thirteenthId);
      const counts = Object.fromEntries(await Promise.all(checkpointTables.map(async table => [
        table,
        await source.app.db.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n'),
      ])));
      const sql = await snapshotPublicationDatabase(source.app);
      clone = await restorePublicationDatabase(sql, { r2: true });
      await cloneObjects(source.app, clone);
      const bucket = await clone.runtime.getR2Bucket('BACKUP_BUCKET');
      const storage: AddendumStorage = { bucket, masterKey: base.key };
      for (const table of checkpointTables) {
        expect(await clone.db.prepare(`SELECT count(*) n FROM ${table}`).first('n'), table).toBe(counts[table]);
      }
      expect((await clone.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      await rotateGeneration(clone);
      await reconcileMonthly(clone, storage);
      await expect(startCorrectionAddendumReconciliation(clone.db, thirteenth.handle.publicationId))
        .rejects.toThrow('PARENT_UNAVAILABLE');
      const checkpointReconciliation = await startCorrectionCheckpointReconciliation(clone.db, checkpoint.handle.publicationId);
      expect(await reconcileCorrectionCheckpoint(clone.db, storage, checkpointReconciliation))
        .toEqual({ state: 'complete', ready: true, replay: false });
      expect(await reconcileCorrectionCheckpoint(clone.db, storage, checkpointReconciliation))
        .toEqual({ state: 'complete', ready: true, replay: true });
      const addendumReconciliation = await startCorrectionAddendumReconciliation(clone.db, thirteenth.handle.publicationId);
      expect(await reconcileCorrectionAddendum(clone.db, storage, addendumReconciliation))
        .toEqual({ state: 'complete', ready: true, replay: false });
      expect((await readPublishedCorrectionCheckpoint(clone.db, storage, checkpoint.handle.publicationId)).visit.row.version)
        .toBe(Number(base.visit.row.version) + 12);
      expect((await readPublishedCorrectionAddendum(clone.db, storage, thirteenthId)).visit.row.version)
        .toBe(Number(base.visit.row.version) + 13);
      expect((await clone.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      await clone?.close();
      await source.app.close();
    }
  }, 240_000);

  it('gives checkpoint recovery and publication priority in bounded maintenance', async () => {
    const { app, storage } = await restored();
    try {
      await publishCorrections(app, storage, 12);
      expect(await maintainCorrectionAddenda({
        CRM_DB: app.db,
        BACKUP_BUCKET: storage.bucket,
        BACKUP_KEY: storage.masterKey,
      })).toMatchObject({ state: 'published' });
      expect(await app.db.prepare('SELECT count(*) n FROM archive_correction_checkpoint_publications').first('n')).toBe(1);
    } finally {
      await app.close();
    }
  }, 180_000);
});
