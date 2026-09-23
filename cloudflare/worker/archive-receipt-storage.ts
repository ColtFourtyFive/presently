import type { ArchiveRecordEvidenceStorage } from './archive-record-evidence';
import type { Env } from './types';

/** Construction performs no IO or key decoding. Receipt resolution decides
 * whether the read-only object dependency is needed after checking ownership. */
export function archiveReceiptStorage(env: Env): ArchiveRecordEvidenceStorage | undefined {
  const bucket = env.BACKUP_BUCKET, masterKey = env.BACKUP_KEY;
  if (env.ARCHIVE_ENABLED !== 'true' || !bucket || typeof masterKey !== 'string' || !masterKey.length) return undefined;
  return { bucket: { get: key => bucket.get(key) }, masterKey };
}
