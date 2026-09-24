import { link, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { verifyBackupArchives } from '../worker/backup-archives';
import { digest, verifyBackupStream } from '../worker/backup-crypto';
import type { RecoverySemanticStore } from './archive-recovery-store';

const MAX_ENCRYPTED_FILE_BYTES = 1024 * 1024 + 4096;
const controller = new AbortController();
let interrupted: NodeJS.Signals | undefined;
const interrupt = (signal: NodeJS.Signals) => { interrupted = signal; controller.abort(new Error(`Recovery interrupted by ${signal}.`)); };
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

async function assertAbsent(path: string) {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to replace existing recovery artifact: ${path}`);
}

async function boundedFile(path: string, maximum: number, noFollow = false): Promise<Uint8Array> {
  controller.signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error(`Recovery input must be a regular file of at most ${maximum} bytes: ${path}`);
    const bytes = new Uint8Array(maximum + 1);
    let used = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
      if (used > maximum) throw new Error(`Recovery input exceeds its size limit: ${path}`);
    }
    return bytes.slice(0, used);
  } finally { await file.close(); }
}

async function writeComplete(file: FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.length) {
    controller.signal.throwIfAborted();
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw new Error('Recovery output write made no progress.');
    offset += bytesWritten;
  }
}

async function bundleFile(root: string, key: string, maximum: number): Promise<Uint8Array> {
  if (isAbsolute(key) || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe recovery object path.');
  const candidate = resolve(root, key);
  if (relative(root, candidate).startsWith(`..${sep}`) || candidate === root) throw new Error('Recovery object path escapes bundle.');
  let cursor = root;
  for (const part of key.split('/')) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlink recovery inputs are not allowed.');
  }
  return boundedFile(candidate, maximum, true);
}

async function decrypt(directory: string, output: string, keyPath: string, archiveDirectory?: string) {
  const root = await realpath(resolve(directory));
  const destination = resolve(output);
  const manifestPath = `${destination}.manifest.json`;
  const archivePath = `${destination}.archives`;
  const archiveRoot = await realpath(resolve(archiveDirectory || directory));
  const lockPath = `${destination}.recovery.lock`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // An exclusive lock coordinates CLI invocations. Final files never serve as
  // placeholders, and hard-link publication cannot replace a concurrent file.
  const lock = await open(lockPath, 'wx', 0o600);
  let stage: string | undefined;
  let file: FileHandle | undefined;
  let publishedManifest = false;
  let publishedSql = false;
  let publishedArchives = false;
  const stagedObjects: string[] = [];
  let archiveSummary = { objects: 0, encryptedBytes: 0, archives: 0 };
  let complete = false;
  try {
    await assertAbsent(destination);
    await assertAbsent(manifestPath);
    await assertAbsent(archivePath);
    await assertAbsent(`${destination}.partial`);
    const key = new TextDecoder().decode(await boundedFile(resolve(keyPath), 4096)).trim();
    const encryptedManifest = await bundleFile(root, 'manifest.kcrm', MAX_ENCRYPTED_FILE_BYTES);
    stage = await mkdtemp(join(dirname(destination), `.${basename(destination)}.recovery-`));
    const stagedSql = join(stage, 'database.sql');
    const stagedManifest = join(stage, 'manifest.json');
    const stagedArchives = join(stage, 'history');
    file = await open(stagedSql, 'wx', 0o600);
    const manifest = await verifyBackupStream(
      key,
      encryptedManifest,
      name => bundleFile(root, name, MAX_ENCRYPTED_FILE_BYTES),
      bytes => writeComplete(file!, bytes),
      async references => {
        archiveSummary = await verifyBackupArchives(key, references,
          (objectKey, maximum) => bundleFile(archiveRoot, objectKey, maximum),
          async (objectKey, bytes) => {
            const path = join(stagedArchives, objectKey);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            const object = await open(path, 'wx', 0o600);
            try { await writeComplete(object, bytes); await object.sync(); } finally { await object.close(); }
            if (await digest(await boundedFile(path, bytes.length)) !== await digest(bytes)) throw new Error('Staged archive copy failed readback verification.');
            stagedObjects.push(objectKey);
          },
          async () => {
            controller.signal.throwIfAborted();
            const { createRecoverySemanticStore } = await import('./archive-recovery-store');
            const scratch = await mkdtemp(join(stage!, '.semantic-'));
            let store: RecoverySemanticStore;
            try { store = await createRecoverySemanticStore(join(scratch, 'records.sqlite'), { signal: controller.signal }); }
            catch (error) { await rm(scratch, { recursive: true, force: true }).catch(() => {}); throw error; }
            return {
              semanticStore: store,
              stagePart: (records, part, archiveManifest) => store.stagePart(records, part, archiveManifest),
              async dispose() {
                try { store.close(); }
                finally { await rm(scratch, { recursive: true, force: true }); }
              },
            };
          },
        );
      },
    );
    controller.signal.throwIfAborted();
    await file.sync();
    await file.close(); file = undefined;
    await writeFile(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx', signal: controller.signal });
    // Archive objects become visible only after all SQL/history verifies. SQL is
    // the final completion artifact; failure removes every artifact we created.
    if (stagedObjects.length) {
      await mkdir(archivePath, { mode: 0o700 });
      publishedArchives = true;
      for (const objectKey of stagedObjects) {
        controller.signal.throwIfAborted();
        const path = join(archivePath, objectKey);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await link(join(stagedArchives, objectKey), path);
      }
    }
    // SQL becomes visible last, after every part and the manifest have verified.
    await link(stagedManifest, manifestPath); publishedManifest = true;
    controller.signal.throwIfAborted();
    await link(stagedSql, destination); publishedSql = true;
    controller.signal.throwIfAborted();
    complete = true;
    console.log(JSON.stringify({
      verified: true, output: destination, backupId: manifest.backupId,
      exportedAt: manifest.createdAt, sqlBytes: manifest.sqlBytes,
      schemaVersions: manifest.schemaVersions, recordCounts: manifest.recordCounts,
      historicalArchives: { ...archiveSummary, output: stagedObjects.length ? archivePath : null },
      next: 'Restore into a new isolated database, apply current migrations, run recovery-access-reset.sql, and reconcile current revocations, holds, and deletions before cutover.',
    }, null, 2));
  } finally {
    await file?.close().catch(() => {});
    if (!complete) {
      if (publishedSql) await rm(destination, { force: true });
      if (publishedManifest) await rm(manifestPath, { force: true });
      if (publishedArchives) await rm(archivePath, { recursive: true, force: true });
    }
    if (stage) await rm(stage, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function main() {
  const [command, directory, output, archiveDirectory] = process.argv.slice(2);
  if (command === 'generate-key') {
    const path = resolve(directory || '.recovery/recovery-key.txt');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx', signal: controller.signal });
    console.log(`Recovery key written to ${path}. Store an independent copy in the customer's approved vault. The key was not printed.`);
  } else if (command === 'verify-decrypt') {
    const keyPath = process.env.KUMON_RECOVERY_KEY_FILE;
    if (!directory || !output || !keyPath) throw new Error('Usage: KUMON_RECOVERY_KEY_FILE=<private-key-file> npm run recovery -- verify-decrypt <downloaded-backup-folder> <new-output.sql> [archive-object-root]');
    await decrypt(directory, output, keyPath, archiveDirectory);
  } else {
    throw new Error('Use: generate-key [new-private-key-file]; or verify-decrypt <backup-folder> <new-output.sql> [archive-object-root]');
  }
}

try { await main(); } catch (error) {
  console.error(`Recovery failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally {
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
}
