import type { Env } from './types';
import { validateBackupArchiveReferences } from './backup-crypto';

const ACTIVE_STATUSES = [
  'building_references',
  'listing',
  'refreshing_references',
  'classifying',
  'finalizing',
] as const;

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
type RunStatus = ActiveStatus | 'complete' | 'failed';
type Classification = 'pending' | 'referenced' | 'orphan_candidate' | 'protected' | 'unstable';

type Policy = {
  inventory_enabled: number;
  delete_enabled: number;
  minimum_age_seconds: number;
  minimum_confirmations: number;
  minimum_confirmation_interval_seconds: number;
  page_size: number;
};

type PolicySnapshot = {
  deleteEnabled: 0;
  minimumAgeSeconds: number;
  minimumConfirmations: number;
  minimumConfirmationIntervalSeconds: number;
  pageSize: number;
};

type InventoryRun = {
  id: string;
  generation: string;
  status: RunStatus;
  reference_pass: number;
  reference_source_index: number;
  reference_cursor: string;
  r2_cursor: string | null;
  classification_cursor: string | null;
  finalization_cursor: string | null;
  policy_snapshot_json: string;
  delete_enabled: number;
  refreshed_at: string | null;
  created_at: string;
};

type SourceRow = Record<string, unknown> & { sourceCursor: string; sourceKey: string };
type CapturedReference = {
  prefix: string;
  sourceTable: string;
  sourceKey: string;
  sourceKind: 'manifest' | 'archive_id' | 'backup_prefix' | 'backup_archive';
};

type ReferenceSource = {
  table: string;
  sql: string;
  decode: (row: SourceRow) => CapturedReference[];
};

type InventoryObject = {
  object_key: string;
  etag: string;
  version: string | null;
  size: number;
  uploaded_at: string;
  classification: Classification;
};

type Observation = {
  object_key: string;
  etag: string;
  version: string | null;
  size: number;
  uploaded_at: string;
  first_candidate_at: string | null;
  last_candidate_at: string | null;
  confirmation_count: number;
  status: 'candidate' | 'eligible' | 'referenced' | 'protected' | 'unstable';
  generation: string;
  last_run_id: string;
};

export type ObjectAuthority =
  | { namespace: 'archives'; prefix: string; archiveId: string; tokens: string[] }
  | { namespace: 'backups'; prefix: string; backupId: string; tokens: string[] }
  | { namespace: 'protected'; prefix: null; tokens: [] };

const identifier = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error('REFERENCE_IDENTIFIER_INVALID');
  }
  return value;
};

export function archivePrefixFromManifestKey(key: string): string {
  if (key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('REFERENCE_KEY_INVALID');
  const parts = key.split('/');
  if (parts.length < 5 || parts[0] !== 'archives') throw new Error('REFERENCE_KEY_INVALID');
  try {
    identifier(parts[1]);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(parts[2])) throw new Error('REFERENCE_KEY_INVALID');
    identifier(parts[3]);
    if (parts.slice(4).some(part => !part || part === '.' || part === '..')) throw new Error('REFERENCE_KEY_INVALID');
  } catch {
    throw new Error('REFERENCE_KEY_INVALID');
  }
  return `archives/${parts[1]}/${parts[2]}/${parts[3]}/`;
}

export function authorityForObjectKey(key: string): ObjectAuthority {
  if (key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) return { namespace: 'protected', prefix: null, tokens: [] };
  const parts = key.split('/');
  if (parts[0] === 'archives') {
    try {
      if (parts.length < 5) throw new Error('OBJECT_KEY_INVALID');
      identifier(parts[1]);
      if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(parts[2])) throw new Error('OBJECT_KEY_INVALID');
      const archiveId = identifier(parts[3]);
      if (parts.slice(4).some(part => !part || part === '.' || part === '..')) throw new Error('OBJECT_KEY_INVALID');
      const prefix = `archives/${parts[1]}/${parts[2]}/${archiveId}/`;
      return { namespace: 'archives', prefix, archiveId, tokens: [prefix, `archive-id:${archiveId}`] };
    } catch {
      return { namespace: 'protected', prefix: null, tokens: [] };
    }
  }
  if (parts[0] === 'backups') {
    try {
      if (parts.length < 3) throw new Error('OBJECT_KEY_INVALID');
      const backupId = identifier(parts[1]);
      if (parts.slice(2).some(part => !part || part === '.' || part === '..')) throw new Error('OBJECT_KEY_INVALID');
      const prefix = `backups/${backupId}/`;
      return { namespace: 'backups', prefix, backupId, tokens: [prefix] };
    } catch {
      return { namespace: 'protected', prefix: null, tokens: [] };
    }
  }
  return { namespace: 'protected', prefix: null, tokens: [] };
}

