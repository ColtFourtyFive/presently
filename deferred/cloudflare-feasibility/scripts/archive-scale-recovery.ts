/**
 * Isolated schema-41 archive and combined-recovery rehearsal.
 *
 * This script accepts no remote binding or credential. It creates temporary
 * workerd/D1/R2 instances, uses synthetic records, and deletes the private
 * recovery bundle after writing a redacted evidence report.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unstable_splitSqlQuery } from 'wrangler';
import { createArchive, openArchiveManifest } from '../worker/archive-codec';
import { advanceCompactMonthlyPublication, startCompactMonthlyPublication } from '../worker/archive-compact-publication';
import { advanceCompactPublicationReconciliation, startCompactPublicationReconciliation } from '../worker/archive-compact-reconciliation';
import { D1ArchiveSemanticStaging, type ArchiveSemanticHandle } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification, type MonthlySemanticRunHandle } from '../worker/archive-semantic-runner';
import { BACKUP_TABLES, startBackup } from '../worker/backup';
import { digest, newHeader, sealPart, type BackupManifest } from '../worker/backup-crypto';
import { advanceHistoryBackfill } from '../worker/history-lookup';
import { advanceRetentionDryRun, startRetentionDryRun } from '../worker/history-retention';
import { evictRetentionSource } from '../worker/history-source-eviction';
import { jobMetadata, sourcePage, type ArchiveJob } from '../worker/archive-source';
import type { Env } from '../worker/types';
import { ARCHIVE_TABLES, type ArchiveManifest, type ArchiveRecord, type ArchiveReference } from '../shared/archive-format';
import type { Actor } from '../shared/types';
import { createRuntime, projectRoot, testAudience, testIssuer, type TestRuntime } from '../tests/runtime';
import { fixtureId, seedGrowthFixture } from './fixtures';
import { archiveCutoffDate, eligibleArchiveMonths, representativeArchiveMonths } from './archive-scale-policy';

process.umask(0o077);

type PublishedMonth = Readonly<{
  month: string;
  jobId: string;
  reference: ArchiveReference;
  manifest: ArchiveManifest;
  semanticHandle: MonthlySemanticRunHandle;
  semanticCalls: number;
  publicationId: string;
  publicationCalls: number;
}>;

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

function argument(name: string, fallback: string): string {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function emit(phase: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: now(), phase, ...detail }));
}

async function requestJson<T>(app: TestRuntime, token: string, path: string): Promise<T> {
  const response = await app.request(path, { token });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function ensureHistoryReady(app: TestRuntime, maximumCalls = 5_000): Promise<number> {
  const nativeDb = await app.runtime.getD1Database('CRM_DB');
  for (let call = 1; call <= maximumCalls; call += 1) {
    const result = await advanceHistoryBackfill(nativeDb);
    if (call % 250 === 0) emit('history-backfill', { call, state: result.state });
    if (result.state === 'ready') return call;
  }
  throw new Error(`History backfill did not finish within ${maximumCalls} calls.`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: unknown): string {
  if (value == null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot snapshot a non-finite number.');
    return String(value);
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof ArrayBuffer) return `X'${Buffer.from(value).toString('hex')}'`;
  if (ArrayBuffer.isView(value)) return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function snapshotDatabase(app: TestRuntime): Promise<string> {
  const objects = (await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name")
    .all<{ name: string; type: string; sql: string }>()).results;
  const tables = objects.filter(object => object.type === 'table');
  const tableKinds = new Map((await app.db.prepare('PRAGMA table_list').all<{ name: string; wr: number }>()).results.map(row => [row.name, row.wr]));
  const lines = ['PRAGMA foreign_keys=OFF;', ...tables.map(table => `${table.sql};`)];

  for (const table of tables) {
    const columns = (await app.db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all<{ name: string; pk: number }>()).results;
    const names = columns.map(column => column.name);
    if (!names.length) continue;
    const columnSql = names.map(quoteIdentifier).join(',');
    if (tableKinds.get(table.name) === 1) {
      const keys = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
      if (!keys.length) throw new Error(`WITHOUT ROWID table ${table.name} has no primary key.`);
      let cursor: unknown[] | undefined;
      for (;;) {
        const keySql = keys.map(quoteIdentifier).join(',');
        const where = cursor ? `WHERE (${keySql})>(${keys.map(() => '?').join(',')})` : '';
        const statement = app.db.prepare(`SELECT * FROM ${quoteIdentifier(table.name)} ${where} ORDER BY ${keySql} LIMIT 500`);
        const page = (await (cursor ? statement.bind(...cursor) : statement).all<Record<string, unknown>>()).results;
        if (!page.length) break;
        for (const row of page) lines.push(`INSERT INTO ${quoteIdentifier(table.name)}(${columnSql}) VALUES(${names.map(name => sqlLiteral(row[name])).join(',')});`);
        cursor = keys.map(key => page.at(-1)![key]);
      }
    } else {
      let cursor = -1;
      for (;;) {
        const page = (await app.db.prepare(`SELECT rowid AS __snapshot_rowid,* FROM ${quoteIdentifier(table.name)} WHERE rowid>? ORDER BY rowid LIMIT 500`)
          .bind(cursor).all<Record<string, unknown>>()).results;
        if (!page.length) break;
        for (const row of page) lines.push(`INSERT INTO ${quoteIdentifier(table.name)}(${columnSql}) VALUES(${names.map(name => sqlLiteral(row[name])).join(',')});`);
        cursor = Number(page.at(-1)!.__snapshot_rowid);
      }
    }
  }
  for (const object of objects.filter(object => object.type !== 'table')) lines.push(`${object.sql};`);
  return `${lines.join('\n')}\n`;
}

async function createV2Archive(app: TestRuntime, env: Env, bucket: R2Bucket, token: string, key: string, month: string): Promise<{
  sourceJobId: string;
  reference: ArchiveReference;
  manifest: ArchiveManifest;
  sourceRecords: number;
}> {
  const started = await app.request('/api/admin/archives/start', { token, body: { month } });
  if (started.status !== 202) throw new Error(`Archive start for ${month} returned ${started.status}: ${await started.text()}`);
  const jobId = ((await started.json()) as { jobId: string }).jobId;
  const job = await app.db.prepare('SELECT * FROM archive_jobs WHERE id=?').bind(jobId).first<ArchiveJob>();
  if (!job) throw new Error(`Archive source snapshot ${jobId} disappeared.`);
  const records: ArchiveRecord[] = [];
  try {
    for (let tableIndex = 0; tableIndex < ARCHIVE_TABLES.length; tableIndex += 1) {
      let after = '';
      for (;;) {
        const page = await sourcePage(env, job, tableIndex, after, 256);
        records.push(...page);
        if (page.length < 256) break;
        after = page.at(-1)!.key;
      }
    }
  } finally {
    const cancelled = await app.request(`/api/admin/archives/${jobId}/cancel`, { token, body: {} });
    if (!cancelled.ok) throw new Error(`Archive source snapshot cancellation returned ${cancelled.status}: ${await cancelled.text()}`);
  }
  const objects = new Map<string, Uint8Array>();
  const archive = await createArchive(key, {
    ...jobMetadata(job),
    archiveId: crypto.randomUUID(),
    semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] },
  }, records, async (part, bytes) => {
    objects.set(part.objectKey, bytes);
  });
  objects.set(archive.objectKey, archive.encrypted);
  for (const [objectKey, bytes] of objects) await bucket.put(objectKey, bytes);
  return {
    sourceJobId: jobId,
    reference: {
      archiveId: archive.manifest.archiveId,
      kind: archive.manifest.kind,
      manifestObjectKey: archive.objectKey,
      manifestSha256: archive.sha256,
    },
    manifest: archive.manifest,
    sourceRecords: records.length,
  };
}

async function stageAndVerify(app: TestRuntime, bucket: R2Bucket, masterKey: string, reference: ArchiveReference): Promise<{
  manifest: ArchiveManifest;
  handle: MonthlySemanticRunHandle;
  calls: number;
}> {
  const manifestObject = await bucket.get(reference.manifestObjectKey);
  if (!manifestObject) throw new Error(`Missing archive manifest ${reference.manifestObjectKey}.`);
  const manifestEnvelope = new Uint8Array(await manifestObject.arrayBuffer());
  const manifest = await openArchiveManifest(masterKey, manifestEnvelope, reference);
  const staging = await D1ArchiveSemanticStaging.create(app.db, masterKey, reference);
  await staging.registerManifest(reference, manifestEnvelope);
  for (const part of manifest.parts) {
    const object = await bucket.get(part.objectKey);
    if (!object) throw new Error(`Missing archive part ${part.objectKey}.`);
    await staging.stageEncryptedPart(reference.archiveId, part.index, new Uint8Array(await object.arrayBuffer()));
  }
  const snapshot = await staging.freeze();
  const handle = await startMonthlySemanticVerification(app.db, {
    ...staging.handle,
    commitToken: snapshot.commitToken,
    graphSha256: snapshot.graphSha256,
  });
  let priorPhase = '';
  let intervalStarted = performance.now();
  for (let call = 1; call <= 100_000; call += 1) {
    const result = await advanceMonthlySemanticVerification(app.db, handle);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    if (result.phase !== priorPhase) {
      priorPhase = result.phase;
      emit('semantic-phase', { month: manifest.month, call, status: result.status, phase: result.phase });
    }
    if (call % 250 === 0) {
      const saved = await app.db.prepare('SELECT cursor_json FROM archive_semantic_runs WHERE run_id=?')
        .bind(handle.runId).first<{ cursor_json: string }>();
      const cursor = saved ? JSON.parse(saved.cursor_json) as {
        tableIndex: number;
        after: string;
        counts: Record<string, number>;
        visitAfter: string;
        visitsDone: number;
        reviewAfter: string;
        reviewsDone: number;
      } : null;
      const elapsedMs = Math.round(performance.now() - intervalStarted);
      intervalStarted = performance.now();
      emit('semantic-verification', {
        month: manifest.month,
        call,
        status: result.status,
        phase: result.phase,
        elapsedMs,
        table: cursor && cursor.tableIndex < ARCHIVE_TABLES.length ? ARCHIVE_TABLES[cursor.tableIndex] : null,
        tableProcessed: cursor && cursor.tableIndex < ARCHIVE_TABLES.length ? cursor.counts[ARCHIVE_TABLES[cursor.tableIndex]] : null,
        after: cursor?.after ?? null,
        visitsDone: cursor?.visitsDone ?? null,
        visitAfter: cursor?.visitAfter ?? null,
        reviewsDone: cursor?.reviewsDone ?? null,
        reviewAfter: cursor?.reviewAfter ?? null,
      });
    }
    if (result.status === 'complete') return { manifest, handle, calls: call };
    if (result.status !== 'pending') throw new Error(`Semantic verification for ${manifest.month} stopped with ${result.status}.`);
  }
  throw new Error(`Semantic verification for ${manifest.month} exceeded 100,000 advances.`);
}

async function publishCompact(app: TestRuntime, handle: MonthlySemanticRunHandle, month: string): Promise<{ publicationId: string; calls: number }> {
  let publication: Awaited<ReturnType<typeof startCompactMonthlyPublication>>;
  emit('compact-publication-start', { month });
  try {
    publication = await startCompactMonthlyPublication(app.db, handle);
  } catch (error) {
    const diagnostic = await app.db.prepare(`SELECT r.*,s.status AS session_status,h.*
      FROM archive_semantic_runs r
      JOIN archive_semantic_sessions s ON s.verification_id=r.verification_id AND s.generation=r.generation
      JOIN archive_semantic_lifecycle h ON h.verification_id=r.verification_id AND h.generation=r.generation
      WHERE r.run_id=?`).bind(handle.runId).first<Record<string, unknown>>();
    const frozen = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(app.db, handle);
    throw new Error(`Compact publication admission failed for ${month}: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify({
      diagnostic,
      frozenHeaderJson: JSON.stringify(frozen.header),
      headerMatches: diagnostic?.header_json === JSON.stringify(frozen.header),
    })}`);
  }
  emit('compact-publication-admitted', { month, publicationId: publication.publicationId });
  let intervalStarted = performance.now();
  for (let call = 1; call <= 25_000; call += 1) {
    const row = await app.db.prepare('SELECT state,revision FROM archive_compact_builds WHERE publication_id=?')
      .bind(publication.publicationId).first<{ state: string; revision: number }>();
    if (!row) throw new Error(`Compact publication ${publication.publicationId} disappeared.`);
    if (row.state === 'published') return { publicationId: publication.publicationId, calls: call - 1 };
    if (row.state === 'invalid') throw new Error(`Compact publication ${publication.publicationId} became invalid.`);
    const result = await advanceCompactMonthlyPublication(app.db, publication, { expectedRevision: row.revision });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    if (call % 100 === 0) {
      const elapsedMs = Math.round(performance.now() - intervalStarted);
      intervalStarted = performance.now();
      emit('compact-publication', { month, call, state: result.state, phase: result.phase, processed: result.processed, elapsedMs });
    }
    if (result.state === 'published') return { publicationId: publication.publicationId, calls: call };
    if (result.state === 'invalid') throw new Error(`Compact publication ${publication.publicationId} became invalid.`);
  }
  throw new Error(`Compact publication ${publication.publicationId} exceeded 25,000 advances.`);
}

async function completeRetentionDryRun(app: TestRuntime, storage: { bucket: R2Bucket; masterKey: string }, actor: Actor, requestedLimit?: number, expectDisabled = true): Promise<{
  jobId: string;
  candidates: number;
  processed: number;
  blockedEvictionCode: string;
}> {
  const maximum = await app.db.prepare("SELECT max_candidates FROM history_retention_policies WHERE center_id='test-center'").first<number>('max_candidates');
  if (!maximum) throw new Error('Retention policy is missing its candidate limit.');
  const limit = Math.min(100, maximum, requestedLimit ?? maximum);
  if (limit < 1) throw new Error('Retention dry-run limit must be positive.');
  emit('retention-start', { maximumCandidates: limit });
  const jobId = await startRetentionDryRun(app.db as unknown as D1Database, 'test-center', actor.id, limit);
  emit('retention-admitted', { jobId });
  let revision = 0;
  for (let call = 1; call <= 10_000; call += 1) {
    const result = await advanceRetentionDryRun(app.db as unknown as D1Database, storage, jobId, { expectedRevision: revision });
    revision = result.revision;
    if (call <= 5 || call % 25 === 0) emit('retention-dry-run', { call, status: result.status, processed: result.processed });
    if (result.status === 'complete') {
      const processed = Number(await app.db.prepare('SELECT count(*) AS n FROM history_retention_items WHERE job_id=?').bind(jobId).first('n'));
      const candidate = await app.db.prepare('SELECT visit_id FROM history_retention_items WHERE job_id=? ORDER BY sequence LIMIT 1')
        .bind(jobId).first<{ visit_id: string }>();
      let blockedEvictionCode = expectDisabled ? 'NO_VERIFIED_CANDIDATE' : 'NOT_PROBED_ENABLED_POLICY';
      if (expectDisabled && candidate) {
        try {
          await evictRetentionSource(app.db as unknown as D1Database, storage, jobId, candidate.visit_id, actor.id);
          blockedEvictionCode = 'UNEXPECTED_EVICTION';
        } catch (error) {
          blockedEvictionCode = error instanceof Error ? error.message : String(error);
        }
        if (blockedEvictionCode !== 'SOURCE_EVICTION_DISABLED') {
          throw new Error(`Expected disabled source eviction, received ${blockedEvictionCode}.`);
        }
      }
      return { jobId, candidates: result.candidateCount, processed, blockedEvictionCode };
    }
    if (result.status === 'blocked' || result.status === 'invalid' || result.status === 'missing') {
      throw new Error(`Retention dry run stopped with ${result.status}:${result.errorCode ?? 'UNKNOWN'}.`);
    }
  }
  throw new Error('Retention dry run exceeded 10,000 advances.');
}

async function listBucketObjects(bucket: R2Bucket): Promise<Array<{ key: string; size: number }>> {
  const objects: Array<{ key: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor });
    objects.push(...page.objects.map(object => ({ key: object.key, size: object.size })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects.sort((a, b) => a.key.localeCompare(b.key));
}

async function writeArchiveObjects(bucket: R2Bucket, root: string, objects: readonly { key: string; size: number }[]): Promise<void> {
  for (const object of objects) {
    const body = await bucket.get(object.key);
    if (!body) throw new Error(`R2 object disappeared during recovery capture: ${object.key}.`);
    const path = join(root, ...object.key.split('/'));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, new Uint8Array(await body.arrayBuffer()), { mode: 0o600 });
  }
}

async function captureBackupJob(app: TestRuntime, env: Env, key: string): Promise<{
  id: string;
  createdAt: string;
  counts: Record<string, number>;
  schemaVersions: number[];
  references: ArchiveReference[];
}> {
  const id = await startBackup({
    ...env,
    BACKUP_KEY: key,
    CF_ACCOUNT_ID: 'isolated-scale-account',
    CF_DATABASE_ID: 'isolated-scale-database',
    CF_EXPORT_API_TOKEN: 'isolated-no-network-token',
  });
  const row = await app.db.prepare('SELECT created_at,counts_json,schema_json,archives_json FROM backup_jobs WHERE id=?')
    .bind(id).first<{ created_at: string; counts_json: string; schema_json: string; archives_json: string }>();
  if (!row) throw new Error('Backup job capture failed.');
  return {
    id,
    createdAt: row.created_at,
    counts: JSON.parse(row.counts_json) as Record<string, number>,
    schemaVersions: JSON.parse(row.schema_json) as number[],
    references: JSON.parse(row.archives_json) as ArchiveReference[],
  };
}

async function createEncryptedBackup(root: string, key: string, captured: Awaited<ReturnType<typeof captureBackupJob>>, sql: Uint8Array): Promise<BackupManifest> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parts: BackupManifest['parts'] = [];
  const partBytes = 1024 * 1024;
  for (let offset = 0, index = 0; offset < sql.length; offset += partBytes, index += 1) {
    const plaintext = sql.slice(offset, offset + partBytes);
    const encrypted = await sealPart(key, plaintext, newHeader(captured.id, index));
    const fileName = `part-${String(index).padStart(5, '0')}.kcrm`;
    await writeFile(join(root, fileName), encrypted, { mode: 0o600 });
    parts.push({
      index,
      fileName,
      plaintextBytes: plaintext.length,
      plaintextSha256: await digest(plaintext),
      encryptedBytes: encrypted.length,
      encryptedSha256: await digest(encrypted),
    });
  }
  const manifest: BackupManifest = {
    format: 'kumon-d1-backup-v1',
    backupId: captured.id,
    applicationVersion: 'schema-41-isolated-scale-rehearsal',
    createdAt: captured.createdAt,
    schemaVersions: captured.schemaVersions,
    snapshotBookmark: 'LOCAL_SYNTHETIC_NO_PROVIDER_EXPORT',
    recordCounts: captured.counts,
    archiveReferences: captured.references,
    sqlBytes: sql.length,
    parts,
  };
  const envelope = await sealPart(key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(captured.id, -1));
  await writeFile(join(root, 'manifest.kcrm'), envelope, { mode: 0o600 });
  return manifest;
}

async function runRecoveryCli(backupRoot: string, outputSql: string, archiveRoot: string, keyPath: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/recovery.ts'), 'verify-decrypt', backupRoot, outputSql, archiveRoot], {
    cwd: projectRoot,
    env: { ...process.env, KUMON_RECOVERY_KEY_FILE: keyPath, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  });
  if (code !== 0) throw new Error(`Recovery CLI exited ${code}: ${stderr || stdout}`);
  return { stdout, stderr };
}

async function resetAndReconcile(app: TestRuntime, bucket: R2Bucket, key: string, publications: readonly PublishedMonth[]): Promise<Array<{
  month: string;
  semanticCalls: number;
  cleanupCalls: number;
  reconciliationCalls: number;
}>> {
  const resetSql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
  await app.db.batch(resetSql.map(sql => app.db.prepare(sql)));
  await ensureHistoryReady(app);

  let cleanupCalls = 0;
  const sessions = (await app.db.prepare("SELECT verification_id,generation,status FROM archive_semantic_sessions ORDER BY created_at")
    .all<{ verification_id: string; generation: string; status: string }>()).results;
  for (const session of sessions) {
    if (session.status !== 'invalid') throw new Error(`Recovery reset left semantic session ${session.status}.`);
    const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, {
      verificationId: session.verification_id,
      generation: session.generation,
    } satisfies ArchiveSemanticHandle);
    for (;;) {
      cleanupCalls += 1;
      if ((await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).complete) break;
    }
  }

  const evidence: Array<{ month: string; semanticCalls: number; cleanupCalls: number; reconciliationCalls: number }> = [];
  for (const publication of publications) {
    const fresh = await stageAndVerify(app, bucket, key, publication.reference);
    const handle = await startCompactPublicationReconciliation(app.db, publication.publicationId, fresh.handle);
    let revision = 0;
    let reconciliationCalls = 0;
    for (let call = 1; call <= 25_000; call += 1) {
      const result = await advanceCompactPublicationReconciliation(app.db, { bucket, masterKey: key }, handle, { expectedRevision: revision });
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      revision = result.revision;
      reconciliationCalls = call;
      if (call % 1_000 === 0) emit('compact-reconciliation', { month: publication.month, call, state: result.state });
      if (result.state === 'complete') break;
      if (result.state !== 'pending') throw new Error(`Compact reconciliation for ${publication.month} stopped with ${result.state}.`);
      if (call === 25_000) throw new Error(`Compact reconciliation for ${publication.month} exceeded 25,000 advances.`);
    }
    evidence.push({ month: publication.month, semanticCalls: fresh.calls, cleanupCalls, reconciliationCalls });
  }
  return evidence;
}

function verifyRestoredSql(path: string, expected: Record<string, number>): {
  bytes: number;
  sha256: string;
  integrity: string;
  foreignKeyViolations: number;
  countsVerified: number;
  studentDetailRows: number;
  reportVisits: number;
  freshDatabaseAllocatedBytes: number;
  freshDatabasePageCount: number;
  freshDatabaseFreelistCount: number;
} {
  const sql = readFileSync(path, 'utf8');
  // A fresh on-disk import measures whether the post-eviction logical snapshot
  // can occupy less space without relying on VACUUM inside a D1 transaction.
  const freshDatabasePath = `${path}.sqlite`;
  const database = new DatabaseSync(freshDatabasePath);
  try {
    database.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    database.exec(sql);
    database.exec('COMMIT; PRAGMA foreign_keys=ON;');
    const integrity = String(database.prepare('PRAGMA integrity_check').get()!.integrity_check);
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
    for (const table of BACKUP_TABLES) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe backup table ${table}.`);
      const actual = Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
      if (actual !== expected[table]) throw new Error(`Restored count mismatch for ${table}: ${actual} !== ${expected[table]}.`);
    }
    const studentDetailRows = Number(database.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?').get(fixtureId(1, 0))!.n);
    const reportVisits = Number(database.prepare('SELECT count(*) AS n FROM visits WHERE check_in_at IS NOT NULL').get()!.n);
    const freshDatabasePageCount = Number(database.prepare('PRAGMA page_count').get()!.page_count);
    const freshDatabaseFreelistCount = Number(database.prepare('PRAGMA freelist_count').get()!.freelist_count);
    const pageSize = Number(database.prepare('PRAGMA page_size').get()!.page_size);
    const freshDatabaseAllocatedBytes = statSync(freshDatabasePath).size;
    if (freshDatabaseAllocatedBytes !== freshDatabasePageCount * pageSize) {
      throw new Error('Fresh restore file size does not match its SQLite page allocation.');
    }
    return {
      bytes: Buffer.byteLength(sql),
      sha256: sha256(sql),
      integrity,
      foreignKeyViolations,
      countsVerified: BACKUP_TABLES.length,
      studentDetailRows,
      reportVisits,
      freshDatabaseAllocatedBytes,
      freshDatabasePageCount,
      freshDatabaseFreelistCount,
    };
  } finally {
    database.close();
  }
}

// readFileSync avoids a second full copy of the restored SQL in async buffers.
import { readFileSync, statSync } from 'node:fs';

const days = integerArgument('days', 400, 2, 420);
const archiveMonthCount = integerArgument('archive-months', 1, 1, 3);
const liveTierDays = integerArgument('live-tier-days', 120, 90, 120);
const evictVerified = integerArgument('evict-verified', 0, 0, 100);
const dayLayout = argument('day-layout', 'spread');
if (dayLayout !== 'spread' && dayLayout !== 'recent') throw new Error('day-layout must be spread or recent.');
const evictAllPublishedValue = argument('evict-all-published', 'false');
if (evictAllPublishedValue !== 'true' && evictAllPublishedValue !== 'false') throw new Error('evict-all-published must be true or false.');
const evictAllPublished = evictAllPublishedValue === 'true';
if (evictAllPublished && evictVerified > 0) throw new Error('Choose evict-all-published or evict-verified, not both.');
const outputPath = resolve(argument('output', join(projectRoot, 'tests/archive-scale-recovery-results.json')));
const syntheticKey = randomBytes(32).toString('base64');
const work = await mkdtemp(join(tmpdir(), 'kumon-scale-recovery-'));
let app: TestRuntime | undefined;

try {
  emit('start', { days, archiveMonthCount, liveTierDays, dayLayout, evictVerified, evictAllPublished, outputPath });
  app = await createRuntime({
    r2: true,
    bindings: {
      APP_ENV: 'local',
      CENTER_ID: 'test-center',
      APP_VERSION: 'schema-41-isolated-scale-rehearsal',
      ACCESS_ISSUER: testIssuer,
      ACCESS_AUD: testAudience,
      BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
      ARCHIVE_ENABLED: 'true',
      BACKUP_KEY: syntheticKey,
    },
  });
  const token = await app.signer.token({ exp: Math.floor(Date.now() / 1_000) + 12 * 60 * 60 });
  const { actor } = await requestJson<{ actor: Actor }>(app, token, '/api/admin/session');
  const fixture = await seedGrowthFixture(app.db, actor, days, message => emit('fixture', { message }), { dayLayout });
  const initialHistoryBackfillCalls = await ensureHistoryReady(app);

  const asOf = new Date().toISOString().slice(0, 10);
  const eligible = eligibleArchiveMonths({ fixtureFrom: fixture.from, fixtureTo: fixture.to, asOf, liveTierDays });
  const counts = (await app.db.prepare("SELECT substr(check_in_at,1,7) AS month,count(*) AS visits FROM visits WHERE check_in_at IS NOT NULL GROUP BY substr(check_in_at,1,7) ORDER BY month")
    .all<{ month: string; visits: number }>()).results;
  const monthsWithVisits = new Set(counts.filter(row => row.visits > 0).map(row => row.month));
  const selectable = eligible.filter(month => monthsWithVisits.has(month));
  const selected = representativeArchiveMonths(selectable, archiveMonthCount);
  if (evictAllPublished && (selected.length !== selectable.length || selected.some((month, index) => month !== selectable[index]))) {
    throw new Error('Full published-month eviction requires every archive-eligible month with visits to be selected.');
  }
  if (!selected.length) throw new Error('No complete archive month with visits exists outside the live window.');
  emit('fixture-complete', { fixture, cutoff: archiveCutoffDate(asOf, liveTierDays), eligibleMonths: eligible.length, selected });

  const boundEnv = await app.runtime.getBindings<Env>();
  const localQueue = { send: async () => undefined } as unknown as Queue;
  const env: Env = { ...boundEnv, ARCHIVE_QUEUE: localQueue, BACKUP_QUEUE: localQueue };
  const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET') as unknown as R2Bucket;
  const publications: PublishedMonth[] = [];
  for (const month of selected) {
    const archive = await createV2Archive(app, env, bucket, token, syntheticKey, month);
    const semantic = await stageAndVerify(app, bucket, syntheticKey, archive.reference);
    const publication = await publishCompact(app, semantic.handle, month);
    publications.push({
      month,
      jobId: archive.sourceJobId,
      reference: archive.reference,
      manifest: semantic.manifest,
      semanticHandle: semantic.handle,
      semanticCalls: semantic.calls,
      publicationId: publication.publicationId,
      publicationCalls: publication.calls,
    });
    emit('month-published', { month, records: semantic.manifest.recordCount, parts: semantic.manifest.parts.length });
  }

  const publishedSourceCount = async (): Promise<number> => Number(await app!.db.prepare(
    'SELECT count(*) AS n FROM visits WHERE substr(original_check_in_at,1,7) IN (SELECT value FROM json_each(?))',
  ).bind(JSON.stringify(selected)).first<number>('n'));
  const publishedSourceVisitsBefore = await publishedSourceCount();
  if (evictAllPublished && publishedSourceVisitsBefore === 0) {
    throw new Error('Full published-month eviction has no source visits to measure.');
  }
  const storagePages = async () => {
    const probe = await app!.db.prepare('SELECT 1 AS probe').all();
    return { allocatedBytes: Number(probe.meta.size_after) };
  };
  const storageBeforeEviction = await storagePages();
  await app.db.prepare(`UPDATE history_retention_policies
    SET live_tier_days=?,max_candidates=?,revision=revision+1,updated_at=?,updated_by=?
    WHERE center_id='test-center'`).bind(
    liveTierDays,
    evictAllPublished ? 100 : 25,
    new Date(Date.now() + 1_000).toISOString(),
    actor.id,
  ).run();
  const firstLimit = evictAllPublished ? Math.min(100, publishedSourceVisitsBefore) : (evictVerified > 0 ? evictVerified : undefined);
  const retention = await completeRetentionDryRun(app, { bucket, masterKey: syntheticKey }, actor, firstLimit);
  const retentionJob = await app.db.prepare(
    'SELECT live_tier_days,live_cutoff FROM history_retention_jobs WHERE job_id=?',
  ).bind(retention.jobId).first<{ live_tier_days: number; live_cutoff: string }>();
  if (Number(retentionJob?.live_tier_days) !== liveTierDays
    || retentionJob?.live_cutoff.slice(0, 10) !== archiveCutoffDate(asOf, liveTierDays)) {
    throw new Error('Archive selection and retention job use different live-tier cutoffs.');
  }
  emit('retention-complete', retention);
  const evictionRehearsal = {
    requested: evictAllPublished ? 'all-published' : String(evictVerified),
    evicted: 0,
    jobs: 0,
    publishedSourceVisitsBefore,
    publishedSourceVisitsAfter: publishedSourceVisitsBefore,
    oldestRemainingVisitAt: null as string | null,
    oldestRemainingAgeDays: null as number | null,
    sourceVisitsRemoved: 0,
    sourceEventsRemoved: 0,
    sourceCorrectionsRemoved: 0,
    sourceAuditsRemoved: 0,
    storageBeforeEviction,
    storageAfterEviction: storageBeforeEviction,
  };
  if (evictVerified > 0 || evictAllPublished) {
    await app.db.prepare(`UPDATE history_source_eviction_policies
      SET enabled=1,revision=revision+1,updated_at=?,updated_by=?
      WHERE center_id='test-center'`).bind(now(), actor.id).run();
    const evictJob = async (job: { jobId: string; processed: number }, count: number) => {
      if (job.processed !== count) {
        throw new Error(`Retention job verified ${job.processed} visits, expected ${count}.`);
      }
      const candidates = (await app!.db.prepare(
        'SELECT visit_id FROM history_retention_items WHERE job_id=? ORDER BY sequence LIMIT ?',
      ).bind(job.jobId, count).all<{ visit_id: string }>()).results;
      if (candidates.length !== count) throw new Error('Verified eviction candidate count changed.');
      for (const candidate of candidates) {
        const receipt = await evictRetentionSource(
          app!.db as unknown as D1Database,
          { bucket, masterKey: syntheticKey },
          job.jobId,
          candidate.visit_id,
          actor.id,
        );
        if (receipt.alreadyComplete || receipt.visitId !== candidate.visit_id || receipt.sourceCounts.visits !== 1) {
          throw new Error(`Unexpected source-eviction receipt for ${candidate.visit_id}.`);
        }
        evictionRehearsal.evicted += 1;
        evictionRehearsal.sourceVisitsRemoved += receipt.sourceCounts.visits;
        evictionRehearsal.sourceEventsRemoved += receipt.sourceCounts.events;
        evictionRehearsal.sourceCorrectionsRemoved += receipt.sourceCounts.corrections;
        evictionRehearsal.sourceAuditsRemoved += receipt.sourceCounts.audits;
      }
      const remaining = await app!.db.prepare(
        'SELECT count(*) AS n FROM visits WHERE id IN (SELECT value FROM json_each(?))',
      ).bind(JSON.stringify(candidates.map(candidate => candidate.visit_id))).first<number>('n');
      if (Number(remaining) !== 0) throw new Error('Evicted source visits remain in D1.');
      evictionRehearsal.jobs += 1;
      evictionRehearsal.publishedSourceVisitsAfter = await publishedSourceCount();
      emit('source-eviction-rehearsal', {
        job: evictionRehearsal.jobs,
        evicted: evictionRehearsal.evicted,
        remaining: evictionRehearsal.publishedSourceVisitsAfter,
      });
    };
    if (evictAllPublished) {
      await evictJob(retention, firstLimit!);
      for (let job = 1; evictionRehearsal.publishedSourceVisitsAfter > 0; job += 1) {
        if (job > 1_000) throw new Error('Published-month eviction exceeded 1,000 bounded jobs.');
        const limit = Math.min(100, evictionRehearsal.publishedSourceVisitsAfter);
        const next = await completeRetentionDryRun(
          app,
          { bucket, masterKey: syntheticKey },
          actor,
          limit,
          false,
        );
        await evictJob(next, limit);
      }
      if (evictionRehearsal.evicted !== publishedSourceVisitsBefore) {
        throw new Error('Not every source visit in the published months was evicted.');
      }
    } else {
      await evictJob(retention, evictVerified);
    }
    const oldest = await app.db.prepare(
      'SELECT min(original_check_in_at) AS at FROM visits',
    ).first<{ at: string | null }>();
    evictionRehearsal.oldestRemainingVisitAt = oldest?.at ?? null;
    if (oldest?.at) {
      evictionRehearsal.oldestRemainingAgeDays = Math.floor(
        (Date.parse(`${asOf}T00:00:00.000Z`) - Date.parse(`${oldest.at.slice(0, 10)}T00:00:00.000Z`)) / 86_400_000,
      );
    }
    if (evictAllPublished && evictionRehearsal.oldestRemainingAgeDays !== null
      && evictionRehearsal.oldestRemainingAgeDays > liveTierDays + 31) {
      throw new Error('Published-month eviction left an older-than-monthly-buffer live visit.');
    }
    evictionRehearsal.storageAfterEviction = await storagePages();
  }
  const reportFrom = selected[0] + '-01';
  const reportTo = new Date(Date.UTC(Number(selected.at(-1)!.slice(0, 4)), Number(selected.at(-1)!.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const student = await requestJson<Record<string, unknown>>(app, token, `/api/admin/students/${fixtureId(1, 0)}`);
  const report = await requestJson<Record<string, unknown>>(app, token, `/api/admin/history?from=${reportFrom}&to=${reportTo}&pageSize=50`);
  const applicationChecks = {
    studentDetailReturnedBeforeRecoveryReset: Object.keys(student).length > 0,
    historyPageReturnedBeforeRecoveryReset: Object.keys(report).length > 0,
  };
  emit('application-checks-complete', applicationChecks);
  emit('backup-capture-start');
  const captured = await captureBackupJob(app, env, syntheticKey);
  emit('backup-capture-complete', { tables: Object.keys(captured.counts).length, archiveReferences: captured.references.length });
  if (captured.schemaVersions.at(-1) !== 41) throw new Error(`Expected schema 41, received ${captured.schemaVersions.at(-1)}.`);
  const expectedReferences = publications.map(value => value.reference).sort((a, b) => a.archiveId.localeCompare(b.archiveId));
  const actualReferences = [...captured.references].sort((a, b) => a.archiveId.localeCompare(b.archiveId));
  if (JSON.stringify(actualReferences) !== JSON.stringify(expectedReferences)) {
    throw new Error(`Backup archive pin mismatch: expected ${expectedReferences.length}, received ${actualReferences.length}.`);
  }

  emit('database-snapshot-start');
  const sqlText = await snapshotDatabase(app);
  emit('database-snapshot-complete', { bytes: Buffer.byteLength(sqlText) });
  const sql = new TextEncoder().encode(sqlText);
  const backupRoot = join(work, 'backup');
  const archiveRoot = join(work, 'archives');
  const recoveryOutput = join(work, 'restored.sql');
  const keyPath = join(work, 'recovery.key');
  await writeFile(keyPath, `${syntheticKey}\n`, { mode: 0o600 });
  const manifest = await createEncryptedBackup(backupRoot, syntheticKey, captured, sql);
  const r2Objects = await listBucketObjects(bucket);
  await writeArchiveObjects(bucket, archiveRoot, r2Objects);
  const recoveryStarted = performance.now();
  const cli = await runRecoveryCli(backupRoot, recoveryOutput, archiveRoot, keyPath);
  let cliSummary: unknown = cli.stdout.trim();
  try {
    cliSummary = JSON.parse(cli.stdout);
  } catch {
    // Preserve non-JSON recovery output without treating formatting as failure.
  }
  const recoveryWallMs = performance.now() - recoveryStarted;
  const restored = verifyRestoredSql(recoveryOutput, captured.counts);

  const reconciliation = await resetAndReconcile(app, bucket, syntheticKey, publications);
  const historyRuntime = await app.db.prepare('SELECT state,generation FROM history_runtime WHERE id=1').first<{ state: string; generation: string }>();
  const availability = (await app.db.prepare("SELECT publication_id,status,generation FROM archive_compact_availability ORDER BY publication_id")
    .all<{ publication_id: string; status: string; generation: string }>()).results;
  if (!historyRuntime || historyRuntime.state !== 'ready' || availability.some(row => row.status !== 'ready' || row.generation !== historyRuntime.generation)) {
    throw new Error('Recovered compact authority did not reconcile to the current history generation.');
  }
  const sizeProbe = await app.db.prepare('SELECT 1 AS probe').all();
  const d1Bytes = Number(sizeProbe.meta.size_after);

  const evidence = {
    kind: 'schema41-isolated-realistic-scale-archive-combined-recovery',
    capturedAt: now(),
    status: 'PASS',
    scope: {
      isolatedSyntheticOnly: true,
      remoteCloudflareChanged: false,
      railwayChanged: false,
      sourceEvictionEnabled: evictionRehearsal.evicted > 0,
      fullPublishedMonthEvictionRehearsed: evictAllPublished,
      r2DeletionEnabled: false,
      providerExportExercised: false,
      cloudRestoreExercised: false,
    },
    policy: {
      fixtureDayLayout: dayLayout,
      liveTierDays,
      cutoff: archiveCutoffDate(asOf, liveTierDays),
      eligibleCompleteMonths: eligible,
      selectedRepresentativeMonths: selected,
    },
    fixture,
    initialHistoryBackfillCalls,

    sourceDatabaseBytes: d1Bytes,
    publications: publications.map(value => ({
      month: value.month,
      archiveId: value.reference.archiveId,
      records: value.manifest.recordCount,
      plaintextBytes: value.manifest.plaintextBytes,
      parts: value.manifest.parts.length,
      semanticCalls: value.semanticCalls,
      publicationCalls: value.publicationCalls,
    })),
    retention: { ...retention, liveTierDays: retentionJob.live_tier_days, liveCutoff: retentionJob.live_cutoff },
    evictionRehearsal,
    r2: {
      objects: r2Objects.length,
      encryptedBytes: r2Objects.reduce((sum, object) => sum + object.size, 0),
      objectInventorySha256: sha256(JSON.stringify(r2Objects)),
    },
    backup: {
      schemaVersion: captured.schemaVersions.at(-1),
      tables: BACKUP_TABLES.length,
      archiveReferences: captured.references.length,
      sqlBytes: manifest.sqlBytes,
      sqlSha256: sha256(sql),
      encryptedParts: manifest.parts.length,
    },
    independentRecovery: {
      recoveryWallMs,
      cliSummary,
      restored,
    },
    recoveryReconciliation: {
      historyGeneration: historyRuntime.generation,
      publicationsReady: availability.length,
      months: reconciliation,
    },
    applicationChecks,
    limits: [
      'This is isolated workerd, local SQLite, and local R2 evidence. It does not measure deployed Worker CPU, remote D1 allocation, replication, network latency, Queue pacing, or provider billing.',
      'The encrypted SQL bundle is built from the same isolated D1 snapshot shape used by recovery tests. No Cloudflare export API or Worker-to-R2 delivery is exercised.',
      evictAllPublished
        ? `A local test policy evicted all ${evictionRehearsal.evicted} source visits in every eligible complete published month of this fixture. This is not deployed deletion safety or a multi-year Free-plan capacity measurement; no R2 object was deleted.`
        : evictionRehearsal.evicted > 0
          ? `A local test policy evicted ${evictionRehearsal.evicted} verified visits after the default-disabled check. This does not demonstrate full ${liveTierDays}-day D1 retention, file-space reclamation, or deployed deletion safety; no R2 object was deleted.`
          : 'Source eviction was called only to prove that the default policy blocks it. No source row or R2 object was deleted.',
      'Production release still requires populated cloud backup delivery and independent cloud restoration, deployed capacity, cutover and rollback, physical device and staff acceptance, ownership transfer, and written customer acceptance.',
    ],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  emit('complete', { outputPath, bytes: (await stat(outputPath)).size, evidenceSha256: sha256(await readFile(outputPath)) });
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
