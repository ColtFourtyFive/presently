import {
  ARCHIVE_FORMAT_V2,
  ARCHIVE_LIMITS,
  type ArchiveManifest,
  type ArchiveMetadata,
  type ArchiveRecord,
  type ArchiveReference,
} from '../shared/archive-format';
import { compareArchiveRecords, createArchive, openArchiveManifest, verifyArchivePart } from './archive-codec';
import { digest } from './backup-crypto';
import { loadManifestRecordEvidence, readArchiveEvidenceObject, type ArchiveEvidenceObject } from './archive-record-evidence';

export type CheckpointStatement<S> = {
  bind(...values: unknown[]): S;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T extends Record<string, unknown>>(): Promise<{ results: T[] }>;
};

export type CheckpointDatabase<S extends CheckpointStatement<S>> = {
  prepare(sql: string): S;
  batch<T extends Record<string, unknown>>(statements: S[]): Promise<{ results: T[] }[]>;
};

export type CheckpointStorage = {
  masterKey: string;
  bucket: {
    get(key: string): Promise<ArchiveEvidenceObject | null>;
    put(key: string, value: Uint8Array): Promise<unknown>;
  };
};

export type CorrectionCheckpointHandle = Readonly<{
  publicationId: string;
  generation: string;
}>;

export type CorrectionCheckpointReconciliationHandle = Readonly<{
  reconciliationId: string;
  publicationId: string;
  generation: string;
}>;

export type PublishedCorrectionEvidence = Readonly<{
  visit: ArchiveRecord;
  correction: ArchiveRecord;
  audit: ArchiveRecord;
  generation: string;
}>;

type BuildRow = {
  publication_id: string;
  generation: string;
  archive_id: string;
  center_id: string;
  visit_id: string;
  base_publication_id: string;
  target_version: number;
  correction_count: number;
  state: 'pending' | 'published' | 'invalid';
  revision: number;
  created_at: string;
  updated_at: string;
};

type BaseRow = {
  publication_id: string;
  generation: string;
  archive_id: string;
  center_id: string;
  month: string;
  timezone: string;
  root_reference_json: string;
  header_json: string;
  header_sha256: string;
  availability_generation: string;
  availability_status: string;
  runtime_generation: string;
  runtime_state: string;
};

type HeadRow = {
  visit_id: string;
  center_id: string;
  student_id: string;
  original_check_in_at: string;
  original_check_out_at: string | null;
  check_in_at: string;
  check_out_at: string | null;
  version: number;
  review_status: string;
  generation: string;
  state: string;
};

type SourcePublication = {
  publication_id: string;
  correction_id: string;
  generation: string;
  center_id: string;
  visit_id: string;
  expected_version: number;
  resulting_version: number;
  manifest_sha256: string;
  availability_generation: string;
  availability_status: string;
};

export type CorrectionCheckpointPublication = {
  publication_id: string;
  generation: string;
  archive_id: string;
  center_id: string;
  visit_id: string;
  month: string;
  timezone: string;
  base_publication_id: string;
  base_reference_json: string;
  starting_version: number;
  resulting_version: number;
  correction_count: number;
  correction_ids_json: string;
  member_digest: string;
  chain_depth: number;
  root_reference_json: string;
  header_json: string;
  header_sha256: string;
  manifest_object_key: string;
  manifest_sha256: string;
  part_descriptors_json: string;
  part_descriptors_sha256: string;
  records_sha256: string;
  published_at: string;
};

