import {
  ARCHIVE_FORMAT_V2,
  ARCHIVE_LIMITS,
  type ArchiveManifest,
  type ArchiveRecord,
  type ArchiveReference,
  type ArchiveTable,
} from '../shared/archive-format';
import { openArchiveManifest, verifyArchivePart } from './archive-codec';
import { COMPACT_DESCRIPTOR_COLUMNS } from './archive-compact-reconciliation';
import {
  readArchiveEvidenceObject,
  type ArchiveRecordEvidenceStorage,
} from './archive-record-evidence';
import { MONTHLY_SEMANTIC_VALIDATOR_VERSION } from './archive-semantic-runner';
import { validateSemanticShape } from './archive-semantic-rules';
import { digest } from './backup-crypto';

export const ARCHIVE_RANGE_LIMITS = Object.freeze({
  publications: 16,
  objectReads: 48,
  records: 40_000,
});

export type ArchiveRangeScope = 'observed' | 'visit-effective' | 'any';

export type ArchiveRangeQuery = {
  centerId: string;
  timezone: string;
  fromISO: string;
  toISO: string;
  scope: ArchiveRangeScope;
  tables: readonly ArchiveTable[];
};

export type ArchiveRangeResult = {
  records: ArchiveRecord[];
  generation: string;
  authoritySha256: string;
  publications: number;
  objectReads: number;
};

export interface ArchiveRangeStatement<S> {
  bind(...values: unknown[]): S;
  all<T extends Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface ArchiveRangeDatabase<S extends ArchiveRangeStatement<S>> {
  prepare(sql: string): S;
}

type Selection = Record<string, unknown>;

type ValidatedSelection = {
  row: Selection;
  reference: ArchiveReference;
  header: Omit<ArchiveManifest, 'parts'>;
};

const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

export class ArchiveRangeUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('ARCHIVE_RANGE_UNAVAILABLE');
  }
}

