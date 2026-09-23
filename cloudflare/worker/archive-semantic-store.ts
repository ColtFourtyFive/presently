import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS as LIMIT, ARCHIVE_TABLES, type ArchiveManifest, type ArchiveRecord, type ArchiveReference, type ArchiveSemanticQuery, type ArchiveSemanticStore, type ArchiveTable } from '../shared/archive-format';
import { openArchiveManifest, verifyArchivePart } from './archive-codec';
import { verifyArchiveSemantics } from './archive-semantics';
import { digest } from './backup-crypto';
import { assertArchiveStagingSize, assertArchiveStagingWork, type ArchiveStagingResult } from './archive-staging-admission';
import { ARCHIVE_STAGING_CLEANUP_LEASE_SECONDS, archiveCleanupReceiptIdentity, claimArchiveStagingCleanup, encodeArchiveControlJson } from './archive-staging-controls';

/** Worker D1 and independent native-D1 recovery transports share this contract.
 * No live application records are read by this module. */
export type ArchiveStagingStatement<S> = { bind(...values: unknown[]): S };
export type ArchiveStagingDatabase<S extends ArchiveStagingStatement<S>> = {
  prepare(sql: string): S;
  /** Must use the primary database and retain native size_after metadata. */
  batch<T = Record<string, unknown>>(statements: S[]): Promise<ArchiveStagingResult<T>[]>;
};
type SessionRow = { verification_id: string; generation: string; root_reference_json: string; status: 'staging' | 'frozen' | 'verified' | 'invalid'; commit_token: string | null; graph_sha256: string | null };
type ManifestRow = { archive_id: string; manifest_sha256: string; manifest_json: string };
type PartRow = { descriptor_json: string; descriptor_sha256: string; rowset_sha256: string; commit_token: string };
export type ArchiveSemanticHandle = { verificationId: string; generation: string };
export type ArchiveSemanticCleanup = ArchiveSemanticHandle & { cleanupGeneration: string; cleanupToken: string };
export type FrozenBaseIdentity = ArchiveSemanticHandle & { commitToken: string; graphSha256: string };
export type ArchiveSemanticHeader = Omit<ArchiveManifest, 'parts'>;
export type ArchiveSemanticSnapshot = { commitToken: string; graphSha256: string; manifests: readonly ArchiveManifest[]; semanticStore: ArchiveSemanticStore };
export type ArchiveSemanticLookupReference = { archiveId: string; table: ArchiveTable; key: string };
export type ArchiveSemanticBatchStore = ArchiveSemanticStore & {
  /** At most twelve point lookups in one native batch, in input order. */
  getMany(references: readonly ArchiveSemanticLookupReference[]): Promise<readonly (ArchiveRecord | null)[]>;
};
const encoder = new TextEncoder();
const states = "('staging','frozen','verified')";
const identifier = /^[A-Za-z0-9_-]{1,100}$/;
const hashPattern = /^[a-f0-9]{64}$/;
function error(code: string): never { throw new Error(`ARCHIVE_STAGING_${code}`); }
const hashJson = (value: unknown) => digest(encoder.encode(JSON.stringify(value)));
function reference(value: ArchiveReference): ArchiveReference {
  if (!value || !identifier.test(value.archiveId) || !hashPattern.test(value.manifestSha256) || !['monthly', 'addendum'].includes(value.kind) || typeof value.manifestObjectKey !== 'string' || value.manifestObjectKey.length > 1024) error('REFERENCE_INVALID');
  return { archiveId: value.archiveId, kind: value.kind, manifestObjectKey: value.manifestObjectKey, manifestSha256: value.manifestSha256 };
}
function table(value: ArchiveTable) { if (!(ARCHIVE_TABLES as readonly string[]).includes(value)) error('TABLE_INVALID'); }

/** Private staging only. Plaintext plus a caller authentication flag is never
 * accepted. Encrypted envelopes are authenticated inside this adapter.
 * finalize runs the full verifier: bounded paging is not proof of one-invocation
 * Worker CPU/subrequest compliance. This module has no publication authority. */
