import { ARCHIVE_TABLES, type ArchiveCounts } from '../shared/archive-format';
import { emptyArchiveCounts } from './archive-codec';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import type { ArchivePublicationBuildRow } from './archive-publication-schema';
import { appendLocatorDigest, type PublicationLocator } from './archive-publication-locators';
import { PUBLICATION_ABANDONMENT_BUILD_COLUMNS, archiveAbandonmentAuthoritySql, archiveAbandonmentLeaseSql,
  archiveAbandonmentSelectionSql, type ArchiveAbandonmentJobRow, type ArchiveAbandonmentCursor,
  type ArchiveAbandonmentTotals, type ArchiveAbandonmentPhase } from './archive-abandonment-schema';
import { ABANDONMENT_ZERO_HASH, abandonmentHash, abandonmentCatalogJson, addAbandonmentHash, abandonmentLocator,
  readAbandonmentCatalogPage, validateAbandonmentCatalogRow, type AbandonmentCatalog, type AbandonmentCatalogRow } from './archive-abandonment-catalog';

export type PublicationAbandonmentHandle = { abandonmentId: string; generation: string };
export type PublicationAbandonmentAdvance = {
  state: ArchiveAbandonmentJobRow['state']; phase: ArchiveAbandonmentPhase; revision: number; processed: number; busy: boolean;
};
type Selection = { expectedRevision: number };
type Progress = { version: 1; locatorDigest: string; locatorPage: PublicationLocator[]; counts: ArchiveCounts; partRecords: number };
const encoder = new TextEncoder();
const phases: ArchiveAbandonmentPhase[] = ['inventory_requests','inventory_records','inventory_parts','delete_requests','delete_records','delete_parts','complete'];
const cursorZero = (): ArchiveAbandonmentCursor => ({ request: '', recordPart: -1, recordOffset: -1, part: -1 });
const totalsZero = (): ArchiveAbandonmentTotals => ({ requests: 0, records: 0, parts: 0, requestSum: ABANDONMENT_ZERO_HASH, recordSum: ABANDONMENT_ZERO_HASH, partSum: ABANDONMENT_ZERO_HASH });
const progressZero = (): Progress => ({ version: 1, locatorDigest: ABANDONMENT_ZERO_HASH, locatorPage: [], counts: emptyArchiveCounts(), partRecords: 0 });
const sumKey = { requests: 'requestSum', records: 'recordSum', parts: 'partSum' } as const;
function fail(code: string): never { throw new Error(`ARCHIVE_ABANDONMENT_${code}`); }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
}
function handleCopy(value: PublicationAbandonmentHandle): Readonly<PublicationAbandonmentHandle> {
  const handle = Object.freeze({ ...value });
  if (!id(handle.abandonmentId) || !id(handle.generation)) fail('HANDLE_INVALID');
  return handle;
}
function revisionCopy(value: Selection): number {
  const revision = value.expectedRevision;
  if (!integer(revision)) fail('SELECTION_INVALID');
  return revision;
}
function outcome(row: ArchiveAbandonmentJobRow, processed = 0, busy = false): PublicationAbandonmentAdvance {
  return { state: row.state, phase: row.phase, revision: row.revision, processed, busy };
}
function buildJson(build: ArchivePublicationBuildRow): string {
  return JSON.stringify(Object.fromEntries(PUBLICATION_ABANDONMENT_BUILD_COLUMNS.map(column => [column,build[column]])));
}
function parse<T>(text: string, maximum: number): T {
  if (typeof text !== 'string' || encoder.encode(text).length > maximum) fail('PROGRESS_BOUND');
  try { return JSON.parse(text) as T; } catch { fail('PROGRESS_INVALID'); }
}
function totals(text: string): ArchiveAbandonmentTotals {
  const value = parse<unknown>(text,2048);
  if (!exact(value,Object.keys(totalsZero())) || !integer(value.requests,20_000) || !integer(value.records,20_000)
    || !integer(value.parts,512) || !hash(value.requestSum) || !hash(value.recordSum) || !hash(value.partSum)) fail('PROGRESS_INVALID');
  return value as ArchiveAbandonmentTotals;
}
async function readProgress(job: ArchiveAbandonmentJobRow) {
  const build = parse<ArchivePublicationBuildRow>(job.build_json,131_072);
  if (!exact(build,PUBLICATION_ABANDONMENT_BUILD_COLUMNS) || buildJson(build) !== job.build_json || await abandonmentHash(job.build_json) !== job.build_sha256
    || build.publication_id !== job.publication_id || build.state !== 'invalid' || build.lease_token !== null || build.lease_expires_at !== null
    || await abandonmentHash(build.header_json) !== build.header_sha256) fail('BUILD_INVALID');
  const cursor = parse<ArchiveAbandonmentCursor>(job.cursor_json,2048), progress = parse<Progress>(job.progress_json,8192);
  if (!exact(cursor,Object.keys(cursorZero())) || typeof cursor.request !== 'string' || cursor.request !== '' && !id(cursor.request)
    || !integer(cursor.recordPart,511,-1) || !integer(cursor.recordOffset,255,-1) || !integer(cursor.part,511,-1)
    || !exact(progress,Object.keys(progressZero())) || progress.version !== 1 || !hash(progress.locatorDigest)
    || !Array.isArray(progress.locatorPage) || progress.locatorPage.length > 8 || !integer(progress.partRecords,256)
    || !exact(progress.counts,ARCHIVE_TABLES) || ARCHIVE_TABLES.some(table => !integer(progress.counts[table],20_000))) fail('PROGRESS_INVALID');
  // appendLocatorDigest validates exact locator keys, bounds, order and bytes.
  if (progress.locatorPage.length) await appendLocatorDigest(progress.locatorDigest,progress.locatorPage);
  const observed = totals(job.observed_json), removed = totals(job.removed_json), inventory = job.inventory_json === null ? null : totals(job.inventory_json);
  for (const kind of ['requests','records','parts'] as const) {
    if (removed[kind] > (inventory?.[kind] ?? 0) || observed[kind] > (inventory?.[kind] ?? (kind === 'requests' ? build.request_count : kind === 'records' ? build.indexed_count : build.next_part + Number(build.next_offset > 0)))) fail('PROGRESS_INVALID');
  }
  if (!inventory && (removed.requests || removed.records || removed.parts) || job.phase.startsWith('delete_') && !inventory) fail('PROGRESS_INVALID');
  return { build,cursor,progress,observed,removed,inventory };
}
function keys(kind: AbandonmentCatalog, rows: AbandonmentCatalogRow[]): unknown[][] {
  return rows.map(row => kind === 'requests' ? [row.request_id] : kind === 'records' ? [row.table_name,row.record_key,row.part_index,row.part_offset] : [row.part_index]);
}
async function addRows(target: ArchiveAbandonmentTotals, kind: AbandonmentCatalog, rows: AbandonmentCatalogRow[]) {
  for (const row of rows) target[sumKey[kind]] = addAbandonmentHash(target[sumKey[kind]], await abandonmentHash(abandonmentCatalogJson(kind,row)));
  target[kind] += rows.length;
}
async function appendRecords(progress: Progress, cursor: ArchiveAbandonmentCursor, rows: AbandonmentCatalogRow[]) {
  for (const row of rows) {
    const locator = abandonmentLocator(row);
    if (locator.part === cursor.recordPart ? locator.offset !== cursor.recordOffset + 1
      : locator.part !== cursor.recordPart + 1 || locator.offset !== 0 || cursor.recordPart >= 0 && cursor.recordOffset + 1 !== progress.partRecords) fail('RECORD_ORDER_INVALID');
    const page = progress.locatorPage;
    if (page.length && (page.length === 8 || page[0].part !== locator.part || page.reduce((n,r) => n+r.recordBytes,0) + locator.recordBytes > 262_144)) {
      progress.locatorDigest = await appendLocatorDigest(progress.locatorDigest,page); progress.locatorPage = [];
    }
    progress.locatorPage.push(locator); progress.counts[locator.table]++;
    cursor.recordPart = locator.part; cursor.recordOffset = locator.offset; progress.partRecords = Number(row.part_indexed);
  }
}
async function finishInventory(kind: AbandonmentCatalog, data: Awaited<ReturnType<typeof readProgress>>) {
  const { observed,removed,inventory,build,progress,cursor } = data;
  if (inventory) {
    if (observed[kind] + removed[kind] !== inventory[kind]
      || addAbandonmentHash(observed[sumKey[kind]],removed[sumKey[kind]]) !== inventory[sumKey[kind]]) fail('REMAINING_INVENTORY_MISMATCH');
  } else {
    const expected = kind === 'requests' ? build.request_count : kind === 'records' ? build.indexed_count : build.next_part + Number(build.next_offset > 0);
    if (observed[kind] !== expected) fail('INVENTORY_MISMATCH');
    if (kind === 'records') {
      if (progress.locatorPage.length) { progress.locatorDigest = await appendLocatorDigest(progress.locatorDigest,progress.locatorPage); progress.locatorPage = []; }
      const counts = parse<ArchiveCounts>(build.counts_json,2048);
      if (progress.locatorDigest !== build.locator_digest || ARCHIVE_TABLES.some(table => counts[table] !== progress.counts[table])
        || cursor.recordPart >= 0 && cursor.recordOffset + 1 !== progress.partRecords) fail('LOCATOR_DIGEST_MISMATCH');
    }
  }
}