type MemberRow = {
  publication_id: string;
  ordinal: number;
  correction_id: string;
  expected_version: number;
  resulting_version: number;
  source_publication_id: string;
  source_manifest_sha256: string;
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
export const CHECKPOINT_THRESHOLD = 12;
export const CHECKPOINT_MAX_CORRECTIONS = 64;
const CHECKPOINT_DESCRIPTOR_BYTES = 512 * 1024;

const timestamp = () => new Date().toISOString();
function fail(code: string): never {
  throw new Error(`ARCHIVE_CHECKPOINT_${code}`);
}
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const same = (left: unknown, right: unknown) => left === right;

function parseReference(value: string, kind: 'monthly' | 'addendum'): ArchiveReference {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail('REFERENCE_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('REFERENCE_INVALID');
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || !validId(row.archiveId) || row.kind !== kind
    || typeof row.manifestObjectKey !== 'string' || row.manifestObjectKey.length < 1 || row.manifestObjectKey.length > 1024
    || !validHash(row.manifestSha256)) fail('REFERENCE_INVALID');
  return row as ArchiveReference;
}

function parseHeader(value: string): Omit<ArchiveManifest, 'parts'> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail('HEADER_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('HEADER_INVALID');
  return parsed as Omit<ArchiveManifest, 'parts'>;
}

function headerOf(manifest: ArchiveManifest): Omit<ArchiveManifest, 'parts'> {
  const { parts: _parts, ...header } = manifest;
  return header;
}

function immutableCreatedAt(parent: Omit<ArchiveManifest, 'parts'>): string {
  const value = Date.parse(parent.createdAt);
  if (!Number.isFinite(value)) fail('BASE_INVALID');
  return new Date(Math.max(Date.now(), value + 1)).toISOString();
}

function auditDetail(correction: Record<string, unknown>): string {
  return JSON.stringify({
    reason: correction.reason,
    priorCheckInAt: correction.prior_check_in_at,
    priorCheckOutAt: correction.prior_check_out_at,
    checkInAt: correction.check_in_at,
    checkOutAt: correction.check_out_at,
  });
}

async function baseForVisit<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  visitId: string,
): Promise<BaseRow> {
  const rows = await db.prepare(`SELECT p.publication_id,p.generation,p.archive_id,p.center_id,p.month,p.timezone,
    p.root_reference_json,p.header_json,p.header_sha256,
    a.generation AS availability_generation,a.status AS availability_status,
    h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_publication_records r
    JOIN archive_publications p ON p.publication_id=r.publication_id
    JOIN archive_publication_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE r.table_name='visits' AND r.record_key=?
    ORDER BY p.published_at,p.publication_id LIMIT 2`).bind(visitId).all<BaseRow>();
  if (rows.results.length !== 1) fail(rows.results.length ? 'BASE_AMBIGUOUS' : 'BASE_MISSING');
  const row = rows.results[0];
  if (row.availability_generation !== row.runtime_generation
    || row.availability_status !== 'ready' || row.runtime_state !== 'ready') fail('BASE_UNAVAILABLE');
  return row;
}

async function headForVisit<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  visitId: string,
): Promise<HeadRow> {
  const row = await db.prepare(`SELECT v.*,h.generation,h.state
    FROM history_visit_heads v JOIN history_runtime h ON h.id=1
    WHERE v.visit_id=?`).bind(visitId).first<HeadRow>();
  if (!row || row.state !== 'ready') fail('HEAD_UNAVAILABLE');
  return row;
}

async function sourcePublications<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  visitId: string,
  generation: string,
): Promise<SourcePublication[]> {
  const rows = await db.prepare(`SELECT p.publication_id,p.correction_id,a.generation,p.center_id,p.visit_id,
    p.expected_version,p.resulting_version,p.manifest_sha256,
    a.generation AS availability_generation,a.status AS availability_status
    FROM archive_correction_addendum_publications p
    JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    WHERE p.visit_id=?
    ORDER BY p.expected_version,p.resulting_version,p.publication_id LIMIT 65`).bind(visitId).all<SourcePublication>();
  if (rows.results.some(row => row.availability_status !== 'ready' || row.availability_generation !== generation)) {
    fail('SOURCE_UNAVAILABLE');
  }
  return rows.results;
}

function validateSourceSequence(rows: readonly SourcePublication[], head: HeadRow): void {
  if (rows.length < CHECKPOINT_THRESHOLD || rows.length > CHECKPOINT_MAX_CORRECTIONS) fail('COUNT_BOUND');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.generation !== head.generation || row.center_id !== head.center_id || row.visit_id !== head.visit_id
      || row.resulting_version !== row.expected_version + 1
      || index > 0 && row.expected_version !== rows[index - 1].resulting_version) fail('SOURCE_SEQUENCE');
  }
  if (rows.at(-1)!.resulting_version !== head.version) fail('HEAD_CHANGED');
}

function memberProjection(rows: readonly SourcePublication[]) {
  return rows.map((row, index) => ({
    ordinal: index + 1,
    correctionId: row.correction_id,
    expectedVersion: row.expected_version,
    resultingVersion: row.resulting_version,
    sourcePublicationId: row.publication_id,
    sourceManifestSha256: row.manifest_sha256,
  }));
}

function finalVisitMatches(visit: ArchiveRecord, head: HeadRow): boolean {
  if (visit.table !== 'visits' || visit.key !== head.visit_id) return false;
  const row = visit.row;
  return row.id === head.visit_id && row.center_id === head.center_id && row.student_id === head.student_id
    && row.original_check_in_at === head.original_check_in_at && same(row.original_check_out_at, head.original_check_out_at)
    && row.check_in_at === head.check_in_at && same(row.check_out_at, head.check_out_at)
    && Number(row.version) === Number(head.version) && row.review_status === head.review_status;
}

