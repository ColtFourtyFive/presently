import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createArchive } from '../worker/archive-codec';
import { digest, newHeader, sealPart, verifyBackupStream, type BackupManifest } from '../worker/backup-crypto';
import { copyR2Backup } from '../scripts/r2-backup-copy';
import { generateConfig, type CommandRunner } from '../scripts/installation';
import { projectRoot } from './runtime';

const input = {
  accountId: 'a'.repeat(32),
  databaseId: '9bb827d6-4b25-4dbb-afb7-5b054d0d5929',
  databaseName: 'kumon-customer-db',
  workerName: 'kumon-customer-center',
  centerId: 'test-center',
  accessIssuer: 'https://kumon-customer.cloudflareaccess.com',
  accessAudience: 'b'.repeat(64),
  ownerEmail: 'owner@kumon.example',
  backupQueue: 'kumon-customer-backups',
  backupProvider: 'r2' as const,
  backupBucket: 'kumon-customer-private-backups',
};

async function fixture(withArchive = false) {
  const root = await mkdtemp(join(tmpdir(), 'kumon-r2-copy-'));
  const configPath = join(root, 'customer.json');
  await generateConfig(input, configPath, projectRoot);
  const key = randomBytes(32).toString('base64');
  const keyPath = join(root, 'recovery.key');
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const backupId = 'copy-test-backup';
  const prefix = `backups/${backupId}/`;
  const sql = new TextEncoder().encode('CREATE TABLE evidence(id TEXT PRIMARY KEY);\n');
  const encrypted = await sealPart(key, sql, newHeader(backupId, 0));
  const fileName = 'part-00000.kcrm';
  const objects = new Map<string, Uint8Array>([[`${prefix}${fileName}`, encrypted]]);
  const archiveReferences: NonNullable<BackupManifest['archiveReferences']> = [];

  if (withArchive) {
    const archive = await createArchive(key, {
      archiveId: 'monthly-archive-1',
      centerId: 'test-center',
      month: '2026-01',
      timezone: 'America/Los_Angeles',
      kind: 'monthly',
      createdAt: '2026-02-01T00:00:00.000Z',
      applicationVersion: '0.1.0',
      schemaVersions: [1, 8],
      references: [],
    }, [{ table: 'centers', key: 'test-center', row: { id: 'test-center', name: 'Test center', timezone: 'America/Los_Angeles' } }], async (part, bytes) => {
      objects.set(part.objectKey, bytes);
    });
    objects.set(archive.objectKey, archive.encrypted);
    archiveReferences.push({
      archiveId: archive.manifest.archiveId,
      kind: archive.manifest.kind,
      manifestObjectKey: archive.objectKey,
      manifestSha256: archive.sha256,
    });
  }

  const manifest: BackupManifest = {
    format: 'kumon-d1-backup-v1',
    backupId,
    applicationVersion: '0.1.0',
    schemaVersions: [1, 8],
    createdAt: '2026-09-22T00:00:00.000Z',
    snapshotBookmark: 'test-bookmark',
    recordCounts: { evidence: 0 },
    sqlBytes: sql.byteLength,
    storageProvider: 'r2',
    storagePrefix: prefix,
    archiveReferences,
    parts: [{
      index: 0,
      fileName,
      objectKey: `${prefix}${fileName}`,
      plaintextBytes: sql.byteLength,
      plaintextSha256: await digest(sql),
      encryptedBytes: encrypted.byteLength,
      encryptedSha256: await digest(encrypted),
    }],
  };
  const manifestBytes = await sealPart(key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(backupId, -1));
  objects.set(`${prefix}manifest.kcrm`, manifestBytes);
  const calls: string[][] = [];
  const runner: CommandRunner = async (_executable, args) => {
    calls.push(args);
    const object = args[4]?.slice(input.backupBucket.length + 1);
    const target = args[args.indexOf('--file') + 1];
    const bytes = objects.get(object);
    if (!bytes || !target) return { code: 1, stdout: 'provider output not exposed' };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { code: 0, stdout: '' };
  };
  return { root, configPath, key, keyPath, backupId, objects, calls, runner, manifest, sql };
}

