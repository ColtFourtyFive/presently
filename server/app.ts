import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Queryable, Row } from './db.js';
import { type Actor, type AuthenticatedRequest, newSession, SESSION_COOKIE, SESSION_IDLE_MS, tokenHash, verifyPassword, hashPassword } from './auth.js';
import { audit, camel, createInquiryRecord, createStudentRecord, inquiryFromRow, iso, publicRow, studentsForCenter, updateEnrollments } from './records.js';
import type { InquiryInput, Role, StudentInput, Subject } from '../shared/types.js';

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new ApiError(status,message); };
const actorOf = (req: Request) => (req as AuthenticatedRequest).actor;
const textField = (value: unknown, name: string, required = true, max = 200): string => {
  if (typeof value !== 'string') { if (!required && value == null) return ''; fail(422,`${name} must be text.`); }
  const text = (value as string).trim();
  if (required && !text) fail(422,`${name} is required.`);
  if (text.length > max) fail(422,`${name} must be ${max} characters or fewer.`);
  return text;
};
const emailField = (value: unknown, required = false) => {
  const email = textField(value,'Email',required,254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(422,'Enter a valid email address.');
  return email;
};
const subjectsField = (value: unknown, required = true): Subject[] => {
  if (!Array.isArray(value) || value.some(s => s !== 'Math' && s !== 'Reading')) fail(422,'Choose Math or Reading.');
  const subjects = [...new Set(value as Subject[])];
  if (required && !subjects.length) fail(422,'Choose at least one subject.');
  return subjects;
};
const dateField = (value: unknown, name: string, optional = false): string | null => {
  if (optional && (value == null || value === '')) return null;
  // Require an explicit offset so the server host's timezone never determines
  // a factual attendance instant. Reject dates JS would silently normalize.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(422,`${name} must be a valid date and time with a time zone.`);
  const day=(value as string).slice(0,10);
  const calendarDate=new Date(`${day}T00:00:00.000Z`);
  if(!Number.isFinite(calendarDate.getTime())||calendarDate.toISOString().slice(0,10)!==day)fail(422,`${name} must use a valid calendar date.`);
  return new Date(value as string).toISOString();
};
function studentInput(body: any): StudentInput {
  const input = { firstName:textField(body.firstName,'First name'), lastName:textField(body.lastName,'Last name'),
    grade:textField(body.grade,'Grade',false,30), subjects:subjectsField(body.subjects), guardianName:textField(body.guardianName,'Guardian name'),
    guardianEmail:emailField(body.guardianEmail), guardianPhone:textField(body.guardianPhone,'Guardian phone',false,40), pickupAlert:textField(body.pickupAlert,'Pickup alert',false,500) };
  if (!input.guardianEmail && !input.guardianPhone) fail(422,'Provide an email address or phone number for the guardian.');
  return input;
}
function inquiryInput(body: any): InquiryInput {
  const input = { contactName:textField(body.contactName,'Contact name'),studentName:textField(body.studentName,'Student name'),
    email:emailField(body.email),phone:textField(body.phone,'Phone',false,40),subjects:subjectsField(body.subjects,false),
    source:textField(body.source,'Source'),nextAction:textField(body.nextAction,'Next action',false,300),
    dueAt:dateField(body.dueAt,'Due date',true)??undefined,notes:textField(body.notes,'Notes',false,2000) };
  if (!input.email && !input.phone) fail(422,'Provide an email address or phone number.');
  return input;
}
const allow = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!roles.includes(actorOf(req).role)) return next(new ApiError(403,'Your role does not allow this action.'));
  next();
};
const managers: Role[] = ['owner','manager'];
const operators: Role[] = ['owner','manager','front_desk'];
async function scoped(tx: Queryable, table: string, id: string, centerId: string, lock = false): Promise<Row> {
  // Table names are constants supplied by the service, never client input.
  const row=(await tx.query(`SELECT * FROM ${table} WHERE id=$1 AND center_id=$2${lock?' FOR UPDATE':''}`,[id,centerId])).rows[0];
  if (!row) fail(404,'Record not found.'); return row;
}