function referenceFromJson(raw: unknown, sourceTable: string, sourceKey: string, kind: CapturedReference['sourceKind'] = 'manifest'): CapturedReference {
  if (typeof raw !== 'string') throw new Error('REFERENCE_CATALOG_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('REFERENCE_CATALOG_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('REFERENCE_CATALOG_INVALID');
  const key = (parsed as { manifestObjectKey?: unknown }).manifestObjectKey;
  if (typeof key !== 'string') throw new Error('REFERENCE_CATALOG_INVALID');
  return { prefix: archivePrefixFromManifestKey(key), sourceTable, sourceKey, sourceKind: kind };
}

function directManifest(raw: unknown, sourceTable: string, sourceKey: string, kind: CapturedReference['sourceKind'] = 'manifest'): CapturedReference {
  if (typeof raw !== 'string') throw new Error('REFERENCE_CATALOG_INVALID');
  return { prefix: archivePrefixFromManifestKey(raw), sourceTable, sourceKey, sourceKind: kind };
}

function archiveIdReference(raw: unknown, sourceTable: string, sourceKey: string): CapturedReference {
  if (typeof raw !== 'string') throw new Error('REFERENCE_CATALOG_INVALID');
  return { prefix: `archive-id:${identifier(raw)}`, sourceTable, sourceKey, sourceKind: 'archive_id' };
}

const keyCursor = (column: string): string => `CAST(${column} AS TEXT)`;

const directSource = (
  table: string,
  keyColumn: string,
  valueColumn: string,
  where = `${valueColumn} IS NOT NULL`,
  cursorExpression = keyCursor(keyColumn),
): ReferenceSource => ({
  table,
  sql: `SELECT ${cursorExpression} AS sourceCursor, ${keyColumn} AS sourceKey, ${valueColumn} AS value FROM ${table}
    WHERE ${cursorExpression}>? AND ${where} ORDER BY ${cursorExpression} LIMIT ?`,
  decode: row => [directManifest(row.value, table, String(row.sourceKey))],
});

const jsonSource = (
  table: string,
  keyColumn: string,
  valueColumn: string,
  where = `${valueColumn} IS NOT NULL`,
  cursorExpression = keyCursor(keyColumn),
): ReferenceSource => ({
  table,
  sql: `SELECT ${cursorExpression} AS sourceCursor, ${keyColumn} AS sourceKey, ${valueColumn} AS value FROM ${table}
    WHERE ${cursorExpression}>? AND ${where} ORDER BY ${cursorExpression} LIMIT ?`,
  decode: row => [referenceFromJson(row.value, table, String(row.sourceKey))],
});

const archiveIdSource = (
  table: string,
  keyColumn: string,
  archiveIdColumn: string,
  where = `${archiveIdColumn} IS NOT NULL`,
  cursorExpression = keyCursor(keyColumn),
): ReferenceSource => ({
  table,
  sql: `SELECT ${cursorExpression} AS sourceCursor, ${keyColumn} AS sourceKey, ${archiveIdColumn} AS value FROM ${table}
    WHERE ${cursorExpression}>? AND ${where} ORDER BY ${cursorExpression} LIMIT ?`,
  decode: row => [archiveIdReference(row.value, table, String(row.sourceKey))],
});

const backupSource: ReferenceSource = {
  table: 'backup_jobs',
  sql: `SELECT CAST(id AS TEXT) AS sourceCursor,id AS sourceKey,storage_provider,archives_json
    FROM backup_jobs WHERE CAST(id AS TEXT)>? AND status<>'failed' ORDER BY CAST(id AS TEXT) LIMIT ?`,
  decode(row) {
    const references: CapturedReference[] = [];
    const jobId = identifier(String(row.sourceKey));
    if (row.storage_provider === 'r2') {
      references.push({ prefix: `backups/${jobId}/`, sourceTable: 'backup_jobs', sourceKey: jobId, sourceKind: 'backup_prefix' });
    } else if (row.storage_provider !== 'google-drive') {
      throw new Error('REFERENCE_CATALOG_INVALID');
    }
    if (row.archives_json !== null && row.archives_json !== undefined) {
      if (typeof row.archives_json !== 'string') throw new Error('REFERENCE_CATALOG_INVALID');
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.archives_json);
      } catch {
        throw new Error('REFERENCE_CATALOG_INVALID');
      }
      validateBackupArchiveReferences(parsed);
      for (let index = 0; index < parsed.length; index += 1) {
        references.push(directManifest(parsed[index].manifestObjectKey, 'backup_jobs.archives_json', `${jobId}:${index}`, 'backup_archive'));
      }
    }
    return references;
  },
};

