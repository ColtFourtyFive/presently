import { Hono } from 'hono';
import type { AppEnv, BackupMessage, Env } from './types';
import type { BackupJob, BackupStatus } from '../shared/types';
import { digest, MANIFEST_FORMAT, newHeader, partFileName, sealPart, type BackupHeader, type BackupManifest } from './backup-crypto';
import { getBusiness } from './admin';
import { ApiProblem, audit, localParts, now, requireRole, type Row } from './util';

/**
 * Nightly encrypted backup of the whole D1 database to the customer's private R2 bucket.
 *
 * 1. `export`: ask the D1 export API for a SQL dump (needs an API token limited to D1 edit).
 * 2. `parts`: copy the dump in 512 KiB ranges, encrypt each range, write it create-only to R2 and read it back.
 * 3. `manifest`: write the encrypted manifest that lists every part and its hashes.
 *
 * Each queue message runs one step so every invocation stays small. D1 blocks
 * queries while an export runs, so the backup is scheduled at night in the
 * business's own time zone.
 */
const PART_BYTES = 512 * 1024;
const MAX_SQL_BYTES = 2 * 1024 * 1024 * 1024;
const LEASE_MS = 5 * 60000;
const MAX_ATTEMPTS = 5;
const STALE_HOURS = 26;
const prefix = (id: string) => `backups/${id}/`;

type Job = {
  id: string; status: BackupJob['status']; reason: BackupJob['reason']; created_at: string; completed_at: string | null;
  bookmark: string | null; signed_url: string | null; sql_bytes: number | null; offset_bytes: number; next_part: number;
  lease_token: string | null; attempts: number; error_code: string | null;
};

export function backupMissing(env: Env) {
  const missing = (['BACKUP_KEY', 'CF_ACCOUNT_ID', 'CF_DATABASE_ID', 'CF_D1_EXPORT_TOKEN'] as const).filter(key => !env[key]);
  if (!env.BACKUP_BUCKET) missing.push('BACKUP_BUCKET' as never);
  if (!env.BACKUP_QUEUE) missing.push('BACKUP_QUEUE' as never);
  return missing as string[];
}
const enabled = (env: Env) => env.BACKUP_ENABLED === 'true';

