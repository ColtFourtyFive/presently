import type { ArchiveCounts, ArchiveRecord, ArchiveTable } from './archive-format';

export type ArchiveSnapshot = { id: string; month: string; timezone: string; capturedAt: string; verifiedAt: string; recordCounts: ArchiveCounts; manifestSha256: string };
export type ArchiveCatalog = { items: Omit<ArchiveSnapshot, 'recordCounts' | 'manifestSha256'>[]; nextCursor: string | null; mode: 'verified-copy' };
export type ArchiveRecordPage = {
  snapshot: ArchiveSnapshot; table: ArchiveTable; items: ArchiveRecord[]; nextCursor: string | null;
  pageVerified: true; searchComplete: boolean; mode: 'verified-copy';
};
