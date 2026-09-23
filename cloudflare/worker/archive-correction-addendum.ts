import {
  ARCHIVE_FORMAT_V2,
  ARCHIVE_LIMITS,
  type ArchiveManifest,
  type ArchiveMetadata,
  type ArchiveRecord,
  type ArchiveReference,
  type ArchiveTable,
} from '../shared/archive-format';
import {
  compareArchiveRecords,
  createArchive,
  openArchiveManifest,
  verifyArchivePart,
} from './archive-codec';
import { digest } from './backup-crypto';
import {
  readArchiveEvidenceObject,
  type ArchiveEvidenceObject,
} from './archive-record-evidence';
import {
  nextCheckpointCandidate,
  publishCorrectionCheckpoint,
  readPublishedCorrectionCheckpoint,
  reconcileCorrectionCheckpoint,
  startCorrectionCheckpoint,
  startCorrectionCheckpointReconciliation,
} from './archive-correction-checkpoint';

export type AddendumStatement<S> = {
  bind(...values: unknown[]): S;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T extends Record<string, unknown>>(): Promise<{ results: T[] }>;
};

export type AddendumDatabase<S extends AddendumStatement<S>> = {
  prepare(sql: string): S;
  batch<T extends Record<string, unknown>>(statements: S[]): Promise<{ results: T[] }[]>;
};

export type AddendumStorage = {
  masterKey: string;
  bucket: {
    get(key: string): Promise<ArchiveEvidenceObject | null>;
    put(key: string, value: Uint8Array): Promise<unknown>;
  };
};

export type CorrectionAddendumHandle = Readonly<{
  publicationId: string;
  generation: string;
}>;

export type CorrectionAddendumReconciliationHandle = Readonly<{
  reconciliationId: string;
  publicationId: string;
  generation: string;
}>;

type CorrectionRow = {
  id: string;
  center_id: string;
  visit_id: string;
  student_id: string;
  expected_version: number;
  prior_check_in_at: string;
  prior_check_out_at: string | null;
  check_in_at: string;
  check_out_at: string | null;
  reason: string;
  actor_id: string;
  actor_name: string;
  recorded_at: string;
  payload_hash: string;
  original_check_in_at: string;
  original_check_out_at: string | null;
  check_in_by: string;
  check_out_by: string | null;
  guardian_id: string | null;
  departure_type: string | null;
  review_status: string;
  resulting_version: number;
  publication_state: string;
  timezone: string;
  runtime_generation: string;
  runtime_state: string;
  head_check_in_at: string;
  head_check_out_at: string | null;
  head_version: number;
  head_review_status: string;
};

type BuildRow = {
  publication_id: string;
  correction_id: string;
  generation: string;
  archive_id: string;
  state: 'pending' | 'published' | 'invalid';
  revision: number;
};

type ParentRow = Record<string, unknown> & {
  publication_id: string;
  root_reference_json: string;
  header_json: string;
  header_sha256: string;
  center_id: string;
  month: string;
  timezone: string;
};

type AddendumPublicationRow = ParentRow & {
  correction_id: string;
  generation: string;
  archive_id: string;
  visit_id: string;
  expected_version: number;
  resulting_version: number;
  parent_kind: 'monthly' | 'addendum';
  parent_publication_id: string;
  parent_reference_json: string;
  chain_depth: number;
  manifest_object_key: string;
  manifest_sha256: string;
  part_descriptor_json: string;
  part_descriptor_sha256: string;
  records_sha256: string;
  published_at: string;
};

type CheckpointParentRow = ParentRow & {
  base_publication_id: string;
  base_reference_json: string;
  visit_id: string;
  resulting_version: number;
  chain_depth: number;
};

type ParentAuthority = {
  kind: 'monthly' | 'addendum';
  source: 'monthly' | 'increment' | 'checkpoint';
  publicationId: string;
  reference: ArchiveReference;
  header: Omit<ArchiveManifest, 'parts'>;
  headerSha256: string;
  chainDepth: number;
};

type ReconciliationJob = {
  reconciliation_id: string;
  publication_id: string;
  execution_generation: string;
  descriptor_json: string;
  descriptor_sha256: string;
  state: 'pending' | 'complete' | 'invalid';
  revision: number;
};

const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const now = () => new Date().toISOString();

function fail(code: string): never {
  throw new Error(`ARCHIVE_ADDENDUM_${code}`);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function parseReference(value: string, expectedKind?: 'monthly' | 'addendum'): ArchiveReference {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail('REFERENCE_INVALID'); }
  if (!exactObject(parsed, ['archiveId', 'kind', 'manifestObjectKey', 'manifestSha256'])
      || !id(parsed.archiveId)
      || !['monthly', 'addendum'].includes(String(parsed.kind))
      || (expectedKind && parsed.kind !== expectedKind)
      || typeof parsed.manifestObjectKey !== 'string'
      || parsed.manifestObjectKey.length < 1
      || parsed.manifestObjectKey.length > 1024
      || !sha(parsed.manifestSha256)) fail('REFERENCE_INVALID');
  return parsed as ArchiveReference;
}

function parseHeader(value: string): Omit<ArchiveManifest, 'parts'> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail('HEADER_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('HEADER_INVALID');
  return parsed as Omit<ArchiveManifest, 'parts'>;
}

function calendarMonth(value: string, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  const month = `${parts.year}-${parts.month}`;
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) fail('MONTH_INVALID');
  return month;
}

function immutableCreatedAt(parent: Omit<ArchiveManifest, 'parts'>): string {
  const parentTime = Date.parse(parent.createdAt);
  if (!Number.isFinite(parentTime)) fail('PARENT_INVALID');
  return new Date(Math.max(Date.now(), parentTime + 1)).toISOString();
}

function headerOf(manifest: ArchiveManifest): Omit<ArchiveManifest, 'parts'> {
  const { parts: _parts, ...header } = manifest;
  return header;
}

function auditDetail(correction: CorrectionRow | Record<string, unknown>): string {
  return JSON.stringify({
    reason: correction.reason,
    priorCheckInAt: correction.prior_check_in_at,
    priorCheckOutAt: correction.prior_check_out_at,
    checkInAt: correction.check_in_at,
    checkOutAt: correction.check_out_at,
  });
}

function same(left: unknown, right: unknown): boolean {
  return left === right;
}

