import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { describe, expect, it } from 'vitest';
import type { AdminSession } from '../shared/types';
import { createStudent, json, seedHistoricalVisit } from './helpers';
import { createRuntime, projectRoot, testAudience, testIssuer } from './runtime';

describe('schema 33 populated upgrade', () => {
  it('backfills legacy active and released holds and keeps all source rows', async () => {
    const app = await createRuntime({ migrate: false, bindings: {
      APP_ENV: 'local', CENTER_ID: 'test-center', APP_VERSION: 'schema-33-upgrade-test',
      ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience,
      BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
    } });
    try {
      const names = (await readdir(join(projectRoot, 'migrations')))
        .filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 32)
        .sort();
      for (const name of names) {
        const sql = await readFile(join(projectRoot, 'migrations', name), 'utf8');
        await app.db.batch(unstable_splitSqlQuery(sql).map(statement => app.db.prepare(statement)));
      }
      const token = await app.signer.token();
      const session = await json<AdminSession>(await app.request('/api/admin/session', { token }));
      const fixture = { ...app, token, actor: session.actor };
      const student = await createStudent(fixture);
      const visit = await seedHistoricalVisit(fixture, student, '2025-01-10T18:00:00.000Z', '2025-01-10T19:00:00.000Z');
      const activeId = crypto.randomUUID(), releasedId = crypto.randomUUID();
      const at = '2026-01-01T00:00:00.000Z';
      await app.db.batch([
        app.db.prepare(`INSERT INTO archive_holds(id,center_id,student_id,visit_id,reason,created_at,created_by)
          VALUES(?,?,?,?,?,?,?)`).bind(activeId, 'test-center', student.student.id, visit.visitId, 'Active legal review', at, session.actor.id),
        app.db.prepare(`INSERT INTO archive_holds(id,center_id,student_id,visit_id,reason,created_at,created_by,released_at,released_by,release_reason)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(releasedId, 'test-center', student.student.id, null, 'Completed family review', at, session.actor.id, '2026-02-01T00:00:00.000Z', session.actor.id, 'Review completed'),
      ]);
      const counts = await app.db.prepare(`SELECT
        (SELECT count(*) FROM visits) AS visits,
        (SELECT count(*) FROM attendance_events) AS events,
        (SELECT count(*) FROM audit_entries) AS audits`).first();
      const migration = await readFile(join(projectRoot, 'migrations/0033_history_retention_dry_run.sql'), 'utf8');
      await app.db.batch(unstable_splitSqlQuery(migration).map(statement => app.db.prepare(statement)));
      expect(await app.db.prepare('SELECT max(version) FROM schema_versions').first('max(version)')).toBe(33);
      expect(await app.db.prepare('SELECT target_kind,visit_id FROM history_holds WHERE hold_id=?').bind(activeId).first())
        .toEqual({ target_kind: 'visit', visit_id: visit.visitId });
      expect(await app.db.prepare('SELECT release_reason FROM history_hold_releases WHERE hold_id=?').bind(releasedId).first('release_reason'))
        .toBe('Review completed');
      expect(await app.db.prepare(`SELECT
        (SELECT count(*) FROM visits) AS visits,
        (SELECT count(*) FROM attendance_events) AS events,
        (SELECT count(*) FROM audit_entries) AS audits`).first()).toEqual(counts);
      expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      expect(await app.db.prepare('SELECT live_tier_days,evidence_retention_days,evidence_expiry_enabled FROM history_retention_policies WHERE center_id=?').bind('test-center').first())
        .toEqual({ live_tier_days: 90, evidence_retention_days: 730, evidence_expiry_enabled: 0 });
    } finally { await app.close(); }
  }, 120_000);
});
