import { createHash, randomBytes } from 'node:crypto';
import type { ArchiveMetadata, ArchiveRecord } from '../shared/archive-format';
import { sourcePage, type ArchiveJob } from '../worker/archive-source';
import type { Env } from '../worker/types';
import { createStudent, json, startApp, type App } from './helpers';

/** Records produced by native application triggers, then detached from their source database. */
export async function nativeSemanticFixture(corrections = 1, exceptionalGuardian = false, beforeClose?: (app: App) => Promise<void>) {
  const key = randomBytes(32).toString('base64');
  const app = await startApp({ r2: true, bindings: { APP_ENV: 'local', ARCHIVE_ENABLED: 'true', BACKUP_KEY: key } });
  try {
    const at = new Date().toISOString(), device = crypto.randomUUID(), enrollment = crypto.randomUUID();
    await app.db.batch([
      app.db.prepare('INSERT INTO device_enrollments(id,center_id,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(enrollment, 'test-center', crypto.randomUUID(), at, app.actor.id, at),
      app.db.prepare('INSERT INTO kiosk_devices(id,center_id,enrollment_id,token_hash,label,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(device, 'test-center', enrollment, crypto.randomUUID(), 'Synthetic verification device', at, at),
    ]);
    const insert = async (studentId: string, visitId: string | null, action: string, observedAt: string, guardianId: string | null = null, reason: string | null = null, kiosk = false) => {
      const eventId = crypto.randomUUID();
      const payloadHash = createHash('sha256').update(JSON.stringify({ studentId, action, observedAt, guardianId, reason })).digest('base64');
      await app.db.prepare('INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(eventId, 'test-center', studentId, visitId, action, observedAt, observedAt, app.actor.id, app.actor.displayName, kiosk ? 'kiosk' : 'admin', kiosk ? device : null, guardianId, reason, payloadHash, crypto.randomUUID()).run();
      return eventId;
    };

    const first = await createStudent(app), correctedVisit = crypto.randomUUID();
    await insert(first.student.id, correctedVisit, 'check_in', '2025-01-10T18:00:00.000Z');
    const exception = await insert(first.student.id, correctedVisit, 'exceptional_departure', '2025-01-10T19:00:00.000Z', exceptionalGuardian ? first.guardians.find(guardian => guardian.pickupAuthority === 'allowed')!.id : null, 'Observed exceptional departure', true);
    for (let index = 0; index < corrections; index++) {
      await json(await app.request(`/api/admin/visits/${correctedVisit}/corrections`, {
        token: app.token, body: { correctionId: crypto.randomUUID(), expectedVersion: index + 2,
          checkInAt: new Date(Date.parse('2025-01-10T18:01:00.000Z') + index * 1000).toISOString(),
          checkOutAt: new Date(Date.parse('2025-01-10T19:01:00.000Z') + index * 1000).toISOString(), reason: `Verified correction ${index}` },
      }), 201);
    }
    await json(await app.request(`/api/admin/reviews/${exception}/resolve`, { token: app.token, body: { resolution: 'Departure evidence reviewed' } }));

    const second = await createStudent(app);
    const unmatched = await insert(second.student.id, null, 'exceptional_departure', '2025-01-11T19:00:00.000Z', null, 'Observed departure without arrival');
    await json(await app.request(`/api/admin/reviews/${unmatched}/resolve`, { token: app.token, body: { resolution: 'Unmatched departure documented' } }));

    const third = await createStudent(app), normalVisit = crypto.randomUUID();
    await insert(third.student.id, normalVisit, 'check_in', '2025-01-12T18:00:00.000Z');
    await insert(third.student.id, normalVisit, 'check_out', '2025-01-12T19:00:00.000Z', third.guardians.find(guardian => guardian.pickupAuthority === 'allowed')!.id);

    const started = await json<{ jobId: string }>(await app.request('/api/admin/archives/start', { token: app.token, body: { month: '2025-01' } }), 202);
    const job = await app.db.prepare('SELECT * FROM archive_jobs WHERE id=?').bind(started.jobId).first<ArchiveJob>();
    const records: ArchiveRecord[] = [];
    for (let table = 0; table < 10; table++) {
      let after = '';
      for (;;) {
        const page = await sourcePage({ CRM_DB: app.db } as unknown as Env, job!, table, after, 256);
        records.push(...page);
        if (page.length < 256) break;
        after = page.at(-1)!.key;
      }
    }
    const metadata: ArchiveMetadata = {
      archiveId: 'resumable-semantic-base', centerId: 'test-center', month: job!.month, timezone: job!.timezone,
      kind: 'monthly', createdAt: job!.created_at, applicationVersion: 'independent-runner-fixture',
      schemaVersions: JSON.parse(job!.schema_json), references: [],
      semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [{ id: device, centerId: 'test-center' }] },
    };
    await beforeClose?.(app);
    return { records, metadata, correctedVisit, key };
  } finally { await app.close(); }
}
