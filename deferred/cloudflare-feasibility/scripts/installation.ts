import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { verifyBackupStream, type BackupManifest } from '../worker/backup-crypto.js';
import { verifyBackupArchives } from '../worker/backup-archives.js';

export const MAINTENANCE_UNTIL = '9999-12-31T23:59:59.999Z';
export const installationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export class InstallationError extends Error {}
export function parseJson(source: string): unknown {
  try { return JSON.parse(source); } catch { throw new InstallationError('Invalid JSON. File content is not printed.'); }
}
const secretNames = ['BACKUP_KEY', 'CF_EXPORT_API_TOKEN', 'GOOGLE_CLIENT_SECRET', 'BACKUP_ALERT_URL'];
const requiredSecrets = (provider: InstallationInput['backupProvider']) => secretNames.filter(name => provider === 'google-drive' || name !== 'GOOGLE_CLIENT_SECRET');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InstallationError('Expected a JSON object.');
  return value as Record<string, unknown>;
};
function field(value: unknown, name: string, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new InstallationError(`Invalid ${name}.`);
  return value;
}
export type InstallationInput = {
  accountId: string; databaseId: string; databaseName: string; workerName: string; centerId: string;
  accessIssuer: string; accessAudience: string; ownerEmail: string; backupQueue: string;
} & (
  | { backupProvider: 'r2'; backupBucket: string }
  | { backupProvider: 'google-drive'; googleClientId?: string; googleOAuthMode: 'production' | 'internal' }
);
export type CustomerConfig = {
  $schema: string; name: string; account_id: string; main: string; compatibility_date: string;
  workers_dev: boolean; preview_urls: boolean;
  assets: { directory: string; binding: string; not_found_handling: string; run_worker_first: string[] };
  d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
  vars: Record<string, string>;
  r2_buckets?: { binding: string; bucket_name: string }[]; queues: { producers: { binding: string; queue: string }[]; consumers: { queue: string; max_batch_size: number; max_concurrency: number; max_retries: number }[] };
  triggers: { crons: string[] }; observability: { enabled: boolean; head_sampling_rate: number; traces: { enabled: boolean; head_sampling_rate: number } };
};
const relativePath = z.string().min(1).max(1024);
const customerConfigSchema: z.ZodType<CustomerConfig> = z.object({
  $schema: relativePath, name: z.string(), account_id: z.string(), main: relativePath,
  compatibility_date: z.literal('2026-06-11'), workers_dev: z.boolean(), preview_urls: z.literal(false),
  assets: z.object({ directory: relativePath, binding: z.literal('ASSETS'), not_found_handling: z.literal('single-page-application'), run_worker_first: z.tuple([z.literal('/api/*')]) }).strict(),
  d1_databases: z.array(z.object({ binding: z.literal('CRM_DB'), database_name: z.string(), database_id: z.string(), migrations_dir: relativePath }).strict()).length(1),
  r2_buckets: z.array(z.object({ binding: z.literal('BACKUP_BUCKET'), bucket_name: z.string() }).strict()).length(1).optional(),
  vars: z.object({ APP_ENV: z.literal('production'), APP_VERSION: z.string().min(1), CENTER_ID: z.string(), ACCESS_ISSUER: z.string(), ACCESS_AUD: z.string(), BOOTSTRAP_OWNER_EMAIL: z.string(), CF_ACCOUNT_ID: z.string(), CF_DATABASE_ID: z.string(), BACKUP_PROVIDER: z.enum(['r2', 'google-drive']), GOOGLE_OAUTH_MODE: z.enum(['production', 'internal']).optional(), GOOGLE_CLIENT_ID: z.string().optional(), BACKUP_ENABLED: z.enum(['true', 'false']), ARCHIVE_ENABLED: z.enum(['true', 'false']).optional(), ARCHIVE_V2_ENABLED: z.enum(['true', 'false']).optional() }).strict(),
  queues: z.object({
    producers: z.array(z.object({ binding: z.literal('BACKUP_QUEUE'), queue: z.string() }).strict()).length(1),
    consumers: z.array(z.object({ queue: z.string(), max_batch_size: z.literal(1), max_concurrency: z.literal(1), max_retries: z.literal(5) }).strict()).length(1),
  }).strict(),
  triggers: z.object({ crons: z.tuple([z.literal('*/5 * * * *')]) }).strict(),
  observability: z.object({ enabled: z.literal(true), head_sampling_rate: z.literal(0.1), traces: z.object({ enabled: z.literal(true), head_sampling_rate: z.literal(0.1) }).strict() }).strict(),
}).strict();
export function validateInstallation(value: unknown): InstallationInput {
  const input = record(value);
  const allowed = ['accountId', 'databaseId', 'databaseName', 'workerName', 'centerId', 'accessIssuer', 'accessAudience', 'ownerEmail', 'backupQueue', 'backupProvider', 'backupBucket', 'googleClientId', 'googleOAuthMode'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new InstallationError('Installation input contains an unsupported field. Do not put secrets in this file.');
  const accountId = field(input.accountId, 'accountId', /^[a-f0-9]{32}$/i);
  const databaseId = field(input.databaseId, 'databaseId', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  if (/^0+$/.test(accountId) || /^0+$/.test(databaseId.replaceAll('-', ''))) throw new InstallationError('Placeholder account/database identifiers are not installation targets.');
  const name = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const base = {
    accountId, databaseId, databaseName: field(input.databaseName, 'databaseName', name), workerName: field(input.workerName, 'workerName', name),
    centerId: field(input.centerId, 'centerId', /^[a-zA-Z0-9_-]{1,64}$/),
    accessIssuer: field(input.accessIssuer, 'accessIssuer', /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/).replace(/\/$/, ''),
    accessAudience: field(input.accessAudience, 'accessAudience', /^[a-f0-9]{64}$/i),
    ownerEmail: field(input.ownerEmail, 'ownerEmail', /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,30}$/).toLowerCase(), backupQueue: field(input.backupQueue, 'backupQueue', name),
  };
  const backupProvider = input.backupProvider === undefined ? 'r2' : input.backupProvider;
  if (backupProvider === 'r2') {
    if (input.googleClientId !== undefined || input.googleOAuthMode !== undefined) throw new InstallationError('R2 configuration must not contain Google OAuth fields. Choose google-drive explicitly for the legacy destination.');
    return { ...base, backupProvider, backupBucket: field(input.backupBucket, 'backupBucket', /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/) };
  }
  if (backupProvider !== 'google-drive') throw new InstallationError('backupProvider must be r2 or google-drive.');
  if (input.backupBucket !== undefined) throw new InstallationError('Google Drive configuration must not contain an R2 bucket.');
  if (input.googleOAuthMode !== 'production' && input.googleOAuthMode !== 'internal') throw new InstallationError('Declare Google OAuth production or internal mode. Testing mode is not suitable for long-lived backups.');
  return { ...base, backupProvider, googleOAuthMode: input.googleOAuthMode, ...(input.googleClientId === undefined ? {} : { googleClientId: field(input.googleClientId, 'googleClientId', /^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/) }) };
}

export async function migrationInventory(root = installationRoot) {
  const files = (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  if (!files.length) throw new InstallationError('Release has no migrations.');
  return Promise.all(files.map(async (name, index) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || Number(name.slice(0, 4)) !== index + 1) throw new InstallationError('Migration names must form a numbered sequence starting at 0001.');
    const sql = await readFile(join(root, 'migrations', name), 'utf8');
    return { name, sha256: hash(sql), sql };
  }));
}
export async function releaseFingerprint(root = installationRoot) {
  const files: { path: string; sha256: string }[] = [];
  async function scan(directory: string) {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new InstallationError('Release source must not contain symbolic links.');
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) files.push({ path, sha256: hash(await readFile(join(root, path))) });
    }
  }
  for (const directory of ['worker', 'shared', 'client', 'migrations', 'scripts', 'tests']) await scan(directory);
  for (const path of ['package.json', 'package-lock.json', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'index.html']) files.push({ path, sha256: hash(await readFile(join(root, path))) });
  const version = String(record(parseJson(await readFile(join(root, 'package.json'), 'utf8'))).version);
  return { version, sha256: hash(JSON.stringify(files)), files };
}
export async function generateConfig(inputValue: unknown, outputPath: string, root = installationRoot) {
  const input = validateInstallation(inputValue), output = resolve(outputPath);
  if (!output.endsWith('.json') || output === join(root, 'wrangler.jsonc') || output === join(root, 'package.json')) throw new InstallationError('Choose a new customer .json configuration path.');
  const path = (target: string) => relative(dirname(output), join(root, target)).split(sep).join('/');
  const version = String(record(parseJson(await readFile(join(root, 'package.json'), 'utf8'))).version);
  const config: CustomerConfig = {
    $schema: path('node_modules/wrangler/config-schema.json'), name: input.workerName, account_id: input.accountId, main: path('worker/index.ts'), compatibility_date: '2026-06-11', workers_dev: true, preview_urls: false,
    assets: { directory: path('dist/client'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
    d1_databases: [{ binding: 'CRM_DB', database_name: input.databaseName, database_id: input.databaseId, migrations_dir: path('migrations') }],
    ...(input.backupProvider === 'r2' ? { r2_buckets: [{ binding: 'BACKUP_BUCKET', bucket_name: input.backupBucket }] } : {}),
    vars: {
      APP_ENV: 'production', APP_VERSION: version, CENTER_ID: input.centerId, ACCESS_ISSUER: input.accessIssuer, ACCESS_AUD: input.accessAudience, BOOTSTRAP_OWNER_EMAIL: input.ownerEmail,
      CF_ACCOUNT_ID: input.accountId, CF_DATABASE_ID: input.databaseId, BACKUP_PROVIDER: input.backupProvider, BACKUP_ENABLED: 'false', ARCHIVE_ENABLED: 'false', ARCHIVE_V2_ENABLED: 'false',
      ...(input.backupProvider === 'google-drive' ? { GOOGLE_OAUTH_MODE: input.googleOAuthMode, ...(input.googleClientId ? { GOOGLE_CLIENT_ID: input.googleClientId } : {}) } : {}),
    },
    queues: { producers: [{ binding: 'BACKUP_QUEUE', queue: input.backupQueue }], consumers: [{ queue: input.backupQueue, max_batch_size: 1, max_concurrency: 1, max_retries: 5 }] },
    triggers: { crons: ['*/5 * * * *'] }, observability: { enabled: true, head_sampling_rate: 0.1, traces: { enabled: true, head_sampling_rate: 0.1 } },
  };
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { configPath: output, backupProvider: input.backupProvider, requiredSecretNames: requiredSecrets(input.backupProvider), remoteChangesMade: false };
}

export async function loadCustomerConfig(path: string) {
  const raw = await readFile(resolve(path), 'utf8'), value = record(parseJson(raw)), vars = record(value.vars);
  if (Object.keys(vars).some(key => secretNames.includes(key) || key.startsWith('LOCAL_ACCESS_'))) throw new InstallationError('Secrets and local authentication fixtures must not be stored in customer config.');
  if (vars.BACKUP_PROVIDER === undefined) throw new InstallationError('Set BACKUP_PROVIDER explicitly. For an existing Google-only configuration use google-drive; new installations default to r2.');
  const parsed = customerConfigSchema.safeParse(value);
  if (!parsed.success) throw new InstallationError('Customer configuration does not match the supported release contract.');
  if (vars.ARCHIVE_V2_ENABLED === 'true' && (vars.ARCHIVE_ENABLED !== 'true' || vars.BACKUP_PROVIDER !== 'r2')) throw new InstallationError('Version 2 history activation requires R2 and ARCHIVE_ENABLED=true.'); const config = parsed.data, database = config.d1_databases[0], producer = config.queues.producers[0], consumer = config.queues.consumers[0];
  const input = validateInstallation({ accountId: config.account_id, databaseId: database.database_id, databaseName: database.database_name, workerName: config.name, centerId: vars.CENTER_ID, accessIssuer: vars.ACCESS_ISSUER, accessAudience: vars.ACCESS_AUD, ownerEmail: vars.BOOTSTRAP_OWNER_EMAIL, backupQueue: producer.queue, backupProvider: vars.BACKUP_PROVIDER, backupBucket: config.r2_buckets?.[0]?.bucket_name, googleClientId: vars.GOOGLE_CLIENT_ID, googleOAuthMode: vars.GOOGLE_OAUTH_MODE });
  if (producer.queue !== consumer.queue) throw new InstallationError('Backup queue producer and consumer must match.');
  if (vars.CF_ACCOUNT_ID !== input.accountId || vars.CF_DATABASE_ID !== input.databaseId) throw new InstallationError('Production backup target does not match the deployment target.');
  return { config, input, configSha256: hash(raw), configPath: resolve(path) };
}

export async function doctor(configPath: string, root = installationRoot) {
  const loaded = await loadCustomerConfig(configPath);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new InstallationError('Node.js 22 or later is required.');
  const configDirectory = dirname(loaded.configPath);
  const expectedPaths: [string, string][] = [[loaded.config.main, 'worker/index.ts'], [loaded.config.d1_databases[0].migrations_dir, 'migrations'], [loaded.config.assets.directory, 'dist/client']];
  for (const [value, target] of expectedPaths) if (resolve(configDirectory, value) !== join(root, target)) throw new InstallationError('Customer config points outside the release package.');
  for (const file of ['node_modules/wrangler/bin/wrangler.js', 'node_modules/wrangler/config-schema.json', 'package-lock.json']) await lstat(join(root, file));
  const migrations = await migrationInventory(root), provider = loaded.input.backupProvider;
  return {
    localChecksPassed: true, configSha256: loaded.configSha256, migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    backupProvider: provider, requiredSecretNames: requiredSecrets(provider), backupsEnabled: loaded.config.vars.BACKUP_ENABLED === 'true',
    ...(loaded.input.backupProvider === 'google-drive' ? { missingGoogleClientId: !loaded.input.googleClientId } : { backupBucket: loaded.input.backupBucket }),
    unresolved: ['Cloudflare account ownership and resource existence', 'Access identity policy, audience and owner sign-in',
      ...(provider === 'r2' ? ['R2 activation and private bucket ownership; public domains and r2.dev must be disabled', 'Encrypted R2 delivery, download, independent restore, and copy outside the Cloudflare account'] : ['Google consent, refresh-token lifetime, and Drive delivery/restore']),
      'Worker secrets, D1 export access, alert delivery and backup enablement', 'Queue/storage allowances and measured full backup completion', 'Device and center operational acceptance'],
  };
}

export type CommandRunner = (executable: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
export const runCommand: CommandRunner = (executable, args, cwd) => new Promise((done, reject) => {
  const child = spawn(executable, args, { cwd, shell: false, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', bytes = 0, exceeded = false;
  const terminate = () => { exceeded = true; child.kill('SIGKILL'); };
  const timer = setTimeout(terminate, 10 * 60_000);
  child.stdout.on('data', data => { bytes += data.length; if (bytes > 8 * 1024 * 1024) terminate(); else stdout += data.toString(); });
  child.stderr.on('data', () => {}); // Provider output can contain credentials.
  child.on('error', () => { clearTimeout(timer); reject(new InstallationError('Could not start required local command.')); });
  child.on('close', code => { clearTimeout(timer); done({ code: exceeded ? 1 : code ?? 1, stdout }); });
});
async function command(runner: CommandRunner, executable: string, args: string[], label: string, root: string) {
  const result = await runner(executable, args, root);
  if (result.code !== 0) throw new InstallationError(`${label} failed. No later operation was run.`);
  return result.stdout;
}
export async function localPreflight(runner: CommandRunner = runCommand, root = installationRoot) {
  for (const task of ['check', 'test', 'build']) await command(runner, 'npm', ['run', task], `Local ${task}`, root);
}
async function privateFile(path: string, maximum: number, requirePrivate = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || (requirePrivate && (info.mode & 0o077))) throw new InstallationError('Expected a bounded regular private file; symbolic links are not accepted.');
  return readFile(path);
}
export async function verifyUpdateBackup(directory: string, keyPath: string, maximumAgeMinutes = 60) {
  if (!Number.isInteger(maximumAgeMinutes) || maximumAgeMinutes < 1 || maximumAgeMinutes > 1440) throw new InstallationError('Backup freshness must be between 1 and 1440 minutes.');
  const key = (await privateFile(resolve(keyPath), 128, true)).toString().trim();
  const manifestPath = join(resolve(directory), 'manifest.kcrm');
  const encrypted = await privateFile(manifestPath, 1024 * 1024);
  const root = resolve(directory);
  const manifest = await verifyBackupStream(key, new Uint8Array(encrypted), async name => new Uint8Array(await privateFile(join(root, name), 1024 * 1024 + 4096)), async () => {}, async references => {
    await verifyBackupArchives(key, references, async (objectKey, maximum) => {
      const segments = objectKey.split('/');
      if (objectKey.includes('\\') || segments.some(segment => !segment || segment === '.' || segment === '..') || !objectKey.startsWith('archives/')) throw new InstallationError('Unsafe historical archive object path.');
      let path = root;
      if ((await lstat(path)).isSymbolicLink()) throw new InstallationError('Historical archive bundle must not contain symbolic links.');
      for (const segment of segments) {
        path = join(path, segment);
        if ((await lstat(path)).isSymbolicLink()) throw new InstallationError('Historical archive bundle must not contain symbolic links.');
      }
      return new Uint8Array(await privateFile(path, maximum));
    }, async () => {});
  });
  const age = Date.now() - Date.parse(manifest.createdAt);
  if (!Number.isFinite(age) || age < -60_000 || age > maximumAgeMinutes * 60_000) throw new InstallationError('A recent completed backup is required before preparing an update.');
  return { manifest, encryptedManifestSha256: hash(encrypted) };
}
export type MaintenanceEvidence = { accountId: string; databaseId: string; backupId: string; verifiedBy: string; writesStoppedAt: string; maintenanceLockId: string; restoreDrillReference: string; stagingMigrationEvidence: string; acceptLegacyLedger: boolean };
export type UpdatePacket = { format: 'kumon-update-packet-v1'; preparedAt: string; configPath: string; configSha256: string; releaseSha256: string; targetVersion: string; backupDirectory: string; backupId: string; encryptedManifestSha256: string; maximumBackupAgeMinutes: number; maintenance: MaintenanceEvidence; migrations: { name: string; sha256: string }[] };
const timestamp = z.string().datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)));
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const maintenanceSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/i), databaseId: uuid,
  backupId: z.string().regex(/^[\w-]{1,100}$/), verifiedBy: z.string().min(3).max(150),
  writesStoppedAt: timestamp, maintenanceLockId: z.string().regex(/^upgrade-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
  restoreDrillReference: z.string().min(5).max(500), stagingMigrationEvidence: z.string().min(5).max(500), acceptLegacyLedger: z.boolean(),
}).strict();
function validateMaintenance(value: unknown): MaintenanceEvidence {
  const parsed = maintenanceSchema.safeParse(value);
  if (!parsed.success) throw new InstallationError('Invalid maintenance evidence. Use the documented fields and ISO timestamps.');
  return parsed.data;
}
const packetSchema: z.ZodType<UpdatePacket> = z.object({
  format: z.literal('kumon-update-packet-v1'), preparedAt: timestamp, configPath: z.string().min(1),
  configSha256: sha256, releaseSha256: sha256, targetVersion: z.string().min(1), backupDirectory: z.string().min(1),
  backupId: z.string().min(1), encryptedManifestSha256: sha256, maximumBackupAgeMinutes: z.number().int().min(1).max(1440),
  maintenance: maintenanceSchema, migrations: z.array(z.object({ name: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/), sha256 }).strict()).min(1),
}).strict();
function validatePacket(value: unknown): UpdatePacket {
  const parsed = packetSchema.safeParse(value);
  if (!parsed.success) throw new InstallationError('Invalid update packet. Prepare a new packet with this release.');
  return parsed.data;
}
export async function prepareUpdate(args: { configPath: string; backupDirectory: string; keyPath: string; evidence: unknown; outputPath: string; maximumBackupAgeMinutes?: number }, runner = runCommand, root = installationRoot) {
  const loaded = await loadCustomerConfig(args.configPath), maintenance = validateMaintenance(args.evidence);
  if (maintenance.accountId !== loaded.input.accountId || maintenance.databaseId !== loaded.input.databaseId) throw new InstallationError('Maintenance evidence targets a different installation.');
  const maximumBackupAgeMinutes = args.maximumBackupAgeMinutes ?? 60;
  const backup = await verifyUpdateBackup(args.backupDirectory, args.keyPath, maximumBackupAgeMinutes);
  if (backup.manifest.backupId !== maintenance.backupId || !Number.isFinite(Date.parse(maintenance.writesStoppedAt)) || Date.parse(maintenance.writesStoppedAt) > Date.parse(backup.manifest.createdAt)) throw new InstallationError('Backup must match the evidence and follow the recorded stop of normal writes.');
  await doctor(args.configPath, root);
  await localPreflight(runner, root);
  const release = await releaseFingerprint(root), migrations = await migrationInventory(root);
  const packet: UpdatePacket = { format: 'kumon-update-packet-v1', preparedAt: new Date().toISOString(), configPath: loaded.configPath,
    configSha256: loaded.configSha256, releaseSha256: release.sha256, targetVersion: release.version,
    backupDirectory: resolve(args.backupDirectory), backupId: backup.manifest.backupId, encryptedManifestSha256: backup.encryptedManifestSha256,
    maximumBackupAgeMinutes, maintenance, migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })) };
  await mkdir(dirname(resolve(args.outputPath)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(args.outputPath), JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { packetPath: resolve(args.outputPath), targetVersion: packet.targetVersion, backupVerified: true, localChecksPassed: true, remoteChangesMade: false };
}

function jsonRows(output: string): Record<string, unknown>[] {
  let decoded: unknown;
  try { decoded = JSON.parse(output); } catch { throw new InstallationError('Wrangler did not return valid structured output.'); }
  const groups = Array.isArray(decoded) ? decoded : [decoded];
  return groups.flatMap(group => {
    const item = record(group);
    if (item.success === false) throw new InstallationError('D1 reported an unsuccessful operation.');
    return Array.isArray(item.results) ? item.results.map(record) : [item];
  });
}
export async function migrateCustomer(args: { configPath: string; confirmDatabaseId: string; execute: boolean; packetPath?: string; keyPath?: string }, runner = runCommand, root = installationRoot) {
  const loaded = await loadCustomerConfig(args.configPath), inventory = await migrationInventory(root);
  if (args.confirmDatabaseId !== loaded.input.databaseId) throw new InstallationError('Explicit database confirmation must match the customer config.');
  if (!args.execute) return { remoteChangesMade: false, planOnly: true, migrations: inventory.map(({ name, sha256 }) => ({ name, sha256 })) };
  await doctor(args.configPath, root);
  const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
  const wrangler = (parts: string[], label: string) => command(runner, process.execPath, [cli, ...parts, '--config', loaded.configPath], label, root);
  const infoRows = jsonRows(await wrangler(['d1', 'info', 'CRM_DB', '--json'], 'Target identity check'));
  const info = infoRows[0];
  if (!info || (info.uuid ?? info.id) !== loaded.input.databaseId || info.name !== loaded.input.databaseName) throw new InstallationError('Remote database identity does not match the selected target.');
  const query = async (sql: string) => jsonRows(await wrangler(['d1', 'execute', 'CRM_DB', '--remote', '--json', '--command', sql], 'D1 metadata check'));
  const tables = (await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'")).map(row => String(row.name));
  const existing = tables.filter(name => name !== 'd1_migrations');
  const applied = tables.includes('d1_migrations') ? (await query('SELECT name FROM d1_migrations ORDER BY id')).map(row => String(row.name)) : [];
  if (new Set(applied).size !== applied.length || applied.some((name, index) => name !== inventory[index]?.name)) throw new InstallationError('Remote migration ledger is unknown, out of order, or ahead of this release.');
  const hashes = tables.includes('installation_migration_hashes') ? await query('SELECT name,sha256 FROM installation_migration_hashes ORDER BY name') : [];
  if (new Set(hashes.map(item => item.name)).size !== hashes.length || hashes.some(item => !applied.includes(String(item.name)))) throw new InstallationError('Migration checksum ledger does not match applied migrations.');
  for (const item of hashes) if (inventory.find(migration => migration.name === item.name)?.sha256 !== item.sha256) throw new InstallationError('An applied migration checksum differs from this release.');
  if ((!existing.length && applied.length) || (existing.length && (!applied.length || !tables.includes('backup_runtime')))) throw new InstallationError('Existing database has no supported application migration history. Review it manually before using this installer.');
  const pending = inventory.slice(applied.length);
  if (!pending.length) return { remoteChangesMade: false, upToDate: true, applied: applied.length, legacyChecksumsMissing: applied.length - hashes.length };
  let packet: UpdatePacket | undefined;
  if (existing.length) {
    if (!args.packetPath || !args.keyPath) throw new InstallationError('An existing database requires a verified update packet and recovery key file.');
    packet = validatePacket(parseJson((await privateFile(resolve(args.packetPath), 1024 * 1024)).toString()));
    const age = Date.now() - Date.parse(packet.preparedAt);
    if (packet.format !== 'kumon-update-packet-v1' || !Number.isFinite(age) || age < -60_000 || age > 30 * 60_000 || packet.configSha256 !== loaded.configSha256 || packet.releaseSha256 !== (await releaseFingerprint(root)).sha256) throw new InstallationError('Update packet is stale or the config/release changed after verification.');
    if (packet.maintenance.accountId !== loaded.input.accountId || packet.maintenance.databaseId !== loaded.input.databaseId || packet.maintenance.backupId !== packet.backupId || JSON.stringify(packet.migrations) !== JSON.stringify(inventory.map(({ name, sha256 }) => ({ name, sha256 })))) throw new InstallationError('Update packet target or migration inventory does not match this installation.');
    const backup = await verifyUpdateBackup(packet.backupDirectory, args.keyPath, packet.maximumBackupAgeMinutes);
    if (Date.parse(packet.maintenance.writesStoppedAt) > Date.parse(backup.manifest.createdAt)) throw new InstallationError('The backup predates the recorded stop of normal writes.');
    if (backup.encryptedManifestSha256 !== packet.encryptedManifestSha256 || backup.manifest.backupId !== packet.backupId) throw new InstallationError('The verified backup changed.');
    if (applied.length !== hashes.length && !packet.maintenance.acceptLegacyLedger) throw new InstallationError('Applied migrations lack checksums. Review the installed release and explicitly accept the legacy ledger in maintenance evidence.');
    const locks = await query('SELECT write_locked_until,lock_job_id FROM backup_runtime WHERE id=1');
    const lockUntil = Date.parse(String(locks[0]?.write_locked_until));
    if (locks.length !== 1 || locks[0]?.lock_job_id !== packet.maintenance.maintenanceLockId || !Number.isFinite(lockUntil) || locks[0]?.write_locked_until !== MAINTENANCE_UNTIL) throw new InstallationError('The matching maintenance write lock must remain active for at least 30 minutes.');
    if (Number((await query("SELECT count(*) AS n FROM backup_jobs WHERE status NOT IN ('complete','failed')"))[0]?.n) !== 0) throw new InstallationError('A backup job is still active.');
  }
  const directory = join(root, '.installation-work', crypto.randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sqlPath = join(directory, 'migration.sql');
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  let sql = "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);\nCREATE TABLE IF NOT EXISTS installation_migration_hashes(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);\n";
  if (packet?.maintenance.acceptLegacyLedger) for (const migration of inventory.slice(0, applied.length)) sql += `INSERT OR IGNORE INTO installation_migration_hashes(name,sha256) VALUES(${literal(migration.name)},${literal(migration.sha256)});\n`;
  for (const migration of pending) sql += `${migration.sql}\nINSERT INTO d1_migrations(name) VALUES(${literal(migration.name)});\nINSERT INTO installation_migration_hashes(name,sha256) VALUES(${literal(migration.name)},${literal(migration.sha256)});\n`;
  await writeFile(sqlPath, sql, { mode: 0o600, flag: 'wx' });
  try {
    await wrangler(['d1', 'execute', 'CRM_DB', '--remote', '--file', sqlPath, '--yes'], 'Native D1 migration import');
    const after = (await query('SELECT name FROM d1_migrations ORDER BY id')).map(row => String(row.name));
    const afterHashes = await query('SELECT name,sha256 FROM installation_migration_hashes ORDER BY name');
    if (afterHashes.length !== inventory.length || afterHashes.some((item, index) => item.name !== inventory[index].name || item.sha256 !== inventory[index].sha256) || JSON.stringify(after) !== JSON.stringify(inventory.map(item => item.name))) throw new InstallationError('Post-migration ledger verification failed. Keep maintenance active and inspect before continuing.');
    return { remoteChangesMade: true, applied: pending.map(item => item.name), maintenanceReleased: false, next: 'Verify schema and application under maintenance. Deployment and reopening access require the operating runbook; code rollback does not undo migrations.' };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
