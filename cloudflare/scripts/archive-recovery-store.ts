import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, ARCHIVE_TABLES, type ArchiveManifest, type ArchivePartDescriptor, type ArchiveRecord, type ArchiveSemanticQuery, type ArchiveSemanticStore, type ArchiveTable } from '../shared/archive-format';
import { compareArchiveRecords, validateArchiveManifest } from '../worker/archive-codec';
import { validateSemanticShape } from '../worker/archive-semantic-rules';

/** Offline recovery limits, not Worker/D1 capacity claims. The database contains
 * private scratch plaintext and must be closed and removed before publication. */
export const RECOVERY_SEMANTIC_STORE_LIMITS = Object.freeze({
 plaintextBytes: ARCHIVE_LIMITS.plaintextGraphBytes,
 databaseBytes: 1024 * 1024 * 1024,
 pageSize: 4096,
 pageRecords: ARCHIVE_LIMITS.semanticPageRecords,
});
const tableSet = new Set<string>(ARCHIVE_TABLES);
const relations = new Set(['visit_id', 'event_id', 'entity_id']);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const keyString = (value: unknown, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= 1024 && /^[\x20-\x7e]*$/.test(value);
const fail = (code: string): never => { throw new Error(`ARCHIVE_RECOVERY_STORE_${code}`); };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const schema = `
 PRAGMA page_size=4096;
 PRAGMA max_page_count=262144;
 PRAGMA journal_mode=DELETE;
 PRAGMA cache_size=-8192;
 PRAGMA mmap_size=0;
 PRAGMA temp_store=MEMORY;
 PRAGMA trusted_schema=OFF;
 PRAGMA foreign_keys=ON;
 CREATE TABLE recovery_state(
  id INTEGER PRIMARY KEY CHECK(id=1),
  plaintext_bytes INTEGER NOT NULL CHECK(plaintext_bytes BETWEEN 0 AND ${RECOVERY_SEMANTIC_STORE_LIMITS.plaintextBytes}),
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  manifest_count INTEGER NOT NULL CHECK(manifest_count BETWEEN 0 AND ${ARCHIVE_LIMITS.graphArchives})
 );
 INSERT INTO recovery_state VALUES(1,0,0,0);
 CREATE TABLE recovery_manifests(
  archive_id TEXT PRIMARY KEY,
  manifest_sha256 TEXT NOT NULL,
  next_part INTEGER NOT NULL CHECK(next_part BETWEEN 0 AND ${ARCHIVE_LIMITS.parts})
 ) WITHOUT ROWID;
 CREATE TABLE recovery_parts(
  archive_id TEXT NOT NULL REFERENCES recovery_manifests(archive_id),
  part_index INTEGER NOT NULL,
  descriptor_sha256 TEXT NOT NULL,
  PRIMARY KEY(archive_id,part_index)
 ) WITHOUT ROWID;
 CREATE TABLE recovery_records(
  archive_id TEXT NOT NULL REFERENCES recovery_manifests(archive_id),
  table_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  visit_id TEXT,
  event_id TEXT,
  entity_id TEXT,
  PRIMARY KEY(archive_id,table_name,record_key)
 ) WITHOUT ROWID;
 CREATE INDEX recovery_records_visit ON recovery_records(archive_id,table_name,visit_id,record_key) WHERE visit_id IS NOT NULL;
 CREATE INDEX recovery_records_event ON recovery_records(archive_id,table_name,event_id,record_key) WHERE event_id IS NOT NULL;
 CREATE INDEX recovery_records_entity ON recovery_records(archive_id,table_name,entity_id,record_key) WHERE entity_id IS NOT NULL;
`;

export class RecoverySemanticStore implements ArchiveSemanticStore {
 readonly #db: DatabaseSync;
 readonly #signal?: AbortSignal;
 #closed = false;
 // Factory owns creation; consumers cannot inject a live application database.
 private constructor(database: DatabaseSync, signal?: AbortSignal) { this.#db = database; this.#signal = signal; }
 static async create(path: string, options: { signal?: AbortSignal } = {}): Promise<RecoverySemanticStore> {
  const signal = options.signal, target = resolve(path);
  signal?.throwIfAborted();
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) fail('PRIVATE_DIRECTORY_REQUIRED');
  signal?.throwIfAborted();
  // Exclusive creation refuses existing files and symlinks. Callers own the
  // private parent directory throughout this store's lifetime.
  const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let database: DatabaseSync | undefined;
  try {
   await file.close();
   signal?.throwIfAborted();
   database = new DatabaseSync(target);
   database.exec(schema);
   signal?.throwIfAborted();
   return new RecoverySemanticStore(database, signal);
  } catch (error) {
   try { database?.close(); } finally { await rm(target, { force: true }); }
   throw error;
  }
 }
 #ready() { if (this.#closed) fail('CLOSED'); this.#signal?.throwIfAborted(); }
 close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }

 /** Receives the authenticated codec callback. It independently binds staged
  * rows to that descriptor. Staging is evidence storage, never publication or
  * application authority. Every input is copied before any asynchronous yield. */
 async stagePart(input: readonly ArchiveRecord[], suppliedPart: ArchivePartDescriptor, suppliedManifest: ArchiveManifest): Promise<void> {
  this.#ready();
  if (!Array.isArray(input) || input.length < 1 || input.length > ARCHIVE_LIMITS.recordsPerPart) fail('PART_BOUND');
  const manifestText = JSON.stringify(suppliedManifest);
  if (Buffer.byteLength(manifestText) > ARCHIVE_LIMITS.manifestBytes) fail('MANIFEST_BOUND');
  const manifest = JSON.parse(manifestText) as ArchiveManifest;
  validateArchiveManifest(manifest);
  if (manifest.format !== ARCHIVE_FORMAT_V2) fail('VERSION');
  const partText = JSON.stringify(suppliedPart), part = JSON.parse(partText) as ArchivePartDescriptor;
  if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index >= manifest.parts.length || JSON.stringify(manifest.parts[part.index]) !== partText) fail('DESCRIPTOR');
  const payloads = input.map(record => JSON.stringify(record));
  const records = payloads.map(payload => JSON.parse(payload) as ArchiveRecord);
  const counts = Object.fromEntries(ARCHIVE_TABLES.map(table => [table, 0])) as Record<ArchiveTable, number>;
  let previous: ArchiveRecord | undefined;
  for (const record of records) {
   if (!tableSet.has(record.table)) fail('TABLE');
   validateSemanticShape(record, manifest);
   if (previous && compareArchiveRecords(previous, record) >= 0) fail('RECORD_ORDER');
   previous = record;
   counts[record.table]++;
  }
  const plaintext = payloads.join('\n') + '\n', bytes = Buffer.byteLength(plaintext);
  if (bytes > ARCHIVE_LIMITS.plaintextPartBytes || bytes !== part.plaintextBytes || hash(plaintext) !== part.plaintextSha256
   || records.length !== part.recordCount || ARCHIVE_TABLES.some(table => counts[table] !== part.recordCounts[table])
   || compareArchiveRecords(records[0], part.first) !== 0 || compareArchiveRecords(records.at(-1)!, part.last) !== 0) fail('PART_CONTENT');
  this.#ready();
  this.#db.exec('BEGIN IMMEDIATE');
  try {
   const state = this.#db.prepare('SELECT * FROM recovery_state WHERE id=1').get()!;
   if (bytes > RECOVERY_SEMANTIC_STORE_LIMITS.plaintextBytes - Number(state.plaintext_bytes)) fail('PLAINTEXT_BOUND');
   const saved = this.#db.prepare('SELECT manifest_sha256,next_part FROM recovery_manifests WHERE archive_id=?').get(manifest.archiveId);
   if (saved && (saved.manifest_sha256 !== hash(manifestText) || saved.next_part !== part.index)) fail('MANIFEST_OR_PART_REUSE');
   if (!saved) {
    if (part.index !== 0 || Number(state.manifest_count) >= ARCHIVE_LIMITS.graphArchives) fail('MANIFEST_BOUND');
    this.#db.prepare('INSERT INTO recovery_manifests VALUES(?,?,0)').run(manifest.archiveId, hash(manifestText));
   }
   this.#db.prepare('INSERT INTO recovery_parts VALUES(?,?,?)').run(manifest.archiveId, part.index, hash(partText));
   const insert = this.#db.prepare('INSERT INTO recovery_records VALUES(?,?,?,?,?,?,?)');
   for (let index = 0; index < records.length; index++) {
    this.#ready();
    const record = records[index];
    insert.run(manifest.archiveId, record.table, record.key, payloads[index],
     typeof record.row.visit_id === 'string' ? record.row.visit_id : null,
     typeof record.row.event_id === 'string' ? record.row.event_id : null,
     typeof record.row.entity_id === 'string' ? record.row.entity_id : null);
   }
   this.#db.prepare('UPDATE recovery_manifests SET next_part=next_part+1 WHERE archive_id=?').run(manifest.archiveId);
   this.#db.prepare('UPDATE recovery_state SET plaintext_bytes=plaintext_bytes+?,record_count=record_count+?,manifest_count=manifest_count+? WHERE id=1').run(bytes, records.length, saved ? 0 : 1);
   this.#ready();
   this.#db.exec('COMMIT');
  } catch (error) {
   // SQLITE_FULL can already have rolled back the transaction.
   try { this.#db.exec('ROLLBACK'); } catch { /* Retain the original failure. */ }
   throw error;
  }
 }
 async get(archiveId: string, table: ArchiveTable, key: string): Promise<ArchiveRecord | null> {
  this.#ready();
  if (!identifier(archiveId) || !tableSet.has(table) || !keyString(key)) fail('QUERY');
  const row = this.#db.prepare('SELECT payload_json FROM recovery_records WHERE archive_id=? AND table_name=? AND record_key=?').get(archiveId, table, key);
  return row ? JSON.parse(String(row.payload_json)) as ArchiveRecord : null;
 }
 async page(query: ArchiveSemanticQuery): Promise<readonly ArchiveRecord[]> {
  this.#ready();
  const { archiveId, table, after, limit } = query, relation = query.relation ? { ...query.relation } : undefined;
  if (!identifier(archiveId) || !tableSet.has(table) || !keyString(after, true) || !Number.isSafeInteger(limit) || limit < 1 || limit > ARCHIVE_LIMITS.semanticPageRecords
   || relation && (!relations.has(relation.column) || !keyString(relation.value))) fail('QUERY');
  // Force the matching relation index: SQLite may otherwise choose the primary
  // key and filter an arbitrarily long tail before finding an empty relation.
  const relationIndex = relation && ({ visit_id: 'recovery_records_visit', event_id: 'recovery_records_event', entity_id: 'recovery_records_entity' } as const)[relation.column];
  // Both dynamic identifiers come from the closed relation set above.
  const rows = relation
   ? this.#db.prepare(`SELECT payload_json FROM recovery_records INDEXED BY ${relationIndex} WHERE archive_id=? AND table_name=? AND ${relation.column}=? AND record_key>? ORDER BY record_key LIMIT ?`).all(archiveId, table, relation.value, after, limit)
   : this.#db.prepare('SELECT payload_json FROM recovery_records WHERE archive_id=? AND table_name=? AND record_key>? ORDER BY record_key LIMIT ?').all(archiveId, table, after, limit);
  return rows.map(row => JSON.parse(String(row.payload_json)) as ArchiveRecord);
 }
}

export const createRecoverySemanticStore = (path: string, options: { signal?: AbortSignal } = {}): Promise<RecoverySemanticStore> => RecoverySemanticStore.create(path, options);
