import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  InstallationError,
  installationRoot,
  loadCustomerConfig,
  migrationInventory,
  parseJson,
  releaseFingerprint,
} from './installation.js';

const DOCUMENTS = [
  'docs/account-setup-handover.md',
  'docs/archive-activation-operator.md',
  'docs/backup-freshness-checkpoint-2026-09-21.md',
  'docs/baseline-requirements-traceability.md',
  'docs/combined-recovery.md',
  'docs/crm-parity.md',
  'docs/customer-owned-handover-package.md',
  'docs/installation-runbook.md',
  'docs/observation-correction-checkpoint-2026-09-21.md',
  'docs/outage-procedure.md',
  'docs/r2-backups.md',
  'docs/readiness-report.md',
] as const;

export const HANDOVER_GATES = [
  'customer_account_ownership',
  'source_and_contract_transfer',
  'staff_access_mfa_and_offboarding',
  'live_backup_delivery_and_alerts',
  'independent_populated_restore',
  'recovery_key_custody',
  'retention_holds_and_independent_copy',
  'deployed_capacity_and_cost',
  'ipad_concurrency_and_outage',
  'pickup_and_exception_workflows',
  'staff_training',
  'railway_cutover_and_rollback',
  'incident_and_support_contacts',
  'written_customer_acceptance',
] as const;

type HandoverGate = typeof HANDOVER_GATES[number];
type FileEvidence = { path: string; sha256: string; bytes: number };
type AcceptanceEvidenceReference = { reference: string; observedAt: string; sha256: string | null };

export type HandoverManifest = {
  format: 'kumon-customer-handover-package-v1';
  status: 'draft';
  createdAt: string;
  release: {
    version: string;
    sha256: string;
    fileCount: number;
    schemaVersion: number;
    migrations: Array<{ name: string; sha256: string }>;
  };
  installation: {
    accountId: string;
    databaseId: string;
    databaseName: string;
    workerName: string;
    centerId: string;
    ownerEmail: string;
    accessIssuer: string;
    accessAudience: string;
    backupProvider: 'r2' | 'google-drive';
    backupBucket: string | null;
    backupQueue: string;
    backupsEnabled: boolean;
    configSha256: string;
  };
  requiredSecretNames: string[];
  requiredAcceptanceGates: HandoverGate[];
  files: FileEvidence[];
  remoteChangesMade: false;
  productionAccepted: false;
};

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InstallationError(`${label} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function privateFile(path: string, content: string | Uint8Array): Promise<void> {
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
}

async function copyReleaseFiles(
  packageDirectory: string,
  root: string,
  releaseFiles: Array<{ path: string; sha256: string }>,
  evidence: FileEvidence[],
): Promise<void> {
  const destination = join(packageDirectory, 'release');
  await mkdir(destination, { mode: 0o700 });
  for (const file of releaseFiles) {
    const content = await readFile(join(root, file.path));
    if (sha256(content) !== file.sha256) {
      throw new InstallationError(`Release source changed while preparing handover: ${file.path}.`);
    }
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await privateFile(target, content);
    evidence.push({ path: `release/${file.path}`, sha256: file.sha256, bytes: content.byteLength });
  }
}

function referencedReviewPaths(documents: Iterable<Uint8Array>): string[] {
  const paths = new Set<string>();
  for (const document of documents) {
    const markdown = Buffer.from(document).toString('utf8');
    for (const match of markdown.matchAll(/\]\((\.\.\/review\/[^)]+)\)/g)) {
      const path = match[1].slice(3);
      if (!/^review\/(?:[a-z0-9_-]+\/)+[a-z0-9_-]+\.json$/.test(path)) {
        throw new InstallationError(`Unsafe handover review reference: ${match[1]}.`);
      }
      paths.add(path);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function copyReviewEvidence(
  packageDirectory: string,
  root: string,
  paths: string[],
  evidence: FileEvidence[],
): Promise<void> {
  await mkdir(join(packageDirectory, 'review'), { mode: 0o700 });
  await mkdir(join(packageDirectory, 'release', 'review'), { mode: 0o700 });
  for (const path of paths) {
    const source = join(root, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new InstallationError(`Handover review evidence is not a regular file: ${path}.`);
    }
    const content = await readFile(source);
    for (const targetPath of [path, `release/${path}`]) {
      const target = join(packageDirectory, targetPath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await privateFile(target, content);
      evidence.push({ path: targetPath, sha256: sha256(content), bytes: content.byteLength });
    }
  }
}

function requiredSecrets(provider: 'r2' | 'google-drive'): string[] {
  return provider === 'google-drive'
    ? ['BACKUP_KEY', 'CF_EXPORT_API_TOKEN', 'GOOGLE_CLIENT_SECRET', 'BACKUP_ALERT_URL']
    : ['BACKUP_KEY', 'CF_EXPORT_API_TOKEN', 'BACKUP_ALERT_URL'];
}

function acceptanceTemplate(releaseSha256: string, installation: HandoverManifest['installation']) {
  return {
    format: 'kumon-customer-acceptance-v1',
    packageReleaseSha256: releaseSha256,
    installation: {
      accountId: installation.accountId,
      databaseId: installation.databaseId,
      workerName: installation.workerName,
      centerId: installation.centerId,
    },
    status: 'pending',
    customerApprover: { name: null, title: null, email: null, acceptedAt: null },
    supplierApprover: { name: null, title: null, email: null, acceptedAt: null },
    decisions: {
      detailedAttendanceDays: { minimum: 90, maximum: 120, approved: null },
      evidenceRetentionDays: { minimum: 730, approved: null },
      recoveryPointMinutes: null,
      recoveryTimeMinutes: null,
      supportEndDate: null,
    },
    gates: HANDOVER_GATES.map(id => ({
      id,
      status: 'pending',
      evidenceReferences: [],
      acceptedBy: null,
      acceptedAt: null,
    })),
    finalDecision: { status: 'pending', acceptedBy: null, acceptedAt: null, conditions: [] },
  };
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new InstallationError(`${label} fields are incomplete or unsupported.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > maximum) {
    throw new InstallationError(`${label} is invalid.`);
  }
  return value;
}