function unavailable(reason: string): never {
  throw new ArchiveRangeUnavailableError(reason);
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function overlaps(from: unknown, to: unknown, query: ArchiveRangeQuery): boolean {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return from < query.toISO && to >= query.fromISO;
}

function descriptor(row: Selection): Record<string, unknown> {
  return Object.fromEntries(COMPACT_DESCRIPTOR_COLUMNS.map(column => [column, row[column]]));
}

async function validateSelection(row: Selection, query: ArchiveRangeQuery): Promise<ValidatedSelection> {
  if (
    row.origin !== 'direct' ||
    typeof row.publication_id !== 'string' || !ID.test(row.publication_id) ||
    row.identity_publication_id !== row.publication_id ||
    row.center_id !== query.centerId ||
    row.timezone !== query.timezone ||
    row.availability_status !== 'ready' ||
    row.availability_generation !== row.runtime_generation ||
    row.runtime_state !== 'ready' ||
    typeof row.runtime_generation !== 'string' || !/^[a-f0-9]{32}$/.test(row.runtime_generation) ||
    row.catalog_version !== 2 ||
    row.validator_version !== MONTHLY_SEMANTIC_VALIDATOR_VERSION ||
    typeof row.archive_id !== 'string' || !ID.test(row.archive_id) ||
    typeof row.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) ||
    typeof row.root_reference_json !== 'string' || encoder.encode(row.root_reference_json).length > 4096 ||
    typeof row.header_json !== 'string' || encoder.encode(row.header_json).length > 49_152 ||
    typeof row.header_sha256 !== 'string' || !HASH.test(row.header_sha256) ||
    !validInteger(row.part_count, 0, ARCHIVE_LIMITS.parts) ||
    !validInteger(row.record_count, 0, ARCHIVE_LIMITS.parts * ARCHIVE_LIMITS.recordsPerPart) ||
    !validInteger(row.request_count, 0, Number(row.record_count)) ||
    typeof row.counts_json !== 'string'
  ) unavailable('selection');

  let reference: ArchiveReference;
  let header: Omit<ArchiveManifest, 'parts'>;
  let counts: Record<string, unknown>;
  try {
    reference = JSON.parse(row.root_reference_json) as ArchiveReference;
    header = JSON.parse(row.header_json) as Omit<ArchiveManifest, 'parts'>;
    counts = JSON.parse(row.counts_json) as Record<string, unknown>;
  } catch {
    return unavailable('json');
  }

  if (
    !exactObject(reference) ||
    !exactObject(header) ||
    !exactObject(counts) ||
    reference.archiveId !== row.archive_id ||
    reference.kind !== 'monthly' ||
    typeof reference.manifestObjectKey !== 'string' ||
    typeof reference.manifestSha256 !== 'string' || !HASH.test(reference.manifestSha256) ||
    header.archiveId !== row.archive_id ||
    header.centerId !== row.center_id ||
    header.month !== row.month ||
    header.timezone !== row.timezone ||
    header.format !== ARCHIVE_FORMAT_V2 ||
    header.kind !== 'monthly' ||
    !Array.isArray(header.references) || header.references.length !== 0 ||
    header.recordCount !== row.record_count ||
    !exactObject(header.recordCounts) ||
    JSON.stringify(header.recordCounts) !== JSON.stringify(counts) ||
    Number(counts.attendance_events) + Number(counts.attendance_corrections) !== row.request_count ||
    await digest(encoder.encode(JSON.stringify(header))) !== row.header_sha256
  ) unavailable('descriptor');

  const direct = row.availability_reconciliation_id === null && row.generation === row.runtime_generation;
  const reconciled = typeof row.availability_reconciliation_id === 'string' &&
    row.receipt_reconciliation_id === row.availability_reconciliation_id &&
    row.receipt_publication_id === row.publication_id &&
    row.receipt_generation === row.runtime_generation &&
    typeof row.receipt_verification_id === 'string' && ID.test(row.receipt_verification_id) &&
    typeof row.receipt_run_id === 'string' && ID.test(row.receipt_run_id) &&
    typeof row.receipt_snapshot_commit_token === 'string' && ID.test(row.receipt_snapshot_commit_token) &&
    typeof row.receipt_graph_sha256 === 'string' && HASH.test(row.receipt_graph_sha256) &&
    row.receipt_validator_version === MONTHLY_SEMANTIC_VALIDATOR_VERSION &&
    row.receipt_expected_parts === row.part_count &&
    typeof row.receipt_descriptor_json === 'string' &&
    typeof row.receipt_descriptor_sha256 === 'string' && HASH.test(row.receipt_descriptor_sha256) &&
    typeof row.receipt_counters_json === 'string' &&
    typeof row.receipt_evidence_digest === 'string' && HASH.test(row.receipt_evidence_digest);

  if (!direct && !reconciled) unavailable('authority');
  if (reconciled) {
    const expectedDescriptor = JSON.stringify(descriptor(row));
    let counters: Record<string, unknown>;
    try {
      counters = JSON.parse(String(row.receipt_counters_json)) as Record<string, unknown>;
    } catch {
      return unavailable('receipt-json');
    }
    if (
      row.receipt_descriptor_json !== expectedDescriptor ||
      await digest(encoder.encode(expectedDescriptor)) !== row.receipt_descriptor_sha256 ||
      !exactObject(counters) ||
      Object.keys(counters).sort().join(',') !== 'catalogRequests,counts,parts,records,requests' ||
      counters.parts !== row.part_count ||
      counters.records !== row.record_count ||
      counters.requests !== row.request_count ||
      counters.catalogRequests !== row.request_count ||
      JSON.stringify(counters.counts) !== JSON.stringify(counts)
    ) unavailable('receipt');
  }

  return { row, reference, header };
}

