import { decodeAttendanceReceipt } from './attendance-receipt';
import {
  compactPublishedRequestStatement,
  loadCompactPublishedRequestEvidence,
  loadPublishedRequestEvidence,
  publishedRequestStatement,
  type HistoryReadDatabase,
  type HistoryReadStatement,
} from './archive-publication-reader';
import type { ArchiveRecordEvidenceStorage } from './archive-record-evidence';
import { ApiProblem } from './util';

type RequestKind = 'event' | 'correction';
type HashEncoding = 'hex-sha256' | 'base64-sha256' | 'base64url-sha256' | 'opaque' | 'none';
type Owner = { source_kind: RequestKind | 'audit'; center_id: string; payload_hash: string | null };
type Key = Owner & { request_id: string; hash_encoding: HashEncoding; canonicalization: string };
export type HistoryRequest = { id: string; centerId: string; kind: RequestKind; payloadHash?: string };

export function historyEvidenceUnavailable(): ApiProblem {
  return new ApiProblem(503, 'HISTORY_EVIDENCE_UNAVAILABLE', 'This request cannot currently be checked against its recorded history. Keep the same request reference and check again.');
}

function reused(kind: RequestKind): ApiProblem {
  return new ApiProblem(409, kind === 'event' ? 'EVENT_ID_REUSED' : 'CORRECTION_ID_REUSED', 'This request ID is already in use and cannot be accepted for these details.');
}

function encodingOf(hash: string): HashEncoding {
  if (/^[a-fA-F0-9]{64}$/.test(hash)) return 'hex-sha256';
  if (/^[A-Za-z0-9+/]{43}=$/.test(hash)) return 'base64-sha256';
  if (/^[A-Za-z0-9_-]{43}$/.test(hash)) return 'base64url-sha256';
  return 'opaque';
}

/** Representation conversion only. Never recompute a stored request from today's
 * student/visit values or silently reinterpret an opaque historical fingerprint. */
