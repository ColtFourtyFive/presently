import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import type { AdminSession, AttendanceResult, CorrectionInput, StudentDetail, VisitSummary } from '../shared/types.js';
import { decodeAttendanceReceipt, type ReceiptEvent } from '../worker/attendance-receipt.js';
import { json, observation, startApp, type App } from './helpers.js';
import { createRuntime, projectRoot, testAudience, testIssuer } from './runtime.js';

const migrationName = '0007_storage_compaction.sql';

// Legacy fixtures use the actual pre-grade columns. New application creation
// routes require later migrations and must not silently alter this old schema.
async function createStudent(app: App): Promise<StudentDetail> {
  const studentId = crypto.randomUUID(), guardianId = crypto.randomUUID(), timestamp = new Date().toISOString();
  await app.db.batch([
    app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,subjects,created_at,updated_at) VALUES(?,'test-center',?,'Synthetic','Student','[\"Math\",\"Reading\"]',?,?)").bind(studentId, `T-${studentId}`, timestamp, timestamp),
    app.db.prepare("INSERT INTO guardians(id,center_id,display_name,phone,email,created_at) VALUES(?,'test-center','Approved Guardian','555-0101','guardian@example.test',?)").bind(guardianId, timestamp),
    app.db.prepare("INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note) VALUES(?,?,'Parent','allowed','Synthetic test verification')").bind(studentId, guardianId),
    app.db.prepare("INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,'test-center',?,?,'student_created','student',?,'{}',?)").bind(crypto.randomUUID(), app.actor.id, app.actor.displayName, studentId, timestamp),
  ]);
  return json<StudentDetail>(await app.request(`/api/admin/students/${studentId}`, { token: app.token }));
}

