import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HANDOVER_GATES,
  prepareHandoverPackage,
  verifyAcceptanceRecord,
  verifyHandoverPackage,
  type HandoverManifest,
} from '../scripts/handover';
import { generateConfig, installationRoot } from '../scripts/installation';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const input = {
  accountId: 'a'.repeat(32),
  databaseId: '9bb827d6-4b25-4dbb-afb7-5b054d0d5929',
  databaseName: 'kumon-customer-db',
  workerName: 'kumon-customer-center',
  centerId: 'kumon_customer_center',
  accessIssuer: 'https://kumon-customer.cloudflareaccess.com',
  accessAudience: 'b'.repeat(64),
  ownerEmail: 'owner@kumon.example',
  backupQueue: 'kumon-customer-backups',
  backupProvider: 'r2' as const,
  backupBucket: 'kumon-customer-private-backups',
};

async function setup(configuration: Record<string, unknown> = input) {
  const directory = await mkdtemp(join(tmpdir(), 'kumon-handover-test-'));
  directories.push(directory);
  const configPath = join(directory, 'customer.json');
  const packageDirectory = join(directory, 'handover');
  await generateConfig(configuration, configPath, installationRoot);
  return { directory, configPath, packageDirectory };
}

async function manifest(directory: string) {
  return JSON.parse(await readFile(join(directory, 'handover-manifest.json'), 'utf8')) as HandoverManifest;
}

async function completedAcceptance(value: Awaited<ReturnType<typeof setup>>) {
  const record = JSON.parse(await readFile(join(value.packageDirectory, 'acceptance-record.template.json'), 'utf8'));
  record.status = 'accepted';
  record.customerApprover = {
    name: 'Kumon Owner',
    title: 'Authorized Customer Approver',
    email: 'customer.approver@kumon.example',
    acceptedAt: '2026-09-20T18:00:00.000Z',
  };
  record.supplierApprover = {
    name: 'Supplier Owner',
    title: 'Authorized Supplier Approver',
    email: 'supplier.approver@example.com',
    acceptedAt: '2026-09-20T18:01:00.000Z',
  };
  record.decisions.detailedAttendanceDays.approved = 100;
  record.decisions.evidenceRetentionDays.approved = 730;
  record.decisions.recoveryPointMinutes = 1_440;
  record.decisions.recoveryTimeMinutes = 240;
  record.decisions.supportEndDate = '2027-09-20';
  record.gates = record.gates.map((gate: { id: string }, index: number) => ({
    id: gate.id,
    status: 'accepted',
    evidenceReferences: [{
      reference: `customer-evidence/${String(index + 1).padStart(2, '0')}-${gate.id}.json`,
      observedAt: '2026-09-20T17:00:00.000Z',
      sha256: 'c'.repeat(64),
    }],
    acceptedBy: index % 2 ? 'supplier.approver@example.com' : 'customer.approver@kumon.example',
    acceptedAt: '2026-09-20T17:30:00.000Z',
  }));
  record.finalDecision = {
    status: 'accepted',
    acceptedBy: 'customer.approver@kumon.example',
    acceptedAt: '2026-09-20T18:02:00.000Z',
    conditions: ['Quarterly recovery exercises continue after handover.'],
  };
  const path = join(value.directory, 'completed-acceptance.json');
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, record };
}

