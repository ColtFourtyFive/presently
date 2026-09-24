import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { bytes64, digest, newHeader, openPart, sealPart, sealSecret, verifyBackup, verifyBackupStream, type BackupManifest } from '../worker/backup-crypto';
import { verifyBackupArchives } from '../worker/backup-archives';
import { BACKUP_TABLES } from '../worker/backup';
import { createStudent, json, observation, startApp, type App } from './helpers';
import { createRuntime, projectRoot } from './runtime';

// Provider responses below are LOCAL mocks. These tests do not establish live
// Cloudflare export, Google OAuth consent, Drive durability, or paid/free quotas.
const key = bytes64(crypto.getRandomValues(new Uint8Array(32)));
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
async function encryptedFixture(chunks = ['CREATE TABLE sample(id TEXT);\n', "INSERT INTO sample VALUES('kept');\n"]) {
  const backupId = crypto.randomUUID(); const files = new Map<string, Uint8Array>(); const parts: BackupManifest['parts'] = [];
  for (const [index, text] of chunks.entries()) {
    const plaintext = encode(text); const encrypted = await sealPart(key, plaintext, newHeader(backupId, index)); const name = `part-${String(index).padStart(5, '0')}.kcrm`; files.set(name, encrypted);
    parts.push({ index, fileName: name, plaintextBytes: plaintext.length, plaintextSha256: await digest(plaintext), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) });
  }
  const manifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId, applicationVersion: 'test', schemaVersions: [1, 2, 3], createdAt: new Date().toISOString(), snapshotBookmark: 'local-mock-bookmark', recordCounts: { sample: 1 }, sqlBytes: encode(chunks.join('')).length, parts };
  const sealManifest = (value: BackupManifest) => sealPart(key, encode(JSON.stringify(value)), newHeader(backupId, -1));
  const manifestBytes = await sealManifest(manifest);
  const read = async (name: string) => { const file = files.get(name); if (!file) throw new Error('MISSING_LOCAL_PART'); return file; };
  return { manifest, manifestBytes, files, read, sealManifest, plaintext: chunks.join('') };
}
describe('encrypted backup integrity and restore bounds', () => {
  it('round trips SQL and authenticates the header, ciphertext, key, and part identity', async () => {
    const fixture = await encryptedFixture(); const verified = await verifyBackup(key, fixture.manifestBytes, fixture.read);
    expect(decode(verified.sql)).toBe(fixture.plaintext); expect(verified.manifest.recordCounts).toEqual({ sample: 1 });
    const wrongKey = bytes64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(verifyBackup(wrongKey, fixture.manifestBytes, fixture.read)).rejects.toThrow();
    const tampered = fixture.manifestBytes.slice(); tampered[tampered.length - 1] ^= 1;
    await expect(verifyBackup(key, tampered, fixture.read)).rejects.toThrow();
    const headerTampered = fixture.manifestBytes.slice(); headerTampered[25] ^= 1;
    await expect(openPart(key, headerTampered)).rejects.toThrow();
  });
  it('rejects missing, reordered, substituted, truncated, and corrupted parts', async () => {
    const fixture = await encryptedFixture();
    await expect(verifyBackup(key, fixture.manifestBytes, async () => { throw new Error('MISSING_LOCAL_PART'); })).rejects.toThrow('MISSING_LOCAL_PART');
    await expect(verifyBackup(key, await fixture.sealManifest({ ...fixture.manifest, parts: [...fixture.manifest.parts].reverse() }), fixture.read)).rejects.toThrow();
    await expect(verifyBackup(key, fixture.manifestBytes, async () => fixture.files.get('part-00001.kcrm')!)).rejects.toThrow();
    await expect(verifyBackup(key, fixture.manifestBytes, async name => (await fixture.read(name)).slice(1))).rejects.toThrow();
    await expect(verifyBackup(key, fixture.manifestBytes, async name => { const bytes = (await fixture.read(name)).slice(); bytes[bytes.length - 1] ^= 1; return bytes; })).rejects.toThrow();
  });
  it('rejects forged size metadata before requesting SQL parts', async () => {
    const fixture = await encryptedFixture(); let reads = 0;
    const read = async (name: string) => { reads++; return fixture.read(name); };
    await expect(verifyBackup(key, await fixture.sealManifest({ ...fixture.manifest, sqlBytes: 513 * 1024 * 1024 }), read)).rejects.toThrow();
    expect(reads).toBe(0);
    await expect(verifyBackup(key, await fixture.sealManifest({ ...fixture.manifest, parts: [{ ...fixture.manifest.parts[0], plaintextBytes: -1 }] }), read)).rejects.toThrow();
    expect(reads).toBe(0);
  });
  it('requires an explicit archive snapshot in schema 8+ and rejects unsafe or duplicate references before reading SQL', async () => {
    const fixture = await encryptedFixture(); let reads = 0;
    const read = async (name: string) => { reads++; return fixture.read(name); };
    await expect(verifyBackup(key, await fixture.sealManifest({ ...fixture.manifest, schemaVersions: [1, 8] }), read)).rejects.toThrow('missing its archive snapshot');
    const reference = { archiveId: 'history-1', kind: 'monthly' as const, manifestObjectKey: `archives/center-1/2025-01/history-1/manifest-${'a'.repeat(64)}.kca`, manifestSha256: 'a'.repeat(64) };
    for (const refs of [[{ ...reference, manifestObjectKey: '../outside.kca' }], [reference, reference]]) await expect(verifyBackup(key, await fixture.sealManifest({ ...fixture.manifest, archiveReferences: refs }), read, async () => {})).rejects.toThrow('backup archive object');
    await expect(verifyBackup(key, await fixture.sealManifest({ ...fixture.manifest, archiveReferences: [reference] }), read)).rejects.toThrow('requires historical archive verification');
    expect(reads).toBe(0);
    expect((await verifyBackup(key, await fixture.sealManifest({ ...fixture.manifest, schemaVersions: [1, 8], archiveReferences: [] }), read)).sql).toBeDefined();
  });
  it('streams authenticated chunks and does not publish a partial restore after a bad last part', async () => {
    const fixture = await encryptedFixture(['-- First authenticated SQL chunk\n', '-- Last authenticated SQL chunk\n']);
    const temporary: Uint8Array[] = []; let published = false;
    const restore = async (read: (name: string) => Promise<Uint8Array>) => { const result = await verifyBackupStream(key, fixture.manifestBytes, read, async part => { temporary.push(part); }); published = true; return result; };
    await expect(restore(async name => { const part = (await fixture.read(name)).slice(); if (name === 'part-00001.kcrm') part[part.length - 1] ^= 1; return part; })).rejects.toThrow();
    expect(temporary).toHaveLength(1); expect(published).toBe(false);
    temporary.length = 0;
    await restore(fixture.read); expect(published).toBe(true); expect(temporary).toHaveLength(2); expect(temporary.map(decode).join('')).toBe(fixture.plaintext);
  });
});