const migrationSql = () => readFile(join(projectRoot, 'migrations', migrationName), 'utf8');
async function legacyApp(): Promise<App> {
  const app = await createRuntime({ migrate: false, bindings: { APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'compaction-test', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test' } });
  try {
    const files = (await readdir(join(projectRoot, 'migrations'))).filter(name => name.endsWith('.sql') && name < migrationName).sort();
    for (const file of files) await app.db.batch(unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', file), 'utf8')).map(sql => app.db.prepare(sql)));
    const token = await app.signer.token();
    const session = await json<AdminSession>(await app.request('/api/admin/session', { token }));
    return { ...app, token, actor: session.actor };
  } catch (error) { await app.close(); throw error; }
}
const post = (app: App, body: unknown) => app.request('/api/admin/attendance', { token: app.token, body });
const apply = async (app: App) => app.db.batch(unstable_splitSqlQuery(await migrationSql()).map(sql => app.db.prepare(sql)));
const auditRows = async (app: App, relation = 'audit_entries') => (await app.db.prepare(`SELECT id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at FROM ${relation} ORDER BY id`).all()).results;
const sourceRows = async (app: App) => (await app.db.prepare('SELECT id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce FROM attendance_events ORDER BY id').all()).results;
const storedReceipts = async (app: App) => (await app.db.prepare('SELECT * FROM attendance_events ORDER BY id').all()).results.map(row => ({ id: row.id, visit: decodeAttendanceReceipt(row as ReceiptEvent) }));

async function sourceReceipt(app: Pick<App, 'db'>, eventId: string, replayed = true): Promise<AttendanceResult> {
  const row = await app.db.prepare('SELECT * FROM attendance_events WHERE id=?').bind(eventId).first();
  if (!row) throw new Error('The historical fixture did not retain its attendance source.');
  return { event: { id: String(row.id), studentId: String(row.student_id), visitId: row.visit_id as string | null,
    action: row.action as AttendanceResult['event']['action'], observedAt: String(row.observed_at), receivedAt: String(row.received_at),
    actorId: String(row.actor_id), actorName: String(row.actor_name), channel: row.channel as 'admin' | 'kiosk',
    guardianId: row.guardian_id as string | null, reason: row.reason as string | null },
  visit: decodeAttendanceReceipt(row as ReceiptEvent), replayed };
}
async function seedLegacyEvent(app: App, input: ReturnType<typeof observation> & { guardianId?: string; reason?: string }): Promise<AttendanceResult> {
  // Schema6/7 fixtures exercise their actual historical D1 triggers. The current
  // HTTP attendance router intentionally requires the later history registry.
  const visitId = input.action === 'check_in' ? `visit-${input.eventId}`
    : await app.db.prepare("SELECT id FROM visits WHERE student_id=? AND center_id='test-center' AND check_out_at IS NULL").bind(input.studentId).first<string>('id');
  const actorName = await app.db.prepare('SELECT display_name FROM staff WHERE id=?').bind(app.actor.id).first<string>('display_name');
  const guardianId = input.guardianId || null, reason = input.reason || null;
  const hash = createHash('sha256').update(JSON.stringify({ studentId: input.studentId, action: input.action, observedAt: input.observedAt, guardianId, reason })).digest('base64');
  await app.db.prepare(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,reason,payload_hash,insertion_nonce)
    VALUES(?,'test-center',?,?,?,?,?,?,?,'admin',?,?,?,?)`)
    .bind(input.eventId, input.studentId, visitId, input.action, input.observedAt, new Date().toISOString(), app.actor.id, actorName,
      guardianId, reason, hash, crypto.randomUUID()).run();
  return sourceReceipt(app, input.eventId, false);
}
async function seedLegacyCorrection(app: App, visitId: string, input: CorrectionInput) {
  const actorName = await app.db.prepare('SELECT display_name FROM staff WHERE id=?').bind(app.actor.id).first<string>('display_name');
  const hash = createHash('sha256').update(JSON.stringify({ visitId, expectedVersion: input.expectedVersion, checkInAt: input.checkInAt, checkOutAt: input.checkOutAt, reason: input.reason })).digest('base64');
  await app.db.prepare(`INSERT INTO attendance_corrections(id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash)
    SELECT ?,'test-center',id,?,check_in_at,check_out_at,?,?,?,?,?,?,? FROM visits WHERE id=?`)
    .bind(input.correctionId, input.expectedVersion, input.checkInAt, input.checkOutAt, input.reason, app.actor.id, actorName, new Date().toISOString(), hash, visitId).run();
}

async function lifecycle(app: App, legacy = false) {
  const record = async (input: ReturnType<typeof observation>) => legacy ? seedLegacyEvent(app, input) : json<AttendanceResult>(await post(app, input), 201);
  const correct = (visitId: string, input: CorrectionInput) => legacy ? seedLegacyCorrection(app, visitId, input)
    : app.request(`/api/admin/visits/${visitId}/corrections`, { token: app.token, body: input }).then(response => json(response, 201));
  const detail = await createStudent(app);
  const arrivalBody = observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 20 * 60000).toISOString() });
  const arrival = await record(arrivalBody);
  const correctedIn = new Date(Date.parse(arrivalBody.observedAt) + 60000).toISOString();
  const correctionBody = { correctionId: crypto.randomUUID(), expectedVersion: arrival.visit!.version, checkInAt: correctedIn, checkOutAt: null, reason: 'Corrected arrival from the original paper observation.' };
  await correct(arrival.visit!.id, correctionBody);
  await app.db.batch([
    app.db.prepare("UPDATE students SET first_name='Name at departure',student_code='DEPARTURE-CODE',active=0 WHERE id=?").bind(detail.student.id),
    app.db.prepare("UPDATE staff SET display_name='Operator at departure' WHERE id=?").bind(app.actor.id),
    app.db.prepare("UPDATE guardians SET display_name='Guardian at departure' WHERE id=?").bind(detail.guardians[0].id),
  ]);
  const departureBody = observation(detail.student.id, 'check_out', { observedAt: new Date(Date.now() - 10 * 60000).toISOString(), guardianId: detail.guardians[0].id });
  const departure = await record(departureBody);
  expect(departure.visit).toMatchObject({ checkInAt: correctedIn, originalCheckInAt: arrivalBody.observedAt, active: false, checkInBy: 'Operator at departure', checkOutBy: 'Operator at departure', guardianName: 'Guardian at departure', version: 3 });
  await correct(arrival.visit!.id, { correctionId: crypto.randomUUID(), expectedVersion: departure.visit!.version, checkInAt: new Date(Date.parse(correctedIn) + 60000).toISOString(), checkOutAt: new Date(Date.parse(departureBody.observedAt) + 60000).toISOString(), reason: 'Subsequent correction must not rewrite either accepted receipt.' });
  await app.db.batch([
    app.db.prepare("UPDATE students SET first_name='Later name',student_code='LATER-CODE',active=1 WHERE id=?").bind(detail.student.id),
    app.db.prepare("UPDATE staff SET display_name='Later operator name' WHERE id=?").bind(app.actor.id),
    app.db.prepare("UPDATE guardians SET display_name='Later guardian name' WHERE id=?").bind(detail.guardians[0].id),
  ]);
  return { arrivalBody, arrival, departureBody, departure, correctionBody };
}

describe('Versioned attendance receipt and logical audit compaction', () => {
  it('freezes compact receipts across departure, corrections, profile changes, and review resolution', async () => {
    const app = await startApp();
    try {
      const fixture = await lifecycle(app);
      for (const [request, accepted] of [[fixture.arrivalBody, fixture.arrival], [fixture.departureBody, fixture.departure]] as const) {
        const replay = await json<AttendanceResult>(await post(app, request));
        expect(replay).toEqual({ ...accepted, replayed: true });
        const stored = String(await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(request.eventId).first('result_visit'));
        expect(JSON.parse(stored)).toHaveLength(10); expect(JSON.parse(stored)[0]).toBe(2);
      }
      const detail = await createStudent(app);
      await json(await post(app, observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 120000).toISOString() })), 201);
      const request = observation(detail.student.id, 'exceptional_departure', { reason: 'Observed departure requiring manager reconciliation.' });
      const accepted = await json<AttendanceResult>(await post(app, request), 201);
      await json(await app.request(`/api/admin/reviews/${accepted.event.id}/resolve`, { token: app.token, body: { resolution: 'Manager reviewed the incident against the paper attendance record.' } }));
      const replay = await json<AttendanceResult>(await post(app, request));
      expect(replay.visit).toEqual(accepted.visit); expect(replay.visit?.reviewStatus).toBe('pending');
      expect(await app.db.prepare('SELECT review_status FROM visits WHERE id=?').bind(accepted.visit!.id).first('review_status')).toBe('resolved');
      expect(await app.db.prepare("SELECT count(*) AS n FROM audit_entries WHERE entity_type='attendance_event' OR action='attendance_correction'").first('n')).toBe(0);
      const logical = await auditRows(app, 'audit_timeline');
      for (const event of [fixture.arrival.event, fixture.departure.event, accepted.event]) expect(logical.filter(row => row.id === event.id)).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('keeps unmatched departures sealed and rejects unknown receipt formats without changing idempotency', async () => {
    const app = await startApp();
    try {
      const detail = await createStudent(app), request = observation(detail.student.id, 'exceptional_departure', { reason: 'Observed departure without a matching arrival.' });
      const responses = await Promise.all([post(app, request), post(app, request)]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
      for (const response of responses) expect((await response.json() as AttendanceResult).visit).toBeNull();
      const row = await app.db.prepare('SELECT * FROM attendance_events WHERE id=?').bind(request.eventId).first();
      expect(row?.result_visit).toBe('null'); expect(row?.visit_id).toBeNull();
      await expect(app.db.prepare('UPDATE attendance_events SET result_visit=NULL WHERE id=?').bind(request.eventId).run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
      await expect(app.db.prepare("UPDATE attendance_events SET actor_name='Changed' WHERE id=?").bind(request.eventId).run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
      expect((await post(app, { ...request, reason: 'A different observed circumstance.' })).status).toBe(409);
      expect(() => decodeAttendanceReceipt({ ...row, result_visit: null } as ReceiptEvent)).toThrow('not sealed');
      expect(() => decodeAttendanceReceipt({ ...row, result_visit: '[99]' } as ReceiptEvent)).toThrow('Unsupported');
    } finally { await app.close(); }
  });

  it('compacts a populated legacy database while preserving every source and logical audit field', async () => {
    const app = await legacyApp();
    try {
      const fixture = await lifecycle(app, true);
      const unmatched = await createStudent(app);
      await seedLegacyEvent(app, observation(unmatched.student.id, 'exceptional_departure', { reason: 'Legacy unmatched departure must remain sealed.' }));
      // Preserve divergent historical/custom audit values instead of replacing them
      // with a projection. Exercise every field used in the exact-match predicate.
      await app.db.prepare('DROP TRIGGER audit_no_update').run();
      await app.db.prepare('INSERT INTO centers(id,name,timezone,created_at) VALUES(?,?,?,?)').bind('legacy-other-center', 'Other legacy center', 'UTC', new Date().toISOString()).run();
      const divergentFields = ['center_id','actor_id','actor_name','action','entity_type','entity_id','detail','created_at'];
      const divergentIds: string[] = [];
      for (const field of divergentFields) {
        const student = await createStudent(app);
        const accepted = await seedLegacyEvent(app, observation(student.student.id, 'check_in'));
        const replacement = field === 'center_id' ? 'legacy-other-center' : field === 'actor_id' ? null : field === 'detail' ? '{"custom":"preserve exact bytes"}' : field === 'created_at' ? '2020-01-01T00:00:00.000Z' : `custom ${field}`;
        await app.db.prepare(`UPDATE audit_entries SET ${field}=? WHERE id=?`).bind(replacement, accepted.event.id).run();
        divergentIds.push(accepted.event.id);
      }
      await app.db.prepare("CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END").run();
      const before = { audits: await auditRows(app), sources: await sourceRows(app), receipts: await storedReceipts(app), corrections: (await app.db.prepare('SELECT * FROM attendance_corrections ORDER BY id').all()).results };
      await app.db.prepare("UPDATE backup_runtime SET write_locked_until='9999-12-31T23:59:59.999Z',lock_job_id='upgrade-compaction-fixture' WHERE id=1").run();
      await apply(app);
      expect(await auditRows(app, 'audit_timeline')).toEqual(before.audits);
      expect(await sourceRows(app)).toEqual(before.sources);
      expect(await storedReceipts(app)).toEqual(before.receipts);
      expect((await app.db.prepare('SELECT * FROM attendance_corrections ORDER BY id').all()).results).toEqual(before.corrections);
      expect((await auditRows(app)).length).toBe(before.audits.length - 5); // Two observations, two corrections, one unmatched departure.
      for (const id of divergentIds) expect(await app.db.prepare('SELECT id FROM audit_entries WHERE id=?').bind(id).first('id')).toBe(id);
      expect(await app.db.prepare('SELECT write_locked_until FROM backup_runtime WHERE id=1').first('write_locked_until')).toBe('9999-12-31T23:59:59.999Z');
      await expect(app.db.prepare("UPDATE students SET first_name='Blocked' WHERE id=?").bind(fixture.arrival.event.studentId).run()).rejects.toThrow('backup_maintenance');
      await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL,lock_job_id=NULL WHERE id=1').run();
      for (const [request, accepted] of [[fixture.arrivalBody, fixture.arrival], [fixture.departureBody, fixture.departure]] as const) expect(await sourceReceipt(app, request.eventId)).toEqual({ ...accepted, replayed: true });
      const index = await app.db.prepare("SELECT sql FROM sqlite_master WHERE name='visits_center_open'").first<string>('sql');
      expect(index).toContain('WHERE check_out_at IS NULL');
      expect(await app.db.prepare("SELECT sql FROM sqlite_master WHERE name='one_open_visit'").first('sql')).toContain('UNIQUE');
      await expect(app.db.prepare('DELETE FROM attendance_events WHERE id=?').bind(fixture.arrival.event.id).run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
      await expect(app.db.prepare('DELETE FROM attendance_corrections WHERE id=?').bind(fixture.correctionBody.correctionId).run()).rejects.toThrow('IMMUTABLE_CORRECTION');
      await expect(app.db.prepare('DELETE FROM audit_entries WHERE id=?').bind(divergentIds[0]).run()).rejects.toThrow('IMMUTABLE_AUDIT');
      expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally { await app.close(); }
  });

  it('rolls back schema changes, removed duplicate rows, and receipt rewrites if the atomic migration fails', async () => {
    const app = await legacyApp();
    try {
      await lifecycle(app, true);
      const before = { objects: (await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).results, audits: await auditRows(app), events: (await app.db.prepare('SELECT * FROM attendance_events ORDER BY id').all()).results };
      await app.db.prepare("UPDATE backup_runtime SET write_locked_until='9999-12-31T23:59:59.999Z',lock_job_id='upgrade-failure-fixture' WHERE id=1").run();
      await expect(app.db.batch([...unstable_splitSqlQuery(await migrationSql()).map(sql => app.db.prepare(sql)), app.db.prepare('INSERT INTO schema_versions(version) VALUES(1)')])).rejects.toThrow('UNIQUE');
      expect((await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).results).toEqual(before.objects);
      expect(await auditRows(app)).toEqual(before.audits);
      expect((await app.db.prepare('SELECT * FROM attendance_events ORDER BY id').all()).results).toEqual(before.events);
      expect(await app.db.prepare('SELECT max(version) AS version FROM schema_versions').first('version')).toBe(6);
      await expect(app.db.prepare("UPDATE attendance_events SET result_visit='null'").run()).rejects.toThrow();
      await expect(app.db.prepare('DELETE FROM audit_entries').run()).rejects.toThrow();
    } finally { await app.close(); }
  });

  it('aborts on an unexpected legacy audit gap instead of silently changing the logical audit identity set', async () => {
    const app = await legacyApp();
    try {
      const detail = await createStudent(app), request = observation(detail.student.id, 'check_in');
      await seedLegacyEvent(app, request);
      await app.db.prepare('DROP TRIGGER audit_no_delete').run();
      await app.db.prepare('DELETE FROM audit_entries WHERE id=?').bind(request.eventId).run();
      await app.db.prepare("CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END").run();
      const receipt = await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(request.eventId).first('result_visit');
      await expect(apply(app)).rejects.toThrow('CHECK');
      expect(await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(request.eventId).first('result_visit')).toBe(receipt);
      expect(await app.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('audit_timeline','storage_compaction_guard')").first('n')).toBe(0);
      await expect(app.db.prepare('DELETE FROM audit_entries').run()).rejects.toThrow('IMMUTABLE_AUDIT');
    } finally { await app.close(); }
  });

  it('restores the compact schema, physical sources, audit views, and immutable guards from a native-style SQL dump', async () => {
    const app = await legacyApp();
    const restored = await createRuntime({ migrate: false, signer: app.signer, bindings: { APP_ENV: 'production', CENTER_ID: 'test-center', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test' } });
    try {
      const fixture = await lifecycle(app, true); await apply(app);
      const objects = (await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all<{ name: string; type: string; sql: string }>()).results;
      const tables = objects.filter(object => object.type === 'table'), sql = ['PRAGMA defer_foreign_keys=ON', ...tables.map(table => table.sql)];
      const literal = (value: unknown) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
      for (const table of tables) for (const row of (await app.db.prepare(`SELECT * FROM "${table.name}"`).all()).results) sql.push(`INSERT INTO "${table.name}" (${Object.keys(row).map(key => `"${key}"`).join(',')}) VALUES (${Object.values(row).map(literal).join(',')})`);
      sql.push(...objects.filter(object => object.type !== 'table').map(object => object.sql));
      await restored.db.batch(sql.map(statement => restored.db.prepare(statement)));
      expect((await restored.db.prepare('SELECT * FROM audit_timeline ORDER BY id').all()).results).toEqual(await auditRows(app, 'audit_timeline'));
      expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      const result = await sourceReceipt(restored, fixture.departure.event.id);
      expect(result).toEqual({ ...fixture.departure, replayed: true });
      await expect(restored.db.prepare('DELETE FROM attendance_events WHERE id=?').bind(fixture.arrival.event.id).run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
    } finally { await restored.close(); await app.close(); }
  });

  it('retains legacy-object support and refuses cross-source audit ID collisions', async () => {
    const app = await legacyApp();
    try {
      const student = await createStudent(app), request = observation(student.student.id, 'check_in');
      const accepted = await seedLegacyEvent(app, request);
      const stored = String(await app.db.prepare('SELECT result_visit FROM attendance_events WHERE id=?').bind(request.eventId).first('result_visit'));
      expect(JSON.parse(stored)).toEqual(accepted.visit);
      expect(decodeAttendanceReceipt({ visit_id: accepted.visit!.id, student_id: student.student.id, action: 'check_in', observed_at: request.observedAt, result_visit: stored })).toEqual(accepted.visit);
      await apply(app);
      const other = await createStudent(app);
      const standalone = (await app.db.prepare("SELECT id FROM audit_entries WHERE action='student_created' LIMIT 1").first<{ id: string }>())!.id;
      await expect(seedLegacyEvent(app, observation(other.student.id, 'check_in', { eventId: standalone }))).rejects.toThrow('AUDIT_ID_CONFLICT');
      expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').bind(other.student.id).first('n')).toBe(0);
      await expect(app.db.prepare("INSERT INTO audit_entries(id,center_id,actor_name,action,entity_type,entity_id,created_at) VALUES(?,'test-center','Other','custom','test','id',?)").bind(request.eventId, new Date().toISOString()).run()).rejects.toThrow('AUDIT_ID_CONFLICT');
      expect(await sourceReceipt(app, request.eventId)).toEqual({ ...accepted, replayed: true });
    } finally { await app.close(); }
  });
});
