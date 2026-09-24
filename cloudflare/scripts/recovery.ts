/**
 * Owner-side recovery tool. Runs on the owner's computer, never in the Worker.
 *
 *   npm run recovery -- generate-key <key-file>
 *   npm run recovery -- download --bucket <bucket> --backup <backup-id> --key-file <key-file> --out <directory>
 *   npm run recovery -- decrypt --dir <directory> --key-file <key-file> --out <restore.sql>
 *
 * `download` uses Wrangler with the owner's Cloudflare login to copy the
 * encrypted objects from R2. `decrypt` verifies every part against the
 * encrypted manifest before writing the SQL file. See docs/operations.md.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openPart, verifyBackup, type BackupManifest } from '../worker/backup-crypto';

class UsageError extends Error {}

function options(values: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i];
    const value = values[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--')) throw new UsageError(`Unexpected option ${key}. Allowed: ${allowed.join(', ')}`);
    result[key] = value;
  }
  for (const key of allowed) if (!result[key]) throw new UsageError(`Missing ${key}.`);
  return result;
}

async function absent(path: string) {
  try { await stat(path); } catch { return; }
  throw new UsageError(`Refusing to overwrite ${path}.`);
}

async function readKey(path: string) {
  const key = (await readFile(path, 'utf8')).trim();
  if (Buffer.from(key, 'base64').length !== 32) throw new UsageError('The key file must contain a base64-encoded 32-byte recovery key.');
  return key;
}

function wrangler(args: string[]) {
  return new Promise<void>((done, fail) => {
    const child = spawn('npx', ['wrangler', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', code => (code === 0 ? done() : fail(new Error(`wrangler ${args[0]} ${args[1]} failed with exit code ${code}`))));
  });
}

async function generateKey(path: string) {
  await absent(path);
  await writeFile(path, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Wrote a new recovery key to ${path}.
Store it in the owner's password manager and a second offline place. Without it, backups cannot be decrypted.
Upload the same value as the BACKUP_KEY secret: npx wrangler secret put BACKUP_KEY --config <your config>`);
}

async function download(bucket: string, backupId: string, keyPath: string, out: string) {
  if (!/^[\w-]{1,100}$/.test(backupId)) throw new UsageError('Backup id is not valid.');
  const key = await readKey(keyPath);
  const directory = resolve(out);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fetchObject = async (name: string) => {
    const target = join(directory, name);
    await wrangler(['r2', 'object', 'get', `${bucket}/backups/${backupId}/${name}`, '--file', target, '--remote']);
    return new Uint8Array(await readFile(target));
  };
  const manifestEnvelope = await fetchObject('manifest.bin');
  const manifest = JSON.parse(new TextDecoder().decode((await openPart(key, manifestEnvelope)).plaintext)) as BackupManifest;
  for (const part of manifest.parts) await fetchObject(part.fileName);
  console.log(`Downloaded ${manifest.parts.length} encrypted parts of backup ${backupId} (${manifest.sqlBytes.toLocaleString()} bytes of SQL) to ${directory}.`);
}

async function decrypt(dir: string, keyPath: string, out: string) {
  await absent(out);
  const key = await readKey(keyPath);
  const directory = resolve(dir);
  const read = async (name: string) => {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Unsafe part name in manifest.');
    return new Uint8Array(await readFile(join(directory, name)));
  };
  const { manifest, sql } = await verifyBackup(key, await read('manifest.bin'), read);
  await writeFile(out, sql, { mode: 0o600, flag: 'wx' });
  console.log(`Verified all ${manifest.parts.length} parts of backup ${manifest.backupId} taken ${manifest.createdAt}.
Wrote ${out}. Restore it into a NEW database: see "Restore a backup" in docs/operations.md.`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'generate-key' && rest.length === 1) await generateKey(rest[0]);
  else if (command === 'download') { const o = options(rest, ['--bucket', '--backup', '--key-file', '--out']); await download(o['--bucket'], o['--backup'], o['--key-file'], o['--out']); }
  else if (command === 'decrypt') { const o = options(rest, ['--dir', '--key-file', '--out']); await decrypt(o['--dir'], o['--key-file'], o['--out']); }
  else throw new UsageError('Commands: generate-key <key-file> | download --bucket B --backup ID --key-file K --out DIR | decrypt --dir DIR --key-file K --out FILE.sql');
} catch (error) {
  console.error(error instanceof UsageError ? error.message : `Recovery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