function validateParentRow(
  row: ParentRow,
  kind: 'monthly' | 'addendum',
  source: ParentAuthority['source'] = kind === 'monthly' ? 'monthly' : 'increment',
): ParentAuthority {
  if (!id(row.publication_id) || !id(row.center_id)
      || typeof row.month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(row.month)
      || typeof row.timezone !== 'string' || !row.timezone || row.timezone.length > 100
      || typeof row.root_reference_json !== 'string'
      || typeof row.header_json !== 'string'
      || !sha(row.header_sha256)) fail('PARENT_INVALID');
  const reference = parseReference(row.root_reference_json, kind);
  const header = parseHeader(row.header_json);
  if (header.format !== ARCHIVE_FORMAT_V2
      || header.kind !== kind
      || header.archiveId !== reference.archiveId
      || header.centerId !== row.center_id
      || header.month !== row.month
      || header.timezone !== row.timezone
      || !Array.isArray(header.references)
      || (kind === 'monthly' ? header.references.length !== 0 : header.references.length !== 1)) {
    fail('PARENT_INVALID');
  }
  const chainDepth = kind === 'addendum' ? Number(row.chain_depth) : 0;
  if (!Number.isSafeInteger(chainDepth) || chainDepth < 0 || chainDepth > 15) fail('GRAPH_BOUND');
  return {
    kind,
    source,
    publicationId: row.publication_id,
    reference,
    header,
    headerSha256: row.header_sha256,
    chainDepth,
  };
}

async function correctionAndBuild<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  handle: CorrectionAddendumHandle,
): Promise<{ build: BuildRow; correction: CorrectionRow }> {
  const [buildResult, correctionResult] = await db.batch<BuildRow | CorrectionRow>([
    db.prepare('SELECT publication_id,correction_id,generation,archive_id,state,revision FROM archive_correction_addendum_builds WHERE publication_id=?').bind(handle.publicationId),
    db.prepare(`SELECT c.*,z.timezone,h.generation AS runtime_generation,h.state AS runtime_state,
      v.check_in_at AS head_check_in_at,v.check_out_at AS head_check_out_at,
      v.version AS head_version,v.review_status AS head_review_status
      FROM archive_correction_addendum_builds b
      JOIN history_correction_outbox c ON c.id=b.correction_id
      JOIN centers z ON z.id=c.center_id
      JOIN history_visit_heads v ON v.visit_id=c.visit_id
      JOIN history_runtime h ON h.id=1
      WHERE b.publication_id=?`).bind(handle.publicationId),
  ]);
  const build = buildResult.results[0] as BuildRow | undefined;
  const correction = correctionResult.results[0] as CorrectionRow | undefined;
  if (!build || !correction
      || build.generation !== handle.generation
      || correction.runtime_generation !== handle.generation
      || correction.runtime_state !== 'ready') fail('STALE');
  if (build.state === 'invalid') fail('STALE');
  return { build, correction };
}

async function selectParent<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  correction: CorrectionRow,
): Promise<ParentAuthority> {
  const month = calendarMonth(correction.original_check_in_at, correction.timezone);
  const checkpoints = await db.prepare(`SELECT p.* FROM archive_correction_checkpoint_publications p
    JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.center_id=? AND p.visit_id=? AND p.resulting_version=?
      AND p.month=? AND p.timezone=?
      AND a.status='ready' AND a.generation=h.generation AND h.state='ready'
    ORDER BY p.published_at DESC,p.publication_id DESC LIMIT 2`)
    .bind(correction.center_id, correction.visit_id, correction.expected_version, month, correction.timezone)
    .all<CheckpointParentRow>();
  if (checkpoints.results.length > 1) fail('PARENT_AMBIGUOUS');
  if (checkpoints.results.length === 1) {
    const checkpoint = validateParentRow(checkpoints.results[0], 'addendum', 'checkpoint');
    if (checkpoint.chainDepth !== 1) fail('PARENT_INVALID');
    return checkpoint;
  }

  const addenda = await db.prepare(`SELECT p.* FROM archive_correction_addendum_publications p
    JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.center_id=? AND p.visit_id=? AND p.resulting_version=?
      AND p.month=? AND p.timezone=?
      AND a.status='ready' AND a.generation=h.generation AND h.state='ready'
    ORDER BY p.published_at DESC,p.publication_id DESC LIMIT 2`)
    .bind(correction.center_id, correction.visit_id, correction.expected_version, month, correction.timezone)
    .all<ParentRow>();
  if (addenda.results.length > 1) fail('PARENT_AMBIGUOUS');
  if (addenda.results.length === 1) return validateParentRow(addenda.results[0], 'addendum');

  const monthly = await db.prepare(`SELECT p.* FROM archive_publications p
    JOIN archive_publication_availability a ON a.publication_id=p.publication_id
    JOIN archive_publication_records r ON r.publication_id=p.publication_id
      AND r.table_name='visits' AND r.record_key=?
    JOIN history_runtime h ON h.id=1
    WHERE p.center_id=? AND p.month=? AND p.timezone=?
      AND a.status='ready' AND a.generation=h.generation AND h.state='ready'
    ORDER BY p.published_at DESC,p.publication_id DESC LIMIT 2`)
    .bind(correction.visit_id, correction.center_id, month, correction.timezone)
    .all<ParentRow>();
  if (monthly.results.length !== 1) fail(monthly.results.length ? 'PARENT_AMBIGUOUS' : 'PARENT_UNAVAILABLE');
  return validateParentRow(monthly.results[0], 'monthly');
}

