import { readFile } from 'node:fs/promises';
import { doctor, generateConfig, InstallationError, migrateCustomer, parseJson, prepareUpdate } from './installation.js';

const [operation, ...values] = process.argv.slice(2);
const flags: Record<string, string> = {};
try {
  const allowed: Record<string, string[]> = {
    configure: ['--input', '--out'], doctor: ['--config'],
    'prepare-update': ['--config', '--backup', '--key-file', '--evidence', '--out', '--max-backup-age-minutes'],
    migrate: ['--config', '--confirm-database', '--execute', '--packet', '--key-file'],
  };
  if (!allowed[operation]) throw new InstallationError('Commands: configure, doctor, prepare-update, migrate. See docs/installation-runbook.md.');
  for (let index = 0; index < values.length; index++) {
    const key = values[index];
    if (!allowed[operation].includes(key) || key in flags) throw new InstallationError('Use only the documented unique named options for this command.');
    if (key === '--execute') flags[key] = 'true';
    else {
      const value = values[++index];
      if (!value || value.startsWith('--')) throw new InstallationError('Each option needs a value.');
      flags[key] = value;
    }
  }
  const required = (key: string) => { if (!flags[key]) throw new InstallationError(`Missing ${key}.`); return flags[key]; };
  let result: unknown;
  if (operation === 'configure') result = await generateConfig(parseJson(await readFile(required('--input'), 'utf8')), required('--out'));
  else if (operation === 'doctor') result = await doctor(required('--config'));
  else if (operation === 'prepare-update') result = await prepareUpdate({ configPath: required('--config'), backupDirectory: required('--backup'), keyPath: required('--key-file'), evidence: parseJson(await readFile(required('--evidence'), 'utf8')), outputPath: required('--out'), maximumBackupAgeMinutes: flags['--max-backup-age-minutes'] ? Number(flags['--max-backup-age-minutes']) : undefined });
  else if (operation === 'migrate') result = await migrateCustomer({ configPath: required('--config'), confirmDatabaseId: required('--confirm-database'), execute: flags['--execute'] === 'true', packetPath: flags['--packet'], keyPath: flags['--key-file'] });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof InstallationError ? error.message : 'Installation command failed. Check local file access, encryption key, and the documented prerequisites. File and provider content is not printed.');
  process.exitCode = 1;
}
