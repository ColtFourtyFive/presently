import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import type { AdminSession, AttendanceResult } from '../shared/types';
import { createStudent, json, observation, startApp, type App } from './helpers';
import { createRuntime, projectRoot, testAudience, testIssuer, type TestRuntime } from './runtime';

const opened: TestRuntime[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function correction(app: App) {
  const detail = await createStudent(app);
  const arrived = observation(detail.student.id, 'check_in', {
    observedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  });
  const accepted = await json<AttendanceResult>(
    await app.request('/api/admin/attendance', { token: app.token, body: arrived }),
    201,
  );
  const correctionId = crypto.randomUUID();
  const recorded = await json<{ correction: { id: string; recordedAt: string } }>(
    await app.request(`/api/admin/visits/${accepted.visit!.id}/corrections`, {
      token: app.token,
      body: {
        correctionId,
        expectedVersion: accepted.visit!.version,
        checkInAt: new Date(Date.parse(arrived.observedAt) + 60_000).toISOString(),
        checkOutAt: null,
        reason: 'Corrected from the contemporaneous paper register.',
      },
    }),
    201,
  );
  return { detail, visitId: accepted.visit!.id, correction: recorded.correction };
}

async function through29(): Promise<App> {
  const runtime = await createRuntime({
    migrate: false,
    bindings: {
      APP_ENV: 'production',
      CENTER_ID: 'test-center',
      APP_VERSION: 'history-correction-head-test',
      ACCESS_ISSUER: testIssuer,
      ACCESS_AUD: testAudience,
      BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
    },
  });
  opened.push(runtime);
  const names = (await readdir(join(projectRoot, 'migrations')))
    .filter(name => name.endsWith('.sql') && name < '0030')
    .sort();
  for (const name of names) {
    const statements = unstable_splitSqlQuery(
      await readFile(join(projectRoot, 'migrations', name), 'utf8'),
    );
    await runtime.db.batch(statements.map(sql => runtime.db.prepare(sql)));
  }
  const token = await runtime.signer.token();
  const session = await json<AdminSession>(await runtime.request('/api/admin/session', { token }));
  return { ...runtime, token, actor: session.actor };
}

async function row(app: App, correctionId: string) {
  return app.db.prepare(
    `SELECT correction_id,center_id,visit_id,student_id,recorded_at,residency
     FROM history_correction_heads WHERE correction_id=?`,
  ).bind(correctionId).first();
}

describe('immutable correction history heads', () => {
  it('captures new corrections and rejects mutation or deletion', async () => {
    const app = await startApp();
    opened.push(app);
    const item = await correction(app);
    expect(await row(app, item.correction.id)).toEqual({
      correction_id: item.correction.id,
      center_id: 'test-center',
      visit_id: item.visitId,
      student_id: item.detail.student.id,
      recorded_at: item.correction.recordedAt,
      residency: 'live',
    });
    await expect(app.db.prepare(
      'UPDATE history_correction_heads SET recorded_at=recorded_at WHERE correction_id=?',
    ).bind(item.correction.id).run()).rejects.toThrow('IMMUTABLE_HISTORY_CORRECTION_HEAD');
    await expect(app.db.prepare(
      'DELETE FROM history_correction_heads WHERE correction_id=?',
    ).bind(item.correction.id).run()).rejects.toThrow('IMMUTABLE_HISTORY_CORRECTION_HEAD');
  });

  it('backfills every retained schema-29 correction when migration 30 is applied', async () => {
    const app = await through29();
    const item = await correction(app);
    expect(await app.db.prepare('SELECT max(version) AS version FROM schema_versions').first('version'))
      .toBe(29);
    const sql = unstable_splitSqlQuery(
      await readFile(join(projectRoot, 'migrations', '0030_history_correction_heads.sql'), 'utf8'),
    );
    await app.db.batch(sql.map(statement => app.db.prepare(statement)));

    expect(await app.db.prepare('SELECT max(version) AS version FROM schema_versions').first('version'))
      .toBe(30);
    expect(await row(app, item.correction.id)).toEqual({
      correction_id: item.correction.id,
      center_id: 'test-center',
      visit_id: item.visitId,
      student_id: item.detail.student.id,
      recorded_at: item.correction.recordedAt,
      residency: 'live',
    });
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
