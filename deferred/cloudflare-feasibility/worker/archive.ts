import { Hono } from 'hono';
import type { AppEnv, Env } from './types';
import { ARCHIVE_FORMAT, ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, ARCHIVE_TABLES, type ArchivePartDescriptor, type ArchiveRecord, type ArchiveManifest, type ArchiveSemanticProof } from '../shared/archive-format';
import { calendarMonthBounds, sealArchivePart, sealArchiveManifest, openArchiveManifest, verifyArchivePart } from './archive-codec';
import { digest } from './backup-crypto';
import { maintainCorrectionAddenda } from './archive-correction-addendum';
import { advanceRetentionDryRun, maintainRetentionDryRuns, startRetentionDryRun } from './history-retention';
import { evictRetentionSource, scheduleRetentionEvidenceExpiry } from './history-source-eviction';
import { advanceR2OrphanInventory, getR2OrphanInventoryStatus, maintainR2OrphanInventory, startR2OrphanInventory } from './r2-orphan-inventory';
import { assertArchiveSourceAvailable, jobMetadata, snapshotStatements, sourcePage, type ArchiveJob } from './archive-source';
import { ApiProblem, audit, body, centerId, id, managementRoles, now, requireRole, textValue } from './util';
import { semanticArchiveRouter } from './archive-activation-routes';

type ArchiveMessage = { type: 'archive'; jobId: string };
const encoder = new TextEncoder();
const sourceLifetime = 2 * 3600_000;

function configured(env: Env) {
  if (env.ARCHIVE_ENABLED !== 'true') throw new ApiProblem(503, 'ARCHIVE_DISABLED', 'Historical archiving has not been enabled for this installation.');
  if (!env.BACKUP_BUCKET || typeof env.BACKUP_KEY !== 'string' || !env.BACKUP_KEY) throw new ApiProblem(503, 'ARCHIVE_NOT_CONFIGURED', 'Configure private R2 storage and its recovery key first.');
  if (!env.BACKUP_QUEUE && env.APP_ENV !== 'local') throw new ApiProblem(503, 'ARCHIVE_QUEUE_REQUIRED', 'Configure the archive processing queue first.');
}

async function enqueue(env: Env, jobId: string, delaySeconds = 0) {
  const queue = env.BACKUP_QUEUE as Queue<ArchiveMessage> | undefined;
  if (queue) await queue.send({ type: 'archive', jobId }, { delaySeconds });
}

export async function startArchive(env: Env, center: string, actorId: string, month: string): Promise<string> {
  configured(env);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiProblem(400, 'INVALID_MONTH', 'Use a calendar month in YYYY-MM format between 2000 and 2099.');
  const centerRow = await env.CRM_DB.prepare('SELECT timezone FROM centers WHERE id=?').bind(center).first<{ timezone: string }>();
  if (!centerRow) throw new ApiProblem(404, 'CENTER_NOT_FOUND', 'Center was not found.');
  const bounds = calendarMonthBounds(month, centerRow.timezone);
  const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
  if (bounds.periodTo > cutoff) throw new ApiProblem(409, 'ARCHIVE_TOO_RECENT', 'Only complete calendar months older than 90 days can be archived.');
  await assertArchiveSourceAvailable(env, center);
  const prior = await env.CRM_DB.prepare("SELECT id FROM archive_jobs WHERE center_id=? AND month=? AND status='complete'").bind(center, month).first();
  if (prior) throw new ApiProblem(409, 'ARCHIVE_MONTH_EXISTS', 'This month already has a verified archive. Changes need an archive addendum.');
  const versions = await env.CRM_DB.prepare('SELECT version FROM schema_versions ORDER BY version').all<{ version: number }>();
  const at = now();
  const formatVersion = env.ARCHIVE_V2_ENABLED === 'true' ? 2 : 1;
  const semanticProof: ArchiveSemanticProof = { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] };
  const job: ArchiveJob = { id: id(), center_id: center, month, timezone: centerRow.timezone,
    period_from: bounds.periodFrom, period_to: bounds.periodTo, cutoff, created_at: at, updated_at: at,
    created_by: actorId, schema_json: JSON.stringify(versions.results.map(r => r.version)), application_version: env.APP_VERSION || 'unknown',
    status: 'parts', source_expires_at: new Date(Date.now() + sourceLifetime).toISOString(), next_part: 0, cursor_table: 0,
    cursor_key: '', verify_part: 0, manifest_key: null, manifest_sha256: null, manifest_json: null, completed_at: null,
    error_code: null, lease_token: null, lease_until: null, attempts: 0,
    format_version: formatVersion, semantic_proof_json: formatVersion === 2 ? JSON.stringify(semanticProof) : null };
  await env.CRM_DB.batch([
    env.CRM_DB.prepare(`INSERT INTO archive_jobs(id,center_id,month,timezone,period_from,period_to,cutoff,created_at,updated_at,created_by,schema_json,application_version,status,source_expires_at,format_version,semantic_proof_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'parts',?,?,?)`).bind(job.id, center, month, job.timezone, job.period_from, job.period_to, cutoff, at, at, actorId, job.schema_json, job.application_version, job.source_expires_at, job.format_version, job.semantic_proof_json),
    ...snapshotStatements(env, job),
  ]);
  const count = await env.CRM_DB.prepare("SELECT count(*) AS n FROM archive_members WHERE job_id=? AND table_name IN ('visits','attendance_events')").bind(job.id).first<{ n: number }>();
  if (!count?.n) {
    await env.CRM_DB.prepare("UPDATE archive_jobs SET status='cancelled',error_code='ARCHIVE_EMPTY' WHERE id=?").bind(job.id).run();
    throw new ApiProblem(409, 'ARCHIVE_EMPTY', 'No eligible attendance records exist in this month. Open visits, pending reviews and held records stay live.');
  }
  // The durable job remains recoverable by the scheduler if delivery fails.
  await enqueue(env, job.id);
  return job.id;
}

