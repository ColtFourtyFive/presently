import { beforeAll, describe, expect, it } from 'vitest';
import { createPublicationFixture, createPublicationSeed, type PublicationSeed, snapshotPublicationDatabase, restorePublicationDatabase } from './archive-publication-fixture';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import type { ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';

let seed: PublicationSeed;
beforeAll(async () => { seed = await createPublicationSeed(); }, 120_000);

describe('private permanent monthly publication', () => {
  it('publishes exact immutable locators, survives replay, and keeps all live source rows', async () => {
    const fixture = await createPublicationFixture(seed);
    try {
      const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
      const storage = { bucket: fixture.bucket, masterKey: fixture.key };
      let revision = 0, steps = 0, total = 0;
      for (;;) {
        const outcome = await advanceMonthlyPublication(fixture.app.db, storage, handle, { expectedRevision: revision });
        expect(outcome.busy).toBe(false);
        expect(outcome.processed).toBeLessThanOrEqual(8);
        total += outcome.processed;
        revision = outcome.revision;
        if (outcome.state === 'published') break;
        expect(++steps).toBeLessThan(100);
        expect((await fixture.app.db.prepare('SELECT count(*) AS n FROM archive_publications').first<{ n: number }>())!.n).toBe(0);
      }
      expect(total).toBe(fixture.records.length);
      const published = await fixture.app.db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(handle.publicationId).first();
      expect(published).toMatchObject({ record_count: fixture.records.length, manifest_sha256: fixture.reference.manifestSha256 });
      expect(await fixture.app.db.prepare('SELECT status FROM archive_publication_availability WHERE publication_id=?').bind(handle.publicationId).first()).toEqual({ status: 'ready' });
      expect((await fixture.app.db.prepare('SELECT count(*) AS n FROM archive_publication_records').first<{ n: number }>())!.n).toBe(fixture.records.length);
      expect((await fixture.app.db.prepare('SELECT count(*) AS n FROM attendance_events').first<{ n: number }>())!.n).toBeGreaterThan(0);
      expect(await advanceMonthlyPublication(fixture.app.db, storage, handle, { expectedRevision: revision - 2 })).toMatchObject({ state: 'published', revision, processed: 0, busy: false });
      expect(await startMonthlyPublication(fixture.app.db, fixture.handle, handle.publicationId)).toEqual(handle);
    } finally { await fixture.app.close(); }
  }, 120_000);
  it('does no object work for a stale revision and resumes after a transient object failure', async () => {
    const fixture = await createPublicationFixture(seed);
    try {
      const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
      let gets = 0;
      const failing: ArchiveRecordEvidenceStorage = { masterKey: fixture.key, bucket: { async get() { gets++; return null; } } };
      expect(await advanceMonthlyPublication(fixture.app.db, failing, handle, { expectedRevision: 99 })).toMatchObject({ revision: 0, busy: true });
      expect(gets).toBe(0);
      await expect(advanceMonthlyPublication(fixture.app.db, failing, handle, { expectedRevision: 0 })).rejects.toThrow('OBJECT_UNAVAILABLE');
      const build = await fixture.app.db.prepare('SELECT revision,indexed_count,lease_token FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first<{ revision: number; indexed_count: number; lease_token: string | null }>();
      expect(build).toEqual({ revision: 2, indexed_count: 0, lease_token: null });
      expect((await advanceMonthlyPublication(fixture.app.db, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: build!.revision })).processed).toBeGreaterThan(0);
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('rejects a generation change during object authentication before writing any candidate record', async () => {
    const fixture = await createPublicationFixture(seed);
    try {
      const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
      let switched = false;
      const storage: ArchiveRecordEvidenceStorage = { masterKey: fixture.key, bucket: { async get(key) {
        const object = await fixture.bucket.get(key);
        if (!switched) { switched = true; await fixture.app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run(); }
        return object;
      } } };
      await expect(advanceMonthlyPublication(fixture.app.db, storage, handle, { expectedRevision: 0 })).rejects.toThrow();
      expect(await fixture.app.db.prepare('SELECT state,indexed_count FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first()).toEqual({ state: 'invalid', indexed_count: 0 });
      expect((await fixture.app.db.prepare('SELECT count(*) AS n FROM archive_publication_records').first<{ n: number }>())!.n).toBe(0);
      expect((await fixture.app.db.prepare('SELECT count(*) AS n FROM archive_publications').first<{ n: number }>())!.n).toBe(0);
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('reconciles immutable source evidence again inside the candidate write transaction', async () => {
    const fixture = await createPublicationFixture(seed);
    let altered: Awaited<ReturnType<typeof restorePublicationDatabase>> | undefined;
    try {
      const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
      const sql = await snapshotPublicationDatabase(fixture.app, { transformRow(table, row) { return table === 'attendance_events' ? { ...row, insertion_nonce: 'changed-after-verification' } : row; } });
      altered = await restorePublicationDatabase(sql);
      let revision = 0, rejected = false;
      for (let step = 0; step < 100; step++) {
        try {
          const outcome = await advanceMonthlyPublication(altered.db, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: revision });
          revision = outcome.revision;
          expect(outcome.state).not.toBe('published');
        } catch { rejected = true; break; }
      }
      expect(rejected).toBe(true);
      expect((await altered.db.prepare('SELECT count(*) AS n FROM archive_publications').first<{ n: number }>())!.n).toBe(0);
      expect((await altered.db.prepare("SELECT count(*) AS n FROM archive_publication_records WHERE table_name='attendance_events'").first<{ n: number }>())!.n).toBe(0);
    } finally { await altered?.close(); await fixture.app.close(); }
  }, 120_000);

  it('retains captured profile names after a legitimate live rename', async () => {
    const fixture = await createPublicationFixture(seed);
    try {
      await fixture.app.db.prepare("UPDATE students SET first_name='Renamed' WHERE center_id='test-center'").run();
      const handle = await startMonthlyPublication(fixture.app.db, fixture.handle);
      let revision = 0, published = false;
      for (let step = 0; step < 100; step++) {
        const outcome = await advanceMonthlyPublication(fixture.app.db, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: revision });
        revision = outcome.revision;
        if (outcome.state === 'published') { published = true; break; }
      }
      expect(published).toBe(true);
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('rolls back candidate writes when the final native checkpoint guard no longer matches', async () => {
    const fixture = await createPublicationFixture(seed);
    try {
      const db = fixture.app.db;
      const handle = await startMonthlyPublication(db, fixture.handle);
      const fenced: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = {
        prepare(sql) { return db.prepare(sql.includes('SET next_part=') ? sql.replace('WHERE b.publication_id=?', 'WHERE 0 AND b.publication_id=?') : sql); },
        batch: db.batch.bind(db),
      };
      await expect(advanceMonthlyPublication(fenced, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: 0 })).rejects.toThrow();
      expect(await db.prepare('SELECT indexed_count,lease_token FROM archive_publication_builds WHERE publication_id=?').bind(handle.publicationId).first()).toEqual({ indexed_count: 0, lease_token: null });
      expect((await db.prepare('SELECT count(*) AS n FROM archive_publication_records').first<{ n: number }>())!.n).toBe(0);
      expect((await db.prepare('SELECT count(*) AS n FROM archive_publication_parts').first<{ n: number }>())!.n).toBe(0);
    } finally { await fixture.app.close(); }
  }, 120_000);

  it('reports the committed revision after a lost reply without repeating candidate writes', async () => {
    const fixture = await createPublicationFixture(seed);
    try {
      const db = fixture.app.db, handle = await startMonthlyPublication(db, fixture.handle);
      let drop = true;
      const dropped: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = {
        prepare: db.prepare.bind(db),
        async batch<T>(statements: ReturnType<typeof db.prepare>[]) { const rows = await db.batch<T>(statements); if (drop && statements.length > 3) { drop = false; throw new Error('simulated lost reply'); } return rows; },
      };
      const storage = { bucket: fixture.bucket, masterKey: fixture.key };
      await expect(advanceMonthlyPublication(dropped, storage, handle, { expectedRevision: 0 })).rejects.toThrow('lost reply');
      const before = await db.prepare('SELECT count(*) AS n FROM archive_publication_records').first<{ n: number }>();
      expect(before!.n).toBeGreaterThan(0);
      expect(await advanceMonthlyPublication(db, storage, handle, { expectedRevision: 0 })).toMatchObject({ state: 'building', revision: 2, processed: 0, busy: true });
      expect(await db.prepare('SELECT count(*) AS n FROM archive_publication_records').first()).toEqual(before);
    } finally { await fixture.app.close(); }
  }, 120_000);
});
