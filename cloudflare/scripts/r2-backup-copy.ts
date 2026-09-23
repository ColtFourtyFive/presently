import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { verifyBackupArchives } from '../worker/backup-archives';
import { openPart, verifyBackupStream, type BackupManifest } from '../worker/backup-crypto';
import { createRecoverySemanticStore } from './archive-recovery-store';
import {
  InstallationError,
  installationRoot,
  loadCustomerConfig,
  runCommand,
  type CommandRunner,
} from './installation';

const MAX_BACKUP_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_KEY_BYTES = 128;
const BACKUP_ID = /^[A-Za-z0-9_-]{1,100}$/;
const BACKUP_PART = /^part-\d{5}\.kcrm$/;

type CopiedObject = { key: string; bytes: number; sha256: string };

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function boundedFile(path: string, maximum: number, requirePrivate = false): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) {
    throw new InstallationError('Downloaded recovery input is not a bounded regular file.');
  }
  if (requirePrivate && (info.mode & 0o077)) {
    throw new InstallationError('Recovery key file must be readable only by its owner.');
  }
  return new Uint8Array(await readFile(path));
}

function parseManifest(plaintext: Uint8Array, backupId: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new InstallationError('Encrypted backup manifest is not valid JSON.');
  }
  const manifest = value as Partial<BackupManifest>;
  if (
    manifest.format !== 'kumon-d1-backup-v1'
    || manifest.backupId !== backupId
    || manifest.storageProvider !== 'r2'
    || manifest.storagePrefix !== `backups/${backupId}/`
    || !Array.isArray(manifest.parts)
    || manifest.parts.length > 512
  ) {
    throw new InstallationError('Encrypted backup manifest does not describe the requested R2 backup.');
  }
  const keys = new Set<string>();
  for (const [position, part] of manifest.parts.entries()) {
    if (
      part.index !== position
      || !BACKUP_PART.test(part.fileName)
      || part.fileName !== `part-${String(position).padStart(5, '0')}.kcrm`
      || part.objectKey !== `${manifest.storagePrefix}${part.fileName}`
      || !Number.isSafeInteger(part.encryptedBytes)
      || part.encryptedBytes < 1
      || part.encryptedBytes > MAX_BACKUP_OBJECT_BYTES
      || keys.has(part.objectKey)
    ) {
      throw new InstallationError('Encrypted backup manifest contains an invalid R2 part inventory.');
    }
    keys.add(part.objectKey);
  }
  return manifest as BackupManifest;
}

export type R2BackupCopyResult = {
  format: 'kumon-r2-backup-copy-v1';
  backupId: string;
  destination: string;
  bucket: string;
  databaseId: string;
  manifestSha256: string;
  objectInventorySha256: string;
  backupParts: number;
  archiveObjects: number;
  archives: number;
  encryptedBytes: number;
  sqlBytes: number;
  remoteChangesMade: false;
};

export async function copyR2Backup(
  args: { configPath: string; backupId: string; keyPath: string; outputDirectory: string },
  runner: CommandRunner = runCommand,
  root = installationRoot,
): Promise<R2BackupCopyResult> {
  if (!BACKUP_ID.test(args.backupId)) throw new InstallationError('Backup ID is invalid.');
  const loaded = await loadCustomerConfig(args.configPath);
  if (loaded.input.backupProvider !== 'r2' || !loaded.input.backupBucket) {
    throw new InstallationError('R2 backup copy requires an R2 customer configuration.');
  }
  const bucket = loaded.input.backupBucket;
  const output = resolve(args.outputDirectory);
  if (!(await missing(output))) throw new InstallationError('Backup copy destination already exists.');
  const key = new TextDecoder().decode(await boundedFile(resolve(args.keyPath), MAX_KEY_BYTES, true)).trim();
  if (!key) throw new InstallationError('Recovery key file is empty.');

  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(`${output}.copying-`);
  await chmod(staging, 0o700);
  const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
  const copied = new Map<string, CopiedObject>();

  const download = async (objectKey: string, localPath: string, maximum: number): Promise<Uint8Array> => {
    const existing = copied.get(objectKey);
    if (existing) return boundedFile(localPath, maximum);
    if (!/^(?:backups|archives)\/[A-Za-z0-9_./-]+$/.test(objectKey) || objectKey.includes('..')) {
      throw new InstallationError('R2 recovery object key is invalid.');
    }
    await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
    const result = await runner(process.execPath, [
      wrangler,
      'r2', 'object', 'get', `${bucket}/${objectKey}`,
      '--remote', '--file', localPath, '--config', loaded.configPath,
    ], root);
    if (result.code !== 0) throw new InstallationError('R2 recovery object download failed. No later object was requested.');
    await chmod(localPath, 0o600);
    const bytes = await boundedFile(localPath, maximum);
    copied.set(objectKey, {
      key: objectKey,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return bytes;
  };

  try {
    const manifestKey = `backups/${args.backupId}/manifest.kcrm`;
    const manifestPath = join(staging, 'manifest.kcrm');
    const encryptedManifest = await download(manifestKey, manifestPath, MAX_BACKUP_OBJECT_BYTES);
    const opened = await openPart(key, encryptedManifest);
    if (opened.header.part !== -1 || opened.header.backupId !== args.backupId) {
      throw new InstallationError('Encrypted manifest identity does not match the requested backup.');
    }
    const manifest = parseManifest(opened.plaintext, args.backupId);
    for (const part of manifest.parts) {
      await download(part.objectKey!, join(staging, part.fileName), MAX_BACKUP_OBJECT_BYTES);
    }

    let archiveSummary = { objects: 0, encryptedBytes: 0, archives: 0 };
    let sqlBytes = 0;
    const verified = await verifyBackupStream(
      key,
      encryptedManifest,
      name => boundedFile(join(staging, name), MAX_BACKUP_OBJECT_BYTES),
      async bytes => { sqlBytes += bytes.byteLength; },
      async references => {
        archiveSummary = await verifyBackupArchives(
          key,
          references,
          (objectKey, maximum) => download(objectKey, join(staging, objectKey), maximum),
          async () => {},
          async archiveManifest => {
            const scratch = await mkdtemp(join(staging, '.semantic-'));
            const store = await createRecoverySemanticStore(join(scratch, 'records.sqlite'));
            return {
              semanticStore: store,
              stagePart: (records, part, parent) => store.stagePart(records, part, parent),
              async dispose() {
                try { store.close(); }
                finally { await rm(scratch, { recursive: true, force: true }); }
              },
            };
          },
        );
      },
    );
    if (verified.backupId !== args.backupId || sqlBytes !== verified.sqlBytes) {
      throw new InstallationError('Copied backup verification did not reproduce the manifest SQL length.');
    }
    const inventory = [...copied.values()].sort((left, right) => left.key.localeCompare(right.key));
    const result: R2BackupCopyResult = {
      format: 'kumon-r2-backup-copy-v1',
      backupId: args.backupId,
      destination: output,
      bucket,
      databaseId: loaded.input.databaseId,
      manifestSha256: createHash('sha256').update(encryptedManifest).digest('hex'),
      objectInventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
      backupParts: verified.parts.length,
      archiveObjects: archiveSummary.objects,
      archives: archiveSummary.archives,
      encryptedBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
      sqlBytes,
      remoteChangesMade: false,
    };
    await writeFile(join(staging, 'copy-evidence.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(staging, output);
    return result;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