const REFERENCE_SOURCES: ReferenceSource[] = [
  archiveIdSource('archive_jobs', 'id', 'id', "status IN ('parts','verify','complete')"),
  directSource('archive_jobs', 'id', 'manifest_key', "manifest_key IS NOT NULL AND status IN ('parts','verify','complete')"),
  archiveIdSource('archive_publication_builds', 'publication_id', 'archive_id', "state IN ('building','published')"),
  jsonSource('archive_publication_builds', 'publication_id', 'root_reference_json', "state IN ('building','published')"),
  directSource('archive_publications', 'publication_id', 'manifest_object_key'),
  jsonSource('archive_compact_builds', 'publication_id', 'root_reference_json', "state IN ('building','published')"),
  jsonSource('archive_compact_publications', 'publication_id', 'root_reference_json'),
  archiveIdSource('archive_correction_addendum_builds', 'publication_id', 'archive_id', "state IN ('pending','published')"),
  directSource('archive_correction_addendum_publications', 'publication_id', 'manifest_object_key'),
  jsonSource('archive_correction_addendum_publications', 'publication_id', 'parent_reference_json'),
  jsonSource('archive_correction_addendum_publications', 'publication_id', 'root_reference_json'),
  archiveIdSource('archive_correction_checkpoint_builds', 'publication_id', 'archive_id', "state IN ('pending','published')"),
  directSource('archive_correction_checkpoint_publications', 'publication_id', 'manifest_object_key'),
  jsonSource('archive_correction_checkpoint_publications', 'publication_id', 'base_reference_json'),
  jsonSource('archive_correction_checkpoint_publications', 'publication_id', 'root_reference_json'),
  jsonSource(
    'archive_semantic_sessions',
    "json_array(verification_id,generation)",
    'root_reference_json',
    "status IN ('staging','frozen','verified')",
    "json_array(verification_id,generation)",
  ),
  backupSource,
];

function policySnapshot(policy: Policy): PolicySnapshot {
  if (policy.inventory_enabled !== 1 || policy.delete_enabled !== 0) throw new Error('R2_INVENTORY_POLICY_DISABLED');
  if (!Number.isInteger(policy.page_size) || policy.page_size < 1 || policy.page_size > 250) throw new Error('R2_INVENTORY_POLICY_INVALID');
  if (!Number.isInteger(policy.minimum_age_seconds) || policy.minimum_age_seconds < 86400) throw new Error('R2_INVENTORY_POLICY_INVALID');
  if (!Number.isInteger(policy.minimum_confirmations) || policy.minimum_confirmations < 2) throw new Error('R2_INVENTORY_POLICY_INVALID');
  if (!Number.isInteger(policy.minimum_confirmation_interval_seconds) || policy.minimum_confirmation_interval_seconds < 3600) throw new Error('R2_INVENTORY_POLICY_INVALID');
  return {
    deleteEnabled: 0,
    minimumAgeSeconds: policy.minimum_age_seconds,
    minimumConfirmations: policy.minimum_confirmations,
    minimumConfirmationIntervalSeconds: policy.minimum_confirmation_interval_seconds,
    pageSize: policy.page_size,
  };
}

