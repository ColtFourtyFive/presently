import { unstable_splitSqlQuery } from 'wrangler';
import { createArchive, openArchiveManifest } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { advanceHistoryBackfill } from '../worker/history-lookup';
import type { ArchiveReference } from '../shared/archive-format';
import type { AdminSession } from '../shared/types';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { json, type App } from './helpers';
import { createRuntime, testAudience, testIssuer, type RuntimeOptions, type TestRuntime } from './runtime';

export type PublicationSnapshotOptions = {
  omitTables?: readonly string[];
  transformRow?: (table: string, row: Record<string, unknown>) => Record<string, unknown> | null;
};

/** Test-only SQL export. Original native guards are recreated after data rows,
 * so omission/corruption tests need not remove guards from an operating DB. */
export async function snapshotPublicationDatabase(app: TestRuntime, options: PublicationSnapshotOptions = {}): Promise<string> {
  const objects = (await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all<{ name: string; type: string; sql: string }>()).results;
  const tables = objects.filter(object => object.type === 'table'), omitted = new Set(options.omitTables);
  for (const table of omitted) if (!tables.some(item => item.name === table)) throw new Error(`Unknown fixture table: ${table}`);
  const literal = (value: unknown): string => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  const lines = tables.map(table => `${table.sql};`);
  for (const table of tables) {
    if (omitted.has(table.name)) continue;
    for (const original of (await app.db.prepare(`SELECT * FROM "${table.name}"`).all<Record<string, unknown>>()).results) {
      const row = options.transformRow ? options.transformRow(table.name, { ...original }) : original;
      if (row) lines.push(`INSERT INTO "${table.name}" (${Object.keys(row).map(name => `"${name}"`).join(',')}) VALUES (${Object.values(row).map(literal).join(',')});`);
    }
  }
  lines.push(...objects.filter(object => object.type !== 'table').map(object => `${object.sql};`));
  return lines.join('\n');
}

export async function createPublicationSeed() {
  let sourceSql = '';
  const seed = await nativeSemanticFixture(1, true, async app => { sourceSql = await snapshotPublicationDatabase(app); });
  if (!sourceSql) throw new Error('Publication fixture source snapshot missing');
  return { ...seed, sourceSql };
}
export type PublicationSeed = Awaited<ReturnType<typeof createPublicationSeed>>;

export async function restorePublicationDatabase(sql: string, options: Partial<RuntimeOptions> = {}): Promise<TestRuntime> {
  const app = await createRuntime({ ...options, migrate: false, r2: options.r2 ?? true, bindings: options.bindings ?? {} });
  try {
    await app.db.batch(['PRAGMA defer_foreign_keys=ON', ...unstable_splitSqlQuery(sql)].map(statement => app.db.prepare(statement)));
    return app;
  } catch (error) { await app.close(); throw error; }
}

/** Reverify the same authenticated publication graph under the current restore
 * generation. This uses detached evidence, so operational receipt rows may be
 * absent and prior staff sessions may remain disabled. No catalog rows change. */