function validateCorrectionTransition(
  priorVisit: ArchiveRecord,
  evidence: PublishedCorrectionEvidence,
  source: SourcePublication,
): void {
  const prior = priorVisit.row;
  const correction = evidence.correction.row;
  const visit = evidence.visit.row;
  const audit = evidence.audit.row;
  if (evidence.correction.table !== 'attendance_corrections' || evidence.audit.table !== 'audit_entries'
    || evidence.visit.table !== 'visits'
    || evidence.correction.key !== source.correction_id || evidence.audit.key !== source.correction_id
    || evidence.visit.key !== source.visit_id || evidence.generation !== source.generation
    || correction.id !== source.correction_id || correction.center_id !== source.center_id
    || correction.visit_id !== source.visit_id
    || Number(correction.expected_version) !== source.expected_version
    || Number(prior.version) !== source.expected_version || Number(visit.version) !== source.resulting_version
    || correction.prior_check_in_at !== prior.check_in_at || !same(correction.prior_check_out_at, prior.check_out_at)
    || correction.check_in_at !== visit.check_in_at || !same(correction.check_out_at, visit.check_out_at)
    || visit.id !== source.visit_id || visit.center_id !== source.center_id
    || prior.id !== visit.id || prior.center_id !== visit.center_id || prior.student_id !== visit.student_id
    || prior.original_check_in_at !== visit.original_check_in_at
    || !same(prior.original_check_out_at, visit.original_check_out_at)
    || prior.check_in_by !== visit.check_in_by || !same(prior.check_out_by, visit.check_out_by)
    || !same(prior.guardian_id, visit.guardian_id) || !same(prior.departure_type, visit.departure_type)
    || prior.review_status !== visit.review_status
    || audit.id !== source.correction_id || audit.center_id !== source.center_id
    || audit.actor_id !== correction.actor_id || audit.actor_name !== correction.actor_name
    || audit.action !== 'attendance_correction' || audit.entity_type !== 'visit'
    || audit.entity_id !== source.visit_id || audit.detail !== auditDetail(correction)
    || audit.created_at !== correction.recorded_at) fail('SEMANTIC_INVALID');
}

export async function startCorrectionCheckpoint<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  visitId: string,
  requestedPublicationId: string = crypto.randomUUID(),
): Promise<CorrectionCheckpointHandle> {
  if (!validId(visitId) || !validId(requestedPublicationId)) fail('HANDLE_INVALID');
  const archiveId = `checkpoint_${requestedPublicationId.replaceAll('-', '_')}`;
  if (!validId(archiveId)) fail('HANDLE_INVALID');
  const [head, base] = await Promise.all([headForVisit(db, visitId), baseForVisit(db, visitId)]);
  if (head.center_id !== base.center_id || head.generation !== base.availability_generation) fail('BASE_INVALID');
  const existing = await db.prepare(`SELECT p.publication_id,p.generation
    FROM archive_correction_checkpoint_publications p
    JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    WHERE p.visit_id=? AND p.resulting_version=? AND a.status='ready' AND a.generation=?
    ORDER BY p.published_at,p.publication_id LIMIT 2`).bind(visitId, head.version, head.generation)
    .all<{ publication_id: string; generation: string }>();
  if (existing.results.length > 1) fail('START_CONFLICT');
  if (existing.results.length === 1) {
    return Object.freeze({ publicationId: existing.results[0].publication_id, generation: existing.results[0].generation });
  }
  const sources = await sourcePublications(db, visitId, head.generation);
  validateSourceSequence(sources, head);
  const at = timestamp();
  await db.prepare(`INSERT OR IGNORE INTO archive_correction_checkpoint_builds(
    publication_id,generation,archive_id,center_id,visit_id,base_publication_id,
    target_version,correction_count,state,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?)`).bind(
    requestedPublicationId, head.generation, archiveId, head.center_id, visitId,
    base.publication_id, head.version, sources.length, at, at,
  ).first();
  const row = await db.prepare(`SELECT * FROM archive_correction_checkpoint_builds
    WHERE publication_id=? OR (visit_id=? AND state='pending')
    ORDER BY created_at,publication_id LIMIT 1`).bind(requestedPublicationId, visitId).first<BuildRow>();
  if (!row || row.state === 'invalid') fail('START_CONFLICT');
  return Object.freeze({ publicationId: row.publication_id, generation: row.generation });
}

type CheckpointEvidence = {
  publication: CorrectionCheckpointPublication;
  members: MemberRow[];
  reference: ArchiveReference;
  header: Omit<ArchiveManifest, 'parts'>;
  records: ArchiveRecord[];
  visit: ArchiveRecord;
  evidenceSha256: string;
};

function descriptorJson(publication: CorrectionCheckpointPublication, members: readonly MemberRow[]): string {
  const descriptor = JSON.stringify({ publication, members });
  if (encoder.encode(descriptor).length > CHECKPOINT_DESCRIPTOR_BYTES) fail('DESCRIPTOR_BOUND');
  return descriptor;
}

