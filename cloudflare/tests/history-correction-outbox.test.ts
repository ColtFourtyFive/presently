import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_TABLES } from '../worker/backup';
import { restorePublicationDatabase, snapshotPublicationDatabase } from './archive-publication-fixture';
import { createStudent, seedHistoricalVisit, startApp, type App } from './helpers';
import { createRuntime, projectRoot, type TestRuntime } from './runtime';

type VisitAuthority = {
  visit_id: string;
  center_id: string;
  student_id: string;
  original_check_in_at: string;
  original_check_out_at: string | null;
  check_in_at: string;
  check_out_at: string | null;
  version: number;
  review_status: 'none' | 'pending' | 'resolved';
  check_in_by: string;
  check_out_by: string | null;
  guardian_id: string | null;
  departure_type: string | null;
  actor_name: string;
};

const opened: TestRuntime[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(runtime => runtime.close()));
});

async function applyThrough(runtime: TestRuntime, maximum: number): Promise<void> {
  const names = (await readdir(join(projectRoot, 'migrations')))
    .filter(name => /^\d{4}.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= maximum)
    .sort();
  for (const name of names) {
    const statements = unstable_splitSqlQuery(
      await readFile(join(projectRoot, 'migrations', name), 'utf8'),
    );
    await runtime.db.batch(statements.map(sql => runtime.db.prepare(sql)));
  }
}

async function sourceFreeFixture(): Promise<{ app: TestRuntime; authority: VisitAuthority }> {
  const source = await startApp();
  const student = await createStudent(source);
  const visit = await seedHistoricalVisit(
    source,
    student,
    '2025-01-10T18:00:00.000Z',
    '2025-01-10T19:00:00.000Z',
  );
  const authority = await source.db.prepare(
    `SELECT h.*,v.check_in_by,v.check_out_by,v.guardian_id,v.departure_type,
            s.display_name AS actor_name
     FROM history_visit_heads h
     JOIN visits v ON v.id=h.visit_id
     JOIN staff s ON s.id=v.check_in_by
     WHERE h.visit_id=?`,
  ).bind(visit.visitId).first<VisitAuthority>();
  if (!authority) throw new Error('Source visit authority was not created');
  const sql = await snapshotPublicationDatabase(source, { omitTables: ['visits'] });
  await source.close();
  const app = await restorePublicationDatabase(sql);
  opened.push(app);
  expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE id=?')
    .bind(authority.visit_id).first('n')).toBe(0);
  return { app, authority };
}

