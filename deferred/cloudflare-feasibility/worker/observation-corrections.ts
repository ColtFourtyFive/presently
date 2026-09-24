import { Hono } from 'hono';
import type {
  ObservationCorrection,
  ObservationCorrectionResult,
  ObservationEffectiveTime,
} from '../shared/types';
import type { AppEnv } from './types';
import {
  ApiProblem,
  body,
  centerId,
  dateValue,
  id,
  managementRoles,
  now,
  requireRole,
  sha256,
  textValue,
  uuidValue,
} from './util';

type Row = Record<string, unknown>;

function correctionView(row: Row): ObservationCorrection {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    originalObservedAt: String(row.original_observed_at),
    priorEffectiveObservedAt: String(row.prior_effective_observed_at),
    effectiveObservedAt: String(row.effective_observed_at),
    expectedVersion: Number(row.expected_version),
    resultingVersion: Number(row.resulting_version),
    reason: String(row.reason),
    actorId: String(row.actor_id),
    actorName: String(row.actor_name),
    recordedAt: String(row.recorded_at),
  };
}

function projectionView(row: Row): ObservationEffectiveTime {
  return {
    eventId: String(row.event_id),
    originalObservedAt: String(row.original_observed_at),
    effectiveObservedAt: String(row.effective_observed_at),
    version: Number(row.version),
    lastCorrectionId: row.last_correction_id === null ? null : String(row.last_correction_id),
    updatedAt: String(row.updated_at),
  };
}

function reused(): ApiProblem {
  return new ApiProblem(
    409,
    'OBSERVATION_CORRECTION_ID_REUSED',
    'This correction reference is already in use and cannot accept different details.',
  );
}

function unavailable(): ApiProblem {
  return new ApiProblem(
    503,
    'OBSERVATION_CORRECTION_UNAVAILABLE',
    'This correction cannot currently be verified. Keep the same correction reference and try again.',
  );
}

async function resolveCorrection(
  db: D1Database,
  request: { id: string; centerId: string; eventId: string; payloadHash?: string },
): Promise<Row | null> {
  const result = await db.batch<Row>([
    db.prepare('SELECT * FROM observation_correction_request_keys WHERE request_id=?').bind(request.id),
    db.prepare(`SELECT c.*,p.original_observed_at
      FROM observation_corrections c
      JOIN observation_effective_times p ON p.event_id=c.event_id
      WHERE c.id=?`).bind(request.id),
    db.prepare('SELECT source_kind,center_id,payload_hash FROM history_request_keys WHERE request_id=?').bind(request.id),
  ]);
  const key = result[0].results[0];
  const correction = result[1].results[0];
  const foreign = result[2].results[0];
  if (foreign) {
    if (request.payloadHash !== undefined) throw reused();
    return null;
  }
  if (!key && !correction) return null;
  if (!key || !correction) throw unavailable();
  if (
    key.source_kind !== 'observation_correction'
    || key.center_id !== request.centerId
    || key.event_id !== request.eventId
    || correction.center_id !== key.center_id
    || correction.event_id !== key.event_id
    || correction.payload_hash !== key.payload_hash
  ) {
    if (request.payloadHash !== undefined) throw reused();
    return null;
  }
  if (request.payloadHash !== undefined && key.payload_hash !== request.payloadHash) throw reused();
  return correction;
}

function resultView(row: Row, replayed: boolean): ObservationCorrectionResult {
  return { correction: correctionView(row), replayed };
}

