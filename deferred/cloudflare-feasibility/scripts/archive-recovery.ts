import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveStagingSink } from '../shared/archive-format';
import { openArchiveManifest, verifyArchiveGraph } from '../worker/archive-codec';
import type { RecoverySemanticStore } from './archive-recovery-store';

const controller = new AbortController();
let interrupted: NodeJS.Signals | undefined;
const onInterrupt = () => { interrupted = 'SIGINT'; controller.abort(new Error('Archive recovery interrupted.')); };
const onTerminate = () => { interrupted = 'SIGTERM'; controller.abort(new Error('Archive recovery interrupted.')); };
process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);

async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to replace existing recovery output: ${path}`);
}

async function boundedFile(path: string, maximum: number): Promise<Uint8Array> {
  controller.signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error(`Input must be a regular file of at most ${maximum} bytes.`);
    const result = new Uint8Array(maximum + 1); let length = 0;
    while (length < result.length) {
      controller.signal.throwIfAborted();
      const { bytesRead } = await handle.read(result, length, result.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('Input exceeds its declared size limit.');
    return result.slice(0, length);
  } finally { await handle.close(); }
}

async function bundleFile(root: string, key: string, maximum: number): Promise<Uint8Array> {
  if (isAbsolute(key) || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe archive object path.');
  const candidate = resolve(root, key);
  if (relative(root, candidate).startsWith(`..${sep}`) || candidate === root) throw new Error('Archive object path escapes bundle.');
  let cursor = root;
  for (const part of key.split('/')) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlink archive inputs are not allowed.'); }
  return boundedFile(candidate, maximum);
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    controller.signal.throwIfAborted();
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error('Archive recovery output write made no progress.');
    offset += bytesWritten;
  }
}

async function main(): Promise<void> {
  const [command, bundleArgument, entryKey, outputArgument, ...extra] = process.argv.slice(2);
  const keyPath = process.env.KUMON_RECOVERY_KEY_FILE;
  if (command !== 'verify-decrypt' || !bundleArgument || !entryKey || !outputArgument || !keyPath || extra.length) {
    throw new Error('Usage: KUMON_RECOVERY_KEY_FILE=<private-key-file> node --import tsx scripts/archive-recovery.ts verify-decrypt <downloaded-bucket-root> <manifest-relative-path> <new-output-directory>');
  }
  const bundle = await realpath(resolve(bundleArgument)), output = resolve(outputArgument), parent = dirname(output);
  const key = new TextDecoder('utf-8', { fatal: true }).decode(await boundedFile(resolve(keyPath), 1024)).trim();
  await absent(output);
  const lockPath = `${output}.lock`, lock = await open(lockPath, 'wx', 0o600);
  let stage: string | undefined, handle: FileHandle | undefined, currentId: string | undefined, published = false;
  let semanticStore: RecoverySemanticStore | undefined, semanticScratch: string | undefined;
  const close = async () => {
    if (!handle) return;
    const closing = handle; handle = undefined;
    try { await closing.sync(); } finally { await closing.close(); }
  };
  const disposeSemantics = async () => {
    const store = semanticStore; semanticStore = undefined;
    try { store?.close(); }
    finally {
      if (semanticScratch) {
        await rm(semanticScratch, { recursive: true, force: true });
        semanticScratch = undefined;
      }
    }
  };
  try {
    await absent(output); controller.signal.throwIfAborted();
    stage = await mkdtemp(join(parent, '.kumon-archive-recovery-')); // mkdtemp directories are private (0700).
    await mkdir(join(stage, 'records'), { mode: 0o700 });
    const entry = await bundleFile(bundle, entryKey, ARCHIVE_LIMITS.encryptedManifestBytes);
    const root = await openArchiveManifest(key, entry);
    if (root.format === ARCHIVE_FORMAT_V2) {
      const { createRecoverySemanticStore } = await import('./archive-recovery-store');
      semanticScratch = await mkdtemp(join(stage, '.semantic-'));
      semanticStore = await createRecoverySemanticStore(join(semanticScratch, 'records.sqlite'), { signal: controller.signal });
    }
    const sink: ArchiveStagingSink = {
      ...(semanticStore ? { semanticStore } : {}),
      async stagePart(records, part, manifest) {
        controller.signal.throwIfAborted();
        await semanticStore?.stagePart(records, part, manifest);
        if (currentId !== manifest.archiveId) {
          await close(); currentId = manifest.archiveId;
          handle = await open(join(stage!, 'records', `${manifest.archiveId}.jsonl`), 'wx', 0o600);
        }
        for (const record of records) await writeAll(handle!, new TextEncoder().encode(JSON.stringify(record) + '\n'));
      },
      async publish(manifests) {
        await close(); controller.signal.throwIfAborted();
        await disposeSemantics();
        const manifestPath = join(stage!, 'manifests.json');
        await writeFile(manifestPath, JSON.stringify({ format: 'kumon-history-recovery-v1', manifests }, null, 2) + '\n', { flag: 'wx', mode: 0o600, signal: controller.signal });
        const file = await open(manifestPath, 'r'); try { await file.sync(); } finally { await file.close(); }
        // Empty archives also have a deterministic empty record file.
        for (const manifest of manifests) if (!manifest.parts.length) await writeFile(join(stage!, 'records', `${manifest.archiveId}.jsonl`), '', { flag: 'wx', mode: 0o600 });
        await absent(output); controller.signal.throwIfAborted();
        await rename(stage!, output); published = true; stage = undefined;
      },
      async discard() {
        // Preserve the verification error; outer cleanup removes the private stage.
        await close().catch(() => {});
        await disposeSemantics().catch(() => {});
      },
    };
    const manifests: ArchiveManifest[] = await verifyArchiveGraph(key, entry, (name, maximum) => bundleFile(bundle, name, maximum), sink);
    console.log(JSON.stringify({ verified: true, archives: manifests.length, records: manifests.reduce((sum, manifest) => sum + manifest.recordCount, 0), output, next: 'Keep recovery output private. Historical evidence is verified; restore live database and archive catalog separately, then reconcile identities and all immutable addenda before cutover.' }));
  } finally {
    try { await close(); } finally {
      try { await disposeSemantics(); } finally {
        try { if (!published && stage) await rm(stage, { recursive: true, force: true }); }
        finally { await lock.close(); await rm(lockPath, { force: true }); }
      }
    }
  }
}

try { await main(); } catch (error) {
  console.error(`Archive recovery failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); }
