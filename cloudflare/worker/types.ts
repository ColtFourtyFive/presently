import type { Actor } from '../shared/types';

export interface Env {
  CRM_DB: D1Database;
  ASSETS?: Fetcher;
  BACKUP_BUCKET?: R2Bucket;
  BACKUP_QUEUE?: Queue<BackupMessage>;
  APP_ENV?: string;
  APP_VERSION?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  BOOTSTRAP_OWNER_EMAIL?: string;
  LOCAL_ACCESS_TEST_MODE?: string;
  LOCAL_ACCESS_JWKS?: string;
  /** Secret mixed into every kiosk PIN hash. A copied database alone cannot be used to recover PINs. */
  PIN_PEPPER?: string;
  BACKUP_ENABLED?: string;
  BACKUP_KEY?: string;
  BACKUP_ALERT_URL?: string;
  CF_ACCOUNT_ID?: string;
  CF_DATABASE_ID?: string;
  /** Account API token limited to D1 edit permission. Used only to export the database. */
  CF_D1_EXPORT_TOKEN?: string;
}

export type BackupMessage = { jobId: string };

export type AppEnv = {
  Bindings: Env;
  Variables: {
    actor: Actor;
    /** Locations this actor can reach. */
    locationIds: number[];
    /** Location selected for this request, when the route is location scoped. */
    locationId: number;
    deviceId: number;
    sessionId: number;
  };
};
