import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { createDatabase, type Database } from '../server/db.js';
import { initializeDatabase } from '../server/seed.js';
import { tokenHash } from '../server/auth.js';
import { createStudentRecord } from '../server/records.js';
import type { ImportPreview, ImportReceipt } from '../shared/import-types.js';

describe('Main control center roster import over HTTP and PostgreSQL-compatible storage',()=> {
  let db: Database, server: Server, base: string, cookie: string, ownerId: string;
  const center='main-center', basic={studentNumber:'Reference',firstName:'First',lastName:'Last'};
  const source=(rows: string[][],headers=['Reference','First','Last'])=>[headers,...rows].map(row=>row.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(',')).join('\r\n');
  const options={seed:false,adminEmail:'import-owner@example.invalid',adminPassword:`Ephemeral-${randomUUID()}`};
  async function request(path: string,body?: unknown,session=cookie,method=body===undefined?'GET':'POST') {
    const response=await fetch(base+path,{method,headers:{cookie:session,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as any};
  }
  async function preview(csv: string,extra: Record<string,unknown>={}) {
    const result=await request('/imports/preview',{csv,mapping:basic,...extra}); expect(result.status,JSON.stringify(result.body)).toBe(200); return result.body as ImportPreview;
  }
  const commit=(p: Pick<ImportPreview,'importId'|'previewToken'>,session=cookie)=>request(`/imports/${p.importId}/commit`,{previewToken:p.previewToken},session);
  async function existing(overrides: {pickupAlert?: string}={}) {
    const id=await db.transaction(tx=>createStudentRecord(tx,center,{firstName:'Existing',lastName:randomUUID(),grade:'3',subjects:['Math','Reading'],guardianName:'Original Guardian',guardianEmail:'guardian@example.invalid',guardianPhone:'555-0101',pickupAlert:overrides.pickupAlert??'Pickup requires manager approval.'}));
    return (await db.query('SELECT * FROM students WHERE id=$1',[id])).rows[0];
  }
  async function session(role: string,target=center) {
    const id=randomUUID(),token=randomUUID();
    await db.query('INSERT INTO staff(id,center_id,name,email,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,target,'Import role test',`${id}@example.invalid`,role,'unusable-test-password-hash']);
    await db.query('INSERT INTO sessions(token_hash,staff_id) VALUES($1,$2)',[tokenHash(token),id]);
    return {id,cookie:`kumon_session=${token}`};
  }
  beforeAll(async()=> {
    db=await createDatabase({dataDir:'memory://'}); await initializeDatabase(db,options);
    ownerId=(await db.query('SELECT id FROM staff WHERE email=$1',[options.adminEmail])).rows[0].id;
    const token=randomUUID(); cookie=`kumon_session=${token}`;
    await db.query('INSERT INTO sessions(token_hash,staff_id) VALUES($1,$2)',[tokenHash(token),ownerId]);
    server=createServer(createApp({db,secureCookies:false})); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(async()=> { if(server) await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); await db?.close(); });

  it('starts empty and applies its additive schema repeatedly without changing existing records',async()=> {
    expect((await db.query('SELECT id FROM students')).rows).toHaveLength(0);
    const p=await preview(source([['INIT-1','Initial','Roster']]));
    await initializeDatabase(db,options);
    expect((await request(`/imports/${p.importId}`)).status).toBe(200);
    expect((await db.query('SELECT id FROM students')).rows).toHaveLength(0);
  });

  it('creates UTF-8 student records without authorizing imported contacts and handles simultaneous commit retries once',async()=> {
    const p=await preview(source([['CREATE-1','Zoë, "Z"','王','Math|Reading','Contact Name','contact@example.invalid','555-0100','Parent','Call manager\nfor pickup.']],['Reference','First','Last','Subjects','Guardian','Email','Phone','Relation','Alert']),{mapping:{...basic,subjects:'Subjects',guardianName:'Guardian',guardianEmail:'Email',guardianPhone:'Phone',guardianRelationship:'Relation',pickupAlert:'Alert'}});
    expect(p.rows[0].action).toBe('create');
    const results=await Promise.all([commit(p),commit(p)]); expect(results.map(result=>result.status)).toEqual([200,200]);
    const student=(await db.query('SELECT * FROM students WHERE student_number=$1',['CREATE-1'])).rows[0];
    expect(student).toMatchObject({first_name:'Zoë, "Z"',last_name:'王',subjects:['Math','Reading'],pickup_alert:'Call manager\nfor pickup.'});
    expect((await db.query('SELECT can_pickup FROM student_guardians WHERE student_id=$1',[student.id])).rows[0].can_pickup).toBe(false);
    expect((await db.query("SELECT id FROM audit_entries WHERE entity_id=$1 AND action='Roster imported'",[student.id])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM attendance_events')).rows).toHaveLength(0);
    expect((await db.query('SELECT payload_json FROM roster_import_rows WHERE import_id=$1',[p.importId])).rows[0].payload_json).toBeNull();
    expect((await request('/imports')).body.imports.some((job:any)=>job.importId===p.importId&&job.status==='completed')).toBe(true);
  });

  it('preserves omitted restrictions, subjects, grade, and all existing guardians on identity-only updates',async()=> {
    const student=await existing(); const before=(await db.query('SELECT * FROM student_guardians WHERE student_id=$1',[student.id])).rows;
    const p=await preview(source([[student.student_number,'Revised',student.last_name]]),{decisions:{[student.student_number]:'update'}});
    expect((await commit(p)).status).toBe(200);
    expect((await db.query('SELECT first_name,grade,subjects,pickup_alert FROM students WHERE id=$1',[student.id])).rows[0]).toEqual({first_name:'Revised',grade:student.grade,subjects:student.subjects,pickup_alert:student.pickup_alert});
    expect((await db.query('SELECT * FROM student_guardians WHERE student_id=$1',[student.id])).rows).toEqual(before);
  });

  it('clears explicitly mapped student fields and synchronizes enrollment records',async()=> {
    const student=await existing();
    const p=await preview(source([[student.student_number,'Revised',student.last_name,'','','']],['Reference','First','Last','Grade','Subjects','Alert']),{mapping:{...basic,grade:'Grade',subjects:'Subjects',pickupAlert:'Alert'},decisions:{[student.student_number]:'update'}});
    expect((await commit(p)).status).toBe(200);
    expect((await db.query('SELECT grade,subjects,pickup_alert FROM students WHERE id=$1',[student.id])).rows[0]).toEqual({grade:'',subjects:[],pickup_alert:''});
    expect((await db.query("SELECT id FROM enrollments WHERE student_id=$1 AND status='active'",[student.id])).rows).toHaveLength(0);
  });

  it('requires duplicate decisions and rejects all conflicting copies of a student reference',async()=> {
    const student=await existing();
    const csv=source([[student.student_number,'Changed',student.last_name],['SAME-NAME',student.first_name,student.last_name],['CONFLICT','A','Student'],['CONFLICT','B','Student']]);
    const initial=await preview(csv); expect(initial.rows.map(row=>row.action)).toEqual(['review','review','reject','reject']);
    expect((await commit(initial)).status).toBe(409);
    const reviewed=await preview(csv,{decisions:{[student.student_number]:'update','SAME-NAME':'create'}});
    expect((await commit(initial)).status).toBe(409);
    const done=await commit(reviewed); expect(done.status).toBe(200); expect(done.body.rows.map((row:any)=>row.status)).toEqual(['applied','applied','rejected','rejected']);
    expect((await db.query('SELECT id FROM students WHERE student_number=$1',['CONFLICT'])).rows).toHaveLength(0);
  });

  it('retains confirmed batches, rejects stale remaining rows, and resumes without duplicate application',async()=> {
    const student=await existing();
    const csv=source([...Array.from({length:11},(_,index)=>[`BATCH-${index}`,`Batch${index}`,'Imported']),[student.student_number,'Updated',student.last_name]]);
    const p=await preview(csv,{decisions:{[student.student_number]:'update'}});
    const first=await commit(p); expect(first.body.remaining).toBe(2); expect(first.body.status).toBe('committing');
    await db.query('UPDATE students SET pickup_alert=$1 WHERE id=$2',['New restriction after preview',student.id]);
    expect((await commit(p)).status).toBe(409);
    expect((await db.query('SELECT id FROM students WHERE student_number=$1',['BATCH-10'])).rows).toHaveLength(0);
    const resumed=await preview(csv,{decisions:{[student.student_number]:'update'},revalidate:true});
    expect(resumed.alreadyAppliedRows).toHaveLength(10); expect(resumed.importId).toBe(p.importId);
    const final=await commit(resumed); expect(final.status).toBe(200); expect(final.body.rows.filter((row:any)=>row.status==='applied')).toHaveLength(12);
    expect((await db.query('SELECT pickup_alert FROM students WHERE id=$1',[student.id])).rows[0].pickup_alert).toBe('New restriction after preview');
    const repeated=await request('/imports/preview',{csv,mapping:basic}); expect(repeated.body.status).toBe('completed');
  });

  it('requires a new review when concurrent previews introduce a same-name collision',async()=> {
    const name=`Concurrent-${randomUUID()}`;
    const a=await preview(source([['RACE-NAME-A',name,'Student']]));
    const csv=source([['RACE-NAME-B',name,'Student']]);
    const b=await preview(csv);
    expect((await commit(a)).status).toBe(200);
    const stale=await commit(b); expect(stale.status).toBe(409); expect(stale.body.code).toBe('PREVIEW_STALE');
    const reviewed=await preview(csv,{revalidate:true,decisions:{'RACE-NAME-B':'create'}});
    expect((await commit(reviewed)).status).toBe(200);
    expect((await db.query("SELECT id FROM students WHERE student_number IN ('RACE-NAME-A','RACE-NAME-B')")).rows).toHaveLength(2);
  });

  it('requires and honors separate-student decisions for duplicate names within one file',async()=> {
    const csv=source([['FILE-NAME-A','Distinct identity','Shared name'],['FILE-NAME-B','Distinct identity','Shared name']]);
    const p=await preview(csv); expect(p.rows.map(row=>row.action)).toEqual(['review','review']);
    expect((await commit(p)).status).toBe(409);
    const accepted=await preview(csv,{decisions:{'FILE-NAME-A':'create','FILE-NAME-B':'create'}});
    const done=await commit(accepted); expect(done.status).toBe(200); expect(done.body.rows.map((row:any)=>row.status)).toEqual(['applied','applied']);
  });

  it('rejects changes to existing guardian contacts instead of overwriting or duplicating them',async()=> {
    const student=await existing();
    const p=await preview(source([[student.student_number,'Updated',student.last_name,'Unexpected Contact']],['Reference','First','Last','Guardian']),{mapping:{...basic,guardianName:'Guardian'},decisions:{[student.student_number]:'update'}});
    expect(p.rows[0].action).toBe('reject'); expect(p.rows[0].problem).toContain('Guardian details differ');
    await commit(p);
    expect((await db.query('SELECT g.name FROM guardians g JOIN student_guardians l ON l.guardian_id=g.id WHERE l.student_id=$1',[student.id])).rows).toEqual([{name:'Original Guardian'}]);
  });

  it('denies other centers, front-desk/instructor roles, and deactivated managers',async()=> {
    const p=await preview(source([['AUTH-1','Authorized','Student']]));
    for(const role of ['front_desk','instructor']) {
      const operator=await session(role);
      expect((await request('/imports/preview',{csv:source([['NOPE','No','Role']]),mapping:basic},operator.cookie)).status).toBe(403);
      expect((await request(`/imports/${p.importId}`,undefined,operator.cookie)).status).toBe(403);
    }
    await db.query('INSERT INTO centers(id,name,timezone) VALUES($1,$2,$3)',['other-center','Other','UTC']);
    const other=await session('owner','other-center');
    expect((await request(`/imports/${p.importId}`,undefined,other.cookie)).status).toBe(404);
    expect((await commit(p,other.cookie)).status).toBe(404);
    const manager=await session('manager');
    expect((await request(`/imports/${p.importId}`,undefined,manager.cookie)).status).toBe(200);
    await db.query('UPDATE staff SET active=FALSE WHERE id=$1',[manager.id]);
    expect((await commit(p,manager.cookie)).status).toBe(401);
  });

  it('accepts bounded files above normal request size and rejects malformed, oversized, and invalid UTF-8 input',async()=> {
    const csv=source(Array.from({length:200},(_,index)=>[`LARGE-${index}`,`Large${index}`,'Roster','x'.repeat(450)]),['Reference','First','Last','Alert']);
    expect(Buffer.byteLength(csv)).toBeGreaterThan(64*1024);
    const p=await preview(csv,{mapping:{...basic,pickupAlert:'Alert'}}); expect(p.totalRows).toBe(200);
    const maximum=await preview(source(Array.from({length:500},(_,index)=>[`LIMIT-${index}`,'Bounded',String(index)]))); expect(maximum.totalRows).toBe(500);
    for(const invalid of ['Reference,First,Last\nA,B', 'Reference,First,Last\nA,"Unclosed,Name',source(Array.from({length:501},(_,index)=>[`OVER-${index}`,'Too','Many'])), 'x'.repeat(512*1024+1)]) expect((await request('/imports/preview',{csv:invalid,mapping:basic})).status).toBe(400);
    const invalidBytes=Buffer.concat([Buffer.from('{"csv":"'),Buffer.from([0xff]),Buffer.from('","mapping":{}}')]);
    const response=await fetch(base+'/imports/preview',{method:'POST',headers:{cookie,'content-type':'application/json'},body:invalidBytes}); expect(response.status).toBe(400);
    expect((await request('/students',{irrelevant:'x'.repeat(70*1024)})).status).toBe(413);
  });

  it('expires pending source payloads without removing receipts',async()=> {
    const p=await preview(source([['EXPIRED','Expired','Roster']]));
    await db.query("UPDATE roster_imports SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[p.importId]);
    expect((await commit(p)).status).toBe(409);
    const result=await request(`/imports/${p.importId}`); expect(result.body.status).toBe('expired');
    expect((await db.query('SELECT payload_json FROM roster_import_rows WHERE import_id=$1',[p.importId])).rows[0].payload_json).toBeNull();
  });
});
