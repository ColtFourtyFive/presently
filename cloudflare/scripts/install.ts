/**
 * Installs Presently into a customer's own Cloudflare account.
 *
 *   npm run install:business -- --input installation.json            # print the plan only
 *   npm run install:business -- --input installation.json --execute  # run it
 *
 * Wrangler must be logged in to the customer's account (a temporary API token
 * in CLOUDFLARE_API_TOKEN, revoked at handover). The Cloudflare Access
 * application is created in the dashboard first; see docs/installation.md.
 *
 * The customer's configuration and recovery key are written outside this
 * repository, under the directory named by --workdir (default ../installations).
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
export class InstallError extends Error {}

export type Installation = {
  accountId: string; workerName: string; ownerEmail: string; accessTeamDomain: string; accessAudience: string;
  customDomain?: string; alertUrl?: string;
};

function text(value: unknown, name: string, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new InstallError(`installation.json: ${name} is missing or invalid.`);
  return value;
}

export function validateInstallation(value: unknown): Installation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InstallError('installation.json must be a JSON object.');
  const input = value as Record<string, unknown>;
  const allowed = ['accountId', 'workerName', 'ownerEmail', 'accessTeamDomain', 'accessAudience', 'customDomain', 'alertUrl'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) throw new InstallError(`installation.json has unsupported fields (${unknown.join(', ')}). Never put secrets in this file.`);
  return {
    accountId: text(input.accountId, 'accountId', /^[a-f0-9]{32}$/),
    workerName: text(input.workerName, 'workerName', /^[a-z0-9][a-z0-9-]{2,40}$/),
    ownerEmail: text(input.ownerEmail, 'ownerEmail', /^[^\s@]+@[^\s@]+\.[^\s@]+$/).toLowerCase(),
    accessTeamDomain: text(input.accessTeamDomain, 'accessTeamDomain', /^[a-z0-9-]+\.cloudflareaccess\.com$/),
    accessAudience: text(input.accessAudience, 'accessAudience', /^[a-f0-9]{64}$/),
    ...(input.customDomain === undefined ? {} : { customDomain: text(input.customDomain, 'customDomain', /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/) }),
    ...(input.alertUrl === undefined ? {} : { alertUrl: text(input.alertUrl, 'alertUrl', /^https:\/\/\S+$/) }),
  };
}

export const resourceNames = (install: Installation) => ({
  database: `${install.workerName}-db`, bucket: `${install.workerName}-backups`, queue: `${install.workerName}-backups`,
});

/** Customer Wrangler configuration. The Worker is minified and uploaded without source maps. */
export function customerConfig(install: Installation, databaseId: string, configDir: string, version: string) {
  const names = resourceNames(install);
  const path = (target: string) => relative(configDir, join(root, target)).split('\\').join('/');
  return {
    $schema: path('node_modules/wrangler/config-schema.json'),
    name: install.workerName,
    account_id: install.accountId,
    main: path('worker/index.ts'),
    compatibility_date: '2026-06-11',
    minify: true,
    upload_source_maps: false,
    workers_dev: !install.customDomain,
    preview_urls: false,
    ...(install.customDomain ? { routes: [{ pattern: install.customDomain, custom_domain: true }] } : {}),
    assets: { directory: path('dist/client'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
    d1_databases: [{ binding: 'CRM_DB', database_name: names.database, database_id: databaseId, migrations_dir: path('migrations') }],
    r2_buckets: [{ binding: 'BACKUP_BUCKET', bucket_name: names.bucket }],
    queues: {
      producers: [{ binding: 'BACKUP_QUEUE', queue: names.queue }],
      consumers: [{ queue: names.queue, max_batch_size: 1, max_retries: 5, max_concurrency: 1 }],
    },
    vars: {
      APP_ENV: 'production', APP_VERSION: version, ACCESS_ISSUER: `https://${install.accessTeamDomain}`, ACCESS_AUD: install.accessAudience,
      BOOTSTRAP_OWNER_EMAIL: install.ownerEmail, CF_ACCOUNT_ID: install.accountId, CF_DATABASE_ID: databaseId, BACKUP_ENABLED: 'true',
    },
    triggers: { crons: ['0 * * * *'] },
    observability: { enabled: true, head_sampling_rate: 1 },
  };
}

async function wrangler(args: string[], input?: string) {
  console.log(`$ wrangler ${args.join(' ')}`);
  await new Promise<void>((done, fail) => {
    const child = spawn('npx', ['wrangler', ...args], { cwd: root, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
    if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
    child.on('exit', code => (code === 0 ? done() : fail(new InstallError(`wrangler ${args.slice(0, 2).join(' ')} failed (exit ${code}).`))));
  });
}
async function databaseId(name: string) {
  const { stdout } = await run('npx', ['wrangler', 'd1', 'info', name, '--json'], { cwd: root });
  const id = (JSON.parse(stdout) as { uuid?: string }).uuid;
  if (!id) throw new InstallError(`Could not read the id of D1 database ${name}.`);
  return id;
}
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args[args.indexOf('--input') + 1];
  if (!args.includes('--input') || !inputPath) throw new InstallError('Usage: npm run install:business -- --input installation.json [--execute] [--workdir DIR]');
  const execute = args.includes('--execute');
  const workdir = resolve(args.includes('--workdir') ? args[args.indexOf('--workdir') + 1] : join(root, '..', 'installations'));
  const install = validateInstallation(JSON.parse(await readFile(inputPath, 'utf8')));
  const names = resourceNames(install);
  const target = join(workdir, install.workerName);
  const configPath = join(target, 'wrangler.jsonc');
  const keyPath = join(target, 'recovery.key');
  const version = String((JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version);

  const plan = [
    `Create D1 database ${names.database}, R2 bucket ${names.bucket} (private), and queue ${names.queue}.`,
    `Write ${configPath} (minified Worker, no source maps, hourly cron, ${install.customDomain ? `custom domain ${install.customDomain}` : 'workers.dev URL'}).`,
    'Apply database migrations with `wrangler d1 migrations apply --remote`.',
    `Generate the recovery key at ${keyPath} and a PIN pepper; upload both as Worker secrets.`,
    'Upload CF_D1_EXPORT_TOKEN from the PRESENTLY_D1_EXPORT_TOKEN environment variable (an API token limited to D1 Edit on this account).',
    ...(install.alertUrl ? ['Upload BACKUP_ALERT_URL.'] : []),
    'Build the client and deploy the Worker, then check /api/health.',
  ];
  console.log(`Installation plan for ${install.workerName} (${install.accountId}):\n${plan.map((step, i) => `  ${i + 1}. ${step}`).join('\n')}`);
  if (!execute) { console.log('\nDry run. Re-run with --execute to apply.'); return; }
  if (!process.env.PRESENTLY_D1_EXPORT_TOKEN) throw new InstallError('Set PRESENTLY_D1_EXPORT_TOKEN to an API token limited to D1 Edit on the customer account.');
  if (await exists(configPath)) throw new InstallError(`${configPath} already exists. This installer only creates new installations; use docs/operations.md to update one.`);

  await mkdir(target, { recursive: true, mode: 0o700 });
  await wrangler(['d1', 'create', names.database]);
  await wrangler(['r2', 'bucket', 'create', names.bucket]);
  await wrangler(['queues', 'create', names.queue]);
  const id = await databaseId(names.database);
  await writeFile(configPath, `${JSON.stringify(customerConfig(install, id, target, version), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await wrangler(['d1', 'migrations', 'apply', 'CRM_DB', '--remote', '--config', configPath]);
  const recoveryKey = randomBytes(32).toString('base64');
  await writeFile(keyPath, `${recoveryKey}\n`, { mode: 0o600, flag: 'wx' });
  await wrangler(['secret', 'put', 'BACKUP_KEY', '--config', configPath], recoveryKey);
  await wrangler(['secret', 'put', 'PIN_PEPPER', '--config', configPath], randomBytes(32).toString('base64'));
  await wrangler(['secret', 'put', 'CF_D1_EXPORT_TOKEN', '--config', configPath], process.env.PRESENTLY_D1_EXPORT_TOKEN);
  if (install.alertUrl) await wrangler(['secret', 'put', 'BACKUP_ALERT_URL', '--config', configPath], install.alertUrl);
  await new Promise<void>((done, fail) => spawn('npm', ['run', 'build:client'], { cwd: root, stdio: 'inherit' }).on('exit', code => (code === 0 ? done() : fail(new InstallError('Client build failed.')))));
  await wrangler(['deploy', '--config', configPath]);
  console.log(`\nInstalled. Next:
  1. Give the recovery key at ${keyPath} to the owner (password manager plus an offline copy), then delete it from this machine.
  2. The owner signs in as ${install.ownerEmail} through Cloudflare Access; the first sign-in creates the business.
  3. Follow the acceptance checklist in docs/installation.md, then revoke the temporary API token.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof InstallError ? error.message : `Installation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
