import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { customerConfig, InstallError, validateInstallation } from '../scripts/install';
import { projectRoot } from './runtime';

const valid = {
  accountId: '0123456789abcdef0123456789abcdef', workerName: 'presently-bright', ownerEmail: 'Owner@Example.com',
  accessTeamDomain: 'bright.cloudflareaccess.com', accessAudience: 'a'.repeat(64), customDomain: 'attendance.bright.example',
};

describe('installer', () => {
  it('validates installation input and refuses secrets or unknown fields', () => {
    expect(validateInstallation(valid).ownerEmail).toBe('owner@example.com');
    expect(() => validateInstallation({ ...valid, backupKey: 'secret' })).toThrow(InstallError);
    expect(() => validateInstallation({ ...valid, accessAudience: 'short' })).toThrow(/accessAudience/);
  });

  it('generates a minified, source-map-free configuration that Wrangler accepts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'presently-install-'));
    try {
      const config = customerConfig(validateInstallation(valid), '11111111-2222-4333-8444-555555555555', directory, '1.0.0');
      expect(config).toMatchObject({ minify: true, upload_source_maps: false, workers_dev: false, triggers: { crons: ['0 * * * *'] } });
      expect(JSON.stringify(config)).not.toMatch(/BACKUP_KEY|PIN_PEPPER|CF_D1_EXPORT_TOKEN/);
      const path = join(directory, 'wrangler.jsonc');
      await writeFile(path, JSON.stringify(config));
      await mkdir(join(projectRoot, 'dist', 'client'), { recursive: true });
      const { stdout } = await promisify(execFile)('npx', ['wrangler', 'deploy', '--dry-run', '--config', path, '--outdir', join(directory, 'out')], { cwd: projectRoot });
      expect(stdout).toMatch(/CRM_DB/);
      expect(stdout).toMatch(/BACKUP_BUCKET/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