describe('customer-side private R2 backup copy', () => {
  it('copies and verifies the exact encrypted backup and pinned archive inventory', async () => {
    const value = await fixture(true);
    const output = join(value.root, 'customer-copy');
    const result = await copyR2Backup({
      configPath: value.configPath,
      backupId: value.backupId,
      keyPath: value.keyPath,
      outputDirectory: output,
    }, value.runner, projectRoot);

    expect(result).toMatchObject({
      format: 'kumon-r2-backup-copy-v1',
      backupId: value.backupId,
      backupParts: 1,
      archives: 1,
      sqlBytes: value.sql.byteLength,
      remoteChangesMade: false,
    });
    expect(result.archiveObjects).toBeGreaterThanOrEqual(2);
    expect(value.calls).toHaveLength(value.objects.size);
    expect((await stat(output)).mode & 0o077).toBe(0);
    expect((await stat(join(output, 'manifest.kcrm'))).mode & 0o177).toBe(0);
    for (const key of value.objects.keys()) {
      const path = key.endsWith('/manifest.kcrm') && key.startsWith('backups/')
        ? join(output, 'manifest.kcrm')
        : key.startsWith(`backups/${value.backupId}/`)
          ? join(output, key.split('/').at(-1)!)
          : join(output, key);
      expect(new Uint8Array(await readFile(path))).toEqual(value.objects.get(key));
    }
    const verified = await verifyBackupStream(
      value.key,
      new Uint8Array(await readFile(join(output, 'manifest.kcrm'))),
      name => readFile(join(output, name)).then(bytes => new Uint8Array(bytes)),
      async () => {},
      async () => {},
    );
    expect(verified.backupId).toBe(value.backupId);
    const restored = join(value.root, 'restored.sql');
    const recovery = spawnSync(process.execPath, [
      join(projectRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(projectRoot, 'scripts/recovery.ts'),
      'verify-decrypt', output, restored,
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, KUMON_RECOVERY_KEY_FILE: value.keyPath },
    });
    expect(recovery.status, recovery.stderr).toBe(0);
    expect(new Uint8Array(await readFile(restored))).toEqual(value.sql);
    expect(await stat(`${restored}.archives`)).toMatchObject({});
  });

  it('removes an incomplete destination when any required object is unavailable', async () => {
    const value = await fixture();
    value.objects.delete(`backups/${value.backupId}/part-00000.kcrm`);
    const output = join(value.root, 'failed-copy');
    await expect(copyR2Backup({
      configPath: value.configPath,
      backupId: value.backupId,
      keyPath: value.keyPath,
      outputDirectory: output,
    }, value.runner, projectRoot)).rejects.toThrow('download failed');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a pinned archive dependency cannot be copied', async () => {
    const value = await fixture(true);
    value.objects.delete(value.manifest.archiveReferences![0].manifestObjectKey);
    const output = join(value.root, 'missing-archive');
    await expect(copyR2Backup({
      configPath: value.configPath,
      backupId: value.backupId,
      keyPath: value.keyPath,
      outputDirectory: output,
    }, value.runner, projectRoot)).rejects.toThrow('download failed');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a decrypted manifest that attempts to write outside its backup prefix', async () => {
    const value = await fixture();
    const changed: BackupManifest = {
      ...value.manifest,
      parts: [{ ...value.manifest.parts[0], objectKey: 'backups/../outside.kcrm' }],
    };
    value.objects.set(
      `backups/${value.backupId}/manifest.kcrm`,
      await sealPart(value.key, new TextEncoder().encode(JSON.stringify(changed)), newHeader(value.backupId, -1)),
    );
    const output = join(value.root, 'unsafe-manifest');
    await expect(copyR2Backup({
      configPath: value.configPath,
      backupId: value.backupId,
      keyPath: value.keyPath,
      outputDirectory: output,
    }, value.runner, projectRoot)).rejects.toThrow('invalid R2 part inventory');
    expect(value.calls).toHaveLength(1);
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an existing destination and a non-private recovery key before provider access', async () => {
    const value = await fixture();
    const output = join(value.root, 'existing');
    await mkdir(output);
    await expect(copyR2Backup({
      configPath: value.configPath,
      backupId: value.backupId,
      keyPath: value.keyPath,
      outputDirectory: output,
    }, value.runner, projectRoot)).rejects.toThrow('already exists');
    await chmod(value.keyPath, 0o644);
    await expect(copyR2Backup({
      configPath: value.configPath,
      backupId: value.backupId,
      keyPath: value.keyPath,
      outputDirectory: join(value.root, 'unsafe-key'),
    }, value.runner, projectRoot)).rejects.toThrow('readable only by its owner');
    expect(value.calls).toHaveLength(0);
  });
});