function parsePolicySnapshot(raw: string): PolicySnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('R2_INVENTORY_POLICY_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('R2_INVENTORY_POLICY_INVALID');
  const candidate = value as Partial<PolicySnapshot>;
  const policy: Policy = {
    inventory_enabled: 1,
    delete_enabled: candidate.deleteEnabled ?? -1,
    minimum_age_seconds: candidate.minimumAgeSeconds ?? 0,
    minimum_confirmations: candidate.minimumConfirmations ?? 0,
    minimum_confirmation_interval_seconds: candidate.minimumConfirmationIntervalSeconds ?? 0,
    page_size: candidate.pageSize ?? 0,
  };
  return policySnapshot(policy);
}

const nowIso = (now?: Date): string => (now ?? new Date()).toISOString();

async function currentGeneration(db: D1Database): Promise<string> {
  const runtime = await db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<{ generation: string }>();
  if (!runtime?.generation) throw new Error('HISTORY_RUNTIME_MISSING');
  return runtime.generation;
}

async function loadRun(db: D1Database, runId?: string): Promise<InventoryRun | null> {
  if (runId) return db.prepare('SELECT * FROM r2_orphan_inventory_runs WHERE id=?').bind(runId).first<InventoryRun>();
  return db.prepare("SELECT * FROM r2_orphan_inventory_runs WHERE active_slot=1 AND status NOT IN ('complete','failed')").first<InventoryRun>();
}

async function assertRunGeneration(db: D1Database, run: InventoryRun): Promise<void> {
  if (run.delete_enabled !== 0) throw new Error('R2_DELETE_MUST_REMAIN_DISABLED');
  if (await currentGeneration(db) !== run.generation) throw new Error('R2_INVENTORY_GENERATION_CHANGED');
}

async function batchInChunks(db: D1Database, statements: D1PreparedStatement[], size = 50): Promise<void> {
  for (let index = 0; index < statements.length; index += size) await db.batch(statements.slice(index, index + size));
}

function chunks<T>(values: readonly T[], size = 80): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z0-9_]{3,80}$/.test(message) ? message : 'R2_INVENTORY_FAILED';
}

async function failRun(db: D1Database, runId: string, error: unknown, now: string): Promise<void> {
  await db.prepare("UPDATE r2_orphan_inventory_runs SET status='failed',active_slot=NULL,error_code=?,completed_at=?,updated_at=? WHERE id=? AND status NOT IN ('complete','failed')")
    .bind(errorCode(error), now, now, runId).run();
}

export async function startR2OrphanInventory(env: Env, at?: Date): Promise<string> {
  if (!env.BACKUP_BUCKET) throw new Error('CONFIG_BACKUP_BUCKET');
  const now = nowIso(at);
  const policy = await env.CRM_DB.prepare('SELECT * FROM r2_orphan_inventory_policy WHERE id=1').first<Policy>();
  if (!policy) throw new Error('R2_INVENTORY_POLICY_MISSING');
  const snapshot = policySnapshot(policy);
  const active = await loadRun(env.CRM_DB);
  if (active) return active.id;
  const generation = await currentGeneration(env.CRM_DB);
  const id = `r2scan_${crypto.randomUUID()}`;
  try {
    await env.CRM_DB.prepare(`INSERT INTO r2_orphan_inventory_runs(
      id,active_slot,generation,status,reference_pass,reference_source_index,reference_cursor,
      policy_snapshot_json,delete_enabled,created_at,updated_at
    ) VALUES(?,1,?,'building_references',1,0,'',?,0,?,?)`)
      .bind(id, generation, JSON.stringify(snapshot), now, now).run();
    return id;
  } catch (error) {
    const winner = await loadRun(env.CRM_DB);
    if (winner) return winner.id;
    throw error;
  }
}

