import { ARCHIVE_TABLES, type ArchiveCounts, type ArchiveRecord, type ArchiveTable } from '../shared/archive-format';
import { D1ArchiveSemanticStaging, type ArchiveSemanticHeader, type ArchiveStagingDatabase, type ArchiveStagingStatement, type FrozenBaseIdentity } from './archive-semantic-store';
import { applyVisitOperation, finishVisitFold, initialVisitFold, matchesResolutionWitness, validateSemanticRecord, validateSemanticShape, type VisitFoldState } from './archive-semantic-rules';
import { assertArchiveStagingWork, isArchiveStagingCapacityPause, type ArchiveStagingResult } from './archive-staging-admission';
import { createMonthlySemanticLookup } from './archive-semantic-prefetch';

export const MONTHLY_SEMANTIC_VALIDATOR_VERSION = 1;
export const MONTHLY_SEMANTIC_LIMITS = { statements: 40, headerBytes: 48 * 1024, cursorBytes: 8 * 1024, decodedBytes: 1024 * 1024, operationPage: 8, leaseMilliseconds: 30_000 } as const;
export type MonthlySemanticRunHandle = FrozenBaseIdentity & { runId: string };
type Phase = 'records' | 'visits' | 'reviews' | 'complete';
export type MonthlySemanticRunSelection = { revision: number; phase: Phase };

/** Private completion proof for publication. A verified session alone is not
 * sufficient: only this supported runner's closed cursor grants publication. */
export async function readCompletedMonthlySemanticProof<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, supplied: MonthlySemanticRunHandle) {
  const handle = Object.freeze({ ...supplied });
  checkIdentity(handle);
  const { header } = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(db, handle);
  const result = await db.batch<Run & { root_reference_json: string }>([db.prepare(`SELECT r.*,s.root_reference_json ${activeFrom}
    WHERE ${activeWhere} AND r.status='complete' AND r.phase='complete' AND s.status='verified' AND h.state='ready'`).bind(...identityArgs(handle))]);
  const run = result[0].results[0];
  if (!run || run.header_json !== JSON.stringify(header)) fail('COMPLETION_PROOF_INVALID');
  readCursor(run.cursor_json, header, 'complete');
  return { handle, header, rootReferenceJson: run.root_reference_json };
}
type Cursor = {
  version: 1; tableIndex: number; after: string; counts: ArchiveCounts;
  visitAfter: string; visitsDone: number;
  visit: null | { key: string; afterVersion: number; afterRequestId: string; processed: number; fold: VisitFoldState };
  reviewAfter: string; reviewsDone: number;
};
type Run = { run_id: string; verification_id: string; generation: string; snapshot_commit_token: string; graph_sha256: string; validator_version: number; archive_id: string; header_json: string; status: 'pending' | 'running' | 'complete' | 'invalid'; phase: Phase; revision: number; lease_token: string | null; lease_expires_at: string | null; cursor_json: string };
export type MonthlySemanticAdvance = { status: 'pending' | 'complete' | 'busy' | 'paused'; phase: Phase; revision: number; processed: number; queries: number };
const encoder = new TextEncoder();
function fail(code: string): never { throw new Error(`ARCHIVE_SEMANTIC_RUN_${code}`); }
function isLifecyclePause(failure: unknown): boolean {
  const message = failure instanceof Error ? failure.message : String(failure);
  return ['ARCHIVE_STAGING_PAUSED', 'ARCHIVE_STAGING_RENEWAL_REQUIRED', 'ARCHIVE_STAGING_EXPIRED'].some(code => message.includes(code));
}
function permanentCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const semantic = /^Invalid historical evidence: ([A-Z_]+)$/.exec(error.message);
  if (semantic) return semantic[1];
  const metadata = /^ARCHIVE_(?:SEMANTIC_RUN|STAGING)_(CURSOR_INVALID|CURSOR_BOUND|HEADER_CHANGED|HEADER_BOUND|BASE_PROFILE|QUERY_BOUND|DECODED_BOUND)$/.exec(error.message);
  return metadata?.[1] ?? null;
}
function semanticFail(code: string): never { throw new Error(`Invalid historical evidence: ${code}`); }
const size = (text: string) => encoder.encode(text).length;
const now = () => new Date().toISOString();
function identityArgs(value: MonthlySemanticRunHandle) { return [value.runId, value.verificationId, value.generation, value.commitToken, value.graphSha256]; }
const activeFrom = `FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.generation`;
const activeWhere = `r.run_id=? AND r.verification_id=? AND r.generation=? AND r.snapshot_commit_token=? AND r.graph_sha256=?
  AND r.validator_version=1 AND ((r.status='complete' AND s.status='verified') OR (r.status IN ('pending','running') AND s.status='frozen'))
  AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256`;
