import { InstallationError } from './installation.js';
import { prepareHandoverPackage, verifyAcceptanceRecord, verifyHandoverPackage } from './handover.js';

const [operation, ...values] = process.argv.slice(2);
const allowed: Record<string, string[]> = {
  prepare: ['--config', '--out'],
  verify: ['--package'],
  'verify-acceptance': ['--package', '--record'],
};

try {
  if (!allowed[operation]) {
    throw new InstallationError('Commands: prepare, verify, verify-acceptance. See docs/customer-owned-handover-package.md.');
  }
  const flags: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!allowed[operation].includes(key) || key in flags || !value || value.startsWith('--')) {
      throw new InstallationError('Use only documented unique named options with values.');
    }
    flags[key] = value;
  }
  const required = (key: string) => {
    if (!flags[key]) throw new InstallationError(`Missing ${key}.`);
    return flags[key];
  };
  const result = operation === 'prepare'
    ? await prepareHandoverPackage(required('--config'), required('--out'))
    : operation === 'verify'
      ? await verifyHandoverPackage(required('--package'))
      : await verifyAcceptanceRecord(required('--package'), required('--record'));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof InstallationError ? error.message : 'Handover command failed.');
  process.exitCode = 1;
}