async function readCheckpointEvidence<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  storage: CheckpointStorage,
  publication: CorrectionCheckpointPublication,
): Promise<CheckpointEvidence> {
  const members = (await db.prepare(`SELECT * FROM archive_correction_checkpoint_members
    WHERE publication_id=? ORDER BY ordinal`).bind(publication.publication_id).all<MemberRow>()).results;
  let correctionIds: unknown;
  try { correctionIds = JSON.parse(publication.correction_ids_json); } catch { return fail('MEMBERS_INVALID'); }
  if (!Array.isArray(correctionIds)
    || correctionIds.length !== members.length
    || correctionIds.some((correctionId, index) => correctionId !== members[index]?.correction_id)
    || members.length !== publication.correction_count
    || members.some((member, index) => member.ordinal !== index + 1
      || member.expected_version !== publication.starting_version + index
      || member.resulting_version !== publication.starting_version + index + 1)
    || await digest(encoder.encode(JSON.stringify(members.map(member => ({
      ordinal: member.ordinal,
      correctionId: member.correction_id,
      expectedVersion: member.expected_version,
      resultingVersion: member.resulting_version,
      sourcePublicationId: member.source_publication_id,
      sourceManifestSha256: member.source_manifest_sha256,
    }))))) !== publication.member_digest) fail('MEMBERS_INVALID');

  const base = await baseForVisit(db, publication.visit_id);
  if (base.publication_id !== publication.base_publication_id
    || base.root_reference_json !== publication.base_reference_json || base.center_id !== publication.center_id
    || base.month !== publication.month || base.timezone !== publication.timezone) fail('BASE_CHANGED');
  const baseReference = parseReference(base.root_reference_json, 'monthly');
  const baseVisit = await loadManifestRecordEvidence(storage, {
    reference: baseReference,
    centerId: base.center_id,
    month: base.month,
    timezone: base.timezone,
    headerSha256: base.header_sha256,
    table: 'visits',
    recordKey: publication.visit_id,
  });
  if (Number(baseVisit.row.version) !== publication.starting_version) fail('BASE_VISIT_INVALID');

  const reference = parseReference(publication.root_reference_json, 'addendum');
  const manifestBytes = await readArchiveEvidenceObject(storage.bucket, reference.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes);
  const manifest = await openArchiveManifest(storage.masterKey, manifestBytes, reference);
  const header = headerOf(manifest);
  let descriptors: unknown;
  try { descriptors = JSON.parse(publication.part_descriptors_json); } catch { return fail('DESCRIPTORS_INVALID'); }
  if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.archiveId !== publication.archive_id
    || manifest.centerId !== publication.center_id || manifest.month !== publication.month
    || manifest.timezone !== publication.timezone || manifest.kind !== 'addendum'
    || JSON.stringify(manifest.references) !== JSON.stringify([baseReference])
    || JSON.stringify(header) !== publication.header_json
    || await digest(encoder.encode(publication.header_json)) !== publication.header_sha256
    || JSON.stringify(manifest.parts) !== JSON.stringify(descriptors)
    || await digest(encoder.encode(publication.part_descriptors_json)) !== publication.part_descriptors_sha256) {
    fail('MANIFEST_INVALID');
  }
  const records: ArchiveRecord[] = [];
  for (const part of manifest.parts) {
    const bytes = await readArchiveEvidenceObject(storage.bucket, part.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, part.encryptedBytes);
    records.push(...await verifyArchivePart(storage.masterKey, manifest, part, bytes));
  }
  if (records.length !== 1 + 2 * publication.correction_count
    || await digest(encoder.encode(JSON.stringify(records))) !== publication.records_sha256) fail('RECORD_SET_INVALID');
  const visits = records.filter(record => record.table === 'visits');
  const corrections = new Map(records.filter(record => record.table === 'attendance_corrections').map(record => [record.key, record]));
  const audits = new Map(records.filter(record => record.table === 'audit_entries').map(record => [record.key, record]));
  if (visits.length !== 1 || corrections.size !== publication.correction_count || audits.size !== publication.correction_count) {
    fail('RECORD_SET_INVALID');
  }
  let prior = baseVisit;
  for (const member of members) {
    const correction = corrections.get(member.correction_id);
    const audit = audits.get(member.correction_id);
    if (!correction || !audit) fail('RECORD_SET_INVALID');
    const syntheticVisit: ArchiveRecord = {
      table: 'visits',
      key: publication.visit_id,
      row: {
        ...prior.row,
        check_in_at: correction.row.check_in_at,
        check_out_at: correction.row.check_out_at,
        version: member.resulting_version,
      },
    };
    validateCorrectionTransition(prior, {
      visit: member.ordinal === members.length ? visits[0] : syntheticVisit,
      correction,
      audit,
      generation: publication.generation,
    }, {
      publication_id: member.source_publication_id,
      correction_id: member.correction_id,
      generation: publication.generation,
      center_id: publication.center_id,
      visit_id: publication.visit_id,
      expected_version: member.expected_version,
      resulting_version: member.resulting_version,
      manifest_sha256: member.source_manifest_sha256,
      availability_generation: publication.generation,
      availability_status: 'ready',
    });
    prior = member.ordinal === members.length ? visits[0] : syntheticVisit;
  }
  return {
    publication,
    members,
    reference,
    header,
    records,
    visit: visits[0],
    evidenceSha256: await digest(encoder.encode(JSON.stringify({
      manifestSha256: reference.manifestSha256,
      partHashes: manifest.parts.map(part => part.encryptedSha256),
      memberDigest: publication.member_digest,
      recordsSha256: publication.records_sha256,
    }))),
  };
}

