import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ObservationCorrectionResult,
  ObservationEffectiveTime,
} from '../shared/types.js';
import { createStudent, json, startApp, type App } from './helpers.js';

describe('unmatched observation time corrections', () => {
  let app: App;
  beforeEach(async () => { app = await startApp(); });
  afterEach(async () => { await app.close(); });

  async function seedUnmatched(observedAt = '2026-03-08T07:30:00.000Z') {
    const detail = await createStudent(app);
    const eventId = crypto.randomUUID();
    await app.db.prepare(`INSERT INTO attendance_events(
      id,center_id,student_id,visit_id,action,observed_at,received_at,
      actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce
    ) VALUES(?,'test-center',?,NULL,'exceptional_departure',?,?,?,?,'admin',NULL,NULL,?,?,?)`).bind(
      eventId,
      detail.student.id,
      observedAt,
      observedAt,
      app.actor.id,
      app.actor.displayName,
      'Departure observed without a matching arrival.',
      eventId,
      eventId,
    ).run();
    return { detail, eventId, observedAt };
  }

  const submit = (eventId: string, input: Record<string, unknown>, token = app.token) => app.request(
    `/api/admin/attendance/events/${eventId}/corrections`,
    { token, body: input },
  );

  it('changes only the effective time and exports the complete immutable chain', async () => {
    const source = await seedUnmatched();
    const correctionId = crypto.randomUUID();
    const effectiveObservedAt = '2026-03-08T10:30:00.000Z';
    const result = await json<ObservationCorrectionResult>(await submit(source.eventId, {
      correctionId,
      expectedVersion: 1,
      effectiveObservedAt,
      reason: 'Corrected from the signed front-desk note.',
    }), 201);
    expect(result.replayed).toBe(false);
    expect(result.correction).toMatchObject({
      id: correctionId,
      eventId: source.eventId,
      originalObservedAt: source.observedAt,
      priorEffectiveObservedAt: source.observedAt,
      effectiveObservedAt,
      expectedVersion: 1,
      resultingVersion: 2,
      actorId: app.actor.id,
    });

    const event = await app.db.prepare('SELECT observed_at,result_visit,visit_id FROM attendance_events WHERE id=?')
      .bind(source.eventId).first<Record<string, unknown>>();
    expect(event).toEqual({ observed_at: source.observedAt, result_visit: 'null', visit_id: null });
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits WHERE student_id=?')
      .bind(source.detail.student.id).first('n')).toBe(0);
    const detail = await json<{ observation: ObservationEffectiveTime; corrections: ObservationCorrectionResult['correction'][] }>(
      await app.request(`/api/admin/attendance/events/${source.eventId}/corrections`, { token: app.token }),
    );
    expect(detail.observation).toMatchObject({
      eventId: source.eventId,
      originalObservedAt: source.observedAt,
      effectiveObservedAt,
      version: 2,
      lastCorrectionId: correctionId,
    });
    expect(detail.corrections).toEqual([result.correction]);
    expect(await app.db.prepare("SELECT count(*) AS n FROM report_epochs WHERE center_id='test-center' AND day IN ('2026-03-08','*')")
      .first('n')).toBe(2);

    const history = await json<{ items: Array<{ id: string; effectiveObservedAt: string; observationVersion: number; observationCorrections: Array<{ id: string }> }> }>(
      await app.request('/api/admin/history/events?from=2026-03-07&to=2026-03-07&pageSize=50', { token: app.token }),
    );
    expect(history.items.find(item => item.id === source.eventId)).toMatchObject({
      effectiveObservedAt,
      observationVersion: 2,
      observationCorrections: [{ id: correctionId }],
    });
    const effectiveDayCsv = await app.request(
      '/api/admin/reports/attendance.csv?from=2026-03-08&to=2026-03-08',
      { token: app.token },
    );
    expect(effectiveDayCsv.status).toBe(200);
    const csv = await effectiveDayCsv.text();
    expect(csv).toContain(source.eventId);
    expect(csv).toContain(source.observedAt);
    expect(csv).toContain(effectiveObservedAt);
    expect(csv).toContain(correctionId);
    const originalDayCsv = await app.request(
      '/api/admin/reports/attendance.csv?from=2026-03-07&to=2026-03-07',
      { token: app.token },
    );
    expect(originalDayCsv.status).toBe(200);
    expect(await originalDayCsv.text()).not.toContain(source.eventId);
  });

  it('returns one acceptance and one exact replay under concurrent submissions', async () => {
    const source = await seedUnmatched();
    const input = {
      correctionId: crypto.randomUUID(),
      expectedVersion: 1,
      effectiveObservedAt: '2026-03-08T06:45:00.000Z',
      reason: 'Matched the paper departure record.',
    };
    const responses = await Promise.all([submit(source.eventId, input), submit(source.eventId, input)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const results = await Promise.all(responses.map(response => response.json() as Promise<ObservationCorrectionResult>));
    expect(results[0].correction).toEqual(results[1].correction);
    expect(await app.db.prepare('SELECT count(*) AS n FROM observation_corrections WHERE event_id=?')
      .bind(source.eventId).first('n')).toBe(1);
    expect(await app.db.prepare('SELECT count(*) AS n FROM observation_correction_request_keys WHERE request_id=?')
      .bind(input.correctionId).first('n')).toBe(1);
  });

  it('resolves a lost response with the same request and rejects changed reuse', async () => {
    const source = await seedUnmatched();
    const input = {
      correctionId: crypto.randomUUID(),
      expectedVersion: 1,
      effectiveObservedAt: '2026-03-08T06:45:00.000Z',
      reason: 'Matched the paper departure record.',
    };
    const lost = await submit(source.eventId, input);
    expect(lost.status).toBe(201);
    await lost.body?.cancel();
    const replay = await json<ObservationCorrectionResult>(await submit(source.eventId, input));
    expect(replay.replayed).toBe(true);
    expect((await submit(source.eventId, { ...input, reason: 'A different explanation.' })).status).toBe(409);
    const receipt = await json<ObservationCorrectionResult>(await app.request(
      `/api/admin/attendance/events/${source.eventId}/corrections/${input.correctionId}`,
      { token: app.token },
    ));
    expect(receipt.correction).toEqual(replay.correction);
  });

  it('serializes competing versions and rejects cross-type request IDs', async () => {
    const source = await seedUnmatched();
    const first = {
      correctionId: crypto.randomUUID(),
      expectedVersion: 1,
      effectiveObservedAt: '2026-03-08T06:45:00.000Z',
      reason: 'Matched the paper departure record.',
    };
    const second = { ...first, correctionId: crypto.randomUUID(), effectiveObservedAt: '2026-03-08T06:50:00.000Z' };
    const responses = await Promise.all([submit(source.eventId, first), submit(source.eventId, second)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);

    const eventRequest = crypto.randomUUID();
    await app.db.prepare(`INSERT INTO history_request_keys(
      request_id,source_kind,center_id,payload_hash,hash_encoding
    ) VALUES(?,'event','test-center',?,'opaque')`).bind(eventRequest, 'existing-event-owner').run();
    expect((await submit(source.eventId, { ...first, correctionId: eventRequest, expectedVersion: 2 })).status).toBe(409);
  });

  it('rejects an attendance event that reuses an accepted observation correction ID', async () => {
    const source = await seedUnmatched();
    const correctionId = crypto.randomUUID();
    await json<ObservationCorrectionResult>(await submit(source.eventId, {
      correctionId,
      expectedVersion: 1,
      effectiveObservedAt: '2026-03-08T06:45:00.000Z',
      reason: 'Matched paper departure record.',
    }), 201);

    const response = await app.request('/api/admin/attendance', {
      token: app.token,
      body: {
        eventId: correctionId,
        studentId: source.detail.student.id,
        action: 'check_in',
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'IMMUTABLE_HISTORY_SOURCE' },
    });
    expect(await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE id=?')
      .bind(correctionId).first('n')).toBe(0);
  });

  it('requires a manager and honors backup and archive fences', async () => {
    const source = await seedUnmatched();
    const timestamp = new Date().toISOString();
    const frontDeskId = crypto.randomUUID();
    await app.db.prepare(`INSERT INTO staff(
      id,center_id,email,display_name,role,active,kiosk_enabled,session_version,created_at,updated_at
    ) VALUES(?,'test-center','front@example.test','Front Desk','front_desk',1,0,1,?,?)`)
      .bind(frontDeskId, timestamp, timestamp).run();
    const frontToken = await app.signer.token({ email: 'front@example.test', sub: 'front-desk' });
    const input = {
      correctionId: crypto.randomUUID(),
      expectedVersion: 1,
      effectiveObservedAt: '2026-03-08T06:45:00.000Z',
      reason: 'Matched the paper departure record.',
    };
    expect((await submit(source.eventId, input, frontToken)).status).toBe(403);

    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=? WHERE id=1')
      .bind(new Date(Date.now() + 60_000).toISOString(), 'observation-test-lock').run();
    expect((await submit(source.eventId, input)).status).toBe(503);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL,lock_job_id=NULL WHERE id=1').run();

    const archiveId = crypto.randomUUID();
    const future = new Date(Date.now() + 60_000).toISOString();
    await app.db.prepare(`INSERT INTO archive_jobs(
      id,center_id,month,timezone,period_from,period_to,cutoff,created_at,updated_at,
      created_by,schema_json,application_version,status,source_expires_at
    ) VALUES(?,'test-center','2026-03','America/Los_Angeles','2026-03-01T08:00:00.000Z',
      '2026-04-01T07:00:00.000Z',?,?,?,?,'[38]','test','parts',?)`).bind(
      archiveId,
      timestamp,
      timestamp,
      timestamp,
      app.actor.id,
      future,
    ).run();
    await app.db.prepare("INSERT INTO archive_members(job_id,table_name,record_key) VALUES(?,'attendance_events',?)")
      .bind(archiveId, source.eventId).run();
    expect((await submit(source.eventId, input)).status).toBe(409);
  });

  it('keeps corrections, request ownership, and projections immutable', async () => {
    const source = await seedUnmatched();
    const input = {
      correctionId: crypto.randomUUID(),
      expectedVersion: 1,
      effectiveObservedAt: '2026-03-08T06:45:00.000Z',
      reason: 'Matched the paper departure record.',
    };
    await json(await submit(source.eventId, input), 201);
    await expect(app.db.prepare('UPDATE observation_corrections SET reason=? WHERE id=?')
      .bind('Changed later.', input.correctionId).run()).rejects.toThrow('IMMUTABLE_OBSERVATION_CORRECTION');
    await expect(app.db.prepare('DELETE FROM observation_correction_request_keys WHERE request_id=?')
      .bind(input.correctionId).run()).rejects.toThrow('IMMUTABLE_OBSERVATION_REQUEST');
    await expect(app.db.prepare('DELETE FROM observation_effective_times WHERE event_id=?')
      .bind(source.eventId).run()).rejects.toThrow('IMMUTABLE_OBSERVATION_PROJECTION');
  });
});