export function createObservationCorrectionsRouter() {
  const app = new Hono<AppEnv>();

  app.post('/attendance/events/:id/corrections', async c => {
    if (c.var.actor.channel !== 'admin') {
      throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace to correct an observation.');
    }
    requireRole(c, managementRoles);
    const eventId = uuidValue(c.req.param('id'), 'eventId');
    const input = await body(c);
    const correctionId = uuidValue(input.correctionId, 'correctionId');
    const expectedVersion = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new ApiProblem(400, 'INVALID_VERSION', 'Provide the observation version you reviewed.');
    }
    const effectiveObservedAt = dateValue(input.effectiveObservedAt, 'effectiveObservedAt');
    const reason = textValue(input.reason, 'reason', 2000);
    if (reason.length < 5) {
      throw new ApiProblem(400, 'REASON_REQUIRED', 'Record why the observed departure time needs correction.');
    }
    const payloadHash = await sha256(JSON.stringify({
      eventId,
      expectedVersion,
      effectiveObservedAt,
      reason,
    }));
    const request = { id: correctionId, centerId: centerId(c), eventId, payloadHash };
    const existing = await resolveCorrection(c.env.CRM_DB, request);
    if (existing) return c.json(resultView(existing, true));

    const recordedAt = now();
    const nonce = id();
    let results: D1Result<Row>[];
    try {
      results = await c.env.CRM_DB.batch<Row>([
        c.env.CRM_DB.prepare(`INSERT INTO observation_corrections(
          id,center_id,event_id,expected_version,prior_effective_observed_at,
          effective_observed_at,reason,actor_id,actor_name,recorded_at,
          payload_hash,resulting_version,insertion_nonce
        )
        SELECT ?,e.center_id,e.id,?,coalesce(p.effective_observed_at,e.observed_at),?,?,?,?,?,?,?+1,?
        FROM attendance_events e
        LEFT JOIN observation_effective_times p ON p.event_id=e.id
        WHERE e.id=? AND e.center_id=? AND coalesce(p.version,1)=?
          AND e.visit_id IS NULL AND e.action='exceptional_departure' AND e.result_visit='null'
        ON CONFLICT(id) DO NOTHING
        RETURNING id`).bind(
          correctionId,
          expectedVersion,
          effectiveObservedAt,
          reason,
          c.var.actor.id,
          c.var.actor.displayName,
          recordedAt,
          payloadHash,
          expectedVersion,
          nonce,
          eventId,
          centerId(c),
          expectedVersion,
        ),
        c.env.CRM_DB.prepare(`SELECT c.*,p.original_observed_at
          FROM observation_corrections c
          JOIN observation_effective_times p ON p.event_id=c.event_id
          WHERE c.id=?`).bind(correctionId),
      ]);
    } catch (error) {
      const replay = await resolveCorrection(c.env.CRM_DB, request);
      if (replay) return c.json(resultView(replay, true));
      throw error;
    }

    const row = results[1].results[0];
    if (!results[0].results.length) {
      const replay = await resolveCorrection(c.env.CRM_DB, request);
      if (replay) return c.json(resultView(replay, true));
      const current = await c.env.CRM_DB.prepare(`SELECT e.id,e.center_id,e.visit_id,e.action,e.result_visit,p.version
        FROM attendance_events e
        LEFT JOIN observation_effective_times p ON p.event_id=e.id
        WHERE e.id=? AND e.center_id=?`).bind(eventId, centerId(c)).first<Row>();
      if (!current) throw new ApiProblem(404, 'EVENT_NOT_FOUND', 'Attendance observation was not found.');
      if (current.visit_id !== null || current.action !== 'exceptional_departure' || current.result_visit !== 'null') {
        throw new ApiProblem(409, 'OBSERVATION_NOT_CORRECTABLE', 'Only an unmatched exceptional departure can use this correction.');
      }
      throw new ApiProblem(409, 'STALE_OBSERVATION', 'This observation changed. Reload it before saving a correction.');
    }
    if (!row || row.insertion_nonce !== nonce || row.payload_hash !== payloadHash) throw unavailable();
    return c.json(resultView(row, false), 201);
  });

  app.get('/attendance/events/:eventId/corrections/:correctionId', async c => {
    requireRole(c, managementRoles);
    const eventId = uuidValue(c.req.param('eventId'), 'eventId');
    const correctionId = uuidValue(c.req.param('correctionId'), 'correctionId');
    const row = await resolveCorrection(c.env.CRM_DB, {
      id: correctionId,
      centerId: centerId(c),
      eventId,
    });
    if (!row) throw new ApiProblem(404, 'CORRECTION_NOT_FOUND', 'Observation correction was not found.');
    return c.json(resultView(row, true));
  });

  app.get('/attendance/events/:id/corrections', async c => {
    requireRole(c, managementRoles);
    const eventId = uuidValue(c.req.param('id'), 'eventId');
    const results = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare(`SELECT p.*
        FROM observation_effective_times p
        JOIN attendance_events e ON e.id=p.event_id
        WHERE p.event_id=? AND p.center_id=?
          AND e.visit_id IS NULL AND e.action='exceptional_departure' AND e.result_visit='null'`).bind(eventId, centerId(c)),
      c.env.CRM_DB.prepare(`SELECT c.*,p.original_observed_at
        FROM observation_corrections c
        JOIN observation_effective_times p ON p.event_id=c.event_id
        WHERE c.event_id=? AND c.center_id=?
        ORDER BY c.resulting_version,c.id`).bind(eventId, centerId(c)),
    ]);
    const projection = results[0].results[0];
    if (!projection) throw new ApiProblem(404, 'EVENT_NOT_FOUND', 'Correctable observation was not found.');
    return c.json({
      observation: projectionView(projection),
      corrections: results[1].results.map(correctionView),
    });
  });

  return app;
}