function acceptanceEmail(value: unknown, label: string): string {
  const email = boundedString(value, label, 230).toLowerCase();
  if (!/^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,30}$/.test(email)) {
    throw new InstallationError(`${label} is invalid.`);
  }
  return email;
}

function acceptanceTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new InstallationError(`${label} must be an ISO UTC timestamp with milliseconds.`);
  }
  return timestamp;
}

function acceptanceApprover(value: unknown, label: string) {
  const approver = object(value, label);
  exactKeys(approver, ['name', 'title', 'email', 'acceptedAt'], label);
  return {
    name: boundedString(approver.name, `${label} name`, 150),
    title: boundedString(approver.title, `${label} title`, 150),
    email: acceptanceEmail(approver.email, `${label} email`),
    acceptedAt: acceptanceTimestamp(approver.acceptedAt, `${label} acceptedAt`),
  };
}

function acceptanceInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new InstallationError(`${label} is outside the supported range.`);
  }
  return Number(value);
}

function evidenceReference(value: unknown, gate: HandoverGate): AcceptanceEvidenceReference {
  const evidence = object(value, `Acceptance evidence for ${gate}`);
  exactKeys(evidence, ['reference', 'observedAt', 'sha256'], `Acceptance evidence for ${gate}`);
  const digest = evidence.sha256;
  if (digest !== null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) {
    throw new InstallationError(`Acceptance evidence for ${gate} has an invalid SHA-256 value.`);
  }
  return {
    reference: boundedString(evidence.reference, `Acceptance evidence reference for ${gate}`, 500),
    observedAt: acceptanceTimestamp(evidence.observedAt, `Acceptance evidence observedAt for ${gate}`),
    sha256: digest,
  };
}