async function readRootRecord(
  storage: AddendumStorage,
  authority: ParentAuthority | { reference: ArchiveReference; header: Omit<ArchiveManifest, 'parts'>; headerSha256: string },
  table: ArchiveTable,
  key: string,
): Promise<{ manifest: ArchiveManifest; record: ArchiveRecord }> {
  const manifestBytes = await readArchiveEvidenceObject(
    storage.bucket,
    authority.reference.manifestObjectKey,
    ARCHIVE_LIMITS.encryptedManifestBytes,
  );
  const manifest = await openArchiveManifest(storage.masterKey, manifestBytes, authority.reference);
  if (JSON.stringify(headerOf(manifest)) !== JSON.stringify(authority.header)
      || await digest(encoder.encode(JSON.stringify(authority.header))) !== authority.headerSha256) {
    fail('MANIFEST_INVALID');
  }
  const parts = manifest.parts.filter(part => part.recordCounts[table] > 0
    && compareArchiveRecords(part.first, { table, key }) <= 0
    && compareArchiveRecords(part.last, { table, key }) >= 0);
  if (parts.length !== 1) fail('RECORD_UNAVAILABLE');
  const partBytes = await readArchiveEvidenceObject(
    storage.bucket,
    parts[0].objectKey,
    ARCHIVE_LIMITS.encryptedPartBytes,
    parts[0].encryptedBytes,
  );
  const records = await verifyArchivePart(storage.masterKey, manifest, parts[0], partBytes);
  const matches = records.filter(record => record.table === table && record.key === key);
  if (matches.length !== 1) fail('RECORD_UNAVAILABLE');
  return { manifest, record: matches[0] };
}

function buildRecords(correction: CorrectionRow, parentVisit: ArchiveRecord): ArchiveRecord[] {
  if (parentVisit.table !== 'visits'
      || parentVisit.key !== correction.visit_id
      || parentVisit.row.id !== correction.visit_id
      || parentVisit.row.center_id !== correction.center_id
      || parentVisit.row.student_id !== correction.student_id
      || parentVisit.row.version !== correction.expected_version
      || parentVisit.row.check_in_at !== correction.prior_check_in_at
      || !same(parentVisit.row.check_out_at, correction.prior_check_out_at)
      || parentVisit.row.original_check_in_at !== correction.original_check_in_at
      || !same(parentVisit.row.original_check_out_at, correction.original_check_out_at)) {
    fail('PARENT_VISIT_MISMATCH');
  }
  if (correction.resulting_version !== correction.expected_version + 1
      || correction.head_version !== correction.resulting_version
      || correction.head_check_in_at !== correction.check_in_at
      || !same(correction.head_check_out_at, correction.check_out_at)
      || correction.head_review_status !== correction.review_status
      || correction.publication_state !== 'pending') fail('SOURCE_CHANGED');

  const visit: ArchiveRecord = {
    table: 'visits',
    key: correction.visit_id,
    row: {
      id: correction.visit_id,
      center_id: correction.center_id,
      student_id: correction.student_id,
      check_in_at: correction.check_in_at,
      check_out_at: correction.check_out_at,
      original_check_in_at: correction.original_check_in_at,
      original_check_out_at: correction.original_check_out_at,
      check_in_by: correction.check_in_by,
      check_out_by: correction.check_out_by,
      guardian_id: correction.guardian_id,
      departure_type: correction.departure_type,
      review_status: correction.review_status,
      version: correction.resulting_version,
    },
  };
  const correctionRecord: ArchiveRecord = {
    table: 'attendance_corrections',
    key: correction.id,
    row: {
      id: correction.id,
      center_id: correction.center_id,
      visit_id: correction.visit_id,
      expected_version: correction.expected_version,
      prior_check_in_at: correction.prior_check_in_at,
      prior_check_out_at: correction.prior_check_out_at,
      check_in_at: correction.check_in_at,
      check_out_at: correction.check_out_at,
      reason: correction.reason,
      actor_id: correction.actor_id,
      actor_name: correction.actor_name,
      recorded_at: correction.recorded_at,
      payload_hash: correction.payload_hash,
    },
  };
  const audit: ArchiveRecord = {
    table: 'audit_entries',
    key: correction.id,
    row: {
      id: correction.id,
      center_id: correction.center_id,
      actor_id: correction.actor_id,
      actor_name: correction.actor_name,
      action: 'attendance_correction',
      entity_type: 'visit',
      entity_id: correction.visit_id,
      detail: auditDetail(correction),
      created_at: correction.recorded_at,
    },
  };
  return [visit, correctionRecord, audit].sort(compareArchiveRecords);
}

function validateAddendumRecords(
  publication: Pick<AddendumPublicationRow, 'correction_id' | 'center_id' | 'visit_id' | 'expected_version' | 'resulting_version' | 'records_sha256'>,
  parentVisit: ArchiveRecord,
  records: readonly ArchiveRecord[],
): void {
  if (records.length !== 3) fail('RECORD_SET_INVALID');
  const visit = records.find(record => record.table === 'visits');
  const correction = records.find(record => record.table === 'attendance_corrections');
  const audit = records.find(record => record.table === 'audit_entries');
  if (!visit || !correction || !audit
      || visit.key !== publication.visit_id || correction.key !== publication.correction_id || audit.key !== publication.correction_id
      || visit.row.id !== publication.visit_id || visit.row.center_id !== publication.center_id
      || correction.row.id !== publication.correction_id || correction.row.center_id !== publication.center_id
      || correction.row.visit_id !== publication.visit_id
      || correction.row.expected_version !== publication.expected_version
      || visit.row.version !== publication.resulting_version
      || parentVisit.row.version !== publication.expected_version
      || correction.row.prior_check_in_at !== parentVisit.row.check_in_at
      || !same(correction.row.prior_check_out_at, parentVisit.row.check_out_at)
      || correction.row.check_in_at !== visit.row.check_in_at
      || !same(correction.row.check_out_at, visit.row.check_out_at)
      || visit.row.student_id !== parentVisit.row.student_id
      || visit.row.original_check_in_at !== parentVisit.row.original_check_in_at
      || !same(visit.row.original_check_out_at, parentVisit.row.original_check_out_at)
      || visit.row.check_in_by !== parentVisit.row.check_in_by
      || !same(visit.row.check_out_by, parentVisit.row.check_out_by)
      || !same(visit.row.guardian_id, parentVisit.row.guardian_id)
      || !same(visit.row.departure_type, parentVisit.row.departure_type)
      || visit.row.review_status !== parentVisit.row.review_status
      || audit.row.id !== publication.correction_id
      || audit.row.center_id !== publication.center_id
      || audit.row.actor_id !== correction.row.actor_id
      || audit.row.actor_name !== correction.row.actor_name
      || audit.row.action !== 'attendance_correction'
      || audit.row.entity_type !== 'visit'
      || audit.row.entity_id !== publication.visit_id
      || audit.row.detail !== auditDetail(correction.row)
      || audit.row.created_at !== correction.row.recorded_at) fail('SEMANTIC_INVALID');
}

