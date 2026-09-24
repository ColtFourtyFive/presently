import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advanceCompactMonthlyPublication, startCompactMonthlyPublication } from '../worker/archive-compact-publication';
import { advanceRetentionDryRun, startRetentionDryRun } from '../worker/history-retention';
import { evictRetentionSource } from '../worker/history-source-eviction';
import { createPublicationFixture, createPublicationSeed, type PublicationSeed } from './archive-publication-fixture';
import type { TestRuntime } from './runtime';

let seed: PublicationSeed;
const runtimes: TestRuntime[] = [];

beforeAll(async () => {
  seed = await createPublicationSeed();
}, 120_000);

afterAll(() => {
  seed = undefined as unknown as PublicationSeed;
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
});

describe('compact archive retention authority', () => {
  it('verifies a dry-run candidate through compact monthly authority and keeps eviction disabled', async () => {
    const fixture = await createPublicationFixture(seed);
    runtimes.push(fixture.app);
    const publication = await startCompactMonthlyPublication(fixture.app.db, fixture.handle);
    for (let call = 0; call < 5_000; call += 1) {
      const row = await fixture.app.db.prepare('SELECT state,revision FROM archive_compact_builds WHERE publication_id=?')
        .bind(publication.publicationId).first<{ state: string; revision: number }>();
      if (row?.state === 'published') break;
      if (!row || row.state === 'invalid') throw new Error('Compact publication stopped.');
      await advanceCompactMonthlyPublication(fixture.app.db, publication, { expectedRevision: row.revision });
      if (call === 4_999) throw new Error('Compact publication did not finish.');
    }

    const storage = { bucket: fixture.bucket, masterKey: fixture.key };
    const jobId = await startRetentionDryRun(fixture.app.db as unknown as D1Database, 'test-center', fixture.app.actor.id, 1);
    let revision = 0;
    for (let call = 0; call < 500; call += 1) {
      const result = await advanceRetentionDryRun(fixture.app.db as unknown as D1Database, storage, jobId, { expectedRevision: revision });
      revision = result.revision;
      if (result.status === 'complete') break;
      if (result.status !== 'planning') throw new Error(`Retention dry run stopped: ${result.status}:${result.errorCode ?? 'UNKNOWN'}`);
      if (call === 499) throw new Error('Retention dry run did not finish.');
    }

    const item = await fixture.app.db.prepare('SELECT visit_id,base_publication_id FROM history_retention_items WHERE job_id=?')
      .bind(jobId).first<{ visit_id: string; base_publication_id: string }>();
    expect(item).toMatchObject({ base_publication_id: publication.publicationId });
    expect(await fixture.app.db.prepare("SELECT status FROM history_retention_jobs WHERE job_id=?").bind(jobId).first('status')).toBe('complete');
    await expect(evictRetentionSource(fixture.app.db as unknown as D1Database, storage, jobId, item!.visit_id, fixture.app.actor.id))
      .rejects.toThrow('SOURCE_EVICTION_DISABLED');
  }, 180_000);
});
