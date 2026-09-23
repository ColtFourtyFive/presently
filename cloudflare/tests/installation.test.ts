import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { bytes64, digest, newHeader, openPart, sealPart, type BackupManifest } from '../worker/backup-crypto';
import { createArchive } from '../worker/archive-codec';
import { doctor, generateConfig, installationRoot, loadCustomerConfig, MAINTENANCE_UNTIL, migrateCustomer, migrationInventory, parseJson, prepareUpdate, validateInstallation, verifyUpdateBackup, type CommandRunner, type CustomerConfig, type UpdatePacket, type MaintenanceEvidence } from '../scripts/installation';

// Every path, backup and provider response in this suite is an isolated fixture.
// No test calls Cloudflare, Google, Railway or the real command runner.
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const input = {
  accountId: 'a'.repeat(32), databaseId: '9bb827d6-4b25-4dbb-afb7-5b054d0d5929', databaseName: 'test-center-db',
  workerName: 'test-center', centerId: 'test_center', accessIssuer: 'https://test-center.cloudflareaccess.com',
  accessAudience: 'b'.repeat(64), ownerEmail: 'owner@example.invalid', backupQueue: 'test-center-backups', backupBucket: 'test-center-private-backups',
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kumon-install-test-')); directories.push(root);
  for (const path of ['worker', 'client', 'shared', 'scripts', 'tests', 'migrations', 'node_modules/wrangler/bin']) await mkdir(join(root, path), { recursive: true });
  for (const path of ['worker/index.ts', 'client/main.ts', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'index.html', 'node_modules/wrangler/bin/wrangler.js', 'node_modules/wrangler/config-schema.json']) await writeFile(join(root, path), '// isolated fixture');
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: 'test-2' }));
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'migrations/0001_initial.sql'), 'CREATE TABLE backup_runtime(id INTEGER PRIMARY KEY, write_locked_until TEXT, lock_job_id TEXT);\nCREATE TABLE backup_jobs(status TEXT);\n');
  await writeFile(join(root, 'migrations/0002_guard.sql'), "CREATE TABLE sample(id TEXT);\nCREATE TRIGGER example_guard BEFORE INSERT ON sample BEGIN\n  SELECT RAISE(ABORT, 'test trigger');\nEND;\n");
  const configPath = join(root, 'customers/config.json');
  await generateConfig(input, configPath, root);
  return { root, configPath };
}
async function backupFixture(root: string, createdAt = new Date().toISOString()) {
  const directory = join(root, `backup-${crypto.randomUUID()}`); await mkdir(directory);
  const backupId = crypto.randomUUID(), key = bytes64(crypto.getRandomValues(new Uint8Array(32))), keyPath = join(root, `key-${backupId}`);
  await writeFile(keyPath, key, { mode: 0o600 });
  const plain = new TextEncoder().encode('CREATE TABLE sample(id TEXT);\n');
  const encrypted = await sealPart(key, plain, newHeader(backupId, 0));
  const fileName = 'part-00000.kcrm'; await writeFile(join(directory, fileName), encrypted);
  const manifest: BackupManifest = { format: 'kumon-d1-backup-v1', backupId, applicationVersion: 'test-1', schemaVersions: [1], createdAt, snapshotBookmark: 'isolated-fixture', recordCounts: { sample: 0 }, sqlBytes: plain.length, parts: [{ index: 0, fileName, plaintextBytes: plain.length, plaintextSha256: await digest(plain), encryptedBytes: encrypted.length, encryptedSha256: await digest(encrypted) }] };
  await writeFile(join(directory, 'manifest.kcrm'), await sealPart(key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(backupId, -1)));
  const evidence: MaintenanceEvidence = { accountId: input.accountId, databaseId: input.databaseId, backupId, verifiedBy: 'Fixture operator', writesStoppedAt: new Date(Date.parse(createdAt) - 1000).toISOString(), maintenanceLockId: `upgrade-${crypto.randomUUID()}`, restoreDrillReference: 'isolated fixture restore drill', stagingMigrationEvidence: 'isolated fixture staged migration', acceptLegacyLedger: false };
  return { directory, keyPath, key, evidence };
}
async function updateFixture() {
  const setup = await fixture(), backup = await backupFixture(setup.root), packetPath = join(setup.root, 'update.json');
  const localCalls: string[][] = [];
  await prepareUpdate({ configPath: setup.configPath, backupDirectory: backup.directory, keyPath: backup.keyPath, evidence: backup.evidence, outputPath: packetPath }, async (_, args) => { localCalls.push(args); return { code: 0, stdout: '' }; }, setup.root);
  return { ...setup, ...backup, packetPath, localCalls };
}
async function addArchiveBundle(backup: Awaited<ReturnType<typeof backupFixture>>) {
  const objects = new Map<string, Uint8Array>();
  const parent = await createArchive(backup.key, { archiveId: 'parent', centerId: 'test_center', month: '2025-01', timezone: 'UTC', kind: 'monthly', createdAt: '2025-02-01T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [1,8], references: [] }, [{ table: 'centers', key: 'test_center', row: { id: 'test_center', name: 'Synthetic Center', timezone: 'UTC' } }], async (part, bytes) => { objects.set(part.objectKey, bytes); });
  objects.set(parent.objectKey, parent.encrypted);
  const child = await createArchive(backup.key, { archiveId: 'addendum', centerId: 'test_center', month: '2025-01', timezone: 'UTC', kind: 'addendum', createdAt: '2025-03-01T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [1,8], references: [{ archiveId: 'parent', kind: 'monthly', manifestObjectKey: parent.objectKey, manifestSha256: parent.sha256 }] }, [{ table: 'audit_entries', key: 'review', row: { id: 'review', center_id: 'test_center', actor_name: 'Synthetic Reviewer', action: 'review.resolve', entity_type: 'review', entity_id: 'review-1', detail: '{"reason":"Checked source record"}', created_at: '2025-03-01T00:00:00.000Z' } }], async (part, bytes) => { objects.set(part.objectKey, bytes); });
  objects.set(child.objectKey, child.encrypted);
  for (const [objectKey, bytes] of objects) { const path = join(backup.directory, objectKey); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  const manifest: BackupManifest = JSON.parse(new TextDecoder().decode((await openPart(backup.key, await readFile(join(backup.directory, 'manifest.kcrm')))).plaintext));
  manifest.schemaVersions = [1,8];
  manifest.archiveReferences = [{ archiveId: 'addendum', kind: 'addendum', manifestObjectKey: child.objectKey, manifestSha256: child.sha256 }];
  await writeFile(join(backup.directory, 'manifest.kcrm'), await sealPart(backup.key, new TextEncoder().encode(JSON.stringify(manifest)), newHeader(manifest.backupId, -1)));
  return { parent, child, objects };
}
type RemoteOptions = { existing?: boolean; wrongTarget?: boolean; names?: string[]; badHash?: boolean; extraHash?: boolean; lock?: string; lockId?: string; importFails?: boolean; missingHash?: boolean; activeJobs?: number; corruptAfter?: boolean; unrelated?: boolean };
async function remote(root: string, options: RemoteOptions = {}) {
  const inventory = await migrationInventory(root), calls: string[][] = [], imported: string[] = [];
  let names = options.names ?? (options.existing ? [inventory[0].name] : []), changed = false;
  const runner: CommandRunner = async (_, args) => {
    calls.push(args);
    const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value) });
    const rows = (value: unknown[]) => result([{ success: true, results: value }]);
    if (args.includes('info')) return result({ uuid: options.wrongTarget ? crypto.randomUUID() : input.databaseId, name: input.databaseName });
    if (args.includes('--file')) {
      imported.push(await readFile(args[args.indexOf('--file') + 1], 'utf8'));
      if (options.importFails) return { code: 1, stdout: 'provider output must never be echoed' };
      names = inventory.map(item => item.name); changed = true; return result({ success: true });
    }
    const sql = args[args.indexOf('--command') + 1];
    if (sql.includes('sqlite_master')) return rows((options.unrelated ? ['unrelated'] : options.existing ? ['d1_migrations', 'installation_migration_hashes', 'backup_runtime', 'backup_jobs'] : []).map(name => ({ name })).filter(row => !(options.missingHash && row.name === 'installation_migration_hashes')));
    if (sql.includes('SELECT name FROM d1_migrations')) return rows(names.map(name => ({ name })));
    if (sql.includes('SELECT name,sha256')) {
      const values = inventory.filter(item => names.includes(item.name)).map(({ name, sha256 }) => ({ name, sha256: options.badHash || (changed && options.corruptAfter) ? '0'.repeat(64) : sha256 }));
      if (options.extraHash) values.push({ name: inventory[1].name, sha256: inventory[1].sha256 });
      return rows(values);
    }
    if (sql.includes('SELECT write_locked_until')) return rows([{ lock_job_id: options.lockId, write_locked_until: options.lock ?? MAINTENANCE_UNTIL }]);
    if (sql.includes('SELECT count(*)')) return rows([{ n: options.activeJobs ?? 0 }]);
    throw new Error('Unexpected simulated provider call');
  };
  return { runner, calls, imported };
}
const migrationArgs = (f: Awaited<ReturnType<typeof fixture>>) => ({ configPath: f.configPath, confirmDatabaseId: input.databaseId, execute: true });

describe('customer configuration and local doctor', () => {
  it('validates identifiers and rejects unknown fields and OAuth Testing mode', () => {
    expect(validateInstallation(input).ownerEmail).toBe(input.ownerEmail);
    for (const patch of [{ accountId: '0'.repeat(32) }, { databaseId: 'invalid' }, { accessIssuer: 'https://evil.invalid/cloudflareaccess.com' }, { accessAudience: 'abc' }, { googleOAuthMode: 'testing' }, { BACKUP_KEY: 'secret' }]) expect(() => validateInstallation({ ...input, ...patch })).toThrow();
    expect(() => parseJson('{"secret":"do-not-print"')).toThrow('Invalid JSON. File content is not printed.');
  });
  it('creates private relative configuration, never overwrites, and keeps backups disabled', async () => {
    const f = await fixture(), loaded = await loadCustomerConfig(f.configPath);
    expect(loaded.config.main).toBe('../worker/index.ts');
    expect(loaded.config.vars.BACKUP_ENABLED).toBe('false'); expect(loaded.config.vars.ARCHIVE_ENABLED).toBe('false'); expect(loaded.config.vars.ARCHIVE_V2_ENABLED).toBe('false');
    expect(loaded.config.observability).toEqual({ enabled: true, head_sampling_rate: 0.1, traces: { enabled: true, head_sampling_rate: 0.1 } });
    expect((await stat(f.configPath)).mode & 0o077).toBe(0);
    const before = await readFile(f.configPath, 'utf8');
    await expect(generateConfig(input, f.configPath, f.root)).rejects.toThrow();
    expect(await readFile(f.configPath, 'utf8')).toBe(before);
    expect(await doctor(f.configPath, f.root)).toMatchObject({ localChecksPassed: true, backupsEnabled: false, backupProvider: 'r2', backupBucket: input.backupBucket });
  });
  it('rejects version 2 activation without the base archive flag', async () => {
    const f = await fixture();
    const config = JSON.parse(await readFile(f.configPath, 'utf8')) as CustomerConfig;
    config.vars.ARCHIVE_V2_ENABLED = 'true';
    await writeFile(f.configPath, JSON.stringify(config));
    await expect(loadCustomerConfig(f.configPath)).rejects.toThrow('requires R2 and ARCHIVE_ENABLED=true');
  });
  it('defaults to R2 without Google inputs or secrets and leaves connection checks unresolved', async () => {
    const f = await fixture(), loaded = await loadCustomerConfig(f.configPath), report = await doctor(f.configPath, f.root);
    expect(loaded.config.vars.BACKUP_PROVIDER).toBe('r2');
    expect(loaded.config.r2_buckets).toEqual([{ binding: 'BACKUP_BUCKET', bucket_name: input.backupBucket }]);
    expect(Object.keys(loaded.config.vars).some(name => name.startsWith('GOOGLE_'))).toBe(false);
    expect(report.requiredSecretNames).toEqual(['BACKUP_KEY', 'CF_EXPORT_API_TOKEN', 'BACKUP_ALERT_URL']);
    expect(report).not.toHaveProperty('missingGoogleClientId');
    expect(report.unresolved).toContain('R2 activation and private bucket ownership; public domains and r2.dev must be disabled');
    expect(report.unresolved.some(item => item.includes('copy outside the Cloudflare account'))).toBe(true);
    expect(report.unresolved.some(item => item.includes('Google consent'))).toBe(false);
  });
  it('validates R2 bucket names and rejects mixed or unsupported providers', () => {
    for (const backupBucket of ['ab', 'a'.repeat(64), 'Uppercase', '-leading', 'trailing-', 'with.dot', 'with_underscore']) expect(() => validateInstallation({ ...input, backupBucket })).toThrow('backupBucket');
    expect(validateInstallation({ ...input, backupBucket: 'a'.repeat(63) }).backupProvider).toBe('r2');
    for (const patch of [{ backupBucket: undefined }, { backupProvider: 's3' }, { backupProvider: null }, { googleClientId: 'fakeclient.apps.googleusercontent.com' }, { googleOAuthMode: 'production' }]) expect(() => validateInstallation({ ...input, ...patch })).toThrow();
  });
  it('supports explicit legacy Google Drive and reports its separate prerequisites', async () => {
    const f = await fixture(), { backupBucket: _, ...base } = input;
    const legacyInput = { ...base, backupProvider: 'google-drive', googleOAuthMode: 'production' };
    const configPath = join(f.root, 'customers/legacy.json');
    const generated = await generateConfig(legacyInput, configPath, f.root);
    const loaded = await loadCustomerConfig(configPath), report = await doctor(configPath, f.root);
    expect(generated.backupProvider).toBe('google-drive');
    expect(loaded.config).not.toHaveProperty('r2_buckets');
    expect(loaded.config.vars).toMatchObject({ BACKUP_PROVIDER: 'google-drive', GOOGLE_OAUTH_MODE: 'production', BACKUP_ENABLED: 'false' });
    expect(report).toMatchObject({ backupProvider: 'google-drive', missingGoogleClientId: true });
    expect(report.requiredSecretNames).toContain('GOOGLE_CLIENT_SECRET');
    expect(report.unresolved.some(item => item.includes('Google consent'))).toBe(true);
    expect(() => validateInstallation({ ...legacyInput, googleOAuthMode: 'testing' })).toThrow('production or internal');
    expect(() => validateInstallation({ ...legacyInput, backupBucket: input.backupBucket })).toThrow('must not contain an R2 bucket');
    await generateConfig({ ...legacyInput, googleClientId: 'fakeclient.apps.googleusercontent.com' }, join(f.root, 'customers/legacy-connected.json'), f.root);
    expect(await doctor(join(f.root, 'customers/legacy-connected.json'), f.root)).toMatchObject({ missingGoogleClientId: false });
  });
  it('rejects missing or ambiguous R2 bindings and requires explicit legacy provider configuration', async () => {
    const f = await fixture(), original = JSON.parse(await readFile(f.configPath, 'utf8'));
    const mutations = [
      (c: CustomerConfig) => delete c.r2_buckets,
      (c: CustomerConfig) => c.r2_buckets!.push({ binding: 'BACKUP_BUCKET', bucket_name: 'another-bucket' }),
      (c: CustomerConfig) => c.r2_buckets![0].binding = 'PUBLIC_BUCKET',
      (c: CustomerConfig) => Reflect.set(c.r2_buckets![0], 'remote', true),
      (c: CustomerConfig) => c.vars.GOOGLE_OAUTH_MODE = 'production',
      (c: CustomerConfig) => c.vars.BACKUP_PROVIDER = 'google-drive',
      (c: CustomerConfig) => delete c.vars.BACKUP_PROVIDER,
    ];
    for (const mutate of mutations) {
      const config = structuredClone(original); mutate(config); await writeFile(f.configPath, JSON.stringify(config));
      await expect(loadCustomerConfig(f.configPath)).rejects.toThrow();
    }
  });
  it('rejects mismatched backup targets, local auth, unsupported bindings and escaped paths', async () => {
    const f = await fixture(), original = JSON.parse(await readFile(f.configPath, 'utf8'));
    for (const mutate of [(c: CustomerConfig) => c.vars.CF_DATABASE_ID = crypto.randomUUID(), (c: CustomerConfig) => c.vars.LOCAL_ACCESS_EMAIL = 'fixture', (c: CustomerConfig) => Reflect.set(c, 'assets', {}), (c: CustomerConfig) => c.main = '/outside/worker.ts', (c: CustomerConfig) => c.queues.consumers[0].max_concurrency = 2]) {
      const value = structuredClone(original); mutate(value); await writeFile(f.configPath, JSON.stringify(value));
      await expect(doctor(f.configPath, f.root)).rejects.toThrow();
    }
  });
  it('rejects unknown command flags without printing supplied content', () => {
    const result = spawnSync(process.execPath, [join(installationRoot, 'node_modules/tsx/dist/cli.mjs'), join(installationRoot, 'scripts/install.ts'), 'configure', '--secret', 'DO_NOT_PRINT'], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).not.toContain('DO_NOT_PRINT'); expect(result.stderr).toContain('documented unique');
  });
});

describe('verified update packets', () => {
  it('verifies all recursive historical dependencies before allowing an update packet', async () => {
    const f = await fixture(), backup = await backupFixture(f.root);
    await addArchiveBundle(backup);
    expect((await verifyUpdateBackup(backup.directory, backup.keyPath)).manifest.archiveReferences).toHaveLength(1);
    const calls: string[][] = [];
    await prepareUpdate({ configPath: f.configPath, backupDirectory: backup.directory, keyPath: backup.keyPath, evidence: backup.evidence, outputPath: join(f.root, 'archive-update.json') }, async (_, args) => { calls.push(args); return { code: 0, stdout: '' }; }, f.root);
    expect(calls).toEqual([['run','check'],['run','test'],['run','build']]);
  });
  it.each(['missing', 'corrupt', 'symlink'] as const)('refuses an update packet with a %s historical dependency', async failure => {
    const f = await fixture(), backup = await backupFixture(f.root), history = await addArchiveBundle(backup);
    const part = history.parent.manifest.parts[0], path = join(backup.directory, part.objectKey);
    if (failure === 'missing') await rm(path);
    if (failure === 'corrupt') { const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes); }
    if (failure === 'symlink') { const original = await readFile(path), outside = join(f.root, 'outside-part'); await writeFile(outside, original); await rm(path); await symlink(outside, path); }
    let called = false; const output = join(f.root, 'rejected.json');
    await expect(prepareUpdate({ configPath: f.configPath, backupDirectory: backup.directory, keyPath: backup.keyPath, evidence: backup.evidence, outputPath: output }, async () => { called = true; return { code: 0, stdout: '' }; }, f.root)).rejects.toThrow();
    expect(called).toBe(false); await expect(stat(output)).rejects.toThrow();
  });
  it('verifies encryption, runs local checks in order, and creates a private packet without keys', async () => {
    const f = await updateFixture(), text = await readFile(f.packetPath, 'utf8');
    expect(f.localCalls).toEqual([['run', 'check'], ['run', 'test'], ['run', 'build']]);
    expect(text).not.toContain(f.key); expect(text).not.toContain(f.keyPath);
    expect((await stat(f.packetPath)).mode & 0o077).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ backupId: f.evidence.backupId, maintenance: f.evidence });
  });
  it('rejects stale/future backups, wrong keys, and non-private keys', async () => {
    const f = await fixture();
    for (const age of [-120_000, 61 * 60_000]) {
      const backup = await backupFixture(f.root, new Date(Date.now() - age).toISOString());
      await expect(verifyUpdateBackup(backup.directory, backup.keyPath)).rejects.toThrow('recent completed backup');
    }
    const backup = await backupFixture(f.root);
    await writeFile(backup.keyPath, bytes64(crypto.getRandomValues(new Uint8Array(32))));
    await expect(verifyUpdateBackup(backup.directory, backup.keyPath)).rejects.toThrow();
    await writeFile(backup.keyPath, backup.key); await chmod(backup.keyPath, 0o644);
    await expect(verifyUpdateBackup(backup.directory, backup.keyPath)).rejects.toThrow('private file');
  });
  it('rejects modified parts and symlinks', async () => {
    const f = await fixture(), backup = await backupFixture(f.root), path = join(backup.directory, 'part-00000.kcrm');
    const original = await readFile(path), changed = Buffer.from(original); changed[changed.length - 1] ^= 1; await writeFile(path, changed);
    await expect(verifyUpdateBackup(backup.directory, backup.keyPath)).rejects.toThrow();
    await rm(path); const target = join(f.root, 'part'); await writeFile(target, original); await symlink(target, path);
    await expect(verifyUpdateBackup(backup.directory, backup.keyPath)).rejects.toThrow('symbolic links');
  });
  it('requires matching evidence and blocks packet creation after failed local checks', async () => {
    const f = await fixture(), backup = await backupFixture(f.root), outputPath = join(f.root, 'packet.json');
    const args = { configPath: f.configPath, backupDirectory: backup.directory, keyPath: backup.keyPath, evidence: backup.evidence, outputPath };
    const calls: string[][] = []; const runner: CommandRunner = async (_, args) => { calls.push(args); return { code: 1, stdout: 'private provider content' }; };
    await expect(prepareUpdate({ ...args, evidence: { ...backup.evidence, databaseId: crypto.randomUUID() } }, runner, f.root)).rejects.toThrow('different installation'); expect(calls).toHaveLength(0);
    await expect(prepareUpdate(args, runner, f.root)).rejects.toThrow('Local check failed'); expect(calls).toEqual([['run', 'check']]);
    await expect(stat(outputPath)).rejects.toThrow();
  });
});