/** Admission is private and can only target an immutable invalid build which
 * has never acquired a committed publication descriptor. */
export async function startPublicationAbandonment<S extends ArchiveStagingStatement<S>>(
  db: ArchiveStagingDatabase<S>, publicationId: string, abandonmentId: string = crypto.randomUUID(),
): Promise<PublicationAbandonmentHandle> {
  if (!id(publicationId) || !id(abandonmentId)) fail('HANDLE_INVALID');
  const selected = await db.batch<ArchivePublicationBuildRow>([db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(publicationId)]);
  const build = selected[0].results[0];
  if (!build || build.state !== 'invalid' || build.lease_token !== null || build.lease_expires_at !== null) fail('BUILD_INELIGIBLE');
  const pinned = buildJson(build), fingerprint = await abandonmentHash(pinned);
  const rows = await db.batch<ArchiveAbandonmentJobRow>([
    db.prepare(`INSERT INTO archive_publication_abandonment_jobs(abandonment_id,publication_id,build_json,build_sha256,admission_generation,execution_generation,reason,state,phase,mode,revision,lease_token,lease_expires_at,cursor_json,observed_json,inventory_json,removed_json,progress_json,selection_json,pause_reason,created_at,updated_at,completed_at)
      SELECT ?,?,?,?,h.generation,h.generation,'invalid_unpublished','pending','inventory_requests','initial',0,NULL,NULL,?,?,NULL,?,?,'[]',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
      FROM history_runtime h WHERE h.id=1 AND h.state='ready' AND NOT EXISTS(SELECT 1 FROM archive_publication_abandonment_jobs WHERE abandonment_id=?)`)
      .bind(abandonmentId,publicationId,pinned,fingerprint,JSON.stringify(cursorZero()),JSON.stringify(totalsZero()),JSON.stringify(totalsZero()),JSON.stringify(progressZero()),abandonmentId),
    db.prepare('SELECT * FROM archive_publication_abandonment_jobs WHERE abandonment_id=?').bind(abandonmentId),
  ]);
  const row = rows[1].results[0];
  if (!row || row.publication_id !== publicationId || row.build_json !== pinned || row.build_sha256 !== fingerprint) fail('START_CONFLICT');
  return { abandonmentId,generation:row.execution_generation };
}