function selectionSql(): string {
  return `SELECT
    i.publication_id AS identity_publication_id,i.origin,
    p.*,
    a.generation AS availability_generation,a.status AS availability_status,
    a.reconciliation_id AS availability_reconciliation_id,
    h.generation AS runtime_generation,h.state AS runtime_state,
    r.reconciliation_id AS receipt_reconciliation_id,
    r.publication_id AS receipt_publication_id,
    r.execution_generation AS receipt_generation,
    r.verification_id AS receipt_verification_id,
    r.run_id AS receipt_run_id,
    r.snapshot_commit_token AS receipt_snapshot_commit_token,
    r.graph_sha256 AS receipt_graph_sha256,
    r.validator_version AS receipt_validator_version,
    r.descriptor_json AS receipt_descriptor_json,
    r.descriptor_sha256 AS receipt_descriptor_sha256,
    r.expected_parts AS receipt_expected_parts,
    r.counters_json AS receipt_counters_json,
    r.evidence_digest AS receipt_evidence_digest
  FROM archive_compact_publications p
  LEFT JOIN archive_compact_identities i ON i.publication_id=p.publication_id
  LEFT JOIN archive_compact_availability a ON a.publication_id=p.publication_id
  LEFT JOIN archive_compact_reconciliation_receipts r
    ON r.reconciliation_id=a.reconciliation_id AND r.publication_id=p.publication_id
  JOIN history_runtime h ON h.id=1
  WHERE p.center_id=? AND p.timezone=? AND (
    (json_extract(p.header_json,'$.periodFrom')<? AND json_extract(p.header_json,'$.periodTo')>?) OR
    (json_extract(p.header_json,'$.coverage.originalFrom')<? AND json_extract(p.header_json,'$.coverage.originalTo')>=?) OR
    (json_extract(p.header_json,'$.coverage.effectiveFrom')<? AND json_extract(p.header_json,'$.coverage.effectiveTo')>=?)
  )
  ORDER BY p.month,p.publication_id
  LIMIT ?`;
}

function validatedQuery(supplied: ArchiveRangeQuery): ArchiveRangeQuery {
  const query = Object.freeze({ ...supplied, tables: Object.freeze([...supplied.tables]) });
  if (
    !ID.test(query.centerId) ||
    typeof query.timezone !== 'string' || !query.timezone || query.timezone.length > 100 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.fromISO) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.toISO) ||
    query.fromISO >= query.toISO ||
    !['observed', 'visit-effective', 'any'].includes(query.scope) ||
    new Set(query.tables).size !== query.tables.length
  ) unavailable('query');
  return query;
}

export async function assertArchiveRangeAuthority<S extends ArchiveRangeStatement<S>>(
  db: ArchiveRangeDatabase<S>,
  supplied: ArchiveRangeQuery,
  expectedSha256: string,
): Promise<void> {
  if (!HASH.test(expectedSha256)) unavailable('authority');
  const query = validatedQuery(supplied);
  const current = JSON.stringify(await readSelections(db, query));
  if (await digest(encoder.encode(current)) !== expectedSha256) unavailable('authority-changed');
}

async function readSelections<S extends ArchiveRangeStatement<S>>(
  db: ArchiveRangeDatabase<S>,
  query: ArchiveRangeQuery,
): Promise<Selection[]> {
  const result = await db.prepare(selectionSql()).bind(
    query.centerId,
    query.timezone,
    query.toISO,
    query.fromISO,
    query.toISO,
    query.fromISO,
    query.toISO,
    query.fromISO,
    ARCHIVE_RANGE_LIMITS.publications + 1,
  ).all<Selection>();
  if (result.results.length > ARCHIVE_RANGE_LIMITS.publications) unavailable('publication-limit');
  return result.results;
}

function relevant(header: Omit<ArchiveManifest, 'parts'>, query: ArchiveRangeQuery): boolean {
  if (query.scope === 'observed') {
    return overlaps(header.coverage.originalFrom, header.coverage.originalTo, query) ||
      overlaps(header.periodFrom, header.periodTo, query);
  }
  if (query.scope === 'any') {
    return overlaps(header.coverage.originalFrom, header.coverage.originalTo, query) ||
      overlaps(header.coverage.effectiveFrom, header.coverage.effectiveTo, query) ||
      overlaps(header.periodFrom, header.periodTo, query);
  }
  return overlaps(header.coverage.effectiveFrom, header.coverage.effectiveTo, query) ||
    overlaps(header.periodFrom, header.periodTo, query);
}

