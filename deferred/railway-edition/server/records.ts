import { randomUUID } from 'node:crypto';
import type { Queryable, Row } from './db.js';
import type { Actor } from './auth.js';
import type { StudentInput, Student, Guardian, Inquiry, InquiryInput, Subject } from '../shared/types.js';

export const iso = (value: any): string => value instanceof Date ? value.toISOString() : String(value);
export const nullableIso = (value: any): string | null => value ? iso(value) : null;
export const camel = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value instanceof Date ? value.toISOString() : value]));
export function publicRow(row: Row): Row {
  const { centerId, actorId, requestHash, passwordHash, resultPayload, ...safe } = camel(row); return safe;
}
export async function audit(tx: Queryable, actor: Actor, action: string, entityId: string, detail = '') {
  await tx.query('INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_id,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), actor.centerId, actor.id, actor.name, action, entityId, detail]);
}
export async function studentsForCenter(tx: Queryable, centerId: string): Promise<Student[]> {
  const students = (await tx.query('SELECT * FROM students WHERE center_id=$1 ORDER BY first_name,last_name', [centerId])).rows;
  const guardians = (await tx.query(`SELECT g.id,g.name,g.email,g.phone,sg.student_id,sg.relationship,sg.can_pickup
    FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id AND sg.center_id=g.center_id WHERE g.center_id=$1`, [centerId])).rows;
  return students.map(row => ({
    id: row.id, studentNumber: row.student_number, firstName: row.first_name, lastName: row.last_name,
    grade: row.grade, subjects: row.subjects, status: row.status, pickupAlert: row.pickup_alert,
    createdAt: iso(row.created_at), guardians: guardians.filter(g => g.student_id === row.id).map(g => ({
      id: g.id, name: g.name, email: g.email, phone: g.phone, relationship: g.relationship, canPickup: g.can_pickup,
    } satisfies Guardian)),
  }));
}
export async function createStudentRecord(tx: Queryable, centerId: string, input: StudentInput): Promise<string> {
  const sequence = (await tx.query('UPDATE centers SET student_sequence=student_sequence+1 WHERE id=$1 RETURNING student_sequence', [centerId])).rows[0].student_sequence;
  const id = randomUUID(), householdId = randomUUID(), guardianId = randomUUID();
  await tx.query('INSERT INTO households(id,center_id,name) VALUES($1,$2,$3)', [householdId, centerId, `${input.lastName} family`]);
  await tx.query(`INSERT INTO students(id,center_id,household_id,student_number,first_name,last_name,grade,subjects,pickup_alert)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, centerId, householdId, `K-${String(sequence).padStart(4, '0')}`, input.firstName, input.lastName, input.grade, JSON.stringify(input.subjects), input.pickupAlert ?? '']);
  await tx.query('INSERT INTO guardians(id,center_id,household_id,name,email,phone) VALUES($1,$2,$3,$4,$5,$6)',
    [guardianId, centerId, householdId, input.guardianName, input.guardianEmail, input.guardianPhone]);
  await tx.query('INSERT INTO student_guardians(center_id,student_id,guardian_id) VALUES($1,$2,$3)', [centerId, id, guardianId]);
  await updateEnrollments(tx, centerId, id, input.subjects);
  return id;
}
export async function updateEnrollments(tx: Queryable, centerId: string, studentId: string, subjects: Subject[]) {
  const existing = (await tx.query("SELECT * FROM enrollments WHERE center_id=$1 AND student_id=$2 AND status='active'", [centerId, studentId])).rows;
  for (const enrollment of existing) {
    if (!subjects.includes(enrollment.subject)) await tx.query("UPDATE enrollments SET status='ended',end_date=CURRENT_DATE WHERE id=$1 AND center_id=$2", [enrollment.id, centerId]);
  }
  for (const subject of subjects) if (!existing.some(e => e.subject === subject)) {
    await tx.query('INSERT INTO enrollments(id,center_id,student_id,subject) VALUES($1,$2,$3,$4)', [randomUUID(), centerId, studentId, subject]);
  }
}
export async function createInquiryRecord(tx: Queryable, actor: Actor, input: InquiryInput): Promise<string> {
  const id = randomUUID();
  await tx.query(`INSERT INTO inquiries(id,center_id,contact_name,student_name,email,phone,subjects,source,owner_name,next_action,due_at,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, actor.centerId, input.contactName, input.studentName, input.email,
    input.phone, JSON.stringify(input.subjects), input.source, actor.name, input.nextAction, input.dueAt || null, input.notes ?? '']);
  await tx.query('INSERT INTO inquiry_stage_history(id,center_id,inquiry_id,to_stage,actor_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor.centerId, id, 'New', actor.id]);
  if (input.nextAction) await tx.query('INSERT INTO tasks(id,center_id,title,detail,due_at,type,inquiry_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), actor.centerId, input.nextAction, `${input.contactName} · ${input.studentName}`, input.dueAt || new Date(Date.now()+86400000).toISOString(), 'follow_up', id]);
  return id;
}
export function inquiryFromRow(row: Row): Inquiry { return publicRow(row) as Inquiry; }
