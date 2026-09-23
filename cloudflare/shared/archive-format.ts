/** Historical evidence format. Independent of the existing SQL backup v1 format. */
export const ARCHIVE_FORMAT = 'kumon-history-archive-v1' as const;
export const ARCHIVE_FORMAT_V2 = 'kumon-history-archive-v2' as const;
export const ARCHIVE_TABLES = ['centers', 'students', 'guardians', 'student_guardians', 'staff', 'visits', 'attendance_events', 'attendance_corrections', 'reviews', 'audit_entries'] as const;
export type ArchiveTable = typeof ARCHIVE_TABLES[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ArchiveRow = { [key: string]: JsonValue };
export type ArchiveRecord = { table: ArchiveTable; key: string; row: ArchiveRow };
export type ArchiveCounts = Record<ArchiveTable, number>;
export type ArchiveKind = 'monthly' | 'addendum';

export const ARCHIVE_LIMITS = {
  recordBytes: 64 * 1024,
  recordsPerPart: 256,
  plaintextPartBytes: 1024 * 1024,
  compressedPartBytes: 1024 * 1024 + 64 * 1024,
  encryptedPartBytes: 1024 * 1024 + 68 * 1024,
  parts: 512,
  plaintextArchiveBytes: 512 * 1024 * 1024,
  manifestBytes: 512 * 1024,
  encryptedManifestBytes: 512 * 1024 + 4096,
  references: 16,
  graphArchives: 32,
  graphDepth: 16,
  plaintextGraphBytes: 512 * 1024 * 1024,
  semanticProofBytes: 32 * 1024,
  deviceContexts: 256,
  semanticPageRecords: 64,
  semanticVisitOperations: 2048,
  semanticVisitBytes: 4 * 1024 * 1024,
} as const;

/** Opt-in validator foundation, not an authorization to remove live records. */
export type ArchiveSemanticProof = {
  version: 1;
  payloadHashEncoding: 'base64' | 'base64-or-hex';
  deviceContexts: { id: string; centerId: string }[];
};

/** Inclusive min/max timestamps of preserved evidence, not only effective times. */
export type ArchiveCoverage = {
  originalFrom: string | null;
  originalTo: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  recordedThrough: string | null;
};
export type ArchiveRecordPosition = { table: ArchiveTable; key: string };

/** References identify an immutable encrypted manifest, never an unversioned key. */
export type ArchiveReference = {
  archiveId: string;
  kind: ArchiveKind;
  manifestObjectKey: string;
  manifestSha256: string;
};
export type ArchiveMetadata = {
  archiveId: string;
  centerId: string;
  month: string;
  timezone: string;
  kind: ArchiveKind;
  createdAt: string;
  applicationVersion: string;
  schemaVersions: number[];
  /** Empty for a monthly base. Addenda reference their base or earlier addenda. */
  references: ArchiveReference[];
  /** Omitted by existing v1 producers. Present only for opt-in v2 evidence. */
  semanticProof?: ArchiveSemanticProof;
};
export type ArchivePartDescriptor = {
  index: number;
  fileName: string;
  objectKey: string;
  recordCount: number;
  recordCounts: ArchiveCounts;
  first: ArchiveRecordPosition;
  last: ArchiveRecordPosition;
  coverage: ArchiveCoverage;
  plaintextBytes: number;
  plaintextSha256: string;
  compressedBytes: number;
  compressedSha256: string;
  encryptedBytes: number;
  encryptedSha256: string;
};
export type ArchiveManifest = ArchiveMetadata & {
  format: typeof ARCHIVE_FORMAT | typeof ARCHIVE_FORMAT_V2;
  compression: 'gzip';
  recordEncoding: 'jsonl';
  /** Exact UTC boundaries of the declared calendar month in its center timezone. */
  periodFrom: string;
  periodTo: string;
  coverage: ArchiveCoverage;
  recordCount: number;
  recordCounts: ArchiveCounts;
  plaintextBytes: number;
  compressedBytes: number;
  parts: ArchivePartDescriptor[];
};

/** A sink must keep staged records private. publish is called only after all checks. */
export type ArchiveStagingSink = {
  stagePart(records: readonly ArchiveRecord[], part: ArchivePartDescriptor, manifest: ArchiveManifest): Promise<void>;
  publish(manifests: readonly ArchiveManifest[]): Promise<void>;
  discard(): Promise<void>;
  /** V2 requires immutable private staged records, never queries of live rows.
   * Implementations must enforce requested page bounds and stable key ordering.
   * stagePart must finish persisting its rows before its promise resolves. */
  semanticStore?: ArchiveSemanticStore;
};

export type ArchiveSemanticQuery = {
  archiveId: string;
  table: ArchiveTable;
  after: string;
  limit: number;
  /** An exact row-column filter. Only these evidence relationships are used. */
  relation?: { column: 'visit_id' | 'event_id' | 'entity_id'; value: string };
};
export type ArchiveSemanticStore = {
  page(query: ArchiveSemanticQuery): Promise<readonly ArchiveRecord[]>;
  get(archiveId: string, table: ArchiveTable, key: string): Promise<ArchiveRecord | null>;
};
