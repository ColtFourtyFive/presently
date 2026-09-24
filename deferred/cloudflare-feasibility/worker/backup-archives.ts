import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveReference, type ArchiveSemanticStore, type ArchiveStagingSink } from '../shared/archive-format';
import { digest, validateBackupArchiveReferences } from './backup-crypto';
import { openArchiveManifest, verifyArchiveGraph } from './archive-codec';

/** Per-graph private recovery storage. Disposal must close and remove all
 * semantic scratch data before the caller can publish recovered output. */
export type BackupArchiveSemanticSink = {
  semanticStore: ArchiveSemanticStore;
  stagePart: ArchiveStagingSink['stagePart'];
  dispose(): Promise<void>;
};
export type BackupArchiveSemanticSinkFactory = (root: ArchiveManifest) => Promise<BackupArchiveSemanticSink>;

/** Verify pinned history and stage byte-identical encrypted objects for recovery.
 * stageObject must remain private until this function and SQL verification finish.
 */
export async function verifyBackupArchives(
  key: string,
  references: readonly ArchiveReference[],
  readObject: (objectKey: string, maximumBytes: number) => Promise<Uint8Array>,
  stageObject: (objectKey: string, bytes: Uint8Array) => Promise<void>,
  createSemanticSink?: BackupArchiveSemanticSinkFactory,
): Promise<{ objects: number; encryptedBytes: number; archives: number }> {
  validateBackupArchiveReferences(references);
  const staged = new Map<string, string>(), verified = new Map<string, string>(), manifestHashes = new Map<string, string>();
  const pinned = new Map(references.map(reference => [reference.archiveId, reference]));
  let encryptedBytes = 0, plaintextBytes = 0;
  const read = async (objectKey: string, maximumBytes: number) => {
    // Object names are supplied by authenticated, validated manifests. Also fence
    // the filesystem-oriented staging callback against any future codec changes.
    if (!/^archives\/[A-Za-z0-9_-]{1,100}\/\d{4}-(0[1-9]|1[0-2])\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.-]+$/.test(objectKey)) throw new Error('Invalid archive recovery object key.');
    const bytes = await readObject(objectKey, maximumBytes);
    if (bytes.length > maximumBytes) throw new Error('Archive recovery object exceeds its size limit.');
    const hash = await digest(bytes), previous = staged.get(objectKey);
    const segments = objectKey.split('/');
    if (segments[4].startsWith('manifest-')) {
      const existing = manifestHashes.get(segments[3]);
      if (existing && existing !== hash) throw new Error('Conflicting archive manifest objects.');
      manifestHashes.set(segments[3], hash);
    }
    if (previous && previous !== hash) throw new Error('Archive recovery object changed during verification.');
    if (!previous) {
      encryptedBytes += bytes.length;
      if (encryptedBytes > 512 * 1024 * 1024) throw new Error('Combined historical recovery exceeds 512 MiB.');
      await stageObject(objectKey, bytes);
      staged.set(objectKey, hash);
    }
    return bytes;
  };
  for (const reference of references) {
    const entry = await read(reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes);
    const root = await openArchiveManifest(key, entry, reference);
    const previous = verified.get(reference.archiveId);
    if (previous && previous !== reference.manifestSha256) throw new Error('Conflicting backup archive identity.');
    if (previous) continue;
    if (root.format === ARCHIVE_FORMAT_V2 && !createSemanticSink) throw new Error('Version 2 archive recovery requires a private semantic store.');
    const semantic = root.format === ARCHIVE_FORMAT_V2 ? await createSemanticSink!(root) : undefined;
    let failed = false;
    try {
      await verifyArchiveGraph(key, entry, read, {
        ...(semantic ? { semanticStore: semantic.semanticStore } : {}),
        async stagePart(records, part, manifest) { await semantic?.stagePart(records, part, manifest); },
        async discard() {},
        async publish(manifests) {
          for (const manifest of manifests) {
            const ownReference = pinned.get(manifest.archiveId);
            // Referenced ancestors are already checksum-bound by the graph codec.
            const hash = manifestHashes.get(manifest.archiveId);
            if (!hash) throw new Error('Missing staged archive manifest.');
            if (ownReference && hash !== ownReference.manifestSha256) throw new Error('Archive dependency disagrees with the SQL snapshot.');
            const existing = verified.get(manifest.archiveId);
            if (existing && existing !== hash) throw new Error('Conflicting backup archive identity.');
            if (!existing) {
              plaintextBytes += manifest.plaintextBytes;
              if (plaintextBytes > 512 * 1024 * 1024 || verified.size >= 4096) throw new Error('Combined historical recovery exceeds its supported bounds.');
              verified.set(manifest.archiveId, hash);
            }
          }
        },
      });
    } catch (error) { failed = true; throw error; }
    finally {
      try { await semantic?.dispose(); }
      catch (error) { if (!failed) throw error; }
    }
  }
  return { objects: staged.size, encryptedBytes, archives: verified.size };
}