describe('native migration guard', () => {
  it('defaults to a local plan and requires explicit target confirmation', async () => {
    const f = await fixture(), r = await remote(f.root);
    expect(await migrateCustomer({ ...migrationArgs(f), execute: false }, r.runner, f.root)).toMatchObject({ planOnly: true, remoteChangesMade: false });
    await expect(migrateCustomer({ ...migrationArgs(f), confirmDatabaseId: crypto.randomUUID() }, r.runner, f.root)).rejects.toThrow('Explicit database');
    expect(r.calls).toHaveLength(0);
  });
  it('stops on the wrong remote target or unknown/out-of-order ledger', async () => {
    const f = await fixture();
    for (const options of [{ wrongTarget: true }, { existing: true, names: ['0009_future.sql'] }, { existing: true, names: ['0002_guard.sql'] }, { unrelated: true }]) {
      const r = await remote(f.root, options); await expect(migrateCustomer(migrationArgs(f), r.runner, f.root)).rejects.toThrow(); expect(r.imported).toHaveLength(0);
    }
  });
  it('bootstraps an empty database through one native file import with intact trigger SQL', async () => {
    const f = await fixture(), r = await remote(f.root);
    expect(await migrateCustomer(migrationArgs(f), r.runner, f.root)).toMatchObject({ remoteChangesMade: true, maintenanceReleased: false });
    expect(r.imported).toHaveLength(1); expect(r.imported[0]).toContain("BEGIN\n  SELECT RAISE(ABORT, 'test trigger');\nEND;");
    expect(r.imported[0]).toContain('INSERT INTO d1_migrations(name)');
    expect(r.imported[0]).toContain('INSERT INTO installation_migration_hashes');
    expect(r.calls.some(call => call.includes('apply'))).toBe(false);
    const native = r.calls.find(call => call.includes('--file'))!;
    await expect(stat(native[native.indexOf('--file') + 1])).rejects.toThrow();
  });
  it('requires a verified packet and refuses tampered or future migration hashes', async () => {
    const f = await fixture();
    for (const options of [{ existing: true }, { existing: true, badHash: true }, { existing: true, extraHash: true }]) {
      const r = await remote(f.root, options); await expect(migrateCustomer(migrationArgs(f), r.runner, f.root)).rejects.toThrow(); expect(r.imported).toHaveLength(0);
    }
  });
  it('applies only pending migrations with a matching backup and manual-release lock', async () => {
    const f = await updateFixture(), r = await remote(f.root, { existing: true, lockId: f.evidence.maintenanceLockId });
    expect(await migrateCustomer({ ...migrationArgs(f), packetPath: f.packetPath, keyPath: f.keyPath }, r.runner, f.root)).toMatchObject({ applied: ['0002_guard.sql'], maintenanceReleased: false });
    expect(r.imported[0]).not.toContain('CREATE TABLE backup_jobs');
    expect(r.calls.flat().join(' ')).not.toContain('UPDATE backup_runtime');
  });
  it('blocks invalid/expiring locks, active backup jobs, and unverified legacy history', async () => {
    const f = await updateFixture();
    for (const options of [{ lock: 'not-a-date' }, { lock: new Date(Date.now() + 60 * 60_000).toISOString() }, { lockId: 'different-lock' }, { activeJobs: 1 }, { missingHash: true }]) {
      const r = await remote(f.root, { existing: true, lockId: f.evidence.maintenanceLockId, ...options });
      await expect(migrateCustomer({ ...migrationArgs(f), packetPath: f.packetPath, keyPath: f.keyPath }, r.runner, f.root)).rejects.toThrow(); expect(r.imported).toHaveLength(0);
    }
  });
  it('blocks stale packets, target changes, and source changes after local verification', async () => {
    const f = await updateFixture(), original = JSON.parse(await readFile(f.packetPath, 'utf8'));
    for (const mutate of [(p: UpdatePacket) => p.preparedAt = new Date(Date.now() - 31 * 60_000).toISOString(), (p: UpdatePacket) => p.maintenance.databaseId = crypto.randomUUID(), (p: UpdatePacket) => p.migrations = []]) {
      const value = structuredClone(original); mutate(value); await writeFile(f.packetPath, JSON.stringify(value));
      const r = await remote(f.root, { existing: true, lockId: f.evidence.maintenanceLockId });
      await expect(migrateCustomer({ ...migrationArgs(f), packetPath: f.packetPath, keyPath: f.keyPath }, r.runner, f.root)).rejects.toThrow(); expect(r.imported).toHaveLength(0);
    }
    await writeFile(f.packetPath, JSON.stringify(original)); await writeFile(join(f.root, 'worker/index.ts'), '// changed after verification');
    const r = await remote(f.root, { existing: true, lockId: f.evidence.maintenanceLockId });
    await expect(migrateCustomer({ ...migrationArgs(f), packetPath: f.packetPath, keyPath: f.keyPath }, r.runner, f.root)).rejects.toThrow('config/release changed'); expect(r.imported).toHaveLength(0);
  });
  it('does not deploy or unlock after import failure and verifies the resulting checksum ledger', async () => {
    const f = await updateFixture();
    for (const options of [{ importFails: true }, { corruptAfter: true }]) {
      const r = await remote(f.root, { existing: true, lockId: f.evidence.maintenanceLockId, ...options });
      await expect(migrateCustomer({ ...migrationArgs(f), packetPath: f.packetPath, keyPath: f.keyPath }, r.runner, f.root)).rejects.toThrow();
      expect(r.calls.some(call => call.includes('deploy') || call.some(value => value.includes('UPDATE backup_runtime')))).toBe(false);
      const imports = r.calls.filter(call => call.includes('--file'));
      expect(imports).toHaveLength(1); // An uncertain provider failure must not trigger an automatic retry.
      expect(imports[0]).toContain('--remote');
      await expect(stat(imports[0][imports[0].indexOf('--file') + 1])).rejects.toThrow();
    }
  });
  it('makes no writes when the installed migration ledger is current', async () => {
    const f = await fixture(), names = (await migrationInventory(f.root)).map(item => item.name), r = await remote(f.root, { existing: true, names });
    expect(await migrateCustomer(migrationArgs(f), r.runner, f.root)).toMatchObject({ upToDate: true, remoteChangesMade: false }); expect(r.imported).toHaveLength(0);
  });
});
