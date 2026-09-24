import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ArchiveRecord } from '../shared/archive-format';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { recoveryV2Fixture, type RecoveryV2Seed } from './archive-recovery-v2-fixture';
import { projectRoot } from './runtime';

type Fixture = Awaited<ReturnType<typeof recoveryV2Fixture>>;
type Mode = 'standalone' | 'combined';
const directories: string[] = [], processes = new Set<ChildProcess>();
let seed: RecoveryV2Seed;
beforeAll(async () => { seed = await nativeSemanticFixture(2, true); });
afterEach(async () => {
  await Promise.all([...processes].map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', () => resolve()); child.kill('SIGKILL');
  })));
  processes.clear();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(options: Parameters<typeof recoveryV2Fixture>[1] = {}) {
  const result = await recoveryV2Fixture(seed, options); directories.push(result.root); return result;
}
function outputFor(f: Fixture, mode: Mode) { return join(f.root, mode === 'standalone' ? 'recovered-history' : 'recovered.sql'); }
function cli(f: Fixture, mode: Mode, options: { keyFile?: string | null; bundle?: string; output?: string } = {}) {
  const output = options.output ?? outputFor(f, mode), bundle = options.bundle ?? f.bundle;
  const args = mode === 'standalone'
    ? ['scripts/archive-recovery.ts', 'verify-decrypt', bundle, f.entry.objectKey, output]
    : ['scripts/recovery.ts', 'verify-decrypt', f.backup, output, bundle];
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.KUMON_RECOVERY_KEY_FILE;
  if (options.keyFile !== null) env.KUMON_RECOVERY_KEY_FILE = options.keyFile ?? f.keyFile;
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { processes.delete(child); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done, output };
}
async function absent(path: string) { await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }); }
async function noPublication(f: Fixture, mode: Mode) {
  const output = outputFor(f, mode);
  await absent(output);
  if (mode === 'standalone') await absent(`${output}.lock`);
  else for (const suffix of ['.manifest.json', '.archives', '.recovery.lock']) await absent(output + suffix);
  const prefix = mode === 'standalone' ? '.kumon-archive-recovery-' : `.${basename(output)}.recovery-`;
  expect((await readdir(f.root)).filter(name => name.startsWith(prefix))).toEqual([]);
}
async function tree(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? [child, ...await tree(child)] : [child];
  }));
  return nested.flat();
}
async function recoveredRecords(output: string, archiveId: string): Promise<ArchiveRecord[]> {
  return (await readFile(join(output, 'records', `${archiveId}.jsonl`), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
}
async function assertHistory(f: Fixture, output: string) {
  expect(JSON.parse(await readFile(join(output, 'manifests.json'), 'utf8')).manifests).toEqual(f.manifests);
  expect((await stat(output)).mode & 0o777).toBe(0o700);
  const files = await tree(output);
  expect(files.some(path => /sqlite|[-.]wal$|[-.]shm$|\.semantic-|private-key/.test(path))).toBe(false);
  for (const [archiveId, records] of f.expected) {
    expect(await recoveredRecords(output, archiveId)).toEqual(records);
    expect((await stat(join(output, 'records', `${archiveId}.jsonl`))).mode & 0o777).toBe(0o600);
  }
}

describe('independent version 2 history recovery acceptance', () => {
  it('recovers exact native receipts, guardian-linked exceptional departure and consecutive corrections after the source was deleted', async () => {
    const f = await fixture(), result = await cli(f, 'standalone').done;
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ verified: true, archives: 1, records: seed.records.length });
    await assertHistory(f, outputFor(f, 'standalone'));
    const records = await recoveredRecords(outputFor(f, 'standalone'), f.base.manifest.archiveId);
    expect(records.filter(record => record.table === 'attendance_corrections')).toHaveLength(2);
    expect(records.find(record => record.table === 'attendance_events' && record.row.action === 'exceptional_departure' && record.row.visit_id)?.row.guardian_id).toBeTruthy();
    const events = records.filter(record => record.table === 'attendance_events');
    expect(events.find(record => record.row.visit_id === null)?.row.result_visit).toBe('null');
    expect(events.map(record => record.row.result_visit)).toEqual(f.expected.get(f.base.manifest.archiveId)!.filter(record => record.table === 'attendance_events').map(record => record.row.result_visit));
    expect(result.stdout + result.stderr).not.toContain(f.key);
  });

  it('recovers the monthly base and supported later resolution addendum in graph order', async () => {
    const f = await fixture({ addendum: true }), result = await cli(f, 'standalone').done;
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ verified: true, archives: 2 });
    await assertHistory(f, outputFor(f, 'standalone'));
  });

  it('publishes exact SQL and encrypted graph only after semantics pass, then independently recovers from the copied graph', async () => {
    const f = await fixture({ addendum: true }), output = outputFor(f, 'combined'), result = await cli(f, 'combined').done;
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(output, 'utf8')).toBe(f.sql);
    expect(JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'))).toEqual(f.backupManifest);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    for (const [name, bytes] of f.objects) expect(new Uint8Array(await readFile(join(`${output}.archives`, name)))).toEqual(bytes);
    expect((await tree(`${output}.archives`)).some(path => /sqlite|[-.]wal$|[-.]shm$|\.semantic-|private-key/.test(path))).toBe(false);
    await rm(f.bundle, { recursive: true });
    const again = await cli(f, 'standalone', { bundle: `${output}.archives` }).done;
    expect(again.code, again.stderr).toBe(0);
    await assertHistory(f, outputFor(f, 'standalone'));
    expect(result.stdout + result.stderr + again.stdout + again.stderr).not.toContain(f.key);
  });

  const inconsistent: [string, (records: ArchiveRecord[]) => void][] = [
    ['source and audit identity disagree', records => { records.find(record => record.table === 'attendance_events')!.row.actor_name = 'Changed after recording'; }],
    ['matched receipt is the literal null receipt', records => { records.find(record => record.table === 'attendance_events' && record.row.visit_id)!.row.result_visit = 'null'; }],
    ['unmatched receipt is SQL null instead of the literal null receipt', records => { records.find(record => record.table === 'attendance_events' && record.row.visit_id === null)!.row.result_visit = null; }],
    ['final visit version disagrees with event and correction history', records => { const visit = records.find(record => record.table === 'visits')!; visit.row.version = Number(visit.row.version) + 10; }],
    ['guardian pickup relationship is absent', records => { const event = records.find(record => record.table === 'attendance_events' && record.row.action === 'exceptional_departure' && record.row.guardian_id)!; const index = records.findIndex(record => record.table === 'student_guardians' && record.row.student_id === event.row.student_id && record.row.guardian_id === event.row.guardian_id); if (index < 0) throw new Error('Native fixture did not contain pickup relationship.'); records.splice(index, 1); }],
  ];
  describe.each<Mode>(['standalone', 'combined'])('%s failure safety', mode => {
    it.each(inconsistent)('rejects authentically encrypted history when %s', async (_name, mutate) => {
      const f = await fixture({ mutate }), result = await cli(f, mode).done;
      expect(result.code, result.stdout).toBe(1);
      expect(result.stdout).not.toContain('"verified":true');
      expect(result.stderr).toMatch(/semantic|evidence|receipt|audit|version|reference/i);
      await noPublication(f, mode);
      expect(result.stdout + result.stderr).not.toContain(f.key);
    });

    it.each(['missing key', 'wrong key', 'missing final part', 'corrupt final part', 'symlink part', 'symlink ancestor'] as const)('rejects %s without publishing plaintext', async failure => {
      const f = await fixture(), part = join(f.bundle, f.base.manifest.parts.at(-1)!.objectKey);
      if (failure === 'wrong key') await writeFile(f.keyFile, Buffer.alloc(32, 19).toString('base64'));
      if (failure === 'missing final part') await rm(part);
      if (failure === 'corrupt final part') { const bytes = await readFile(part); bytes[bytes.length - 1] ^= 1; await writeFile(part, bytes); }
      if (failure === 'symlink part') { const outside = join(f.root, 'outside-part'); await rename(part, outside); await symlink(outside, part); }
      if (failure === 'symlink ancestor') { const parent = dirname(part), outside = join(f.root, 'outside-directory'); await rename(parent, outside); await symlink(outside, parent); }
      const result = await cli(f, mode, failure === 'missing key' ? { keyFile: null } : {}).done;
      expect(result.code, result.stdout).toBe(1);
      expect(result.stdout).not.toContain('"verified":true');
      await noPublication(f, mode);
      expect(result.stdout + result.stderr).not.toContain(f.key);
    });

    it('keeps SQLite private and removes scratch, locks and partial output after interruption', async () => {
      const f = await fixture({ extraStudents: 10_000 }), run = cli(f, mode);
      const prefix = mode === 'standalone' ? '.kumon-archive-recovery-' : `.${basename(run.output)}.recovery-`;
      let scratch: string | undefined;
      for (let attempt = 0; attempt < 1500 && run.child.exitCode === null; attempt++) {
        const stage = (await readdir(f.root)).find(name => name.startsWith(prefix));
        if (stage) {
          const scratchDir = (await readdir(join(f.root, stage))).find(name => name.startsWith('.semantic-'));
          if (scratchDir) {
            const candidate = join(f.root, stage, scratchDir, 'records.sqlite');
            if (await stat(candidate).then(() => true, () => false)) { scratch = candidate; break; }
          }
        }
        await delay(2);
      }
      expect(scratch, 'semantic scratch was never observed before completion').toBeTruthy();
      expect((await stat(scratch!)).mode & 0o777).toBe(0o600);
      await absent(run.output);
      if (mode === 'combined') { await absent(`${run.output}.manifest.json`); await absent(`${run.output}.archives`); }
      run.child.kill('SIGTERM');
      const result = await run.done;
      expect(result.code, result.stderr).toBe(143);
      await noPublication(f, mode);
      expect(result.stdout + result.stderr).not.toContain(f.key);
    });
  });
});
