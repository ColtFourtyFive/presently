/** Isolated synthetic archive measurement. Never uses a configured remote binding. */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { unstable_splitSqlQuery } from 'wrangler';
import { createRuntime, testAudience, testIssuer } from '../tests/runtime';
import { sourcePage, type ArchiveJob } from '../worker/archive-source';
import type { Env } from '../worker/types';
import type { Actor } from '../shared/types';
import { ARCHIVE_TABLES, type ArchiveMetadata, type ArchiveRecord } from '../shared/archive-format';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { verifyArchiveSemantics } from '../worker/archive-semantics';

process.umask(0o077);
const [mode, requestedOutput, baselineArgument, measurementLabel = 'final'] = process.argv.slice(2);
if (!['generate', 'measure'].includes(mode) || !requestedOutput) throw new Error('Use generate OUTPUT or measure OUTPUT BASELINE_SQLITE. All data is isolated and synthetic.');
if (!/^[a-z0-9-]{1,40}$/.test(measurementLabel)) throw new Error('Invalid measurement label');
const output = resolve(requestedOutput);
const encoder = new TextEncoder();
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64');
const versions = async () => (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort();
const jsonFile = (name: string, data: unknown) => writeFile(resolve(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

async function generate() {
  await mkdir(output, { recursive: false, mode: 0o700 });
  const key = randomBytes(32).toString('base64');
  const app = await createRuntime({ migrate: false, r2: true, bindings: { APP_ENV: 'local', CENTER_ID: 'test-center', APP_VERSION: 'isolated-semantic-month', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', ARCHIVE_ENABLED: 'true', BACKUP_KEY: key } });
  try {
    // Fixed source schema makes this historical source reproducible while later
    // admission migrations are tested only in the separate destination.
    for (const name of await versions()) if (Number(name.slice(0, 4)) <= 19) await app.db.batch(unstable_splitSqlQuery(await readFile(resolve('migrations', name), 'utf8')).map(sql => app.db.prepare(sql)));
    const token = await app.signer.token({ exp: Math.floor(Date.now() / 1000) + 7200 });
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await app.request(path, { token, body });
      if (!response.ok) throw new Error(`Isolated source request failed: ${response.status} ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    const { actor } = await request<{ actor: Actor }>('/api/admin/session');
    const at = new Date().toISOString(), staff = [actor.id], guardians = Array.from({ length: 460 }, () => crypto.randomUUID());
    const students = Array.from({ length: 340 }, () => crypto.randomUUID());
    const pending: ReturnType<typeof app.db.prepare>[] = [];
    const flush = async () => { if (pending.length) await app.db.batch(pending.splice(0)); };
    for (let i = 1; i < 8; i++) {
      staff.push(crypto.randomUUID());
      pending.push(app.db.prepare("INSERT INTO staff(id,center_id,email,display_name,role,active,created_at,updated_at) VALUES(?,'test-center',?,?,'manager',1,?,?)").bind(staff[i], `synthetic-${i}@example.test`, `Synthetic Staff ${i}`, at, at));
    }
    for (const [i, id] of guardians.entries()) {
      pending.push(app.db.prepare("INSERT INTO guardians(id,center_id,display_name,created_at) VALUES(?,'test-center',?,?)").bind(id, `Synthetic Guardian ${i}`, at));
      if (pending.length >= 32) await flush();
    }
    await flush();
    for (const [i, id] of students.entries()) {
      pending.push(app.db.prepare("INSERT INTO students(id,center_id,student_code,first_name,last_name,subjects,created_at,updated_at) VALUES(?,'test-center',?,'Synthetic',?,'[\"Math\",\"Reading\"]',?,?)").bind(id, `S-${String(i).padStart(4, '0')}`, `Student ${i}`, at, at));
      pending.push(app.db.prepare("INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note) VALUES(?,?,'Parent','allowed','Synthetic authority evidence')").bind(id, guardians[i]));
      pending.push(app.db.prepare("INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority) VALUES(?,?,'Contact','unverified')").bind(id, guardians[(i + 340) % guardians.length]));
      if (pending.length >= 30) await flush();
    }
    await flush();
    const device = crypto.randomUUID(), enrollment = crypto.randomUUID();
    await app.db.batch([
      app.db.prepare("INSERT INTO device_enrollments(id,center_id,token_hash,expires_at,created_by,created_at) VALUES(?,'test-center',?,?,?,?)").bind(enrollment, crypto.randomUUID(), at, actor.id, at),
      app.db.prepare("INSERT INTO kiosk_devices(id,center_id,enrollment_id,token_hash,label,created_at,expires_at) VALUES(?,'test-center',?,?,'Synthetic scale device',?,?)").bind(device, enrollment, crypto.randomUUID(), at, at),
    ]);
    const actorNames = new Map((await app.db.prepare('SELECT id,display_name FROM staff').all<{ id: string; display_name: string }>()).results.map(row => [row.id, row.display_name]));
    const visits: string[] = [], arrivals: string[] = [], departures: string[] = [];
    const event = (studentId: string, visitId: string | null, action: string, observedAt: string, operator: string, guardianId: string | null, reason: string | null, kiosk = false) => {
      const id = crypto.randomUUID();
      pending.push(app.db.prepare('INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, 'test-center', studentId, visitId, action, observedAt, observedAt, operator, actorNames.get(operator)!, kiosk ? 'kiosk' : 'admin', kiosk ? device : null, guardianId, reason, fingerprint({ studentId, action, observedAt, guardianId, reason }), crypto.randomUUID()));
      return id;
    };
    let linkedException = '';
    for (let i = 0; i < 2550; i++) {
      const student = i % students.length, visit = crypto.randomUUID(), day = 1 + Math.floor(i / 170);
      const arrived = new Date(Date.UTC(2025, 0, day, 18)).toISOString(), departed = new Date(Date.UTC(2025, 0, day, 19)).toISOString();
      visits.push(visit); arrivals.push(arrived); departures.push(departed);
      event(students[student], visit, 'check_in', arrived, staff[i % staff.length], null, null);
      const departure = event(students[student], visit, i === 0 ? 'exceptional_departure' : 'check_out', departed, staff[i % staff.length], i === 0 ? null : guardians[student], i === 0 ? 'Observed exceptional departure in synthetic month' : null, i === 0);
      if (i === 0) linkedException = departure;
      if (pending.length >= 32) await flush();
      if (i % 500 === 0) console.log(JSON.stringify({ phase: 'native-source', visits: i }));
    }
    await flush();
    const unmatched = event(students[1], null, 'exceptional_departure', '2025-01-25T20:00:00.000Z', actor.id, null, 'Observed unmatched synthetic departure');
    await flush();
    for (let i = 0; i < 25; i++) {
      const target = i < 9 ? 0 : i - 8, offset = i < 9 ? i + 1 : 1;
      await request(`/api/admin/visits/${visits[target]}/corrections`, { correctionId: crypto.randomUUID(), expectedVersion: i < 9 ? i + 2 : 2, checkInAt: new Date(Date.parse(arrivals[target]) + offset * 1000).toISOString(), checkOutAt: new Date(Date.parse(departures[target]) + offset * 1000).toISOString(), reason: `Synthetic scale correction ${i}` });
    }
    for (const review of [linkedException, unmatched]) await request(`/api/admin/reviews/${review}/resolve`, { resolution: 'Synthetic departure evidence reviewed' });
    const started = await request<{ jobId: string }>('/api/admin/archives/start', { month: '2025-01' });
    const job = await app.db.prepare('SELECT * FROM archive_jobs WHERE id=?').bind(started.jobId).first<ArchiveJob>();
    if (!job) throw new Error('Missing isolated source snapshot');
    const records: ArchiveRecord[] = [];
    // TestRuntime is an RPC transport to actual local D1, not a production Env.
    const env = { CRM_DB: app.db } as unknown as Env;
    for (let table = 0; table < ARCHIVE_TABLES.length; table++) {
      let after = '';
      for (;;) { const page = await sourcePage(env, job, table, after, 256); records.push(...page); if (page.length < 256) break; after = page.at(-1)!.key; }
    }
    const metadata: ArchiveMetadata = { archiveId: crypto.randomUUID(), centerId: 'test-center', month: job.month, timezone: job.timezone, kind: 'monthly', createdAt: job.created_at, applicationVersion: 'native-full-month-fixture', schemaVersions: JSON.parse(job.schema_json), references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [{ id: device, centerId: 'test-center' }] } };
    const serialized = JSON.stringify(records);
    await writeFile(resolve(output, 'source-records.json'), serialized, { flag: 'wx', mode: 0o600 });
    await jsonFile('source-metadata.json', metadata);
    await writeFile(resolve(output, 'synthetic-fixture.key'), key, { flag: 'wx', mode: 0o600 });
    await jsonFile('source-evidence.json', { capturedAt: new Date().toISOString(), scope: 'Synthetic current-trigger-generated records in isolated native workerd/D1; source closes before staging.', schemaVersion: 19, sourceSha256: sha(serialized), counts: Object.fromEntries(ARCHIVE_TABLES.map(table => [table, records.filter(r => r.table === table).length])), recordJsonBytes: records.reduce((n, r) => n + encoder.encode(JSON.stringify(r)).length, 0), d1Meta: (await app.db.prepare('SELECT 1').all()).meta });
    console.log(JSON.stringify({ phase: 'source-complete', records: records.length, output }));
  } finally { await app.close(); }
}

function sqliteTransport(db: DatabaseSync) {
  let statements = 0;
  class Statement {
    constructor(readonly sql: string, readonly args: SQLInputValue[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values as SQLInputValue[]); }
    result() { statements++; return { results: db.prepare(this.sql).all(...this.args), meta: { size_after: Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size), served_by_primary: true } }; }
  }
  return { prepare: (sql: string) => new Statement(sql), get statements() { return statements; }, async batch<T = Record<string, unknown>>(items: Statement[]) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = items.map(item => item.result()); db.exec('COMMIT'); return result as { results: T[]; meta: { size_after: number; served_by_primary: boolean } }[]; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

async function measure() {
  if (!baselineArgument) throw new Error('An existing isolated synthetic baseline is required');
  const baseline = resolve(baselineArgument), baselineHash = sha(await readFile(baseline));
  const path = resolve(output, `measured-${measurementLabel}.sqlite`);
  await copyFile(baseline, path, constants.COPYFILE_EXCL); await chmod(path, 0o600);
  const source = await readFile(resolve(output, 'source-records.json'), 'utf8');
  const evidence = JSON.parse(await readFile(resolve(output, 'source-evidence.json'), 'utf8')) as { sourceSha256: string };
  if (sha(source) !== evidence.sourceSha256) throw new Error('Synthetic source evidence changed');
  const records: ArchiveRecord[] = JSON.parse(source), metadata: ArchiveMetadata = JSON.parse(await readFile(resolve(output, 'source-metadata.json'), 'utf8'));
  const master = await readFile(resolve(output, 'synthetic-fixture.key'), 'utf8');
  const sqlite = new DatabaseSync(path); sqlite.exec('PRAGMA foreign_keys=ON');
  const db = sqliteTransport(sqlite), snapshots: Record<string, unknown> = {};
  const progress = async (phase: string, detail: Record<string, unknown> = {}) => writeFile(resolve(output, `measurement-${measurementLabel}-progress.json`), JSON.stringify({ capturedAt: new Date().toISOString(), phase, sourceSha256: evidence.sourceSha256, snapshots, ...detail }, null, 2) + '\n', { mode: 0o600 });
  const privateTables = ['archive_semantic_sessions', 'archive_semantic_manifests', 'archive_semantic_parts', 'archive_semantic_rows', 'archive_semantic_runs', 'archive_semantic_operations', 'archive_semantic_visit_totals', 'archive_semantic_review_witnesses'];
  const snapshot = () => { const page = Number(sqlite.prepare('PRAGMA page_size').get()!.page_size), count = Number(sqlite.prepare('PRAGMA page_count').get()!.page_count), free = Number(sqlite.prepare('PRAGMA freelist_count').get()!.freelist_count); return { allocatedBytes: page * count, usedBytes: page * (count - free), freeBytes: page * free, counts: Object.fromEntries(privateTables.map(table => [table, Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)])) }; };
  try {
    const current = Number(sqlite.prepare('SELECT max(version) AS version FROM schema_versions').get()!.version);
    for (const name of await versions()) if (Number(name.slice(0, 4)) > current) sqlite.exec(await readFile(resolve('migrations', name), 'utf8'));
    snapshots.baseline = snapshot();
    await progress('baseline');
    const parts = new Map<string, Uint8Array>();
    const sealed = await createArchive(master, metadata, records, async (part, encrypted) => { parts.set(part.objectKey, encrypted); });
    const reference = { archiveId: sealed.manifest.archiveId, kind: sealed.manifest.kind, manifestObjectKey: sealed.objectKey, manifestSha256: sealed.sha256 };
    const staging = await D1ArchiveSemanticStaging.create(db, master, reference);
    await staging.registerManifest(reference, sealed.encrypted);
    for (const part of sealed.manifest.parts) await staging.stageEncryptedPart(sealed.manifest.archiveId, part.index, parts.get(part.objectKey)!);
    const frozen = await staging.freeze(); snapshots.staged = snapshot();
    await progress('staged', { recordCount: sealed.manifest.recordCount, plaintextBytes: sealed.manifest.plaintextBytes, parts: sealed.manifest.parts.length });
    const run = await startMonthlySemanticVerification(db, { ...staging.handle, commitToken: frozen.commitToken, graphSha256: frozen.graphSha256 });
    let calls = 0, maximumStatements = 0; const started = performance.now();
    for (;;) {
      const before = db.statements, step = await advanceMonthlySemanticVerification(db, run), actual = db.statements - before;
      calls++; maximumStatements = Math.max(maximumStatements, actual);
      if (actual !== step.queries || actual > 40) throw new Error('Statement bound/accounting mismatch');
      if (calls % 1000 === 0) { console.log(JSON.stringify({ phase: 'verify', calls, records: step.processed })); await progress('verifying', { calls, maximumStatements }); }
      if (step.status === 'complete') break;
      if (step.status !== 'pending' || calls > 40000) throw new Error(`Unexpected benchmark progress: ${step.status}`);
    }
    const runnerMs = performance.now() - started; snapshots.verified = snapshot();
    await progress('runner-complete', { calls, maximumStatements, runnerMs });
    await verifyArchiveSemantics(frozen.manifests, frozen.semanticStore);
    const expectedOperations = records.filter(r => r.table === 'attendance_corrections' || r.table === 'attendance_events' && r.row.visit_id !== null).length;
    const expectedVisits = records.filter(r => r.table === 'visits').length, expectedWitnesses = records.filter(r => r.table === 'reviews' && r.row.status === 'resolved').length;
    for (const [table, expected] of [['archive_semantic_operations', expectedOperations], ['archive_semantic_visit_totals', expectedVisits], ['archive_semantic_review_witnesses', expectedWitnesses], ['archive_semantic_runs', 1]] as const) if (Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) !== expected) throw new Error(`Derived count mismatch: ${table}`);
    await progress('oracle-complete', { calls, maximumStatements, runnerMs, expectedOperations, expectedVisits, expectedWitnesses });
    await staging.discard(); const cleanup = await D1ArchiveSemanticStaging.beginCleanup(db, staging.handle); let cleanupCalls = 0, maxDeleted = 0;
    for (;;) { const page = await D1ArchiveSemanticStaging.cleanupPage(db, cleanup); cleanupCalls++; maxDeleted = Math.max(maxDeleted, page.deleted); if (page.complete) break; if (cleanupCalls > 3000) throw new Error('Cleanup bound'); }
    snapshots.cleaned = snapshot();
    await progress('cleaned', { calls, maximumStatements, runnerMs, cleanupCalls, maxDeleted });
    for (const table of privateTables) if (Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) !== 0) throw new Error(`Cleanup incomplete: ${table}`);
    if (sqlite.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid measurement database');
    const schemaVersion = Number(sqlite.prepare('SELECT max(version) AS n FROM schema_versions').get()!.n);
    sqlite.close(); const closedBeforeVacuum = (await stat(path)).size;
    const vacuum = new DatabaseSync(path); vacuum.exec('VACUUM'); vacuum.close();
    if (baselineHash !== sha(await readFile(baseline))) throw new Error('Baseline changed');
    await jsonFile(`measurement-${measurementLabel}.json`, { capturedAt: new Date().toISOString(), scope: 'Full-month native D1-generated synthetic evidence, authenticated and verified in a separate local primary SQLite database. Local allocation and statement counts only; not deployed CPU, D1 quota or remote reclamation.', schemaVersion, baseline, baselineSha256: baselineHash, sourceSha256: evidence.sourceSha256, recordCount: sealed.manifest.recordCount, plaintextBytes: sealed.manifest.plaintextBytes, parts: sealed.manifest.parts.length, snapshots, runner: { completed: true, oraclePassed: true, calls, maximumStatements, localSQLiteMs: runnerMs, expectedOperations, expectedVisits, expectedWitnesses }, cleanup: { calls: cleanupCalls, maxDeleted, closedBeforeVacuum, closedAfterVacuum: (await stat(path)).size }, baselineUnchanged: true });
    console.log(JSON.stringify({ phase: 'measurement-complete', calls, maximumStatements, output }));
  } catch (error) { try { sqlite.close(); } catch { /* Already closed after verification. */ } throw error; }
}
await (mode === 'generate' ? generate() : measure());
