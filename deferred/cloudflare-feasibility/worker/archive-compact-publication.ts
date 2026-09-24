import { digest } from './backup-crypto';
import { readCompletedMonthlySemanticProof, type MonthlySemanticRunHandle } from './archive-semantic-runner';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import { COMPACT_PROOF_COLUMNS, COMPACT_PUBLICATION_LIMITS, compactLeaseSql, compactMaintenanceSql, compactPageSql, compactProofSql, type CompactPublicationBuild, type CompactPublicationPhase } from './archive-compact-schema';

export type CompactMonthlyPublicationHandle = { publicationId: string; generation: string };
export type CompactMonthlyPublicationAdvance = { state: 'building' | 'published' | 'invalid'; phase: CompactPublicationPhase; revision: number; processed: number; busy: boolean };
function fail(code: string): never { throw new Error(`ARCHIVE_COMPACT_${code}`); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value); }
function result(row: CompactPublicationBuild, processed = 0, busy = false): CompactMonthlyPublicationAdvance {
  return { state: row.state, phase: row.phase, revision: row.revision, processed, busy };
}
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const assertChanged = "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('ARCHIVE_COMPACT_STALE','$') END AS committed";

/** Internal writer. Reuses the authenticated complete frozen semantic graph;
 * it does not attest that R2 objects will remain available after publication. */
export async function startCompactMonthlyPublication<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, supplied: MonthlySemanticRunHandle, publicationId: string = crypto.randomUUID()): Promise<CompactMonthlyPublicationHandle> {
  if (!identifier(publicationId)) fail('HANDLE_INVALID');
  const { handle, header, rootReferenceJson } = await readCompletedMonthlySemanticProof(db, supplied);
  if (header.recordCount > COMPACT_PUBLICATION_LIMITS.records) fail('RECORD_BOUND');
  const headerJson = JSON.stringify(header), headerSha = await digest(new TextEncoder().encode(headerJson));
  const rows = await db.batch<CompactPublicationBuild>([
    db.prepare(`INSERT INTO archive_compact_builds(${COMPACT_PROOF_COLUMNS.join(',')},state,phase,after_key,verified_events,verified_corrections,verified_audits,revision,lease_token,lease_expires_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,1,?,?,?,?,?,?,?,m.part_count,?,2,'building','events','',0,0,0,0,NULL,NULL,${now},${now}
      FROM archive_semantic_manifests m WHERE m.verification_id=? AND m.generation=? AND m.archive_id=? AND NOT EXISTS(SELECT 1 FROM archive_compact_builds WHERE publication_id=?)`)
      .bind(publicationId,handle.verificationId,handle.generation,handle.runId,handle.commitToken,handle.graphSha256,
        header.archiveId,header.centerId,header.month,header.timezone,rootReferenceJson,headerJson,headerSha,header.recordCount,handle.verificationId,handle.generation,header.archiveId,publicationId),
    db.prepare('SELECT * FROM archive_compact_builds WHERE publication_id=?').bind(publicationId),
  ]);
  const row = rows[1].results[0];
  if (!row || row.verification_id !== handle.verificationId || row.generation !== handle.generation || row.run_id !== handle.runId || row.snapshot_commit_token !== handle.commitToken || row.graph_sha256 !== handle.graphSha256 || row.header_json !== headerJson || row.header_sha256 !== headerSha || row.root_reference_json !== rootReferenceJson || row.state === 'invalid') fail('START_CONFLICT');
  return Object.freeze({ publicationId, generation: handle.generation });
}

