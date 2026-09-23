import { ARCHIVE_TABLES, type ArchiveTable } from '../shared/archive-format';
import { digest } from './backup-crypto';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import type { ArchivePublicationBuildRow } from './archive-publication-schema';
import type { PublicationLocator } from './archive-publication-locators';

export type AbandonmentCatalog = 'requests' | 'records' | 'parts';
export type AbandonmentCatalogRow = Record<string, unknown>;
export const ABANDONMENT_ZERO_HASH = '0'.repeat(64);
const encoder = new TextEncoder();
const modulus = 1n << 256n;
const columns = {
  requests: ['request_id', 'publication_id', 'source_kind', 'center_id', 'payload_hash', 'table_name', 'record_key'],
  records: ['publication_id', 'table_name', 'record_key', 'part_index', 'part_offset', 'descriptor_sha256', 'record_sha256', 'record_bytes'],
  parts: ['publication_id', 'part_index', 'descriptor_json', 'descriptor_sha256', 'record_count', 'indexed_count', 'completed'],
} as const;

function fail(code: string): never { throw new Error(`ARCHIVE_ABANDONMENT_${code}`); }
export const abandonmentHash = (text: string): Promise<string> => digest(encoder.encode(text));
export function abandonmentCatalogJson(kind: AbandonmentCatalog, row: AbandonmentCatalogRow): string {
  return JSON.stringify(Object.fromEntries(columns[kind].map(column => [column, row[column]])));
}
export function addAbandonmentHash(prior: string, next: string, subtract = false): string {
  if (![prior, next].every(value => /^[a-f0-9]{64}$/.test(value))) fail('HASH_INVALID');
  return ((BigInt(`0x${prior}`) + (subtract ? -1n : 1n) * BigInt(`0x${next}`) + modulus) % modulus).toString(16).padStart(64, '0');
}
export function abandonmentLocator(row: AbandonmentCatalogRow): PublicationLocator {
  return { table: row.table_name as ArchiveTable, key: row.record_key as string,
    part: row.part_index as number, offset: row.part_offset as number,
    descriptorSha256: row.descriptor_sha256 as string, recordSha256: row.record_sha256 as string,
    recordBytes: row.record_bytes as number };
}

function encoding(value: unknown): string {
  if (typeof value !== 'string') fail('REQUEST_INVALID');
  return /^[a-fA-F0-9]{64}$/.test(value) ? 'hex-sha256' : /^[A-Za-z0-9+/]{43}=$/.test(value) ? 'base64-sha256' : /^[A-Za-z0-9_-]{43}$/.test(value) ? 'base64url-sha256' : 'opaque';
}

/** Only catalog metadata is read. No operational attendance rows or R2 objects
 * are deletion targets, and permanent request ownership must remain intact. */
export async function readAbandonmentCatalogPage<S extends ArchiveStagingStatement<S>>(
  db: ArchiveStagingDatabase<S>, kind: AbandonmentCatalog, publicationId: string,
  after: { request: string; part: number; offset: number },
): Promise<AbandonmentCatalogRow[]> {
  let query: S;
  if (kind === 'requests') query = db.prepare(`SELECT q.*,k.source_kind AS owner_kind,k.center_id AS owner_center,k.payload_hash AS owner_hash,k.hash_encoding AS owner_encoding,k.canonicalization AS owner_canonicalization,r.record_key AS locator_key
    FROM archive_publication_requests q LEFT JOIN history_request_keys k ON k.request_id=q.request_id
    LEFT JOIN archive_publication_records r ON r.publication_id=q.publication_id AND r.table_name=q.table_name AND r.record_key=q.record_key
    WHERE q.publication_id=? AND q.request_id>? ORDER BY q.request_id LIMIT 8`).bind(publicationId, after.request);
  else if (kind === 'records') query = db.prepare(`SELECT r.*,p.descriptor_sha256 AS part_descriptor,p.indexed_count AS part_indexed
    FROM archive_publication_records r LEFT JOIN archive_publication_parts p ON p.publication_id=r.publication_id AND p.part_index=r.part_index
    WHERE r.publication_id=? AND (r.part_index,r.part_offset)>(?,?) ORDER BY r.part_index,r.part_offset LIMIT 8`).bind(publicationId, after.part, after.offset);
  else query = db.prepare('SELECT * FROM archive_publication_parts WHERE publication_id=? AND part_index>? ORDER BY part_index LIMIT 8').bind(publicationId, after.part);
  const rows = (await db.batch<AbandonmentCatalogRow>([query]))[0].results;
  if (rows.length > 8) fail('PAGE_BOUND');
  return rows;
}

export async function validateAbandonmentCatalogRow(kind: AbandonmentCatalog, row: AbandonmentCatalogRow, build: ArchivePublicationBuildRow): Promise<void> {
  if (row.publication_id !== build.publication_id) fail('CATALOG_MISMATCH');
  if (kind === 'requests') {
    if (row.request_id !== row.record_key || row.locator_key !== row.record_key || row.center_id !== build.center_id
      || row.owner_kind !== row.source_kind || row.owner_center !== row.center_id || row.owner_hash !== row.payload_hash
      || row.owner_encoding !== encoding(row.payload_hash) || row.owner_canonicalization !== 'legacy-unverified'
      || !((row.source_kind === 'event' && row.table_name === 'attendance_events') || (row.source_kind === 'correction' && row.table_name === 'attendance_corrections'))) fail('REQUEST_INVALID');
  } else if (kind === 'records') {
    const locator = abandonmentLocator(row);
    if (!ARCHIVE_TABLES.includes(locator.table) || typeof locator.key !== 'string' || !locator.key || locator.key.length > 210
      || !Number.isSafeInteger(locator.part) || locator.part < 0 || locator.part >= build.part_count
      || !Number.isSafeInteger(locator.offset) || locator.offset < 0 || locator.offset >= Number(row.part_indexed)
      || row.part_descriptor !== locator.descriptorSha256
      || !/^[a-f0-9]{64}$/.test(locator.descriptorSha256) || !/^[a-f0-9]{64}$/.test(locator.recordSha256)
      || !Number.isSafeInteger(locator.recordBytes) || locator.recordBytes < 1 || locator.recordBytes > 65_536) fail('RECORD_INVALID');
  } else {
    if (typeof row.descriptor_json !== 'string' || encoder.encode(row.descriptor_json).length > 8192
      || await abandonmentHash(row.descriptor_json) !== row.descriptor_sha256) fail('PART_INVALID');
    let descriptor: Record<string, unknown>;
    try { descriptor = JSON.parse(row.descriptor_json); } catch { fail('PART_INVALID'); }
    if (!descriptor || descriptor.index !== row.part_index || descriptor.recordCount !== row.record_count
      || !Number.isSafeInteger(row.part_index) || Number(row.part_index) < 0 || Number(row.part_index) >= build.part_count
      || !Number.isSafeInteger(row.indexed_count) || Number(row.indexed_count) < 1 || Number(row.indexed_count) > Number(row.record_count)
      || row.completed !== Number(row.indexed_count === row.record_count)) fail('PART_INVALID');
  }
  if (encoder.encode(abandonmentCatalogJson(kind, row)).length > 16_384) fail('CATALOG_BOUND');
}
