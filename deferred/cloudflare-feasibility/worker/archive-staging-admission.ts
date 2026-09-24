/** Logical admission is enforced by schema 20. Database size is a fresh,
 * conservative preflight, not an atomic reservation against application writes.
 * Adapters must execute on the primary: raw env.CRM_DB, or independent local
 * SQLite. Missing served_by_primary is not evidence that a replica is primary. */
export const ARCHIVE_STAGING_ADMISSION = Object.freeze({
  plaintextBytes: 16 * 1024 * 1024,
  records: 20_000,
  planningBytes: 128 * 1024 * 1024,
  databaseWatermark: 400_000_000,
});

export type ArchiveStagingResult<T = Record<string, unknown>> = {
  results: T[];
  meta?: { size_after?: number; served_by_primary?: boolean; [key: string]: unknown };
};

export function assertArchiveStagingSize(result: ArchiveStagingResult<unknown>, creating = false): void {
  const size = result.meta?.size_after;
  if (!Number.isSafeInteger(size) || size! <= 0 || result.meta?.served_by_primary === false) {
    throw new Error('ARCHIVE_STAGING_SIZE_UNAVAILABLE');
  }
  if (size! > ARCHIVE_STAGING_ADMISSION.databaseWatermark - (creating ? ARCHIVE_STAGING_ADMISSION.planningBytes : 0)) {
    throw new Error('ARCHIVE_STAGING_CAPACITY');
  }
}

export function assertArchiveStagingWork(result: ArchiveStagingResult<unknown>, allowed: unknown): void {
  if (allowed !== 1) throw new Error('ARCHIVE_STAGING_ADMISSION_LIMIT');
  assertArchiveStagingSize(result);
}

export function isArchiveStagingCapacityPause(error: unknown): boolean {
  return error instanceof Error && ['ARCHIVE_STAGING_SIZE_UNAVAILABLE', 'ARCHIVE_STAGING_CAPACITY'].includes(error.message);
}
