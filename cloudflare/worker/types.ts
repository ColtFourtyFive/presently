import type { Actor } from '../shared/types';
export interface Env {
  CRM_DB: Cloudflare.Env['CRM_DB'];
  ASSETS?: Cloudflare.Env['ASSETS'];
  APP_ENV?: string;
  APP_VERSION?: string;
  CENTER_ID?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  BOOTSTRAP_OWNER_EMAIL?: string;
  LOCAL_ACCESS_TEST_MODE?: string;
  LOCAL_ACCESS_JWKS?: string;
  BACKUP_PROVIDER?: 'r2' | 'google-drive';
  BACKUP_BUCKET?: Cloudflare.Env['BACKUP_BUCKET'];
  [key: string]: unknown;
}
export type AppEnv = { Bindings: Env; Variables: { actor: Actor; deviceId: string; sessionId: string } };