type DriveFile = { name: string; mimeType: string; bytes?: Buffer };
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function backupApp() {
  const app = await startApp({ bindings: { APP_ENV: 'local', BACKUP_PROVIDER: 'google-drive', BACKUP_KEY: key, CF_ACCOUNT_ID: 'local-mock-account', CF_DATABASE_ID: 'local-mock-db', CF_EXPORT_API_TOKEN: 'local-mock-export-token', GOOGLE_CLIENT_ID: 'local-mock-client', GOOGLE_CLIENT_SECRET: 'local-mock-client-secret', GOOGLE_OAUTH_MODE: 'production' } });
  apps.push(app);
  await app.db.prepare('INSERT INTO backup_google(id,sealed_tokens,folder_id,connected_by,connected_at) VALUES(1,?,?,?,?)').bind(await sealSecret(key, { refreshToken: 'local-mock-refresh', accessToken: 'local-mock-drive-access', expiresAt: Date.now() + 3600000 }), 'root-folder', app.actor.id, new Date().toISOString()).run();
  return app;
}
function headersAsRecord(headers: unknown): Record<string, string> {
  if (headers && typeof (headers as Headers).entries === 'function') return Object.fromEntries((headers as Headers).entries());
  if (Array.isArray(headers)) { const result: Record<string, string> = {}; for (let i = 0; i < headers.length; i += 2) result[String(headers[i]).toLowerCase()] = String(headers[i + 1]); return result; }
  return Object.fromEntries(Object.entries((headers || {}) as Record<string, unknown>).map(([name, value]) => [name.toLowerCase(), String(value)]));
}
async function mockBody(body: unknown): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = []; for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
const asyncMock = (callback: (request: { path: string; headers?: unknown; body?: unknown }) => Promise<string>) => (request: { path: string; headers?: unknown; body?: unknown }) => callback(request) as unknown as string;
function providers(app: App, sql: Uint8Array, options: { loseUploadResponse?: boolean; exportIncomplete?: boolean; exportActiveOnce?: boolean; omitContentRange?: boolean; oversizedRangeBody?: boolean; pauseFirstUpload?: { arrived: () => void; resume: Promise<void> } } = {}) {
  const files = new Map<string, DriveFile>([['root-folder', { name: 'Root', mimeType: 'application/vnd.google-apps.folder' }]]); let sequence = 0; let uploadCalls = 0; let exportCalls = 0; let readbacks = 0; let responseLost = false;
  const jsonReply = (data: unknown, statusCode = 200) => ({ statusCode, data: JSON.stringify(data), responseOptions: { headers: { 'content-type': 'application/json' } } });
 app.fetchMock.get('https://api.cloudflare.com').intercept({ path: '/client/v4/accounts/local-mock-account/d1/database/local-mock-db/export', method: 'POST', headers: { authorization: 'Bearer local-mock-export-token' } }).reply(() => { exportCalls++; return jsonReply({ success: true, result: { at_bookmark: 'local-snapshot-bookmark', status: options.exportIncomplete || (options.exportActiveOnce && exportCalls === 1) ? 'active' : 'complete', result: { signed_url: 'https://local-export.example.test/snapshot.sql' } } }); }).persist();
  app.fetchMock.get('https://local-export.example.test').intercept({ path: '/snapshot.sql' }).reply(request => {
    const range = headersAsRecord(request.headers).range?.match(/^bytes=(\d+)-(\d+)$/); if (!range) return jsonReply({ error: 'RANGE_REQUIRED' }, 400);
    const start = Number(range[1]); const end = Math.min(Number(range[2]), sql.length - 1); const data = options.oversizedRangeBody ? Buffer.alloc(2 * 1024 * 1024, 65) : Buffer.from(sql.slice(start, end + 1));
    return { statusCode: 206, data, responseOptions: { headers: { 'content-type': 'application/sql', ...(options.omitContentRange ? {} : { 'content-range': `bytes ${start}-${end}/${sql.length}` }) } } };
  }).persist();
  const drive = app.fetchMock.get('https://www.googleapis.com');
  drive.intercept({ path: '/drive/v3/files/generateIds?count=1&space=drive', headers: { authorization: 'Bearer local-mock-drive-access' } }).reply(() => jsonReply({ ids: [`file-${++sequence}`] })).persist();
  drive.intercept({ path: path => path.startsWith('/drive/v3/files/') && path.includes('fields='), headers: { authorization: 'Bearer local-mock-drive-access' } }).reply(request => { const id = /\/files\/([^?]+)/.exec(request.path)![1]; const file = files.get(id); return file ? jsonReply({ id, mimeType: file.mimeType, trashed: false }) : jsonReply({}, 404); }).persist();
  drive.intercept({ path: '/drive/v3/files?fields=id', method: 'POST', headers: { authorization: 'Bearer local-mock-drive-access' } }).reply(200, asyncMock(async request => { const data = JSON.parse((await mockBody(request.body)).toString()) as { id: string; name: string; mimeType: string }; files.set(data.id, data); return JSON.stringify({ id: data.id }); }), { headers: { 'content-type': 'application/json' } }).persist();
  drive.intercept({ path: path => path.startsWith('/drive/v3/files/') && path.includes('alt=media'), headers: { authorization: 'Bearer local-mock-drive-access' } }).reply(request => { const id = /\/files\/([^?]+)/.exec(request.path)![1]; const file = files.get(id); if (!file?.bytes) return jsonReply({}, 404); readbacks++; return { statusCode: 200, data: file.bytes, responseOptions: { headers: { 'content-type': 'application/octet-stream' } } }; }).persist();
  const upload = asyncMock(async request => {
    uploadCalls++; const contentType = headersAsRecord(request.headers)['content-type']; const boundary = /boundary=(.+)$/.exec(contentType)![1];
    const raw = await mockBody(request.body);
    const metadataStart = raw.indexOf('\r\n\r\n') + 4; const metadataEnd = raw.indexOf(`\r\n--${boundary}`, metadataStart); const metadata = JSON.parse(raw.subarray(metadataStart, metadataEnd).toString()) as { id: string; name: string };
    const bytesStart = raw.indexOf('\r\n\r\n', metadataEnd + 4) + 4; const bytesEnd = raw.lastIndexOf(`\r\n--${boundary}--`); const bytes = raw.subarray(bytesStart, bytesEnd);
    files.set(metadata.id, { name: metadata.name, mimeType: 'application/octet-stream', bytes: Buffer.from(bytes) });
    if (options.pauseFirstUpload && uploadCalls === 1) { options.pauseFirstUpload.arrived(); await options.pauseFirstUpload.resume; }
    if (options.loseUploadResponse && !responseLost) responseLost = true;
    return JSON.stringify({ id: metadata.id, size: String(bytes.length) });
  });
  drive.intercept({ path: '/upload/drive/v3/files?uploadType=multipart&fields=id,size', method: 'POST', headers: { authorization: 'Bearer local-mock-drive-access' } }).reply(() => ({ statusCode: options.loseUploadResponse && !responseLost ? 503 : 200, data: upload, responseOptions: { headers: { 'content-type': 'application/json' } } })).persist();
  return { files, metrics: () => ({ uploadCalls, exportCalls, readbacks, responseLost }) };
}
async function start(app: App) { return json<{ jobId: string }>(await app.request('/api/admin/backups/start', { token: app.token, body: {} }), 202); }
async function advance(app: App, jobId: string) { return json<{ status: string; delay?: number }>(await app.request(`/api/admin/backups/${jobId}/advance`, { token: app.token, body: {} })); }
async function run(app: App, jobId: string) { for (let i = 0; i < 20; i++) { const result = await advance(app, jobId); if (['complete', 'failed'].includes(result.status)) return result; } throw new Error('Backup did not terminate within test step bound.'); }
async function dumpFixture(app: App) {
  const objects = (await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all<{ name: string; type: string; sql: string }>()).results;
  const tables = objects.filter(object => object.type === 'table'); const lines = tables.map(table => `${table.sql};`);
  const literal = (value: unknown) => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  for (const table of tables) { const rows = (await app.db.prepare(`SELECT * FROM "${table.name}"`).all()).results; for (const row of rows) lines.push(`INSERT INTO "${table.name}" (${Object.keys(row).map(key => `"${key}"`).join(',')}) VALUES (${Object.values(row).map(literal).join(',')});`); }
  lines.push(...objects.filter(object => object.type !== 'table').map(object => `${object.sql};`));
  return encode(lines.join('\n'));
}
describe('backup jobs in actual local workerd/D1 with mocked providers', () => {
  it('stops immediately when Cloudflare denies D1 export', async () => {
    const app = await backupApp();
    app.fetchMock.get('https://api.cloudflare.com').intercept({
      path: '/client/v4/accounts/local-mock-account/d1/database/local-mock-db/export',
      method: 'POST',
      headers: { authorization: 'Bearer local-mock-export-token' }
    }).reply(401, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), {
      headers: { 'content-type': 'application/json' }
    });
    const { jobId } = await start(app);
    expect((await advance(app, jobId)).status).toBe('failed');
    const job = await app.db.prepare('SELECT status,error_code,attempts FROM backup_jobs WHERE id=?').bind(jobId).first<{status:string;error_code:string;attempts:number}>();
    expect(job).toMatchObject({ status: 'failed', error_code: 'D1_EXPORT_401', attempts: 1 });
  });
  it('preserves a consistent manifest, verifies Drive readbacks, and restores a tiny database fixture', async () => {
    const app = await backupApp(); const student = await createStudent(app); await json(await app.request('/api/admin/attendance', { token: app.token, body: observation(student.student.id, 'check_in') }), 201);
    const sql = await dumpFixture(app); const provider = providers(app, sql); const { jobId } = await start(app);
    const blocked = await app.request(`/api/admin/students/${student.student.id}`, { token: app.token, method: 'PATCH', body: { firstName: 'Blocked during snapshot' } }); expect(blocked.status).toBe(503);
    expect((await run(app, jobId)).status).toBe('complete');
    const job = await app.db.prepare('SELECT * FROM backup_jobs WHERE id=?').bind(jobId).first<Record<string, unknown>>();
    expect(job?.signed_url).toBeNull(); const manifestFile = provider.files.get(String(job?.manifest_file_id)); expect(manifestFile?.bytes).toBeDefined();
    const verified = await verifyBackup(key, manifestFile!.bytes!, async name => { const file = [...provider.files.values()].find(file => file.name === name); if (!file?.bytes) throw new Error('MISSING_LOCAL_DRIVE_FILE'); return file.bytes; });
    expect(verified.sql).toEqual(sql); expect(verified.manifest.recordCounts.students).toBe(1); expect(verified.manifest.recordCounts.visits).toBe(1); expect(verified.manifest.recordCounts.attendance_events).toBe(1); expect(verified.manifest.schemaVersions).toEqual((await app.db.prepare('SELECT version FROM schema_versions ORDER BY version').all<{version:number}>()).results.map(row => row.version)); expect(provider.metrics().readbacks).toBeGreaterThanOrEqual(verified.manifest.parts.length + 1);
    const restored = await createRuntime({ bindings: {}, migrate: false });
    try {
      const statements = ['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(decode(verified.sql))]; await restored.db.batch(statements.map(sql => restored.db.prepare(sql)));
      for (const table of BACKUP_TABLES) expect(await restored.db.prepare(`SELECT count(*) AS n FROM "${table}"`).first('n'), table).toBe(verified.manifest.recordCounts[table]);
      expect(await restored.db.prepare('SELECT student_code FROM students WHERE id=?').bind(student.student.id).first('student_code')).toBe(student.student.studentCode);
      await expect(restored.db.prepare('DELETE FROM attendance_events').run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
    } finally { await restored.close(); }
    const status = await json<{ stale: boolean; jobs: { status: string }[] }>(await app.request('/api/admin/backups', { token: app.token })); expect(status.stale).toBe(false); expect(status.jobs[0].status).toBe('complete');
  });
  it('reconciles a persisted upload after a lost acknowledgement without duplicating Drive files', async () => {
    const app = await backupApp(); const provider = providers(app, encode('-- LOCAL mock SQL\nSELECT 1;'), { loseUploadResponse: true }); const { jobId } = await start(app);
    expect((await run(app, jobId)).status).toBe('complete'); const parts = (await app.db.prepare('SELECT * FROM backup_parts WHERE job_id=?').bind(jobId).all()).results;
    expect(parts).toHaveLength(2); expect(parts.every(part => part.verified_at)).toBe(true); expect(provider.metrics().responseLost).toBe(true); expect(provider.metrics().uploadCalls).toBe(2);
    expect([...provider.files.values()].filter(file => file.mimeType === 'application/octet-stream')).toHaveLength(2);
  });
  it('fails an expired export lock and leaves an explicit stale status', async () => {
  const app = await backupApp(); const provider = providers(app, encode('SELECT 1;')); const { jobId } = await start(app);
  await app.db.prepare('UPDATE backup_runtime SET write_locked_until=? WHERE id=1').bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await advance(app, jobId)).status).toBe('failed'); expect(provider.metrics().uploadCalls).toBe(0);
    const status = await json<{ stale: boolean; jobs: { status: string; error_code: string }[] }>(await app.request('/api/admin/backups', { token: app.token })); expect(status.stale).toBe(true); expect(status.jobs[0]).toMatchObject({ status: 'failed', error_code: 'EXPORT_LOCK_EXPIRED' });
    expect(await app.db.prepare('SELECT write_locked_until FROM backup_runtime WHERE id=1').first('write_locked_until')).toBeNull();
  });
 it('keeps an active export bookmark in memory until D1 accepts writes again', async () => {
  const app = await backupApp();
  const provider = providers(app, encode('SELECT 1;'), { exportActiveOnce: true });
  const { jobId } = await start(app);
  expect((await advance(app, jobId)).status).toBe('parts');
  expect(provider.metrics().exportCalls).toBe(2);
  expect(await app.db.prepare('SELECT write_locked_until FROM backup_runtime WHERE id=1').first('write_locked_until')).toBeNull();
  expect((await run(app, jobId)).status).toBe('complete');
 });
 it('leaves a held job alone and resumes it after an abandoned lease expires', async () => {
    const app = await backupApp(); const provider = providers(app, encode('SELECT 1;')); const { jobId } = await start(app);
    await app.db.prepare('UPDATE backup_jobs SET lease_until=? WHERE id=?').bind(new Date(Date.now() + 30000).toISOString(), jobId).run();
    expect((await advance(app, jobId)).status).toBe('export'); expect(provider.metrics().exportCalls).toBe(0);
    await app.db.prepare('UPDATE backup_jobs SET lease_until=? WHERE id=?').bind(new Date(Date.now() - 1000).toISOString(), jobId).run();
    expect((await run(app, jobId)).status).toBe('complete'); expect(provider.metrics().exportCalls).toBe(1);
  });
  it('fences an old upload worker after another worker takes over its expired lease', async () => {
    const app = await backupApp(); let arrived!: () => void; let resume!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; }); const gate = new Promise<void>(resolve => { resume = resolve; });
    providers(app, encode('-- Local multipart fixture\n' + 'x'.repeat(1024 * 1024 + 100)), { pauseFirstUpload: { arrived, resume: gate } });
    const { jobId } = await start(app); expect((await advance(app, jobId)).status).toBe('parts');
    const original = advance(app, jobId);
    try {
      await arrival;
      await app.db.prepare('UPDATE backup_jobs SET lease_until=? WHERE id=?').bind(new Date(Date.now() - 1000).toISOString(), jobId).run();
      await advance(app, jobId);
    } finally { resume(); }
    await original; expect((await run(app, jobId)).status).toBe('complete');
    const parts = (await app.db.prepare('SELECT part FROM backup_parts WHERE job_id=? AND part>=0 ORDER BY part').bind(jobId).all<{ part: number }>()).results;
    expect(parts.map(part => part.part)).toEqual([0, 1]);
  });
  it('rejects missing range metadata and oversized export responses instead of declaring success', async () => {
    for (const options of [{ omitContentRange: true }, { oversizedRangeBody: true }]) {
      const app = await backupApp(); providers(app, encode('SELECT 1;'), options); const { jobId } = await start(app); expect((await run(app, jobId)).status).toBe('failed');
      expect(await app.db.prepare('SELECT count(*) AS n FROM backup_jobs WHERE id=? AND status=\'complete\'').bind(jobId).first('n')).toBe(0); expect(await app.db.prepare('SELECT error_code FROM backup_jobs WHERE id=?').bind(jobId).first('error_code')).toBe('omitContentRange' in options ? 'D1_EXPORT_SIZE_OR_RANGE' : 'REMOTE_BODY_TOO_LARGE');
    }
  });
});

