import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createStudent, json, startApp, type App } from './helpers';
import { openArchiveManifest, verifyArchivePart } from '../worker/archive-codec';
import { ARCHIVE_FORMAT_V2, type ArchiveRecord } from '../shared/archive-format';
import { advanceArchive } from '../worker/archive';
import type { Env } from '../worker/types';
import { setTimeout as delay } from 'node:timers/promises';

describe('verified historical archive jobs', () => {
  let app: App;
  const key = randomBytes(32).toString('base64');
  beforeEach(async () => { app = await startApp({ r2: true, bindings: { APP_ENV: 'local', ARCHIVE_ENABLED: 'true', BACKUP_KEY: key } }); });
  afterEach(async () => { await app.close(); });

  async function visit(arrival = '2025-01-10T18:00:00.000Z', departure: string | null = '2025-01-10T19:00:00.000Z') {
    const detail = await createStudent(app);
    const visitId = crypto.randomUUID();
    const sql = 'INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)';
    for (const [action, at] of [['check_in', arrival], ['check_out', departure]] as const) {
      if (!at) continue;
      const eventId = crypto.randomUUID();
      const guardianId = action === 'check_out' ? detail.guardians.find(g => g.pickupAuthority === 'allowed')!.id : null;
      await app.db.prepare(sql).bind(eventId, 'test-center', detail.student.id, visitId, action, at, at,
        app.actor.id, app.actor.displayName, 'admin', guardianId,
        createHash('sha256').update(JSON.stringify({ studentId: detail.student.id, action, observedAt: at, guardianId, reason: null })).digest('base64'), eventId).run();
    }
    return { detail, visitId };
  }
  async function start(month = '2025-01') {
    return (await json<{ jobId: string }>(await app.request('/api/admin/archives/start', { token: app.token, body: { month } }), 202)).jobId;
  }
  async function finish(jobId: string) {
    for (let i = 0; i < 100; i++) {
      const result = await json<{ status: string }>(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
      if (result.status === 'complete') return;
      if (result.status === 'failed') {
        const failed = await app.db.prepare('SELECT error_code,next_part,verify_part FROM archive_jobs WHERE id=?').bind(jobId).first();
        throw new Error(JSON.stringify(failed));
      }
    }
    throw new Error('Archive did not finish within bounded test steps');
  }
  async function archivedRecords(jobId: string): Promise<ArchiveRecord[]> {
    const job = await app.db.prepare('SELECT manifest_key FROM archive_jobs WHERE id=?').bind(jobId).first<{ manifest_key: string }>();
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    const envelope = await bucket.get(job!.manifest_key);
    const manifest = await openArchiveManifest(key, new Uint8Array(await envelope!.arrayBuffer()));
    const records: ArchiveRecord[] = [];
    for (const part of manifest.parts) { const object = await bucket.get(part.objectKey); records.push(...await verifyArchivePart(key, manifest, part, new Uint8Array(await object!.arrayBuffer()))); }
    return records;
  }

  it('preserves observations and identity context in verified R2 copies without evicting live records', async () => {
    const { visitId } = await visit();
    const countsBefore = await app.db.prepare('SELECT count(*) AS n FROM attendance_events').first();
    const jobId = await start();
    await finish(jobId);
    const job = await app.db.prepare('SELECT * FROM archive_jobs WHERE id=?').bind(jobId).first<{ manifest_key: string; manifest_sha256: string }>();
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    const stored = await bucket.get(job!.manifest_key);
    const manifest = await openArchiveManifest(key, new Uint8Array(await stored!.arrayBuffer()));
    expect(manifest.recordCounts.attendance_events).toBe(2);
    expect(manifest.recordCounts.visits).toBe(1);
    expect(manifest.recordCounts.audit_entries).toBe(2);
    const records: ArchiveRecord[] = [];
    for (const part of manifest.parts) {
      const object = await bucket.get(part.objectKey);
      records.push(...await verifyArchivePart(key, manifest, part, new Uint8Array(await object!.arrayBuffer())));
    }
    expect(records.find(r => r.table === 'visits')?.row.id).toBe(visitId);
    const staff = records.find(r => r.table === 'staff')!.row;
    expect(staff).not.toHaveProperty('pin_hash');
    expect(staff).not.toHaveProperty('pin_salt');
    expect(staff).not.toHaveProperty('email');
    expect(records.filter(r => r.table === 'guardians').every(r => !Object.hasOwn(r.row, 'phone') && !Object.hasOwn(r.row, 'email'))).toBe(true);
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events').first()).toEqual(countsBefore);
    expect(await app.db.prepare('SELECT id FROM visits WHERE id=?').bind(visitId).first()).toBeTruthy();
    expect(await app.db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] });
    const listed = await json<{ mode: string }>(await app.request('/api/admin/archives', { token: app.token }));
    expect(listed.mode).toBe('verified-copy');
  });

  it('seals an opted-in version 2 job with a frozen semantic profile while retaining source rows', async () => {
    await app.close();
    app = await startApp({ r2: true, bindings: { APP_ENV: 'local', ARCHIVE_ENABLED: 'true', ARCHIVE_V2_ENABLED: 'true', BACKUP_KEY: key } });
    const { visitId } = await visit();
    const jobId = await start();
    await finish(jobId);
    const job = await app.db.prepare('SELECT format_version,semantic_proof_json,manifest_key FROM archive_jobs WHERE id=?')
      .bind(jobId).first<{ format_version: number; semantic_proof_json: string; manifest_key: string }>();
    expect(job?.format_version).toBe(2);
    expect(JSON.parse(job!.semantic_proof_json)).toEqual({ version: 1, payloadHashEncoding: 'base64', deviceContexts: [] });
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    const stored = await bucket.get(job!.manifest_key);
    const manifest = await openArchiveManifest(key, new Uint8Array(await stored!.arrayBuffer()));
    expect(manifest.format).toBe(ARCHIVE_FORMAT_V2);
    expect(manifest.semanticProof).toEqual(JSON.parse(job!.semantic_proof_json));
    expect((await archivedRecords(jobId)).some(record => record.table === 'visits' && record.row.id === visitId)).toBe(true);
    expect(await app.db.prepare('SELECT id FROM visits WHERE id=?').bind(visitId).first()).toBeTruthy();
    let historyReady = false;
    for (let step = 0; step < 200 && !historyReady; step++) {
      const result = await json<{ state: string }>(await app.request('/api/admin/archives/semantic/maintenance/backfill/advance', { token: app.token, body: {} }));
      historyReady = result.state === 'ready';
    }
    expect(historyReady).toBe(true);
    const semantic = await json<{ parts: number; verificationId: string; generation: string }>(await app.request(`/api/admin/archives/semantic/${jobId}/start`, { token: app.token, body: {} }), 202);
    const replayed = await json<{ verificationId: string; generation: string }>(await app.request(`/api/admin/archives/semantic/${jobId}/start`, { token: app.token, body: {} }), 202);
    expect(replayed).toMatchObject({ verificationId: semantic.verificationId, generation: semantic.generation });
    for (let index = 0; index < semantic.parts; index++) {
      await json(await app.request(`/api/admin/archives/semantic/${jobId}/parts/${index}`, { token: app.token, body: {} }));
    }
    await json(await app.request(`/api/admin/archives/semantic/${jobId}/parts/0`, { token: app.token, body: {} }));
    await json(await app.request(`/api/admin/archives/semantic/${jobId}/freeze`, { token: app.token, body: {} }), 202);
    const frozenReplay = await json<{ status: string }>(await app.request(`/api/admin/archives/semantic/${jobId}/start`, { token: app.token, body: {} }), 202);
    expect(frozenReplay.status).toBe('frozen');
    await json(await app.request(`/api/admin/archives/semantic/${jobId}/parts/0`, { token: app.token, body: {} }), 409);
    let verified = false;
    for (let step = 0; step < 200 && !verified; step++) {
      const result = await json<{ status: string }>(await app.request(`/api/admin/archives/semantic/${jobId}/verify/advance`, { token: app.token, body: {} }));
      if (result.status === 'complete') verified = true;
      else if (result.status !== 'pending' && result.status !== 'busy') throw new Error(`Semantic verification stopped: ${result.status}`);
      await delay(5);
    }
    expect(verified).toBe(true);
    await json(await app.request(`/api/admin/archives/semantic/${jobId}/publish/start`, { token: app.token, body: {} }), 202);
    await json(await app.request(`/api/admin/archives/semantic/${jobId}/publish/start`, { token: app.token, body: {} }), 202);
    let published = false;
    for (let step = 0; step < 200 && !published; step++) {
      const result = await json<{ state: string }>(await app.request(`/api/admin/archives/semantic/${jobId}/publish/advance`, { token: app.token, body: {} }));
      if (result.state === 'published') published = true;
      else if (result.state !== 'building') throw new Error(`Compact publication stopped: ${result.state}`);
      await delay(5);
    }
    expect(published).toBe(true);
    const activated = await json<{ publication: { state: string }; sourceEvictionEnabled: boolean }>(await app.request(`/api/admin/archives/semantic/${jobId}`, { token: app.token }));
    expect(activated.publication.state).toBe('published');
    expect(activated.sourceEvictionEnabled).toBe(false);
    const retention = await json<{ jobId: string; deletionEnabled: boolean }>(await app.request('/api/admin/archives/retention/start', { token: app.token, body: { limit: 10 } }), 202);
    expect(retention.deletionEnabled).toBe(false);
    let candidates = 0;
    for (let step = 0; step < 100; step++) {
      const result = await json<{ status: string; candidateCount: number }>(await app.request(`/api/admin/archives/retention/${retention.jobId}/advance`, { token: app.token, body: {} }));
      if (result.status === 'complete') { candidates = result.candidateCount; break; }
      if (result.status !== 'planning') throw new Error(`Retention dry run stopped: ${result.status}`);
    }
    expect(candidates).toBe(1);
    await json(await app.request(`/api/admin/archives/retention/${retention.jobId}/evict/${visitId}`, { token: app.token, body: {} }), 409);
    expect(await app.db.prepare('SELECT id FROM visits WHERE id=?').bind(visitId).first()).toBeTruthy();
  });

  it('keeps semantic activation unavailable for existing version 1 copies', async () => {
    await visit();
    const jobId = await start();
    await finish(jobId);
    const response = await json<{ error: { code: string } }>(await app.request(`/api/admin/archives/semantic/${jobId}/start`, { token: app.token, body: {} }), 503);
    expect(response.error.code).toBe('ARCHIVE_V2_DISABLED');
    expect(await app.db.prepare('SELECT count(*) AS n FROM archive_semantic_sessions WHERE root_archive_id=?').bind(jobId).first<number>('n')).toBe(0);
  });

  it('excludes open and held visits and rejects recent months', async () => {
    const held = await visit();
    const open = await visit('2025-01-11T18:00:00.000Z', null);
    const eligible = await visit();
    await json(await app.request('/api/admin/archives/holds', { token: app.token, body: { visitId: held.visitId, reason: 'Keep this incident available for review' } }), 201);
    const jobId = await start();
    const members = await app.db.prepare("SELECT record_key FROM archive_members WHERE job_id=? AND table_name='visits'").bind(jobId).all();
    expect(members.results).toEqual([{ record_key: eligible.visitId }]);
    expect(members.results).not.toContainEqual({ record_key: open.visitId });
    await json(await app.request('/api/admin/archives/start', { token: app.token, body: { month: new Date().toISOString().slice(0, 7) } }), 409);
  });

  it('blocks corrections to selected source rows until cancellation, without blocking current attendance', async () => {
    const { visitId } = await visit();
    const jobId = await start();
    const correction = { correctionId: crypto.randomUUID(), expectedVersion: 2, checkInAt: '2025-01-10T18:05:00.000Z', checkOutAt: '2025-01-10T19:00:00.000Z', reason: 'Corrected from the original paper note' };
    const denied = await json<{ error: { code: string } }>(await app.request(`/api/admin/visits/${visitId}/corrections`, { token: app.token, body: correction }), 409);
    expect(denied.error.code).toBe('ARCHIVE_SOURCE_BUSY');
    const current = await createStudent(app);
    await json(await app.request('/api/admin/attendance', { token: app.token, body: { eventId: crypto.randomUUID(), studentId: current.student.id, action: 'check_in', observedAt: new Date().toISOString() } }), 201);
    await json(await app.request(`/api/admin/archives/${jobId}/cancel`, { token: app.token, body: {} }));
    await json(await app.request(`/api/admin/visits/${visitId}/corrections`, { token: app.token, body: correction }), 201);
  });

  it('expires abandoned source freezes and refuses to publish changed source records', async () => {
    const { visitId } = await visit();
    const jobId = await start();
    await app.db.prepare("UPDATE archive_jobs SET source_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(jobId).run();
    await app.db.prepare('UPDATE visits SET version=version+1 WHERE id=?').bind(visitId).run();
    const result = await json<{ status: string }>(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
    expect(result.status).toBe('failed');
    expect(await app.db.prepare('SELECT completed_at,error_code FROM archive_jobs WHERE id=?').bind(jobId).first()).toEqual({ completed_at: null, error_code: 'ARCHIVE_SOURCE_EXPIRED' });
  });

  it('fails verification when a stored part is altered and leaves all source records intact', async () => {
    await visit();
    const jobId = await start();
    for (let i = 0; i < 30; i++) {
      const result = await json<{ status: string }>(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
      if (result.status === 'verify') break;
    }
    const part = await app.db.prepare('SELECT descriptor_json FROM archive_parts WHERE job_id=? AND part_index=0').bind(jobId).first<{ descriptor_json: string }>();
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    await bucket.put(JSON.parse(part!.descriptor_json).objectKey, new Uint8Array([1, 2, 3]));
    for (let i = 0; i < 5; i++) await json(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
    expect(await app.db.prepare('SELECT status,completed_at FROM archive_jobs WHERE id=?').bind(jobId).first()).toEqual({ status: 'failed', completed_at: null });
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events').first()).toEqual({ n: 2 });
    await json(await app.request(`/api/admin/archives/${jobId}/manifest`, { token: app.token }), 404);
  });

  it('adding a hold cancels an in-progress archive and records a release reason', async () => {
    const selected = await visit();
    const jobId = await start();
    const hold = await json<{ holdId: string }>(await app.request('/api/admin/archives/holds', { token: app.token, body: { studentId: selected.detail.student.id, reason: 'Investigation still open for this student' } }), 201);
    expect(await app.db.prepare('SELECT status FROM archive_jobs WHERE id=?').bind(jobId).first()).toEqual({ status: 'cancelled' });
    await json(await app.request(`/api/admin/archives/holds/${hold.holdId}/release`, { token: app.token, body: { reason: 'Review completed and approved by the owner' } }));
    expect((await app.db.prepare('SELECT released_at,release_reason FROM archive_holds WHERE id=?').bind(hold.holdId).first())!.release_reason).toBe('Review completed and approved by the owner');
  });

  it('requires configured storage and an owner to start an archive', async () => {
    const staffId = crypto.randomUUID(), at = new Date().toISOString();
    await app.db.prepare("INSERT INTO staff(id,center_id,email,display_name,role,created_at,updated_at) VALUES(?,'test-center','desk@example.test','Desk','front_desk',?,?)").bind(staffId, at, at).run();
    const token = await app.signer.token({ email: 'desk@example.test', sub: 'desk' });
    await json(await app.request('/api/admin/archives/start', { token, body: { month: '2025-01' } }), 403);
    await json(await app.request('/api/admin/archives', { token }), 403);
    await json(await app.request('/api/admin/archives/start', { body: { month: '2025-01' } }), 401);
  });

  it('preserves direct legacy visit identities and additional audit actors without inventing observations', async () => {
    const detail = await createStudent(app), visitId = crypto.randomUUID(), visitStaff = crypto.randomUUID(), auditStaff = crypto.randomUUID(), at = '2025-01-10T18:00:00.000Z';
    for (const [staffId, name] of [[visitStaff, 'Legacy instructor'], [auditStaff, 'Later reviewer']]) {
      await app.db.prepare("INSERT INTO staff(id,center_id,email,display_name,role,created_at,updated_at) VALUES(?,'test-center',?,?,'instructor',?,?)").bind(staffId, `${staffId}@example.test`, name, at, at).run();
    }
    const guardian = detail.guardians.find(g => g.pickupAuthority === 'allowed')!;
    await app.db.prepare('DELETE FROM student_guardians WHERE student_id=? AND guardian_id=?').bind(detail.student.id, guardian.id).run();
    await app.db.prepare(`INSERT INTO visits(id,center_id,student_id,check_in_at,check_out_at,original_check_in_at,original_check_out_at,check_in_by,check_out_by,guardian_id,version)
      VALUES(?,'test-center',?,?,'2025-01-10T19:00:00.000Z',?,'2025-01-10T19:00:00.000Z',?,?,?,2)`).bind(visitId, detail.student.id, at, at, visitStaff, visitStaff, guardian.id).run();
    const auditId = crypto.randomUUID();
    await app.db.prepare("INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,'test-center',?,'Later reviewer','legacy_review','visit',?,'{}',?)").bind(auditId, auditStaff, visitId, at).run();
    const jobId = await start(); await finish(jobId); const records = await archivedRecords(jobId);
    expect(records.filter(r => r.table === 'attendance_events')).toEqual([]);
    expect(records.find(r => r.table === 'students' && r.key === detail.student.id)).toBeTruthy();
    expect(records.find(r => r.table === 'guardians' && r.key === guardian.id)).toBeTruthy();
    expect(records.filter(r => r.table === 'staff').map(r => r.key).sort()).toEqual([visitStaff, auditStaff].sort());
    expect(records.find(r => r.table === 'audit_entries' && r.key === auditId)).toBeTruthy();
  });

  it('keeps unmatched exceptional departures and their resolved review evidence', async () => {
    const detail = await createStudent(app), eventId = crypto.randomUUID(), at = '2025-01-10T18:00:00.000Z';
    await app.db.prepare(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,reason,payload_hash,insertion_nonce)
      VALUES(?,'test-center',?,NULL,'exceptional_departure',?,?,?,?,'admin','Arrival recorded on paper',?,?)`).bind(eventId, detail.student.id, at, at, app.actor.id, app.actor.displayName, createHash('sha256').update(eventId).digest('base64'), eventId).run();
    await app.db.prepare("UPDATE reviews SET status='resolved',resolved_at=?,resolved_by=?,resolution='Paper register reviewed' WHERE event_id=?").bind(at, app.actor.id, eventId).run();
    const jobId = await start(); await finish(jobId); const records = await archivedRecords(jobId);
    expect(records.filter(r => r.table === 'visits')).toEqual([]);
    expect(records.find(r => r.table === 'attendance_events')?.row).toMatchObject({ id: eventId, visit_id: null, result_visit: 'null', reason: 'Arrival recorded on paper' });
    expect(records.find(r => r.table === 'reviews')?.row).toMatchObject({ event_id: eventId, resolution: 'Paper register reviewed', resolved_by: app.actor.id });
  });

  it('archives by the original local arrival month and retains later cross-month corrections', async () => {
    const { visitId } = await visit('2025-02-01T07:30:00.000Z', '2025-02-01T08:30:00.000Z');
    const correctionId = crypto.randomUUID();
    await json(await app.request(`/api/admin/visits/${visitId}/corrections`, { token: app.token, body: { correctionId, expectedVersion: 2, checkInAt: '2025-02-01T08:05:00.000Z', checkOutAt: '2025-02-01T08:45:00.000Z', reason: 'Clock and paper register reconciled' } }), 201);
    const jobId = await start(); await finish(jobId); const records = await archivedRecords(jobId);
    expect(records.find(r => r.table === 'visits')?.row).toMatchObject({ original_check_in_at: '2025-02-01T07:30:00.000Z', check_in_at: '2025-02-01T08:05:00.000Z', original_check_out_at: '2025-02-01T08:30:00.000Z', check_out_at: '2025-02-01T08:45:00.000Z' });
    expect(records.find(r => r.table === 'attendance_corrections')?.row).toMatchObject({ id: correctionId, prior_check_in_at: '2025-02-01T07:30:00.000Z', prior_check_out_at: '2025-02-01T08:30:00.000Z', reason: 'Clock and paper register reconciled' });
    expect(records.filter(r => r.table === 'audit_entries')).toHaveLength(3);
  });

  it('respects a running lease and rolls a failed cursor transaction back before a fresh encrypted retry', async () => {
    await visit(); const jobId = await start();
    await app.db.prepare('UPDATE archive_jobs SET lease_token=?,lease_until=? WHERE id=?').bind('another-worker', new Date(Date.now() + 60_000).toISOString(), jobId).run();
    const waiting = await json<{ status: string; delay: number }>(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
    expect(waiting).toMatchObject({ status: 'parts', delay: 10 });
    expect(await app.db.prepare('SELECT count(*) AS n FROM archive_parts WHERE job_id=?').bind(jobId).first()).toEqual({ n: 0 });
    await app.db.prepare('UPDATE archive_jobs SET lease_until=NULL WHERE id=?').bind(jobId).run();
    await app.db.prepare("CREATE TRIGGER archive_test_cursor_failure BEFORE UPDATE ON archive_jobs WHEN NEW.next_part>OLD.next_part BEGIN SELECT RAISE(ABORT,'TEST_TRANSIENT_FAILURE'); END").run();
    await json(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
    expect(await app.db.prepare('SELECT next_part,attempts FROM archive_jobs WHERE id=?').bind(jobId).first()).toEqual({ next_part: 0, attempts: 1 });
    expect(await app.db.prepare('SELECT count(*) AS n FROM archive_parts WHERE job_id=?').bind(jobId).first()).toEqual({ n: 0 });
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    const before = await bucket.list({ prefix: `archives/test-center/2025-01/${jobId}/` }); expect(before.objects).toHaveLength(1);
    await app.db.prepare('DROP TRIGGER archive_test_cursor_failure').run();
    await json(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
    const after = await bucket.list({ prefix: `archives/test-center/2025-01/${jobId}/` }); expect(after.objects).toHaveLength(2);
    expect(new Set(after.objects.map(object => object.key)).size).toBe(2);
    expect(await app.db.prepare('SELECT next_part,attempts FROM archive_jobs WHERE id=?').bind(jobId).first()).toEqual({ next_part: 1, attempts: 0 });
    await finish(jobId);
  });

  it('waits through the native backup write lock without advancing or exhausting archive retries', async () => {
    await visit(); const jobId = await start();
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=? WHERE id=1').bind(new Date(Date.now() + 60_000).toISOString()).run();
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await json(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
      expect(result).toMatchObject({ status: 'parts', delay: 10 });
    }
    expect(await app.db.prepare('SELECT next_part,attempts,lease_token FROM archive_jobs WHERE id=?').bind(jobId).first()).toEqual({ next_part: 0, attempts: 0, lease_token: null });
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    await finish(jobId);
  });

  it('checks the source freeze at database execution time before final publication', async () => {
    const { visitId } = await visit(); const jobId = await start();
    for (let i = 0; i < 60; i++) {
      const row = await app.db.prepare('SELECT status,next_part,verify_part FROM archive_jobs WHERE id=?').bind(jobId).first<{ status: string; next_part: number; verify_part: number }>();
      if (row!.status === 'verify' && row!.verify_part === row!.next_part) break;
      await json(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
    }
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    let delayedPublication = false;
    const env = {
      APP_ENV: 'local', ARCHIVE_ENABLED: 'true', BACKUP_KEY: key, BACKUP_BUCKET: bucket,
      CRM_DB: {
        prepare(sql: string) {
          const statement = app.db.prepare(sql);
          if (!sql.startsWith("UPDATE archive_jobs SET status='complete'")) return statement;
          return { bind: (...values: unknown[]) => ({ async run() {
            delayedPublication = true;
            // Simulate a request waiting in transit while its short freeze ends.
            await app.db.prepare('UPDATE archive_jobs SET source_expires_at=? WHERE id=?').bind(new Date(Date.now() + 100).toISOString(), jobId).run();
            await delay(150);
            await app.db.prepare('UPDATE visits SET version=version+1 WHERE id=?').bind(visitId).run();
            return statement.bind(...values).run();
          } }) };
        },
      },
    } as unknown as Env;
    await advanceArchive(env, jobId); expect(delayedPublication).toBe(true);
    expect(await app.db.prepare('SELECT status,completed_at FROM archive_jobs WHERE id=?').bind(jobId).first()).toEqual({ status: 'verify', completed_at: null });
    await app.db.prepare("UPDATE archive_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").bind(jobId).run();
    const result = await json(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
    expect(result).toMatchObject({ status: 'failed' });
    await json(await app.request(`/api/admin/archives/${jobId}/manifest`, { token: app.token }), 404);
  });
});