describe('customer-owned handover package', () => {
  it('creates a private release-bound draft with every acceptance gate pending', async () => {
    const value = await setup();
    const prepared = await prepareHandoverPackage(value.configPath, value.packageDirectory);
    expect(prepared).toMatchObject({
      schemaVersion: 42,
      gateCount: HANDOVER_GATES.length,
      remoteChangesMade: false,
    });
    expect((await stat(value.packageDirectory)).mode & 0o077).toBe(0);

    const record = await manifest(value.packageDirectory);
    expect(record).toMatchObject({
      format: 'kumon-customer-handover-package-v1',
      status: 'draft',
      productionAccepted: false,
      remoteChangesMade: false,
      installation: {
        accountId: input.accountId,
        databaseId: input.databaseId,
        backupProvider: 'r2',
        backupBucket: input.backupBucket,
        backupsEnabled: false,
      },
      release: { schemaVersion: 42 },
    });
    expect(record.release.migrations.at(-1)?.name).toBe('0042_archive_v2_jobs.sql');
    expect(record.requiredSecretNames).toEqual(['BACKUP_KEY', 'CF_EXPORT_API_TOKEN', 'BACKUP_ALERT_URL']);
    expect(record.requiredAcceptanceGates).toEqual(HANDOVER_GATES);
    expect(record.files.some(item => item.path === 'documents/customer-owned-handover-package.md')).toBe(true);
    expect(record.files.some(item => item.path === 'documents/baseline-requirements-traceability.md')).toBe(true);
    expect(record.files.some(item => item.path === 'documents/backup-freshness-checkpoint-2026-09-21.md')).toBe(true);
    for (const item of record.files) {
      expect((await stat(join(value.packageDirectory, item.path))).mode & 0o177).toBe(0);
    }

    const acceptance = JSON.parse(await readFile(join(value.packageDirectory, 'acceptance-record.template.json'), 'utf8'));
    expect(acceptance.status).toBe('pending');
    expect(acceptance.customerApprover.acceptedAt).toBeNull();
    expect(acceptance.supplierApprover.acceptedAt).toBeNull();
    expect(acceptance.gates.map((gate: { id: string }) => gate.id)).toEqual(HANDOVER_GATES);
    expect(acceptance.gates.every((gate: { status: string }) => gate.status === 'pending')).toBe(true);
    expect(acceptance.decisions).toMatchObject({
      detailedAttendanceDays: { minimum: 90, maximum: 120, approved: null },
      evidenceRetentionDays: { minimum: 730, approved: null },
    });

    await expect(verifyHandoverPackage(value.packageDirectory)).resolves.toMatchObject({
      valid: true,
      status: 'draft',
      releaseSha256: prepared.releaseSha256,
      schemaVersion: 42,
      gateCount: HANDOVER_GATES.length,
      productionAccepted: false,
    });
    await expect(prepareHandoverPackage(value.configPath, value.packageDirectory)).rejects.toThrow('already exists');
  });

  it('verifies a private completed record bound to every release and installation gate', async () => {
    const value = await setup();
    const prepared = await prepareHandoverPackage(value.configPath, value.packageDirectory);
    const completed = await completedAcceptance(value);
    await expect(verifyAcceptanceRecord(value.packageDirectory, completed.path)).resolves.toMatchObject({
      valid: true,
      status: 'accepted',
      releaseSha256: prepared.releaseSha256,
      gateCount: HANDOVER_GATES.length,
      customerApproverEmail: 'customer.approver@kumon.example',
      supplierApproverEmail: 'supplier.approver@example.com',
      acceptedAt: '2026-09-20T18:02:00.000Z',
      conditionCount: 1,
      remoteChangesMade: false,
    });

    const result = spawnSync(process.execPath, [
      join(installationRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(installationRoot, 'scripts/handover-cli.ts'),
      'verify-acceptance',
      '--package',
      value.packageDirectory,
      '--record',
      completed.path,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, status: 'accepted', gateCount: HANDOVER_GATES.length });
  });

  it('rejects incomplete, mismatched, unsafe, or inconsistently signed acceptance records', async () => {
    const value = await setup();
    await prepareHandoverPackage(value.configPath, value.packageDirectory);
    const completed = await completedAcceptance(value);
    const save = async () => {
      await writeFile(completed.path, JSON.stringify(completed.record, null, 2) + '\n');
      await chmod(completed.path, 0o600);
    };

    completed.record.packageReleaseSha256 = 'd'.repeat(64);
    await save();
    await expect(verifyAcceptanceRecord(value.packageDirectory, completed.path)).rejects.toThrow('different release');

    completed.record.packageReleaseSha256 = (await manifest(value.packageDirectory)).release.sha256;
    completed.record.gates[3].evidenceReferences = [];
    await save();
    await expect(verifyAcceptanceRecord(value.packageDirectory, completed.path)).rejects.toThrow('requires bounded dated evidence');

    completed.record.gates[3].evidenceReferences = [{
      reference: 'customer-evidence/live-backup.json',
      observedAt: '2026-09-20T18:00:00.000Z',
      sha256: null,
    }];
    await save();
    await expect(verifyAcceptanceRecord(value.packageDirectory, completed.path)).rejects.toThrow('before its evidence');

    completed.record.gates[3].evidenceReferences[0].observedAt = '2026-09-20T17:00:00.000Z';
    completed.record.supplierApprover.email = completed.record.customerApprover.email;
    await save();
    await expect(verifyAcceptanceRecord(value.packageDirectory, completed.path)).rejects.toThrow('different identities');

    completed.record.supplierApprover.email = 'supplier.approver@example.com';
    completed.record.gates[3].acceptedBy = 'unnamed.reviewer@example.com';
    await save();
    await expect(verifyAcceptanceRecord(value.packageDirectory, completed.path)).rejects.toThrow('named approver');

    completed.record.gates[3].acceptedBy = 'supplier.approver@example.com';
    await save();
    await chmod(completed.path, 0o644);
    await expect(verifyAcceptanceRecord(value.packageDirectory, completed.path)).rejects.toThrow('permissions');
  });

  it('rejects changed, extra, linked, or publicly readable package content', async () => {
    const changed = await setup();
    await prepareHandoverPackage(changed.configPath, changed.packageDirectory);
    const runbook = join(changed.packageDirectory, 'documents', 'installation-runbook.md');
    await writeFile(runbook, `${await readFile(runbook, 'utf8')}changed\n`);
    await expect(verifyHandoverPackage(changed.packageDirectory)).rejects.toThrow('does not match');

    const extra = await setup();
    await prepareHandoverPackage(extra.configPath, extra.packageDirectory);
    await writeFile(join(extra.packageDirectory, 'secret.txt'), 'must not be accepted', { mode: 0o600 });
    await expect(verifyHandoverPackage(extra.packageDirectory)).rejects.toThrow('inventory');

    const linked = await setup();
    await prepareHandoverPackage(linked.configPath, linked.packageDirectory);
    const readme = join(linked.packageDirectory, 'README.md');
    await rm(readme);
    await symlink('/tmp/not-a-handover-file', readme);
    await expect(verifyHandoverPackage(linked.packageDirectory)).rejects.toThrow('file type');

    const publicPackage = await setup();
    await prepareHandoverPackage(publicPackage.configPath, publicPackage.packageDirectory);
    await chmod(join(publicPackage.packageDirectory, 'handover-manifest.json'), 0o644);
    await expect(verifyHandoverPackage(publicPackage.packageDirectory)).rejects.toThrow('permissions');
  });

  it('ships the exact release source and rejects changed or extra source files', async () => {
    const value = await setup();
    await prepareHandoverPackage(value.configPath, value.packageDirectory);
    const record = await manifest(value.packageDirectory);
    expect(record.files.some(item => item.path === 'release/worker/index.ts')).toBe(true);
    expect(record.files.some(item => item.path === 'release/migrations/0041_backup_failure_alert_retries.sql')).toBe(true);
    expect(record.files.some(item => item.path === 'release/migrations/0042_archive_v2_jobs.sql')).toBe(true);
    expect(record.files.some(item => item.path === 'release/package-lock.json')).toBe(true);
    await expect(verifyHandoverPackage(value.packageDirectory)).resolves.toMatchObject({ valid: true });

    const worker = join(value.packageDirectory, 'release', 'worker', 'index.ts');
    const original = await readFile(worker);
    await writeFile(worker, Buffer.concat([original, Buffer.from('\n// changed after sealing\n')]));
    await expect(verifyHandoverPackage(value.packageDirectory)).rejects.toThrow('does not match');
    await writeFile(worker, original);

    const extra = join(value.packageDirectory, 'release', 'worker', 'unsealed.ts');
    await writeFile(extra, 'export {};\n', { mode: 0o600 });
    await expect(verifyHandoverPackage(value.packageDirectory)).rejects.toThrow('inventory');
  });

  it('ships every linked review record with intact document links', async () => {
    const value = await setup();
    await prepareHandoverPackage(value.configPath, value.packageDirectory);
    let checkedLinks = 0;
    for (const documentsDirectory of [
      join(value.packageDirectory, 'documents'),
      join(value.packageDirectory, 'release', 'docs'),
    ]) {
      for (const name of await readdir(documentsDirectory)) {
        const markdown = await readFile(join(documentsDirectory, name), 'utf8');
        for (const match of markdown.matchAll(/\]\((\.\.\/review\/[^)]+)\)/g)) {
          expect((await stat(join(documentsDirectory, match[1]))).isFile()).toBe(true);
          checkedLinks += 1;
        }
      }
    }
    expect(checkedLinks).toBeGreaterThan(0);
    await expect(verifyHandoverPackage(value.packageDirectory)).resolves.toMatchObject({ valid: true });

    const review = join(value.packageDirectory, 'review', 'customer-handover-package', 'schema41-fresh-restore-storage-2026-09-22.json');
    await writeFile(review, '{}\n');
    await expect(verifyHandoverPackage(value.packageDirectory)).rejects.toThrow('does not match');
  });

  it('records the explicit legacy Google secret set without accepting secret values', async () => {
    const value = await setup({
      ...input,
      backupProvider: 'google-drive',
      backupBucket: undefined,
      googleOAuthMode: 'production',
      googleClientId: 'customer-client.apps.googleusercontent.com',
    });
    await prepareHandoverPackage(value.configPath, value.packageDirectory);
    const record = await manifest(value.packageDirectory);
    expect(record.installation).toMatchObject({ backupProvider: 'google-drive', backupBucket: null });
    expect(record.requiredSecretNames).toEqual([
      'BACKUP_KEY',
      'CF_EXPORT_API_TOKEN',
      'GOOGLE_CLIENT_SECRET',
      'BACKUP_ALERT_URL',
    ]);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('client-secret-value');
    await expect(verifyHandoverPackage(value.packageDirectory)).resolves.toMatchObject({ valid: true });
  });

  it('keeps invalid CLI arguments out of error output', () => {
    const result = spawnSync(process.execPath, [
      join(installationRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(installationRoot, 'scripts/handover-cli.ts'),
      'prepare',
      '--secret',
      'DO_NOT_PRINT',
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('DO_NOT_PRINT');
    expect(result.stderr).toContain('documented unique');
  });
});