function packageReadme(manifest: Omit<HandoverManifest, 'files'>): string {
  return `# Customer handover package\n\nThis is the draft evidence package for \`${manifest.installation.workerName}\`. It is bound to release \`${manifest.release.sha256}\` and schema ${manifest.release.schemaVersion}. It does not grant production approval.\n\nThe package contains no secret values or recovery key. Keep it private because it records account, database, Access, and owner identifiers. Store the recovery key separately from this package and the encrypted backups.\n\nThe \`release/\` directory contains the exact source, migrations, package lock, and tests bound to this release. It contains no installed dependencies or customer credentials. The cited local evidence is copied into \`review/\` so document links work after handover; it remains test evidence, not customer acceptance. Review the copied documents in \`documents/\`. Copy \`acceptance-record.template.json\` into a separate controlled acceptance record, attach dated evidence for every gate, and obtain named customer and supplier approval. Do not edit the template inside this sealed draft.\n\nCopy the sealed source into a working directory before installing dependencies. This keeps the package unchanged while you build and verify it:\n\n\`\`\`sh\ncp -R /private/customer/kumon-crm-handover/release /private/customer/kumon-crm-release-work\ncd /private/customer/kumon-crm-release-work\nnpm ci\nnpm run check\nnpm run build\nnpm run handover -- verify --package /private/customer/kumon-crm-handover\n\`\`\`\n\nAfter all evidence and approvals exist, verify the separate completed record:\n\n\`\`\`sh\nnpm run handover -- verify-acceptance \\\n  --package /private/customer/kumon-crm-handover \\\n  --record /private/customer/completed-acceptance.json\n\`\`\`\n\nThe package verifier checks the packaged source tree, release fingerprint, migration hashes, copied documents, private file permissions, and pending acceptance template. The completed-record verifier checks release and installation identity, every dated gate, approved retention and recovery targets, signer identities, and approval timing. Neither command contacts Cloudflare, proves the referenced evidence is truthful, tests backups, or grants acceptance by itself.\n`;
}