export async function publishCorrectionCheckpoint<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  storage: CheckpointStorage,
  suppliedHandle: CorrectionCheckpointHandle,
  readCorrection: (correctionId: string) => Promise<PublishedCorrectionEvidence>,
  applicationVersion = 'archive-checkpoint-v1',
): Promise<Readonly<{ handle: CorrectionCheckpointHandle; reference: ArchiveReference; records: readonly ArchiveRecord[]; replay: boolean }>> {
  const handle = Object.freeze({ ...suppliedHandle });
  if (!validId(handle.publicationId) || !validId(handle.generation)) fail('HANDLE_INVALID');
  const existing = await db.prepare(`SELECT p.*,a.generation AS availability_generation,
    a.status AS availability_status,h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_correction_checkpoint_publications p
    JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1 WHERE p.publication_id=?`)
    .bind(handle.publicationId).first<CorrectionCheckpointPublication & Record<string, unknown>>();
  if (existing) {
    if (existing.generation !== handle.generation
      || existing.availability_status !== 'ready'
      || existing.availability_generation !== existing.runtime_generation
      || existing.runtime_state !== 'ready') fail('STALE');
    const evidence = await readCheckpointEvidence(db, storage, existing);
    return Object.freeze({ handle, reference: evidence.reference, records: Object.freeze(evidence.records), replay: true });
  }
  const build = await db.prepare('SELECT * FROM archive_correction_checkpoint_builds WHERE publication_id=?')
    .bind(handle.publicationId).first<BuildRow>();
  if (!build || build.generation !== handle.generation || build.state !== 'pending') fail('STALE');
  const [head, base] = await Promise.all([headForVisit(db, build.visit_id), baseForVisit(db, build.visit_id)]);
  const sources = await sourcePublications(db, build.visit_id, build.generation);
  validateSourceSequence(sources, head);
  if (head.generation !== build.generation || head.center_id !== build.center_id || head.version !== build.target_version
    || base.publication_id !== build.base_publication_id || base.availability_generation !== build.generation
    || sources.length !== build.correction_count) fail('SOURCE_CHANGED');
  const baseReference = parseReference(base.root_reference_json, 'monthly');
  const baseHeader = parseHeader(base.header_json);
  const baseVisit = await loadManifestRecordEvidence(storage, {
    reference: baseReference,
    centerId: base.center_id,
    month: base.month,
    timezone: base.timezone,
    headerSha256: base.header_sha256,
    table: 'visits',
    recordKey: build.visit_id,
  });
  if (Number(baseVisit.row.version) !== sources[0].expected_version) fail('BASE_VISIT_INVALID');
  const records: ArchiveRecord[] = [];
  let priorVisit = baseVisit;
  for (const source of sources) {
    const evidence = await readCorrection(source.correction_id);
    validateCorrectionTransition(priorVisit, evidence, source);
    records.push(evidence.correction, evidence.audit);
    priorVisit = evidence.visit;
  }
  if (!finalVisitMatches(priorVisit, head)) fail('HEAD_CHANGED');
  records.push(priorVisit);
  records.sort(compareArchiveRecords);
  const memberProjectionValue = memberProjection(sources);
  const memberDigest = await digest(encoder.encode(JSON.stringify(memberProjectionValue)));
  const correctionIds = sources.map(row => row.correction_id);
  const schemaRows = await db.prepare('SELECT version FROM schema_versions ORDER BY version').all<{ version: number }>();
  const schemaVersions = schemaRows.results.map(row => Number(row.version));
  const metadata: ArchiveMetadata = {
    archiveId: build.archive_id,
    centerId: build.center_id,
    month: base.month,
    timezone: base.timezone,
    kind: 'addendum',
    createdAt: immutableCreatedAt(baseHeader),
    applicationVersion,
    schemaVersions,
    references: [baseReference],
    ...(baseHeader.semanticProof ? { semanticProof: baseHeader.semanticProof } : {}),
  };
  const archive = await createArchive(storage.masterKey, metadata, records, async (part, bytes) => {
    await storage.bucket.put(part.objectKey, bytes);
    const readback = await readArchiveEvidenceObject(storage.bucket, part.objectKey, ARCHIVE_LIMITS.encryptedPartBytes, bytes.length);
    if (await digest(readback) !== part.encryptedSha256) fail('PART_READBACK_INVALID');
  });
  if (archive.manifest.parts.length < 1 || archive.manifest.parts.length > 8
    || archive.manifest.recordCount !== records.length) fail('RECORD_SET_INVALID');
  await storage.bucket.put(archive.objectKey, archive.encrypted);
  const manifestReadback = await readArchiveEvidenceObject(storage.bucket, archive.objectKey, ARCHIVE_LIMITS.encryptedManifestBytes, archive.encrypted.length);
  const opened = await openArchiveManifest(storage.masterKey, manifestReadback, {
    archiveId: archive.manifest.archiveId,
    kind: 'addendum',
    manifestObjectKey: archive.objectKey,
    manifestSha256: archive.sha256,
  });
  if (JSON.stringify(opened) !== JSON.stringify(archive.manifest)) fail('MANIFEST_INVALID');

  const [freshBuild, freshHead, freshBase] = await Promise.all([
    db.prepare('SELECT * FROM archive_correction_checkpoint_builds WHERE publication_id=?').bind(handle.publicationId).first<BuildRow>(),
    headForVisit(db, build.visit_id),
    baseForVisit(db, build.visit_id),
  ]);
  const freshSources = await sourcePublications(db, build.visit_id, build.generation);
  if (JSON.stringify(freshBuild) !== JSON.stringify(build) || JSON.stringify(freshHead) !== JSON.stringify(head)
    || JSON.stringify(freshBase) !== JSON.stringify(base) || JSON.stringify(freshSources) !== JSON.stringify(sources)) {
    fail('SOURCE_CHANGED');
  }
  const reference: ArchiveReference = {
    archiveId: archive.manifest.archiveId,
    kind: 'addendum',
    manifestObjectKey: archive.objectKey,
    manifestSha256: archive.sha256,
  };
  const header = headerOf(archive.manifest);
  const headerJson = JSON.stringify(header);
  const descriptorsJson = JSON.stringify(archive.manifest.parts);
  const recordsSha256 = await digest(encoder.encode(JSON.stringify(records)));
  const publishedAt = timestamp();
  const statements = [
    db.prepare(`INSERT INTO archive_correction_checkpoint_publications(
      publication_id,generation,archive_id,center_id,visit_id,month,timezone,
      base_publication_id,base_reference_json,starting_version,resulting_version,correction_count,
      correction_ids_json,member_digest,chain_depth,root_reference_json,header_json,header_sha256,
      manifest_object_key,manifest_sha256,part_descriptors_json,part_descriptors_sha256,records_sha256,published_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`).bind(
      handle.publicationId, build.generation, build.archive_id, build.center_id, build.visit_id,
      base.month, base.timezone, base.publication_id, base.root_reference_json,
      sources[0].expected_version, head.version, sources.length, JSON.stringify(correctionIds), memberDigest,
      JSON.stringify(reference), headerJson, await digest(encoder.encode(headerJson)),
      archive.objectKey, archive.sha256, descriptorsJson, await digest(encoder.encode(descriptorsJson)),
      recordsSha256, publishedAt,
    ),
    ...sources.map((source, index) => db.prepare(`INSERT INTO archive_correction_checkpoint_members(
      publication_id,ordinal,correction_id,expected_version,resulting_version,source_publication_id,source_manifest_sha256)
      VALUES(?,?,?,?,?,?,?)`).bind(
      handle.publicationId, index + 1, source.correction_id, source.expected_version,
      source.resulting_version, source.publication_id, source.manifest_sha256,
    )),
    db.prepare(`INSERT INTO archive_correction_checkpoint_availability(publication_id,generation,status,reconciliation_id)
      VALUES(?,?,'ready',NULL)`).bind(handle.publicationId, build.generation),
    db.prepare(`UPDATE archive_correction_checkpoint_builds
      SET state='published',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+0.001 seconds')
      WHERE publication_id=? AND generation=? AND state='pending' AND revision=?`).bind(
      handle.publicationId, build.generation, build.revision,
    ),
    db.prepare(`SELECT CASE WHEN EXISTS(
      SELECT 1 FROM archive_correction_checkpoint_builds
      WHERE publication_id=? AND state='published' AND revision=?
    ) THEN 1 ELSE json('ARCHIVE_CHECKPOINT_COMMIT_STALE') END AS committed`).bind(
      handle.publicationId, build.revision + 1,
    ),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const winner = await db.prepare(`SELECT p.*,a.generation AS availability_generation,
      a.status AS availability_status,h.generation AS runtime_generation,h.state AS runtime_state
      FROM archive_correction_checkpoint_publications p
      JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
      JOIN history_runtime h ON h.id=1 WHERE p.publication_id=?`)
      .bind(handle.publicationId).first<CorrectionCheckpointPublication & Record<string, unknown>>();
    if (!winner || winner.generation !== handle.generation
      || winner.availability_status !== 'ready'
      || winner.availability_generation !== winner.runtime_generation
      || winner.runtime_state !== 'ready') throw error;
    const evidence = await readCheckpointEvidence(db, storage, winner);
    return Object.freeze({
      handle,
      reference: evidence.reference,
      records: Object.freeze(evidence.records),
      replay: true,
    });
  }
  return Object.freeze({ handle, reference, records: Object.freeze(records), replay: false });
}

