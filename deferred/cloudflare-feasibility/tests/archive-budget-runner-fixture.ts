import { createHash } from 'node:crypto';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging } from '../worker/archive-semantic-store';
import { startMonthlySemanticVerification, type MonthlySemanticRunHandle, type MonthlySemanticRunSelection } from '../worker/archive-semantic-runner';
import type { nativeSemanticFixture } from './archive-semantic-fixture';
import { openBudgetFixture } from './archive-budget-fixture';
import type { TestRuntime } from './runtime';

export async function createBudgetRunnerFixture(app: TestRuntime, source: Awaited<ReturnType<typeof nativeSemanticFixture>>) {
  const objects = new Map<string, Uint8Array>();
  const archive = await createArchive(source.key, { ...source.metadata, archiveId: crypto.randomUUID() }, source.records,
    async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const reference = { archiveId: archive.manifest.archiveId, kind: archive.manifest.kind, manifestObjectKey: archive.objectKey, manifestSha256: archive.sha256 };
  const target = await D1ArchiveSemanticStaging.create(app.db, source.key, reference);
  await target.registerManifest(reference, archive.encrypted);
  for (const part of archive.manifest.parts) await target.stageEncryptedPart(reference.archiveId, part.index, objects.get(part.objectKey)!);
  const snapshot = await target.freeze();
  const handle = await startMonthlySemanticVerification(app.db, { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
  const { identity } = await openBudgetFixture(app, {
    work: { reads: 1_000_000_000, writes: 100_000_000 }, cleanup: { reads: 100_000, writes: 100_000 }, control: { reads: 10_000_000, writes: 1_000_000 },
  });
  return { target, handle, identity, reference };
}

export async function readBudgetRunnerSelection(app: TestRuntime, handle: MonthlySemanticRunHandle): Promise<MonthlySemanticRunSelection> {
  return (await app.db.prepare('SELECT revision,phase FROM archive_semantic_runs WHERE run_id=?').bind(handle.runId).first<MonthlySemanticRunSelection>())!;
}

export async function privateSourceFingerprint(app: TestRuntime, handle: MonthlySemanticRunHandle): Promise<string> {
  const rows = await app.db.prepare('SELECT * FROM archive_semantic_rows WHERE verification_id=? AND generation=? ORDER BY archive_id,table_name,record_key')
    .bind(handle.verificationId, handle.generation).all();
  return createHash('sha256').update(JSON.stringify(rows.results)).digest('hex');
}