export async function advanceCompactMonthlyPublication<S extends ArchiveStagingStatement<S>>(db: ArchiveStagingDatabase<S>, supplied: CompactMonthlyPublicationHandle, selection: { expectedRevision: number }): Promise<CompactMonthlyPublicationAdvance> {
  const handle = Object.freeze({ ...supplied });
  const expectedRevision = selection.expectedRevision;
  if (!identifier(handle.publicationId) || !identifier(handle.generation) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('HANDLE_INVALID');
  const leaseToken = crypto.randomUUID();
  const acquired = await db.batch<CompactPublicationBuild>([
    db.prepare(`UPDATE archive_compact_builds AS b SET state='invalid',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now}
      WHERE b.publication_id=? AND b.generation=? AND b.revision=? AND b.state='building' AND NOT (${compactProofSql()}) AND ${compactMaintenanceSql()}`)
      .bind(handle.publicationId,handle.generation,expectedRevision),
    db.prepare(`UPDATE archive_compact_builds AS b SET revision=revision+1,lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=${now}
      WHERE b.publication_id=? AND b.generation=? AND b.revision=? AND b.state='building' AND (b.lease_token IS NULL OR b.lease_expires_at<=${now}) AND ${compactProofSql()} AND ${compactMaintenanceSql()} RETURNING *`)
      .bind(leaseToken,handle.publicationId,handle.generation,expectedRevision),
    db.prepare('SELECT * FROM archive_compact_builds WHERE publication_id=? AND generation=?').bind(handle.publicationId,handle.generation),
  ]);
  const build = acquired[1].results[0], saved = acquired[2].results[0];
  if (!saved) fail('NOT_FOUND');
  if (!build) return result(saved,0,saved.state === 'building');
  const identity = [build.publication_id,build.generation,build.revision,leaseToken];
  const guard = `b.publication_id=? AND b.generation=? AND b.revision=? AND b.lease_token=? AND ${compactLeaseSql()}`;
  try {
    if (build.phase === 'complete') {
      const written = await db.batch<CompactPublicationBuild>([
        db.prepare(`INSERT INTO archive_compact_publications(${COMPACT_PROOF_COLUMNS.join(',')},request_count,counts_json,published_at)
          SELECT ${COMPACT_PROOF_COLUMNS.map(c=>`b.${c}`).join(',')},b.verified_events+b.verified_corrections,json_extract(b.header_json,'$.recordCounts'),${now}
          FROM archive_compact_builds b WHERE ${guard}`).bind(...identity),
        db.prepare(assertChanged),
        db.prepare('SELECT * FROM archive_compact_builds WHERE publication_id=?').bind(build.publication_id),
      ]);
      const next = written[2].results[0];
      if (!next || next.state !== 'published') fail('STALE');
      return result(next);
    }
    const selected = await db.batch<{ keys_json: string }>([
      db.prepare(`SELECT (SELECT json_group_array(record_key) FROM (${compactPageSql()})) AS keys_json FROM archive_compact_builds b WHERE ${guard}`).bind(...identity),
    ]);
    if (!selected[0].results[0]) fail('STALE');
    const keys: unknown = JSON.parse(selected[0].results[0].keys_json);
    if (!Array.isArray(keys) || keys.length > COMPACT_PUBLICATION_LIMITS.pageRecords || keys.some(key=>typeof key !== 'string')) fail('PAGE_INVALID');
    const statements: S[] = [];
    if (build.phase === 'events' || build.phase === 'corrections') {
      for (const key of keys) statements.push(db.prepare(`INSERT INTO archive_compact_requests(request_id,publication_id) SELECT ?,b.publication_id FROM archive_compact_builds b WHERE ${guard}`).bind(key,...identity));
    }
    if (keys.length) {
      const counter = ({ events: 'verified_events', corrections: 'verified_corrections', audit: 'verified_audits' } as const)[build.phase];
      statements.push(db.prepare(`UPDATE archive_compact_builds AS b SET after_key=?,${counter}=${counter}+?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now} WHERE ${guard} RETURNING *`).bind(keys.at(-1),keys.length,...identity));
    } else {
      const nextPhase = ({ events: 'corrections', corrections: 'audit', audit: 'complete' } as const)[build.phase];
      statements.push(db.prepare(`UPDATE archive_compact_builds AS b SET phase=?,after_key='',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now} WHERE ${guard} RETURNING *`).bind(nextPhase,...identity));
    }
    statements.push(db.prepare(assertChanged));
    const written = await db.batch<CompactPublicationBuild>(statements), next = written.at(-2)?.results[0];
    if (!next) fail('STALE');
    return result(next,keys.length);
  } catch (error) {
    // Exact token/revision release cannot clear a successor's lease. All failed
    // page inserts roll back with the checkpoint's in-transaction assertion.
    try {
      await db.batch([db.prepare(`UPDATE archive_compact_builds SET revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now}
        WHERE publication_id=? AND generation=? AND revision=? AND lease_token=? AND state='building'`).bind(...identity)]);
    } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
