import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Context } from 'hono';
import { unstable_splitSqlQuery } from 'wrangler';
import {
  advanceCompactMonthlyPublication,
  startCompactMonthlyPublication,
} from '../worker/archive-compact-publication';
import {
  advanceCompactPublicationReconciliation,
  startCompactPublicationReconciliation,
} from '../worker/archive-compact-reconciliation';
import {
  ARCHIVE_RANGE_LIMITS,
  assertArchiveRangeAuthority,
  readArchiveRange,
} from '../worker/archive-range-reader';
import { verifiedVisitRows } from '../worker/archive-visit-history';
import type { ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';
import type { ReportPage, ReportPhase, ReportRange } from '../shared/attendance-report';
import type { AppEnv } from '../worker/types';
import {
  createPublicationFixture,
  createPublicationSeed,
  refreshPublicationProof,
  restorePublicationDatabase,
  snapshotPublicationDatabase,
} from './archive-publication-fixture';
import { testAudience, testIssuer, type TestRuntime } from './runtime';

type Fixture = Awaited<ReturnType<typeof createPublicationFixture>>;

let fixture: Fixture;
let sourceFreeSql: string;
let visitSourceFreeSql: string;
let publicationId: string;
const opened: TestRuntime[] = [];

async function publish(value: Fixture): Promise<string> {
  const handle = await startCompactMonthlyPublication(value.app.db, value.handle);
  let revision = 0;
  for (let step = 0; step < 100; step += 1) {
    const result = await advanceCompactMonthlyPublication(value.app.db, handle, {
      expectedRevision: revision,
    });
    revision = result.revision;
    if (result.state === 'published') return handle.publicationId;
    if (result.state !== 'building' || result.busy) throw new Error(`Compact publication ${result.state}`);
  }
  throw new Error('Compact publication did not finish');
}

async function restoreSourceFree(sql = sourceFreeSql) {
  const app = await restorePublicationDatabase(sql, {
    metrics: true,
    bindings: {
      APP_ENV: 'local',
      CENTER_ID: 'test-center',
      APP_VERSION: 'archive-range-test',
      ACCESS_ISSUER: testIssuer,
      ACCESS_AUD: testAudience,
      BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
      BACKUP_KEY: fixture.key,
      ARCHIVE_ENABLED: 'true',
    },
  });
  opened.push(app);
  const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  for (const [key, bytes] of fixture.objects) await bucket.put(key, bytes);
  const calls: string[] = [];
  const storage: ArchiveRecordEvidenceStorage = {
    masterKey: fixture.key,
    bucket: {
      get: async key => {
        calls.push(key);
        return bucket.get(key);
      },
    },
  };
  return { app, bucket, calls, storage };
}

beforeAll(async () => {
  fixture = await createPublicationFixture(await createPublicationSeed());
  publicationId = await publish(fixture);
  sourceFreeSql = await snapshotPublicationDatabase(fixture.app, {
    omitTables: ['attendance_events', 'attendance_corrections', 'reviews'],
  });
  visitSourceFreeSql = await snapshotPublicationDatabase(fixture.app, {
    omitTables: ['visits', 'attendance_events', 'attendance_corrections', 'reviews'],
  });
}, 120_000);

afterAll(async () => {
  await fixture?.app.close();
  await Promise.all(opened.splice(0).map(app => app.close()));
});

function query(tables: ('attendance_events' | 'attendance_corrections' | 'reviews')[]) {
  return {
    centerId: fixture.archive.manifest.centerId,
    timezone: fixture.archive.manifest.timezone,
    fromISO: fixture.archive.manifest.periodFrom,
    toISO: fixture.archive.manifest.periodTo,
    scope: 'observed' as const,
    tables,
  };
}

function archiveDates() {
  const [year, month] = fixture.archive.manifest.month.split('-').map(Number);
  return {
    from: `${year}-${String(month).padStart(2, '0')}-01`,
    to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
  };
}

describe('authenticated archive range reader', () => {
  it('rejects archive authority appearing while an empty range result is being finalized', async () => {
    let reads = 0;
    const statement = {
      bind() { return this; },
      async all<T extends Record<string, unknown>>() {
        reads += 1;
        return {
          results: (reads === 1 ? [] : [{ publication_id: 'late-publication' }]) as unknown as T[],
        };
      },
    };
    const db = { prepare: () => statement };

    await expect(readArchiveRange(db, undefined, query(['attendance_events'])))
      .rejects.toThrow('ARCHIVE_RANGE_UNAVAILABLE');
    expect(reads).toBe(2);
  });

  it('reads event and correction evidence after operational source rows are absent', async () => {
    const restored = await restoreSourceFree();
    const result = await readArchiveRange(
      restored.app.db,
      restored.storage,
      query(['attendance_events', 'attendance_corrections']),
    );
    const expected = fixture.records.filter(record =>
      record.table === 'attendance_events' || record.table === 'attendance_corrections');

    expect(result.records).toEqual(expected);
    expect(result.generation).toMatch(/^[a-f0-9]{32}$/);
    expect(result.authoritySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.publications).toBe(1);
    expect(result.objectReads).toBe(restored.calls.length);
    expect(result.objectReads).toBeLessThanOrEqual(ARCHIVE_RANGE_LIMITS.objectReads);
    expect(restored.calls[0]).toBe(fixture.archive.objectKey);
  });

  it('rejects a completed range read after its D1 authority changes', async () => {
    const restored = await restoreSourceFree();
    const rangeQuery = query(['attendance_events']);
    const result = await readArchiveRange(restored.app.db, restored.storage, rangeQuery);
    await restored.app.db.prepare(
      "UPDATE archive_compact_availability SET status='unavailable'",
    ).run();

    await expect(assertArchiveRangeAuthority(
      restored.app.db,
      rangeQuery,
      result.authoritySha256,
    )).rejects.toThrow('ARCHIVE_RANGE_UNAVAILABLE');
  });

  it('reads through a fresh restored-generation reconciliation receipt', async () => {
    const restored = await restoreSourceFree();
    const resetSql = unstable_splitSqlQuery(await readFile(
      new URL('../scripts/recovery-access-reset.sql', import.meta.url),
      'utf8',
    ));
    await restored.app.db.batch(resetSql.map(sql => restored.app.db.prepare(sql)));
    const fresh = await refreshPublicationProof(restored.app, fixture);
    const handle = await startCompactPublicationReconciliation(
      restored.app.db,
      publicationId,
      fresh.handle,
    );
    let revision = 0;
    for (let step = 0; step < 200; step += 1) {
      const result = await advanceCompactPublicationReconciliation(
        restored.app.db,
        restored.storage,
        handle,
        { expectedRevision: revision },
      );
      revision = result.revision;
      if (result.state === 'complete') break;
      if (result.state !== 'pending' || result.busy || step === 199) {
        throw new Error(`Compact reconciliation stopped in ${result.state}`);
      }
    }

    const result = await readArchiveRange(
      restored.app.db,
      restored.storage,
      query(['attendance_events', 'attendance_corrections']),
    );
    expect(result.records).toEqual(fixture.records.filter(record =>
      record.table === 'attendance_events' || record.table === 'attendance_corrections'));
    expect(result.generation).toBe(fresh.handle.generation);
  });

  it('authenticates only parts that contain requested tables', async () => {
    const restored = await restoreSourceFree();
    const result = await readArchiveRange(
      restored.app.db,
      restored.storage,
      query(['attendance_corrections']),
    );
    const correctionParts = fixture.archive.manifest.parts.filter(part =>
      part.recordCounts.attendance_corrections > 0);

    expect(result.records).toEqual(fixture.records.filter(record =>
      record.table === 'attendance_corrections'));
    expect(restored.calls).toHaveLength(1 + correctionParts.length);
    expect(new Set(restored.calls.slice(1))).toEqual(new Set(correctionParts.map(part => part.objectKey)));
  });

  it('supports a manifest-only authority check without reading record parts', async () => {
    const restored = await restoreSourceFree();
    const result = await readArchiveRange(restored.app.db, restored.storage, query([]));

    expect(result.records).toEqual([]);
    expect(result.publications).toBe(1);
    expect(result.objectReads).toBe(1);
    expect(restored.calls).toEqual([fixture.archive.objectKey]);
  });

  it('fails closed when a selected encrypted part is missing', async () => {
    const restored = await restoreSourceFree();
    const missing = fixture.archive.manifest.parts.find(part =>
      part.recordCounts.attendance_events > 0)!.objectKey;
    const storage: ArchiveRecordEvidenceStorage = {
      ...restored.storage,
      bucket: {
        get: key => key === missing ? Promise.resolve(null) : restored.storage.bucket.get(key),
      },
    };

    await expect(readArchiveRange(
      restored.app.db,
      storage,
      query(['attendance_events']),
    )).rejects.toThrow();
  });

  it('rejects an authority change that occurs while R2 is being read', async () => {
    const restored = await restoreSourceFree();
    let changed = false;
    const storage: ArchiveRecordEvidenceStorage = {
      ...restored.storage,
      bucket: {
        get: async key => {
          if (!changed) {
            changed = true;
            await restored.app.db.prepare(
              "UPDATE archive_compact_availability SET status='unavailable'",
            ).run();
          }
          return restored.storage.bucket.get(key);
        },
      },
    };

    await expect(readArchiveRange(
      restored.app.db,
      storage,
      query(['attendance_events']),
    )).rejects.toThrow('ARCHIVE_RANGE_UNAVAILABLE');
  });

  it('serves the normal history events page from source-free R2 evidence', async () => {
    const restored = await restoreSourceFree();
    const token = await restored.app.signer.token();
    const { from, to } = archiveDates();
    const response = await restored.app.request(
      `/api/admin/history/events?from=${from}&to=${to}&page=1&pageSize=50`,
      { token },
    );
    const body = await response.json() as {
      items: { id: string; observedAt: string }[];
      total: number;
    };
    const expected = fixture.records
      .filter(record => record.table === 'attendance_events')
      .sort((left, right) =>
        String(right.row.observed_at).localeCompare(String(left.row.observed_at)) ||
        left.key.localeCompare(right.key));

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.total).toBe(expected.length);
    expect(body.items.map(item => item.id)).toEqual(expected.slice(0, 50).map(record => record.key));
  });

  it('exports source-free archived visits, events, and corrections through normal report pages', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const token = await restored.app.signer.token();
    const { from, to } = archiveDates();
    const read = async (path: string) => {
      const response = await restored.app.request(path, { token });
      const body = await response.json() as ReportPage | { error: unknown };
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body as ReportPage;
    };
    const first = await read(`/api/admin/reports/attendance/pages?from=${from}&to=${to}`);
    const visits = fixture.records.filter(record => record.table === 'visits');
    const events = fixture.records.filter(record => record.table === 'attendance_events');
    const corrections = fixture.records.filter(record => record.table === 'attendance_corrections');
    const attached = events.filter(record => record.row.visit_id !== null);
    const unmatched = events.filter(record => record.row.visit_id === null);

    expect(first.initial?.counts).toEqual({
      visits: visits.length,
      corrections: corrections.length,
      observations: attached.length,
      unmatched: unmatched.length,
    });
    expect(first.items.map(item => item.data.id).sort()).toEqual(visits.map(record => record.key).sort());

    const expectedByPhase: Record<Exclude<ReportPhase, 'visits'>, string[]> = {
      corrections: corrections.map(record => record.key).sort(),
      observations: attached.map(record => record.key).sort(),
      unmatched: unmatched.map(record => record.key).sort(),
    };
    for (const phase of ['corrections', 'observations', 'unmatched'] as const) {
      const page = await read(
        `/api/admin/reports/attendance/pages?from=${from}&to=${to}` +
        `&phase=${phase}&epoch=${first.epoch}&generation=${first.generation}`,
      );
      expect(page.next).toBeNull();
      expect(page.items.map(item => item.data.id).sort()).toEqual(expectedByPhase[phase]);
    }
  });

  it('serves paged visit history from retained heads and authenticated source-free R2 detail', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const token = await restored.app.signer.token();
    const { from, to } = archiveDates();
    const response = await restored.app.request(
      `/api/admin/history?from=${from}&to=${to}&page=1&pageSize=50`,
      { token },
    );
    const body = await response.json() as {
      items: { id: string; checkInAt: string; version: number }[];
      total: number;
    };
    const expected = fixture.records
      .filter(record => record.table === 'visits')
      .sort((left, right) =>
        String(right.row.check_in_at).localeCompare(String(left.row.check_in_at)) ||
        left.key.localeCompare(right.key));
    expect(await restored.app.db.prepare('SELECT count(*) AS n FROM visits').first()).toEqual({ n: 0 });
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.total).toBe(expected.length);
    expect(body.items.map(item => item.id)).toEqual(expected.slice(0, 50).map(record => record.key));
    expect(body.items.every(item => item.version >= 1)).toBe(true);
  });

  it('serves student-filtered visit history from authenticated source-free R2 detail', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const token = await restored.app.signer.token();
    const { from, to } = archiveDates();
    const target = fixture.records.find(record => record.table === 'visits')!;
    const studentId = String(target.row.student_id);
    const expected = fixture.records
      .filter(record => record.table === 'visits' && record.row.student_id === studentId)
      .sort((left, right) =>
        String(right.row.check_in_at).localeCompare(String(left.row.check_in_at)) ||
        left.key.localeCompare(right.key));
    const response = await restored.app.request(
      `/api/admin/history?from=${from}&to=${to}&page=1&pageSize=50&studentId=${encodeURIComponent(studentId)}`,
      { token },
    );
    const body = await response.json() as { items: { id: string }[]; total: number };

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.total).toBe(expected.length);
    expect(body.items.map(item => item.id)).toEqual(expected.map(record => record.key));
  });

  it('serves source-free recent visits and corrections through the student profile', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const token = await restored.app.signer.token();
    const correction = fixture.records.find(record => record.table === 'attendance_corrections')!;
    const correctedVisit = fixture.records.find(record =>
      record.table === 'visits' && record.key === correction.row.visit_id)!;
    const studentId = String(correctedVisit.row.student_id);
    const heads = fixture.records
      .filter(record => record.table === 'visits' && record.row.student_id === studentId)
      .sort((left, right) =>
        String(right.row.check_in_at).localeCompare(String(left.row.check_in_at)) ||
        left.key.localeCompare(right.key))
      .slice(0, 100);
    const headIds = new Set(heads.map(record => record.key));
    const corrections = fixture.records
      .filter(record =>
        record.table === 'attendance_corrections' && headIds.has(String(record.row.visit_id)))
      .sort((left, right) =>
        String(right.row.recorded_at).localeCompare(String(left.row.recorded_at)) ||
        left.key.localeCompare(right.key))
      .slice(0, 100);
    const response = await restored.app.request(`/api/admin/students/${studentId}`, { token });
    const body = await response.json() as {
      visits: { id: string }[];
      corrections: { id: string }[];
    };
    const reads = JSON.parse(response.headers.get('x-isolated-r2-reads') || '[]') as string[];

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.visits.map(item => item.id)).toEqual(heads.slice(0, 20).map(record => record.key));
    expect(body.corrections.map(item => item.id)).toEqual(corrections.map(record => record.key));
    expect(body.corrections.map(item => item.id)).toContain(correction.key);
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads.length).toBeLessThanOrEqual(ARCHIVE_RANGE_LIMITS.objectReads);
  });

  it('corrects an authenticated archived visit without recreating its source row', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const correctedVisitIds = new Set(fixture.records
      .filter(record => record.table === 'attendance_corrections')
      .map(record => String(record.row.visit_id)));
    const source = fixture.records.find(record =>
      record.table === 'visits' && !correctedVisitIds.has(record.key))!;
    const token = await restored.app.signer.token();
    const detail = await restored.app.request(`/api/admin/visits/${source.key}`, { token });
    const current = (await detail.json() as { visit: {
      version: number; checkInAt: string; checkOutAt: string | null;
    } }).visit;
    expect(detail.status).toBe(200);

    const input = {
      correctionId: crypto.randomUUID(),
      expectedVersion: current.version,
      checkInAt: new Date(Date.parse(current.checkInAt) + 1_000).toISOString(),
      checkOutAt: current.checkOutAt
        ? new Date(Date.parse(current.checkOutAt) + 1_000).toISOString()
        : null,
      reason: 'Verified against the signed attendance sheet.',
    };
    const first = await restored.app.request(`/api/admin/visits/${source.key}/corrections`, {
      token,
      method: 'POST',
      body: input,
    });
    const firstBody = await first.json() as {
      correction: { id: string; visitId: string };
      visit: { version: number; checkInAt: string };
      replayed: boolean;
    };
    expect(first.status, JSON.stringify(firstBody)).toBe(201);
    expect(firstBody).toMatchObject({
      correction: { id: input.correctionId, visitId: source.key },
      visit: { version: current.version + 1, checkInAt: input.checkInAt },
      replayed: false,
    });
    expect(await restored.app.db.prepare('SELECT count(*) AS n FROM visits WHERE id=?')
      .bind(source.key).first('n')).toBe(0);
    expect(await restored.app.db.prepare('SELECT count(*) AS n FROM history_correction_outbox WHERE id=?')
      .bind(input.correctionId).first('n')).toBe(1);
    expect(await restored.app.db.prepare('SELECT version FROM history_visit_heads WHERE visit_id=?')
      .bind(source.key).first('version')).toBe(current.version + 1);
    expect(await restored.app.db.prepare('SELECT count(*) AS n FROM audit_timeline WHERE id=?')
      .bind(input.correctionId).first('n')).toBe(1);

    const replay = await restored.app.request(`/api/admin/visits/${source.key}/corrections`, {
      token,
      method: 'POST',
      body: input,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, correction: { id: input.correctionId } });

    const conflict = await restored.app.request(`/api/admin/visits/${source.key}/corrections`, {
      token,
      method: 'POST',
      body: { ...input, reason: 'A different correction payload must not reuse this request reference.' },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'CORRECTION_ID_REUSED' } });

    const stale = await restored.app.request(`/api/admin/visits/${source.key}/corrections`, {
      token,
      method: 'POST',
      body: { ...input, correctionId: crypto.randomUUID() },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'STALE_VISIT' } });

    const secondInput = {
      ...input,
      correctionId: crypto.randomUUID(),
      expectedVersion: current.version + 1,
      reason: 'Second verified adjustment from the signed attendance sheet.',
    };
    const second = await restored.app.request(`/api/admin/visits/${source.key}/corrections`, {
      token,
      method: 'POST',
      body: secondInput,
    });
    expect(second.status, await second.clone().text()).toBe(201);
    expect(JSON.parse(second.headers.get('x-isolated-r2-reads') || '[]')).toEqual([]);
    expect(await restored.app.db.prepare('SELECT count(*) AS n FROM history_correction_outbox WHERE visit_id=?')
      .bind(source.key).first('n')).toBe(2);

    const latest = await restored.app.request(`/api/admin/visits/${source.key}`, { token });
    expect(latest.status).toBe(200);
    expect(JSON.parse(latest.headers.get('x-isolated-r2-reads') || '[]')).toEqual([]);
    expect(await latest.json()).toMatchObject({
      visit: { id: source.key, version: current.version + 2, checkInAt: input.checkInAt },
    });
    const profile = await restored.app.request(
      `/api/admin/students/${String(source.row.student_id)}`,
      { token },
    );
    const profileBody = await profile.json() as {
      visits: { id: string; version: number }[];
      corrections: { id: string }[];
    };
    expect(profile.status, JSON.stringify(profileBody)).toBe(200);
    expect(profileBody.visits).toContainEqual(expect.objectContaining({
      id: source.key,
      version: current.version + 2,
    }));
    expect(profileBody.corrections.map(item => item.id)).toEqual(
      expect.arrayContaining([input.correctionId, secondInput.correctionId]),
    );
  });

  it('does not accept an archived correction when required visit evidence is missing', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const source = fixture.records.find(record => record.table === 'visits')!;
    const part = fixture.archive.manifest.parts.find(item => item.recordCounts.visits > 0)!;
    await restored.bucket.delete(part.objectKey);
    const token = await restored.app.signer.token();
    const response = await restored.app.request(`/api/admin/visits/${source.key}/corrections`, {
      token,
      method: 'POST',
      body: {
        correctionId: crypto.randomUUID(),
        expectedVersion: Number(source.row.version),
        checkInAt: String(source.row.check_in_at),
        checkOutAt: source.row.check_out_at,
        reason: 'Verified against the signed attendance sheet.',
      },
    });
    const body = await response.json() as { error?: { code?: string } };
    expect(response.status).toBe(503);
    expect(body.error?.code).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    expect(await restored.app.db.prepare('SELECT count(*) AS n FROM history_correction_outbox')
      .first('n')).toBe(0);
  });

  it('does not read R2 when the student profile evidence is complete in D1', async () => {
    const correction = fixture.records.find(record => record.table === 'attendance_corrections')!;
    const correctedVisit = fixture.records.find(record =>
      record.table === 'visits' && record.key === correction.row.visit_id)!;
    const token = await fixture.app.signer.token();
    const response = await fixture.app.request(
      `/api/admin/students/${String(correctedVisit.row.student_id)}`,
      { token },
    );
    const body = await response.json() as { visits?: unknown[]; corrections?: unknown[] };

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.visits?.length).toBeGreaterThan(0);
    expect(body.corrections?.length).toBeGreaterThan(0);
    expect(JSON.parse(response.headers.get('x-isolated-r2-reads') || '[]')).toEqual([]);
  });

  it('fails the student profile closed when a live visit is missing its retained head', async () => {
    const restored = await restoreSourceFree(sourceFreeSql);
    const visit = fixture.records.find(record => record.table === 'visits')!;
    await restored.app.db.prepare('DROP TRIGGER history_heads_no_delete').run();
    await restored.app.db.prepare('DELETE FROM history_visit_heads WHERE visit_id=?')
      .bind(visit.key).run();
    const token = await restored.app.signer.token();
    const response = await restored.app.request(
      `/api/admin/students/${String(visit.row.student_id)}`,
      { token },
    );
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
  });

  it('keeps a recent correction visible when its archived visit is older than the 20 profile visits', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const token = await restored.app.signer.token();
    const correction = fixture.records.find(record => record.table === 'attendance_corrections')!;
    const correctedVisit = fixture.records.find(record =>
      record.table === 'visits' && record.key === correction.row.visit_id)!;
    const studentId = String(correctedVisit.row.student_id);
    const statements = Array.from({ length: 20 }, (_, index) => {
      const checkInAt = new Date(Date.parse(fixture.archive.manifest.periodTo) + (index + 1) * 60_000)
        .toISOString();
      const checkOutAt = new Date(Date.parse(checkInAt) + 30_000).toISOString();
      return restored.app.db.prepare(
        `INSERT INTO visits(id,center_id,student_id,check_in_at,check_out_at,
          original_check_in_at,original_check_out_at,check_in_by,check_out_by,
          guardian_id,departure_type,review_status,version)
         VALUES(?,'test-center',?,?,?,?,?,?,?,NULL,'check_out','none',2)`,
      ).bind(
        crypto.randomUUID(), studentId, checkInAt, checkOutAt,
        checkInAt, checkOutAt, fixture.app.actor.id, fixture.app.actor.id,
      );
    });
    await restored.app.db.batch(statements);

    const response = await restored.app.request(`/api/admin/students/${studentId}`, { token });
    const body = await response.json() as {
      visits: { id: string }[];
      corrections: { id: string }[];
    };

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.visits).toHaveLength(20);
    expect(body.visits.map(item => item.id)).not.toContain(correctedVisit.key);
    expect(body.corrections.map(item => item.id)).toContain(correction.key);
  });

  it('fails the student profile closed when required correction evidence is missing', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const correction = fixture.records.find(record => record.table === 'attendance_corrections')!;
    const correctedVisit = fixture.records.find(record =>
      record.table === 'visits' && record.key === correction.row.visit_id)!;
    const part = fixture.archive.manifest.parts.find(item =>
      item.recordCounts.attendance_corrections > 0)!;
    await restored.bucket.delete(part.objectKey);
    const token = await restored.app.signer.token();
    const response = await restored.app.request(
      `/api/admin/students/${String(correctedVisit.row.student_id)}`,
      { token },
    );
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
  });

  it('fails the student profile closed when a correction head disagrees with archive detail', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const correction = fixture.records.find(record => record.table === 'attendance_corrections')!;
    const correctedVisit = fixture.records.find(record =>
      record.table === 'visits' && record.key === correction.row.visit_id)!;
    await restored.app.db.prepare('DROP TRIGGER history_correction_heads_no_update').run();
    await restored.app.db.prepare(
      "UPDATE history_correction_heads SET recorded_at='2025-01-31T23:59:59.000Z' WHERE correction_id=?",
    ).bind(correction.key).run();
    const token = await restored.app.signer.token();
    const response = await restored.app.request(
      `/api/admin/students/${String(correctedVisit.row.student_id)}`,
      { token },
    );
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
  });

  it('serves a later source-free visit report page from its retained-head cursor', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const token = await restored.app.signer.token();
    const { from, to } = archiveDates();
    const read = async (path: string) => {
      const response = await restored.app.request(path, { token });
      const body = await response.json() as ReportPage | { error: unknown };
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body as ReportPage;
    };
    const first = await read(`/api/admin/reports/attendance/pages?from=${from}&to=${to}`);
    expect(first.items.length).toBeGreaterThan(1);
    const after = btoa(JSON.stringify(first.items[0].key));
    const later = await read(
      `/api/admin/reports/attendance/pages?from=${from}&to=${to}` +
      `&phase=visits&epoch=${first.epoch}&generation=${first.generation}` +
      `&after=${encodeURIComponent(after)}`,
    );

    expect(later.items.map(item => item.data.id))
      .toEqual(first.items.slice(1).map(item => item.data.id));
  });

  it('fails closed when a retained visit head disagrees with authenticated archive detail', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    await restored.app.db.prepare('DROP TRIGGER history_heads_validate_update').run();
    await restored.app.db.prepare(
      'UPDATE history_visit_heads SET version=version+1 WHERE visit_id=(SELECT visit_id FROM history_visit_heads LIMIT 1)',
    ).run();
    const token = await restored.app.signer.token();
    const { from, to } = archiveDates();
    const response = await restored.app.request(
      `/api/admin/history?from=${from}&to=${to}&page=1&pageSize=50`,
      { token },
    );
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
  });

  it('rejects source-free visit detail when archive authority changes during R2 reads', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const heads = (await restored.app.db.prepare(
      'SELECT * FROM history_visit_heads ORDER BY check_in_at,visit_id LIMIT 2',
    ).all<Record<string, unknown>>()).results;
    let changed = false;
    const context = {
      env: {
        CRM_DB: restored.app.db,
        CENTER_ID: 'test-center',
        ARCHIVE_ENABLED: 'true',
        BACKUP_KEY: fixture.key,
        BACKUP_BUCKET: {
          get: async (key: string) => {
            if (!changed) {
              changed = true;
              await restored.app.db.prepare(
                "UPDATE archive_compact_availability SET status='unavailable'",
              ).run();
            }
            return restored.bucket.get(key);
          },
        },
      },
    } as unknown as Context<AppEnv>;
    const dates = archiveDates();
    const range: ReportRange = {
      ...dates,
      fromISO: fixture.archive.manifest.periodFrom,
      toISO: fixture.archive.manifest.periodTo,
      timezone: fixture.archive.manifest.timezone,
    };

    await expect(verifiedVisitRows(context, range, heads)).rejects.toMatchObject({
      code: 'HISTORY_EVIDENCE_UNAVAILABLE',
    });
    expect(changed).toBe(true);
  });

  it('does not turn a missing archived visit object into an empty visit history page', async () => {
    const restored = await restoreSourceFree(visitSourceFreeSql);
    const part = fixture.archive.manifest.parts.find(item => item.recordCounts.visits > 0)!;
    const bucket = await restored.app.runtime.getR2Bucket('BACKUP_BUCKET');
    await bucket.delete(part.objectKey);
    const token = await restored.app.signer.token();
    const { from, to } = archiveDates();
    const response = await restored.app.request(
      `/api/admin/history?from=${from}&to=${to}&page=1&pageSize=50`,
      { token },
    );
    const body = await response.json() as { error?: { code?: string }; items?: unknown[] };
    expect(response.status).toBe(503);
    expect(body.error?.code).toBe('HISTORY_EVIDENCE_UNAVAILABLE');
    expect(body).not.toHaveProperty('items');
  });

});