function checkIdentity(value: FrozenBaseIdentity & { runId?: string }) {
  for (const text of [value.verificationId, value.generation, value.commitToken, ...(value.runId === undefined ? [] : [value.runId])]) if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(text)) fail('HANDLE_INVALID');
  if (typeof value.graphSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.graphSha256)) fail('HANDLE_INVALID');
}
function initialCursor(): Cursor { return { version: 1, tableIndex: 0, after: '', counts: Object.fromEntries(ARCHIVE_TABLES.map(name => [name, 0])) as ArchiveCounts, visitAfter: '', visitsDone: 0, visit: null, reviewAfter: '', reviewsDone: 0 }; }
function cursorText(cursor: Cursor) { const text = JSON.stringify(cursor); if (size(text) > MONTHLY_SEMANTIC_LIMITS.cursorBytes) fail('CURSOR_BOUND'); return text; }
function readCursor(text: string, header: ArchiveSemanticHeader, phase: Phase): Cursor {
  if (size(text) > MONTHLY_SEMANTIC_LIMITS.cursorBytes) fail('CURSOR_BOUND');
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { fail('CURSOR_INVALID'); }
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const integer = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  const key = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024;
  const time = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  if (!exact(parsed, ['version','tableIndex','after','counts','visitAfter','visitsDone','visit','reviewAfter','reviewsDone']) || parsed.version !== 1
    || !integer(parsed.tableIndex, ARCHIVE_TABLES.length) || !key(parsed.after) || !key(parsed.visitAfter) || !key(parsed.reviewAfter)
    || !integer(parsed.visitsDone, header.recordCounts.visits) || !integer(parsed.reviewsDone, header.recordCounts.reviews)
    || !exact(parsed.counts, [...ARCHIVE_TABLES])) fail('CURSOR_INVALID');
  const counts = parsed.counts;
  if (ARCHIVE_TABLES.some(name => !integer(counts[name], header.recordCounts[name]))) fail('CURSOR_INVALID');
  const cursor = parsed as Cursor;
  if ((cursor.visitsDone === 0) !== (cursor.visitAfter === '') || (cursor.reviewsDone === 0) !== (cursor.reviewAfter === '')) fail('CURSOR_INVALID');
  if (cursor.visit !== null) {
    const state = cursor.visit;
    if (!exact(state, ['key','afterVersion','afterRequestId','processed','fold']) || !id(state.key) || state.key <= cursor.visitAfter
      || !key(state.afterRequestId) || !state.afterRequestId || !integer(state.afterVersion, 2048) || !integer(state.processed, 2048)
      || state.processed < 1 || state.processed !== state.afterVersion || cursor.visitsDone >= header.recordCounts.visits
      || !exact(state.fold, ['version','bytes','start','end','originalStart','originalEnd','inBy','outBy','guardian','departure'])) fail('CURSOR_INVALID');
    const fold = state.fold;
    if (fold.version !== state.processed || !integer(fold.bytes, 4 * 1024 * 1024) || fold.bytes < 1 || !time(fold.start) || !time(fold.originalStart)
      || (fold.end !== null && !time(fold.end)) || (fold.originalEnd !== null && !time(fold.originalEnd)) || !id(fold.inBy)
      || (fold.outBy !== null && !id(fold.outBy)) || (fold.guardian !== null && !id(fold.guardian))
      || ![null, 'check_out', 'exceptional_departure'].includes(fold.departure as string | null)) fail('CURSOR_INVALID');
  }
  if (phase === 'records') {
    if (cursor.tableIndex >= ARCHIVE_TABLES.length || cursor.visitsDone || cursor.visit !== null || cursor.reviewsDone) fail('CURSOR_INVALID');
    for (const [index, name] of ARCHIVE_TABLES.entries()) {
      if (index < cursor.tableIndex && cursor.counts[name] !== header.recordCounts[name] || index > cursor.tableIndex && cursor.counts[name] !== 0) fail('CURSOR_INVALID');
    }
    if ((cursor.counts[ARCHIVE_TABLES[cursor.tableIndex]] === 0) !== (cursor.after === '')) fail('CURSOR_INVALID');
  } else {
    if (!['visits','reviews','complete'].includes(phase) || cursor.tableIndex !== ARCHIVE_TABLES.length || cursor.after !== ''
      || ARCHIVE_TABLES.some(name => cursor.counts[name] !== header.recordCounts[name])) fail('CURSOR_INVALID');
    if (phase === 'visits' && cursor.reviewsDone !== 0) fail('CURSOR_INVALID');
    if (phase !== 'visits' && (cursor.visit !== null || cursor.visitsDone !== header.recordCounts.visits)) fail('CURSOR_INVALID');
    if (phase === 'complete' && cursor.reviewsDone !== header.recordCounts.reviews) fail('CURSOR_INVALID');
  }
  return cursor;
}

