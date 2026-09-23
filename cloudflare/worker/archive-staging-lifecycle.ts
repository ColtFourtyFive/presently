import type { ArchiveSemanticHandle, ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';

/** Internal operational metadata, not publication or deletion authority.
 * Writes are atomic SQL hooks; no caller-supplied progress or renewal API. */
export interface ArchiveStagingLifecycle {
  verification_id: string;
  generation: string;
  admitted_at: string;
  last_progress_at: string | null;
  progress_revision: number;
  revision: number;
  verified_at: string | null;
  renewal_deadline_at: string;
  migration_grace_until: string | null;
  due_at: string;
}

function handle(value: ArchiveSemanticHandle): void {
  if (![value.verificationId, value.generation].every(item => typeof item === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item))) {
    throw new Error('ARCHIVE_LIFECYCLE_HANDLE_INVALID');
  }
}

/** Retained older-generation metadata remains inspectable after restoration. */
export async function readArchiveStagingLifecycle<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, identity: ArchiveSemanticHandle): Promise<ArchiveStagingLifecycle> {
  handle(identity);
  const result = await db.batch<ArchiveStagingLifecycle>([db.prepare(`SELECT l.* FROM archive_semantic_lifecycle l
    JOIN archive_semantic_sessions s USING(verification_id,generation)
    WHERE l.verification_id=? AND l.generation=?`).bind(identity.verificationId, identity.generation)]);
  const row = result[0].results[0];
  if (!row) throw new Error('ARCHIVE_LIFECYCLE_MISSING');
  return row;
}

/** A due row is a candidate for future guarded reconciliation, not permission
 * to invalidate or delete anything. No scheduler calls this function. */
export async function readNextDueArchiveStagingLifecycle<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>): Promise<ArchiveStagingLifecycle | null> {
  const result = await db.batch<ArchiveStagingLifecycle>([db.prepare(`SELECT l.* FROM archive_semantic_lifecycle l INDEXED BY archive_semantic_lifecycle_due
    JOIN archive_semantic_sessions s USING(verification_id,generation)
    WHERE l.due_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY l.due_at,l.verification_id,l.generation LIMIT 1`)]);
  return result[0].results[0] ?? null;
}
