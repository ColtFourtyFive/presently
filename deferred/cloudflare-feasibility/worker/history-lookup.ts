/** Shadow authority only. Live attendance remains the read/retry authority until
 * archive publication, historical lookup and deletion have their own validation. */
type HistoryDatabase = Pick<D1Database, 'prepare' | 'batch'>;
type Source = 'events' | 'corrections' | 'audits' | 'visits';
type Job = { source: Source; generation: string; cursor: string | null; processed: number; status: 'pending' | 'complete' };
export type HistoryLookupStatus = { generation: string; state: 'backfilling' | 'ready'; jobs: Job[] };
export type HistoryBackfillResult = { generation: string; state: 'backfilling' | 'ready' | 'paused'; source?: Source; processed: number };

const sources = ['events', 'corrections', 'audits', 'visits'] as const;
const tables: Record<Source, string> = { events: 'attendance_events', corrections: 'attendance_corrections', audits: 'audit_entries', visits: 'visits' };
const headFields = ['center_id', 'student_id', 'original_check_in_at', 'original_check_out_at', 'check_in_at', 'check_out_at', 'version', 'review_status'];

function hashEncoding(expression: string) {
  // This describes the stored representation, not verified payload semantics.
  return `CASE WHEN length(${expression})=64 AND ${expression} NOT GLOB '*[^0-9a-fA-F]*' THEN 'hex-sha256'
    WHEN length(${expression})=44 AND substr(${expression},44,1)='=' AND substr(${expression},1,43) NOT GLOB '*[^A-Za-z0-9+/]*' THEN 'base64-sha256'
    WHEN length(${expression})=43 AND ${expression} NOT GLOB '*[^A-Za-z0-9_-]*' THEN 'base64url-sha256' ELSE 'opaque' END`;
}

export async function readHistoryLookupStatus(db: HistoryDatabase): Promise<HistoryLookupStatus> {
  // One transaction avoids observing half of a recovery generation reset.
  const results = await db.batch([
    db.prepare('SELECT generation,state FROM history_runtime WHERE id=1'),
    db.prepare('SELECT source,generation,cursor,processed,status FROM history_backfill_jobs ORDER BY source'),
  ]);
  const runtime = results[0].results[0] as { generation: string; state: HistoryLookupStatus['state'] } | undefined;
  const jobs = results[1].results as Job[];
  if (!runtime || jobs.length !== sources.length || sources.some(source => !jobs.some(j => j.source === source)) ||
      jobs.some(job => job.generation !== runtime.generation) ||
      (runtime.state === 'ready' && jobs.some(job => job.status !== 'complete'))) {
    throw new Error('HISTORY_RUNTIME_RECONCILIATION_REQUIRED');
  }
  return { ...runtime, jobs };
}

/** Work is bounded by explicit primary-key pages. Only IDs cross the transaction
 * boundary: projections always read current source rows inside the write batch. */
