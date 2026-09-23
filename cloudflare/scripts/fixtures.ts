import { createHash } from 'node:crypto';
import { IsolatedDatabase, type IsolatedStatement } from '../tests/runtime.js';
import type { Actor } from '../shared/types.js';

export const fixtureId = (group: number, index: number) => `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const fixturePayloadHash = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('base64');

/** This function accepts only the isolated test transport, never a live D1 binding. */
export async function seedGrowthFixture(db: IsolatedDatabase, owner: Actor, operatingDays = 400, progress: (message: string) => void = () => {}, options: { centerId?: string; dayLayout?: 'spread' | 'recent' } = {}) {
  if (!(db instanceof IsolatedDatabase)) throw new Error('Growth fixtures require the isolated test database transport.');
  const center = options.centerId ?? 'test-center';
  const students = 340, activeStudents = 300, families = 230, dailyVisits = 150;
  const timestamp = new Date().toISOString();
  const pending: IsolatedStatement[] = [];
  async function flush() { if (pending.length) await db.batch(pending.splice(0)); }
  async function add(statement: IsolatedStatement) { pending.push(statement); if (pending.length >= 100) await flush(); }
  const operators = [owner, ...Array.from({ length: 7 }, (_, index) => ({ id: fixtureId(3, index), displayName: `Synthetic Staff ${index + 1}` }))];
  for (const operator of operators.slice(1)) {
    await add(db.prepare("INSERT INTO staff(id,center_id,email,display_name,role,active,kiosk_enabled,created_at,updated_at) VALUES(?,?,?,?,'front_desk',1,0,?,?)")
      .bind(operator.id, center, `${operator.id}@example.test`, operator.displayName, timestamp, timestamp));
  }
  for (let index = 0; index < families * 2; index++) {
    await add(db.prepare('INSERT INTO guardians(id,center_id,display_name,phone,email,created_at) VALUES(?,?,?,?,?,?)')
      .bind(fixtureId(2, index), center, `Synthetic Guardian ${index}`, `555-${String(index).padStart(4, '0')}`, `guardian${index}@example.test`, timestamp));
  }
  await flush();
  for (let index = 0; index < students; index++) {
    const studentId = fixtureId(1, index), family = Math.floor(index * families / students);
    await add(db.prepare('INSERT INTO students(id,center_id,student_code,first_name,last_name,subjects,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(studentId, center, `BENCH-${String(index).padStart(4, '0')}`, `Student${index}`, `Family${family}`, index % 2 ? '["Math"]' : '["Math","Reading"]', timestamp, timestamp));
    for (let guardian = 0; guardian < 2; guardian++) {
      const authority = guardian === 0 || index % 10 ? 'allowed' : 'unverified';
      await add(db.prepare('INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note) VALUES(?,?,?,?,?)')
        .bind(studentId, fixtureId(2, family * 2 + guardian), guardian ? 'Additional guardian' : 'Parent', authority,
          authority === 'allowed' ? 'Synthetic benchmark record. Center reviewed the signed pickup form with this guardian and recorded the effective date and named staff reviewer.' : 'Contact details supplied; pickup authority has not been verified.'));
    }
    await add(db.prepare('INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(fixtureId(4, index), center, owner.id, owner.displayName, 'student_created', 'student', studentId,
        JSON.stringify({ subjects: index % 2 ? ['Math'] : ['Math', 'Reading'], note: 'Synthetic administrative record for workload measurement. Guardian information reviewed; historical evidence remains linked when enrollment status changes.' }), timestamp));
  }
  await flush();
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1); end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end); start.setUTCFullYear(start.getUTCFullYear() - 2); start.setUTCDate(start.getUTCDate() - 7);
  const candidates: Date[] = [];
  for (let day = new Date(start); day <= end; day = new Date(day.getTime() + 86_400_000)) {
    if ([1, 2, 4, 5].includes(day.getUTCDay())) candidates.push(day);
  }
  if (operatingDays < 2 || operatingDays > candidates.length) throw new Error(`Choose 2-${candidates.length} operating days.`);
  const days = options.dayLayout === 'recent'
    ? candidates.slice(-operatingDays)
    : Array.from({ length: operatingDays }, (_, index) => candidates[Math.round(index * (candidates.length - 1) / (operatingDays - 1))]);
  const insertEvent = 'INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)';
  let visits = 0, corrections = 0;
  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    for (let slot = 0; slot < dailyVisits; slot++) {
      const index = visits++, studentIndex = index % students, studentId = fixtureId(1, studentIndex);
      const family = Math.floor(studentIndex * families / students), operator = operators[index % operators.length];
      const arrived = new Date(days[dayIndex].getTime() + (15 * 60 + slot % 20 * 15) * 60_000).toISOString();
      const departed = new Date(Date.parse(arrived) + (45 + index % 30) * 60_000).toISOString();
      const arrivalId = fixtureId(16, index), departureId = fixtureId(17, index), visitId = `visit-${arrivalId}`;
        await add(db.prepare(insertEvent).bind(arrivalId, center, studentId, visitId, 'check_in', arrived, new Date(Date.parse(arrived) + 120).toISOString(), operator.id, operator.displayName, 'admin', null, fixturePayloadHash({ studentId, action: 'check_in', observedAt: arrived, guardianId: null, reason: null }), arrivalId));
        await add(db.prepare(insertEvent).bind(departureId, center, studentId, visitId, 'check_out', departed, new Date(Date.parse(departed) + 140).toISOString(), operator.id, operator.displayName, 'admin', fixtureId(2, family * 2), fixturePayloadHash({ studentId, action: 'check_out', observedAt: departed, guardianId: fixtureId(2, family * 2), reason: null }), departureId));
      if (index % 100 === 0) {
        const correctionId = fixtureId(18, index);
        await add(db.prepare('INSERT INTO attendance_corrections(id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash) VALUES(?,?,?,2,?,?,?,?,?,?,?,?,?)')
          .bind(correctionId, center, visitId, arrived, departed, new Date(Date.parse(arrived) + 60_000).toISOString(), departed,
            'Synthetic correction based on a contemporaneous staff note. The original arrival remains available, the manager records why the observed time changed, and the report includes both versions for later review.',
            owner.id, owner.displayName, new Date(Date.parse(departed) + 60_000).toISOString(), fixturePayloadHash({ visitId, expectedVersion: 2, checkInAt: new Date(Date.parse(arrived) + 60_000).toISOString(), checkOutAt: departed, reason: 'Synthetic correction based on a contemporaneous staff note. The original arrival remains available, the manager records why the observed time changed, and the report includes both versions for later review.' })));
        corrections++;
      }
    }
    if (dayIndex % 50 === 49) { await flush(); progress(`Loaded ${visits.toLocaleString()} synthetic historical visits.`); }
  }
  await flush();
  await db.prepare('UPDATE students SET active=0 WHERE student_code>=?').bind(`BENCH-${String(activeStudents).padStart(4, '0')}`).run();
  await db.prepare('UPDATE students SET pickup_alert=? WHERE student_code IN (?,?,?)')
    .bind('Synthetic pickup restriction. Consult the manager and the current approved release instructions before authorizing departure.', 'BENCH-0021', 'BENCH-0042', 'BENCH-0063').run();
  return {
    activeStudents, inactiveStudents: students - activeStudents, students, staff: operators.length,
    guardians: families * 2, guardianRelationships: students * 2, operatingDays,
    visits, attendanceEvents: visits * 2, corrections, dailyVisits,
    from: days[0].toISOString().slice(0, 10), to: days.at(-1)!.toISOString().slice(0, 10),
    omittedProductCollections: ['schedules', 'interactions', 'inquiries', 'tasks'],
  };
}
