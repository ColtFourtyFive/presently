import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from './db.js';
import { schemaStatements } from './schema.js';
import { hashPassword, type Actor } from './auth.js';
import { createStudentRecord, createInquiryRecord, audit } from './records.js';
import type { Subject } from '../shared/types.js';

export interface InitializeOptions { seed?: boolean; adminEmail?: string; adminPassword?: string }
export const DEMO_CENTER_LOCATION = 'Your learning center';
export const DEMO_OPERATING_HOURS = 'Monday–Thursday, 2:00–7:00 PM';
export async function initializeDatabase(db: Database, options: InitializeOptions = {}): Promise<void> {
  for (const statement of schemaStatements) await db.query(statement);
  const existing = await db.query('SELECT id FROM centers LIMIT 1');
  if (existing.rows.length) return;
  const email = (options.adminEmail ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';
  if (!email || password.length < 12) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) before the first start.');
  const passwordHash = await hashPassword(password);
  const seed = options.seed ?? process.env.SEED_DEMO === 'true';
  await db.transaction(async tx => {
    const centerId = 'main-center';
    await tx.query('INSERT INTO centers(id,name,timezone,location,operating_hours,demo) VALUES($1,$2,$3,$4,$5,$6)',
      [centerId, process.env.CENTER_NAME || 'Kumon Learning Center', process.env.CENTER_TIMEZONE || 'America/Los_Angeles',
       process.env.CENTER_LOCATION?.trim() ?? (seed ? DEMO_CENTER_LOCATION : ''),
       process.env.CENTER_OPERATING_HOURS?.trim() ?? (seed ? DEMO_OPERATING_HOURS : ''), seed]);
    const actor: Actor = { id: randomUUID(), centerId, name: process.env.ADMIN_NAME || (seed ? 'Emma Wilson' : 'Center Owner'), email, role: 'owner' };
    await tx.query('INSERT INTO staff(id,center_id,name,email,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [actor.id, centerId, actor.name, email, actor.role, passwordHash]);
    await audit(tx, actor, 'Center initialized', centerId, seed ? 'Synthetic demonstration dataset. Do not use as actual attendance.' : 'Empty center created.');
    if (seed) await seedDemo(tx, actor);
  });
}

async function seedDemo(tx: Queryable, actor: Actor) {
  const names = [
    ['Aarav','Patel','4','Priya Patel'], ['Sophie','Chen','3','Lily Chen'], ['Noah','Williams','2','Olivia Williams'],
    ['Emma','Johnson','5','Sarah Johnson'], ['Liam','Kim','1','Grace Kim'], ['Olivia','Garcia','4','Elena Garcia'],
    ['Ethan','Shah','6','Anika Shah'], ['Mia','Thompson','K','Rachel Thompson'], ['Lucas','Nguyen','3','Mai Nguyen'],
    ['Amelia','Davis','2','Jessica Davis'], ['Oliver','Wilson','5','Claire Wilson'], ['Charlotte','Lee','4','Hannah Lee'],
    ['James','Martinez','1','Isabel Martinez'], ['Isabella','Brown','3','Emily Brown'], ['Benjamin','Singh','6','Meera Singh'],
    ['Harper','Anderson','2','Nicole Anderson'], ['Elijah','Park','4','Jenny Park'], ['Evelyn','Robinson','K','Melissa Robinson'],
    ['Henry','Patel','2','Rina Patel'], ['Aria','Lewis','5','Amanda Lewis'], ['Mason','Walker','3','Laura Walker'],
    ['Ella','Clark','1','Rebecca Clark'], ['Daniel','Lopez','4','Sofia Lopez'], ['Grace','Hall','6','Andrea Hall'],
  ];
  const students: string[] = [];
  const now = Date.now();
  for (const [index, [firstName,lastName,grade,guardianName]] of names.entries()) {
    const subjects: Subject[] = index % 3 === 0 ? ['Math','Reading'] : index % 3 === 1 ? ['Reading'] : ['Math'];
    const studentId = await createStudentRecord(tx, actor.centerId, { firstName, lastName, grade, subjects, guardianName,
      guardianEmail: `${guardianName.toLowerCase().replace(/ /g,'.')}@example.com`, guardianPhone: `+1 (415) 555-${String(100+index).padStart(4,'0')}`,
      pickupAlert: index === 2 ? 'Staff review required. Confirm pickup arrangements with the manager.' : '', });
    students.push(studentId);
    await tx.query('UPDATE students SET created_at=$1 WHERE id=$2', [new Date(now-(45+index*7)*86400000).toISOString(), studentId]);
    for (const day of [1+(index%2), 3+(index%2)]) for (const [subjectIndex,subject] of subjects.entries()) {
      await tx.query('INSERT INTO schedules(id,center_id,student_id,day_of_week,start_time,duration_minutes,subject) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(),actor.centerId,studentId,day,`${14+Math.floor((index%12)/3)}:${String(((index%3)*20+subjectIndex*30)%60).padStart(2,'0')}`,30,subject]);
    }
    if (index < 14) {
      const arrival=new Date(now-(90-index*4)*60000);
      await demoVisit(tx, actor, studentId, arrival, index < 6 ? null : new Date(arrival.getTime()+30*60000));
    }
    for (let week=1; week<=3; week++) {
      const arrival = new Date(now-(week*7+index%4)*86400000-3600000);
      await demoVisit(tx, actor, studentId, arrival, new Date(arrival.getTime()+(30+index%4*10)*60000));
    }
  }
  // Sample retained records prove history can reach beyond two calendar years.
  await demoVisit(tx,actor,students[0],new Date('2024-02-29T23:00:00Z'),new Date('2024-03-01T00:00:00Z'));
  const historic = new Date(now); historic.setUTCFullYear(historic.getUTCFullYear()-2); historic.setUTCDate(historic.getUTCDate()-2);
  await demoVisit(tx,actor,students[1],historic,new Date(historic.getTime()+45*60000));
  await tx.query("INSERT INTO incidents(id,center_id,student_id,type,summary,created_at) VALUES($1,$2,$3,'pickup_review',$4,$5)",
    [randomUUID(),actor.centerId,students[2],'Sample: review the pickup plan before the next departure.',new Date(now-2*3600000).toISOString()]);
  const inquiryNames = [
    ['Michelle Rivera','Mateo Rivera','New','Website','Call Michelle about Math enrollment'],
    ['David Wang','Chloe Wang','Contacted','Referral','Confirm assessment time'],
    ['Jennifer Moore','Jack Moore','Assessment scheduled','Walk-in','Prepare reading assessment'],
    ['Aisha Ali','Zara Ali','New','Google search','Introduce the reading program'],
    ['Michael Scott','Leo Scott','Assessment completed','Referral','Discuss assessment results'],
    ['Teresa Young','Luna Young','Contacted','Website','Follow up on available days'],
    ['Andrew King','Max King','Assessment scheduled','Community event','Confirm Wednesday assessment'],
    ['Natasha Green','Ruby Green','Closed lost','Walk-in',''],
  ];
  for (const [index,[contactName,studentName,stage,source,nextAction]] of inquiryNames.entries()) {
    const id = await createInquiryRecord(tx,actor,{contactName,studentName,email:`${contactName.toLowerCase().replace(/ /g,'.')}@example.com`,phone:`+1 (415) 555-02${String(index).padStart(2,'0')}`,
      subjects:index%2?['Reading']:['Math','Reading'],source,nextAction,dueAt:new Date(now+(index-2)*3600000).toISOString(),
      notes:stage==='Closed lost'?'Synthetic example: family selected a different schedule.':'Synthetic inquiry for product demonstration.'});
    await tx.query('UPDATE inquiries SET stage=$1,created_at=$2 WHERE id=$3',[stage,new Date(now-(index+1)*86400000).toISOString(),id]);
  }
  await tx.query('INSERT INTO tasks(id,center_id,title,detail,due_at,type) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(),actor.centerId,'Review today’s pickup arrangements','Check operational alerts before students leave.',new Date(now+2*3600000).toISOString(),'operations']);
  for (const [index,channel] of ['Phone','Meeting','Email'].entries()) await tx.query('INSERT INTO interactions(id,center_id,student_id,channel,summary,actor_id,actor_name,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(),actor.centerId,students[index],channel,'Synthetic example: discussed the student’s preferred attendance days.',actor.id,actor.name,new Date(now-(index+2)*86400000).toISOString()]);
}

async function demoVisit(tx: Queryable, actor: Actor, studentId: string, arrival: Date, departure: Date | null) {
  const visitId=randomUUID();
  await tx.query('INSERT INTO visits(id,center_id,student_id,checked_in_at,checked_out_at,status,release_basis) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [visitId,actor.centerId,studentId,arrival.toISOString(),departure?.toISOString()??null,departure?'closed':'open',departure?'Synthetic authorized pickup':null]);
  for (const [action,time] of [['check_in',arrival],...(departure?[['check_out',departure]]:[])] as [string,Date][]) {
    const id=randomUUID();
    await tx.query(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,occurred_at,received_at,actor_id,actor_name,capture_mode,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,'demo_seed',$9)`,[id,actor.centerId,studentId,visitId,action,time.toISOString(),actor.id,'Demo seed',`seed:${id}`]);
  }
}