function correctionStatement(
  app: TestRuntime,
  authority: VisitAuthority,
  correctionId: string,
  payloadHash: string,
) {
  const checkInAt = new Date(Date.parse(authority.check_in_at) + 1_000).toISOString();
  const checkOutAt = authority.check_out_at
    ? new Date(Date.parse(authority.check_out_at) + 1_000).toISOString()
    : null;
  return app.db.prepare(
    `INSERT INTO history_correction_outbox(
       id,center_id,visit_id,student_id,expected_version,
       prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,
       reason,actor_id,actor_name,recorded_at,payload_hash,
       original_check_in_at,original_check_out_at,check_in_by,check_out_by,
       guardian_id,departure_type,review_status,resulting_version
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    correctionId,
    authority.center_id,
    authority.visit_id,
    authority.student_id,
    authority.version,
    authority.check_in_at,
    authority.check_out_at,
    checkInAt,
    checkOutAt,
    'Verified against the signed attendance sheet.',
    authority.check_in_by,
    authority.actor_name,
    new Date().toISOString(),
    payloadHash,
    authority.original_check_in_at,
    authority.original_check_out_at,
    authority.check_in_by,
    authority.check_out_by,
    authority.guardian_id,
    authority.departure_type,
    authority.review_status,
    authority.version + 1,
  );
}

async function currentAuthority(
  app: TestRuntime,
  base: VisitAuthority,
): Promise<VisitAuthority> {
  const head = await app.db.prepare(
    'SELECT check_in_at,check_out_at,version,review_status FROM history_visit_heads WHERE visit_id=?',
  ).bind(base.visit_id).first<Pick<VisitAuthority, 'check_in_at' | 'check_out_at' | 'version' | 'review_status'>>();
  if (!head) throw new Error('Retained visit authority is missing');
  return { ...base, ...head };
}

async function counts(app: TestRuntime, correctionId: string) {
  const results = await app.db.batch<{ n: number }>([
    app.db.prepare('SELECT count(*) AS n FROM history_correction_outbox WHERE id=?').bind(correctionId),
    app.db.prepare('SELECT count(*) AS n FROM history_correction_heads WHERE correction_id=?').bind(correctionId),
    app.db.prepare('SELECT count(*) AS n FROM history_request_keys WHERE request_id=?').bind(correctionId),
  ]);
  return results.map(result => result.results[0]?.n ?? 0);
}

describe('schema 31 archived correction outbox', () => {
  it('rolls back a failed native migration batch and then applies schema 31 cleanly', async () => {
    const app = await createRuntime({ migrate: false, bindings: {} });
    opened.push(app);
    await applyThrough(app, 30);
    const sql = unstable_splitSqlQuery(
      await readFile(join(projectRoot, 'migrations/0031_archived_correction_outbox.sql'), 'utf8'),
    );

    await expect(app.db.batch([
      ...sql.map(statement => app.db.prepare(statement)),
      app.db.prepare('INSERT INTO schema_versions(version) VALUES(30)'),
    ])).rejects.toThrow();
    expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(30);
    expect(await app.db.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('history_correction_outbox','attendance_correction_records')",
    ).first('n')).toBe(0);

    await app.db.batch(sql.map(statement => app.db.prepare(statement)));
    expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(31);
    expect(await app.db.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('history_correction_outbox','attendance_correction_records')",
    ).first('n')).toBe(2);
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('rolls back the row, head, correction head, and request key after a late trigger failure', async () => {
    const { app, authority } = await sourceFreeFixture();
    const correctionId = crypto.randomUUID();
    const original = await currentAuthority(app, authority);
    await app.db.prepare(
      `CREATE TRIGGER test_outbox_late_failure
       BEFORE INSERT ON history_request_keys
       WHEN NEW.request_id='${correctionId}'
       BEGIN SELECT RAISE(ABORT,'TEST_LATE_FAILURE'); END`,
    ).run();

    await expect(correctionStatement(app, original, correctionId, 'a'.repeat(64)).run())
      .rejects.toThrow('TEST_LATE_FAILURE');
    expect(await counts(app, correctionId)).toEqual([0, 0, 0]);
    expect(await currentAuthority(app, authority)).toMatchObject({
      check_in_at: original.check_in_at,
      check_out_at: original.check_out_at,
      version: original.version,
    });
  });

  it('allows exactly one of two native corrections at the same expected version', async () => {
    const { app, authority } = await sourceFreeFixture();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const attempted = await Promise.allSettled(ids.map((correctionId, index) =>
      correctionStatement(app, authority, correctionId, String(index + 1).repeat(64)).run()));
    expect(attempted.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempted.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(String((attempted.find(result => result.status === 'rejected') as PromiseRejectedResult).reason))
      .toContain('STALE_VISIT');

    const rows = (await app.db.prepare(
      'SELECT id FROM history_correction_outbox WHERE id IN (?,?)',
    ).bind(...ids).all<{ id: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(await counts(app, rows[0].id)).toEqual([1, 1, 1]);
    expect(await app.db.prepare('SELECT version FROM history_visit_heads WHERE visit_id=?')
      .bind(authority.visit_id).first('version')).toBe(authority.version + 1);
  });

  it('rejects backup-window writes and direct forged or mutable rows without side effects', async () => {
    const { app, authority } = await sourceFreeFixture();
    const lockedId = crypto.randomUUID();
    await app.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    await expect(correctionStatement(app, authority, lockedId, 'b'.repeat(64)).run())
      .rejects.toThrow('backup_maintenance');
    expect(await counts(app, lockedId)).toEqual([0, 0, 0]);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();

    const forgedId = crypto.randomUUID();
    const forged = { ...authority, visit_id: crypto.randomUUID() };
    await expect(correctionStatement(app, forged, forgedId, 'c'.repeat(64)).run())
      .rejects.toThrow('STALE_VISIT');
    expect(await counts(app, forgedId)).toEqual([0, 0, 0]);

    const acceptedId = crypto.randomUUID();
    await correctionStatement(app, authority, acceptedId, 'd'.repeat(64)).run();
    await expect(app.db.prepare(
      'UPDATE history_correction_outbox SET reason=? WHERE id=?',
    ).bind('Forged replacement', acceptedId).run()).rejects.toThrow('IMMUTABLE_ARCHIVED_CORRECTION');
    await expect(app.db.prepare(
      'DELETE FROM history_correction_outbox WHERE id=?',
    ).bind(acceptedId).run()).rejects.toThrow('IMMUTABLE_ARCHIVED_CORRECTION');
    expect(await counts(app, acceptedId)).toEqual([1, 1, 1]);
  });

  it('restores pending authority and accepts the next correction from the restored state', async () => {
    const { app, authority } = await sourceFreeFixture();
    const firstId = crypto.randomUUID();
    await correctionStatement(app, authority, firstId, 'e'.repeat(64)).run();
    const snapshot = await snapshotPublicationDatabase(app);
    const restored = await restorePublicationDatabase(snapshot);
    opened.push(restored);

    expect(await counts(restored, firstId)).toEqual([1, 1, 1]);
    expect(await restored.db.prepare('SELECT count(*) AS n FROM audit_timeline WHERE id=?')
      .bind(firstId).first('n')).toBe(1);
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

    const latest = await currentAuthority(restored, authority);
    const secondId = crypto.randomUUID();
    await correctionStatement(restored, latest, secondId, 'f'.repeat(64)).run();
    expect(await counts(restored, secondId)).toEqual([1, 1, 1]);
    expect(await restored.db.prepare('SELECT version FROM history_visit_heads WHERE visit_id=?')
      .bind(authority.visit_id).first('version')).toBe(authority.version + 2);
    expect(BACKUP_TABLES).toHaveLength(96);
    expect(BACKUP_TABLES).toContain('history_correction_outbox');
  });
});