async function readObject(env: Env, key: string, maximum: number): Promise<Uint8Array> {
  const object = await env.BACKUP_BUCKET!.get(key);
  if (!object) throw new Error('ARCHIVE_OBJECT_MISSING');
  if (object.size > maximum) { await object.body.cancel(); throw new Error('ARCHIVE_OBJECT_TOO_LARGE'); }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size || bytes.length > maximum) throw new Error('ARCHIVE_OBJECT_SIZE');
  return bytes;
}

async function putVerified(env: Env, key: string, encrypted: Uint8Array, hash: string) {
  await env.BACKUP_BUCKET!.put(key, encrypted, { onlyIf: new Headers({ 'If-None-Match': '*' }),
    sha256: hash, httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' } });
  const actual = await readObject(env, key, encrypted.length);
  if (actual.length !== encrypted.length || await digest(actual) !== hash) throw new Error('ARCHIVE_READBACK_MISMATCH');
}

function owned(env: Env, job: ArchiveJob, sql: string, values: unknown[]) {
  // Use database execution time, matching the source-freeze triggers. A timestamp
  // captured before an awaited write can otherwise authorize publication after
  // that freeze has expired and another transaction has changed the source.
  return env.CRM_DB.prepare(sql + " AND EXISTS(SELECT 1 FROM archive_jobs owner WHERE owner.id=? AND owner.lease_token=? AND owner.status IN ('parts','verify') AND owner.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .bind(...values, job.id, job.lease_token);
}

async function saveJob(env: Env, job: ArchiveJob, sets: string, values: unknown[]) {
  const result = await owned(env, job, `UPDATE archive_jobs SET ${sets},updated_at=? WHERE id=?`, [...values, now(), job.id]).run();
  if (result.meta.changes !== 1) throw new Error('ARCHIVE_LEASE_LOST');
}

async function nextPart(env: Env, job: ArchiveJob) {
  let tableIndex = job.cursor_table;
  let after = job.cursor_key;
  let records: ArchiveRecord[] = [];
  while (tableIndex < ARCHIVE_TABLES.length) {
    const candidates = await sourcePage(env, job, tableIndex, after);
    let bytes = 0;
    for (const record of candidates) {
      const size = encoder.encode(JSON.stringify(record) + '\n').length;
      if (size > ARCHIVE_LIMITS.recordBytes) throw new Error('ARCHIVE_RECORD_TOO_LARGE');
      if (bytes + size > ARCHIVE_LIMITS.plaintextPartBytes) break;
      records.push(record); bytes += size;
    }
    if (records.length) break;
    tableIndex++; after = '';
  }
  if (!records.length) {
    const rows = await env.CRM_DB.prepare('SELECT descriptor_json FROM archive_parts WHERE job_id=? ORDER BY part_index').bind(job.id).all<{ descriptor_json: string }>();
    if (rows.results.length !== job.next_part) throw new Error('ARCHIVE_PARTS_INCOMPLETE');
    const sealed = await sealArchiveManifest(String(env.BACKUP_KEY), jobMetadata(job), rows.results.map(r => JSON.parse(r.descriptor_json) as ArchivePartDescriptor));
    await putVerified(env, sealed.objectKey, sealed.encrypted, sealed.sha256);
    await saveJob(env, job, "status='verify',manifest_key=?,manifest_sha256=?,manifest_json=?", [sealed.objectKey, sealed.sha256, JSON.stringify(sealed.manifest)]);
    return;
  }
  if (job.next_part >= ARCHIVE_LIMITS.parts) throw new Error('ARCHIVE_TOO_MANY_PARTS');
  const sealed = await sealArchivePart(String(env.BACKUP_KEY), jobMetadata(job), job.next_part, records);
  await putVerified(env, sealed.descriptor.objectKey, sealed.encrypted, sealed.descriptor.encryptedSha256);
  const hashes = await Promise.all(records.map(async r => ({ key: r.key, hash: await digest(encoder.encode(JSON.stringify(r))) })));
  const results = await env.CRM_DB.batch([
    owned(env, job, `INSERT INTO archive_parts(job_id,part_index,descriptor_json) SELECT ?,?,? WHERE 1=1`, [job.id, job.next_part, JSON.stringify(sealed.descriptor)]),
    owned(env, job, `UPDATE archive_members SET part_index=?,content_sha256=(SELECT json_extract(value,'$.hash') FROM json_each(?) WHERE json_extract(value,'$.key')=record_key)
      WHERE job_id=? AND table_name=? AND record_key IN (SELECT json_extract(value,'$.key') FROM json_each(?))`, [job.next_part, JSON.stringify(hashes), job.id, ARCHIVE_TABLES[tableIndex], JSON.stringify(hashes)]),
    owned(env, job, 'UPDATE archive_jobs SET cursor_table=?,cursor_key=?,next_part=next_part+1,updated_at=? WHERE id=?', [tableIndex, records.at(-1)!.key, now(), job.id]),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== records.length || results[2].meta.changes !== 1) throw new Error('ARCHIVE_LEASE_LOST');
}

async function manifestForJob(env: Env, job: ArchiveJob): Promise<ArchiveManifest> {
  if (!job.manifest_key || !job.manifest_sha256) throw new Error('ARCHIVE_MANIFEST_MISSING');
  const bytes = await readObject(env, job.manifest_key, ARCHIVE_LIMITS.encryptedManifestBytes);
  if (await digest(bytes) !== job.manifest_sha256) throw new Error('ARCHIVE_MANIFEST_MISMATCH');
  const manifest = await openArchiveManifest(String(env.BACKUP_KEY), bytes, { archiveId: job.id, kind: 'monthly', manifestObjectKey: job.manifest_key, manifestSha256: job.manifest_sha256 });
  if (job.format_version !== 2 && manifest.format === ARCHIVE_FORMAT_V2) {
    throw new ApiProblem(503, 'ARCHIVE_V2_NOT_ENABLED', 'This historical format is not enabled for this job.');
  }
  const expectedFormat = job.format_version === 2 ? ARCHIVE_FORMAT_V2 : ARCHIVE_FORMAT;
  if (manifest.format !== expectedFormat) throw new Error('ARCHIVE_JOB_FORMAT_MISMATCH');
  if (manifest.archiveId !== job.id || manifest.centerId !== job.center_id || manifest.month !== job.month || manifest.timezone !== job.timezone || manifest.createdAt !== job.created_at || manifest.periodFrom !== job.period_from || manifest.periodTo !== job.period_to || manifest.parts.length !== job.next_part) throw new Error('ARCHIVE_MANIFEST_SCOPE');
  return manifest;
}

async function verifyStep(env: Env, job: ArchiveJob) {
  const manifest = await manifestForJob(env, job);
  const descriptor = manifest.parts[job.verify_part];
  if (descriptor) {
    const bytes = await readObject(env, descriptor.objectKey, ARCHIVE_LIMITS.encryptedPartBytes);
    const records = await verifyArchivePart(String(env.BACKUP_KEY), manifest, descriptor, bytes);
    const members = await env.CRM_DB.prepare('SELECT table_name,record_key,content_sha256 FROM archive_members WHERE job_id=? AND part_index=?').bind(job.id, descriptor.index)
      .all<{ table_name: string; record_key: string; content_sha256: string }>();
    const expected = new Map(members.results.map(r => [JSON.stringify([r.table_name, r.record_key]), r.content_sha256]));
    if (records.length !== expected.size) throw new Error('ARCHIVE_RECORDS_MISMATCH');
    for (const record of records) if (await digest(encoder.encode(JSON.stringify(record))) !== expected.get(JSON.stringify([record.table, record.key]))) throw new Error('ARCHIVE_RECORDS_MISMATCH');
    const result = await env.CRM_DB.batch([
      owned(env, job, 'UPDATE archive_parts SET verified_at=? WHERE job_id=? AND part_index=?', [now(), job.id, descriptor.index]),
      owned(env, job, 'UPDATE archive_jobs SET verify_part=verify_part+1,updated_at=? WHERE id=?', [now(), job.id]),
    ]);
    if (result.some(r => r.meta.changes !== 1)) throw new Error('ARCHIVE_LEASE_LOST');
    return;
  }
  const unverified = await env.CRM_DB.prepare('SELECT count(*) AS n FROM archive_parts WHERE job_id=? AND verified_at IS NULL').bind(job.id).first<{ n: number }>();
  const missing = await env.CRM_DB.prepare('SELECT count(*) AS n FROM archive_members WHERE job_id=? AND (content_sha256 IS NULL OR part_index IS NULL)').bind(job.id).first<{ n: number }>();
  if (unverified?.n || missing?.n || job.verify_part !== manifest.parts.length) throw new Error('ARCHIVE_VERIFICATION_INCOMPLETE');
  // Copy-only until historical correction/replay and combined recovery gates pass.
  // No deletion bypass or purge call exists in this worker.
  await saveJob(env, job, "status='complete',completed_at=?,lease_until=NULL,error_code=NULL", [now()]);
}

export async function advanceArchive(env: Env, jobId: string): Promise<{ status: string; delay: number }> {
  configured(env);
  // A backup's write barrier is expected maintenance, not an archive failure.
  // Leave the durable cursor intact and let the queue/scheduler retry it.
  const locked = await env.CRM_DB.prepare("SELECT 1 AS locked FROM backup_runtime WHERE id=1 AND write_locked_until>?").bind(now()).first();
  if (locked) {
    const current = await env.CRM_DB.prepare('SELECT status FROM archive_jobs WHERE id=?').bind(jobId).first<{ status: string }>();
    return { status: current?.status || 'missing', delay: 10 };
  }
  const at = now();
  const token = id();
  const job = await env.CRM_DB.prepare(`UPDATE archive_jobs SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status IN ('parts','verify')
    AND (lease_until IS NULL OR lease_until<=?) RETURNING *`).bind(token, new Date(Date.now() + 60_000).toISOString(), at, jobId, at).first<ArchiveJob>();
  if (!job) {
    const row = await env.CRM_DB.prepare('SELECT status FROM archive_jobs WHERE id=?').bind(jobId).first<{ status: string }>();
    return { status: row?.status || 'missing', delay: 10 };
  }
  try {
    if (job.source_expires_at <= now()) throw new Error('ARCHIVE_SOURCE_EXPIRED');
    if (job.status === 'parts') await nextPart(env, job); else await verifyStep(env, job);
    await env.CRM_DB.prepare('UPDATE archive_jobs SET lease_until=NULL,attempts=0 WHERE id=? AND lease_token=?').bind(jobId, token).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('backup_maintenance')) return { status: job.status, delay: 10 };
    const code = error instanceof ApiProblem && /^[A-Z0-9_]+$/.test(error.code) ? error.code : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'ARCHIVE_STEP_FAILED';
    if (code === 'ARCHIVE_LEASE_LOST') return { status: job.status, delay: 10 };
    const terminal = job.attempts >= 4 || /EXPIRED|MISMATCH|TOO_LARGE|TOO_MANY|SOURCE_MISSING|MANIFEST_SCOPE|V2_NOT_ENABLED/.test(code);
    await env.CRM_DB.prepare('UPDATE archive_jobs SET status=?,error_code=?,attempts=attempts+1,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status IN (\'parts\',\'verify\')')
      .bind(terminal ? 'failed' : job.status, code, now(), jobId, token).run();
  }
  const result = await env.CRM_DB.prepare('SELECT status FROM archive_jobs WHERE id=?').bind(jobId).first<{ status: string }>();
  return { status: result?.status || 'missing', delay: 1 };
}

export async function archiveQueue(batch: MessageBatch<ArchiveMessage>, env: Env) {
  for (const message of batch.messages) {
    const result = await advanceArchive(env, message.body.jobId);
    if (['parts', 'verify'].includes(result.status)) await enqueue(env, message.body.jobId, result.delay);
    message.ack();
  }
}

export async function archiveScheduled(env: Env) {
  if (env.ARCHIVE_ENABLED !== 'true') return;
  await maintainCorrectionAddenda(env);
  await maintainRetentionDryRuns(env);
  await maintainR2OrphanInventory(env);
  if (!env.BACKUP_QUEUE) return;
  const jobs = await env.CRM_DB.prepare("SELECT id FROM archive_jobs WHERE status IN ('parts','verify') AND updated_at<? LIMIT 10").bind(new Date(Date.now() - 60_000).toISOString()).all<{ id: string }>();
  for (const job of jobs.results) await enqueue(env, job.id);
}

export const archiveRouter = new Hono<AppEnv>();
archiveRouter.use('*', async (c, next) => { requireRole(c, managementRoles); await next(); });
archiveRouter.route('/semantic', semanticArchiveRouter);
archiveRouter.get('/', async c => {
  const jobs = await c.env.CRM_DB.prepare('SELECT id,month,status,format_version,created_at,updated_at,completed_at,error_code,next_part,verify_part FROM archive_jobs WHERE center_id=? ORDER BY created_at DESC LIMIT 50').bind(centerId(c)).all();
  const holds = await c.env.CRM_DB.prepare(`SELECT h.hold_id AS id,h.student_id,h.visit_id,h.reason,h.created_at FROM history_holds h WHERE h.center_id=? AND NOT EXISTS(SELECT 1 FROM history_hold_releases r WHERE r.hold_id=h.hold_id) ORDER BY h.created_at DESC LIMIT 100`).bind(centerId(c)).all();
  return c.json({ enabled: c.env.ARCHIVE_ENABLED === 'true', mode: 'verified-copy', retentionDays: 90, jobs: jobs.results, holds: holds.results });
});
archiveRouter.post('/start', async c => {
  requireRole(c, ['owner']);
  const input = await body(c);
  const jobId = await startArchive(c.env, centerId(c), c.var.actor.id, textValue(input.month, 'month', 7));
  await audit(c, 'archive_started', 'archive', jobId).run();
  return c.json({ jobId }, 202);
});
archiveRouter.get('/retention', async c => {
  const [policy, jobs] = await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare('SELECT live_tier_days,evidence_retention_days,evidence_expiry_enabled,max_candidates,revision,updated_at FROM history_retention_policies WHERE center_id=?').bind(centerId(c)),
    c.env.CRM_DB.prepare(`SELECT j.*,p.permit_id,p.mode,p.delete_enabled,p.issued_at,
      EXISTS(SELECT 1 FROM history_retention_invalidations i WHERE i.job_id=j.job_id) AS invalidated
      FROM history_retention_jobs j LEFT JOIN history_retention_permits p ON p.job_id=j.job_id
      WHERE j.center_id=? ORDER BY j.created_at DESC LIMIT 50`).bind(centerId(c)),
  ]);
  return c.json({ policy: policy.results[0] ?? null, jobs: jobs.results, deletionEnabled: false });
});
archiveRouter.post('/retention/start', async c => {
  requireRole(c, ['owner']);
  const input = await body(c);
  const limit = input.limit === undefined ? undefined : Number(input.limit);
  const jobId = await startRetentionDryRun(c.env.CRM_DB, centerId(c), c.var.actor.id, limit);
  await audit(c, 'retention_dry_run_started', 'retention_job', jobId, { limit: limit ?? null }).run();
  return c.json({ jobId, deletionEnabled: false }, 202);
});
archiveRouter.post('/retention/:id/advance', async c => {
  requireRole(c, ['owner']);
  if (!c.env.BACKUP_BUCKET || typeof c.env.BACKUP_KEY !== 'string' || !c.env.BACKUP_KEY) {
    throw new ApiProblem(503, 'ARCHIVE_NOT_CONFIGURED', 'Configure private R2 storage and the recovery key first.');
  }
  const job = await c.env.CRM_DB.prepare('SELECT job_id FROM history_retention_jobs WHERE job_id=? AND center_id=?').bind(c.req.param('id'), centerId(c)).first<{ job_id: string }>();
  if (!job) throw new ApiProblem(404, 'RETENTION_JOB_NOT_FOUND', 'Retention dry run was not found.');
  const result = await advanceRetentionDryRun(c.env.CRM_DB, { bucket: c.env.BACKUP_BUCKET, masterKey: c.env.BACKUP_KEY }, job.job_id);
  return c.json(result);
});

archiveRouter.post('/retention/:id/schedule-expiry', async c => {
  requireRole(c, ['owner']);
  const jobId = c.req.param('id');
  const job = await c.env.CRM_DB.prepare('SELECT job_id FROM history_retention_jobs WHERE job_id=? AND center_id=?')
    .bind(jobId, centerId(c)).first<{ job_id: string }>();
  if (!job) throw new ApiProblem(404, 'RETENTION_JOB_NOT_FOUND', 'Retention dry run was not found.');
  try {
    return c.json(await scheduleRetentionEvidenceExpiry(c.env.CRM_DB, jobId, c.var.actor.id), 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'EVIDENCE_EXPIRY_DISABLED') {
      throw new ApiProblem(409, error.message, 'Evidence expiry is disabled for this center.');
    }
    throw error;
  }
});

archiveRouter.post('/retention/:id/evict/:visitId', async c => {
  requireRole(c, ['owner']);
  if (!c.env.BACKUP_BUCKET || typeof c.env.BACKUP_KEY !== 'string' || !c.env.BACKUP_KEY) {
    throw new ApiProblem(503, 'ARCHIVE_NOT_CONFIGURED', 'Configure private R2 storage and the recovery key first.');
  }
  const jobId = c.req.param('id');
  const visitId = c.req.param('visitId');
  const item = await c.env.CRM_DB.prepare(`SELECT i.visit_id FROM history_retention_items i
    JOIN history_retention_jobs j ON j.job_id=i.job_id
    WHERE i.job_id=? AND i.visit_id=? AND j.center_id=?`).bind(jobId, visitId, centerId(c)).first();
  if (!item) throw new ApiProblem(404, 'SOURCE_EVICTION_ITEM_MISSING', 'Retention candidate was not found.');
  try {
    return c.json(await evictRetentionSource(c.env.CRM_DB, {
      bucket: c.env.BACKUP_BUCKET as Parameters<typeof evictRetentionSource>[1]['bucket'],
      masterKey: c.env.BACKUP_KEY,
    }, jobId, visitId, c.var.actor.id));
  } catch (error) {
    if (error instanceof Error && error.message === 'SOURCE_EVICTION_DISABLED') {
      throw new ApiProblem(409, error.message, 'Source eviction is disabled for this center.');
    }
    throw error;
  }
});

archiveRouter.get('/orphan-inventory', async c => c.json(await getR2OrphanInventoryStatus(c.env)));

archiveRouter.post('/orphan-inventory/start', async c => {
  requireRole(c, ['owner']);
  const id = await startR2OrphanInventory(c.env);
  await audit(c, 'r2_orphan_inventory_requested', 'r2_orphan_inventory', id).run();
  const status = await advanceR2OrphanInventory(c.env, id);
  return c.json({ id, status, deleteEnabled: false }, 202);
});

archiveRouter.post('/orphan-inventory/:id/advance', async c => {
  requireRole(c, ['owner']);
  const id = c.req.param('id');
  const status = await advanceR2OrphanInventory(c.env, id);
  if (status === null) return c.json({ error: 'Inventory run not found.' }, 404);
  return c.json({ id, status, deleteEnabled: false });
});
archiveRouter.post('/:id/cancel', async c => {
  requireRole(c, ['owner']);
  await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare("UPDATE archive_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND center_id=? AND status IN ('parts','verify')").bind(now(), c.req.param('id'), centerId(c)),
    audit(c, 'archive_cancelled', 'archive', c.req.param('id')),
  ]);
  return c.json({ ok: true });
});
archiveRouter.post('/:id/advance', async c => {
  requireRole(c, ['owner']);
  if (c.env.APP_ENV !== 'local') throw new ApiProblem(404, 'NOT_FOUND', 'Use the processing queue for this installation.');
  const job = await c.env.CRM_DB.prepare('SELECT id FROM archive_jobs WHERE id=? AND center_id=?').bind(c.req.param('id'), centerId(c)).first();
  if (!job) throw new ApiProblem(404, 'ARCHIVE_NOT_FOUND', 'Archive was not found.');
  return c.json(await advanceArchive(c.env, String(job.id)));
});
archiveRouter.get('/:id/manifest', async c => {
  const job = await c.env.CRM_DB.prepare("SELECT * FROM archive_jobs WHERE id=? AND center_id=? AND status='complete'").bind(c.req.param('id'), centerId(c)).first<ArchiveJob>();
  if (!job) throw new ApiProblem(404, 'ARCHIVE_NOT_FOUND', 'A verified archive was not found.');
  const manifest = await manifestForJob(c.env, job);
  await audit(c, 'archive_manifest_viewed', 'archive', job.id).run();
  return c.json({ manifest });
});
archiveRouter.post('/holds', async c => {
  const input = await body(c);
  const studentId = input.studentId ? textValue(input.studentId, 'studentId', 100) : null;
  const visitId = input.visitId ? textValue(input.visitId, 'visitId', 100) : null;
  const reason = textValue(input.reason, 'reason', 2000);
  if ((!studentId && !visitId) || reason.length < 5) throw new ApiProblem(400, 'HOLD_INPUT_REQUIRED', 'Choose a student or visit and give a preservation reason.');
  const target = visitId
    ? await c.env.CRM_DB.prepare('SELECT student_id,version,original_check_in_at FROM history_visit_heads WHERE visit_id=? AND center_id=?').bind(visitId, centerId(c)).first<{ student_id: string; version: number; original_check_in_at: string }>()
    : await c.env.CRM_DB.prepare('SELECT id AS student_id,NULL AS version,NULL AS original_check_in_at FROM students WHERE id=? AND center_id=?').bind(studentId, centerId(c)).first<{ student_id: string; version: null; original_check_in_at: null }>();
  if (!target || (studentId && target.student_id !== studentId)) throw new ApiProblem(404, 'HOLD_TARGET_NOT_FOUND', 'The hold target was not found in this center.');
  const holdId = id();
  await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare(`INSERT INTO history_holds(
      hold_id,center_id,target_kind,student_id,visit_id,target_head_version,
      target_original_check_in_at,reason,created_at,created_by,source_schema
    ) VALUES(?,?,?,?,?,?,?,?,?,?,2)`).bind(
      holdId, centerId(c), visitId ? 'visit' : 'student', target.student_id, visitId,
      target.version, target.original_check_in_at, reason, now(), c.var.actor.id,
    ),
    audit(c, 'archive_hold_added', 'archive_hold', holdId, { studentId: target.student_id, visitId, reason }),
  ]);
  return c.json({ holdId }, 201);
});
archiveRouter.post('/holds/:id/release', async c => {
  requireRole(c, ['owner']);
  const reason = textValue((await body(c)).reason, 'reason', 2000);
  if (reason.length < 5) throw new ApiProblem(400, 'REASON_REQUIRED', 'Explain why this hold can be released.');
  const result = await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare(`INSERT INTO history_hold_releases(hold_id,released_at,released_by,release_reason)
      SELECT h.hold_id,?,?,? FROM history_holds h
      WHERE h.hold_id=? AND h.center_id=?
        AND NOT EXISTS(SELECT 1 FROM history_hold_releases r WHERE r.hold_id=h.hold_id)`)
      .bind(now(), c.var.actor.id, reason, c.req.param('id'), centerId(c)),
    audit(c, 'archive_hold_released', 'archive_hold', c.req.param('id'), { reason }),
  ]);
  return c.json({ released: result[0].meta.changes === 1 });
});