/**
 * Reads bounded, authenticated historical records. The complete D1 publication
 * snapshot is checked again after the R2 reads so a restore or availability
 * change cannot turn a stale selection into current authority.
 */
export async function readArchiveRange<S extends ArchiveRangeStatement<S>>(
  db: ArchiveRangeDatabase<S>,
  storage: ArchiveRecordEvidenceStorage | undefined,
  supplied: ArchiveRangeQuery,
): Promise<ArchiveRangeResult> {
  const query = validatedQuery(supplied);

  const before = await readSelections(db, query);
  const authority = JSON.stringify(before);
  const validated = await Promise.all(before.map(row => validateSelection(row, query)));
  const active = validated.filter(item => relevant(item.header, query));
  if (!active.length) {
    const after = await readSelections(db, query);
    if (JSON.stringify(after) !== authority) unavailable('authority-changed');
    const generation = before[0]?.runtime_generation;
    return {
      records: [],
      generation: typeof generation === 'string' ? generation : '',
      authoritySha256: await digest(encoder.encode(authority)),
      publications: 0,
      objectReads: 0,
    };
  }
  if (!storage) unavailable('storage');

  let objectReads = active.length;
  if (objectReads > ARCHIVE_RANGE_LIMITS.objectReads) unavailable('object-limit');
  const opened = await Promise.all(active.map(async item => {
    const bytes = await readArchiveEvidenceObject(
      storage.bucket,
      item.reference.manifestObjectKey,
      ARCHIVE_LIMITS.encryptedManifestBytes,
    );
    const manifest = await openArchiveManifest(storage.masterKey, bytes, item.reference);
    const { parts: _parts, ...header } = manifest;
    if (
      JSON.stringify(header) !== item.row.header_json ||
      manifest.parts.length !== item.row.part_count ||
      manifest.recordCount !== item.row.record_count
    ) unavailable('manifest');
    return { ...item, manifest };
  }));

  const wanted = new Set<ArchiveTable>(query.tables);
  const partReads = opened.flatMap(item => item.manifest.parts
    .filter(part => query.tables.some(table => part.recordCounts[table] > 0))
    .map(part => ({ item, part })));
  objectReads += partReads.length;
  if (objectReads > ARCHIVE_RANGE_LIMITS.objectReads) unavailable('object-limit');

  const pages = await Promise.all(partReads.map(async ({ item, part }) => {
    const bytes = await readArchiveEvidenceObject(
      storage.bucket,
      part.objectKey,
      ARCHIVE_LIMITS.encryptedPartBytes,
      part.encryptedBytes,
    );
    return verifyArchivePart(storage.masterKey, item.manifest, part, bytes);
  }));

  const records: ArchiveRecord[] = [];
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const manifest = partReads[pageIndex].item.manifest;
    for (const record of pages[pageIndex]) {
      if (!wanted.has(record.table)) continue;
      validateSemanticShape(record, manifest, record.table, record.key);
      const identity = `${record.table}\u0000${record.key}`;
      if (seen.has(identity)) unavailable('duplicate');
      seen.add(identity);
      records.push(record);
      if (records.length > ARCHIVE_RANGE_LIMITS.records) unavailable('record-limit');
    }
  }

  const after = await readSelections(db, query);
  if (JSON.stringify(after) !== authority) unavailable('authority-changed');
  const generations = new Set(active.map(item => String(item.row.runtime_generation)));
  if (generations.size !== 1) unavailable('generation');

  return {
    records,
    generation: String(active[0].row.runtime_generation),
    authoritySha256: await digest(encoder.encode(authority)),
    publications: active.length,
    objectReads,
  };
}
