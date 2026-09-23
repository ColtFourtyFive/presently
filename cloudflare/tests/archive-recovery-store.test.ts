import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveRecord, type ArchiveSemanticQuery } from '../shared/archive-format';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { createRecoverySemanticStore, RECOVERY_SEMANTIC_STORE_LIMITS } from '../scripts/archive-recovery-store';

type Store = Awaited<ReturnType<typeof createRecoverySemanticStore>>;
let directory: string, database: string;
let stores: Store[];
const master = randomBytes(32).toString('base64');
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'kumon-recovery-store-test-')); database = join(directory, 'private.sqlite'); stores = []; });
afterEach(async () => { for (const store of stores) store.close(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const student = (key: string, extra: ArchiveRecord['row'] = {}): ArchiveRecord => ({ table: 'students', key, row: { id: key, center_id: 'test-center', student_code: key, first_name: 'Synthetic', last_name: 'Recovery', active: 1, subjects: '["math"]', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z', ...extra } });
const query = (archiveId: string, extra: Partial<ArchiveSemanticQuery> = {}): ArchiveSemanticQuery => ({ archiveId, table: 'students', after: '', limit: 64, ...extra });
async function open(signal?: AbortSignal) { const store = await createRecoverySemanticStore(database, { signal }); stores.push(store); return store; }
async function archive(records: ArchiveRecord[], archiveId = 'recovery-base'): Promise<ArchiveManifest> {
  records.sort(compareArchiveRecords);
  const created = await createArchive(master, { archiveId, centerId: 'test-center', month: '2025-01', timezone: 'UTC', kind: 'monthly', createdAt: '2025-02-01T00:00:00.000Z', applicationVersion: 'private-recovery-test', schemaVersions: [24], references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64-or-hex', deviceContexts: [] } }, records, async () => {});
  return created.manifest;
}
async function stage(store: Store, records: ArchiveRecord[], archiveId = 'recovery-base') {
  const manifest = await archive(records, archiveId);
  let offset = 0;
  for (const part of manifest.parts) { await store.stagePart(records.slice(offset, offset + part.recordCount), part, manifest); offset += part.recordCount; }
  return manifest;
}

describe('independent private archive recovery store', () => {
  it('creates a private detached database, refuses replacement and never edits existing targets', async () => {
    const store = await open();
    expect((await stat(database)).mode & 0o777).toBe(0o600);
    await expect(createRecoverySemanticStore(database)).rejects.toThrow();
    const sentinel = join(directory, 'sentinel');
    await writeFile(sentinel, 'keep this original', { mode: 0o600 });
    await expect(createRecoverySemanticStore(sentinel)).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('keep this original');
    const link = join(directory, 'symlink.sqlite');
    await symlink(sentinel, link);
    await expect(createRecoverySemanticStore(link)).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('keep this original');
    expect(await store.get('missing-archive', 'students', 'missing-student')).toBeNull();
  });

  it('pages in stable exclusive-key order and separates archives and tables', async () => {
    const store = await open();
    const records = Array.from({ length: 140 }, (_, index) => student(`student-${String(index).padStart(3, '0')}`));
    records.push({ table: 'guardians', key: 'student-003', row: { id: 'student-003', center_id: 'test-center', display_name: 'Different table', created_at: '2025-01-01T00:00:00.000Z' } });
    await stage(store, records);
    await stage(store, [student('student-003', { first_name: 'Different archive' })], 'recovery-other');
    const first = await store.page(query('recovery-base'));
    const second = await store.page(query('recovery-base', { after: first.at(-1)!.key }));
    const third = await store.page(query('recovery-base', { after: second.at(-1)!.key }));
    expect([first.length, second.length, third.length]).toEqual([64, 64, 12]);
    expect([...first, ...second, ...third].map(record => record.key)).toEqual(records.filter(record => record.table === 'students').map(record => record.key));
    expect(await store.page(query('recovery-base', { after: 'student-139' }))).toEqual([]);
    expect((await store.page(query('recovery-base', { after: 'student-002', limit: 1 })))[0].key).toBe('student-003');
    expect((await store.get('recovery-other', 'students', 'student-003'))?.row.first_name).toBe('Different archive');
    expect((await store.get('recovery-base', 'guardians', 'student-003'))?.row.display_name).toBe('Different table');
    expect(await store.get('recovery-base', 'students', 'student-999')).toBeNull();
  });

  it('applies exact visit, event and entity relations before paging', async () => {
    const store = await open();
    const records: ArchiveRecord[] = [];
    for (let index = 0; index < 140; index++) {
      const suffix = String(index).padStart(3, '0');
      records.push({ table: 'reviews', key: `review-${suffix}`, row: { id: `review-${suffix}`, center_id: 'test-center', event_id: index % 3 ? 'event-other' : 'event-selected', visit_id: index % 2 ? null : 'visit-selected', student_id: 'student-001', reason: 'Synthetic', status: 'open', created_at: '2025-01-01T00:00:00.000Z', resolved_at: null, resolved_by: null, resolution: null } });
      records.push({ table: 'audit_entries', key: `audit-${suffix}`, row: { id: `audit-${suffix}`, center_id: 'test-center', actor_id: null, actor_name: 'Synthetic', action: 'test', entity_type: 'visit', entity_id: index % 5 ? 'entity-other' : 'entity-selected', detail: '{}', created_at: '2025-01-01T00:00:00.000Z' } });
    }
    await stage(store, records);
    for (const [table, column, value] of [['reviews', 'visit_id', 'visit-selected'], ['reviews', 'event_id', 'event-selected'], ['audit_entries', 'entity_id', 'entity-selected']] as const) {
      const expected = records.filter(record => record.table === table && record.row[column] === value);
      const first = await store.page(query('recovery-base', { table, relation: { column, value } }));
      const second = await store.page(query('recovery-base', { table, after: first.at(-1)!.key, relation: { column, value } }));
      expect([...first, ...second]).toEqual(expected);
      expect(await store.page(query('recovery-base', { table, relation: { column, value: 'unmatched' } }))).toEqual([]);
    }
  });

  it('persists copies before resolving and returns independently decoded records', async () => {
    const store = await open();
    const records = [student('student-001')];
    const manifest = await archive(records);
    const expected = structuredClone(records[0]);
    const pending = store.stagePart(records, manifest.parts[0], manifest);
    records[0].row.first_name = 'Mutated caller';
    records.push(student('student-002'));
    await pending;
    const found = await store.get(manifest.archiveId, 'students', 'student-001');
    expect(found).toEqual(expected);
    found!.row.first_name = 'Mutated result';
    const page = await store.page(query(manifest.archiveId));
    expect(page).toEqual([expected]);
    page[0].row.first_name = 'Mutated page';
    expect(await store.get(manifest.archiveId, 'students', 'student-001')).toEqual(expected);
  });

  it('rejects malformed query shapes and unsupported bounds', async () => {
    const store = await open();
    for (const limit of [0, -1, 65, 1.5, NaN, Infinity, '2']) {
      await expect(store.page(query('recovery-base', { limit: limit as number }))).rejects.toThrow();
    }
    for (const malformed of [
      { ...query('recovery-base'), table: 'sqlite_master' },
      { ...query('recovery-base'), archiveId: '' },
      { ...query('recovery-base'), after: null },
      { ...query('recovery-base'), relation: { column: 'first_name', value: 'Synthetic' } },
      { ...query('recovery-base'), relation: { column: 'visit_id', value: null } },
    ]) await expect(store.page(malformed as ArchiveSemanticQuery)).rejects.toThrow();
    await expect(store.get('recovery-base', 'sqlite_master' as never, 'id')).rejects.toThrow();
    await expect(store.get('recovery-base', 'students', null as never)).rejects.toThrow();
    expect(await store.get('recovery-base', 'students', "x' OR 1=1 --")).toBeNull();
    expect(await store.page(query('recovery-base', { relation: { column: 'entity_id', value: "x' OR 1=1 --" } }))).toEqual([]);
  });

  it('rejects duplicate parts and malformed or oversized records without partial staging', async () => {
    const store = await open();
    const records = [student('student-001')];
    const manifest = await stage(store, records);
    await expect(store.stagePart(records, manifest.parts[0], manifest)).rejects.toThrow();
    expect(await store.page(query(manifest.archiveId))).toEqual(records);
    const candidates = [student('student-002'), student('student-003')];
    const later = await archive(candidates, 'recovery-malformed');
    candidates[1].row.id = 'does-not-match-key';
    await expect(store.stagePart(candidates, later.parts[0], later)).rejects.toThrow();
    expect(await store.page(query(later.archiveId))).toEqual([]);
    const oversized = [student('student-004', { first_name: '💡'.repeat(ARCHIVE_LIMITS.recordBytes) })];
    await expect(store.stagePart(oversized, { ...later.parts[0], recordCount: 1 }, later)).rejects.toThrow();
    expect(await store.page(query(later.archiveId))).toEqual([]);
  });

  it('checks abort before creation, queries and staging, and refuses reuse after close', async () => {
    const cancelled = new AbortController(); cancelled.abort(new Error('stop recovery now'));
    await expect(createRecoverySemanticStore(database, { signal: cancelled.signal })).rejects.toThrow();
    await expect(stat(database)).rejects.toMatchObject({ code: 'ENOENT' });
    const controller = new AbortController(), store = await open(controller.signal);
    const records = [student('student-001')], manifest = await archive(records);
    controller.abort(new Error('stop recovery now'));
    await expect(store.stagePart(records, manifest.parts[0], manifest)).rejects.toThrow();
    await expect(store.page(query(manifest.archiveId))).rejects.toThrow();
    await expect(store.get(manifest.archiveId, 'students', 'student-001')).rejects.toThrow();
    store.close();
    expect(() => store.close()).not.toThrow();
    const other = await createRecoverySemanticStore(join(directory, 'closed.sqlite')); stores.push(other);
    other.close();
    await expect(other.page(query(manifest.archiveId))).rejects.toThrow();
    await expect(other.get(manifest.archiveId, 'students', 'student-001')).rejects.toThrow();
    await expect(other.stagePart(records, manifest.parts[0], manifest)).rejects.toThrow();
  });

  it('binds records to the authenticated descriptor and rejects manifest or descriptor substitution', async () => {
    const store = await open(), records = [student('student-001')], manifest = await archive(records);
    const changed = structuredClone(records); changed[0].row.first_name = 'Changed but structurally valid';
    await expect(store.stagePart(changed, manifest.parts[0], manifest)).rejects.toThrow('PART_CONTENT');
    await expect(store.stagePart(records, { ...manifest.parts[0], plaintextSha256: 'a'.repeat(64) }, manifest)).rejects.toThrow('DESCRIPTOR');
    expect(await store.page(query(manifest.archiveId))).toEqual([]);
    await store.stagePart(records, manifest.parts[0], manifest);
    await expect(store.stagePart(records, manifest.parts[0], { ...manifest, applicationVersion: 'changed-manifest' })).rejects.toThrow('MANIFEST_OR_PART_REUSE');
    expect(await store.page(query(manifest.archiveId))).toEqual(records);
  });

  it('refuses a public parent and enforces the native database size policy on its actual connection', async () => {
    await chmod(directory, 0o755);
    await expect(open()).rejects.toThrow('PRIVATE_DIRECTORY_REQUIRED');
    await expect(stat(database)).rejects.toMatchObject({ code: 'ENOENT' });
    await chmod(directory, 0o700);
    const calls = vi.spyOn(DatabaseSync.prototype, 'exec');
    const store = await open();
    const native = calls.mock.contexts[0] as DatabaseSync;
    expect(native).toBeInstanceOf(DatabaseSync);
    const pageSize = Number(native.prepare('PRAGMA page_size').get()!.page_size);
    const pageLimit = Number(native.prepare('PRAGMA max_page_count').get()!.max_page_count);
    expect(pageSize * pageLimit).toBe(RECOVERY_SEMANTIC_STORE_LIMITS.databaseBytes);
    expect(RECOVERY_SEMANTIC_STORE_LIMITS.databaseBytes).toBe(1024 * 1024 * 1024);
    expect(native.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('delete');
    // Lower the actual native limit to inject disk exhaustion without allocating
    // a gigabyte; the production limit above was read from this same connection.
    const currentPages = Number(native.prepare('PRAGMA page_count').get()!.page_count);
    native.exec(`PRAGMA max_page_count=${currentPages}`);
    const records = Array.from({ length: 100 }, (_, index) => student(`student-${String(index).padStart(3, '0')}`, { first_name: 'x'.repeat(1000) }));
    const manifest = await archive(records);
    await expect(store.stagePart(records, manifest.parts[0], manifest)).rejects.toThrow(/full/i);
    expect(native.prepare('SELECT * FROM recovery_state').get()).toMatchObject({ plaintext_bytes: 0, record_count: 0, manifest_count: 0 });
    expect(native.prepare('SELECT count(*) n FROM recovery_parts').get()!.n).toBe(0);
    expect(await store.page(query(manifest.archiveId))).toEqual([]);
    native.exec(`PRAGMA max_page_count=${pageLimit}`);
    await store.stagePart(records, manifest.parts[0], manifest);
    expect((await store.page(query(manifest.archiveId))).length).toBe(64);
  });

  it('enforces aggregate JSONL bytes and graph count atomically at their boundaries', async () => {
    const store = await open(), native = new DatabaseSync(database);
    try {
      const records = [student('student-001')], manifest = await archive(records);
      const bytes = Buffer.byteLength(records.map(record => JSON.stringify(record)).join('\n') + '\n');
      const maximum = RECOVERY_SEMANTIC_STORE_LIMITS.plaintextBytes;
      expect(maximum).toBe(512 * 1024 * 1024);
      native.prepare('UPDATE recovery_state SET plaintext_bytes=?').run(maximum - bytes + 1);
      await expect(store.stagePart(records, manifest.parts[0], manifest)).rejects.toThrow('PLAINTEXT_BOUND');
      expect(native.prepare('SELECT * FROM recovery_state').get()).toMatchObject({ plaintext_bytes: maximum - bytes + 1, record_count: 0, manifest_count: 0 });
      expect(native.prepare('SELECT count(*) n FROM recovery_manifests').get()!.n).toBe(0);
      native.prepare('UPDATE recovery_state SET plaintext_bytes=?').run(maximum - bytes);
      await store.stagePart(records, manifest.parts[0], manifest);
      expect(native.prepare('SELECT * FROM recovery_state').get()).toMatchObject({ plaintext_bytes: maximum, record_count: 1, manifest_count: 1 });
      const next = [student('student-002')], nextManifest = await archive(next, 'second-archive');
      await expect(store.stagePart(next, nextManifest.parts[0], nextManifest)).rejects.toThrow('PLAINTEXT_BOUND');
      expect(await store.get(nextManifest.archiveId, 'students', 'student-002')).toBeNull();
      native.prepare('UPDATE recovery_state SET plaintext_bytes=0,manifest_count=?').run(ARCHIVE_LIMITS.graphArchives);
      await expect(store.stagePart(next, nextManifest.parts[0], nextManifest)).rejects.toThrow('MANIFEST_BOUND');
      expect(native.prepare('SELECT count(*) n FROM recovery_manifests').get()!.n).toBe(1);
    } finally { native.close(); }
  });

  it('rolls back earlier inserts, part registration and counters on a later duplicate record', async () => {
    const store = await open();
    const records = Array.from({ length: 258 }, (_, index) => student(`student-${String(index).padStart(3, '0')}`));
    const manifest = await archive(records);
    expect(manifest.parts.map(part => part.recordCount)).toEqual([256, 2]);
    await expect(store.stagePart(records.slice(0, 257), manifest.parts[0], manifest)).rejects.toThrow('PART_BOUND');
    await expect(store.stagePart(records.slice(256), manifest.parts[1], manifest)).rejects.toThrow();
    await store.stagePart(records.slice(0, 256), manifest.parts[0], manifest);
    const native = new DatabaseSync(database);
    try {
      const before = native.prepare('SELECT * FROM recovery_state').get();
      // Inject a duplicate late in an otherwise authentic second part. This
      // exercises rollback after the first new record has already been inserted.
      native.prepare('INSERT INTO recovery_records VALUES(?,?,?,?,NULL,NULL,NULL)').run(manifest.archiveId, records[257].table, records[257].key, JSON.stringify(records[257]));
      await expect(store.stagePart(records.slice(256), manifest.parts[1], manifest)).rejects.toThrow();
      expect(await store.get(manifest.archiveId, 'students', records[256].key)).toBeNull();
      expect(await store.get(manifest.archiveId, 'students', records[257].key)).toEqual(records[257]);
      expect(native.prepare('SELECT * FROM recovery_state').get()).toEqual(before);
      expect(native.prepare('SELECT count(*) n FROM recovery_parts').get()!.n).toBe(1);
      expect(native.prepare('SELECT next_part FROM recovery_manifests').get()!.next_part).toBe(1);
      native.prepare('DELETE FROM recovery_records WHERE record_key=?').run(records[257].key);
      await store.stagePart(records.slice(256), manifest.parts[1], manifest);
      expect(native.prepare('SELECT record_count FROM recovery_state').get()!.record_count).toBe(258);
    } finally { native.close(); }
  });

  it('uses indexed key and relation searches for the actual query statements', async () => {
    const store = await open();
    await stage(store, Array.from({ length: 128 }, (_, index) => student(`student-${String(index).padStart(3, '0')}`)));
    const prepared = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const capture = async (operation: () => Promise<unknown>) => {
      prepared.mockClear();
      await operation();
      expect(prepared.mock.calls).toHaveLength(1);
      return String(prepared.mock.calls[0][0]);
    };
    const statements: { sql: string; bindings: (string | number)[]; relation?: string }[] = [
      { sql: await capture(() => store.get('recovery-base', 'students', 'student-042')), bindings: ['recovery-base', 'students', 'student-042'] },
      { sql: await capture(() => store.page(query('recovery-base', { after: 'student-042' }))), bindings: ['recovery-base', 'students', 'student-042', 64] },
    ];
    for (const column of ['visit_id', 'event_id', 'entity_id'] as const) {
      statements.push({ sql: await capture(() => store.page(query('recovery-base', { relation: { column, value: 'target' } }))), bindings: ['recovery-base', 'students', 'target', '', 64], relation: column });
    }
    prepared.mockRestore();
    const native = new DatabaseSync(database);
    try {
      for (const { sql, bindings, relation } of statements) {
        const plan = native.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map(row => String(row.detail)).join('\n');
        expect(plan).toMatch(/SEARCH recovery_records USING (?:PRIMARY KEY|INDEX)/);
        expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
        expect(plan).toContain('archive_id=? AND table_name=?');
        if (relation) expect(plan).toContain(`${relation}=? AND record_key>?`);
      }
    } finally { native.close(); }
  });
});
