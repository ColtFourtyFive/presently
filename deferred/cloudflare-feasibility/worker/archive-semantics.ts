import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS as LIMIT, ARCHIVE_TABLES, type ArchiveManifest, type ArchiveRecord, type ArchiveRow, type ArchiveSemanticStore, type ArchiveTable } from '../shared/archive-format';
import { applyVisitOperation, canonicalSemanticValue as canonical, failSemantic as fail, finishVisitFold, initialVisitFold, matchesResolutionWitness, semanticOperation, validateSemanticRecord, validateSemanticShape as shape } from './archive-semantic-rules';

const immutable = new Set<ArchiveTable>(['attendance_events', 'attendance_corrections', 'audit_entries']);
/** The store contains only private, authenticated archive staging, not live rows.
 * Memory is bounded by one page, graph metadata, and one capped visit closure.
 * This checks semantic consistency; it does not authorize eviction or prove that
 * the producer selected every eligible record from the original database.
 * Bounded memory does not establish one-invocation Worker CPU/subrequest limits;
 * production use needs checkpointed work or separately measured supported caps. */
export async function verifyArchiveSemantics(manifests: readonly ArchiveManifest[], store: ArchiveSemanticStore): Promise<void> {
  if (!manifests.length || manifests.length > LIMIT.graphArchives) fail('GRAPH_BOUND');
  const first = manifests[0];
  for (const [index, manifest] of manifests.entries()) {
    if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.semanticProof?.version !== 1 || manifest.centerId !== first.centerId || manifest.month !== first.month || manifest.timezone !== first.timezone) fail('SEMANTIC_GRAPH_VERSION');
    if (index === 0 ? manifest.kind !== 'monthly' || manifest.references.length !== 0 : manifest.kind !== 'addendum' || manifest.references.length !== 1 || manifest.references[0].archiveId !== manifests[index - 1].archiveId) fail('UNSUPPORTED_GRAPH_BRANCH');
  }
  async function* scan(index: number, table: ArchiveTable, relation?: { column: 'visit_id' | 'event_id' | 'entity_id'; value: string }) {
    let after = '', total = 0;
    for (;;) {
      const rows = await store.page({ archiveId: manifests[index].archiveId, table, after, limit: LIMIT.semanticPageRecords, ...(relation ? { relation } : {}) });
      if (!Array.isArray(rows) || rows.length > LIMIT.semanticPageRecords) fail('STAGING_PAGE_BOUND');
      for (const record of rows) {
        shape(record, manifests[index], table);
        if (record.key <= after || relation && record.row[relation.column] !== relation.value) fail('STAGING_PAGE_ORDER');
        after = record.key; if (++total > manifests[index].recordCounts[table]) fail('STAGING_RECORD_COUNT');
        yield record;
      }
      if (rows.length < LIMIT.semanticPageRecords) break;
    }
    if (!relation && total !== manifests[index].recordCounts[table]) fail('STAGING_RECORD_COUNT');
  }
  async function find(index: number, table: ArchiveTable, key: unknown): Promise<ArchiveRecord | null> {
    if (typeof key !== 'string') return fail('INVALID_REFERENCE');
    for (let source = index; source >= 0; source--) {
      const row = await store.get(manifests[source].archiveId, table, key);
      if (row) { shape(row, manifests[source], table, key); return row; }
    }
    return null;
  }
  async function requireRecord(index: number, table: ArchiveTable, key: unknown): Promise<ArchiveRow> {
    const record = await find(index, table, key); if (!record) return fail('MISSING_RELATION'); return record.row;
  }
  async function visitState(index: number, visit: ArchiveRow) {
    const operations = new Map<string, { record: ArchiveRecord; version: number }>(); let bytes = 0;
    for (let source = 0; source <= index; source++) for (const table of ['attendance_events', 'attendance_corrections'] as const) for await (const record of scan(source, table, { column: 'visit_id', value: String(visit.id) })) {
      const existing = operations.get(record.key);
      if (existing) { if (canonical(existing.record) !== canonical(record)) fail('CONFLICTING_IMMUTABLE_RECORD'); continue; }
      const operation = semanticOperation(record);
      if (!operation) fail('MISSING_ARRIVAL');
      bytes += operation.bytes;
      if (operations.size >= LIMIT.semanticVisitOperations || bytes > LIMIT.semanticVisitBytes) fail('VISIT_CLOSURE_BOUND');
      operations.set(record.key, { record, version: operation.version });
    }
    let state = initialVisitFold();
    for (const step of [...operations.values()].sort((a, b) => a.version - b.version)) state = applyVisitOperation(state, visit, step.record);
    finishVisitFold(state, visit, manifests[index]);
  }
  for (const [index, manifest] of manifests.entries()) {
    await requireRecord(index, 'centers', manifest.centerId);
    for (const table of ARCHIVE_TABLES) for await (const record of scan(index, table)) {
      const row = record.row;
      if (index && immutable.has(table)) {
        const prior = await find(index - 1, table, record.key);
        if (prior && canonical(prior) !== canonical(record)) fail('CONFLICTING_IMMUTABLE_RECORD');
      }
      await validateSemanticRecord(record, manifest, {
        find: (table, key) => find(index, table, key),
        localGet: (table, key) => store.get(manifest.archiveId, table, key),
      });
      if (table === 'visits') await visitState(index, row);
      if (table === 'reviews') {
        if (row.status === 'resolved') {
          let matched = false;
          for (let source = 0; source <= index; source++) for await (const audit of scan(source, 'audit_entries', { column: 'entity_id', value: String(row.id) })) {
            if (matchesResolutionWitness(audit.row, row)) matched = true;
          }
          if (!matched) fail('MISSING_REVIEW_RESOLUTION_AUDIT');
        }
        if (index) {
          const prior = await find(index - 1, 'reviews', row.id);
          if (prior && (['id', 'center_id', 'event_id', 'visit_id', 'student_id', 'reason', 'created_at'].some(field => prior.row[field] !== row[field]) || prior.row.status === 'resolved' && canonical(prior.row) !== canonical(row))) fail('REVIEW_VERSION_CHAIN');
        }
      }
    }
  }
}
