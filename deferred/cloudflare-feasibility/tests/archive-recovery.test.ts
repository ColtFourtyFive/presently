import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ARCHIVE_LIMITS, type ArchiveMetadata, type ArchiveRecord } from '../shared/archive-format';
import { createArchive } from '../worker/archive-codec';
import { bytes64 } from '../worker/backup-crypto';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temp() { const path = await mkdtemp(join(tmpdir(), 'kumon-archive-cli-')); directories.push(path); return path; }
const metadata = (extra: Partial<ArchiveMetadata> = {}): ArchiveMetadata => ({ archiveId: 'archive-1', centerId: 'center-1', month: '2026-01', timezone: 'UTC', kind: 'monthly', createdAt: '2026-02-03T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [1], references: [], ...extra });
const records = (count: number): ArchiveRecord[] => Array.from({ length: count }, (_, i) => {
  const id = `student-${String(i).padStart(6, '0')}`;
  return { table: 'students', key: id, row: { id, center_id: 'center-1', student_code: id, first_name: 'Synthetic', last_name: 'Fixture' } };
});
async function fixture(count = 300) {
  const root = await temp(), bundle = join(root, 'bundle'), output = join(root, 'recovered'), keyFile = join(root, 'key.txt');
  await mkdir(bundle); const key = bytes64(crypto.getRandomValues(new Uint8Array(32))); await writeFile(keyFile, key, { mode: 0o600 });
  const write = async (name: string, bytes: Uint8Array) => { const path = join(bundle, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
  const archive = await createArchive(key, metadata(), records(count), async (part, encrypted) => write(part.objectKey, encrypted)); await write(archive.objectKey, archive.encrypted);
  return { root, bundle, output, keyFile, key, write, ...archive };
}
function cli(bundle: string, entry: string, output: string, keyFile: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/archive-recovery.ts'), 'verify-decrypt', bundle, entry, output], { cwd: resolve('.'), env: { ...process.env, KUMON_RECOVERY_KEY_FILE: keyFile, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((accept, reject) => { child.on('error', reject); child.on('close', (code, signal) => accept({ code, signal, stdout, stderr })); });
  return { child, done };
}
async function cleanFailure(root: string, output: string) {
  await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(`${output}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(root)).filter(name => name.startsWith('.kumon-archive-recovery-'))).toEqual([]);
}

describe('independent historical archive recovery CLI', () => {
  it('publishes verified private JSONL and manifests, preserves exact evidence, and refuses overwrite', async () => {
    const f = await fixture(); const result = await cli(f.bundle, f.objectKey, f.output, f.keyFile).done;
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ verified: true, archives: 1, records: 300 });
    const outputRecords = (await readFile(join(f.output, 'records/archive-1.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(outputRecords).toEqual(records(300));
    expect(JSON.parse(await readFile(join(f.output, 'manifests.json'), 'utf8')).manifests).toEqual([f.manifest]);
    expect((await stat(f.output)).mode & 0o777).toBe(0o700); expect((await stat(join(f.output, 'records/archive-1.jsonl'))).mode & 0o777).toBe(0o600);
    const before = await readFile(join(f.output, 'manifests.json'));
    const again = await cli(f.bundle, f.objectKey, f.output, f.keyFile).done; expect(again.code).toBe(1); expect(again.stderr).toContain('Refusing to replace'); expect(await readFile(join(f.output, 'manifests.json'))).toEqual(before);
  });

  it('publishes all immutable parent/addendum versions together', async () => {
    const f = await fixture(1);
    const evidence: ArchiveRecord = { table: 'audit_entries', key: 'audit-1', row: { id: 'audit-1', center_id: 'center-1', actor_name: 'Synthetic Staff', action: 'review.resolve', entity_type: 'review', entity_id: 'review-1', detail: '{"reason":"Later review"}', created_at: '2026-02-04T00:00:00.000Z' } };
    const addendum = await createArchive(f.key, metadata({ archiveId: 'addendum-1', kind: 'addendum', createdAt: '2026-02-05T00:00:00.000Z', references: [{ archiveId: 'archive-1', kind: 'monthly', manifestObjectKey: f.objectKey, manifestSha256: f.sha256 }] }), [evidence], async (part, bytes) => f.write(part.objectKey, bytes));
    await f.write(addendum.objectKey, addendum.encrypted);
    const result = await cli(f.bundle, addendum.objectKey, f.output, f.keyFile).done; expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ archives: 2, records: 2 });
    expect(JSON.parse((await readFile(join(f.output, 'records/addendum-1.jsonl'), 'utf8')).trim())).toEqual(evidence);
    expect(JSON.parse(await readFile(join(f.output, 'manifests.json'), 'utf8')).manifests.map((m: { archiveId: string }) => m.archiveId)).toEqual(['archive-1', 'addendum-1']);
  });

  it.each(['wrong key', 'missing final part', 'corrupt final part', 'oversized input', 'symlink part'] as const)('leaves no visible or staged plaintext after %s', async mode => {
    const f = await fixture(); const part = f.manifest.parts.at(-1)!, path = join(f.bundle, part.objectKey);
    if (mode === 'wrong key') await writeFile(f.keyFile, bytes64(crypto.getRandomValues(new Uint8Array(32))));
    if (mode === 'missing final part') await rm(path);
    if (mode === 'corrupt final part') { const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes); }
    if (mode === 'oversized input') await writeFile(join(f.bundle, f.objectKey), new Uint8Array(ARCHIVE_LIMITS.encryptedManifestBytes + 1));
    if (mode === 'symlink part') { const real = join(f.root, 'outside.kca'); await writeFile(real, await readFile(path)); await rm(path); await symlink(real, path); }
    const result = await cli(f.bundle, f.objectKey, f.output, f.keyFile).done;
    expect(result.code, result.stdout).toBe(1); expect(result.stderr).toContain('Archive recovery failed'); await cleanFailure(f.root, f.output);
  });

  it('cleans private staging on process interruption', async () => {
    const f = await fixture(20000), run = cli(f.bundle, f.objectKey, f.output, f.keyFile);
    let staged = false;
    for (let i = 0; i < 1000; i++) {
      if ((await readdir(f.root)).some(name => name.startsWith('.kumon-archive-recovery-'))) { staged = true; break; }
      await delay(2);
    }
    expect(staged).toBe(true); run.child.kill('SIGTERM');
    const result = await run.done; expect(result.code).toBe(143); await cleanFailure(f.root, f.output);
  });
});