export async function readPublishedCorrectionCheckpoint<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  storage: CheckpointStorage,
  publicationId: string,
): Promise<Readonly<{ visit: ArchiveRecord; reference: ArchiveReference; generation: string }>> {
  if (!validId(publicationId)) fail('HANDLE_INVALID');
  const selection = await db.prepare(`SELECT p.*,a.generation AS availability_generation,a.status AS availability_status,
    a.reconciliation_id,h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_correction_checkpoint_publications p
    JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.publication_id=?`).bind(publicationId)
    .first<CorrectionCheckpointPublication & Record<string, unknown>>();
  if (!selection || selection.availability_status !== 'ready'
    || selection.availability_generation !== selection.runtime_generation
    || selection.runtime_state !== 'ready') fail('UNAVAILABLE');
  const authority = JSON.stringify(selection);
  const evidence = await readCheckpointEvidence(db, storage, selection);
  const fresh = await db.prepare(`SELECT p.*,a.generation AS availability_generation,a.status AS availability_status,
    a.reconciliation_id,h.generation AS runtime_generation,h.state AS runtime_state
    FROM archive_correction_checkpoint_publications p
    JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
    JOIN history_runtime h ON h.id=1
    WHERE p.publication_id=?`).bind(publicationId)
    .first<CorrectionCheckpointPublication & Record<string, unknown>>();
  if (JSON.stringify(fresh) !== authority) fail('AUTHORITY_CHANGED');
  return Object.freeze({ visit: evidence.visit, reference: evidence.reference, generation: String(selection.runtime_generation) });
}

