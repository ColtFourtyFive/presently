import { readFileSync } from 'node:fs';
import { unstable_splitSqlQuery } from 'wrangler';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advanceCompactMonthlyPublication, startCompactMonthlyPublication } from '../worker/archive-compact-publication';
import { compactPublishedRequestStatement } from '../worker/archive-publication-reader';
import type { ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';
import { resolveHistoryRequest, type HistoryRequest } from '../worker/history-request';
import {
  createPublicationFixture,
  createPublicationSeed,
  restorePublicationDatabase,
  snapshotPublicationDatabase,
  type PublicationSnapshotOptions,
} from './archive-publication-fixture';
import type { IsolatedStatement, TestRuntime } from './runtime';

type Fixture = Awaited<ReturnType<typeof createPublicationFixture>>;
type RecordFixture = Fixture['records'][number];

const opened: TestRuntime[] = [];
const unavailable = { status: 503, code: 'HISTORY_EVIDENCE_UNAVAILABLE' };
const omittedSources = ['attendance_events', 'attendance_corrections', 'reviews'];
const resetStatements = unstable_splitSqlQuery(readFileSync(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8'));
let fixture: Fixture;
let archivedSql: string;
let event: RecordFixture;
let correction: RecordFixture;

beforeAll(async () => {
  fixture = await createPublicationFixture(await createPublicationSeed());
  const handle = await startCompactMonthlyPublication(fixture.app.db, fixture.handle);
  let revision = 0;
  for (let step = 0; step < 100; step += 1) {
    const result = await advanceCompactMonthlyPublication(fixture.app.db, handle, { expectedRevision: revision });
    expect(result.busy).toBe(false);
    revision = result.revision;
    if (result.state === 'published') break;
    if (result.state !== 'building') throw new Error(`Compact publication became ${result.state}`);
    if (step === 99) throw new Error('Compact publication did not finish');
  }
  expect(await fixture.app.db.prepare('SELECT count(*) n FROM archive_publications').first<number>('n')).toBe(0);
  expect(await fixture.app.db.prepare('SELECT count(*) n FROM archive_compact_publications').first<number>('n')).toBe(1);
  archivedSql = await snapshotPublicationDatabase(fixture.app, { omitTables: omittedSources });
  event = fixture.records.find(record => record.table === 'attendance_events' && record.row.result_visit === 'null')
    ?? fixture.records.find(record => record.table === 'attendance_events')!;
  correction = fixture.records.find(record => record.table === 'attendance_corrections')!;
}, 120_000);

afterAll(async () => { await fixture?.app.close(); });
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function restore(sql = archivedSql) {
  const app = await restorePublicationDatabase(sql);
  opened.push(app);
  const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  for (const [key, bytes] of fixture.objects) await bucket.put(key, bytes);
  const calls: string[] = [];
  const storage: ArchiveRecordEvidenceStorage = {
    masterKey: fixture.key,
    bucket: {
      get: async (key: string) => {
        calls.push(key);
        return bucket.get(key);
      },
    },
  };
  return { app, db: app.db, bucket, calls, storage };
}

async function restoreTransformed(transformRow: NonNullable<PublicationSnapshotOptions['transformRow']>) {
  return restore(await snapshotPublicationDatabase(fixture.app, {
    omitTables: omittedSources,
    transformRow,
  }));
}

function request(record: RecordFixture, withHash = false): HistoryRequest {
  return {
    id: record.key,
    centerId: String(record.row.center_id),
    kind: record.table === 'attendance_events' ? 'event' : 'correction',
    ...(withHash ? { payloadHash: String(record.row.payload_hash) } : {}),
  };
}

describe('direct compact published request resolution', () => {
  it('replays source-absent event and correction evidence with exactly two object reads', async () => {
    const archived = await restore();
    for (const record of [event, correction]) {
      archived.calls.length = 0;
      expect(await resolveHistoryRequest(archived.db, request(record, true), archived.storage)).toEqual(record.row);
      expect(archived.calls).toHaveLength(2);
      expect(archived.calls[0]).toBe(fixture.archive.objectKey);
    }
    expect((await resolveHistoryRequest(archived.db, request(event), archived.storage))!.result_visit).toBe('null');
    expect(await archived.db.prepare('SELECT count(*) n FROM attendance_events').first<number>('n')).toBe(0);
    expect(await archived.db.prepare('SELECT count(*) n FROM attendance_corrections').first<number>('n')).toBe(0);
  });

  it('rejects changed payload and hides foreign or wrong-kind ownership before object storage', async () => {
    const archived = await restore();
    await expect(resolveHistoryRequest(archived.db, {
      ...request(event), payloadHash: Buffer.alloc(32, 19).toString('base64'),
    }, archived.storage)).rejects.toMatchObject({ status: 409, code: 'EVENT_ID_REUSED' });
    for (const foreign of [
      { ...request(event), centerId: 'other-center' },
      { ...request(event), kind: 'correction' as const },
    ]) {
      expect(await resolveHistoryRequest(archived.db, foreign, archived.storage)).toBeNull();
      await expect(resolveHistoryRequest(archived.db, {
        ...foreign, payloadHash: String(event.row.payload_hash),
      }, archived.storage)).rejects.toMatchObject({ status: 409 });
    }
    expect(archived.calls).toEqual([]);
  });

  it('fails closed when the manifest or selected part is unavailable or corrupt', async () => {
    for (const failure of ['manifest', 'part', 'corrupt'] as const) {
      const archived = await restore();
      const first = await resolveHistoryRequest(archived.db, request(event), archived.storage);
      expect(first).toEqual(event.row);
      const selectedPart = archived.calls[1];
      archived.calls.length = 0;
      if (failure === 'manifest') await archived.bucket.delete(fixture.archive.objectKey);
      if (failure === 'part') await archived.bucket.delete(selectedPart);
      if (failure === 'corrupt') {
        const bytes = fixture.objects.get(selectedPart)!.slice();
        bytes[bytes.length - 1] ^= 1;
        await archived.bucket.put(selectedPart, bytes);
      }
      await expect(resolveHistoryRequest(archived.db, request(event), archived.storage)).rejects.toMatchObject(unavailable);
      expect(archived.calls.length).toBeGreaterThan(0);
      expect(archived.calls.length).toBeLessThanOrEqual(2);
      await archived.app.close();
      opened.splice(opened.indexOf(archived.app), 1);
    }
  });

  it.each(['runtime', 'availability'] as const)('rechecks %s authority after object reads', async field => {
    const archived = await restore();
    const originalGet = archived.storage.bucket.get;
    archived.storage.bucket.get = async key => {
      const result = await originalGet(key);
      if (archived.calls.length === 1) {
        if (field === 'runtime') {
          await archived.db.prepare("UPDATE history_runtime SET generation='changed-during-read' WHERE id=1").run();
        } else {
          await archived.db.prepare("UPDATE archive_compact_availability SET status='unavailable'").run();
        }
      }
      return result;
    };
    await expect(resolveHistoryRequest(archived.db, request(event), archived.storage)).rejects.toMatchObject(unavailable);
    expect(archived.calls).toHaveLength(2);
  });

  it.each(['map', 'descriptor'] as const)('rechecks compact %s when recovery replaces the database during object access', async field => {
    const archived = await restore();
    const replacement = await restoreTransformed((table, row) => {
      if (field === 'map' && table === 'archive_compact_requests' && row.request_id === event.key) {
        return null;
      }
      if (field === 'descriptor' && table === 'archive_compact_publications') {
        return { ...row, header_sha256: '1'.repeat(64) };
      }
      return row;
    });
    let current = archived.db;
    const db = {
      prepare: (sql: string) => current.prepare(sql),
      batch: async <T = Record<string, unknown>>(statements: IsolatedStatement[]) => (
        await current.batch<T>(statements)
      ) as { results: T[] }[],
    };
    const originalGet = archived.storage.bucket.get;
    archived.storage.bucket.get = async key => {
      const result = await originalGet(key);
      current = replacement.db;
      return result;
    };
    await expect(resolveHistoryRequest(db, request(event), archived.storage)).rejects.toMatchObject(unavailable);
    expect(archived.calls).toHaveLength(2);
  });

  it('keeps restored compact evidence unavailable until fresh reconciliation exists', async () => {
    const reset = await restore();
    await reset.app.db.batch(resetStatements.map(sql => reset.app.db.prepare(sql)));
    reset.calls.length = 0;
    await expect(resolveHistoryRequest(reset.db, request(event), reset.storage)).rejects.toMatchObject(unavailable);
    expect(reset.calls).toEqual([]);
  });

  it('uses only primary-key lookups for compact request authority', async () => {
    const archived = await restore();
    const selection = compactPublishedRequestStatement(archived.db, event.key) as IsolatedStatement;
    const plan = await archived.db.prepare(`EXPLAIN QUERY PLAN ${selection.sql}`)
      .bind(...selection.args).all<{ detail: string }>();
    expect(plan.results.some(row => /SCAN\s/i.test(row.detail))).toBe(false);
    for (const alias of ['q', 'i', 'p', 'a']) {
      expect(plan.results.some(row => row.detail.includes(`SEARCH ${alias} USING PRIMARY KEY`))).toBe(true);
    }
  });
});