async function readAddendumRecords(
  storage: AddendumStorage,
  publication: AddendumPublicationRow,
): Promise<{ manifest: ArchiveManifest; records: ArchiveRecord[]; evidenceSha256: string }> {
  const reference = parseReference(publication.root_reference_json, 'addendum');
  const header = parseHeader(publication.header_json);
  const manifestBytes = await readArchiveEvidenceObject(storage.bucket, reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes);
  const manifest = await openArchiveManifest(storage.masterKey, manifestBytes, reference);
  if (manifest.parts.length !== 1
      || JSON.stringify(headerOf(manifest)) !== publication.header_json
      || await digest(encoder.encode(publication.header_json)) !== publication.header_sha256
      || JSON.stringify(manifest.parts[0]) !== publication.part_descriptor_json
      || await digest(encoder.encode(publication.part_descriptor_json)) !== publication.part_descriptor_sha256) {
    fail('MANIFEST_INVALID');
  }
  const partBytes = await readArchiveEvidenceObject(
    storage.bucket,
    manifest.parts[0].objectKey,
    ARCHIVE_LIMITS.encryptedPartBytes,
    manifest.parts[0].encryptedBytes,
  );
  const records = await verifyArchivePart(storage.masterKey, manifest, manifest.parts[0], partBytes);
  if (await digest(encoder.encode(JSON.stringify(records))) !== publication.records_sha256) fail('RECORD_SET_INVALID');
  return {
    manifest,
    records,
    evidenceSha256: await digest(encoder.encode(JSON.stringify({
      manifest: reference.manifestSha256,
      part: manifest.parts[0].encryptedSha256,
      parent: publication.parent_reference_json,
      records: publication.records_sha256,
    }))),
  };
}

async function parentForPublication<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  publication: AddendumPublicationRow,
): Promise<ParentAuthority> {
  const values = [
    publication.parent_publication_id,
    publication.parent_reference_json,
    publication.center_id,
    publication.month,
    publication.timezone,
  ];
  if (publication.parent_kind === 'monthly') {
    const rows = await db.prepare(`SELECT p.* FROM archive_publications p
      JOIN archive_publication_availability a ON a.publication_id=p.publication_id
      JOIN archive_publication_records r ON r.publication_id=p.publication_id
        AND r.table_name='visits' AND r.record_key=?
      JOIN history_runtime h ON h.id=1
      WHERE p.publication_id=? AND p.root_reference_json=?
        AND p.center_id=? AND p.month=? AND p.timezone=?
        AND a.status='ready' AND a.generation=h.generation AND h.state='ready' LIMIT 2`)
      .bind(publication.visit_id, ...values).all<ParentRow>();
    if (rows.results.length !== 1) fail('PARENT_UNAVAILABLE');
    const parent = validateParentRow(rows.results[0], 'monthly');
    if (parent.chainDepth + 1 !== publication.chain_depth) fail('PARENT_INVALID');
    return parent;
  }

  const [incrementRows, checkpointRows] = await Promise.all([
    db.prepare(`SELECT p.* FROM archive_correction_addendum_publications p
      JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
      JOIN history_runtime h ON h.id=1
      WHERE p.publication_id=? AND p.root_reference_json=?
        AND p.center_id=? AND p.month=? AND p.timezone=?
        AND p.visit_id=? AND p.resulting_version=?
        AND a.status='ready' AND a.generation=h.generation AND h.state='ready' LIMIT 2`)
      .bind(...values, publication.visit_id, publication.expected_version).all<ParentRow>(),
    db.prepare(`SELECT p.* FROM archive_correction_checkpoint_publications p
      JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
      JOIN history_runtime h ON h.id=1
      WHERE p.publication_id=? AND p.root_reference_json=?
        AND p.center_id=? AND p.month=? AND p.timezone=?
        AND p.visit_id=? AND p.resulting_version=?
        AND a.status='ready' AND a.generation=h.generation AND h.state='ready' LIMIT 2`)
      .bind(...values, publication.visit_id, publication.expected_version).all<CheckpointParentRow>(),
  ]);
  if (incrementRows.results.length + checkpointRows.results.length !== 1) fail('PARENT_UNAVAILABLE');
  const parent = checkpointRows.results.length === 1
    ? validateParentRow(checkpointRows.results[0], 'addendum', 'checkpoint')
    : validateParentRow(incrementRows.results[0], 'addendum', 'increment');
  if (parent.chainDepth + 1 !== publication.chain_depth) fail('PARENT_INVALID');
  return parent;
}

async function checkpointBase<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  supplied: ParentAuthority,
): Promise<ParentAuthority> {
  const checkpoints = await db.prepare(`SELECT p.* FROM archive_correction_checkpoint_publications p
    JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.publication_id=? AND a.status='ready'
      AND a.generation=h.generation AND h.state='ready' LIMIT 2`)
    .bind(supplied.publicationId).all<CheckpointParentRow>();
  if (checkpoints.results.length !== 1) fail('PARENT_UNAVAILABLE');
  const row = checkpoints.results[0];
  const checkpoint = validateParentRow(row, 'addendum', 'checkpoint');
  if (checkpoint.chainDepth !== 1 || JSON.stringify(checkpoint) !== JSON.stringify(supplied)) fail('PARENT_CHANGED');
  const baseReference = parseReference(row.base_reference_json, 'monthly');
  if (JSON.stringify(checkpoint.header.references) !== JSON.stringify([baseReference])) fail('PARENT_CHANGED');
  const bases = await db.prepare(`SELECT p.* FROM archive_publications p
    JOIN archive_publication_availability a ON a.publication_id=p.publication_id
    JOIN archive_publication_records r ON r.publication_id=p.publication_id
      AND r.table_name='visits' AND r.record_key=?
    JOIN history_runtime h ON h.id=1
    WHERE p.publication_id=? AND p.root_reference_json=?
      AND p.center_id=? AND p.month=? AND p.timezone=?
      AND a.status='ready' AND a.generation=h.generation AND h.state='ready' LIMIT 2`)
    .bind(row.visit_id, row.base_publication_id, row.base_reference_json, row.center_id, row.month, row.timezone)
    .all<ParentRow>();
  if (bases.results.length !== 1) fail('PARENT_UNAVAILABLE');
  const base = validateParentRow(bases.results[0], 'monthly');
  if (JSON.stringify(base.reference) !== JSON.stringify(baseReference)) fail('PARENT_CHANGED');
  return base;
}

