import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecoverySemanticStore, type RecoverySemanticStore } from '../scripts/archive-recovery-store';
import { verifyBackupArchives, type BackupArchiveSemanticSinkFactory } from '../worker/backup-archives';
import { createArchive } from '../worker/archive-codec';
import type { ArchiveManifest, ArchiveReference } from '../shared/archive-format';
import { nativeSemanticFixture } from './archive-semantic-fixture';

let seed: Awaited<ReturnType<typeof nativeSemanticFixture>>;
const directories: string[] = [], stores: RecoverySemanticStore[] = [];
beforeAll(async () => { seed = await nativeSemanticFixture(1, true); });
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function archive(archiveId = 'private-sink-root') {
  const objects = new Map<string, Uint8Array>();
  const bundle = await createArchive(seed.key, { ...seed.metadata, archiveId }, structuredClone(seed.records), async (part, bytes) => { objects.set(part.objectKey, bytes); });
  objects.set(bundle.objectKey, bundle.encrypted);
  const reference: ArchiveReference = { archiveId, kind: bundle.manifest.kind, manifestObjectKey: bundle.objectKey, manifestSha256: bundle.sha256 };
  return { ...bundle, objects, reference };
}

function reader(objects: Map<string, Uint8Array>, missingError = new Error('Missing encrypted object')) {
  return async (key: string, maximum: number) => {
    const bytes = objects.get(key);
    if (!bytes || bytes.length > maximum) throw missingError;
    return bytes;
  };
}

function semanticFactory(disposalError?: Error) {
  const roots: ArchiveManifest[] = [], disposed: string[] = [], staged: string[] = [];
  const factory: BackupArchiveSemanticSinkFactory = async root => {
    roots.push(root);
    const directory = await mkdtemp(join(tmpdir(), 'kumon-private-semantic-sink-')); directories.push(directory);
    const store = await createRecoverySemanticStore(join(directory, 'records.sqlite')); stores.push(store);
    return {
      semanticStore: store,
      async stagePart(records, part, manifest) { await store.stagePart(records, part, manifest); staged.push(manifest.archiveId); },
      async dispose() {
        store.close(); await rm(directory, { recursive: true, force: true }); disposed.push(root.archiveId);
        if (disposalError) throw disposalError;
      },
    };
  };
  return { factory, roots, disposed, staged };
}

describe('portable historical backup semantic sink lifetime', () => {
  it('creates private storage per authenticated graph and disposes every store before success', async () => {
    const first = await archive('private-sink-first'), second = await archive('private-sink-second');
    const objects = new Map([...first.objects, ...second.objects]), privateCopies = new Map<string, Uint8Array>();
    const sink = semanticFactory();
    const result = await verifyBackupArchives(seed.key, [first.reference, second.reference], reader(objects), async (key, bytes) => { privateCopies.set(key, bytes); }, sink.factory);
    expect(result).toMatchObject({ archives: 2, objects: objects.size });
    expect(sink.roots).toEqual([first.manifest, second.manifest]);
    expect(sink.disposed).toEqual([first.manifest.archiveId, second.manifest.archiveId]);
    expect(new Set(sink.staged)).toEqual(new Set(sink.disposed));
    expect(privateCopies).toEqual(objects);
    for (const directory of directories) await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('disposes after graph failure and preserves that error even if disposal also fails', async () => {
    const bundle = await archive(), graphFailure = new Error('Synthetic encrypted part unavailable');
    bundle.objects.delete(bundle.manifest.parts[0].objectKey);
    const sink = semanticFactory(new Error('Synthetic disposal failure'));
    await expect(verifyBackupArchives(seed.key, [bundle.reference], reader(bundle.objects, graphFailure), async () => {}, sink.factory)).rejects.toBe(graphFailure);
    expect(sink.disposed).toEqual([bundle.manifest.archiveId]);
    for (const directory of directories) await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not complete recovery when disposal fails after semantic verification', async () => {
    const bundle = await archive(), disposalFailure = new Error('Synthetic disposal failure'), sink = semanticFactory(disposalFailure);
    let published = false;
    const verification = verifyBackupArchives(seed.key, [bundle.reference], reader(bundle.objects), async () => {}, sink.factory).then(() => { published = true; });
    await expect(verification).rejects.toBe(disposalFailure);
    expect(published).toBe(false);
    expect(sink.staged.length).toBe(bundle.manifest.parts.length);
    expect(sink.disposed).toEqual([bundle.manifest.archiveId]);
  });

  it('keeps v2 fail closed without a semantic sink factory', async () => {
    const bundle = await archive();
    await expect(verifyBackupArchives(seed.key, [bundle.reference], reader(bundle.objects), async () => {})).rejects.toThrow('requires a private semantic store');
  });

  it('checks the authenticated root reference before allocating private storage', async () => {
    const bundle = await archive(), sink = semanticFactory();
    await expect(verifyBackupArchives(seed.key, [{ ...bundle.reference, manifestSha256: '0'.repeat(64) }], reader(bundle.objects), async () => {}, sink.factory)).rejects.toThrow();
    expect(sink.roots).toEqual([]); expect(sink.disposed).toEqual([]); expect(directories).toEqual([]);
  });
});
