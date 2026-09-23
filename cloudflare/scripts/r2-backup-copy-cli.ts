import { InstallationError } from './installation';
import { copyR2Backup } from './r2-backup-copy';

const [operation, ...values] = process.argv.slice(2);
const flags: Record<string, string> = {};

try {
  if (operation !== 'copy') throw new InstallationError('Command: copy. See docs/r2-backups.md.');
  const allowed = ['--config', '--backup-id', '--key-file', '--out'];
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!allowed.includes(key) || key in flags || !value || value.startsWith('--')) {
      throw new InstallationError('Use each documented named option exactly once.');
    }
    flags[key] = value;
  }
  const required = (key: string) => {
    if (!flags[key]) throw new InstallationError(`Missing ${key}.`);
    return flags[key];
  };
  const result = await copyR2Backup({
    configPath: required('--config'),
    backupId: required('--backup-id'),
    keyPath: required('--key-file'),
    outputDirectory: required('--out'),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof InstallationError ? error.message : 'R2 backup copy failed. Provider output and secrets were not printed.');
  process.exitCode = 1;
}