async function captureReferences(env: Env, run: InventoryRun, policy: PolicySnapshot, now: string): Promise<void> {
  let sourceIndex = run.reference_source_index;
  let cursor = run.reference_cursor;
  while (sourceIndex < REFERENCE_SOURCES.length) {
    const source = REFERENCE_SOURCES[sourceIndex];
    const result = await env.CRM_DB.prepare(source.sql).bind(cursor, policy.pageSize).all<SourceRow>();
    if (result.results.length === 0) {
      sourceIndex += 1;
      cursor = '';
      continue;
    }
    const byPrefix = new Map<string, CapturedReference>();
    let finalCursor = cursor;
    for (const row of result.results) {
      if (typeof row.sourceCursor !== 'string' || row.sourceCursor <= cursor || row.sourceCursor.length > 1024) {
        throw new Error('REFERENCE_CURSOR_INVALID');
      }
      finalCursor = row.sourceCursor;
      for (const reference of source.decode(row)) if (!byPrefix.has(reference.prefix)) byPrefix.set(reference.prefix, reference);
    }
    const statements = [...byPrefix.values()].map(reference => env.CRM_DB.prepare(`INSERT OR IGNORE INTO r2_orphan_inventory_references(
      run_id,reference_prefix,source_table,source_key,source_kind,captured_at
    ) VALUES(?,?,?,?,?,?)`).bind(run.id, reference.prefix, reference.sourceTable, reference.sourceKey, reference.sourceKind, now));
    await batchInChunks(env.CRM_DB, statements);
    await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET reference_source_index=?,reference_cursor=?,updated_at=?
      WHERE id=? AND status=? AND generation=?`)
      .bind(sourceIndex, finalCursor, now, run.id, run.status, run.generation).run();
    return;
  }

  if (run.status === 'building_references') {
    await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET status='listing',reference_source_index=0,reference_cursor='',
      reference_completed_at=?,updated_at=? WHERE id=? AND status='building_references' AND generation=?`)
      .bind(now, now, run.id, run.generation).run();
  } else {
    await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET status='classifying',reference_source_index=0,reference_cursor='',
      refreshed_at=?,classification_cursor=NULL,updated_at=? WHERE id=? AND status='refreshing_references' AND generation=?`)
      .bind(now, now, run.id, run.generation).run();
  }
}

async function listObjects(env: Env, run: InventoryRun, policy: PolicySnapshot, now: string): Promise<void> {
  const bucket = env.BACKUP_BUCKET;
  if (!bucket) throw new Error('CONFIG_BACKUP_BUCKET');
  const page = await bucket.list({ cursor: run.r2_cursor ?? undefined, limit: policy.pageSize });
  const statements = page.objects.map(object => env.CRM_DB.prepare(`INSERT INTO r2_orphan_inventory_objects(
    run_id,object_key,etag,version,size,uploaded_at,classification,observed_at
  ) VALUES(?,?,?,?,?,?,'pending',?)
  ON CONFLICT(run_id,object_key) DO UPDATE SET
    classification=CASE WHEN etag=excluded.etag AND size=excluded.size AND uploaded_at=excluded.uploaded_at
      AND coalesce(version,'')=coalesce(excluded.version,'') THEN classification ELSE 'unstable' END`)
    .bind(run.id, object.key, object.etag, object.version ?? null, object.size, object.uploaded.toISOString(), now));
  await batchInChunks(env.CRM_DB, statements);
  if (page.truncated) {
    if (!page.cursor || page.cursor === run.r2_cursor) throw new Error('R2_LIST_CURSOR_INVALID');
    await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET r2_cursor=?,listed_count=listed_count+?,updated_at=?
      WHERE id=? AND status='listing' AND generation=?`)
      .bind(page.cursor, page.objects.length, now, run.id, run.generation).run();
    return;
  }
  await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET status='refreshing_references',reference_pass=2,
    reference_source_index=0,reference_cursor='',r2_cursor=NULL,listed_count=listed_count+?,listing_completed_at=?,updated_at=?
    WHERE id=? AND status='listing' AND generation=?`)
    .bind(page.objects.length, now, now, run.id, run.generation).run();
}

async function classifyObjects(env: Env, run: InventoryRun, policy: PolicySnapshot, now: string): Promise<void> {
  const cursor = run.classification_cursor ?? '';
  const page = await env.CRM_DB.prepare(`SELECT object_key,classification FROM r2_orphan_inventory_objects
    WHERE run_id=? AND object_key>? ORDER BY object_key LIMIT ?`)
    .bind(run.id, cursor, policy.pageSize).all<{ object_key: string; classification: Classification }>();
  if (page.results.length === 0) {
    await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET status='finalizing',finalization_cursor=NULL,updated_at=?
      WHERE id=? AND status='classifying' AND generation=?`).bind(now, run.id, run.generation).run();
    return;
  }
  if (page.results.some(row => row.classification === 'unstable')) throw new Error('R2_OBJECT_CHANGED_DURING_SCAN');
  const authorities = page.results.map(row => ({ row, authority: authorityForObjectKey(row.object_key) }));
  const tokens = [...new Set(authorities.flatMap(item => item.authority.tokens))];
  const referenceByToken = new Map<string, { source_table: string }>();
  for (const tokenPage of chunks(tokens)) {
    const placeholders = tokenPage.map(() => '?').join(',');
    const references = await env.CRM_DB.prepare(`SELECT reference_prefix,source_table FROM r2_orphan_inventory_references
      WHERE run_id=? AND reference_prefix IN (${placeholders})`).bind(run.id, ...tokenPage).all<{ reference_prefix: string; source_table: string }>();
    for (const reference of references.results) if (!referenceByToken.has(reference.reference_prefix)) referenceByToken.set(reference.reference_prefix, reference);
  }
  const statements = authorities.map(({ row, authority }) => {
    if (authority.namespace === 'protected') {
      return env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_objects SET classification='protected',matched_reference_prefix=NULL,
        matched_source_table=NULL WHERE run_id=? AND object_key=? AND classification='pending'`).bind(run.id, row.object_key);
    }
    const matched = authority.tokens.map(token => ({ token, reference: referenceByToken.get(token) })).find(item => item.reference);
    if (matched?.reference) {
      return env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_objects SET classification='referenced',matched_reference_prefix=?,
        matched_source_table=? WHERE run_id=? AND object_key=? AND classification='pending'`)
        .bind(matched.token, matched.reference.source_table, run.id, row.object_key);
    }
    return env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_objects SET classification='orphan_candidate',matched_reference_prefix=NULL,
      matched_source_table=NULL WHERE run_id=? AND object_key=? AND classification='pending'`).bind(run.id, row.object_key);
  });
  await batchInChunks(env.CRM_DB, statements);
  await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET classification_cursor=?,updated_at=?
    WHERE id=? AND status='classifying' AND generation=?`)
    .bind(page.results.at(-1)!.object_key, now, run.id, run.generation).run();
}