async function assertParentChain<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  supplied: ParentAuthority,
): Promise<void> {
  let parent = supplied;
  let traversed = 0;
  while (parent.kind === 'addendum') {
    if (++traversed > 16) fail('GRAPH_BOUND');
    if (parent.source === 'checkpoint') {
      parent = await checkpointBase(db, parent);
      continue;
    }
    const publication = await publicationById(db, parent.publicationId);
    if (publication.chain_depth !== parent.chainDepth
        || publication.root_reference_json !== JSON.stringify(parent.reference)) fail('PARENT_CHANGED');
    parent = await parentForPublication(db, publication);
  }
}

const publicationDescriptorColumns = [
  'publication_id', 'correction_id', 'generation', 'archive_id', 'center_id', 'visit_id',
  'month', 'timezone', 'expected_version', 'resulting_version', 'parent_kind',
  'parent_publication_id', 'parent_reference_json', 'chain_depth', 'root_reference_json',
  'header_json', 'header_sha256', 'manifest_object_key', 'manifest_sha256',
  'part_descriptor_json', 'part_descriptor_sha256', 'records_sha256', 'published_at',
] as const;

function descriptorJson(publication: AddendumPublicationRow): string {
  return JSON.stringify(Object.fromEntries(publicationDescriptorColumns.map(column => [column, publication[column]])));
}

async function publicationById<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  publicationId: string,
): Promise<AddendumPublicationRow> {
  const row = await db.prepare('SELECT * FROM archive_correction_addendum_publications WHERE publication_id=?')
    .bind(publicationId).first<AddendumPublicationRow>();
  if (!row) fail('PUBLICATION_NOT_FOUND');
  return row;
}

export async function startCorrectionAddendumPublication<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  correctionId: string,
  requestedPublicationId: string = crypto.randomUUID(),
): Promise<CorrectionAddendumHandle> {
  if (!id(correctionId) || !id(requestedPublicationId)) fail('HANDLE_INVALID');
  const archiveId = `addendum_${requestedPublicationId.replaceAll('-', '_')}`;
  if (!id(archiveId)) fail('HANDLE_INVALID');
  const at = now();
  const result = await db.batch<BuildRow>([
    db.prepare(`INSERT INTO archive_correction_addendum_builds(
      publication_id,correction_id,generation,archive_id,state,revision,created_at,updated_at)
      SELECT ?,?,generation,?,'pending',0,?,? FROM history_runtime
      WHERE id=1 AND state='ready'
        AND EXISTS(SELECT 1 FROM history_correction_outbox WHERE id=? AND publication_state='pending')
        AND NOT EXISTS(SELECT 1 FROM archive_correction_addendum_builds
          WHERE correction_id=? AND state IN ('pending','published'))`)
      .bind(requestedPublicationId, correctionId, archiveId, at, at, correctionId, correctionId),
    db.prepare(`SELECT publication_id,correction_id,generation,archive_id,state,revision
      FROM archive_correction_addendum_builds WHERE correction_id=? AND state IN ('pending','published')
      ORDER BY created_at DESC,publication_id DESC LIMIT 1`).bind(correctionId),
  ]);
  const row = result[1].results[0];
  if (!row || row.state === 'invalid') fail('STALE');
  return Object.freeze({ publicationId: row.publication_id, generation: row.generation });
}