export async function prepareHandoverPackage(
  configPath: string,
  outputDirectory: string,
  root = installationRoot,
): Promise<{ packageDirectory: string; releaseSha256: string; schemaVersion: number; gateCount: number; remoteChangesMade: false }> {
  const output = resolve(outputDirectory);
  if (!(await missing(output))) throw new InstallationError('Handover output already exists. Choose a new directory.');
  const loaded = await loadCustomerConfig(configPath);
  const release = await releaseFingerprint(root);
  const migrations = await migrationInventory(root);
  const rawConfig = await readFile(resolve(configPath), 'utf8');
  const installation: HandoverManifest['installation'] = {
    accountId: loaded.input.accountId,
    databaseId: loaded.input.databaseId,
    databaseName: loaded.input.databaseName,
    workerName: loaded.input.workerName,
    centerId: loaded.input.centerId,
    ownerEmail: loaded.input.ownerEmail,
    accessIssuer: loaded.input.accessIssuer,
    accessAudience: loaded.input.accessAudience,
    backupProvider: loaded.input.backupProvider,
    backupBucket: loaded.input.backupProvider === 'r2' ? loaded.input.backupBucket : null,
    backupQueue: loaded.input.backupQueue,
    backupsEnabled: loaded.config.vars.BACKUP_ENABLED === 'true',
    configSha256: sha256(rawConfig),
  };
  const base = {
    format: 'kumon-customer-handover-package-v1' as const,
    status: 'draft' as const,
    createdAt: new Date().toISOString(),
    release: {
      version: release.version,
      sha256: release.sha256,
      fileCount: release.files.length,
      schemaVersion: migrations.length,
      migrations: migrations.map(({ name, sha256: migrationSha256 }) => ({ name, sha256: migrationSha256 })),
    },
    installation,
    requiredSecretNames: requiredSecrets(loaded.input.backupProvider),
    requiredAcceptanceGates: [...HANDOVER_GATES],
    remoteChangesMade: false as const,
    productionAccepted: false as const,
  };
  const temporary = `${output}.preparing-${crypto.randomUUID()}`;
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(join(temporary, 'documents'), { recursive: true, mode: 0o700 });
  await chmod(temporary, 0o700);
  const files: FileEvidence[] = [];
  try {
    const documentContents = new Map<string, Buffer>();
    for (const sourcePath of DOCUMENTS) {
      const content = await readFile(join(root, sourcePath));
      documentContents.set(sourcePath, content);
      const targetPath = `documents/${basename(sourcePath)}`;
      await privateFile(join(temporary, targetPath), content);
      files.push({ path: targetPath, sha256: sha256(content), bytes: content.byteLength });
    }
    await copyReleaseFiles(temporary, root, release.files, files);
    await mkdir(join(temporary, 'release', 'docs'), { mode: 0o700 });
    for (const sourcePath of DOCUMENTS) {
      const content = documentContents.get(sourcePath)!;
      const targetPath = `release/${sourcePath}`;
      await privateFile(join(temporary, targetPath), content);
      files.push({ path: targetPath, sha256: sha256(content), bytes: content.byteLength });
    }
    await copyReviewEvidence(temporary, root, referencedReviewPaths(documentContents.values()), files);
    const acceptance = json(acceptanceTemplate(release.sha256, installation));
    await privateFile(join(temporary, 'acceptance-record.template.json'), acceptance);
    files.push({ path: 'acceptance-record.template.json', sha256: sha256(acceptance), bytes: Buffer.byteLength(acceptance) });
    const readme = packageReadme(base);
    await privateFile(join(temporary, 'README.md'), readme);
    files.push({ path: 'README.md', sha256: sha256(readme), bytes: Buffer.byteLength(readme) });
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest: HandoverManifest = { ...base, files };
    await privateFile(join(temporary, 'handover-manifest.json'), json(manifest));
    if (!(await missing(output))) throw new InstallationError('Handover output was created by another process.');
    await rename(temporary, output);
    return {
      packageDirectory: output,
      releaseSha256: release.sha256,
      schemaVersion: migrations.length,
      gateCount: HANDOVER_GATES.length,
      remoteChangesMade: false,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function assertPrivate(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new InstallationError('Handover package contains an unsupported file type.');
  }
  const unsafe = info.mode & (directory ? 0o077 : 0o177);
  if (unsafe) throw new InstallationError('Handover package permissions are not private.');
}

async function packageTreeInventory(directory: string, prefix: string): Promise<string[]> {
  await assertPrivate(directory, true);
  const paths = [`${prefix}/`];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const child = `${prefix}/${name}`;
    const info = await lstat(path);
    if (info.isDirectory()) paths.push(...await packageTreeInventory(path, child));
    else {
      await assertPrivate(path, false);
      paths.push(child);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function expectedPackageTreeInventory(prefix: string, files: Array<{ path: string }>): string[] {
  const paths = new Set<string>([`${prefix}/`]);
  for (const file of files) {
    const components = file.path.split('/');
    for (let index = 1; index < components.length; index += 1) {
      paths.add(`${prefix}/${components.slice(0, index).join('/')}/`);
    }
    paths.add(`${prefix}/${file.path}`);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export async function verifyHandoverPackage(
  packageDirectory: string,
  root = installationRoot,
): Promise<{ valid: true; status: 'draft'; releaseSha256: string; schemaVersion: number; gateCount: number; manifestSha256: string; productionAccepted: false }> {
  const directory = resolve(packageDirectory);
  await assertPrivate(directory, true);
  const rootEntries = (await readdir(directory)).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(['README.md', 'acceptance-record.template.json', 'documents', 'handover-manifest.json', 'release', 'review'])) {
    throw new InstallationError('Handover package file inventory is not exact.');
  }
  await assertPrivate(join(directory, 'documents'), true);
  const documentEntries = (await readdir(join(directory, 'documents'))).sort();
  const expectedDocuments = DOCUMENTS.map(path => basename(path)).sort();
  if (JSON.stringify(documentEntries) !== JSON.stringify(expectedDocuments)) {
    throw new InstallationError('Handover document inventory is not exact.');
  }
  const reviewPaths = referencedReviewPaths(await Promise.all(
    DOCUMENTS.map(path => readFile(join(directory, 'documents', basename(path)))),
  ));
  if (JSON.stringify(await packageTreeInventory(join(directory, 'review'), 'review'))
    !== JSON.stringify(expectedPackageTreeInventory('review', reviewPaths.map(path => ({ path: path.slice('review/'.length) }))))) {
    throw new InstallationError('Handover review evidence inventory is not exact.');
  }
  const manifestPath = join(directory, 'handover-manifest.json');
  await assertPrivate(manifestPath, false);
  const manifestText = await readFile(manifestPath, 'utf8');
  const value = object(parseJson(manifestText), 'Handover manifest') as unknown as HandoverManifest;
  if (value.format !== 'kumon-customer-handover-package-v1' || value.status !== 'draft' || value.productionAccepted !== false || value.remoteChangesMade !== false) {
    throw new InstallationError('Handover manifest status is unsupported.');
  }
  const release = await releaseFingerprint(root);
  const migrations = await migrationInventory(root);
  if (JSON.stringify(await packageTreeInventory(join(directory, 'release'), 'release'))
    !== JSON.stringify(expectedPackageTreeInventory('release', [
      ...release.files,
      ...DOCUMENTS.map(path => ({ path })),
      ...reviewPaths.map(path => ({ path })),
    ]))) {
    throw new InstallationError('Handover release source inventory is not exact.');
  }
  if (
    value.release?.version !== release.version
    || value.release?.sha256 !== release.sha256
    || value.release?.fileCount !== release.files.length
    || value.release?.schemaVersion !== migrations.length
    || JSON.stringify(value.release?.migrations) !== JSON.stringify(migrations.map(({ name, sha256: migrationSha256 }) => ({ name, sha256: migrationSha256 })))
  ) {
    throw new InstallationError('Handover release evidence does not match this release.');
  }
  if (JSON.stringify(value.requiredAcceptanceGates) !== JSON.stringify(HANDOVER_GATES)) {
    throw new InstallationError('Handover acceptance gates are incomplete or reordered.');
  }
  const expectedPaths = [
    'README.md',
    'acceptance-record.template.json',
    ...expectedDocuments.map(name => `documents/${name}`),
    ...release.files.map(file => `release/${file.path}`),
    ...DOCUMENTS.map(path => `release/${path}`),
    ...reviewPaths,
    ...reviewPaths.map(path => `release/${path}`),
  ].sort((left, right) => left.localeCompare(right));
  const evidence = Array.isArray(value.files) ? [...value.files].sort((a, b) => a.path.localeCompare(b.path)) : [];
  if (JSON.stringify(evidence.map(item => item.path)) !== JSON.stringify(expectedPaths)) {
    throw new InstallationError('Handover manifest content inventory is not exact.');
  }
  for (const item of evidence) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 1) {
      throw new InstallationError('Handover file evidence is malformed.');
    }
    const path = join(directory, item.path);
    await assertPrivate(path, false);
    const content = await readFile(path);
    if (content.byteLength !== item.bytes || sha256(content) !== item.sha256) {
      throw new InstallationError('Handover file evidence does not match package content.');
    }
  }
  const acceptance = object(parseJson(await readFile(join(directory, 'acceptance-record.template.json'), 'utf8')), 'Acceptance template');
  if (acceptance.status !== 'pending' || acceptance.packageReleaseSha256 !== release.sha256) {
    throw new InstallationError('Handover acceptance template is not a pending record for this release.');
  }
  const gates = Array.isArray(acceptance.gates) ? acceptance.gates.map(gate => object(gate, 'Acceptance gate')) : [];
  if (
    JSON.stringify(gates.map(gate => gate.id)) !== JSON.stringify(HANDOVER_GATES)
    || gates.some(gate => gate.status !== 'pending')
  ) {
    throw new InstallationError('Handover acceptance template cannot claim completed gates.');
  }
  return {
    valid: true,
    status: 'draft',
    releaseSha256: release.sha256,
    schemaVersion: migrations.length,
    gateCount: HANDOVER_GATES.length,
    manifestSha256: sha256(manifestText),
    productionAccepted: false,
  };
}

export async function verifyAcceptanceRecord(
  packageDirectory: string,
  recordPath: string,
  root = installationRoot,
): Promise<{
  valid: true;
  status: 'accepted';
  releaseSha256: string;
  gateCount: number;
  customerApproverEmail: string;
  supplierApproverEmail: string;
  acceptedAt: string;
  conditionCount: number;
  recordSha256: string;
  remoteChangesMade: false;
}> {
  const directory = resolve(packageDirectory);
  const path = resolve(recordPath);
  const fromPackage = relative(directory, path);
  if (!fromPackage || (fromPackage !== '..' && !fromPackage.startsWith(`..${sep}`))) {
    throw new InstallationError('Completed acceptance record must be stored outside the sealed handover package.');
  }
  const packageResult = await verifyHandoverPackage(directory, root);
  await assertPrivate(path, false);
  if ((await stat(path)).size > 1024 * 1024) {
    throw new InstallationError('Completed acceptance record exceeds the supported size.');
  }
  const recordText = await readFile(path, 'utf8');
  const record = object(parseJson(recordText), 'Completed acceptance record');
  exactKeys(record, [
    'format',
    'packageReleaseSha256',
    'installation',
    'status',
    'customerApprover',
    'supplierApprover',
    'decisions',
    'gates',
    'finalDecision',
  ], 'Completed acceptance record');
  if (record.format !== 'kumon-customer-acceptance-v1' || record.status !== 'accepted') {
    throw new InstallationError('Completed acceptance record status is unsupported.');
  }
  if (record.packageReleaseSha256 !== packageResult.releaseSha256) {
    throw new InstallationError('Completed acceptance record targets a different release.');
  }

  const manifest = object(parseJson(await readFile(join(directory, 'handover-manifest.json'), 'utf8')), 'Handover manifest') as unknown as HandoverManifest;
  const installation = object(record.installation, 'Completed acceptance installation');
  exactKeys(installation, ['accountId', 'databaseId', 'workerName', 'centerId'], 'Completed acceptance installation');
  if (
    installation.accountId !== manifest.installation.accountId
    || installation.databaseId !== manifest.installation.databaseId
    || installation.workerName !== manifest.installation.workerName
    || installation.centerId !== manifest.installation.centerId
  ) {
    throw new InstallationError('Completed acceptance record targets a different installation.');
  }

  const customer = acceptanceApprover(record.customerApprover, 'Customer approver');
  const supplier = acceptanceApprover(record.supplierApprover, 'Supplier approver');
  if (customer.email === supplier.email) {
    throw new InstallationError('Customer and supplier approvals require different identities.');
  }

  const decisions = object(record.decisions, 'Acceptance decisions');
  exactKeys(decisions, [
    'detailedAttendanceDays',
    'evidenceRetentionDays',
    'recoveryPointMinutes',
    'recoveryTimeMinutes',
    'supportEndDate',
  ], 'Acceptance decisions');
  const detailed = object(decisions.detailedAttendanceDays, 'Detailed attendance decision');
  exactKeys(detailed, ['minimum', 'maximum', 'approved'], 'Detailed attendance decision');
  if (detailed.minimum !== 90 || detailed.maximum !== 120) {
    throw new InstallationError('Detailed attendance decision changed the supported range.');
  }
  acceptanceInteger(detailed.approved, 'Approved detailed attendance days', 90, 120);
  const retention = object(decisions.evidenceRetentionDays, 'Evidence retention decision');
  exactKeys(retention, ['minimum', 'approved'], 'Evidence retention decision');
  if (retention.minimum !== 730) {
    throw new InstallationError('Evidence retention decision changed the supported minimum.');
  }
  acceptanceInteger(retention.approved, 'Approved evidence retention days', 730, 36_500);
  acceptanceInteger(decisions.recoveryPointMinutes, 'Accepted recovery point minutes', 1, 1_440);
  acceptanceInteger(decisions.recoveryTimeMinutes, 'Accepted recovery time minutes', 1, 10_080);
  const supportEndDate = boundedString(decisions.supportEndDate, 'Support end date', 10);
  const supportEndTime = Date.parse(`${supportEndDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(supportEndDate)
    || !Number.isFinite(supportEndTime)
    || new Date(supportEndTime).toISOString().slice(0, 10) !== supportEndDate
  ) {
    throw new InstallationError('Support end date must be an ISO calendar date.');
  }

  const gates = Array.isArray(record.gates) ? record.gates.map(value => object(value, 'Acceptance gate')) : [];
  if (JSON.stringify(gates.map(gate => gate.id)) !== JSON.stringify(HANDOVER_GATES)) {
    throw new InstallationError('Completed acceptance gates are incomplete or reordered.');
  }
  const gateTimes: number[] = [];
  for (const [index, gate] of gates.entries()) {
    const gateId = HANDOVER_GATES[index];
    exactKeys(gate, ['id', 'status', 'evidenceReferences', 'acceptedBy', 'acceptedAt'], `Acceptance gate ${gateId}`);
    if (gate.status !== 'accepted') throw new InstallationError(`Acceptance gate ${gateId} is not accepted.`);
    const acceptedBy = acceptanceEmail(gate.acceptedBy, `Acceptance gate ${gateId} acceptedBy`);
    const acceptedAt = acceptanceTimestamp(gate.acceptedAt, `Acceptance gate ${gateId} acceptedAt`);
    if (![customer.email, supplier.email].includes(acceptedBy)) {
      throw new InstallationError(`Acceptance gate ${gateId} is not signed by a named approver.`);
    }
    if (Date.parse(acceptedAt) > Date.now() + 300_000) {
      throw new InstallationError(`Acceptance gate ${gateId} has invalid approval timing.`);
    }
    const references = Array.isArray(gate.evidenceReferences)
      ? gate.evidenceReferences.map(value => evidenceReference(value, gateId))
      : [];
    if (references.length < 1 || references.length > 50) {
      throw new InstallationError(`Acceptance gate ${gateId} requires bounded dated evidence.`);
    }
    if (references.some(reference => Date.parse(reference.observedAt) > Date.parse(acceptedAt))) {
      throw new InstallationError(`Acceptance gate ${gateId} was approved before its evidence was observed.`);
    }
    gateTimes.push(Date.parse(acceptedAt));
  }

  const finalDecision = object(record.finalDecision, 'Final acceptance decision');
  exactKeys(finalDecision, ['status', 'acceptedBy', 'acceptedAt', 'conditions'], 'Final acceptance decision');
  if (finalDecision.status !== 'accepted') throw new InstallationError('Final acceptance decision is not accepted.');
  const finalAcceptedBy = acceptanceEmail(finalDecision.acceptedBy, 'Final acceptance acceptedBy');
  const finalAcceptedAt = acceptanceTimestamp(finalDecision.acceptedAt, 'Final acceptance acceptedAt');
  if (finalAcceptedBy !== customer.email) {
    throw new InstallationError('Final acceptance must be signed by the named customer approver.');
  }
  const conditions = Array.isArray(finalDecision.conditions)
    ? finalDecision.conditions.map(value => boundedString(value, 'Final acceptance condition', 500))
    : [];
  if (conditions.length > 20) throw new InstallationError('Final acceptance has too many conditions.');
  const finalTime = Date.parse(finalAcceptedAt);
  if (
    finalTime > Date.now() + 300_000
    || finalTime < Date.parse(customer.acceptedAt)
    || finalTime < Date.parse(supplier.acceptedAt)
    || gateTimes.some(value => value > finalTime)
    || Date.parse(`${supportEndDate}T23:59:59.999Z`) < finalTime
  ) {
    throw new InstallationError('Final acceptance timing is inconsistent with approvals, gates, or support term.');
  }

  return {
    valid: true,
    status: 'accepted',
    releaseSha256: packageResult.releaseSha256,
    gateCount: HANDOVER_GATES.length,
    customerApproverEmail: customer.email,
    supplierApproverEmail: supplier.email,
    acceptedAt: finalAcceptedAt,
    conditionCount: conditions.length,
    recordSha256: sha256(recordText),
    remoteChangesMade: false,
  };
}