export function createApp(options: { db: Database; secureCookies?: boolean }) {
  const {db} = options;
  const app=express();
  const secureCookies=options.secureCookies ?? process.env.NODE_ENV==='production';
  if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.TRUST_PROXY === '1') app.set('trust proxy',1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: process.env.NODE_ENV==='production' ? {
    directives: { defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"] },
  } : false, crossOriginEmbedderPolicy:false }));
  app.use(express.json({limit:'64kb'}));
  app.use(cookieParser());
  app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.use('/api',(req,_res,next)=>{
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin=req.get('origin');
      const expected=process.env.APP_URL?.replace(/\/$/,'') || `${req.protocol}://${req.get('host')}`;
      if ((origin && origin!==expected) || req.get('sec-fetch-site')==='cross-site') return next(new ApiError(403,'This request must come from the CRM application.'));
    }
    next();
  });
  app.get(['/health','/api/health'],async(_req,res)=>{await db.query('SELECT 1');res.json({status:'ok',database:db.kind});});
  const loginLimiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,skipSuccessfulRequests:true,message:{error:'Too many sign-in attempts. Try again in 15 minutes.'}});
  const dummyHash=hashPassword('non-authenticating-timing-placeholder');
  app.post('/api/auth/login',loginLimiter,async(req,res)=>{
    const email=textField(req.body?.email,'Email',true,254).toLowerCase();
    const password=req.body?.password;
    if(typeof password!=='string'||!password.length||password.length>1024)fail(422,'Enter your password.');
    const staff=(await db.query('SELECT * FROM staff WHERE email=$1',[email])).rows[0];
    const valid=await verifyPassword(password,staff?.password_hash??await dummyHash);
    if (!staff || !staff.active || !valid) fail(401,'Email or password is incorrect.');
    const session=newSession();
    await db.transaction(async tx=>{
      // Replace an existing browser session and clear expired rows on successful sign in.
      const previous=req.cookies[SESSION_COOKIE];
      if (typeof previous==='string') await tx.query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(previous)]);
      await tx.query("DELETE FROM sessions WHERE last_seen_at < NOW() - INTERVAL '15 minutes'");
      await tx.query('INSERT INTO sessions(token_hash,staff_id) VALUES($1,$2)',[session.hash,staff.id]);
      await audit(tx,{id:staff.id,centerId:staff.center_id,name:staff.name,email:staff.email,role:staff.role},'Signed in',staff.id);
    });
    res.cookie(SESSION_COOKIE,session.token,{httpOnly:true,secure:secureCookies,sameSite:'strict',path:'/',maxAge:SESSION_IDLE_MS});
    res.json({user:{id:staff.id,name:staff.name,email:staff.email,role:staff.role}});
  });
  app.use('/api',async(req,res,next)=>{
    const token=req.cookies[SESSION_COOKIE];
    if (typeof token!=='string' || token.length>100) return next(new ApiError(401,'Please sign in to continue.'));
    const session=(await db.query(`SELECT s.*,u.id AS user_id,u.center_id,u.name,u.email,u.role,u.active FROM sessions s
      JOIN staff u ON u.id=s.staff_id WHERE s.token_hash=$1`,[tokenHash(token)])).rows[0];
    if (!session || !session.active || Date.now()-new Date(session.last_seen_at).getTime()>SESSION_IDLE_MS) {
      if (session) await db.query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(token)]);
      res.clearCookie(SESSION_COOKIE,{path:'/',secure:secureCookies,httpOnly:true,sameSite:'strict'});
      return next(new ApiError(401,'Your session has expired. Please sign in again.'));
    }
    (req as AuthenticatedRequest).actor={id:session.user_id,centerId:session.center_id,name:session.name,email:session.email,role:session.role};
    // Background roster polling must not keep an unattended staff session alive.
    if(req.get('x-background-request')!=='1') {
      await db.query('UPDATE sessions SET last_seen_at=NOW() WHERE token_hash=$1',[tokenHash(token)]);
      res.cookie(SESSION_COOKIE,token,{httpOnly:true,secure:secureCookies,sameSite:'strict',path:'/',maxAge:SESSION_IDLE_MS});
    }
    next();
  });
  app.get('/api/auth/session',(req,res)=>{const {centerId,...user}=actorOf(req);res.json({user});});
  app.post('/api/auth/logout',async(req,res)=>{await db.query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(req.cookies[SESSION_COOKIE])]);res.clearCookie(SESSION_COOKIE,{path:'/',secure:secureCookies,httpOnly:true,sameSite:'strict'});res.json({ok:true});});
  app.get('/api/bootstrap',async(req,res)=>{
    const actor=actorOf(req), instructor=actor.role==='instructor';
    const result=await db.transaction(async tx=>{
      // One consistent snapshot prevents a concurrent attendance commit from
      // appearing in events while its visit is absent from the same response.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const centerRow=(await tx.query('SELECT * FROM centers WHERE id=$1',[actor.centerId])).rows[0];
      if(!centerRow)fail(404,'Center not found.');
      const center=camel(centerRow);
      const rows=async(table:string,order:string)=> (await tx.query(`SELECT * FROM ${table} WHERE center_id=$1 ORDER BY ${order}`,[actor.centerId])).rows.map(publicRow);
      const students=await studentsForCenter(tx,actor.centerId);
      if(instructor) for(const student of students) student.guardians=[];
      return {center:{id:center.id,name:center.name,timezone:center.timezone,location:center.location,operatingHours:center.operatingHours},
        user:{id:actor.id,name:actor.name,email:actor.email,role:actor.role},students,schedules:await rows('schedules','day_of_week,start_time'),
        visits:await rows('visits','checked_in_at DESC'),events:await rows('attendance_events','occurred_at DESC'),
        inquiries:instructor?[]:await rows('inquiries','created_at DESC'),tasks:instructor?[]:await rows('tasks','due_at'),
        incidents:await rows('incidents','created_at DESC'),audit:managers.includes(actor.role)?await rows('audit_entries','created_at DESC'):[],
        interactions:instructor?[]:await rows('interactions','occurred_at DESC'),
        corrections:managers.includes(actor.role)?await rows('attendance_corrections','created_at DESC'):[],
        serverTime:new Date().toISOString(),demo:center.demo};
    });
    res.json(result);
  });
  app.post('/api/students',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),input=studentInput(req.body??{});
    const student=await db.transaction(async tx=>{
      const id=await createStudentRecord(tx,actor.centerId,input);await audit(tx,actor,'Student created',id,'Student and guardian relationship added.');
      return (await studentsForCenter(tx,actor.centerId)).find(s=>s.id===id);
    });res.status(201).json(student);
  });
  app.patch('/api/students/:id',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),id=String(req.params.id),body=req.body??{};
    const student=await db.transaction(async tx=>{
      const current=await scoped(tx,'students',id,actor.centerId,true);
      const updates:Record<string,unknown>={};
      for(const [field,column] of [['firstName','first_name'],['lastName','last_name'],['grade','grade']] as const) if(field in body) updates[column]=textField(body[field],field,field!=='grade',field==='grade'?30:200);
      if('pickupAlert' in body){if(!managers.includes(actor.role))fail(403,'A manager must update pickup restrictions.');updates.pickup_alert=textField(body.pickupAlert,'Pickup alert',false,500);}
      if('status' in body){if(!['active','inactive'].includes(body.status))fail(422,'Choose active or inactive.');updates.status=body.status;}
      if('subjects' in body){const subjects=subjectsField(body.subjects);updates.subjects=JSON.stringify(subjects);await updateEnrollments(tx,actor.centerId,id,subjects);}
      if(Object.keys(updates).length) await tx.query(`UPDATE students SET ${Object.keys(updates).map((key,i)=>`${key}=$${i+1}`).join(',')} WHERE id=$${Object.keys(updates).length+1} AND center_id=$${Object.keys(updates).length+2}`,[...Object.values(updates),id,actor.centerId]);
      if(Array.isArray(body.guardians)) {
        if(!managers.includes(actor.role))fail(403,'A manager must update guardian authorization.');
        for(const guardian of body.guardians) {
          const relationship=(await tx.query('SELECT * FROM student_guardians WHERE center_id=$1 AND student_id=$2 AND guardian_id=$3',[actor.centerId,id,guardian.id])).rows[0];
          if(!relationship)fail(404,'Guardian relationship not found.');
          if(typeof guardian.canPickup!=='boolean')fail(422,'Pickup authorization must be true or false.');
          await tx.query('UPDATE student_guardians SET can_pickup=$1 WHERE center_id=$2 AND student_id=$3 AND guardian_id=$4',[guardian.canPickup,actor.centerId,id,guardian.id]);
        }
      }
      if('guardianName' in body || 'guardianEmail' in body || 'guardianPhone' in body) {
        const guardian=(await tx.query('SELECT guardian_id FROM student_guardians WHERE center_id=$1 AND student_id=$2 ORDER BY guardian_id LIMIT 1',[actor.centerId,id])).rows[0];
        if(guardian){const g=await scoped(tx,'guardians',guardian.guardian_id,actor.centerId);await tx.query('UPDATE guardians SET name=$1,email=$2,phone=$3 WHERE id=$4 AND center_id=$5',[
          'guardianName' in body?textField(body.guardianName,'Guardian name'):g.name,'guardianEmail' in body?emailField(body.guardianEmail):g.email,'guardianPhone' in body?textField(body.guardianPhone,'Phone',false,40):g.phone,g.id,actor.centerId]);}
      }
      await audit(tx,actor,'Student updated',id,`Updated fields: ${Object.keys(body).filter(k=>['firstName','lastName','grade','subjects','status','pickupAlert','guardians','guardianName','guardianEmail','guardianPhone'].includes(k)).join(', ')}.`);
      return (await studentsForCenter(tx,actor.centerId)).find(s=>s.id===current.id);
    });res.json(student);
  });
  app.post('/api/inquiries',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),input=inquiryInput(req.body??{});
    const result=await db.transaction(async tx=>{const id=await createInquiryRecord(tx,actor,input);await audit(tx,actor,'Inquiry created',id);return inquiryFromRow(await scoped(tx,'inquiries',id,actor.centerId));});res.status(201).json(result);
  });
  app.patch('/api/inquiries/:id',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),id=String(req.params.id),body=req.body??{};
    const result=await db.transaction(async tx=>{
      const current=await scoped(tx,'inquiries',id,actor.centerId,true),updates:Record<string,unknown>={};
      if('stage' in body) {
        if(!['New','Contacted','Assessment scheduled','Assessment completed','Enrolled','Closed lost','Do not contact'].includes(body.stage))fail(422,'Choose a valid inquiry stage.');
        if(body.stage==='Enrolled'&&!current.converted_student_id)fail(422,'Use Enroll student to create a linked enrollment.');
        if(current.converted_student_id&&body.stage!=='Enrolled')fail(409,'This inquiry is linked to an enrolled student. Manage the student record instead.');
        if(body.stage==='Closed lost'&&!String(body.notes??current.notes).trim())fail(422,'Add a reason in notes before closing this inquiry.');
        updates.stage=body.stage;
        if(body.stage!==current.stage)await tx.query('INSERT INTO inquiry_stage_history(id,center_id,inquiry_id,from_stage,to_stage,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.centerId,id,current.stage,body.stage,actor.id]);
        if(['Closed lost','Do not contact'].includes(body.stage))await tx.query('UPDATE tasks SET completed_at=NOW() WHERE center_id=$1 AND inquiry_id=$2 AND completed_at IS NULL',[actor.centerId,id]);
      }
      for(const [field,column,max] of [['nextAction','next_action',300],['notes','notes',2000],['ownerName','owner_name',200]] as const)if(field in body)updates[column]=textField(body[field],field,false,max);
      if('dueAt' in body)updates.due_at=dateField(body.dueAt,'Due date',true);
      if(Object.keys(updates).length)await tx.query(`UPDATE inquiries SET ${Object.keys(updates).map((key,i)=>`${key}=$${i+1}`).join(',')} WHERE id=$${Object.keys(updates).length+1} AND center_id=$${Object.keys(updates).length+2}`,[...Object.values(updates),id,actor.centerId]);
      if('nextAction' in body||'dueAt' in body)await tx.query('UPDATE tasks SET title=$1,due_at=COALESCE($2,due_at) WHERE center_id=$3 AND inquiry_id=$4 AND completed_at IS NULL',[updates.next_action??current.next_action,updates.due_at??current.due_at,actor.centerId,id]);
      await audit(tx,actor,'Inquiry updated',id,'Pipeline and follow-up details updated.');return inquiryFromRow(await scoped(tx,'inquiries',id,actor.centerId));
    });res.json(result);
  });
  app.post('/api/inquiries/:id/convert',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),id=String(req.params.id);
    const result=await db.transaction(async tx=>{
      const inquiry=await scoped(tx,'inquiries',id,actor.centerId,true);
      if(inquiry.stage==='Do not contact'||inquiry.stage==='Closed lost')fail(409,'Reopen the inquiry before enrollment.');
      if(inquiry.converted_student_id)return {studentId:inquiry.converted_student_id,student:(await studentsForCenter(tx,actor.centerId)).find(s=>s.id===inquiry.converted_student_id),inquiry:inquiryFromRow(inquiry)};
      const parts=inquiry.student_name.trim().split(/\s+/),lastName=parts.length>1?parts.slice(1).join(' '):'';
      const studentId=await createStudentRecord(tx,actor.centerId,{firstName:parts[0],lastName,grade:textField(req.body?.grade,'Grade',false,30),subjects:inquiry.subjects.length?inquiry.subjects:['Math'],guardianName:inquiry.contact_name,guardianEmail:inquiry.email,guardianPhone:inquiry.phone});
      await tx.query("UPDATE inquiries SET stage='Enrolled',converted_student_id=$1,next_action='',due_at=NULL WHERE id=$2 AND center_id=$3",[studentId,id,actor.centerId]);
      await tx.query('INSERT INTO inquiry_stage_history(id,center_id,inquiry_id,from_stage,to_stage,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.centerId,id,inquiry.stage,'Enrolled',actor.id]);
      await tx.query('UPDATE tasks SET completed_at=NOW() WHERE center_id=$1 AND inquiry_id=$2 AND completed_at IS NULL',[actor.centerId,id]);
      await audit(tx,actor,'Inquiry enrolled',id,`Linked student ${studentId}.`);
      return {studentId,student:(await studentsForCenter(tx,actor.centerId)).find(s=>s.id===studentId),inquiry:inquiryFromRow(await scoped(tx,'inquiries',id,actor.centerId))};
    });res.json(result);
  });
  app.post('/api/tasks/:id/complete',allow(...operators),async(req,res)=>{const actor=actorOf(req);const result=await db.transaction(async tx=>{await scoped(tx,'tasks',String(req.params.id),actor.centerId);const row=(await tx.query('UPDATE tasks SET completed_at=COALESCE(completed_at,NOW()) WHERE id=$1 AND center_id=$2 RETURNING *',[String(req.params.id),actor.centerId])).rows[0];await audit(tx,actor,'Task completed',row.id);return publicRow(row);});res.json(result);});
  app.post('/api/schedules',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),body=req.body??{},studentId=textField(body.studentId,'Student');
    if(!Number.isInteger(body.dayOfWeek)||body.dayOfWeek<0||body.dayOfWeek>6)fail(422,'Choose a valid day.');
    if(typeof body.startTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime))fail(422,'Use a valid start time.');
    if(!Number.isInteger(body.durationMinutes)||body.durationMinutes<15||body.durationMinutes>180)fail(422,'Duration must be 15–180 minutes.');
    if(!['Math','Reading'].includes(body.subject))fail(422,'Choose Math or Reading.');
    const result=await db.transaction(async tx=>{
      const student=await scoped(tx,'students',studentId,actor.centerId,true);if(student.status!=='active')fail(409,'Reactivate the student before scheduling.');
      if(!student.subjects.includes(body.subject))fail(422,'The student must be enrolled in this subject.');
      const start=Number(body.startTime.slice(0,2))*60+Number(body.startTime.slice(3));
      if(start+body.durationMinutes>1440)fail(422,'A visit slot cannot extend past midnight.');
      const existing=(await tx.query('SELECT * FROM schedules WHERE center_id=$1 AND student_id=$2 AND day_of_week=$3 AND active=TRUE',[actor.centerId,studentId,body.dayOfWeek])).rows;
      if(existing.some(s=>{const minute=Number(s.start_time.slice(0,2))*60+Number(s.start_time.slice(3));return start<minute+s.duration_minutes&&start+body.durationMinutes>minute;}))fail(409,'This student already has an overlapping visit slot.');
      const row=(await tx.query('INSERT INTO schedules(id,center_id,student_id,day_of_week,start_time,duration_minutes,subject) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),actor.centerId,studentId,body.dayOfWeek,body.startTime,body.durationMinutes,body.subject])).rows[0];await audit(tx,actor,'Schedule created',row.id);return publicRow(row);
    });res.status(201).json(result);
  });
  app.patch('/api/schedules/:id',allow(...operators),async(req,res)=>{
    if(typeof req.body?.active!=='boolean')fail(422,'Active must be true or false.');const actor=actorOf(req);
    const result=await db.transaction(async tx=>{
      const schedule=await scoped(tx,'schedules',String(req.params.id),actor.centerId);
      const student=await scoped(tx,'students',schedule.student_id,actor.centerId,true);
      if(req.body.active&&!schedule.active) {
        if(student.status!=='active'||!student.subjects.includes(schedule.subject))fail(409,'The student needs an active enrollment in this subject before restoring the slot.');
        const minute=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3));
        const start=minute(schedule.start_time);
        const others=(await tx.query('SELECT * FROM schedules WHERE center_id=$1 AND student_id=$2 AND day_of_week=$3 AND active=TRUE AND id<>$4',[actor.centerId,schedule.student_id,schedule.day_of_week,schedule.id])).rows;
        if(others.some(s=>start<minute(s.start_time)+s.duration_minutes&&start+schedule.duration_minutes>minute(s.start_time)))fail(409,'Restoring this slot would overlap another visit for this student.');
      }
      const row=(await tx.query('UPDATE schedules SET active=$1 WHERE id=$2 AND center_id=$3 RETURNING *',[req.body.active,String(req.params.id),actor.centerId])).rows[0];
      await audit(tx,actor,req.body.active?'Schedule restored':'Schedule canceled',row.id);return publicRow(row);
    });res.json(result);
  });

  installAttendance(app,db);
  app.post('/api/students/:id/interactions',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),studentId=String(req.params.id),summary=textField(req.body?.summary,'Summary',true,2000),channel=req.body?.channel;
    if(!['Phone','Email','Meeting','Other'].includes(channel))fail(422,'Choose a valid contact channel.');
    const result=await db.transaction(async tx=>{await scoped(tx,'students',studentId,actor.centerId);const row=(await tx.query('INSERT INTO interactions(id,center_id,student_id,channel,summary,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),actor.centerId,studentId,channel,summary,actor.id,actor.name])).rows[0];await audit(tx,actor,'Interaction logged',studentId,channel);return publicRow(row);});res.status(201).json(result);
  });
  app.post('/api/incidents/:id/resolve',allow(...managers),async(req,res)=>{
    const actor=actorOf(req),id=String(req.params.id),reason=textField(req.body?.reason,'Resolution reason',true,1000);
    const result=await db.transaction(async tx=>{const incident=await scoped(tx,'incidents',id,actor.centerId,true);if(incident.status==='resolved')return publicRow(incident);const row=(await tx.query("UPDATE incidents SET status='resolved',resolved_at=NOW(),resolution_reason=$1 WHERE id=$2 AND center_id=$3 RETURNING *",[reason,id,actor.centerId])).rows[0];
      if(incident.visit_id)await tx.query("UPDATE visits SET reconciliation_status='clear' WHERE center_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM incidents WHERE center_id=$1 AND visit_id=$2 AND status='open')",[actor.centerId,incident.visit_id]);
      await audit(tx,actor,'Incident resolved',id,'Manager recorded a resolution.');return publicRow(row);});res.json(result);
  });
  app.use('/api',(_req,_res,next)=>next(new ApiError(404,'API route not found.')));
  app.use((error: any,_req: Request,res: Response,_next: NextFunction)=>{
    if(error instanceof ApiError)return res.status(error.status).json({error:error.message});
    if(error?.type==='entity.parse.failed')return res.status(400).json({error:'Request body must be valid JSON.'});
    if(error?.type==='entity.too.large')return res.status(413).json({error:'Request is too large.'});
    if(error?.code==='23505')return res.status(409).json({error:'This record conflicts with an existing record. Refresh and try again.'});
    console.error('Request failed',{name:error?.name,code:error?.code});
    return res.status(500).json({error:'The request could not be saved. Please try again.'});
  });
  return app;
}

function installAttendance(app: ReturnType<typeof express>,db: Database) {
  app.post('/api/attendance',allow(...operators),async(req,res)=>{
    const actor=actorOf(req),body=req.body??{};
    const eventId=textField(body.eventId,'Event ID',true,128),studentId=textField(body.studentId,'Student',true,128),action=body.action;
    if(!['check_in','check_out','exceptional_departure'].includes(action))fail(422,'Choose an explicit attendance action.');
    const reason=textField(body.reason,'Reason',action==='exceptional_departure',1000),guardianId=textField(body.guardianId,'Guardian',false,128);
    const requestHash=createHash('sha256').update(JSON.stringify({studentId,action,reason,guardianId})).digest('hex');
    const result=await db.transaction(async tx=>{
      const student=await scoped(tx,'students',studentId,actor.centerId,true);
      const previous=(await tx.query('SELECT * FROM attendance_events WHERE center_id=$1 AND id=$2',[actor.centerId,eventId])).rows[0];
      if(previous){if(previous.request_hash!==requestHash)fail(409,'This event ID was already used for a different request.');return {event:previous.result_payload?.event??publicRow(previous),visit:previous.result_payload?.visit??(previous.visit_id?publicRow(await scoped(tx,'visits',previous.visit_id,actor.centerId)):null),replayed:true};}
      const open=(await tx.query("SELECT * FROM visits WHERE center_id=$1 AND student_id=$2 AND status='open' FOR UPDATE",[actor.centerId,studentId])).rows[0];
      if(action==='check_in'&&open){await addIncident(tx,actor,studentId,open.id,'duplicate_check_in','A second arrival was attempted while a visit was already open.');await audit(tx,actor,'Duplicate check-in rejected',studentId);return {conflict:'This student is already checked in. Verify the current roster.'};}
      if(action==='check_in'&&student.status!=='active')fail(409,'This student is inactive. A manager must review the record before check-in.');
      let releaseBasis:string|null=null;
      if(action==='check_out') {
        if(student.pickup_alert)fail(403,'A pickup restriction needs manager review. Normal release is blocked. If an actual departure occurs, record an exceptional departure.');
        if(!guardianId)fail(422,'Select the authorized guardian who is collecting the student.');
        const guardian=(await tx.query('SELECT g.name,sg.can_pickup FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id AND g.center_id=sg.center_id WHERE sg.center_id=$1 AND sg.student_id=$2 AND sg.guardian_id=$3',[actor.centerId,studentId,guardianId])).rows[0];
        if(!guardian||!guardian.can_pickup)fail(403,'This guardian is not authorized for pickup. Ask the manager to review.');
        releaseBasis=`Authorized guardian: ${guardian.name}`;
      }
      const occurredAt=new Date().toISOString();let visitId:string|null=open?.id??null;
      if(action==='check_in') {
        visitId=randomUUID();await tx.query("INSERT INTO visits(id,center_id,student_id,checked_in_at,status) VALUES($1,$2,$3,$4,'open')",[visitId,actor.centerId,studentId,occurredAt]);
      } else if(open) {
        await tx.query("UPDATE visits SET checked_out_at=$1,status='closed',release_basis=$2,reconciliation_status=CASE WHEN $3 OR EXISTS(SELECT 1 FROM incidents WHERE center_id=$5 AND visit_id=$4 AND status='open') THEN 'review_needed' ELSE 'clear' END WHERE id=$4 AND center_id=$5",[occurredAt,action==='exceptional_departure'?'Observed exceptional departure':releaseBasis,action==='exceptional_departure',open.id,actor.centerId]);
      }
      const event=(await tx.query(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,occurred_at,actor_id,actor_name,reason,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[eventId,actor.centerId,studentId,visitId,action,occurredAt,actor.id,actor.name,reason||null,requestHash])).rows[0];
      if(action==='exceptional_departure'||(!open&&action==='check_out'))await addIncident(tx,actor,studentId,visitId,action==='exceptional_departure'?'exceptional_departure':'unmatched_departure',action==='exceptional_departure'?reason:'Departure observed without a recorded arrival. No arrival was inferred.');
      await audit(tx,actor,action==='check_in'?'Student checked in':action==='check_out'?'Student checked out':'Exceptional departure recorded',eventId,visitId?`Visit ${visitId}.`:'Unmatched departure retained for review.');
      const payload={event:publicRow(event),visit:visitId?publicRow(await scoped(tx,'visits',visitId,actor.centerId)):null};
      await tx.query('UPDATE attendance_events SET result_payload=$1 WHERE center_id=$2 AND id=$3',[JSON.stringify(payload),actor.centerId,eventId]);
      return {...payload,replayed:false};
    });
    if('conflict' in result)fail(409,result.conflict!);res.status(result.replayed?200:201).json(result);
  });
  app.post('/api/attendance/:eventId/corrections',allow(...managers),async(req,res)=>{
    const actor=actorOf(req),eventId=String(req.params.eventId),occurredAt=dateField(req.body?.occurredAt,'Actual occurrence time')!,reason=textField(req.body?.reason,'Correction reason',true,1000);
    if(Date.parse(occurredAt)>Date.now())fail(422,'An attendance correction cannot be in the future.');
    const result=await db.transaction(async tx=>{
      const event=await scoped(tx,'attendance_events',eventId,actor.centerId);
      await scoped(tx,'students',event.student_id,actor.centerId,true);
      const prior=(await tx.query('SELECT * FROM attendance_corrections WHERE center_id=$1 AND event_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[actor.centerId,eventId])).rows[0];
      if(event.visit_id){
        const visit=await scoped(tx,'visits',event.visit_id,actor.centerId,true);
        const arrival=event.action==='check_in'?occurredAt:iso(visit.checked_in_at),departure=event.action!=='check_in'?occurredAt:visit.checked_out_at?iso(visit.checked_out_at):null;
        if(departure&&Date.parse(departure)<Date.parse(arrival))fail(422,'Departure cannot be earlier than arrival.');
        const overlaps=(await tx.query(`SELECT id FROM visits WHERE center_id=$1 AND student_id=$2 AND id<>$3
          AND checked_in_at < COALESCE($4::timestamptz,'infinity'::timestamptz)
          AND COALESCE(checked_out_at,'infinity'::timestamptz) > $5::timestamptz LIMIT 1`,[actor.centerId,event.student_id,visit.id,departure,arrival])).rows;
        if(overlaps.length)fail(422,'The correction would overlap another recorded visit. Review the full visit history.');
        await tx.query(`UPDATE visits SET ${event.action==='check_in'?'checked_in_at':'checked_out_at'}=$1 WHERE id=$2 AND center_id=$3`,[occurredAt,visit.id,actor.centerId]);
      }
      const correction=(await tx.query('INSERT INTO attendance_corrections(id,center_id,event_id,original_occurred_at,corrected_occurred_at,reason,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),actor.centerId,eventId,prior?.corrected_occurred_at??event.occurred_at,occurredAt,reason,actor.id,actor.name])).rows[0];
      await audit(tx,actor,'Attendance corrected',eventId,'Original event preserved; visit projection updated.');return {correction:publicRow(correction),event:publicRow(event)};
    });res.status(201).json(result);
  });
  app.get('/api/reports/attendance.csv',allow(...managers),async(req,res)=>{
    const actor=actorOf(req),from=req.query.from,to=req.query.to,studentId=req.query.studentId;
    for(const value of [from,to])if(value!==undefined&&(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))fail(422,'Report dates must be valid YYYY-MM-DD dates.');
    if(from&&to&&String(from)>String(to))fail(422,'The start date must be before the end date.');
    if(studentId!==undefined&&typeof studentId!=='string')fail(422,'Choose one student.');
    const result=await db.transaction(async tx=>{
      const center=(await tx.query('SELECT * FROM centers WHERE id=$1',[actor.centerId])).rows[0];
      if(studentId)await scoped(tx,'students',String(studentId),actor.centerId);
      const rows=(await tx.query(`SELECT e.*,s.student_number,s.first_name,s.last_name,
        c.corrected_occurred_at,c.reason AS correction_reason,c.actor_name AS correcting_actor,c.created_at AS correction_recorded_at
        FROM attendance_events e JOIN students s ON s.id=e.student_id AND s.center_id=e.center_id
        LEFT JOIN LATERAL (SELECT * FROM attendance_corrections c WHERE c.center_id=e.center_id AND c.event_id=e.id ORDER BY created_at DESC,id DESC LIMIT 1) c ON TRUE
        WHERE e.center_id=$1 AND ($2::date IS NULL OR (COALESCE(c.corrected_occurred_at,e.occurred_at) AT TIME ZONE $4)::date >= $2::date)
        AND ($3::date IS NULL OR (COALESCE(c.corrected_occurred_at,e.occurred_at) AT TIME ZONE $4)::date <= $3::date)
        AND ($5::text IS NULL OR e.student_id=$5) ORDER BY COALESCE(c.corrected_occurred_at,e.occurred_at) DESC`,[actor.centerId,from??null,to??null,center.timezone,studentId??null])).rows;
      await audit(tx,actor,'Attendance exported',actor.centerId,`${rows.length} events; from ${from??'all'} through ${to??'all'}; ${center.timezone}.`);return {rows,center};
    });
    const exportedAt=new Date().toISOString();
    const headers=['Student ID','Student number','Student name','Event ID','Action','Original occurred UTC','Effective occurred UTC','Center time zone','Effective local time','Received UTC','Visit ID','Capture mode','Actor','Reason','Correction reason','Corrected by','Correction recorded UTC','Exported UTC'];
    const lines=result.rows.map(row=>{const effective=row.corrected_occurred_at??row.occurred_at;return [row.student_id,row.student_number,`${row.first_name} ${row.last_name}`,row.id,row.action,iso(row.occurred_at),iso(effective),result.center.timezone,new Date(effective).toLocaleString('en-US',{timeZone:result.center.timezone}),iso(row.received_at),row.visit_id,row.capture_mode,row.actor_name,row.reason,row.correction_reason,row.correcting_actor,row.correction_recorded_at?iso(row.correction_recorded_at):'',exportedAt];});
    const csv=[headers,...lines].map(row=>row.map(csvCell).join(',')).join('\r\n');
    res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename="kumon-attendance.csv"');res.send('\uFEFF'+csv+'\r\n');
  });
}
async function addIncident(tx: Queryable,actor: Actor,studentId: string,visitId: string|null,type: string,summary: string) {
  await tx.query('INSERT INTO incidents(id,center_id,student_id,visit_id,type,summary) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.centerId,studentId,visitId,type,summary]);
  if(visitId)await tx.query("UPDATE visits SET reconciliation_status='review_needed' WHERE id=$1 AND center_id=$2",[visitId,actor.centerId]);
}
function csvCell(value: unknown): string {
  let text=value==null?'':String(value);
  if(/^[\s]*[=+\-@]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