function canonicalHash(hash: string, encoding: HashEncoding): string {
  if (encoding !== encodingOf(hash)) throw historyEvidenceUnavailable();
  if (encoding === 'opaque') return hash;
  if (encoding === 'hex-sha256') return hash.toLowerCase();
  const base64 = encoding === 'base64url-sha256' ? hash.replaceAll('-', '+').replaceAll('_', '/') + '=' : hash;
  let decoded: string;
  try { decoded = atob(base64); } catch { throw historyEvidenceUnavailable(); }
  if (decoded.length !== 32 || btoa(decoded) !== base64) throw historyEvidenceUnavailable();
  return Array.from(decoded, character => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

export function requireRequestHash(row: { payload_hash?: unknown }, request: HistoryRequest): void {
  if (typeof row.payload_hash !== 'string') throw historyEvidenceUnavailable();
  const encoding = encodingOf(row.payload_hash);
  const stored = canonicalHash(row.payload_hash, encoding);
  if (request.payloadHash === undefined) return;
  const matches = encoding === 'opaque' ? row.payload_hash === request.payloadHash
    : stored === canonicalHash(request.payloadHash, encodingOf(request.payloadHash));
  if (!matches) throw reused(request.kind);
}

export function requireSealedEvent(row: Record<string, unknown>): void {
  try {
    const receipt = decodeAttendanceReceipt({ visit_id: row.visit_id, student_id: row.student_id, action: row.action, observed_at: row.observed_at, result_visit: row.result_visit });
    if (receipt === null) {
      if (row.action !== 'exceptional_departure' || row.visit_id !== null) throw historyEvidenceUnavailable();
    } else if (receipt.id !== row.visit_id || receipt.studentId !== row.student_id) throw historyEvidenceUnavailable();
  } catch { throw historyEvidenceUnavailable(); }
}

/** A single D1 snapshot distinguishes unused IDs, legacy live owners and durable
 * reservations. A hashless read returns null for undisclosed foreign IDs too;
 * only a payload-bearing write lookup may interpret null as permission to insert.
 * Known but unavailable evidence must never look like a new ID.
 * Authenticated receipt GET and POST replay callers may supply read-only archive
 * storage when enabled. A known ID never becomes insertable when storage fails. */
export async function resolveHistoryRequest<S extends HistoryReadStatement<S>>(db: HistoryReadDatabase<S>, suppliedRequest: HistoryRequest, archiveStorage?: ArchiveRecordEvidenceStorage): Promise<Record<string, unknown> | null> {
  const request = Object.freeze({ ...suppliedRequest });
  const table = request.kind === 'event' ? 'attendance_events' : 'attendance_corrections';
  // The permanent source owner keeps its audit alias from becoming a new owner
  // when source detail is absent from a restored archive fixture.
  const auditAlias = " AND NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=? AND source_kind IN ('event','correction'))";
  const snapshot = () => db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM history_request_keys WHERE request_id=?').bind(request.id),
    db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(request.id),
    db.prepare(`SELECT 'event' AS source_kind,center_id,payload_hash FROM attendance_events WHERE id=?
      UNION ALL SELECT 'correction',center_id,payload_hash FROM attendance_corrections WHERE id=?
      UNION ALL SELECT 'audit',center_id,NULL FROM audit_entries WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=?) AND NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=?)${auditAlias}`)
      .bind(request.id, request.id, request.id, request.id, request.id, request.id),
    db.prepare('SELECT state,generation FROM history_runtime WHERE id=1'),
    ...(archiveStorage ? [
      publishedRequestStatement(db, request.id),
      compactPublishedRequestStatement(db, request.id),
    ] : []),
  ]);
  const results = await snapshot();
  const key = results[0].results[0] as Key | undefined;
  let row = results[1].results[0];
  const owners = results[2].results as Owner[];
  const runtime = results[3].results[0];
  const published = archiveStorage ? results[4].results : [];
  const compact = archiveStorage ? results[5].results : [];
  if (!row && key?.source_kind === 'correction') {
    try {
      const [outbox] = await db.batch<Record<string, unknown>>([
        db.prepare('SELECT * FROM history_correction_outbox WHERE id=?').bind(request.id),
      ]);
      row = outbox.results[0];
      if (row) owners.push({
        source_kind: 'correction',
        center_id: String(row.center_id),
        payload_hash: typeof row.payload_hash === 'string' ? row.payload_hash : null,
      });
    } catch (error) {
      // During a rolling migration, an older schema has no outbox yet. Its
      // retained or archived correction authority remains handled below.
      if (!String(error).includes('no such table')) throw error;
    }
  }
  if (!runtime || !['backfilling', 'ready'].includes(String(runtime.state))) throw historyEvidenceUnavailable();
  const owner = key ?? owners[0];
  if (!owner) {
    if (published.length || compact.length) throw historyEvidenceUnavailable();
    return null;
  }
  // Keep cross-center and cross-type probes indistinguishable from absence.
  if (owner.center_id !== request.centerId || owner.source_kind !== request.kind) {
    if (request.payloadHash !== undefined) throw reused(request.kind);
    return null;
  }
  if (owners.length > 1 || (key && owners[0] && (key.center_id !== owners[0].center_id || key.source_kind !== owners[0].source_kind || key.payload_hash !== owners[0].payload_hash))) throw historyEvidenceUnavailable();
  if (!key && runtime.state === 'ready') throw historyEvidenceUnavailable();
  if (key && (key.canonicalization !== 'legacy-unverified' || typeof key.payload_hash !== 'string' || key.hash_encoding !== encodingOf(key.payload_hash))) throw historyEvidenceUnavailable();
  // Changed payloads are definite conflicts even while R2 is unavailable.
  requireRequestHash(owner, request);
  if (row || owners[0]) {
    // R2 must never mask inconsistent retained evidence.
    if (!row || !owners[0] || row.center_id !== request.centerId || row.id !== request.id || row.payload_hash !== owner.payload_hash) throw historyEvidenceUnavailable();
    if (request.kind === 'event') requireSealedEvent(row);
    return row;
  }
  if (!archiveStorage || !key || runtime.state !== 'ready' || typeof runtime.generation !== 'string') throw historyEvidenceUnavailable();
  if (published.length + compact.length !== 1) throw historyEvidenceUnavailable();
  try {
    const expected = {
      requestId: request.id, sourceKind: request.kind, centerId: request.centerId, payloadHash: key.payload_hash!, generation: runtime.generation,
    };
    const recovered = published.length === 1
      ? await loadPublishedRequestEvidence(archiveStorage, published[0], expected)
      : await loadCompactPublishedRequestEvidence(archiveStorage, compact[0], expected);
    if (request.kind === 'event') requireSealedEvent(recovered);
    // Registry, runtime, live ownership and every selected locator field must
    // still match after R2 awaits. Restore or authority changes fail closed.
    const refreshed = await snapshot();
    if (JSON.stringify(results.map(result => result.results)) !== JSON.stringify(refreshed.map(result => result.results))) throw historyEvidenceUnavailable();
    return recovered;
  } catch { throw historyEvidenceUnavailable(); }
}