export function nextObservation(
  object: InventoryObject,
  previous: Observation | undefined,
  run: Pick<InventoryRun, 'id' | 'generation'>,
  policy: PolicySnapshot,
  now: Date,
): { status: Observation['status']; firstCandidateAt: string | null; lastCandidateAt: string | null; confirmations: number; eligible: boolean } {
  if (object.classification !== 'orphan_candidate') {
    const status = object.classification === 'unstable' ? 'unstable' : object.classification === 'referenced' ? 'referenced' : 'protected';
    return { status, firstCandidateAt: null, lastCandidateAt: null, confirmations: 0, eligible: false };
  }
  const nowValue = now.getTime();
  const sameObject = previous && previous.generation === run.generation && previous.etag === object.etag && previous.size === object.size
    && previous.uploaded_at === object.uploaded_at && (previous.version ?? '') === (object.version ?? '')
    && (previous.status === 'candidate' || previous.status === 'eligible');
  let firstCandidateAt = sameObject ? previous.first_candidate_at : now.toISOString();
  let lastCandidateAt = sameObject ? previous.last_candidate_at : now.toISOString();
  let confirmations = sameObject ? previous.confirmation_count : 1;
  if (sameObject && previous.last_candidate_at) {
    const interval = nowValue - Date.parse(previous.last_candidate_at);
    if (Number.isFinite(interval) && interval >= policy.minimumConfirmationIntervalSeconds * 1000 && previous.last_run_id !== run.id) {
      confirmations += 1;
      lastCandidateAt = now.toISOString();
    }
  }
  if (!firstCandidateAt) firstCandidateAt = now.toISOString();
  if (!lastCandidateAt) lastCandidateAt = now.toISOString();
  const age = nowValue - Date.parse(object.uploaded_at);
  const span = nowValue - Date.parse(firstCandidateAt);
  const eligible = confirmations >= policy.minimumConfirmations
    && Number.isFinite(age) && age >= policy.minimumAgeSeconds * 1000
    && Number.isFinite(span) && span >= policy.minimumConfirmationIntervalSeconds * 1000;
  return { status: eligible ? 'eligible' : 'candidate', firstCandidateAt, lastCandidateAt, confirmations, eligible };
}

