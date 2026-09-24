import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../server/db.js';
import { initializeDatabase } from '../server/seed.js';
import { resetDemoCenter } from '../server/demo-reset.js';
import { createStudentRecord } from '../server/records.js';
import { tokenHash, verifyPassword } from '../server/auth.js';

const email='reset-owner@test.invalid';
const password='Reset-test-only-credential';
const businessTables=['attendance_corrections','attendance_events','incidents','interactions','schedules','tasks','inquiry_stage_history','inquiries','visits','enrollments','student_guardians','students','guardians','households'];
let db: Database | undefined;
afterEach(async()=>{if(db)await db.close();db=undefined;vi.unstubAllEnvs();});

it('starts empty unless demo data is explicitly requested, with unset center details left blank',async()=>{
  vi.stubEnv('SEED_DEMO',undefined);
  vi.stubEnv('CENTER_LOCATION',undefined);
  vi.stubEnv('CENTER_OPERATING_HOURS',undefined);
  db=await createDatabase({url:'',dataDir:'memory://'});
  await initializeDatabase(db,{adminEmail:email,adminPassword:password});
  const center=(await db.query('SELECT * FROM centers')).rows[0];
  expect(center.demo).toBe(false);
  expect(center.location).toBe('');
  expect(center.operating_hours).toBe('');
  expect((await db.query('SELECT * FROM students')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM staff')).rows).toHaveLength(1);
  // Existing installations must also lose the old implicit demo default.
  await db.query('ALTER TABLE centers ALTER COLUMN demo SET DEFAULT TRUE');
  await initializeDatabase(db,{adminEmail:email,adminPassword:password});
  const otherId=randomUUID();
  await db.query('INSERT INTO centers(id,name,timezone) VALUES($1,$2,$3)',[otherId,'No implicit demo','UTC']);
  expect((await db.query('SELECT demo FROM centers WHERE id=$1',[otherId])).rows[0].demo).toBe(false);
});

it('clears only the chosen demo center while preserving center identity, staff, and sessions; restart stays empty',async()=>{
  vi.stubEnv('CENTER_LOCATION',undefined);
  vi.stubEnv('CENTER_OPERATING_HOURS',undefined);
  db=await createDatabase({url:'',dataDir:'memory://'});
  await initializeDatabase(db,{seed:true,adminEmail:email,adminPassword:password});
  const center=(await db.query('SELECT * FROM centers')).rows[0];
  const owner=(await db.query('SELECT * FROM staff')).rows[0];
  const sessionHash=tokenHash('reset-test-session');
  await db.query('INSERT INTO sessions(token_hash,staff_id) VALUES($1,$2)',[sessionHash,owner.id]);
  const staffBefore=(await db.query('SELECT * FROM staff ORDER BY id')).rows;
  const sessionsBefore=(await db.query('SELECT * FROM sessions ORDER BY token_hash')).rows;
  const student=(await db.query('SELECT * FROM students LIMIT 1')).rows[0];
  const event=(await db.query('SELECT * FROM attendance_events LIMIT 1')).rows[0];
  await db.query('INSERT INTO attendance_corrections(id,center_id,event_id,original_occurred_at,corrected_occurred_at,reason,actor_id,actor_name) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',[randomUUID(),center.id,event.id,event.occurred_at,'Synthetic test correction',owner.id,owner.name]);
  const otherCenter=randomUUID();
  await db.query('INSERT INTO centers(id,name,timezone,demo) VALUES($1,$2,$3,FALSE)',[otherCenter,'Other center','UTC']);
  const otherStudent=await db.transaction(tx=>createStudentRecord(tx,otherCenter,{firstName:'Preserved',lastName:'Student',grade:'3',subjects:['Math'],guardianName:'Other guardian',guardianEmail:'other@test.invalid',guardianPhone:''}));

  const result=await resetDemoCenter(db,{centerId:center.id,adminEmail:email});
  expect(result.removed.students).toBeGreaterThan(0);
  expect(result.removed.attendance_corrections).toBe(1);
  expect(result.preservedStaff).toBe(1);
  expect(result.preservedSessions).toBe(1);
  for(const table of businessTables)expect((await db.query(`SELECT * FROM ${table} WHERE center_id=$1`,[center.id])).rows,table).toHaveLength(0);
  expect((await db.query('SELECT * FROM staff ORDER BY id')).rows).toEqual(staffBefore);
  expect((await db.query('SELECT * FROM sessions ORDER BY token_hash')).rows).toEqual(sessionsBefore);
  expect(await verifyPassword(password,owner.password_hash)).toBe(true);
  const after=(await db.query('SELECT * FROM centers WHERE id=$1',[center.id])).rows[0];
  expect(after).toMatchObject({id:center.id,name:center.name,timezone:center.timezone,demo:false,student_sequence:0,location:'',operating_hours:''});
  const audit=(await db.query('SELECT * FROM audit_entries WHERE center_id=$1',[center.id])).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({action:'Demo workspace cleared',actor_id:owner.id});
  expect((await db.query('SELECT id FROM students WHERE center_id=$1',[otherCenter])).rows).toEqual([{id:otherStudent}]);
  expect((await db.query('SELECT id FROM students WHERE id=$1',[student.id])).rows).toHaveLength(0);

  vi.stubEnv('SEED_DEMO','true');
  await initializeDatabase(db,{adminEmail:email,adminPassword:password});
  expect((await db.query('SELECT * FROM students WHERE center_id=$1',[center.id])).rows).toHaveLength(0);
  expect((await db.query('SELECT demo FROM centers WHERE id=$1',[center.id])).rows[0].demo).toBe(false);
});

it('refuses to clear a non-demo center and leaves its records untouched',async()=>{
  db=await createDatabase({url:'',dataDir:'memory://'});
  await initializeDatabase(db,{seed:false,adminEmail:email,adminPassword:password});
  const center=(await db.query('SELECT * FROM centers')).rows[0];
  const studentId=await db.transaction(tx=>createStudentRecord(tx,center.id,{firstName:'Keep',lastName:'Student',grade:'3',subjects:['Math'],guardianName:'Guardian',guardianEmail:'keep@test.invalid',guardianPhone:''}));
  const auditBefore=(await db.query('SELECT * FROM audit_entries')).rows;
  await expect(resetDemoCenter(db,{centerId:center.id,adminEmail:email})).rejects.toThrow('non-demo');
  expect((await db.query('SELECT id FROM students WHERE center_id=$1',[center.id])).rows).toEqual([{id:studentId}]);
  expect((await db.query('SELECT * FROM audit_entries')).rows).toEqual(auditBefore);
});

it('refuses an owner outside the chosen center and retains custom center details on an authorized reset',async()=>{
  vi.stubEnv('CENTER_LOCATION','Custom street address');
  vi.stubEnv('CENTER_OPERATING_HOURS','Tuesday 3–6 PM');
  db=await createDatabase({url:'',dataDir:'memory://'});
  await initializeDatabase(db,{seed:true,adminEmail:email,adminPassword:password});
  const center=(await db.query('SELECT * FROM centers')).rows[0];
  const before=(await db.query('SELECT COUNT(*) AS count FROM students')).rows[0].count;
  await expect(resetDemoCenter(db,{centerId:center.id,adminEmail:'different@test.invalid'})).rejects.toThrow('active owner');
  expect((await db.query('SELECT COUNT(*) AS count FROM students')).rows[0].count).toBe(before);
  await resetDemoCenter(db,{centerId:center.id,adminEmail:email});
  expect((await db.query('SELECT location,operating_hours FROM centers WHERE id=$1',[center.id])).rows[0]).toEqual({location:'Custom street address',operating_hours:'Tuesday 3–6 PM'});
});