export async function publishCorrectionAddendum<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  storage: AddendumStorage,
  suppliedHandle: CorrectionAddendumHandle,
  applicationVersion = 'archive-addendum-v1',
): Promise<{ handle: CorrectionAddendumHandle; reference: ArchiveReference; records: readonly ArchiveRecord[]; replay: boolean }> {
  const handle = Object.freeze({ ...suppliedHandle });
  if (!id(handle.publicationId) || !id(handle.generation)) fail('HANDLE_INVALID');
  const existing = await db.prepare('SELECT * FROM archive_correction_addendum_publications WHERE publication_id=?')
    .bind(handle.publicationId).first<AddendumPublicationRow>();
  if (existing) {
    return { handle, reference: parseReference(existing.root_reference_json, 'addendum'), records: [], replay: true };
  }
  const { build, correction } = await correctionAndBuild(db, handle);
  if (build.state !== 'pending') fail('STALE');
  const parent = await selectParent(db, correction);
  if (parent.chainDepth >= 16) fail('GRAPH_BOUND');
  await assertParentChain(db, parent);
  const parentEvidence = await readRootRecord(storage, parent, 'visits', correction.visit_id);
  const records = buildRecords(correction, parentEvidence.record);
  const month = calendarMonth(correction.original_check_in_at, correction.timezone);
  const schemaRows = await db.prepare('SELECT version FROM schema_versions ORDER BY version')
    .all<{ version: number }>();
  const schemaVersions = schemaRows.results.map(row => Number(row.version));
  if (!schemaVersions.length || schemaVersions.length > 256
      || schemaVersions.some((version, index) => !Number.isSafeInteger(version)
        || version < 1 || (index > 0 && version <= schemaVersions[index - 1]))) fail('SCHEMA_INVALID');
  const metadata: ArchiveMetadata = {
    archiveId: build.archive_id,
    centerId: correction.center_id,
    month,
    timezone: correction.timezone,
    kind: 'addendum',
    createdAt: immutableCreatedAt(parent.header),
    applicationVersion,
    schemaVersions,
    references: [parent.reference],
    ...(parent.header.semanticProof ? { semanticProof: parent.header.semanticProof } : {}),
  };
  const archive = await createArchive(storage.masterKey, metadata, records, async (part, bytes) => {
    await storage.bucket.put(part.objectKey, bytes);
    const readback = await readArchiveEvidenceObject(storage.bucket, part.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, bytes.length);
    if (await digest(readback) !== part.encryptedSha256) fail('PART_READBACK_INVALID');
  });
  if (archive.manifest.parts.length !== 1 || archive.manifest.recordCount !== 3) fail('RECORD_SET_INVALID');
  await storage.bucket.put(archive.objectKey, archive.encrypted);
  const manifestReadback = await readArchiveEvidenceObject(
    storage.bucket,
    archive.objectKey,
    ARCHIVE_LIMITS.encryptedManifestBytes,
    archive.encrypted.length,
  );
  const opened = await openArchiveManifest(storage.masterKey, manifestReadback, {
    archiveId: archive.manifest.archiveId,
    kind: 'addendum',
    manifestObjectKey: archive.objectKey,
    manifestSha256: archive.sha256,
  });
  if (JSON.stringify(opened) !== JSON.stringify(archive.manifest)) fail('MANIFEST_INVALID');

  const fresh = await correctionAndBuild(db, handle);
  if (JSON.stringify(fresh.correction) !== JSON.stringify(correction)) fail('SOURCE_CHANGED');
  const freshParent = await selectParent(db, fresh.correction);
  await assertParentChain(db, freshParent);
  if (JSON.stringify(freshParent) !== JSON.stringify(parent)) fail('PARENT_CHANGED');

  const reference: ArchiveReference = {
    archiveId: archive.manifest.archiveId,
    kind: 'addendum',
    manifestObjectKey: archive.objectKey,
    manifestSha256: archive.sha256,
  };
  const header = headerOf(archive.manifest);
  const headerJson = JSON.stringify(header);
  const descriptor = archive.manifest.parts[0];
  const descriptorText = JSON.stringify(descriptor);
  const publishedAt = now();
  try {
    await db.batch([
      db.prepare(`INSERT INTO archive_correction_addendum_publications(
        publication_id,correction_id,generation,archive_id,center_id,visit_id,month,timezone,
        expected_version,resulting_version,parent_kind,parent_publication_id,parent_reference_json,chain_depth,
        root_reference_json,header_json,header_sha256,manifest_object_key,manifest_sha256,
        part_descriptor_json,part_descriptor_sha256,records_sha256,published_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          handle.publicationId, correction.id, handle.generation, build.archive_id,
          correction.center_id, correction.visit_id, month, correction.timezone,
          correction.expected_version, correction.resulting_version, parent.kind,
          parent.publicationId, JSON.stringify(parent.reference), parent.chainDepth + 1,
          JSON.stringify(reference), headerJson, await digest(encoder.encode(headerJson)),
          archive.objectKey, archive.sha256, descriptorText,
          await digest(encoder.encode(descriptorText)),
          await digest(encoder.encode(JSON.stringify(records))), publishedAt,
        ),
      db.prepare(`INSERT INTO archive_correction_addendum_availability(publication_id,generation,status,reconciliation_id)
        VALUES(?,?,'ready',NULL)`).bind(handle.publicationId, handle.generation),
      db.prepare(`UPDATE archive_correction_addendum_builds
        SET state='published',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+0.001 seconds')
        WHERE publication_id=? AND generation=? AND state='pending'`).bind(handle.publicationId, handle.generation),
      db.prepare(`SELECT CASE WHEN EXISTS(
        SELECT 1 FROM archive_correction_addendum_builds
        WHERE publication_id=? AND generation=? AND state='published'
      ) THEN 1 ELSE json('ARCHIVE_ADDENDUM_COMMIT_STALE') END AS committed`)
        .bind(handle.publicationId, handle.generation),
    ]);
  } catch (error) {
    const winner = await db.prepare('SELECT * FROM archive_correction_addendum_publications WHERE correction_id=?')
      .bind(correction.id).first<AddendumPublicationRow>();
    if (winner) {
      return {
        handle: Object.freeze({ publicationId: winner.publication_id, generation: winner.generation }),
        reference: parseReference(winner.root_reference_json, 'addendum'),
        records: [],
        replay: true,
      };
    }
    throw error;
  }
  return { handle, reference, records: Object.freeze(records), replay: false };
}

export async function startCorrectionAddendumReconciliation<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  publicationId: string,
  requestedReconciliationId: string = crypto.randomUUID(),
): Promise<CorrectionAddendumReconciliationHandle> {
  if (!id(publicationId) || !id(requestedReconciliationId)) fail('HANDLE_INVALID');
  const replay = await db.prepare('SELECT publication_id,execution_generation FROM archive_correction_addendum_reconciliation_jobs WHERE reconciliation_id=?')
    .bind(requestedReconciliationId).first<{ publication_id: string; execution_generation: string }>();
  if (replay) {
    if (replay.publication_id !== publicationId) fail('HANDLE_INVALID');
    return Object.freeze({ reconciliationId: requestedReconciliationId, publicationId, generation: replay.execution_generation });
  }
  const publication = await publicationById(db, publicationId);
  const parent = await parentForPublication(db, publication);
  await assertParentChain(db, parent);
  const generation = await db.prepare("SELECT generation FROM history_runtime WHERE id=1 AND state='ready'").first<string>('generation');
  if (!id(generation)) fail('STALE');
  const descriptor = descriptorJson(publication);
  const descriptorSha256 = await digest(encoder.encode(descriptor));
  const at = now();
  await db.batch([
    db.prepare(`INSERT INTO archive_correction_addendum_reconciliation_jobs(
      reconciliation_id,publication_id,execution_generation,descriptor_json,descriptor_sha256,state,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',0,?,?)`)
      .bind(requestedReconciliationId, publicationId, generation, descriptor, descriptorSha256, at, at),
    db.prepare(`UPDATE archive_correction_addendum_availability
      SET generation=?,status='unavailable',reconciliation_id=NULL
      WHERE publication_id=?`).bind(generation, publicationId),
  ]);
  return Object.freeze({ reconciliationId: requestedReconciliationId, publicationId, generation });
}

export async function reconcileCorrectionAddendum<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  storage: AddendumStorage,
  suppliedHandle: CorrectionAddendumReconciliationHandle,
): Promise<{ state: 'complete'; ready: boolean; replay: boolean }> {
  const handle = Object.freeze({ ...suppliedHandle });
  if (!id(handle.reconciliationId) || !id(handle.publicationId) || !id(handle.generation)) fail('HANDLE_INVALID');
  const job = await db.prepare('SELECT * FROM archive_correction_addendum_reconciliation_jobs WHERE reconciliation_id=?')
    .bind(handle.reconciliationId).first<ReconciliationJob>();
  if (!job || job.publication_id !== handle.publicationId || job.execution_generation !== handle.generation) fail('STALE');
  if (job.state === 'invalid') fail('STALE');
  if (job.state === 'complete') {
    const ready = await db.prepare(`SELECT count(*) AS n FROM archive_correction_addendum_availability
      WHERE publication_id=? AND generation=? AND status='ready' AND reconciliation_id=?`)
      .bind(handle.publicationId, handle.generation, handle.reconciliationId).first<number>('n');
    return { state: 'complete', ready: ready === 1, replay: true };
  }
  const publication = await publicationById(db, handle.publicationId);
  if (descriptorJson(publication) !== job.descriptor_json
      || await digest(encoder.encode(job.descriptor_json)) !== job.descriptor_sha256) fail('DESCRIPTOR_INVALID');
  try {
    const parent = await parentForPublication(db, publication);
    await assertParentChain(db, parent);
    const [parentEvidence, addendum] = await Promise.all([
      readRootRecord(storage, parent, 'visits', publication.visit_id),
      readAddendumRecords(storage, publication),
    ]);
    if (addendum.manifest.createdAt <= parentEvidence.manifest.createdAt
        || JSON.stringify(addendum.manifest.references) !== JSON.stringify([parent.reference])) fail('GRAPH_INVALID');
    validateAddendumRecords(publication, parentEvidence.record, addendum.records);
    const freshParent = await parentForPublication(db, publication);
    await assertParentChain(db, freshParent);
    if (JSON.stringify(freshParent) !== JSON.stringify(parent)) fail('PARENT_CHANGED');
    const at = now();
    try {
      await db.batch([
        db.prepare(`INSERT INTO archive_correction_addendum_reconciliation_receipts(
          reconciliation_id,publication_id,execution_generation,descriptor_json,descriptor_sha256,evidence_sha256,completed_at)
          VALUES(?,?,?,?,?,?,?)`)
          .bind(handle.reconciliationId, handle.publicationId, handle.generation,
            job.descriptor_json, job.descriptor_sha256, addendum.evidenceSha256, at),
        db.prepare(`UPDATE archive_correction_addendum_reconciliation_jobs
          SET state='complete',revision=revision+1,updated_at=?
          WHERE reconciliation_id=? AND state='pending' AND revision=?`)
          .bind(at, handle.reconciliationId, job.revision),
        db.prepare(`UPDATE archive_correction_addendum_availability
          SET generation=?,status='ready',reconciliation_id=? WHERE publication_id=?`)
          .bind(handle.generation, handle.reconciliationId, handle.publicationId),
      ]);
    } catch (error) {
      const winner = await db.prepare(`SELECT count(*) AS n FROM archive_correction_addendum_availability
        WHERE publication_id=? AND generation=? AND status='ready'`)
        .bind(handle.publicationId, handle.generation).first<number>('n');
      if (winner === 1) return { state: 'complete', ready: true, replay: true };
      throw error;
    }
    return { state: 'complete', ready: true, replay: false };
  } catch (error) {
    try {
      await db.prepare(`UPDATE archive_correction_addendum_reconciliation_jobs
        SET state='invalid',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+0.001 seconds')
        WHERE reconciliation_id=? AND state='pending' AND revision=?`)
        .bind(handle.reconciliationId, job.revision).first();
    } catch { /* Preserve the authenticated failure from above. */ }
    throw error;
  }
}

export async function readPublishedCorrectionAddendum<S extends AddendumStatement<S>>(
  db: AddendumDatabase<S>,
  storage: AddendumStorage,
  correctionId: string,
): Promise<Readonly<{ visit: ArchiveRecord; correction: ArchiveRecord; audit: ArchiveRecord; generation: string }>> {
  if (!id(correctionId)) fail('HANDLE_INVALID');
  const selection = await db.prepare(`SELECT p.*,a.generation AS availability_generation,a.status AS availability_status,
      a.reconciliation_id,h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_correction_addendum_publications p
    JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.correction_id=?`).bind(correctionId).first<AddendumPublicationRow & Record<string, unknown>>();
  if (!selection || selection.availability_status !== 'ready'
      || selection.availability_generation !== selection.runtime_generation
      || selection.runtime_state !== 'ready') fail('UNAVAILABLE');
  const parent = await parentForPublication(db, selection);
  await assertParentChain(db, parent);
  const authority = JSON.stringify(selection);
  const addendum = await readAddendumRecords(storage, selection);
  const fresh = await db.prepare(`SELECT p.*,a.generation AS availability_generation,a.status AS availability_status,
      a.reconciliation_id,h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_correction_addendum_publications p
    JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.correction_id=?`).bind(correctionId).first<AddendumPublicationRow & Record<string, unknown>>();
  if (!fresh || JSON.stringify(fresh) !== authority) fail('AUTHORITY_CHANGED');
  const freshParent = await parentForPublication(db, fresh);
  await assertParentChain(db, freshParent);
  if (JSON.stringify(freshParent) !== JSON.stringify(parent)) fail('AUTHORITY_CHANGED');
  const visit = addendum.records.find(record => record.table === 'visits');
  const correction = addendum.records.find(record => record.table === 'attendance_corrections');
  const audit = addendum.records.find(record => record.table === 'audit_entries');
  if (!visit || !correction || !audit) fail('RECORD_SET_INVALID');
  return Object.freeze({ visit, correction, audit, generation: String(selection.runtime_generation) });
}

export type CorrectionAddendumMaintenanceResult = Readonly<{
  state: 'disabled' | 'idle' | 'published' | 'reconciled' | 'waiting';
  id?: string;
}>;

/** Performs at most one bounded R2 addendum operation per invocation. Parent
 * monthly reconciliation remains the prerequisite after a restore. */
export async function maintainCorrectionAddenda<S extends AddendumStatement<S>>(
  env: {
    CRM_DB: AddendumDatabase<S>;
    BACKUP_BUCKET?: AddendumStorage['bucket'];
    BACKUP_KEY?: unknown;
    APP_VERSION?: unknown;
  },
): Promise<CorrectionAddendumMaintenanceResult> {
  if (!env.BACKUP_BUCKET || typeof env.BACKUP_KEY !== 'string' || !env.BACKUP_KEY) {
    return Object.freeze({ state: 'disabled' });
  }
  const storage: AddendumStorage = { bucket: env.BACKUP_BUCKET, masterKey: env.BACKUP_KEY };
  const pendingCheckpointReconciliation = await env.CRM_DB.prepare(`SELECT j.reconciliation_id,j.publication_id,j.execution_generation
    FROM archive_correction_checkpoint_reconciliation_jobs j
    JOIN history_runtime h ON h.id=1 AND h.generation=j.execution_generation AND h.state='ready'
    WHERE j.state='pending' ORDER BY j.created_at,j.reconciliation_id LIMIT 1`)
    .first<{ reconciliation_id: string; publication_id: string; execution_generation: string }>();
  if (pendingCheckpointReconciliation) {
    await reconcileCorrectionCheckpoint(env.CRM_DB, storage, {
      reconciliationId: pendingCheckpointReconciliation.reconciliation_id,
      publicationId: pendingCheckpointReconciliation.publication_id,
      generation: pendingCheckpointReconciliation.execution_generation,
    });
    return Object.freeze({ state: 'reconciled', id: pendingCheckpointReconciliation.publication_id });
  }

  const unavailableCheckpoint = await env.CRM_DB.prepare(`SELECT p.publication_id
    FROM archive_correction_checkpoint_publications p
    JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1 AND h.state='ready'
    WHERE a.status='unavailable' AND a.generation=h.generation
      AND NOT EXISTS(SELECT 1 FROM archive_correction_checkpoint_reconciliation_jobs j
        WHERE j.publication_id=p.publication_id AND j.execution_generation=h.generation
          AND j.state IN ('pending','complete'))
      AND (SELECT count(*) FROM archive_correction_checkpoint_reconciliation_jobs j
        WHERE j.publication_id=p.publication_id AND j.execution_generation=h.generation
          AND j.state='invalid')<4
    ORDER BY p.published_at,p.publication_id LIMIT 1`).first<string>('publication_id');
  if (unavailableCheckpoint) {
    try {
      const handle = await startCorrectionCheckpointReconciliation(env.CRM_DB, unavailableCheckpoint);
      await reconcileCorrectionCheckpoint(env.CRM_DB, storage, handle);
      return Object.freeze({ state: 'reconciled', id: unavailableCheckpoint });
    } catch (error) {
      if (String(error).includes('ARCHIVE_CHECKPOINT_BASE_UNAVAILABLE')
          || String(error).includes('ARCHIVE_CHECKPOINT_BASE_MISSING')) {
        return Object.freeze({ state: 'waiting', id: unavailableCheckpoint });
      }
      throw error;
    }
  }

  const checkpointVisit = await nextCheckpointCandidate(env.CRM_DB);
  if (checkpointVisit) {
    const handle = await startCorrectionCheckpoint(env.CRM_DB, checkpointVisit);
    const published = await publishCorrectionCheckpoint(
      env.CRM_DB,
      storage,
      handle,
      correctionId => readPublishedCorrectionAddendum(env.CRM_DB, storage, correctionId),
      typeof env.APP_VERSION === 'string' && env.APP_VERSION ? env.APP_VERSION : 'archive-checkpoint-v1',
    );
    return Object.freeze({ state: 'published', id: published.handle.publicationId });
  }

  const pendingReconciliation = await env.CRM_DB.prepare(`SELECT j.reconciliation_id,j.publication_id,j.execution_generation
    FROM archive_correction_addendum_reconciliation_jobs j
    JOIN history_runtime h ON h.id=1 AND h.generation=j.execution_generation AND h.state='ready'
    WHERE j.state='pending' ORDER BY j.created_at,j.reconciliation_id LIMIT 1`)
    .first<{ reconciliation_id: string; publication_id: string; execution_generation: string }>();
  if (pendingReconciliation) {
    await reconcileCorrectionAddendum(env.CRM_DB, storage, {
      reconciliationId: pendingReconciliation.reconciliation_id,
      publicationId: pendingReconciliation.publication_id,
      generation: pendingReconciliation.execution_generation,
    });
    return Object.freeze({ state: 'reconciled', id: pendingReconciliation.publication_id });
  }

  const unavailable = await env.CRM_DB.prepare(`SELECT p.publication_id
    FROM archive_correction_addendum_publications p
    JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1 AND h.state='ready'
    WHERE a.status='unavailable' AND a.generation=h.generation
      AND NOT EXISTS(SELECT 1 FROM archive_correction_addendum_reconciliation_jobs j
        WHERE j.publication_id=p.publication_id AND j.execution_generation=h.generation
          AND j.state IN ('pending','complete'))
      AND (SELECT count(*) FROM archive_correction_addendum_reconciliation_jobs j
        WHERE j.publication_id=p.publication_id AND j.execution_generation=h.generation
          AND j.state='invalid')<4
    ORDER BY p.chain_depth,p.published_at,p.publication_id LIMIT 1`)
    .first<string>('publication_id');
  if (unavailable) {
    try {
      const handle = await startCorrectionAddendumReconciliation(env.CRM_DB, unavailable);
      await reconcileCorrectionAddendum(env.CRM_DB, storage, handle);
      return Object.freeze({ state: 'reconciled', id: unavailable });
    } catch (error) {
      if (String(error).includes('ARCHIVE_ADDENDUM_PARENT_UNAVAILABLE')) {
        return Object.freeze({ state: 'waiting', id: unavailable });
      }
      throw error;
    }
  }

  const correctionId = await env.CRM_DB.prepare(`SELECT c.id FROM history_correction_outbox c
    WHERE c.publication_state='pending'
      AND NOT EXISTS(SELECT 1 FROM archive_correction_addendum_publications p WHERE p.correction_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM archive_correction_addendum_builds b
        WHERE b.correction_id=c.id AND b.state='published')
    ORDER BY c.recorded_at,c.id LIMIT 1`).first<string>('id');
  if (!correctionId) return Object.freeze({ state: 'idle' });
  try {
    const handle = await startCorrectionAddendumPublication(env.CRM_DB, correctionId);
    const published = await publishCorrectionAddendum(
      env.CRM_DB,
      storage,
      handle,
      typeof env.APP_VERSION === 'string' && env.APP_VERSION ? env.APP_VERSION : 'archive-addendum-v1',
    );
    return Object.freeze({ state: 'published', id: published.handle.publicationId });
  } catch (error) {
    if (String(error).includes('ARCHIVE_ADDENDUM_PARENT_UNAVAILABLE')) {
      return Object.freeze({ state: 'waiting', id: correctionId });
    }
    throw error;
  }
}