async function finalizeObjects(env: Env, run: InventoryRun, policy: PolicySnapshot, nowText: string): Promise<void> {
  if (!run.refreshed_at) throw new Error('R2_REFERENCE_REFRESH_INCOMPLETE');
  const cursor = run.finalization_cursor ?? '';
  const page = await env.CRM_DB.prepare(`SELECT object_key,etag,version,size,uploaded_at,classification
    FROM r2_orphan_inventory_objects WHERE run_id=? AND object_key>? ORDER BY object_key LIMIT ?`)
    .bind(run.id, cursor, policy.pageSize).all<InventoryObject>();
  if (page.results.length === 0) {
    await assertRunGeneration(env.CRM_DB, run);
    const counts = await env.CRM_DB.prepare(`SELECT classification,count(*) AS count FROM r2_orphan_inventory_objects
      WHERE run_id=? GROUP BY classification`).bind(run.id).all<{ classification: Classification; count: number }>();
    const values = new Map(counts.results.map(row => [row.classification, Number(row.count)]));
    const eligible = await env.CRM_DB.prepare("SELECT count(*) AS count FROM r2_orphan_cleanup_plans WHERE run_id=? AND status='dry_run_blocked'")
      .bind(run.id).first<{ count: number }>();
    await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET status='complete',active_slot=NULL,completed_at=?,updated_at=?,
      referenced_count=?,orphan_candidate_count=?,protected_count=?,eligible_count=?,error_code=NULL
      WHERE id=? AND status='finalizing' AND generation=? AND delete_enabled=0`)
      .bind(nowText, nowText, values.get('referenced') ?? 0, values.get('orphan_candidate') ?? 0,
        values.get('protected') ?? 0, Number(eligible?.count ?? 0), run.id, run.generation).run();
    return;
  }
  if (page.results.some(row => row.classification === 'pending' || row.classification === 'unstable')) {
    throw new Error(page.results.some(row => row.classification === 'unstable') ? 'R2_OBJECT_CHANGED_DURING_SCAN' : 'R2_CLASSIFICATION_INCOMPLETE');
  }
  const keys = page.results.map(row => row.object_key);
  const previousByKey = new Map<string, Observation>();
  for (const keyPage of chunks(keys)) {
    const placeholders = keyPage.map(() => '?').join(',');
    const previousRows = await env.CRM_DB.prepare(`SELECT * FROM r2_orphan_observations WHERE object_key IN (${placeholders})`)
      .bind(...keyPage).all<Observation>();
    for (const row of previousRows.results) previousByKey.set(row.object_key, row);
  }
  const now = new Date(nowText);
  const statements: D1PreparedStatement[] = [];
  for (const object of page.results) {
    const next = nextObservation(object, previousByKey.get(object.object_key), run, policy, now);
    statements.push(env.CRM_DB.prepare(`INSERT INTO r2_orphan_observations(
      object_key,etag,version,size,uploaded_at,first_candidate_at,last_candidate_at,confirmation_count,status,generation,last_run_id,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(object_key) DO UPDATE SET etag=excluded.etag,version=excluded.version,size=excluded.size,
      uploaded_at=excluded.uploaded_at,first_candidate_at=excluded.first_candidate_at,last_candidate_at=excluded.last_candidate_at,
      confirmation_count=excluded.confirmation_count,status=excluded.status,generation=excluded.generation,
      last_run_id=excluded.last_run_id,updated_at=excluded.updated_at`)
      .bind(object.object_key, object.etag, object.version, object.size, object.uploaded_at, next.firstCandidateAt,
        next.lastCandidateAt, next.confirmations, next.status, run.generation, run.id, nowText));
    if (next.eligible) {
      const evidence = JSON.stringify({
        version: 1,
        runId: run.id,
        generation: run.generation,
        objectKey: object.object_key,
        etag: object.etag,
        objectVersion: object.version,
        size: object.size,
        uploadedAt: object.uploaded_at,
        confirmations: next.confirmations,
        firstCandidateAt: next.firstCandidateAt,
        lastCandidateAt: next.lastCandidateAt,
        referenceRefreshCompletedAt: run.refreshed_at,
        deleteEnabled: false,
      });
      const evidenceSha = await sha256Hex(evidence);
      const planId = `r2plan_${evidenceSha.slice(0, 40)}`;
      statements.push(env.CRM_DB.prepare(`INSERT OR IGNORE INTO r2_orphan_cleanup_plans(
        id,run_id,object_key,etag,version,size,uploaded_at,generation,confirmation_count,evidence_json,evidence_sha256,
        delete_enabled,status,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'dry_run_blocked',?)`)
        .bind(planId, run.id, object.object_key, object.etag, object.version, object.size, object.uploaded_at,
          run.generation, next.confirmations, evidence, evidenceSha, nowText));
    }
  }
  await batchInChunks(env.CRM_DB, statements);
  await env.CRM_DB.prepare(`UPDATE r2_orphan_inventory_runs SET finalization_cursor=?,updated_at=?
    WHERE id=? AND status='finalizing' AND generation=?`)
    .bind(page.results.at(-1)!.object_key, nowText, run.id, run.generation).run();
}

export async function advanceR2OrphanInventory(env: Env, runId?: string, at?: Date): Promise<RunStatus | null> {
  const run = await loadRun(env.CRM_DB, runId);
  if (!run || run.status === 'complete' || run.status === 'failed') return run?.status ?? null;
  const now = nowIso(at);
  try {
    if (!env.BACKUP_BUCKET) throw new Error('CONFIG_BACKUP_BUCKET');
    await assertRunGeneration(env.CRM_DB, run);
    const policy = parsePolicySnapshot(run.policy_snapshot_json);
    if (run.status === 'building_references' || run.status === 'refreshing_references') await captureReferences(env, run, policy, now);
    else if (run.status === 'listing') await listObjects(env, run, policy, now);
    else if (run.status === 'classifying') await classifyObjects(env, run, policy, now);
    else if (run.status === 'finalizing') await finalizeObjects(env, run, policy, now);
  } catch (error) {
    await failRun(env.CRM_DB, run.id, error, now);
    return 'failed';
  }
  return (await loadRun(env.CRM_DB, run.id))?.status ?? null;
}

export async function maintainR2OrphanInventory(env: Env): Promise<void> {
  const run = await loadRun(env.CRM_DB);
  if (run) await advanceR2OrphanInventory(env, run.id);
}

export async function getR2OrphanInventoryStatus(env: Env): Promise<Record<string, unknown>> {
  const [policy, latest, plans] = await Promise.all([
    env.CRM_DB.prepare('SELECT * FROM r2_orphan_inventory_policy WHERE id=1').first(),
    env.CRM_DB.prepare('SELECT * FROM r2_orphan_inventory_runs ORDER BY created_at DESC LIMIT 1').first(),
    env.CRM_DB.prepare(`SELECT count(*) AS count FROM r2_orphan_cleanup_plans
      WHERE run_id=(SELECT id FROM r2_orphan_inventory_runs ORDER BY created_at DESC LIMIT 1)
        AND status='dry_run_blocked' AND delete_enabled=0`).first<{ count: number }>(),
  ]);
  return { policy, latestRun: latest, dryRunBlockedPlans: Number(plans?.count ?? 0) };
}