export async function advanceHistoryBackfill(db: HistoryDatabase, pageSize = 100): Promise<HistoryBackfillResult> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('HISTORY_PAGE_SIZE_INVALID');
  const status = await readHistoryLookupStatus(db);
  const result = (state: HistoryBackfillResult['state'], processed = 0, source?: Source): HistoryBackfillResult => ({ state, generation: status.generation, processed, ...(source ? { source } : {}) });
  if (status.state === 'ready') return result('ready');
  const job = sources.map(source => status.jobs.find(j => j.source === source)!).find(j => j.status === 'pending');
  if (!job) throw new Error('HISTORY_RUNTIME_RECONCILIATION_REQUIRED');
  if (await db.prepare("SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')").first()) return result('paused');

  const table = tables[job.source];
  const page = await db.prepare(`SELECT id FROM ${table} ${job.cursor === null ? '' : 'WHERE id>?'} ORDER BY id LIMIT ?`)
    .bind(...(job.cursor === null ? [pageSize] : [job.cursor, pageSize])).all<{ id: string }>();
  const ids = page.results.map(row => row.id);
  const pageJson = JSON.stringify(ids);
  const from = `${table} s JOIN json_each(?) selected ON s.id=selected.value`;
  const statements: D1PreparedStatement[] = [
    // A stale call rolls the entire batch back, including all projection writes.
    db.prepare(`UPDATE history_runtime SET state=CASE WHEN generation=? AND state='backfilling' AND EXISTS(
      SELECT 1 FROM history_backfill_jobs WHERE source=? AND generation=? AND cursor IS ? AND processed=? AND status='pending'
    ) THEN state ELSE 'stale' END WHERE id=1`).bind(status.generation, job.source, job.generation, job.cursor, job.processed),
    db.prepare(`UPDATE history_runtime SET state=CASE WHEN (SELECT count(*) FROM ${from})=? THEN state ELSE 'invalid_projection' END WHERE id=1`).bind(pageJson, ids.length),
  ];

  if (job.source === 'visits') {
    statements.push(db.prepare(`INSERT INTO history_visit_heads(visit_id,${headFields.join(',')},residency)
      SELECT s.id,${headFields.map(field => `s.${field}`).join(',')},'live' FROM ${from}
      WHERE NOT EXISTS(SELECT 1 FROM history_visit_heads h WHERE h.visit_id=s.id)`).bind(pageJson));
    statements.push(db.prepare(`UPDATE history_runtime SET state=CASE WHEN NOT EXISTS(
      SELECT 1 FROM ${from} LEFT JOIN history_visit_heads h ON h.visit_id=s.id
      WHERE h.visit_id IS NULL OR h.residency!='live' OR ${headFields.map(field => `h.${field} IS NOT s.${field}`).join(' OR ')}
    ) THEN state ELSE 'invalid_projection' END WHERE id=1`).bind(pageJson));
  } else {
    const kind = job.source === 'events' ? 'event' : job.source === 'corrections' ? 'correction' : 'audit';
    const hash = kind === 'audit' ? 'NULL' : 's.payload_hash';
    const encoding = kind === 'audit' ? "'none'" : hashEncoding(hash);
    // Old physical aliases may even disagree about center. The immutable source
    // owns the request globally; preserve those physical rows without reserving twice.
    // An audit row can be the physical alias of an event or correction. The
    // permanent request map remains authoritative after those source rows are
    // archived, so recovery backfill must not reclassify the alias as a
    // standalone audit merely because the live source row is absent.
    const eligible = kind === 'audit' ? `NOT EXISTS(SELECT 1 FROM attendance_events e WHERE e.id=s.id)
      AND NOT EXISTS(SELECT 1 FROM attendance_corrections c WHERE c.id=s.id)
      AND NOT EXISTS(SELECT 1 FROM history_request_keys owner
        WHERE owner.request_id=s.id AND owner.source_kind IN ('event','correction'))` : '1';
    statements.push(db.prepare(`INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding)
      SELECT s.id,'${kind}',s.center_id,${hash},${encoding} FROM ${from}
      WHERE ${eligible} AND NOT EXISTS(SELECT 1 FROM history_request_keys k WHERE k.request_id=s.id)`).bind(pageJson));
    statements.push(db.prepare(`UPDATE history_runtime SET state=CASE WHEN NOT EXISTS(
      SELECT 1 FROM ${from} LEFT JOIN history_request_keys k ON k.request_id=s.id
      WHERE (${eligible}) AND (k.request_id IS NULL OR k.source_kind!='${kind}' OR k.center_id IS NOT s.center_id
        OR k.payload_hash IS NOT ${hash} OR k.hash_encoding IS NOT (${encoding}) OR k.canonicalization!='legacy-unverified')
    ) THEN state ELSE 'invalid_projection' END WHERE id=1`).bind(pageJson));
  }

  const nextCursor = ids.at(-1) ?? job.cursor;
  statements.push(db.prepare(`UPDATE history_backfill_jobs SET cursor=?,processed=processed+?,status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source=?`)
    .bind(nextCursor, ids.length, ids.length < pageSize ? 'complete' : 'pending', job.source));
  statements.push(db.prepare(`UPDATE history_runtime SET state=CASE WHEN NOT EXISTS(
    SELECT 1 FROM history_backfill_jobs WHERE status!='complete' OR generation!=history_runtime.generation
  ) THEN 'ready' ELSE 'backfilling' END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`));

  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('backup_maintenance')) return result('paused');
    if (message.includes('HISTORY_BACKFILL_STALE')) {
      const current = await readHistoryLookupStatus(db);
      return { state: current.state, generation: current.generation, processed: 0 };
    }
    throw error;
  }
  const current = await readHistoryLookupStatus(db);
  return { state: current.state, generation: current.generation, source: job.source, processed: ids.length };
}