async function r2BackupApp(withBucket = true) {
  const app = await startApp({ r2: withBucket, bindings: { APP_ENV: 'local', ARCHIVE_ENABLED: 'true', BACKUP_KEY: key, CF_ACCOUNT_ID: 'local-mock-account', CF_DATABASE_ID: 'local-mock-db', CF_EXPORT_API_TOKEN: 'local-mock-export-token' } });
  apps.push(app); return app;
}
describe('R2 backup destination in actual local workerd, D1, and R2', () => {
  it('defaults to private R2 without Google, decrypts with the independent CLI, and restores student attendance', async () => {
    const app = await r2BackupApp(); const student = await createStudent(app);
    await json(await app.request('/api/admin/attendance', { token: app.token, body: observation(student.student.id, 'check_in') }), 201);
    const sql = await dumpFixture(app); const provider = providers(app, sql); const { jobId } = await start(app);
    expect((await run(app, jobId)).status).toBe('complete');
    expect(provider.metrics().uploadCalls).toBe(0); expect(await app.db.prepare('SELECT count(*) AS n FROM backup_google').first('n')).toBe(0);
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET'); const prefix = `backups/${jobId}/`;
    const listing = await bucket.list({ prefix }); expect(listing.objects.map(object => object.key).sort()).toEqual([`${prefix}manifest.kcrm`, `${prefix}part-00000.kcrm`]);
    const downloaded = join(app.directory, 'downloaded-encrypted-r2'); await mkdir(downloaded, { mode: 0o700 });
    for (const object of listing.objects) {
      const stored = await bucket.get(object.key); expect(stored?.httpMetadata?.cacheControl).toBe('no-store');
      await writeFile(join(downloaded, object.key.slice(prefix.length)), new Uint8Array(await stored!.arrayBuffer()), { mode: 0o600 });
    }
    const keyFile = join(app.directory, 'recovery.key'); await writeFile(keyFile, key, { mode: 0o600 });
    const output = join(app.directory, 'independent-restore.sql');
    const cli = await promisify(execFile)(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/recovery.ts'), 'verify-decrypt', downloaded, output], { cwd: projectRoot, env: { ...process.env, KUMON_RECOVERY_KEY_FILE: keyFile } });
    expect(JSON.parse(cli.stdout).verified).toBe(true); expect(new Uint8Array(await readFile(output))).toEqual(sql);
    const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as BackupManifest;
    expect(manifest.storageProvider).toBe('r2'); expect(manifest.storagePrefix).toBe(prefix); expect(manifest.parts[0].objectKey).toBe(`${prefix}part-00000.kcrm`);
    const restored = await createRuntime({ bindings: {}, migrate: false });
    try {
      await restored.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(decode(sql))].map(statement => restored.db.prepare(statement)));
      for (const table of BACKUP_TABLES) expect(await restored.db.prepare(`SELECT count(*) AS n FROM "${table}"`).first('n'), table).toBe(manifest.recordCounts[table]);
      expect(await restored.db.prepare('SELECT student_code FROM students WHERE id=?').bind(student.student.id).first('student_code')).toBe(student.student.studentCode);
      await expect(restored.db.prepare('DELETE FROM attendance_events').run()).rejects.toThrow('IMMUTABLE_ATTENDANCE');
    } finally { await restored.close(); }
    const status = await json<{ provider: string; configured: boolean; storageConfigured: boolean; schedulingConfigured: boolean; stale: boolean; jobs: { manifestKey: string; storagePrefix: string }[] }>(await app.request('/api/admin/backups', { token: app.token }));
    expect(status).toMatchObject({ provider: 'r2', configured: true, storageConfigured: true, schedulingConfigured: false, stale: false });
    expect(status.jobs[0]).toMatchObject({ manifestKey: `${prefix}manifest.kcrm`, storagePrefix: prefix });
    await json(await app.request('/api/admin/backups/connect', { token: app.token, body: {} }), 409);
  });
  it('pins completed archive references under the SQL snapshot lock and independently recovers the combined database and objects', async () => {
    const app = await r2BackupApp(); const student = await createStudent(app); const visitId = crypto.randomUUID();
    for (const [action, timestamp] of [['check_in', '2025-01-10T18:00:00.000Z'], ['check_out', '2025-01-10T19:00:00.000Z']]) {
      const eventId = crypto.randomUUID();
      await app.db.prepare('INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(eventId,'test-center',student.student.id,visitId,action,timestamp,timestamp,app.actor.id,app.actor.displayName,'admin',action==='check_out'?student.guardians.find(guardian=>guardian.pickupAuthority==='allowed')!.id:null,await digest(encode(eventId)),eventId).run();
    }
    const archive = await json<{jobId:string}>(await app.request('/api/admin/archives/start', { token: app.token, body: { month: '2025-01' } }), 202);
    let archiveComplete = false;
    for(let i=0;i<30;i++) { const status=await json<{status:string}>(await app.request(`/api/admin/archives/${archive.jobId}/advance`, { token: app.token, body: {} })); if(status.status==='complete'){archiveComplete=true;break;} expect(status.status).not.toBe('failed'); }
    expect(archiveComplete).toBe(true);
    await json(await app.request('/api/admin/schedules', { token: app.token, body: { studentId: student.student.id, dayOfWeek: 1, startTime: '15:00', durationMinutes: 30, subject: 'Math' } }), 201);
    const sql = await dumpFixture(app); providers(app, sql); const { jobId } = await start(app);
    const pinned = JSON.parse(String(await app.db.prepare('SELECT archives_json FROM backup_jobs WHERE id=?').bind(jobId).first('archives_json')));
    expect(pinned).toHaveLength(1); expect(pinned[0].archiveId).toBe(archive.jobId);
    for(const table of ['archive_jobs','archive_members','archive_parts']) await expect(app.db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow('backup_maintenance');
    expect((await run(app, jobId)).status).toBe('complete');
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET'); const prefix = `backups/${jobId}/`;
    const encryptedManifest = new Uint8Array(await (await bucket.get(prefix+'manifest.kcrm'))!.arrayBuffer());
    await expect(verifyBackup(key, encryptedManifest, async name=>new Uint8Array(await (await bucket.get(prefix+name))!.arrayBuffer()))).rejects.toThrow('historical archive verification');
    const verified = await verifyBackup(key, encryptedManifest, async name=>new Uint8Array(await (await bucket.get(prefix+name))!.arrayBuffer()), async references=>{await verifyBackupArchives(key,references,async objectKey=>new Uint8Array(await (await bucket.get(objectKey))!.arrayBuffer()),async()=>{});});
    expect(verified.manifest.archiveReferences).toEqual(pinned); expect(verified.manifest.recordCounts.schedules).toBe(1); expect(verified.manifest.recordCounts.archive_jobs).toBe(1);
    const downloaded=join(app.directory,'combined-backup'), archiveRoot=join(app.directory,'archive-root'); await mkdir(downloaded);
    for (const object of (await bucket.list({prefix})).objects) await writeFile(join(downloaded,object.key.slice(prefix.length)),new Uint8Array(await (await bucket.get(object.key))!.arrayBuffer()));
    const archiveObjects=(await bucket.list({prefix:'archives/'})).objects;
    for (const object of archiveObjects) { const path=join(archiveRoot,object.key);await mkdir(dirname(path),{recursive:true});await writeFile(path,new Uint8Array(await (await bucket.get(object.key))!.arrayBuffer())); }
    const keyFile=join(app.directory,'combined.key');await writeFile(keyFile,key,{mode:0o600});const output=join(app.directory,'combined.sql');
    const recovered=await promisify(execFile)(process.execPath,['--import','tsx',join(projectRoot,'scripts/recovery.ts'),'verify-decrypt',downloaded,output,archiveRoot],{cwd:projectRoot,env:{...process.env,KUMON_RECOVERY_KEY_FILE:keyFile}});
    expect(JSON.parse(recovered.stdout).historicalArchives).toMatchObject({archives:1,objects:archiveObjects.length});
    const restored=await createRuntime({bindings:{},migrate:false});
    try { await restored.db.batch(['PRAGMA defer_foreign_keys=ON',...unstable_splitSqlQuery(await readFile(output,'utf8'))].map(statement=>restored.db.prepare(statement)));for(const table of BACKUP_TABLES)expect(await restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'),table).toBe(verified.manifest.recordCounts[table]); }
    finally { await restored.close(); }
    for(const object of archiveObjects) expect(new Uint8Array(await readFile(join(`${output}.archives`,object.key)))).toEqual(new Uint8Array(await (await bucket.get(object.key))!.arrayBuffer()));
  });
  it('reports missing binding and refuses to begin a snapshot when storage is not configured', async () => {
    const app = await r2BackupApp(false);
    const status = await json(await app.request('/api/admin/backups', { token: app.token }));
    expect(status).toMatchObject({ provider: 'r2', storageConfigured: false, configured: false, schedulingConfigured: false, missingConfiguration: ['BACKUP_BUCKET'] });
    await json(await app.request('/api/admin/backups/start', { token: app.token, body: {} }), 503);
    expect(await app.db.prepare('SELECT count(*) AS n FROM backup_jobs').first('n')).toBe(0);
    expect(await app.db.prepare('SELECT write_locked_until FROM backup_runtime WHERE id=1').first('write_locked_until')).toBeNull();
  });
  it('resumes an uncertain cursor after R2 persistence without overwriting the encrypted object', async () => {
    const app = await r2BackupApp(); providers(app, encode('-- local R2 retry fixture\nSELECT 1;')); const { jobId } = await start(app);
    expect((await advance(app, jobId)).status).toBe('parts'); expect((await advance(app, jobId)).status).toBe('manifest');
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET'); const partKey = `backups/${jobId}/part-00000.kcrm`; const before = await bucket.get(partKey);
    await app.db.prepare("UPDATE backup_jobs SET offset_bytes=0,next_part=0,status='parts' WHERE id=?").bind(jobId).run();
    expect((await run(app, jobId)).status).toBe('complete'); const after = await bucket.get(partKey);
    expect(after!.version).toBe(before!.version); expect(new Uint8Array(await after!.arrayBuffer())).toEqual(new Uint8Array(await before!.arrayBuffer()));
    expect((await bucket.list({ prefix: `backups/${jobId}/` })).objects).toHaveLength(2);
    expect(await app.db.prepare('SELECT count(*) AS n FROM backup_parts WHERE job_id=?').bind(jobId).first('n')).toBe(2);
  });
  it('rejects a corrupted R2 readback, preserves the conflicting object, and does not publish a manifest', async () => {
    const app = await r2BackupApp(); providers(app, encode('-- local R2 mismatch fixture\nSELECT 1;')); const { jobId } = await start(app);
    await advance(app, jobId); await advance(app, jobId);
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET'); const partKey = `backups/${jobId}/part-00000.kcrm`;
    const corrupted = new Uint8Array(await (await bucket.get(partKey))!.arrayBuffer()); corrupted[corrupted.length - 1] ^= 1; const conflicting = await bucket.put(partKey, corrupted);
    await app.db.prepare("UPDATE backup_jobs SET offset_bytes=0,next_part=0,status='parts' WHERE id=?").bind(jobId).run();
    expect((await run(app, jobId)).status).toBe('failed');
    expect(await app.db.prepare('SELECT error_code FROM backup_jobs WHERE id=?').bind(jobId).first('error_code')).toBe('R2_VERIFY_MISMATCH');
    expect((await bucket.get(partKey))!.version).toBe(conflicting!.version); expect(await bucket.get(`backups/${jobId}/manifest.kcrm`)).toBeNull();
    const status = await json(await app.request('/api/admin/backups', { token: app.token })); expect(status.stale).toBe(true);
  });
});