export class D1ArchiveSemanticStaging<S extends ArchiveStagingStatement<S> = D1PreparedStatement> {
  private constructor(private readonly db: ArchiveStagingDatabase<S>, private readonly master: string, readonly handle: Readonly<ArchiveSemanticHandle>, private readonly root: ArchiveReference) {}

  static async create<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, master: string, expectedRoot: ArchiveReference, verificationId: string = crypto.randomUUID()): Promise<D1ArchiveSemanticStaging<S>> {
    if (!identifier.test(verificationId)) error('ID_INVALID');
    const root = reference(expectedRoot);
    if (root.kind !== 'monthly') error('ADMISSION_LIMIT');
    const observation = await db.batch([db.prepare('SELECT generation FROM history_runtime WHERE id=1')]);
    assertArchiveStagingSize(observation[0], true);
    const generation = observation[0].results[0]?.generation;
    if (typeof generation !== 'string') error('RUNTIME_MISSING');
    const result = await db.batch([
      db.prepare(`INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at)
        SELECT ?,generation,?,?,?,'staging',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM history_runtime WHERE id=1 AND generation=?`).bind(verificationId, root.archiveId, root.manifestSha256, JSON.stringify(root), generation),
      db.prepare('SELECT generation FROM archive_semantic_sessions WHERE verification_id=? AND generation=?').bind(verificationId, generation),
    ]);
    const runtime = result[1].results[0] as { generation: string } | undefined;
    if (!runtime) error('STALE');
    return new D1ArchiveSemanticStaging(db, master, Object.freeze({ verificationId, generation: runtime.generation }), root);
  }

  /** Resume retains the captured generation; restoration must never relabel it. */
  static async resume<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, master: string, handle: ArchiveSemanticHandle): Promise<D1ArchiveSemanticStaging<S>> {
    if (!identifier.test(handle.verificationId) || !identifier.test(handle.generation)) error('HANDLE_INVALID');
    const result = await db.batch<SessionRow>([db.prepare(`SELECT s.* FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
      WHERE s.verification_id=? AND s.generation=? AND s.status IN ${states}`).bind(handle.verificationId, handle.generation)]);
    const session = result[0].results[0];
    if (!session) error('STALE');
    return new D1ArchiveSemanticStaging(db, master, Object.freeze({ ...handle }), reference(JSON.parse(session.root_reference_json)));
  }

  /** Opens only one already frozen monthly base. No key, R2 read, descriptor
   * scan or whole-graph verifier is needed for a resumable semantic step. */
  static async openFrozenBaseSnapshot<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, identity: FrozenBaseIdentity): Promise<{ header: ArchiveSemanticHeader; semanticStore: ArchiveSemanticBatchStore }> {
    const args = [identity.verificationId, identity.generation, identity.commitToken, identity.graphSha256];
    const result = await db.batch([
      db.prepare(`SELECT s.*,EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a WHERE a.verification_id=s.verification_id AND a.generation=s.generation) AS admission_allowed FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
        WHERE s.verification_id=? AND s.generation=? AND s.commit_token=? AND s.graph_sha256=? AND s.status IN ('frozen','verified')`).bind(...args),
      db.prepare(`SELECT json_remove(m.manifest_json,'$.parts') AS header_json FROM archive_semantic_manifests m
        JOIN archive_semantic_sessions s USING(verification_id,generation) JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
        WHERE s.verification_id=? AND s.generation=? AND s.commit_token=? AND s.graph_sha256=? AND s.status IN ('frozen','verified') ORDER BY m.archive_id LIMIT 2`).bind(...args),
    ]);
    const session = result[0].results[0] as SessionRow | undefined;
    if (!session) error('STALE');
    assertArchiveStagingWork(result[0], (session as SessionRow & { admission_allowed: number }).admission_allowed);
    if (result[1].results.length !== 1) error('BASE_PROFILE');
    const json = String(result[1].results[0].header_json);
    if (encoder.encode(json).length > 48 * 1024) error('HEADER_BOUND');
    const header = JSON.parse(json) as ArchiveSemanticHeader;
    const root = reference(JSON.parse(session.root_reference_json));
    if (header.format !== ARCHIVE_FORMAT_V2 || header.kind !== 'monthly' || header.references.length || header.archiveId !== root.archiveId) error('BASE_PROFILE');
    const target = new D1ArchiveSemanticStaging(db, '', Object.freeze({ verificationId: identity.verificationId, generation: identity.generation }), root);
    return { header, semanticStore: target.store(identity.commitToken) };
  }

  /** Cleanup is a separate private capability. First invalidate an active
   * session with discard, or use a session invalidated by recovery. No rows
   * are removed until the explicit bounded cleanup operation is called. */
  static async beginCleanup<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, handle: ArchiveSemanticHandle): Promise<ArchiveSemanticCleanup> {
    try { return await claimArchiveStagingCleanup(db, handle); }
    catch (cause) {
      if (String(cause).includes('ARCHIVE_STAGING_CONTROL_STALE')) error('CLEANUP_STALE');
      throw cause;
    }
  }

  /** Deletes at most limit private records/checkpoints per call in FK order.
   * Each page checks a captured lifecycle revision and renews its lease only
   * after deletion. D1 batch rollback makes a lost checkpoint discard deletion.
   * The final session deletion removes lifecycle metadata and records a stable
   * completion receipt. Those additional writes are excluded from deleted.
   */
  static async cleanupPage<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, input: ArchiveSemanticCleanup, limit: number = LIMIT.semanticPageRecords): Promise<{ phase: string; deleted: number; complete: boolean }> {
    const handle = Object.freeze({ verificationId: input.verificationId, generation: input.generation, cleanupGeneration: input.cleanupGeneration, cleanupToken: input.cleanupToken });
    if (!Object.values(handle).every(value => typeof value === 'string' && identifier.test(value))) error('HANDLE_INVALID');
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT.semanticPageRecords) error('PAGE_BOUND');
    const receipt = await archiveCleanupReceiptIdentity(handle);
    const args = [handle.verificationId, handle.generation, handle.cleanupGeneration, handle.cleanupToken];
    const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    const leaseUntil = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${ARCHIVE_STAGING_CLEANUP_LEASE_SECONDS} seconds')`;
    const valid = `SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
      JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
      WHERE s.verification_id=? AND s.generation=? AND s.cleanup_generation=? AND s.cleanup_token=? AND s.status='invalid'
      AND l.revision=? AND l.cleanup_lease_until>${now}`;
    const tables = ['archive_semantic_review_witnesses', 'archive_semantic_operations', 'archive_semantic_visit_totals', 'archive_semantic_runs', 'archive_semantic_rows', 'archive_semantic_parts', 'archive_semantic_manifests', 'archive_semantic_sessions'] as const;
    const derived = new Set<string>(['archive_semantic_review_witnesses', 'archive_semantic_operations', 'archive_semantic_visit_totals']);
    const scope = (name: string) => derived.has(name) ? 'run_id IN (SELECT run_id FROM archive_semantic_runs WHERE verification_id=? AND generation=?)' : 'verification_id=? AND generation=?';
    const columns: Record<typeof tables[number], string[]> = {
      archive_semantic_review_witnesses: ['run_id', 'review_id'], archive_semantic_operations: ['run_id', 'request_id'], archive_semantic_visit_totals: ['run_id', 'visit_id'], archive_semantic_runs: ['run_id'],
      archive_semantic_rows: ['archive_id', 'table_name', 'record_key'], archive_semantic_parts: ['archive_id', 'part_index'], archive_semantic_manifests: ['archive_id'], archive_semantic_sessions: ['verification_id'],
    };
    const read = await db.batch([
      db.prepare('SELECT generation FROM history_runtime WHERE id=1'),
      db.prepare(`SELECT result_json FROM archive_semantic_diagnostics WHERE event_id=? AND verification_id=? AND generation=?
        AND execution_generation=? AND kind='cleanup_complete' AND request_sha256=? AND cleanup_token_sha256=?`)
        .bind(receipt.eventId, handle.verificationId, handle.generation, handle.cleanupGeneration, receipt.requestSha256, receipt.tokenSha256),
      db.prepare(`SELECT l.revision,s.cleanup_generation,s.cleanup_token,s.status,l.cleanup_lease_until>${now} AS live_lease
        FROM archive_semantic_sessions s LEFT JOIN archive_semantic_lifecycle l USING(verification_id,generation)
        WHERE s.verification_id=? AND s.generation=?`).bind(handle.verificationId, handle.generation),
      ...tables.map(name => db.prepare(`SELECT 1 FROM ${name} WHERE ${scope(name)} LIMIT 1`).bind(handle.verificationId, handle.generation)),
    ]);
    if (read[0].results[0]?.generation !== handle.cleanupGeneration) error('CLEANUP_STALE');
    const state = read[2].results[0];
    if (!state) {
      const saved = read[1].results[0]?.result_json;
      if (typeof saved !== 'string') error('CLEANUP_STALE');
      let replay: unknown;
      try { replay = JSON.parse(saved); } catch { error('CLEANUP_STALE'); }
      if (!replay || typeof replay !== 'object' || Array.isArray(replay)) error('CLEANUP_STALE');
      const result = replay as Record<string, unknown>;
      if (result.phase !== 'archive_semantic_sessions' || result.deleted !== 1 || result.complete !== true || Object.keys(result).length !== 3) error('CLEANUP_STALE');
      return { phase: 'archive_semantic_sessions', deleted: 1, complete: true };
    }
    if (state.status !== 'invalid' || state.cleanup_generation !== handle.cleanupGeneration || state.cleanup_token !== handle.cleanupToken || state.live_lease !== 1 || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0) error('CLEANUP_STALE');
    const revision = Number(state.revision), guardedArgs = [...args, revision];
    const index = read.slice(3).findIndex(result => result.results.length);
    if (index < 0) error('CLEANUP_STALE');
    const phase = tables[index], keys = columns[phase].join(',');
    const complete = phase === 'archive_semantic_sessions';
    // RAISE is only available in triggers. A deliberately invalid JSON argument
    // aborts this atomic batch if the immediately preceding checkpoint lost CAS.
    const assertCheckpoint = db.prepare("SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'ARCHIVE_STAGING_CLEANUP_STALE' END) AS checkpoint_ok");
    const statements = complete ? [
      db.prepare(`INSERT INTO archive_semantic_diagnostics(event_id,verification_id,generation,execution_generation,kind,reason_code,actor_id,request_sha256,created_at,lifecycle_revision,archive_id,manifest_sha256,runner_error_code,cleanup_token_sha256,detail_json,result_json)
        SELECT ?,s.verification_id,s.generation,?,'cleanup_complete','CLEANUP_COMPLETE',NULL,?,${now},l.revision,s.root_archive_id,s.root_manifest_sha256,NULL,?, ?,?
        FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
        WHERE s.verification_id=? AND s.generation=? AND EXISTS(${valid})`)
        .bind(receipt.eventId, handle.cleanupGeneration, receipt.requestSha256, receipt.tokenSha256,
          encodeArchiveControlJson({ phase }), encodeArchiveControlJson({ phase, deleted: 1, complete: true }), handle.verificationId, handle.generation, ...guardedArgs),
      db.prepare(`DELETE FROM archive_semantic_sessions WHERE verification_id=? AND generation=? AND changes()=1 AND EXISTS(${valid})`)
        .bind(handle.verificationId, handle.generation, ...guardedArgs),
      db.prepare('SELECT changes() AS deleted'), assertCheckpoint,
    ] : [
      db.prepare(`DELETE FROM ${phase} WHERE ${scope(phase)} AND EXISTS(${valid}) AND (${keys}) IN (
        SELECT ${keys} FROM ${phase} WHERE ${scope(phase)} ORDER BY ${keys} LIMIT ?)`)
        .bind(handle.verificationId, handle.generation, ...guardedArgs, handle.verificationId, handle.generation, limit),
      db.prepare('SELECT changes() AS deleted'),
      db.prepare(`UPDATE archive_semantic_lifecycle SET revision=revision+1,cleanup_lease_until=${leaseUntil},due_at=${leaseUntil}
        WHERE verification_id=? AND generation=? AND revision=? AND changes()>0 AND EXISTS(${valid})`)
        .bind(handle.verificationId, handle.generation, revision, ...guardedArgs), assertCheckpoint,
    ];
    let result: ArchiveStagingResult<Record<string, unknown>>[];
    try { result = await db.batch(statements); }
    catch (cause) {
      // This mapping is limited to the two batches containing our assertion.
      if (String(cause).includes('malformed JSON')) error('CLEANUP_STALE');
      throw cause;
    }
    const deleted = Number(result[complete ? 2 : 1].results[0]?.deleted ?? 0);
    if (!Number.isSafeInteger(deleted) || deleted < 1 || deleted > limit) error('CLEANUP_STALE');
    return { phase, deleted, complete };
  }

  private args() { return [this.handle.verificationId, this.handle.generation]; }
  private active(status = states, token?: string) {
    return this.db.prepare(`SELECT s.*,EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a WHERE a.verification_id=s.verification_id AND a.generation=s.generation) AS admission_allowed FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
      WHERE s.verification_id=? AND s.generation=? AND s.status IN ${status}${token === undefined ? '' : ' AND s.commit_token=?'}`).bind(...this.args(), ...(token === undefined ? [] : [token]));
  }
  private assertActive(results: ArchiveStagingResult<unknown>[], work = true): SessionRow {
    const session = results[0].results[0] as SessionRow | undefined;
    if (!session) error('STALE');
    if (work) assertArchiveStagingWork(results[0], (session as SessionRow & { admission_allowed: number }).admission_allowed);
    return session;
  }
  private async manifests(): Promise<ManifestRow[]> {
    const result = await this.db.batch([this.active(), this.db.prepare(`SELECT m.archive_id,m.manifest_sha256,m.manifest_json
      FROM archive_semantic_manifests m JOIN archive_semantic_sessions s USING(verification_id,generation)
      JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
      WHERE m.verification_id=? AND m.generation=? AND s.status IN ${states} ORDER BY m.archive_id LIMIT ?`).bind(...this.args(), LIMIT.graphArchives + 1)]);
    this.assertActive(result);
    const rows = result[1].results as ManifestRow[];
    if (rows.length > LIMIT.graphArchives) error('GRAPH_BOUND');
    return rows;
  }

  /** expected comes from trusted root selection or an authenticated reference.
   * freeze rejects any registrations outside the exact reachable root graph. */
  async registerManifest(expected: ArchiveReference, envelope: Uint8Array): Promise<ArchiveManifest> {
    this.assertActive(await this.db.batch([this.active("('staging')")]));
    const trusted = reference(expected);
    const manifest = await openArchiveManifest(this.master, envelope, trusted);
    if (manifest.format !== ARCHIVE_FORMAT_V2) error('VERSION');
    if (manifest.archiveId === this.root.archiveId && JSON.stringify(trusted) !== JSON.stringify(this.root)) error('ROOT_MISMATCH');
    const json = JSON.stringify(manifest);
    const result = await this.db.batch([
      this.active("('staging')"),
      this.db.prepare(`INSERT INTO archive_semantic_manifests(verification_id,generation,archive_id,manifest_sha256,manifest_json,plaintext_bytes,part_count,record_count)
        SELECT s.verification_id,s.generation,?,?,?,?,?,? FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
        WHERE s.verification_id=? AND s.generation=? AND s.status='staging' AND NOT EXISTS(
          SELECT 1 FROM archive_semantic_manifests m WHERE m.verification_id=s.verification_id AND m.generation=s.generation AND m.archive_id=?)`)
        .bind(manifest.archiveId, trusted.manifestSha256, json, manifest.plaintextBytes, manifest.parts.length, manifest.recordCount, ...this.args(), manifest.archiveId),
      this.db.prepare('SELECT archive_id,manifest_sha256,manifest_json FROM archive_semantic_manifests WHERE verification_id=? AND generation=? AND archive_id=?').bind(...this.args(), manifest.archiveId),
    ]);
    this.assertActive(result);
    const stored = result[2].results[0] as ManifestRow | undefined;
    if (!stored || stored.manifest_sha256 !== trusted.manifestSha256 || stored.manifest_json !== json) error('MANIFEST_REPLAY_MISMATCH');
    return manifest;
  }

  /** Authenticates before the transaction, then atomically commits all records
   * and the checkpoint. Identical retries return the original commit token. */
  async stageEncryptedPart(archiveId: string, partIndex: number, envelope: Uint8Array): Promise<string> {
    if (!identifier.test(archiveId) || !Number.isInteger(partIndex) || partIndex < 0 || partIndex >= LIMIT.parts) error('PART_ID_INVALID');
    const read = await this.db.batch([this.active("('staging')"), this.db.prepare('SELECT manifest_json FROM archive_semantic_manifests WHERE verification_id=? AND generation=? AND archive_id=?').bind(...this.args(), archiveId)]);
    this.assertActive(read);
    const entry = read[1].results[0] as { manifest_json: string } | undefined;
    if (!entry) error('MANIFEST_MISSING');
    const manifest: ArchiveManifest = JSON.parse(entry.manifest_json), descriptor = manifest.parts[partIndex];
    if (!descriptor || descriptor.index !== partIndex) error('PART_MISSING');
    const records = await verifyArchivePart(this.master, manifest, descriptor, envelope);
    const descriptorJson = JSON.stringify(descriptor), descriptorHash = await hashJson(descriptor);
    const rowsetHash = await digest(encoder.encode(records.map(record => JSON.stringify(record) + '\n').join(''))), token = crypto.randomUUID();
    const checkpointArgs = [...this.args(), archiveId, partIndex];
    const statements = [this.active("('staging')"),
      this.db.prepare(`INSERT INTO archive_semantic_parts(verification_id,generation,archive_id,part_index,descriptor_json,descriptor_sha256,rowset_sha256,commit_token)
        SELECT s.verification_id,s.generation,?,?,?,?,?,? FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
        WHERE s.verification_id=? AND s.generation=? AND s.status='staging' AND NOT EXISTS(
          SELECT 1 FROM archive_semantic_parts p WHERE p.verification_id=s.verification_id AND p.generation=s.generation AND p.archive_id=? AND p.part_index=?)`)
        .bind(archiveId, partIndex, descriptorJson, descriptorHash, rowsetHash, token, ...this.args(), archiveId, partIndex)];
    // One JSON parameter keeps the transaction at four statements even for a
    // 256-record part. This array is at most the authenticated 1 MiB JSONL
    // length plus its brackets, below D1's 2 MiB string limit.
    const payload = JSON.stringify(records);
    if (encoder.encode(payload).length > LIMIT.plaintextPartBytes + 2) error('PART_BYTES');
    statements.push(this.db.prepare(`INSERT INTO archive_semantic_rows(verification_id,generation,archive_id,table_name,record_key,part_index,part_commit_token,record_json,visit_id,event_id,entity_id)
      SELECT p.verification_id,p.generation,p.archive_id,json_extract(j.value,'$.table'),json_extract(j.value,'$.key'),p.part_index,p.commit_token,j.value,
        CASE WHEN json_type(j.value,'$.row.visit_id')='text' THEN json_extract(j.value,'$.row.visit_id') END,
        CASE WHEN json_type(j.value,'$.row.event_id')='text' THEN json_extract(j.value,'$.row.event_id') END,
        CASE WHEN json_type(j.value,'$.row.entity_id')='text' THEN json_extract(j.value,'$.row.entity_id') END
      FROM json_each(?) j JOIN archive_semantic_parts p
      JOIN archive_semantic_sessions s USING(verification_id,generation) JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
      WHERE p.verification_id=? AND p.generation=? AND p.archive_id=? AND p.part_index=? AND p.commit_token=? AND s.status='staging'`)
      .bind(payload, ...checkpointArgs, token));
    statements.push(this.db.prepare('SELECT descriptor_json,descriptor_sha256,rowset_sha256,commit_token FROM archive_semantic_parts WHERE verification_id=? AND generation=? AND archive_id=? AND part_index=?').bind(...checkpointArgs));
    const result = await this.db.batch(statements);
    this.assertActive(result);
    const committed = result.at(-1)!.results[0] as PartRow | undefined;
    if (!committed || committed.descriptor_json !== descriptorJson || committed.descriptor_sha256 !== descriptorHash || committed.rowset_sha256 !== rowsetHash) error('PART_REPLAY_MISMATCH');
    return committed.commit_token;
  }

  private graph(rows: ManifestRow[]) {
    const byId = new Map(rows.map(row => [row.archive_id, row])), active = new Set<string>(), visited = new Set<string>();
    const ordered: ArchiveManifest[] = [], rootRow = byId.get(this.root.archiveId);
    if (!rootRow || rootRow.manifest_sha256 !== this.root.manifestSha256) error('ROOT_MISSING');
    const root: ArchiveManifest = JSON.parse(rootRow.manifest_json);
    const visit = (expected: ArchiveReference, depth: number, parent?: ArchiveManifest): void => {
      if (depth > LIMIT.graphDepth) error('GRAPH_DEPTH');
      const row = byId.get(expected.archiveId);
      if (!row || row.manifest_sha256 !== expected.manifestSha256) error('REFERENCE_MISSING');
      const manifest: ArchiveManifest = JSON.parse(row.manifest_json);
      if (manifest.kind !== expected.kind || manifest.centerId !== root.centerId || manifest.month !== root.month || manifest.timezone !== root.timezone || manifest.createdAt > (parent?.createdAt ?? root.createdAt)) error('GRAPH_SCOPE');
      if (active.has(manifest.archiveId)) error('GRAPH_CYCLE');
      if (visited.has(manifest.archiveId)) return;
      active.add(manifest.archiveId);
      for (const dependency of manifest.references) visit(dependency, depth + 1, manifest);
      active.delete(manifest.archiveId); visited.add(manifest.archiveId); ordered.push(manifest);
    };
    visit(this.root, 0);
    if (visited.size !== rows.length) error('UNREACHABLE_MANIFEST');
    return ordered;
  }

  /** Freeze grants private snapshot visibility, not semantic success or public
   * publication. It fixes the exact complete manifest/part set before reads. */
  async freeze(): Promise<ArchiveSemanticSnapshot> {
    const rows = await this.manifests(), manifests = this.graph(rows);
    const manifestSet = JSON.stringify(rows.map(row => [row.archive_id, row.manifest_sha256]));
    const graphHash = await digest(encoder.encode(manifestSet)), token = crypto.randomUUID();
    const result = await this.db.batch([this.active(),
      this.db.prepare(`UPDATE archive_semantic_sessions SET status='frozen',commit_token=?,graph_sha256=?
        WHERE verification_id=? AND generation=? AND status='staging'
        AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=?)
        AND (SELECT count(*) FROM archive_semantic_manifests WHERE verification_id=? AND generation=?)=?
        AND NOT EXISTS(SELECT 1 FROM archive_semantic_manifests m WHERE m.verification_id=? AND m.generation=? AND (
          NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE json_extract(expected.value,'$[0]')=m.archive_id AND json_extract(expected.value,'$[1]')=m.manifest_sha256)
          OR m.part_count!=(SELECT count(*) FROM archive_semantic_parts p WHERE p.verification_id=m.verification_id AND p.generation=m.generation AND p.archive_id=m.archive_id)
          OR EXISTS(SELECT 1 FROM archive_semantic_parts p WHERE p.verification_id=m.verification_id AND p.generation=m.generation AND p.archive_id=m.archive_id
            AND p.descriptor_json IS NOT json_extract(m.manifest_json,'$.parts['||p.part_index||']'))
        ))`).bind(token, graphHash, ...this.args(), this.handle.generation, ...this.args(), rows.length, ...this.args(), manifestSet),
      this.db.prepare('SELECT * FROM archive_semantic_sessions WHERE verification_id=? AND generation=?').bind(...this.args())]);
    this.assertActive(result);
    const session = result[2].results[0] as SessionRow;
    if (!['frozen', 'verified'].includes(session.status) || session.graph_sha256 !== graphHash || !session.commit_token) error('INCOMPLETE_OR_CHANGED_GRAPH');
    const commitToken = session.commit_token;
    return { commitToken, graphSha256: graphHash, manifests, semanticStore: this.store(commitToken) };
  }

  private store(commitToken: string): ArchiveSemanticBatchStore {
    const statement = (archiveId: string, name: ArchiveTable, suffix: string, values: unknown[], index?: string): S => {
      table(name); if (!identifier.test(archiveId)) error('ARCHIVE_ID_INVALID');
      // The outer row preserves admission/size validation for an empty page.
      // Every record predicate and LIMIT belongs inside the indexed subquery.
      return this.db.prepare(`WITH active AS MATERIALIZED (
          SELECT s.*,EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a WHERE a.verification_id=s.verification_id AND a.generation=s.generation) AS admission_allowed
          FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
          WHERE s.verification_id=? AND s.generation=? AND s.status IN ('frozen','verified') AND s.commit_token=?)
        SELECT s.*,r.record_json FROM active s
        LEFT JOIN (SELECT r.record_key,r.record_json FROM archive_semantic_rows r${index ? ` INDEXED BY ${index}` : ''}
          WHERE r.verification_id=? AND r.generation=? AND r.archive_id=? AND r.table_name=? ${suffix}) r ON 1=1
        ORDER BY r.record_key`)
        .bind(...this.args(), commitToken, ...this.args(), archiveId, name, ...values);
    };
    const records = (result: ArchiveStagingResult<unknown>): ArchiveRecord[] => {
      this.assertActive([result]);
      return (result.results as { record_json: string | null }[])
        .filter(row => row.record_json !== null).map(row => JSON.parse(row.record_json!) as ArchiveRecord);
    };
    const query = async (archiveId: string, name: ArchiveTable, suffix: string, values: unknown[], index?: string): Promise<ArchiveRecord[]> => {
      const result = await this.db.batch([statement(archiveId, name, suffix, values, index)]);
      return records(result[0]);
    };
    return {
      page: async (input: ArchiveSemanticQuery) => {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > LIMIT.semanticPageRecords || typeof input.after !== 'string' || input.after.length > 1024) error('PAGE_BOUND');
        const relation = input.relation;
        if (relation && (!['visit_id', 'event_id', 'entity_id'].includes(relation.column) || typeof relation.value !== 'string' || relation.value.length > 1024)) error('RELATION_INVALID');
        return query(input.archiveId, input.table, `AND r.record_key>? ${relation ? `AND r.${relation.column}=?` : ''} ORDER BY r.record_key LIMIT ?`, [input.after, ...(relation ? [relation.value] : []), input.limit], relation ? `archive_semantic_rows_${relation.column.split('_')[0]}` : undefined);
      },
      get: async (archiveId, name, key) => {
        if (typeof key !== 'string' || key.length > 1024) error('KEY_INVALID');
        return (await query(archiveId, name, 'AND r.record_key=? LIMIT 1', [key]))[0] ?? null;
      },
      getMany: async references => {
        if (!Array.isArray(references) || references.length > 12) error('LOOKUP_BOUND');
        const statements = references.map(reference => {
          if (!reference || typeof reference.key !== 'string' || reference.key.length > 1024) error('KEY_INVALID');
          return statement(reference.archiveId, reference.table, 'AND r.record_key=? LIMIT 1', [reference.key]);
        });
        if (!statements.length) return [];
        const result = await this.db.batch(statements);
        return result.map(item => records(item)[0] ?? null);
      },
    };
  }

  /** The adapter runs the actual semantic proof before writing verified status.
   * An interrupted frozen session is resumable; rerunning verifies it afresh. */
  async finalize(): Promise<ArchiveSemanticSnapshot> {
    const snapshot = await this.freeze();
    try {
      await verifyArchiveSemantics(snapshot.manifests, snapshot.semanticStore);
      const result = await this.db.batch([this.active("('frozen','verified')", snapshot.commitToken),
        this.db.prepare(`UPDATE archive_semantic_sessions SET status='verified' WHERE verification_id=? AND generation=? AND status IN ('frozen','verified') AND commit_token=? AND graph_sha256=?
          AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=?)`).bind(...this.args(), snapshot.commitToken, snapshot.graphSha256, this.handle.generation)]);
      this.assertActive(result);
      return snapshot;
    } catch (failure) {
      // Maintenance/interrupted transport is retryable; semantic rejection is
      // terminal for this immutable session. No retained records are deleted.
      if (failure instanceof Error && failure.message.startsWith('Invalid historical evidence:')) await this.discard();
      throw failure;
    }
  }

  async discard(): Promise<void> {
    const result = await this.db.batch([this.active(),
      this.db.prepare(`UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL WHERE verification_id=? AND generation=? AND status IN ${states}
        AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=?)`).bind(...this.args(), this.handle.generation)]);
    this.assertActive(result, false);
  }
}
