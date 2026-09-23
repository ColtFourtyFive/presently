import { ARCHIVE_LIMITS, ARCHIVE_TABLES, type ArchiveRecord, type ArchiveTable } from '../shared/archive-format';
import { digest } from './backup-crypto';

/** locator_version=1: these boundaries and JSON property orders are durable. */
export const INITIAL_LOCATOR_DIGEST = '0'.repeat(64);
export const LOCATOR_PAGE_RECORDS = 8;
export const LOCATOR_PAGE_BYTES = 256 * 1024;
export type PublicationLocator = {
  table: ArchiveTable; key: string; part: number; offset: number;
  descriptorSha256: string; recordSha256: string; recordBytes: number;
};
const locatorKeys = ['table', 'key', 'part', 'offset', 'descriptorSha256', 'recordSha256', 'recordBytes'];
const encoder = new TextEncoder();
function fail(): never { throw new Error('ARCHIVE_PUBLICATION_LOCATOR_INVALID'); }
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function recordBytes(record: ArchiveRecord): Uint8Array {
  if (!record || !ARCHIVE_TABLES.includes(record.table) || typeof record.key !== 'string' || !record.key || record.key.length > 1024) fail();
  const bytes = encoder.encode(JSON.stringify(record));
  if (bytes.length > ARCHIVE_LIMITS.recordBytes) fail();
  return bytes;
}

/** Input is exactly one authenticated part. Pages never span part boundaries.
 * The byte limit counts record JSON without the JSONL newline. */
export function partitionPage(records: readonly ArchiveRecord[], offset: number): {
  records: ArchiveRecord[]; nextOffset: number; recordBytes: number; complete: boolean;
} {
  if (!Array.isArray(records) || records.length > ARCHIVE_LIMITS.recordsPerPart || !Number.isSafeInteger(offset) || offset < 0 || offset > records.length) fail();
  const page: ArchiveRecord[] = [];
  let bytes = 0;
  for (const record of records.slice(offset, offset + LOCATOR_PAGE_RECORDS)) {
    const length = recordBytes(record).length;
    if (bytes + length > LOCATOR_PAGE_BYTES) break;
    page.push(record); bytes += length;
  }
  return { records: page, nextOffset: offset + page.length, recordBytes: bytes, complete: offset + page.length === records.length };
}

export async function buildLocator(record: ArchiveRecord, part: number, offset: number, descriptorSha256: string): Promise<PublicationLocator> {
  if (!Number.isSafeInteger(part) || part < 0 || part >= ARCHIVE_LIMITS.parts || !Number.isSafeInteger(offset) || offset < 0 || offset >= ARCHIVE_LIMITS.recordsPerPart || !hashValid(descriptorSha256)) fail();
  const bytes = recordBytes(record), table = record.table, key = record.key;
  const recordSha256 = await digest(bytes);
  // Property order is part of the v1 digest, including the enclosing page's
  // {prior,locators} object. Do not replace this with a general canonicalizer.
  return { table, key, part, offset, descriptorSha256, recordSha256, recordBytes: bytes.length };
}

export async function appendLocatorDigest(prior: string, locators: readonly PublicationLocator[]): Promise<string> {
  if (!hashValid(prior) || !Array.isArray(locators) || locators.length < 1 || locators.length > LOCATOR_PAGE_RECORDS) fail();
  let bytes = 0;
  for (const [index, locator] of locators.entries()) {
    if (JSON.stringify(Object.keys(locator)) !== JSON.stringify(locatorKeys) || !ARCHIVE_TABLES.includes(locator.table) ||
      typeof locator.key !== 'string' || !locator.key || !Number.isSafeInteger(locator.part) || locator.part < 0 || locator.part >= ARCHIVE_LIMITS.parts ||
      !Number.isSafeInteger(locator.offset) || locator.offset < 0 || locator.offset >= ARCHIVE_LIMITS.recordsPerPart ||
      !hashValid(locator.descriptorSha256) || !hashValid(locator.recordSha256) || !Number.isSafeInteger(locator.recordBytes) || locator.recordBytes < 1 || locator.recordBytes > ARCHIVE_LIMITS.recordBytes ||
      locator.part !== locators[0].part || locator.descriptorSha256 !== locators[0].descriptorSha256 || locator.offset !== locators[0].offset + index) fail();
    bytes += locator.recordBytes;
  }
  if (bytes > LOCATOR_PAGE_BYTES) fail();
  return digest(encoder.encode(JSON.stringify({ prior, locators })));
}
