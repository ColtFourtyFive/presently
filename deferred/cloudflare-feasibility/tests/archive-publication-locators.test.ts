import { describe, expect, it } from 'vitest';
import type { ArchiveRecord } from '../shared/archive-format';
import { INITIAL_LOCATOR_DIGEST, LOCATOR_PAGE_BYTES, LOCATOR_PAGE_RECORDS, appendLocatorDigest, buildLocator, partitionPage } from '../worker/archive-publication-locators';

const encoder = new TextEncoder();
const record = (index: number, prefix = 'count'): ArchiveRecord => {
  const id = `${prefix}-${String(index).padStart(2, '0')}`;
  return { table: 'students', key: id, row: { id, name: 'Ada', note: 'é' } };
};
function sized(index: number): ArchiveRecord {
  const id = `byte-${String(index).padStart(2, '0')}`;
  const result: ArchiveRecord = { table: 'students', key: id, row: { id, note: '' } };
  result.row.note = 'x'.repeat(65_536 - encoder.encode(JSON.stringify(result)).length);
  return result;
}

// Fixed expected values independently computed with Python hashlib.sha256 and
// json.dumps(separators=(',', ':'), ensure_ascii=False), not this implementation.
describe('publication locator_version=1 durable digest vectors', () => {
  it('preserves exact locator property order and UTF-8 record bytes', async () => {
    expect(INITIAL_LOCATOR_DIGEST).toBe('0000000000000000000000000000000000000000000000000000000000000000');
    const locator = await buildLocator(record(0), 0, 0, 'a'.repeat(64));
    expect(Object.keys(locator)).toEqual(['table', 'key', 'part', 'offset', 'descriptorSha256', 'recordSha256', 'recordBytes']);
    expect(locator).toEqual({ table: 'students', key: 'count-00', part: 0, offset: 0, descriptorSha256: 'a'.repeat(64),
      recordSha256: 'f5794764261dd729a440a26286b9190c6068462609603b54b17af55ca91ac27d', recordBytes: 86 });
    expect(await appendLocatorDigest(INITIAL_LOCATOR_DIGEST, [locator])).toBe('c62cabd45c3fe70c35d04b6734f2ac55d1d5885374ca898f674e36a5be9a3e27');
  });

  it('matches the independent digest chain across the eight-record boundary', async () => {
    const records = Array.from({ length: 9 }, (_, index) => record(index));
    const first = partitionPage(records, 0), last = partitionPage(records, first.nextOffset);
    expect(LOCATOR_PAGE_RECORDS).toBe(8);
    expect(first).toMatchObject({ nextOffset: 8, recordBytes: 688, complete: false });
    expect(first.records).toEqual(records.slice(0, 8));
    expect(last).toMatchObject({ nextOffset: 9, recordBytes: 86, complete: true });
    let prior = INITIAL_LOCATOR_DIGEST;
    for (const [page, offset, expected] of [
      [first, 0, 'efcae571b07a596369c79d2b1ca2699dc18f51c9233cc89c52903700aa152611'],
      [last, 8, '111052ba0859e4d9b36c1816674046bff252826cb0ca3393fbffe6773d31feaa'],
    ] as const) {
      prior = await appendLocatorDigest(prior, await Promise.all(page.records.map((value, index) => buildLocator(value, 0, offset + index, 'a'.repeat(64)))));
      expect(prior).toBe(expected);
    }
    expect(partitionPage(records, 9)).toEqual({ records: [], nextOffset: 9, recordBytes: 0, complete: true });
  });

  it('includes exactly 256 KiB without adding JSONL newlines, then resumes the same part', async () => {
    const records = Array.from({ length: 5 }, (_, index) => sized(index));
    const first = partitionPage(records, 0), last = partitionPage(records, first.nextOffset);
    expect(LOCATOR_PAGE_BYTES).toBe(262_144);
    expect(first).toMatchObject({ nextOffset: 4, recordBytes: 262_144, complete: false });
    expect(last).toMatchObject({ nextOffset: 5, recordBytes: 65_536, complete: true });
    let prior = INITIAL_LOCATOR_DIGEST;
    for (const [page, offset, expected] of [
      [first, 0, '7d4bf86bd9af278427d18a25e160cdae6e7cad3921a3932e4a747e9b4cf00138'],
      [last, 4, 'f2317a0b22280f965443a09c868d7a2b34dd0f140baae14e89a4355d8717895f'],
    ] as const) {
      prior = await appendLocatorDigest(prior, await Promise.all(page.records.map((value, index) => buildLocator(value, 0, offset + index, 'b'.repeat(64)))));
      expect(prior).toBe(expected);
    }
  });

  it('ends a short page at the part boundary and resets offsets for the next part', async () => {
    const parts = [Array.from({ length: 3 }, (_, index) => record(index, 'first')), Array.from({ length: 9 }, (_, index) => record(index, 'second'))];
    const expected = [
      { part: 0, offset: 0, count: 3, bytes: 258, digest: 'a74270719a76d5087c6f626b64da05b7c2d0956a2a917de1d23ceedc884c30d6' },
      { part: 1, offset: 0, count: 8, bytes: 704, digest: 'a01173c0762c0143c9960e0f2d3b06097b4b4358783934c5694db2ecb0b9652c' },
      { part: 1, offset: 8, count: 1, bytes: 88, digest: 'ad50270d89ef2cb8ed016209055fa04cdb07b07a7ae6e64add8dfce52cdd300e' },
    ];
    let prior = INITIAL_LOCATOR_DIGEST, pageIndex = 0;
    for (const [part, records] of parts.entries()) {
      for (let offset = 0; offset < records.length;) {
        const page = partitionPage(records, offset), vector = expected[pageIndex++];
        expect({ part, offset, count: page.records.length, bytes: page.recordBytes }).toEqual({ part: vector.part, offset: vector.offset, count: vector.count, bytes: vector.bytes });
        prior = await appendLocatorDigest(prior, await Promise.all(page.records.map((value, index) => buildLocator(value, part, offset + index, ['c', 'd'][part].repeat(64)))));
        expect(prior).toBe(vector.digest);
        offset = page.nextOffset;
      }
    }
    expect(pageIndex).toBe(3);
  });

  it('does not canonicalize the original record property order', async () => {
    const original = record(0), changed = { ...original, row: { note: original.row.note, name: original.row.name, id: original.row.id } };
    const first = await buildLocator(original, 0, 0, 'a'.repeat(64)), second = await buildLocator(changed, 0, 0, 'a'.repeat(64));
    expect(first.recordBytes).toBe(second.recordBytes);
    expect(first.recordSha256).not.toBe(second.recordSha256);
  });

  it('rejects invalid boundaries, oversized records and pages crossing parts', async () => {
    for (const offset of [-1, 0.5, 2]) expect(() => partitionPage([record(0)], offset)).toThrow('ARCHIVE_PUBLICATION_LOCATOR_INVALID');
    const tooLarge = sized(0); tooLarge.row.note = String(tooLarge.row.note) + 'x';
    expect(() => partitionPage([tooLarge], 0)).toThrow('ARCHIVE_PUBLICATION_LOCATOR_INVALID');
    await expect(buildLocator(record(0), 512, 0, 'a'.repeat(64))).rejects.toThrow('ARCHIVE_PUBLICATION_LOCATOR_INVALID');
    await expect(buildLocator(record(0), 0, 256, 'a'.repeat(64))).rejects.toThrow('ARCHIVE_PUBLICATION_LOCATOR_INVALID');
    const first = await buildLocator(record(0), 0, 0, 'a'.repeat(64)), second = await buildLocator(record(1), 1, 0, 'b'.repeat(64));
    await expect(appendLocatorDigest(INITIAL_LOCATOR_DIGEST, [first, second])).rejects.toThrow('ARCHIVE_PUBLICATION_LOCATOR_INVALID');
    await expect(appendLocatorDigest(INITIAL_LOCATOR_DIGEST, [])).rejects.toThrow('ARCHIVE_PUBLICATION_LOCATOR_INVALID');
  });
});