async function readBounded(response: Response, maximum: number) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new Error('REMOTE_BODY_TOO_LARGE'); }
    chunks.push(item.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function startBackup(env: Env, reason: 'scheduled' | 'manual') {
  const missing = backupMissing(env);
  if (missing.length) throw new ApiProblem(503, 'BACKUP_NOT_CONFIGURED', `Backups need: ${missing.join(', ')}.`);
  const active = await env.CRM_DB.prepare("SELECT id FROM backup_jobs WHERE status NOT IN ('complete', 'failed') ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
  if (active) return active.id;
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const at = now();
  await env.CRM_DB.prepare("INSERT INTO backup_jobs (id, status, reason, created_at, updated_at) VALUES (?, 'export', ?, ?, ?)").bind(id, reason, at, at).run();
  await env.BACKUP_QUEUE!.send({ jobId: id });
  return id;
}

async function jobUpdate(env: Env, job: Job, sql: string, values: (string | number | null)[]) {
  const result = await env.CRM_DB.prepare(`${sql}, updated_at = ? WHERE id = ? AND lease_token = ?`).bind(...values, now(), job.id, job.lease_token).run();
  if (result.meta.changes !== 1) throw new Error('BACKUP_LEASE_LOST');
}

async function exportStep(env: Env, job: Job) {
  let bookmark = job.bookmark;
  let url: string | undefined;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID!)}/d1/database/${encodeURIComponent(env.CF_DATABASE_ID!)}/export`;
  const deadline = Date.now() + 25000;
  // No D1 queries run while the export is active; the bookmark is saved afterwards.
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${env.CF_D1_EXPORT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) }),
    });
    if (!response.ok) throw new Error(`D1_EXPORT_${response.status}`);
    const value = await response.json() as { success: boolean; result?: { at_bookmark?: string; status?: string; result?: { signed_url?: string } } };
    if (!value.success || value.result?.status === 'error') throw new Error('D1_EXPORT_FAILED');
    bookmark = value.result?.at_bookmark || bookmark;
    if (value.result?.status === 'complete') { url = value.result.result?.signed_url; break; }
    if (value.result?.status !== 'active') throw new Error('D1_EXPORT_RESPONSE');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!url) {
    if (bookmark) await jobUpdate(env, job, 'UPDATE backup_jobs SET bookmark = ?', [bookmark]);
    return true; // Still exporting; poll again in the next message.
  }
  if (new URL(url).protocol !== 'https:' || !bookmark) throw new Error('D1_EXPORT_RESPONSE');
  await jobUpdate(env, job, "UPDATE backup_jobs SET status = 'parts', bookmark = ?, signed_url = ?", [bookmark, url]);
  return true;
}

async function storePart(env: Env, job: Job, index: number, plaintext: Uint8Array, fileName: string) {
  const bucket = env.BACKUP_BUCKET!;
  const key = prefix(job.id) + fileName;
  const plainHash = await digest(plaintext);
  const existing = await env.CRM_DB.prepare('SELECT * FROM backup_parts WHERE job_id = ? AND part = ?').bind(job.id, index).first<Row>();
  if (existing && (existing.plaintext_sha256 !== plainHash || Number(existing.plaintext_bytes) !== plaintext.length)) throw new Error('BACKUP_SOURCE_CHANGED');
  const header: BackupHeader = existing ? JSON.parse(String(existing.header_json)) : newHeader(job.id, index);
  const encrypted = await sealPart(env.BACKUP_KEY!, plaintext, header);
  const encryptedHash = await digest(encrypted);
  if (!existing) {
    await env.CRM_DB.prepare(`INSERT INTO backup_parts (job_id, part, object_key, header_json, plaintext_bytes, plaintext_sha256, encrypted_bytes, encrypted_sha256)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM backup_jobs WHERE id = ? AND lease_token = ?)`)
      .bind(job.id, index, key, JSON.stringify(header), plaintext.length, plainHash, encrypted.length, encryptedHash, job.id, job.lease_token).run();
  } else if (existing.encrypted_sha256 !== encryptedHash) throw new Error('BACKUP_CIPHER_CHANGED');
  const stored = await bucket.head(key);
  if (!stored) {
    // Create only: never overwrite an object a timed-out attempt may already have written.
    await bucket.put(key, encrypted, { onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: encryptedHash, httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { format: 'presently-backup-part-v1' } });
  }
  const object = await bucket.get(key);
  if (!object) throw new Error('R2_UPLOAD_NOT_VERIFIED');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== encrypted.length || await digest(bytes) !== encryptedHash) throw new Error('R2_VERIFY_MISMATCH');
  await env.CRM_DB.prepare('UPDATE backup_parts SET verified_at = ? WHERE job_id = ? AND part = ?').bind(now(), job.id, index).run();
  return { key, plainHash, encryptedHash, encryptedBytes: encrypted.length };
}

async function partStep(env: Env, job: Job) {
  const response = await fetch(job.signed_url!, { headers: { Range: `bytes=${job.offset_bytes}-${job.offset_bytes + PART_BYTES - 1}` } });
  const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (response.status !== 206 && !(response.status === 200 && job.offset_bytes === 0)) { await response.body?.cancel(); throw new Error(`D1_EXPORT_RANGE_${response.status}`); }
  const bytes = await readBounded(response, response.status === 200 ? MAX_SQL_BYTES : PART_BYTES);
  if (response.status === 200 && bytes.length > PART_BYTES) throw new Error('D1_EXPORT_RANGE_UNSUPPORTED');
  const total = range ? Number(range[3]) : bytes.length;
  if (!bytes.length || !Number.isSafeInteger(total) || total > MAX_SQL_BYTES || (range && Number(range[1]) !== job.offset_bytes)
    || (job.sql_bytes !== null && job.sql_bytes !== total)) throw new Error('D1_EXPORT_SIZE_OR_RANGE');
  await storePart(env, job, job.next_part, bytes, partFileName(job.next_part));
  const offset = job.offset_bytes + bytes.length;
  await jobUpdate(env, job, 'UPDATE backup_jobs SET sql_bytes = ?, offset_bytes = ?, next_part = ?, status = ?', [total, offset, job.next_part + 1, offset >= total ? 'manifest' : 'parts']);
  return true;
}

async function manifestStep(env: Env, job: Job) {
  const parts = await env.CRM_DB.prepare('SELECT * FROM backup_parts WHERE job_id = ? AND part >= 0 ORDER BY part').bind(job.id).all<Row>();
  if (parts.results.length !== job.next_part || parts.results.some((p, i) => Number(p.part) !== i || !p.verified_at)) throw new Error('BACKUP_PARTS_INCOMPLETE');
  const completedAt = now();
  const manifest: BackupManifest = {
    format: MANIFEST_FORMAT, backupId: job.id, applicationVersion: env.APP_VERSION || '0.0.0', createdAt: job.created_at, completedAt,
    snapshotBookmark: job.bookmark!, sqlBytes: Number(job.sql_bytes), storagePrefix: prefix(job.id),
    parts: parts.results.map(p => ({
      index: Number(p.part), fileName: partFileName(Number(p.part)), objectKey: String(p.object_key), plaintextBytes: Number(p.plaintext_bytes),
      plaintextSha256: String(p.plaintext_sha256), encryptedBytes: Number(p.encrypted_bytes), encryptedSha256: String(p.encrypted_sha256),
    })),
  };
  await storePart(env, job, -1, new TextEncoder().encode(JSON.stringify(manifest)), 'manifest.bin');
  await jobUpdate(env, job, "UPDATE backup_jobs SET status = 'complete', completed_at = ?, signed_url = NULL, error_code = NULL", [completedAt]);
  await env.CRM_DB.prepare('UPDATE business SET backup_alerted_at = NULL WHERE id = 1').run();
  return false;
}

async function sendAlert(env: Env, payload: Record<string, unknown>) {
  if (!env.BACKUP_ALERT_URL) return false;
  try {
    const response = await fetch(env.BACKUP_ALERT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'presently', ...payload }) });
    return response.ok;
  } catch { return false; }
}

/** Run one step of a backup job. Returns true when another step should follow. */
export async function advanceBackup(env: Env, jobId: string) {
  const leaseToken = crypto.randomUUID();
  const at = now();
  const job = await env.CRM_DB.prepare(`UPDATE backup_jobs SET lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status NOT IN ('complete', 'failed') AND (lease_until IS NULL OR lease_until <= ?) RETURNING *`)
    .bind(leaseToken, new Date(Date.now() + LEASE_MS).toISOString(), at, jobId, at).first<Job>();
  if (!job) return false;
  try {
    const more = job.status === 'export' ? await exportStep(env, job) : job.status === 'parts' ? await partStep(env, job) : await manifestStep(env, job);
    await env.CRM_DB.prepare('UPDATE backup_jobs SET lease_until = NULL, attempts = 0 WHERE id = ? AND lease_token = ?').bind(job.id, leaseToken).run();
    return more;
  } catch (error) {
    const code = (error instanceof Error ? error.message : 'BACKUP_FAILED').replace(/[^A-Z0-9_]/g, '_').slice(0, 60) || 'BACKUP_FAILED';
    if (job.attempts >= MAX_ATTEMPTS) {
      await env.CRM_DB.prepare("UPDATE backup_jobs SET status = 'failed', error_code = ?, lease_until = NULL, signed_url = NULL, updated_at = ? WHERE id = ?").bind(code, now(), job.id).run();
      if (await sendAlert(env, { event: 'backup_failed', backupId: job.id, code, at: now() }))
        await env.CRM_DB.prepare('UPDATE backup_jobs SET alert_sent_at = ? WHERE id = ?').bind(now(), job.id).run();
      return false;
    }
    await env.CRM_DB.prepare('UPDATE backup_jobs SET error_code = ?, lease_until = NULL WHERE id = ? AND lease_token = ?').bind(code, job.id, leaseToken).run();
    throw error;
  }
}

export async function backupQueue(batch: MessageBatch<BackupMessage>, env: Env) {
  for (const message of batch.messages) {
    try {
      if (await advanceBackup(env, message.body.jobId)) await env.BACKUP_QUEUE!.send({ jobId: message.body.jobId });
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}

/** Hourly: start the nightly backup at the business's chosen local hour, re-drive stalled jobs, and alert when backups go stale. */
export async function backupScheduled(env: Env, at = new Date()) {
  if (!enabled(env) || backupMissing(env).length) return;
  const business = await env.CRM_DB.prepare('SELECT timezone, backup_hour, backup_alerted_at, created_at FROM business WHERE id = 1').first<Row>();
  if (!business) return;
  const local = localParts(at.getTime(), String(business.timezone));
  const recent = await env.CRM_DB.prepare("SELECT id FROM backup_jobs WHERE reason = 'scheduled' AND created_at > ? LIMIT 1")
    .bind(new Date(at.getTime() - 20 * 3600000).toISOString()).first();
  if (local.hour === Number(business.backup_hour) && !recent) await startBackup(env, 'scheduled');
  const stalled = await env.CRM_DB.prepare("SELECT id FROM backup_jobs WHERE status NOT IN ('complete', 'failed') AND updated_at < ? LIMIT 5")
    .bind(new Date(at.getTime() - 15 * 60000).toISOString()).all<{ id: string }>();
  for (const job of stalled.results) await env.BACKUP_QUEUE!.send({ jobId: job.id });
  const last = await env.CRM_DB.prepare("SELECT max(completed_at) AS at FROM backup_jobs WHERE status = 'complete'").first<{ at: string | null }>();
  const reference = Date.parse(last?.at || String(business.created_at));
  if (at.getTime() - reference > STALE_HOURS * 3600000 && !business.backup_alerted_at) {
    if (await sendAlert(env, { event: 'backup_stale', lastCompletedAt: last?.at ?? null, at: at.toISOString() }))
      await env.CRM_DB.prepare('UPDATE business SET backup_alerted_at = ? WHERE id = 1').bind(at.toISOString()).run();
  }
}

export const backupRouter = new Hono<AppEnv>();
backupRouter.get('/', async c => {
  requireRole(c, ['owner']);
  const business = await getBusiness(c);
  const rows = await c.env.CRM_DB.prepare('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT 20').all<Row>();
  const jobs: BackupJob[] = rows.results.map(r => ({
    id: String(r.id), status: r.status as BackupJob['status'], reason: r.reason as BackupJob['reason'], createdAt: String(r.created_at),
    completedAt: (r.completed_at as string | null) ?? null, sqlBytes: r.sql_bytes === null ? null : Number(r.sql_bytes), parts: Number(r.next_part),
    errorCode: (r.error_code as string | null) ?? null,
  }));
  const lastCompletedAt = jobs.find(job => job.status === 'complete')?.completedAt
    ?? (await c.env.CRM_DB.prepare("SELECT max(completed_at) AS at FROM backup_jobs WHERE status = 'complete'").first<{ at: string | null }>())?.at ?? null;
  const missing = backupMissing(c.env);
  const status: BackupStatus = {
    configured: !missing.length, enabled: enabled(c.env), missing, backupHour: business.backupHour, timezone: business.timezone,
    lastCompletedAt, stale: !lastCompletedAt || Date.now() - Date.parse(lastCompletedAt) > STALE_HOURS * 3600000, jobs,
  };
  return c.json(status);
});
backupRouter.post('/start', async c => {
  requireRole(c, ['owner']);
  const id = await startBackup(c.env, 'manual');
  await audit(c, 'backup_started', 'backup', id).run();
  return c.json({ id }, 202);
});
