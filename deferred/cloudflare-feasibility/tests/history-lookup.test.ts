import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import type { AdminSession, AttendanceResult } from '../shared/types.js';
import { BACKUP_TABLES } from '../worker/backup.js';
import { decodeAttendanceReceipt } from '../worker/attendance-receipt.js';
import { advanceHistoryBackfill, readHistoryLookupStatus } from '../worker/history-lookup.js';
import { createStudent, json, observation, startApp, type App } from './helpers.js';
import { createRuntime, projectRoot, testAudience, testIssuer } from './runtime.js';

const migrationPrefix = '0017';
const registryTables = ['history_request_keys', 'history_visit_heads', 'history_record_locations', 'history_runtime', 'history_backfill_jobs'];
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function currentApp() { const app = await startApp(); apps.push(app); return app; }
async function legacyApp(): Promise<App> {
  const runtime = await createRuntime({ migrate: false, bindings: {
    APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'history-lookup-test',
    ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
  } });
  try {
    const names = (await readdir(join(projectRoot, 'migrations'))).filter(name => name.endsWith('.sql') && name < migrationPrefix).sort();
    for (const name of names) await runtime.db.batch(unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8')).map(sql => runtime.db.prepare(sql)));
    const token = await runtime.signer.token();
    const session = await json<AdminSession>(await runtime.request('/api/admin/session', { token }));
    const app = { ...runtime, token, actor: session.actor };
    apps.push(app);
    return app;
  } catch (error) { await runtime.close(); throw error; }
}
async function migrate(app: App) {
  const names = (await readdir(join(projectRoot, 'migrations'))).filter(name => name.startsWith(migrationPrefix) && name.endsWith('.sql'));
  expect(names).toHaveLength(1);
  await app.db.batch(unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', names[0]), 'utf8')).map(sql => app.db.prepare(sql)));
}
// The adapter sends every statement to an actual workerd D1 binding; it does
// not implement unrelated platform methods such as sessions or dump().
const database = (app: App) => app.db as unknown as Parameters<typeof advanceHistoryBackfill>[0];
const advance = (app: App, pageSize = 2) => advanceHistoryBackfill(database(app), pageSize);
const status = (app: App) => readHistoryLookupStatus(database(app));
async function finish(app: App, pageSize = 2) {
  for (let step = 0; step < 200; step++) {
    const result = await advance(app, pageSize);
    if (result.state === 'ready') return result;
  }
  throw new Error('History lookup backfill did not finish within its fixture bound.');
}
async function rows(app: App, table: string) { return (await app.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results; }
async function sources(app: App) {
  const [attendance_events, attendance_corrections, audit_entries, visits] = await Promise.all(
    ['attendance_events', 'attendance_corrections', 'audit_entries', 'visits'].map(table => rows(app, table)),
  );
  return { attendance_events, attendance_corrections, audit_entries, visits };
}
async function assertHead(app: App, visitId: string) {
  const columns = 'center_id,student_id,original_check_in_at,original_check_out_at,check_in_at,check_out_at,version,review_status';
  const live = await app.db.prepare(`SELECT id,${columns} FROM visits WHERE id=?`).bind(visitId).first();
  const head = await app.db.prepare(`SELECT visit_id AS id,${columns},residency FROM history_visit_heads WHERE visit_id=?`).bind(visitId).first();
  expect(head).toEqual({ ...live, residency: 'live' });
}
async function lifecycle(app: App) {
  const detail = await createStudent(app);
  const arrivalBody = observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
  const arrival = await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: arrivalBody }), 201);
  const correctionBody = {
    correctionId: crypto.randomUUID(), expectedVersion: arrival.visit!.version,
    checkInAt: new Date(Date.parse(arrivalBody.observedAt) + 60_000).toISOString(), checkOutAt: null,
    reason: 'Arrival corrected from a contemporaneous staff observation.',
  };
  await json(await app.request(`/api/admin/visits/${arrival.visit!.id}/corrections`, { token: app.token, body: correctionBody }), 201);
  const departureBody = observation(detail.student.id, 'exceptional_departure', {
    observedAt: new Date(Date.now() - 10 * 60_000).toISOString(), reason: 'Observed departure requires documented manager review.',
  });
  const departure = await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: departureBody }), 201);
  return { detail, arrivalBody, arrival, correctionBody, departureBody, departure, visitId: arrival.visit!.id };
}
async function legacyLifecycle(app: App) {
  expect(await app.db.prepare('SELECT max(version) AS version FROM schema_versions').first('version')).toBe(16);
  const detail = await createStudent(app);
  const arrivalBody = observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
  const visitId = `visit-${arrivalBody.eventId}`;
  // Seed the real schema16 sources through their original D1 triggers. The
  // current attendance router correctly requires the schema17 lookup tables.
  const seedEvent = async (input: ReturnType<typeof observation>, reason: string | null = null): Promise<AttendanceResult> => {
    const receivedAt = new Date().toISOString();
    const hash = createHash('sha256').update(JSON.stringify({ studentId: input.studentId, action: input.action,
      observedAt: input.observedAt, guardianId: null, reason })).digest('base64');
    await app.db.prepare(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,reason,payload_hash,insertion_nonce)
      VALUES(?,'test-center',?,?,?,?,?,?,?,'admin',NULL,?,?,?)`)
      .bind(input.eventId, input.studentId, visitId, input.action, input.observedAt, receivedAt, app.actor.id, app.actor.displayName,
        reason, hash, crypto.randomUUID()).run();
    const sealed = await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(input.eventId).first('result_visit');
    return { event: { id: input.eventId, studentId: input.studentId, visitId, action: input.action, observedAt: input.observedAt,
      receivedAt, actorId: app.actor.id, actorName: app.actor.displayName, channel: 'admin', guardianId: null, reason },
    visit: decodeAttendanceReceipt({ visit_id: visitId, student_id: input.studentId, action: input.action, observed_at: input.observedAt, result_visit: sealed }), replayed: false };
  };
  const arrival = await seedEvent(arrivalBody);
  const correctionBody = { correctionId: crypto.randomUUID(), expectedVersion: arrival.visit!.version,
    checkInAt: new Date(Date.parse(arrivalBody.observedAt) + 60_000).toISOString(), checkOutAt: null,
    reason: 'Arrival corrected from a contemporaneous staff observation.' };
  const correctionHash = createHash('sha256').update(JSON.stringify({ visitId, expectedVersion: correctionBody.expectedVersion,
    checkInAt: correctionBody.checkInAt, checkOutAt: correctionBody.checkOutAt, reason: correctionBody.reason })).digest('base64');
  await app.db.prepare(`INSERT INTO attendance_corrections(id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash)
    SELECT ?,'test-center',id,?,check_in_at,check_out_at,?,?,?,?,?,?,? FROM visits WHERE id=?`)
    .bind(correctionBody.correctionId, correctionBody.expectedVersion, correctionBody.checkInAt, correctionBody.checkOutAt,
      correctionBody.reason, app.actor.id, app.actor.displayName, new Date().toISOString(), correctionHash, visitId).run();
  const departureReason = 'Observed departure requires documented manager review.';
  const departureBody = observation(detail.student.id, 'exceptional_departure', { observedAt: new Date(Date.now() - 10 * 60_000).toISOString(), reason: departureReason });
  const departure = await seedEvent(departureBody, departureReason);
  return { detail, arrivalBody, arrival, correctionBody, departureBody, departure, visitId };
}
async function insertAudit(app: App, id = crypto.randomUUID()) {
  await app.db.prepare("INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,'test-center',?,?,'history_test','center','test-center','{}',?)")
    .bind(id, app.actor.id, app.actor.displayName, new Date().toISOString()).run();
  return id;
}

describe('durable history lookup registration in actual workerd/D1', () => {
  it('captures exact request ownership and hashes while attendance receipts are sealed', async () => {
    const app = await currentApp();
    const fixture = await lifecycle(app);
    for (const [table, kind, ids] of [
      ['attendance_events', 'event', [fixture.arrivalBody.eventId, fixture.departureBody.eventId]],
      ['attendance_corrections', 'correction', [fixture.correctionBody.correctionId]],
    ] as const) {
      for (const id of ids) {
        const source = await app.db.prepare(`SELECT center_id,payload_hash FROM ${table} WHERE id=?`).bind(id).first();
        expect(await app.db.prepare('SELECT request_id,center_id,source_kind,payload_hash,hash_encoding,canonicalization FROM history_request_keys WHERE request_id=?').bind(id).first())
          .toEqual({ request_id: id, ...source, source_kind: kind, hash_encoding: 'base64-sha256', canonicalization: 'legacy-unverified' });
      }
    }
    const auditId = await insertAudit(app);
    expect(await app.db.prepare('SELECT request_id,center_id,source_kind,payload_hash,hash_encoding,canonicalization FROM history_request_keys WHERE request_id=?').bind(auditId).first())
      .toEqual({ request_id: auditId, center_id: 'test-center', source_kind: 'audit', payload_hash: null, hash_encoding: 'none', canonicalization: 'legacy-unverified' });
    const accepted = await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(fixture.arrivalBody.eventId).first('result_visit');
    expect(JSON.parse(String(accepted))[0]).toBe(2);
    const retry = await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: fixture.arrivalBody }));
    expect(retry.visit).toEqual(fixture.arrival.visit);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys WHERE request_id=?').bind(fixture.arrivalBody.eventId).first('n')).toBe(1);
  });

  it('tracks arrivals, corrections, departure, and same-version review resolution in visit heads', async () => {
    const app = await currentApp();
    const detail = await createStudent(app);
    const arrival = await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 20 * 60_000).toISOString() }) }), 201);
    const visitId = arrival.visit!.id;
    await assertHead(app, visitId);
    await json(await app.request(`/api/admin/visits/${visitId}/corrections`, { token: app.token, body: {
      correctionId: crypto.randomUUID(), expectedVersion: 1,
      checkInAt: new Date(Date.parse(arrival.visit!.checkInAt) + 60_000).toISOString(), checkOutAt: null,
      reason: 'Correcting the originally recorded arrival time.',
    } }), 201);
    await assertHead(app, visitId);
    const departure = await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: observation(detail.student.id, 'exceptional_departure', {
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(), reason: 'Observed departure is awaiting manager confirmation.',
    }) }), 201);
    await assertHead(app, visitId);
    const beforeVersion = await app.db.prepare('SELECT version FROM visits WHERE id=?').bind(visitId).first('version');
    await json(await app.request(`/api/admin/reviews/${departure.event.id}/resolve`, { token: app.token, body: { resolution: 'Manager confirmed the circumstances of this departure.' } }));
    await assertHead(app, visitId);
    expect(await app.db.prepare('SELECT review_status,version FROM history_visit_heads WHERE visit_id=?').bind(visitId).first())
      .toEqual({ review_status: 'resolved', version: beforeVersion });
    expect(await app.db.prepare('SELECT original_check_in_at FROM history_visit_heads WHERE visit_id=?').bind(visitId).first('original_check_in_at')).toBe(arrival.visit!.originalCheckInAt);
  });

  it('blocks source visit deletion and changes to its permanent identity fields', async () => {
    const app = await currentApp();
    const fixture = await lifecycle(app);
    const otherStudent = await createStudent(app);
    await app.db.prepare("INSERT INTO centers(id,name,timezone,created_at) VALUES('other-history-center','Other history fixture','UTC',?)").bind(new Date().toISOString()).run();
    const before = await sources(app);
    const heads = await rows(app, 'history_visit_heads');
    await expect(app.db.prepare('DELETE FROM visits WHERE id=?').bind(fixture.visitId).run()).rejects.toThrow('HISTORY_EVICTION_DISABLED');
    for (const [field, value] of [
      ['id', `visit-${crypto.randomUUID()}`],
      ['center_id', 'other-history-center'],
      ['student_id', otherStudent.student.id],
      ['original_check_in_at', new Date(Date.parse(fixture.arrivalBody.observedAt) - 60_000).toISOString()],
    ]) await expect(app.db.prepare(`UPDATE visits SET ${field}=? WHERE id=?`).bind(value, fixture.visitId).run()).rejects.toThrow('IMMUTABLE_VISIT_IDENTITY');
    expect(await sources(app)).toEqual(before);
    expect(await rows(app, 'history_visit_heads')).toEqual(heads);
  });

  it('cannot insert a visit using an ID retained by a head after the live source is absent', async () => {
    const app = await currentApp();
    const detail = await createStudent(app);
    const arrival = await json<AttendanceResult>(await app.request('/api/admin/attendance', {
      token: app.token, body: observation(detail.student.id, 'check_in'),
    }), 201);
    const visitId = arrival.visit!.id;
    const source = await app.db.prepare('SELECT * FROM visits WHERE id=?').bind(visitId).first();
    expect(source).toBeTruthy();
    const head = await app.db.prepare('SELECT * FROM history_visit_heads WHERE visit_id=?').bind(visitId).first();
    // Simulate a retained head with no live source. Normal deletion remains
    // blocked; remove and restore only that guard within this fixture batch.
    const deleteGuard = await app.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='history_visit_no_delete'").first<string>('sql');
    expect(deleteGuard).toBeTruthy();
    await app.db.batch([
      app.db.prepare('DROP TRIGGER history_visit_no_delete'),
      app.db.prepare('DELETE FROM visits WHERE id=?').bind(visitId),
      app.db.prepare(deleteGuard!),
    ]);
    const columns = Object.keys(source!);
    await expect(app.db.prepare(`INSERT INTO visits(${columns.map(column => `"${column}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .bind(...columns.map(column => source![column])).run()).rejects.toThrow('HISTORY_VISIT_ID_CONFLICT');
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE id=?').bind(visitId).first('n')).toBe(0);
    expect(await app.db.prepare('SELECT * FROM history_visit_heads WHERE visit_id=?').bind(visitId).first()).toEqual(head);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE id=?').bind(arrival.event.id).first('n')).toBe(1);
  });

  it('never permits a registered request ID to change ownership, fingerprint, or disappear', async () => {
    const app = await currentApp();
    const fixture = await lifecycle(app);
    const id = fixture.arrivalBody.eventId;
    const original = await app.db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(id).first();
    for (const sql of [
      "UPDATE history_request_keys SET source_kind='audit',payload_hash=NULL,hash_encoding='none' WHERE request_id=?",
      "UPDATE history_request_keys SET payload_hash='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' WHERE request_id=?",
      "UPDATE history_request_keys SET center_id='different-center' WHERE request_id=?",
      'DELETE FROM history_request_keys WHERE request_id=?',
    ]) await expect(app.db.prepare(sql).bind(id).run()).rejects.toThrow();
    expect(await app.db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(id).first()).toEqual(original);
    await expect(insertAudit(app, id)).rejects.toThrow();
    expect(await app.db.prepare('SELECT count(*) AS n FROM audit_entries WHERE id=?').bind(id).first('n')).toBe(0);
  });

  it('rejects a live event when its ID has already been reserved by another request kind', async () => {
    const app = await currentApp();
    const detail = await createStudent(app);
    const body = observation(detail.student.id, 'check_in');
    await app.db.prepare("INSERT INTO history_request_keys(request_id,center_id,source_kind,payload_hash,hash_encoding) VALUES(?,'test-center','audit',NULL,'none')").bind(body.eventId).run();
    const before = await sources(app);
    const response = await app.request('/api/admin/attendance', { token: app.token, body });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await sources(app)).toEqual(before);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_visit_heads WHERE student_id=?').bind(detail.student.id).first('n')).toBe(0);
  });

  it('rejects INSERT OR REPLACE attempts instead of relying on SQLite delete-trigger recursion', async () => {
    const app = await currentApp();
    const fixture = await lifecycle(app);
    const auditId = await insertAudit(app);
    const key = await app.db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(fixture.arrivalBody.eventId).first();
    const audit = await app.db.prepare('SELECT * FROM audit_entries WHERE id=?').bind(auditId).first();
    const beforeSources = await sources(app);
    await expect(app.db.prepare(`INSERT OR REPLACE INTO history_request_keys(request_id,center_id,source_kind,payload_hash,hash_encoding)
      VALUES(?,'test-center','event','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','base64-sha256')`)
      .bind(fixture.arrivalBody.eventId).run()).rejects.toThrow();
    await expect(app.db.prepare(`INSERT OR REPLACE INTO history_request_keys
      SELECT * FROM history_request_keys WHERE request_id=?`).bind(fixture.arrivalBody.eventId).run()).rejects.toThrow();
    await expect(app.db.prepare(`INSERT OR REPLACE INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
      SELECT id,center_id,actor_id,actor_name,action,entity_type,entity_id,'{"tampered":true}',created_at FROM audit_entries WHERE id=?`)
      .bind(auditId).run()).rejects.toThrow();
    for (const [table, id] of [
      ['attendance_events', fixture.arrivalBody.eventId],
      ['attendance_corrections', fixture.correctionBody.correctionId],
    ]) await expect(app.db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE id=?`).bind(id).run()).rejects.toThrow();
    expect(await app.db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(fixture.arrivalBody.eventId).first()).toEqual(key);
    expect(await app.db.prepare('SELECT * FROM audit_entries WHERE id=?').bind(auditId).first()).toEqual(audit);
    expect(await sources(app)).toEqual(beforeSources);
  });
});