export async function startCorrectionCheckpointReconciliation<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  publicationId: string,
  requestedReconciliationId: string = crypto.randomUUID(),
): Promise<CorrectionCheckpointReconciliationHandle> {
  if (!validId(publicationId) || !validId(requestedReconciliationId)) fail('HANDLE_INVALID');
  const replay = await db.prepare(`SELECT publication_id,execution_generation
    FROM archive_correction_checkpoint_reconciliation_jobs WHERE reconciliation_id=?`)
    .bind(requestedReconciliationId).first<{ publication_id: string; execution_generation: string }>();
  if (replay) {
    if (replay.publication_id !== publicationId) fail('HANDLE_INVALID');
    return Object.freeze({ reconciliationId: requestedReconciliationId, publicationId, generation: replay.execution_generation });
  }
  const publication = await db.prepare('SELECT * FROM archive_correction_checkpoint_publications WHERE publication_id=?')
    .bind(publicationId).first<CorrectionCheckpointPublication>();
  if (!publication) fail('PUBLICATION_NOT_FOUND');
  const members = (await db.prepare('SELECT * FROM archive_correction_checkpoint_members WHERE publication_id=? ORDER BY ordinal')
    .bind(publicationId).all<MemberRow>()).results;
  const generation = await db.prepare("SELECT generation FROM history_runtime WHERE id=1 AND state='ready'").first<string>('generation');
  if (!generation) fail('STALE');
  const existing = await db.prepare(`SELECT reconciliation_id FROM archive_correction_checkpoint_reconciliation_jobs
    WHERE publication_id=? AND execution_generation=? AND state IN ('pending','complete')
    ORDER BY created_at,reconciliation_id LIMIT 1`).bind(publicationId, generation).first<string>('reconciliation_id');
  if (existing) return Object.freeze({ reconciliationId: existing, publicationId, generation });
  const base = await baseForVisit(db, publication.visit_id);
  if (base.publication_id !== publication.base_publication_id
      || base.root_reference_json !== publication.base_reference_json
      || base.center_id !== publication.center_id || base.month !== publication.month
      || base.timezone !== publication.timezone || base.availability_generation !== generation) fail('BASE_CHANGED');
  const descriptor = descriptorJson(publication, members);
  const descriptorSha256 = await digest(encoder.encode(descriptor));
  const at = timestamp();
  await db.batch([
    db.prepare(`INSERT INTO archive_correction_checkpoint_reconciliation_jobs(
      reconciliation_id,publication_id,execution_generation,descriptor_json,descriptor_sha256,state,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',0,?,?)`).bind(
      requestedReconciliationId, publicationId, generation, descriptor, descriptorSha256, at, at,
    ),
    db.prepare(`UPDATE archive_correction_checkpoint_availability
      SET generation=?,status='unavailable',reconciliation_id=NULL WHERE publication_id=?`).bind(generation, publicationId),
  ]);
  return Object.freeze({ reconciliationId: requestedReconciliationId, publicationId, generation });
}