export async function advancePublicationAbandonment<S extends ArchiveStagingStatement<S>>(
  db: ArchiveStagingDatabase<S>, suppliedHandle: PublicationAbandonmentHandle, suppliedSelection: Selection,
): Promise<PublicationAbandonmentAdvance> {
  const handle = handleCopy(suppliedHandle), revision = revisionCopy(suppliedSelection), lease = crypto.randomUUID();
  const selectionSql = `CASE j.phase ${phases.filter(phase => phase !== 'complete').map(phase => `WHEN '${phase}' THEN ${archiveAbandonmentSelectionSql(phase)}`).join(' ')} ELSE '[]' END`;
  const initial = await db.batch<ArchiveAbandonmentJobRow & { current_authority?: number }>([
    db.prepare(`UPDATE archive_publication_abandonment_jobs AS j SET state='running',revision=revision+1,lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),selection_json=${selectionSql},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE abandonment_id=? AND execution_generation=? AND revision=? AND state IN ('pending','running') AND (lease_token IS NULL OR lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND ${archiveAbandonmentAuthoritySql()} RETURNING *`).bind(lease,handle.abandonmentId,handle.generation,revision),
    db.prepare(`SELECT j.*,CASE WHEN ${archiveAbandonmentAuthoritySql()} THEN 1 ELSE 0 END AS current_authority FROM archive_publication_abandonment_jobs j WHERE abandonment_id=? AND execution_generation=?`).bind(handle.abandonmentId,handle.generation),
  ]);
  const job = initial[1].results[0];
  if (!job) fail('STALE');
  if (!initial[0].results.length) {
    if ((job.state === 'pending' || job.state === 'running') && !job.current_authority) fail('AUTHORITY_UNAVAILABLE');
    return outcome(job,0,job.state === 'pending' || job.state === 'running');
  }
  const identity = [job.abandonment_id,job.execution_generation,job.revision,lease];
  const guard = `j.abandonment_id=? AND j.execution_generation=? AND j.revision=? AND j.lease_token=? AND ${archiveAbandonmentLeaseSql()}`;
  try {
    const data = await readProgress(job), { build,cursor,progress,observed,removed } = data;
    let inventory = data.inventory, phase = job.phase;
    if (phase === 'complete') fail('PHASE_INVALID');
    const scanning = phase.startsWith('inventory_'), kind = phase.slice(phase.indexOf('_')+1) as AbandonmentCatalog;
    const page = await readAbandonmentCatalogPage(db,kind,job.publication_id,scanning
      ? { request:cursor.request,part:kind === 'records' ? cursor.recordPart : cursor.part,offset:cursor.recordOffset }
      : { request:'',part:-1,offset:-1 });
    if (JSON.stringify(keys(kind,page)) !== job.selection_json) fail('SELECTION_CHANGED');
    for (const row of page) await validateAbandonmentCatalogRow(kind,row,build);
    const statements: S[] = [];
    if (scanning) {
      await addRows(observed,kind,page);
      if (kind === 'records' && !inventory) {
        await appendRecords(progress,cursor,page);
        if (observed.records === build.indexed_count && progress.locatorPage.length) {
          progress.locatorDigest = await appendLocatorDigest(progress.locatorDigest,progress.locatorPage);
          progress.locatorPage = [];
        }
      }
      else if (kind === 'records' && page.length) { cursor.recordPart = Number(page.at(-1)!.part_index); cursor.recordOffset = Number(page.at(-1)!.part_offset); }
      if (kind === 'requests' && page.length) cursor.request = String(page.at(-1)!.request_id);
      if (kind === 'parts' && page.length) {
        if (!inventory) for (const row of page) {
          if (row.part_index !== cursor.part+1 || row.indexed_count !== (Number(row.part_index) < build.next_part ? row.record_count : build.next_offset)) fail('PART_ORDER_INVALID');
          cursor.part = Number(row.part_index);
        }
        else cursor.part = Number(page.at(-1)!.part_index);
      }
      if (!page.length) {
        await finishInventory(kind,data);
        phase = phases[phases.indexOf(phase)+1];
        if (kind === 'parts' && !inventory) inventory = { ...observed };
      }
    } else {
      if (!inventory) fail('INVENTORY_REQUIRED');
      await addRows(removed,kind,page);
      if (removed[kind] > inventory[kind]) fail('REMOVAL_BOUND');
      if (page.length) {
        const fields = kind === 'requests' ? ['request_id'] : kind === 'records' ? ['table_name','record_key','part_index','part_offset'] : ['part_index'];
        const slots = page.map(() => `(${fields.map(() => '?').join(',')})`).join(',');
        const predicate = fields.length === 1 ? `${fields[0]} IN (${page.map(() => '?').join(',')})` : `(${fields.join(',')}) IN (VALUES ${slots})`;
        statements.push(db.prepare(`DELETE FROM archive_publication_${kind} WHERE publication_id=? AND ${predicate} AND EXISTS(SELECT 1 FROM archive_publication_abandonment_jobs j WHERE ${guard})`)
          .bind(job.publication_id,...page.flatMap(row => fields.map(field => row[field])),...identity));
        statements.push(db.prepare(`SELECT CASE WHEN changes()=${page.length} THEN 1 ELSE json_extract('ARCHIVE_ABANDONMENT_DELETE_STALE','$') END AS valid`));
      } else {
        if (removed[kind] !== inventory[kind] || removed[sumKey[kind]] !== inventory[sumKey[kind]]) fail('REMOVAL_MISMATCH');
        phase = phases[phases.indexOf(phase)+1];
      }
    }
    const complete = phase === 'complete';
    statements.push(db.prepare(`UPDATE archive_publication_abandonment_jobs AS j SET state=?,phase=?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,selection_json='[]',cursor_json=?,observed_json=?,inventory_json=?,removed_json=?,progress_json=?,completed_at=${complete ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'NULL'},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard} RETURNING *`)
      .bind(complete?'complete':'pending',phase,JSON.stringify(cursor),JSON.stringify(observed),inventory?JSON.stringify(inventory):null,JSON.stringify(removed),JSON.stringify(progress),...identity));
    statements.push(db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('ARCHIVE_ABANDONMENT_CHECKPOINT_STALE','$') END AS valid"));
    const committed = await db.batch<ArchiveAbandonmentJobRow>(statements), saved = committed[committed.length-2].results[0];
    if (!saved) fail('STALE');
    return outcome(saved,page.length);
  } catch (error) {
    try {
      await db.batch([db.prepare(`UPDATE archive_publication_abandonment_jobs SET state='pending',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,selection_json='[]',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE abandonment_id=? AND execution_generation=? AND revision=? AND lease_token=? AND state='running'`).bind(...identity)]);
    } catch { /* Preserve the failure; reset and maintenance never regain deletion authority. */ }
    throw error;
  }
}

/** Explicit rebind only admits a new bounded inventory pass. Every remaining
 * row must match the original inventory minus committed removal receipts. */
export async function resumePublicationAbandonment<S extends ArchiveStagingStatement<S>>(
  db: ArchiveStagingDatabase<S>, suppliedHandle: PublicationAbandonmentHandle, suppliedSelection: Selection,
): Promise<PublicationAbandonmentHandle> {
  const handle = handleCopy(suppliedHandle), revision = revisionCopy(suppliedSelection);
  const rows = await db.batch<ArchiveAbandonmentJobRow>([
    db.prepare(`UPDATE archive_publication_abandonment_jobs AS j SET execution_generation=(SELECT generation FROM history_runtime WHERE id=1 AND state='ready'),state='pending',phase='inventory_requests',mode='resume',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,selection_json='[]',cursor_json=?,observed_json=?,progress_json=?,pause_reason=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE abandonment_id=? AND execution_generation=? AND revision=? AND state='paused' AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND state='ready' AND generation!=j.execution_generation) RETURNING *`)
      .bind(JSON.stringify(cursorZero()),JSON.stringify(totalsZero()),JSON.stringify(progressZero()),handle.abandonmentId,handle.generation,revision),
    db.prepare('SELECT * FROM archive_publication_abandonment_jobs WHERE abandonment_id=?').bind(handle.abandonmentId),
  ]);
  const row = rows[1].results[0];
  if (!row || !rows[0].results.length) fail('RESUME_CONFLICT');
  return { abandonmentId:row.abandonment_id,generation:row.execution_generation };
}