describe('bounded, restartable history lookup backfill', () => {
  it('uses preserved source receipts for requests not yet registered during partial backfill', async () => {
    const app = await legacyApp();
    const fixture = await legacyLifecycle(app);
    const before = await sources(app);
    await migrate(app);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys').first('n')).toBe(0);
    await advance(app, 1);
    expect((await status(app)).state).toBe('backfilling');
    const unregisteredId = await app.db.prepare(`SELECT e.id FROM attendance_events e WHERE NOT EXISTS(
      SELECT 1 FROM history_request_keys k WHERE k.request_id=e.id) ORDER BY e.id LIMIT 1`).first<string>('id');
    expect(unregisteredId).toBeTruthy();
    const original = unregisteredId === fixture.arrivalBody.eventId ? fixture.arrival : fixture.departure;
    const input = unregisteredId === fixture.arrivalBody.eventId ? fixture.arrivalBody : fixture.departureBody;
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys WHERE request_id=?').bind(fixture.correctionBody.correctionId).first('n')).toBe(0);
    const keys = await rows(app, 'history_request_keys');
    expect(await json<AttendanceResult>(await app.request(`/api/admin/attendance/events/${unregisteredId}`, { token: app.token })))
      .toEqual({ ...original, replayed: true });
    expect(await json<AttendanceResult>(await app.request('/api/admin/attendance', { token: app.token, body: input })))
      .toEqual({ ...original, replayed: true });
    const corrected = await json<{ correction: { id: string; visitId: string; checkInAt: string }; replayed: boolean }>(
      await app.request(`/api/admin/visits/${fixture.visitId}/corrections`, { token: app.token, body: fixture.correctionBody }));
    expect(corrected).toMatchObject({ correction: { id: fixture.correctionBody.correctionId, visitId: fixture.visitId, checkInAt: fixture.correctionBody.checkInAt }, replayed: true });
    expect(await rows(app, 'history_request_keys')).toEqual(keys);
    expect(await sources(app)).toEqual(before);
  });

  it('returns unavailable when a completed lookup registry is missing a key despite retained source evidence', async () => {
    const app = await legacyApp();
    const fixture = await legacyLifecycle(app);
    await migrate(app);
    await finish(app);
    expect((await status(app)).state).toBe('ready');
    const before = await sources(app);
    const deleteGuard = await app.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='history_keys_no_delete'").first<string>('sql');
    expect(deleteGuard).toBeTruthy();
    // Simulate an incomplete restore only in the isolated fixture. Restore the
    // permanent key guard before invoking any application request.
    await app.db.batch([
      app.db.prepare('DROP TRIGGER history_keys_no_delete'),
      app.db.prepare('DELETE FROM history_request_keys WHERE request_id IN (?,?)').bind(fixture.arrivalBody.eventId, fixture.correctionBody.correctionId),
      app.db.prepare(deleteGuard!),
    ]);
    for (const response of [
      await app.request(`/api/admin/attendance/events/${fixture.arrivalBody.eventId}`, { token: app.token }),
      await app.request('/api/admin/attendance', { token: app.token, body: fixture.arrivalBody }),
      await app.request(`/api/admin/visits/${fixture.visitId}/corrections`, { token: app.token, body: fixture.correctionBody }),
    ]) expect((await json<{ error: { code: string } }>(response, 503)).error.code).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys WHERE request_id IN (?,?)').bind(fixture.arrivalBody.eventId, fixture.correctionBody.correctionId).first('n')).toBe(0);
    expect(await sources(app)).toEqual(before);
  });

  it('protects existing source rows from REPLACE before their first backfill page runs', async () => {
    const app = await legacyApp();
    const fixture = await legacyLifecycle(app);
    const auditId = await insertAudit(app);
    const before = await sources(app);
    await migrate(app);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys').first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_visit_heads').first('n')).toBe(0);
    await expect(app.db.prepare('INSERT OR REPLACE INTO visits SELECT * FROM visits WHERE id=?').bind(fixture.visitId).run())
      .rejects.toThrow('HISTORY_VISIT_ID_CONFLICT');
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_visit_heads').first('n')).toBe(0);
    for (const [table, id] of [
      ['attendance_events', fixture.arrivalBody.eventId],
      ['attendance_corrections', fixture.correctionBody.correctionId],
    ]) await expect(app.db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE id=?`).bind(id).run()).rejects.toThrow();
    await expect(app.db.prepare(`INSERT OR REPLACE INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
      SELECT id,center_id,actor_id,actor_name,action,entity_type,entity_id,'{"tampered":true}',created_at FROM audit_entries WHERE id=?`)
      .bind(auditId).run()).rejects.toThrow();
    expect(await sources(app)).toEqual(before);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys').first('n')).toBe(0);
    // A harmless retry that retains the existing source remains permitted.
    for (const [table, id] of [
      ['attendance_events', fixture.arrivalBody.eventId],
      ['attendance_corrections', fixture.correctionBody.correctionId],
    ]) await app.db.prepare(`INSERT INTO ${table} SELECT * FROM ${table} WHERE id=? ON CONFLICT(id) DO NOTHING`).bind(id).run();
    await finish(app);
    expect(await sources(app)).toEqual(before);
    await assertHead(app, fixture.visitId);
  });

  it('rejects invalid page bounds before moving any persisted cursor', async () => {
    const app = await currentApp();
    const before = await status(app);
    for (const pageSize of [0, -1, 501, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(advance(app, pageSize)).rejects.toThrow('HISTORY_PAGE_SIZE_INVALID');
    }
    expect(await status(app)).toEqual(before);
  });

  it('backfills all legacy sources and physical audit aliases without rewriting source evidence', async () => {
    const app = await legacyApp();
    const fixture = await legacyLifecycle(app);
    for (let index = 0; index < 7; index++) await insertAudit(app);
    // Preserve an old physical alias exactly as a pre-compaction installation
    // could contain it. The production guard is immediately restored.
    const guard = await app.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='standalone_audit_id_available'").first<string>('sql');
    expect(guard).toBeTruthy();
    await app.db.batch([
      app.db.prepare('DROP TRIGGER standalone_audit_id_available'),
      app.db.prepare('INSERT INTO audit_entries SELECT * FROM attendance_audit_source WHERE id=?').bind(fixture.arrivalBody.eventId),
      app.db.prepare(guard!),
    ]);
    const before = await sources(app);
    await migrate(app);
    expect((await status(app)).state).toBe('backfilling');
    let finished = false;
    let lastProcessed = 0;
    for (let step = 0; step < 100; step++) {
      const result = await advance(app, 2);
      const processed = Number(await app.db.prepare('SELECT coalesce(sum(processed),0) AS n FROM history_backfill_jobs').first('n'));
      expect(processed - lastProcessed).toBeGreaterThanOrEqual(0);
      expect(processed - lastProcessed).toBeLessThanOrEqual(2);
      lastProcessed = processed;
      if (result.state === 'ready') { finished = true; break; }
    }
    expect(finished).toBe(true);
    expect((await status(app)).state).toBe('ready');
    const expectedKeys = (await app.db.prepare(`
      SELECT id AS request_id,center_id,'event' AS source_kind,payload_hash FROM attendance_events
      UNION ALL SELECT id,center_id,'correction',payload_hash FROM attendance_corrections
      UNION ALL SELECT id,center_id,'audit',NULL FROM audit_entries a
        WHERE NOT EXISTS(SELECT 1 FROM attendance_events e WHERE e.id=a.id)
          AND NOT EXISTS(SELECT 1 FROM attendance_corrections c WHERE c.id=a.id)
      ORDER BY request_id`).all()).results;
    expect((await app.db.prepare('SELECT request_id,center_id,source_kind,payload_hash FROM history_request_keys ORDER BY request_id').all()).results).toEqual(expectedKeys);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys WHERE request_id=?').bind(fixture.arrivalBody.eventId).first('n')).toBe(1);
    await assertHead(app, fixture.visitId);
    expect(await sources(app)).toEqual(before);
    const completed = await rows(app, 'history_backfill_jobs');
    const keys = await rows(app, 'history_request_keys');
    await advance(app, 2);
    await advance(app, 2);
    expect(await rows(app, 'history_backfill_jobs')).toEqual(completed);
    expect(await rows(app, 'history_request_keys')).toEqual(keys);
  });

  it('keeps a newer live visit head while an older migration backlog is still being processed', async () => {
    const app = await legacyApp();
    const fixture = await legacyLifecycle(app);
    await migrate(app);
    await advance(app, 1);
    // This same-version change happens after the backlog was created and must
    // not be undone by a later visit backfill page.
    await json(await app.request(`/api/admin/reviews/${fixture.departure.event.id}/resolve`, { token: app.token, body: { resolution: 'Resolved while a historical lookup backfill is in progress.' } }));
    const newHead = await app.db.prepare('SELECT * FROM history_visit_heads WHERE visit_id=?').bind(fixture.visitId).first();
    expect(newHead?.review_status).toBe('resolved');
    const later = await lifecycle(app);
    await finish(app, 1);
    expect(await app.db.prepare('SELECT * FROM history_visit_heads WHERE visit_id=?').bind(fixture.visitId).first()).toEqual(newHead);
    await assertHead(app, later.visitId);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys WHERE request_id=?').bind(later.arrivalBody.eventId).first('n')).toBe(1);
  });

  it('cannot retarget an existing head to another otherwise matching visit during partial backfill', async () => {
    const app = await legacyApp();
    await legacyLifecycle(app);
    await legacyLifecycle(app);
    const before = await sources(app);
    await migrate(app);
    let reachedVisitPage = false;
    for (let step = 0; step < 100; step++) {
      const result = await advance(app, 1);
      if (result.source === 'visits' && result.processed === 1) { reachedVisitPage = true; break; }
    }
    expect(reachedVisitPage).toBe(true);
    expect((await status(app)).state).toBe('backfilling');
    const heads = await rows(app, 'history_visit_heads');
    expect(heads).toHaveLength(1);
    const target = await app.db.prepare(`SELECT id AS visit_id,center_id,student_id,original_check_in_at,original_check_out_at,
      check_in_at,check_out_at,version,review_status,'live' AS residency FROM visits WHERE id!=? ORDER BY id LIMIT 1`).bind(heads[0].visit_id).first();
    expect(target).toBeTruthy();
    const columns = Object.keys(target!);
    await expect(app.db.prepare(`UPDATE history_visit_heads SET ${columns.map(column => `${column}=?`).join(',')} WHERE visit_id=?`)
      .bind(...columns.map(column => target![column]), heads[0].visit_id).run()).rejects.toThrow('HISTORY_PROJECTION_MISMATCH');
    expect(await rows(app, 'history_visit_heads')).toEqual(heads);
    expect(await sources(app)).toEqual(before);
    await finish(app, 1);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_visit_heads').first('n')).toBe(2);
    await assertHead(app, String(heads[0].visit_id));
    await assertHead(app, String(target!.visit_id));
  });

  it('does not skip records or double-count progress when two backfill workers select the same cursor', async () => {
    const app = await legacyApp();
    await legacyLifecycle(app);
    await legacyLifecycle(app);
    const before = await sources(app);
    const expectedProcessed = Object.values(before).reduce((sum, records) => sum + records.length, 0);
    await migrate(app);
    const concurrent = await Promise.allSettled([advance(app, 1), advance(app, 1)]);
    for (const result of concurrent) {
      if (result.status === 'rejected') expect(String(result.reason)).toContain('HISTORY_BACKFILL_STALE');
    }
    await finish(app, 1);
    expect(await app.db.prepare('SELECT sum(processed) AS n FROM history_backfill_jobs').first('n')).toBe(expectedProcessed);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_request_keys').first('n'))
      .toBe(before.attendance_events.length + before.attendance_corrections.length + before.audit_entries.length);
    expect(await app.db.prepare('SELECT count(*) AS n FROM history_visit_heads').first('n')).toBe(before.visits.length);
    expect(await sources(app)).toEqual(before);
  });

  it('fails closed on a conflicting pre-existing request fingerprint and preserves the cursor for retry', async () => {
    const app = await legacyApp();
    const fixture = await legacyLifecycle(app);
    await migrate(app);
    await app.db.prepare("INSERT INTO history_request_keys(request_id,center_id,source_kind,payload_hash,hash_encoding) VALUES(?,'test-center','event',?,'base64-sha256')")
      .bind(fixture.arrivalBody.eventId, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').run();
    const before = await sources(app);
    const jobs = await rows(app, 'history_backfill_jobs');
    await expect(finish(app, 100)).rejects.toThrow();
    expect((await status(app)).state).toBe('backfilling');
    expect(await rows(app, 'history_backfill_jobs')).toEqual(jobs);
    expect(await sources(app)).toEqual(before);
    await expect(finish(app, 100)).rejects.toThrow();
    expect(await rows(app, 'history_backfill_jobs')).toEqual(jobs);
  });

  it('does not declare ready when an existing head disagrees with the live visit', async () => {
    const app = await legacyApp();
    const fixture = await legacyLifecycle(app);
    await migrate(app);
    // Inject corruption as if a restore or an older deployment had left an
    // inconsistent head. Current write guards must be restored before testing
    // whether the backfill trusts that pre-existing record.
    const guards = (await app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='history_visit_heads'").all<{ name: string; sql: string }>()).results;
    expect(guards.length).toBeGreaterThan(0);
    await app.db.batch([
      ...guards.map(guard => app.db.prepare(`DROP TRIGGER "${guard.name}"`)),
      app.db.prepare(`INSERT INTO history_visit_heads(visit_id,center_id,student_id,original_check_in_at,original_check_out_at,check_in_at,check_out_at,version,review_status,residency)
        SELECT id,center_id,student_id,original_check_in_at,original_check_out_at,check_in_at,check_out_at,version,'resolved','live' FROM visits WHERE id=?`).bind(fixture.visitId),
      ...guards.map(guard => app.db.prepare(guard.sql)),
    ]);
    const before = await sources(app);
    await expect(finish(app, 100)).rejects.toThrow();
    expect((await status(app)).state).toBe('backfilling');
    expect(await app.db.prepare('SELECT review_status FROM history_visit_heads WHERE visit_id=?').bind(fixture.visitId).first('review_status')).toBe('resolved');
    expect(await sources(app)).toEqual(before);
  });

  it('blocks every lookup mutation during the SQL backup snapshot and includes all registry tables in recovery counts', async () => {
    const app = await currentApp();
    const fixture = await lifecycle(app);
    expect(BACKUP_TABLES).toEqual(expect.arrayContaining(registryTables));
    expect(await app.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='history_record_locations' AND sql LIKE '%backup_runtime%'").first('n')).toBe(3);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1')
      .bind(new Date(Date.now() + 60_000).toISOString(), 'lookup-backup-fixture').run();
    const before = Object.fromEntries(await Promise.all(registryTables.map(async table => [table, await rows(app, table)])));
    for (const statement of [
      app.db.prepare("INSERT INTO history_request_keys(request_id,center_id,source_kind,payload_hash,hash_encoding) VALUES(?,'test-center','audit',NULL,'none')").bind(crypto.randomUUID()),
      app.db.prepare('UPDATE history_visit_heads SET review_status=review_status WHERE visit_id=?').bind(fixture.visitId),
      app.db.prepare('UPDATE history_runtime SET generation=generation WHERE id=1'),
      app.db.prepare('UPDATE history_backfill_jobs SET processed=processed'),
    ]) await expect(statement.run()).rejects.toThrow('backup_maintenance');
    expect((await advance(app)).state).toBe('paused');
    expect(Object.fromEntries(await Promise.all(registryTables.map(async table => [table, await rows(app, table)])))).toEqual(before);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL,lock_job_id=NULL WHERE id=1').run();
    expect((await finish(app)).state).toBe('ready');
  });
});