export async function reconcileCorrectionCheckpoint<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
  storage: CheckpointStorage,
  suppliedHandle: CorrectionCheckpointReconciliationHandle,
): Promise<Readonly<{ state: 'complete'; ready: boolean; replay: boolean }>> {
  const handle = Object.freeze({ ...suppliedHandle });
  if (!validId(handle.reconciliationId) || !validId(handle.publicationId) || !validId(handle.generation)) fail('HANDLE_INVALID');
  const job = await db.prepare('SELECT * FROM archive_correction_checkpoint_reconciliation_jobs WHERE reconciliation_id=?')
    .bind(handle.reconciliationId).first<ReconciliationJob>();
  if (!job || job.publication_id !== handle.publicationId || job.execution_generation !== handle.generation) fail('STALE');
  if (job.state === 'invalid') fail('STALE');
  if (job.state === 'complete') {
    const ready = await db.prepare(`SELECT count(*) AS n FROM archive_correction_checkpoint_availability
      WHERE publication_id=? AND generation=? AND status='ready' AND reconciliation_id=?`)
      .bind(handle.publicationId, handle.generation, handle.reconciliationId).first<number>('n');
    return Object.freeze({ state: 'complete', ready: ready === 1, replay: true });
  }
  try {
    const publication = await db.prepare('SELECT * FROM archive_correction_checkpoint_publications WHERE publication_id=?')
      .bind(handle.publicationId).first<CorrectionCheckpointPublication>();
    const members = (await db.prepare('SELECT * FROM archive_correction_checkpoint_members WHERE publication_id=? ORDER BY ordinal')
      .bind(handle.publicationId).all<MemberRow>()).results;
    if (!publication || descriptorJson(publication, members) !== job.descriptor_json
      || await digest(encoder.encode(job.descriptor_json)) !== job.descriptor_sha256) fail('DESCRIPTOR_INVALID');
    const evidence = await readCheckpointEvidence(db, storage, publication);
    const at = timestamp();
    try {
      await db.batch([
        db.prepare(`INSERT INTO archive_correction_checkpoint_reconciliation_receipts(
          reconciliation_id,publication_id,execution_generation,descriptor_json,descriptor_sha256,evidence_sha256,completed_at)
          VALUES(?,?,?,?,?,?,?)`).bind(
          handle.reconciliationId, handle.publicationId, handle.generation,
          job.descriptor_json, job.descriptor_sha256, evidence.evidenceSha256, at,
        ),
        db.prepare(`UPDATE archive_correction_checkpoint_reconciliation_jobs
          SET state='complete',revision=revision+1,updated_at=?
          WHERE reconciliation_id=? AND state='pending' AND revision=?`).bind(at, handle.reconciliationId, job.revision),
        db.prepare(`UPDATE archive_correction_checkpoint_availability
          SET generation=?,status='ready',reconciliation_id=? WHERE publication_id=?`).bind(
          handle.generation, handle.reconciliationId, handle.publicationId,
        ),
      ]);
    } catch (error) {
      const ready = await db.prepare(`SELECT count(*) AS n FROM archive_correction_checkpoint_availability
        WHERE publication_id=? AND generation=? AND status='ready' AND reconciliation_id=?`)
        .bind(handle.publicationId, handle.generation, handle.reconciliationId).first<number>('n');
      if (ready === 1) return Object.freeze({ state: 'complete', ready: true, replay: true });
      throw error;
    }
    return Object.freeze({ state: 'complete', ready: true, replay: false });
  } catch (error) {
    try {
      await db.prepare(`UPDATE archive_correction_checkpoint_reconciliation_jobs
        SET state='invalid',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+0.001 seconds')
        WHERE reconciliation_id=? AND state='pending' AND revision=?`).bind(handle.reconciliationId, job.revision).first();
    } catch { /* Preserve the authenticated error. */ }
    throw error;
  }
}

export async function nextCheckpointCandidate<S extends CheckpointStatement<S>>(
  db: CheckpointDatabase<S>,
): Promise<string | null> {
  return db.prepare(`SELECT p.visit_id
    FROM archive_correction_addendum_publications p
    JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    JOIN history_visit_heads v ON v.visit_id=p.visit_id AND v.version=p.resulting_version
    JOIN history_runtime h ON h.id=1 AND h.state='ready'
    WHERE p.chain_depth>=?
    AND a.status='ready' AND a.generation=h.generation
    AND (SELECT count(*) FROM archive_correction_addendum_publications source
      WHERE source.visit_id=p.visit_id) BETWEEN ? AND ?
    AND NOT EXISTS(
      SELECT 1 FROM archive_correction_addendum_publications source
      JOIN archive_correction_addendum_availability source_availability
        ON source_availability.publication_id=source.publication_id
      WHERE source.visit_id=p.visit_id
      AND (source_availability.status!='ready' OR source_availability.generation!=h.generation)
    )
    AND NOT EXISTS(SELECT 1 FROM archive_correction_checkpoint_builds b WHERE b.visit_id=p.visit_id AND b.state='pending')
    AND NOT EXISTS(SELECT 1 FROM archive_correction_checkpoint_publications c
      JOIN archive_correction_checkpoint_availability ca ON ca.publication_id=c.publication_id
      WHERE c.visit_id=p.visit_id AND c.resulting_version=v.version
      AND ca.status='ready' AND ca.generation=h.generation)
    ORDER BY p.published_at,p.publication_id LIMIT 1`)
    .bind(CHECKPOINT_THRESHOLD, CHECKPOINT_THRESHOLD, CHECKPOINT_MAX_CORRECTIONS).first<string>('visit_id');
}
