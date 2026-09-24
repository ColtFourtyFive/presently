import type { ArchiveRecord, ArchiveTable } from '../shared/archive-format';
import type { ArchiveSemanticBatchStore, ArchiveSemanticHeader, ArchiveSemanticLookupReference } from './archive-semantic-store';
import { validateSemanticShape, type SemanticLookup } from './archive-semantic-rules';

/** One-step cache for a single frozen monthly base. In this scope find and
 * localGet address the same immutable publication. Nothing survives the step. */
export function createMonthlySemanticLookup(header: ArchiveSemanticHeader, store: ArchiveSemanticBatchStore): SemanticLookup & { prefetch(record: ArchiveRecord): Promise<void> } {
  const cache = new Map<string, ArchiveRecord | null>();
  const identity = (table: ArchiveTable, key: string) => JSON.stringify([table, key]);
  const get = async (table: ArchiveTable, key: string): Promise<ArchiveRecord | null> => {
    const id = identity(table, key);
    const record = cache.has(id) ? cache.get(id)! : await store.get(header.archiveId, table, key);
    if (record) validateSemanticShape(record, header, table, key);
    if (cache.size < 12) cache.set(id, record);
    return record;
  };
  return {
    find: async (table, key) => {
      if (typeof key !== 'string' || !key) throw new Error('Invalid historical evidence: INVALID_REFERENCE');
      return get(table, key);
    },
    localGet: get,
    prefetch: async record => {
      validateSemanticShape(record, header);
      const row = record.row;
      cache.set(identity(record.table, record.key), record);
      const references = new Map<string, ArchiveSemanticLookupReference>();
      const add = (table: ArchiveTable, key: unknown) => {
        if (typeof key !== 'string' || !key) return;
        const id = identity(table, key);
        if (!cache.has(id)) references.set(id, { archiveId: header.archiveId, table, key });
      };
      if (record.table === 'student_guardians') { add('students', row.student_id); add('guardians', row.guardian_id); }
      if (record.table === 'visits') {
        add('students', row.student_id); add('staff', row.check_in_by); add('staff', row.check_out_by); add('guardians', row.guardian_id);
      }
      if (record.table === 'attendance_events') {
        add('students', row.student_id); add('staff', row.actor_id); add('guardians', row.guardian_id);
        if (row.guardian_id !== null) add('student_guardians', JSON.stringify([row.student_id, row.guardian_id]));
        add('visits', row.visit_id); add('audit_entries', row.id); add('attendance_corrections', row.id);
        if (row.action === 'exceptional_departure') add('reviews', row.id);
      }
      if (record.table === 'attendance_corrections') {
        add('visits', row.visit_id); add('staff', row.actor_id); add('audit_entries', row.id); add('attendance_events', row.id);
      }
      if (record.table === 'reviews') {
        add('attendance_events', row.event_id);
        if (row.status === 'resolved') add('staff', row.resolved_by);
      }
      if (record.table === 'audit_entries') {
        add('staff', row.actor_id);
        const target = ({ attendance_event: 'attendance_events', visit: 'visits', review: 'reviews' } as const)[String(row.entity_type) as 'visit'];
        if (target) add(target, row.entity_id);
        if (['check_in', 'check_out', 'exceptional_departure'].includes(String(row.action))) add('attendance_events', row.id);
        else if (row.action === 'attendance_correction') add('attendance_corrections', row.id);
        if (row.action === 'review_resolved') add('reviews', row.entity_id);
      }
      const pending = [...references.values()];
      if (!pending.length) return;
      const records = await store.getMany(pending);
      if (records.length !== pending.length) throw new Error('ARCHIVE_STAGING_LOOKUP_RESULT_COUNT');
      for (let index = 0; index < pending.length; index++) cache.set(identity(pending[index].table, pending[index].key), records[index]);
    },
  };
}