export async function refreshPublicationProof(app: TestRuntime, evidence: { key: string; reference: ArchiveReference; objects: ReadonlyMap<string, Uint8Array> }) {
  const nativeDB = await app.runtime.getD1Database('CRM_DB');
  for (let step = 0; ; step++) {
    if (step > 12) throw new Error('Refreshed publication history backfill did not finish');
    if ((await advanceHistoryBackfill(nativeDB)).state === 'ready') break;
  }
  const sessions = (await app.db.prepare('SELECT verification_id,generation,status FROM archive_semantic_sessions').all<{ verification_id: string; generation: string; status: string }>()).results;
  for (const session of sessions) {
    if (session.status !== 'invalid') throw new Error('Refreshed publication requires prior staging to be invalid');
    const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, { verificationId: session.verification_id, generation: session.generation });
    for (let step = 0; ; step++) {
      if (step > 500) throw new Error('Refreshed publication private staging cleanup did not finish');
      if ((await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).complete) break;
    }
  }
  const encrypted = evidence.objects.get(evidence.reference.manifestObjectKey);
  if (!encrypted) throw new Error('Refreshed publication manifest unavailable');
  const manifest = await openArchiveManifest(evidence.key, encrypted, evidence.reference);
  const staging = await D1ArchiveSemanticStaging.create(app.db, evidence.key, evidence.reference);
  await staging.registerManifest(evidence.reference, encrypted);
  for (const part of manifest.parts) {
    const bytes = evidence.objects.get(part.objectKey);
    if (!bytes) throw new Error('Refreshed publication part unavailable');
    await staging.stageEncryptedPart(evidence.reference.archiveId, part.index, bytes);
  }
  const snapshot = await staging.freeze();
  const handle = await startMonthlySemanticVerification(app.db, { ...staging.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
  for (let step = 0; ; step++) {
    if (step > 500) throw new Error('Refreshed publication semantic runner did not finish');
    const result = await advanceMonthlySemanticVerification(app.db, handle);
    if (result.status === 'complete') break;
    if (result.status !== 'pending') throw new Error(`Refreshed publication semantic runner is ${result.status}`);
  }
  return { staging, snapshot, handle, nativeDB };
}

/** Real native operational rows plus their detached v2 evidence and completed
 * private semantic run. This does not publish or evict any source records. */
export async function createPublicationFixture(source?: PublicationSeed) {
  const seed = source ?? await createPublicationSeed();
  const runtime = await restorePublicationDatabase(seed.sourceSql, { metrics: true, bindings: { APP_ENV: 'local', CENTER_ID: 'test-center', APP_VERSION: 'publication-test', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', BACKUP_KEY: seed.key, ARCHIVE_ENABLED: 'true', CF_ACCOUNT_ID: 'isolated-publication-account', CF_DATABASE_ID: 'isolated-publication-database', CF_EXPORT_API_TOKEN: 'isolated-no-network-token' } });
  try {
    const token = await runtime.signer.token();
    const session = await json<AdminSession>(await runtime.request('/api/admin/session', { token }));
    const app: App = { ...runtime, token, actor: session.actor };
    const nativeDB = await app.runtime.getD1Database('CRM_DB'), bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    for (let step = 0; ; step++) {
      if (step > 12) throw new Error('Publication fixture history backfill did not finish');
      if ((await advanceHistoryBackfill(nativeDB)).state === 'ready') break;
    }
    const objects = new Map<string, Uint8Array>();
    const archive = await createArchive(seed.key, { ...seed.metadata, archiveId: crypto.randomUUID() }, seed.records, async (part, bytes) => { objects.set(part.objectKey, bytes); });
    objects.set(archive.objectKey, archive.encrypted);
    for (const [key, bytes] of objects) await bucket.put(key, bytes);
    const reference: ArchiveReference = { archiveId: archive.manifest.archiveId, kind: archive.manifest.kind, manifestObjectKey: archive.objectKey, manifestSha256: archive.sha256 };
    const staging = await D1ArchiveSemanticStaging.create(app.db, seed.key, reference);
    await staging.registerManifest(reference, archive.encrypted);
    for (const part of archive.manifest.parts) await staging.stageEncryptedPart(reference.archiveId, part.index, objects.get(part.objectKey)!);
    const snapshot = await staging.freeze();
    const handle = await startMonthlySemanticVerification(app.db, { ...staging.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
    for (let step = 0; ; step++) {
      if (step > 500) throw new Error('Publication fixture semantic run did not finish');
      const result = await advanceMonthlySemanticVerification(app.db, handle);
      if (result.status === 'complete') break;
      if (result.status !== 'pending') throw new Error(`Publication fixture semantic run stopped: ${result.status}`);
    }
    return { app, seed, key: seed.key, records: seed.records, metadata: seed.metadata, objects, archive, reference, staging, snapshot, handle, nativeDB, bucket };
  } catch (error) { await runtime.close(); throw error; }
}