/** Counts actual prepared statements, including each member of a D1 batch.
 * Record payloads have a cumulative ceiling; each compact header has its own
 * separate bound and is deliberately not charged against record payload bytes. */
class Budget<S extends ArchiveStagingStatement<S>> implements ArchiveStagingDatabase<S> {
  used = 0; decoded = 0; reserve = 0;
  constructor(private readonly db: ArchiveStagingDatabase<S>) {}
  prepare(sql: string) { return this.db.prepare(sql); }
  async batch<T = Record<string, unknown>>(statements: S[]): Promise<ArchiveStagingResult<T>[]> {
    if (this.used + statements.length + this.reserve > MONTHLY_SEMANTIC_LIMITS.statements) fail('QUERY_BOUND');
    this.used += statements.length;
    const results = await this.db.batch<T>(statements);
    for (const result of results) for (const item of result.results) {
      if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>;
        if (typeof row.header_json === 'string' && size(row.header_json) > MONTHLY_SEMANTIC_LIMITS.headerBytes) fail('HEADER_BOUND');
        if (typeof row.record_json === 'string') this.decoded += size(row.record_json);
      }
    }
    if (this.decoded > MONTHLY_SEMANTIC_LIMITS.decodedBytes) fail('DECODED_BOUND');
    return results;
  }
}

/** Starts one private proof; no archive object is read or published here. */
export async function startMonthlySemanticVerification<S extends ArchiveStagingStatement<S>>(database: ArchiveStagingDatabase<S>, identity: FrozenBaseIdentity): Promise<MonthlySemanticRunHandle> {
  checkIdentity(identity);
  const db = new Budget(database);
  const { header, semanticStore } = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(db, identity);
  const center = await semanticStore.get(header.archiveId, 'centers', header.centerId);
  if (!center) semanticFail('MISSING_RELATION');
  validateSemanticShape(center, header, 'centers', header.centerId);
  const runId = crypto.randomUUID(), at = now(), headerJson = JSON.stringify(header);
  if (size(headerJson) > MONTHLY_SEMANTIC_LIMITS.headerBytes) fail('HEADER_BOUND');
  const results = await db.batch([
    db.prepare(`INSERT INTO archive_semantic_runs(run_id,verification_id,generation,snapshot_commit_token,graph_sha256,validator_version,archive_id,header_json,status,phase,revision,cursor_json,created_at,updated_at)
      SELECT ?,s.verification_id,s.generation,s.commit_token,s.graph_sha256,1,?,?,'pending','records',0,?,?,? FROM archive_semantic_sessions s
      JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
      WHERE s.verification_id=? AND s.generation=? AND s.commit_token=? AND s.graph_sha256=? AND s.status='frozen'
        AND NOT EXISTS(SELECT 1 FROM archive_semantic_runs r WHERE r.verification_id=s.verification_id AND r.generation=s.generation AND r.snapshot_commit_token=s.commit_token AND r.validator_version=1)`)
      .bind(runId, header.archiveId, headerJson, cursorText(initialCursor()), at, at, identity.verificationId, identity.generation, identity.commitToken, identity.graphSha256),
    db.prepare(`SELECT r.run_id ${activeFrom} WHERE r.verification_id=? AND r.generation=? AND r.snapshot_commit_token=? AND r.graph_sha256=? AND r.validator_version=1 AND r.status!='invalid'
      AND s.status IN ('frozen','verified') AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256`).bind(identity.verificationId, identity.generation, identity.commitToken, identity.graphSha256),
  ]);
  const row = results[1].results[0] as { run_id: string } | undefined;
  if (!row) fail('STALE');
  return { ...identity, runId: row.run_id };
}

/** One bounded internal step. Callers must include their ledger overhead and
 * injected fence statements in their own enclosing limit.
 * A supplied selection binds this call to one revision/phase. A mismatch throws
 * STALE_SELECTION without leasing or permanently invalidating the proof. */
export async function advanceMonthlySemanticVerification<S extends ArchiveStagingStatement<S>>(database: ArchiveStagingDatabase<S>, handle: MonthlySemanticRunHandle, selection?: MonthlySemanticRunSelection): Promise<MonthlySemanticAdvance> {
  checkIdentity(handle);
  const expected = selection === undefined ? undefined : Object.freeze({ revision: selection?.revision, phase: selection?.phase });
  if (expected && (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || !['records', 'visits', 'reviews', 'complete'].includes(expected.phase))) fail('SELECTION_INVALID');
  const assertSelection = (run: Pick<Run, 'revision' | 'phase'>) => {
    if (expected && (run.revision !== expected.revision || run.phase !== expected.phase)) fail('STALE_SELECTION');
  };
  const db = new Budget(database), args = identityArgs(handle);
  let leased: Run | undefined;
  const response = (status: MonthlySemanticAdvance['status'], run: Pick<Run, 'phase' | 'revision'>, processed = 0): MonthlySemanticAdvance => ({ status, phase: run.phase, revision: run.revision, processed, queries: db.used });
  const read = await db.batch<Run & { admission_allowed: number; lifecycle_present: number; work_error: string | null }>([db.prepare(`SELECT r.*,EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a WHERE a.verification_id=r.verification_id AND a.generation=r.generation) AS admission_allowed,EXISTS(SELECT 1 FROM archive_semantic_work_control c WHERE c.verification_id=r.verification_id AND c.generation=r.generation) AS lifecycle_present,(SELECT c.work_error FROM archive_semantic_work_control c WHERE c.verification_id=r.verification_id AND c.generation=r.generation) AS work_error ${activeFrom} WHERE ${activeWhere}`).bind(...args)]);
  const saved = read[0].results[0]; if (!saved) fail('STALE');
  assertSelection(saved);
  if (saved.lifecycle_present !== 1) fail('LIFECYCLE_MISSING');
  if (saved.work_error !== null) {
    if (isLifecyclePause(saved.work_error)) return response('paused', saved);
    fail('LIFECYCLE_INVALID');
  }
  try { assertArchiveStagingWork(read[0], saved.admission_allowed); }
  catch (failure) {
    if (isArchiveStagingCapacityPause(failure) || isLifecyclePause(failure)) return response('paused', saved);
    throw failure;
  }
  if (saved.status === 'complete') {
    try {
      const { header } = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(db, handle);
      if (JSON.stringify(header) !== saved.header_json) fail('HEADER_CHANGED');
      readCursor(saved.cursor_json, header, saved.phase);
      return response('complete', saved);
    } catch (failure) {
      if (isArchiveStagingCapacityPause(failure) || isLifecyclePause(failure)) return response('paused', saved);
      const code = permanentCode(failure);
      if (code) {
        const changed = await db.batch([
          db.prepare(`UPDATE archive_semantic_runs SET status='invalid',error_code=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=? AND revision=? AND status='complete'
            AND EXISTS(SELECT 1 ${activeFrom} WHERE ${activeWhere}) RETURNING run_id`).bind(code, now(), saved.run_id, saved.revision, ...args),
          db.prepare(`UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL
            WHERE verification_id=? AND generation=? AND commit_token=? AND graph_sha256=? AND changes()=1
              AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=?)`).bind(handle.verificationId, handle.generation, handle.commitToken, handle.graphSha256, handle.generation),
        ]);
        if (!changed[0].results.length) fail('STALE');
      }
      throw failure;
    }
  }
  try {
    const lease = crypto.randomUUID(), expires = new Date(Date.now() + MONTHLY_SEMANTIC_LIMITS.leaseMilliseconds).toISOString();
    const claim = await db.batch<Run>([db.prepare(`UPDATE archive_semantic_runs SET status='running',lease_token=?,lease_expires_at=?,updated_at=?
      WHERE run_id=? AND revision=? AND phase=? AND status IN ('pending','running') AND (lease_token IS NULL OR lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND EXISTS(SELECT 1 ${activeFrom} WHERE ${activeWhere}) RETURNING *`).bind(lease, expires, now(), handle.runId, expected?.revision ?? saved.revision, expected?.phase ?? saved.phase, ...args)]);
    leased = claim[0].results[0];
    if (!leased) {
      const current = await db.batch<Run>([db.prepare(`SELECT r.* ${activeFrom} WHERE ${activeWhere}`).bind(...args)]);
      if (!current[0].results[0]) fail('STALE');
      assertSelection(current[0].results[0]);
      return response(current[0].results[0].status === 'complete' ? 'complete' : 'busy', current[0].results[0]);
    }
    const run = leased;
    db.reserve = 6;
    const { header, semanticStore } = await D1ArchiveSemanticStaging.openFrozenBaseSnapshot(db, handle);
    if (header.archiveId !== run.archive_id || JSON.stringify(header) !== run.header_json) fail('HEADER_CHANGED');
    const cursor = readCursor(run.cursor_json, header, run.phase);
    const guard = () => db.prepare(`SELECT r.run_id ${activeFrom} WHERE ${activeWhere} AND r.status='running' AND r.revision=? AND r.lease_token=? AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(...args, run.revision, lease);
    const guarded = async <T,>(statement: S): Promise<T[]> => {
      const result = await db.batch([guard(), statement]);
      if (!result[0].results.length) fail('STALE');
      return result[1].results as T[];
    };
    const lookup = createMonthlySemanticLookup(header, semanticStore);
    let phase = run.phase, processed = 0;
    const writes: S[] = [];
    if (phase === 'records') {
      if (cursor.tableIndex >= ARCHIVE_TABLES.length) fail('CURSOR_INVALID');
      const table = ARCHIVE_TABLES[cursor.tableIndex];
      const page = await semanticStore.page({ archiveId: header.archiveId, table, after: cursor.after, limit: 1 });
      if (!page.length) {
        if (cursor.counts[table] !== header.recordCounts[table]) semanticFail('STAGING_RECORD_COUNT');
        cursor.tableIndex++; cursor.after = '';
        if (cursor.tableIndex === ARCHIVE_TABLES.length) phase = 'visits';
      } else {
        const record = page[0]; validateSemanticShape(record, header, table);
        if (record.key <= cursor.after) semanticFail('STAGING_PAGE_ORDER');
        if (cursor.counts[table] >= header.recordCounts[table]) semanticFail('STAGING_RECORD_COUNT');
        await lookup.prefetch(record);
        const facts = await validateSemanticRecord(record, header, lookup);
        if (facts.operation) {
          const operation = facts.operation;
          writes.push(db.prepare('INSERT INTO archive_semantic_operations(run_id,request_id,source_table,record_key,visit_id,operation_version,record_bytes) VALUES(?,?,?,?,?,?,?)')
            .bind(run.run_id, operation.requestId, operation.table, operation.key, operation.visitId, operation.version, operation.bytes));
          writes.push(db.prepare(`INSERT INTO archive_semantic_visit_totals(run_id,visit_id,operation_count,record_bytes) VALUES(?,?,1,?)
            ON CONFLICT(run_id,visit_id) DO UPDATE SET operation_count=operation_count+1,record_bytes=record_bytes+excluded.record_bytes`).bind(run.run_id, operation.visitId, operation.bytes));
        }
        if (facts.resolutionWitness) writes.push(db.prepare(`INSERT INTO archive_semantic_review_witnesses(run_id,review_id,audit_key) SELECT ?,?,?
          WHERE NOT EXISTS(SELECT 1 FROM archive_semantic_review_witnesses WHERE run_id=? AND review_id=?)`)
          .bind(run.run_id, facts.resolutionWitness.reviewId, facts.resolutionWitness.auditKey, run.run_id, facts.resolutionWitness.reviewId));
        cursor.counts[table]++; cursor.after = record.key; processed = 1;
      }
    } else if (phase === 'visits') {
      let visit: ArchiveRecord | null;
      if (cursor.visit) visit = await lookup.localGet('visits', cursor.visit.key);
      else visit = (await semanticStore.page({ archiveId: header.archiveId, table: 'visits', after: cursor.visitAfter, limit: 1 }))[0] ?? null;
      if (!visit) {
        if (cursor.visit || cursor.visitsDone !== header.recordCounts.visits) semanticFail('STAGING_RECORD_COUNT');
        phase = 'reviews';
      } else {
        validateSemanticShape(visit, header, 'visits');
        if (visit.key <= cursor.visitAfter) semanticFail('STAGING_PAGE_ORDER');
        const totals = (await guarded<{ operation_count: number; record_bytes: number }>(db.prepare('SELECT operation_count,record_bytes FROM archive_semantic_visit_totals WHERE run_id=? AND visit_id=?').bind(run.run_id, visit.key)))[0];
        if (!totals) semanticFail('MISSING_ARRIVAL');
        if (totals.operation_count > 2048 || totals.record_bytes > 4 * 1024 * 1024) semanticFail('VISIT_CLOSURE_BOUND');
        const state = cursor.visit ?? { key: visit.key, afterVersion: 0, afterRequestId: '', processed: 0, fold: initialVisitFold() };
        const operations = await guarded<{ source_table: ArchiveTable; record_key: string; request_id: string; operation_version: number; record_json: string | null }>(db.prepare(`SELECT o.source_table,o.record_key,o.request_id,o.operation_version,s.record_json
          FROM archive_semantic_operations o INDEXED BY archive_semantic_operations_visit
          LEFT JOIN archive_semantic_rows s ON s.verification_id=? AND s.generation=? AND s.archive_id=? AND s.table_name=o.source_table AND s.record_key=o.record_key
          WHERE o.run_id=? AND o.visit_id=? AND (o.operation_version>? OR (o.operation_version=? AND o.request_id>?))
          ORDER BY o.operation_version,o.request_id LIMIT ?`).bind(handle.verificationId, handle.generation, header.archiveId, run.run_id, visit.key, state.afterVersion, state.afterVersion, state.afterRequestId, MONTHLY_SEMANTIC_LIMITS.operationPage));
        for (const operation of operations) {
          if (!operation.record_json) semanticFail('MISSING_RELATION');
          const record = JSON.parse(operation.record_json) as ArchiveRecord;
          validateSemanticShape(record, header, operation.source_table, operation.record_key);
          state.fold = applyVisitOperation(state.fold, visit.row, record);
          state.afterVersion = operation.operation_version; state.afterRequestId = operation.request_id; state.processed++; processed++;
        }
        if (operations.length < MONTHLY_SEMANTIC_LIMITS.operationPage) {
          if (state.processed !== totals.operation_count) semanticFail('VISIT_VERSION_CHAIN');
          finishVisitFold(state.fold, visit.row, header);
          cursor.visitsDone++; cursor.visitAfter = visit.key; cursor.visit = null;
        } else cursor.visit = state;
      }
    } else if (phase === 'reviews') {
      const page = await semanticStore.page({ archiveId: header.archiveId, table: 'reviews', after: cursor.reviewAfter, limit: 1 });
      if (!page.length) {
        if (cursor.reviewsDone !== header.recordCounts.reviews || cursor.visitsDone !== header.recordCounts.visits || cursor.visit
          || cursor.tableIndex !== ARCHIVE_TABLES.length || ARCHIVE_TABLES.some(name => cursor.counts[name] !== header.recordCounts[name])) semanticFail('STAGING_RECORD_COUNT');
        phase = 'complete';
      } else {
        const review = page[0]; validateSemanticShape(review, header, 'reviews');
        if (review.key <= cursor.reviewAfter) semanticFail('STAGING_PAGE_ORDER');
        if (review.row.status === 'resolved') {
          const witness = (await guarded<{ audit_key: string }>(db.prepare('SELECT audit_key FROM archive_semantic_review_witnesses WHERE run_id=? AND review_id=?').bind(run.run_id, review.key)))[0];
          const audit = witness ? await lookup.localGet('audit_entries', witness.audit_key) : null;
          if (!audit || !matchesResolutionWitness(audit.row, review.row)) semanticFail('MISSING_REVIEW_RESOLUTION_AUDIT');
        }
        cursor.reviewAfter = review.key; cursor.reviewsDone++; processed = 1;
      }
    } else fail('CURSOR_INVALID');

    db.reserve = 0;
    // This assert executes before all derived writes. A stale revision or lease
    // forces the transaction to abort; it cannot leave counters without cursor.
    const fence = db.prepare(`UPDATE archive_semantic_runs SET revision=CASE WHEN EXISTS(SELECT 1 ${activeFrom} WHERE ${activeWhere}
      AND r.status='running' AND r.revision=? AND r.lease_token=? AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN revision ELSE -1 END WHERE run_id=?`).bind(...args, run.revision, lease, run.run_id);
    const complete = phase === 'complete';
    const committed = await db.batch([
      fence, ...writes,
      ...(complete ? [db.prepare(`UPDATE archive_semantic_sessions SET status='verified' WHERE verification_id=? AND generation=? AND status='frozen' AND commit_token=? AND graph_sha256=?`).bind(handle.verificationId, handle.generation, handle.commitToken, handle.graphSha256)] : []),
      db.prepare(`UPDATE archive_semantic_runs SET status=?,phase=?,cursor_json=?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE run_id=? AND revision=? AND lease_token=? RETURNING revision`).bind(complete ? 'complete' : 'pending', phase, cursorText(cursor), now(), run.run_id, run.revision, lease),
    ]);
    if (committed.at(-1)!.results.length !== 1) fail('STALE');
    return response(complete ? 'complete' : 'pending', { phase, revision: Number(committed.at(-1)!.results[0].revision) }, processed);
  } catch (caught) {
    db.reserve = 0;
    let failure = caught;
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message.includes('backup_maintenance') || isArchiveStagingCapacityPause(caught) || isLifecyclePause(caught)) return response('paused', leased ?? saved);
    if (message.includes('SEMANTIC_VISIT_CLOSURE_BOUND')) failure = new Error('Invalid historical evidence: VISIT_CLOSURE_BOUND');
    if (leased) {
      const run = leased;
      const code = permanentCode(failure);
      if (code) {
        // The same-generation lease check prevents an old worker from revoking
        // authority after restoration or a different worker's takeover.
        const result = await db.batch([db.prepare(`UPDATE archive_semantic_runs SET status='invalid',error_code=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE run_id=? AND revision=? AND lease_token=? AND EXISTS(SELECT 1 ${activeFrom} WHERE ${activeWhere} AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING run_id`)
          .bind(code, now(), run.run_id, run.revision, run.lease_token, ...args),
          db.prepare(`UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL
            WHERE verification_id=? AND generation=? AND commit_token=? AND graph_sha256=? AND changes()=1
              AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=?)
              AND EXISTS(SELECT 1 FROM archive_semantic_runs WHERE run_id=? AND status='invalid' AND revision=?)`)
            .bind(handle.verificationId, handle.generation, handle.commitToken, handle.graphSha256, handle.generation, run.run_id, run.revision)]);
        if (!result[0].results.length) fail('STALE');
      } else {
        await db.batch([db.prepare(`UPDATE archive_semantic_runs SET status='pending',lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE run_id=? AND revision=? AND lease_token=? AND EXISTS(SELECT 1 ${activeFrom} WHERE ${activeWhere})`).bind(now(), run.run_id, run.revision, run.lease_token, ...args)]);
      }
    }
    throw failure;
  }
}
