import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Actor, AuthenticatedRequest } from './auth.js';
import type { Database, Queryable, Row } from './db.js';
import { audit, iso, updateEnrollments } from './records.js';
import { parseCsv } from './import-csv.js';
import { IMPORT_FIELDS, type ImportAction, type ImportMapping, type ImportPreviewRequest, type ImportPreviewRow, type ImportReceipt, type ImportValues } from '../shared/import-types.js';
import type { Subject } from '../shared/types.js';

class ImportError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const fail = (code: string, message: string, status = 400): never => { throw new ImportError(status, code, message); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const actorOf = (req: Request) => (req as AuthenticatedRequest).actor;
const optional = ['grade', 'subjects', 'pickupAlert'] as const;
const guardianColumns = [['guardianName','name'], ['guardianEmail','email'], ['guardianPhone','phone'], ['guardianRelationship','relationship']] as const;

function input(body: unknown): ImportPreviewRequest & { parsed: ReturnType<typeof parseCsv> } {
  if (!identity(body) || typeof body.csv !== 'string' || !identity(body.mapping)) fail('IMPORT_FORMAT','Supply a UTF-8 CSV and a column mapping.');
  const raw = body as Record<string, unknown>, mapping: ImportMapping = {};
  if (Object.keys(raw).some(key => !['csv','mapping','decisions','revalidate'].includes(key))) fail('IMPORT_FORMAT','Unexpected import request field.');
  let parsed: ReturnType<typeof parseCsv>;
  try { parsed = parseCsv(raw.csv as string); } catch (error) { return fail('CSV_INVALID',error instanceof Error ? error.message : 'Invalid CSV.'); }
  if (Object.keys(raw.mapping as object).some(key => !IMPORT_FIELDS.some(([field]) => field === key))) fail('MAPPING_INVALID','Unknown destination field in the mapping.');
  for (const [field,,required] of IMPORT_FIELDS) {
    const column = (raw.mapping as Record<string, unknown>)[field];
    if (column !== undefined && column !== '' && (typeof column !== 'string' || !parsed.headers.includes(column))) fail('MAPPING_INVALID',`The ${field} column does not exist.`);
    if (column) mapping[field] = column as string;
    if (required && !mapping[field]) fail('MAPPING_REQUIRED','Map student reference, first name, and last name.');
  }
  if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) fail('MAPPING_DUPLICATE','Map each CSV column to only one field.');
  if (raw.decisions !== undefined && (!identity(raw.decisions) || Object.keys(raw.decisions).length > 500 || Object.values(raw.decisions).some(value => !['create','update','skip'].includes(String(value))))) fail('DECISIONS_INVALID','Supply create, update, or skip decisions by student reference.');
  if (raw.revalidate !== undefined && typeof raw.revalidate !== 'boolean') fail('IMPORT_FORMAT','Revalidate must be true or false.');
  return { csv: raw.csv as string, mapping, parsed, decisions: raw.decisions as ImportPreviewRequest['decisions'], revalidate: raw.revalidate as boolean | undefined };
}

function normalize(headers: string[], cells: string[], mapping: ImportMapping): ImportValues {
  const values: Record<string, unknown> = {};
  for (const [field] of IMPORT_FIELDS) if (mapping[field]) values[field] = cells[headers.indexOf(mapping[field]!)].trim();
  if (mapping.subjects) values.subjects = [...new Set(String(values.subjects).split(/[;,|]/).map(value => value.trim()).filter(Boolean).map(value => /^math$/i.test(value) ? 'Math' : /^reading$/i.test(value) ? 'Reading' : value))];
  if (mapping.guardianEmail) values.guardianEmail = String(values.guardianEmail).toLowerCase();
  return values as ImportValues;
}

function validate(values: ImportValues): string | null {
  if (!values.studentNumber || !values.firstName || !values.lastName) return 'Student reference, first name, and last name are required.';
  const limits = { studentNumber: 80, firstName: 200, lastName: 200, grade: 30, pickupAlert: 500, guardianName: 200, guardianEmail: 254, guardianPhone: 40, guardianRelationship: 100 } as const;
  for (const [field, limit] of Object.entries(limits)) if (String(values[field as keyof typeof limits] ?? '').length > limit) return `${field} must be ${limit} characters or fewer.`;
  if (values.subjects?.some(subject => !['Math','Reading'].includes(subject))) return 'Subjects must be Math, Reading, or both.';
  if (values.guardianEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.guardianEmail)) return 'Guardian email is not valid.';
  if (!values.guardianName && [values.guardianEmail,values.guardianPhone,values.guardianRelationship].some(Boolean)) return 'Guardian name is required when guardian contact details are supplied.';
  return null;
}

async function snapshot(tx: Queryable, centerId: string, id: string, lock = false) {
  const student = (await tx.query(`SELECT * FROM students WHERE center_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [centerId,id])).rows[0];
  if (!student) return null;
  const guardians = (await tx.query(`SELECT g.id,g.name,g.email,g.phone,l.relationship,l.can_pickup FROM student_guardians l JOIN guardians g ON g.id=l.guardian_id AND g.center_id=l.center_id WHERE l.center_id=$1 AND l.student_id=$2 ORDER BY g.id${lock ? ' FOR UPDATE OF g,l' : ''}`, [centerId,id])).rows;
  const signature = hash(JSON.stringify([student.student_number,student.first_name,student.last_name,student.grade,student.subjects,student.pickup_alert,student.status,guardians]));
  return { student, guardians, signature };
}

async function expire(tx: Queryable, centerId: string) {
  await tx.query("UPDATE roster_imports SET status='expired' WHERE center_id=$1 AND status IN ('preview','committing') AND expires_at<=NOW()", [centerId]);
  await tx.query("UPDATE roster_import_rows r SET payload_json=NULL FROM roster_imports i WHERE r.import_id=i.id AND i.center_id=$1 AND i.status IN ('expired','completed') AND r.payload_json IS NOT NULL", [centerId]);
}

async function receipt(tx: Queryable, centerId: string, id: string): Promise<ImportReceipt> {
  const job = (await tx.query('SELECT * FROM roster_imports WHERE center_id=$1 AND id=$2',[centerId,id])).rows[0];
  if (!job) return fail('NOT_FOUND','Import receipt not found.',404);
  const rows = (await tx.query('SELECT row_number AS row,action,status,student_id AS "studentId",guardian_id AS "guardianId",problem,applied_at AS "appliedAt" FROM roster_import_rows WHERE center_id=$1 AND import_id=$2 ORDER BY row_number',[centerId,id])).rows;
  return { importId:id,status:job.status,totalRows:job.total_rows,previewToken:job.preview_token,createdAt:iso(job.created_at),expiresAt:iso(job.expires_at),remaining:rows.filter(row=>row.status==='pending').length,rows:rows.map(row=>({...row,appliedAt:row.appliedAt?iso(row.appliedAt):null})) as ImportReceipt['rows'] };
}

async function lockOwner(tx: Queryable, actor: Actor) {
  const current = (await tx.query('SELECT role,active FROM staff WHERE id=$1 AND center_id=$2 FOR SHARE',[actor.id,actor.centerId])).rows[0];
  if (!current?.active || !['owner','manager'].includes(current.role)) fail('FORBIDDEN','Only owners and managers can import a roster.',403);
  await tx.query('SELECT id FROM centers WHERE id=$1 FOR UPDATE',[actor.centerId]);
}

export function createImportRouter(db: Database) {
  const router = Router();
  router.use((req,res,next)=> { if (!['owner','manager'].includes(actorOf(req).role)) { res.status(403).json({error:'Only owners and managers can import a roster.',code:'FORBIDDEN'}); return; } next(); });
  const route = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request,res: Response,next: (error?: unknown)=>void) => { try { await fn(req,res); } catch (error) { if (error instanceof ImportError) res.status(error.status).json({error:error.message,code:error.code}); else next(error); } };

  router.get('/',route(async(req,res)=> {
    const center = actorOf(req).centerId;
    const imports = await db.transaction(async tx => {
      await expire(tx,center);
      return (await tx.query("SELECT i.id AS \"importId\",i.status,i.total_rows AS \"totalRows\",i.created_at AS \"createdAt\",i.expires_at AS \"expiresAt\",(SELECT COUNT(*)::integer FROM roster_import_rows r WHERE r.import_id=i.id AND r.status='pending') AS remaining FROM roster_imports i WHERE center_id=$1 ORDER BY created_at DESC LIMIT 20",[center])).rows.map(row=>({...row,createdAt:iso(row.createdAt),expiresAt:iso(row.expiresAt)}));
    });
    res.json({imports});
  }));

  router.post('/preview',route(async(req,res)=> {
    const body = input(req.body), actor = actorOf(req), sourceHash = hash(body.csv), mappingHash = hash(JSON.stringify(body.mapping));
    const values = body.parsed.rows.map(cells => normalize(body.parsed.headers,cells,body.mapping));
    const result = await db.transaction(async tx => {
      await lockOwner(tx,actor); await expire(tx,actor.centerId);
      const old = (await tx.query('SELECT * FROM roster_imports WHERE center_id=$1 AND source_hash=$2 AND mapping_hash=$3 FOR UPDATE',[actor.centerId,sourceHash,mappingHash])).rows[0];
      if (old && (old.status==='completed' || old.status==='committing' && !body.revalidate)) return receipt(tx,actor.centerId,old.id);
      const id = old?.id ?? randomUUID(), token = randomUUID(), expires = new Date(Date.now()+3600000).toISOString();
      const applied = old ? (await tx.query("SELECT row_number FROM roster_import_rows WHERE import_id=$1 AND status='applied'",[id])).rows.map(row=>Number(row.row_number)) : [];
      const codes = [...new Set(values.map(value=>value.studentNumber!))], names = [...new Set(values.map(value=>`${value.firstName} ${value.lastName}`.toLowerCase()))];
      const existing = (await tx.query('SELECT id,student_number,first_name,last_name FROM students WHERE center_id=$1 AND student_number=ANY($2::text[])',[actor.centerId,codes])).rows;
      const sameNames = (await tx.query("SELECT id,student_number,first_name,last_name FROM students WHERE center_id=$1 AND lower(first_name||' '||last_name)=ANY($2::text[]) LIMIT 1001",[actor.centerId,names])).rows;
      if(sameNames.length===1001) fail('TOO_MANY_MATCHES','Split the file into smaller files to review duplicate names.');
      const snapshots = new Map<string,Awaited<ReturnType<typeof snapshot>>>();
      for(const student of existing) snapshots.set(student.student_number,await snapshot(tx,actor.centerId,student.id));
      const fingerprints = new Map<string,Set<string>>();
      for(const value of values) { const key=value.studentNumber!; const group=fingerprints.get(key) ?? new Set(); group.add(JSON.stringify(value)); fingerprints.set(key,group); }
      const fileNames=new Map<string,Set<string>>();
      for(const value of values) { const key=`${value.firstName} ${value.lastName}`.toLowerCase(); const group=fileNames.get(key) ?? new Set(); group.add(value.studentNumber!); fileNames.set(key,group); }
      const seen = new Set<string>(), studentIds = new Map<string,string>();
      const rows: (ImportPreviewRow & { expectedHash: string | null })[] = values.map((value,index)=> {
        const code=value.studentNumber!, prior=snapshots.get(code), decision=body.decisions?.[code], rowHash=JSON.stringify(value);
        const studentId=prior?.student.id ?? studentIds.get(code) ?? randomUUID(); studentIds.set(code,studentId);
        let action: ImportAction=prior?'review':'create', problem=validate(value), guardianId: string|null=null;
        if(prior && value.guardianName) {
          const match=prior.guardians.find(guardian=>guardianColumns.every(([field,column])=>value[field]===undefined || value[field]===guardian[column]));
          if(!match) problem=problem || 'Guardian details differ from the existing record. Exclude guardian columns and review those contacts in the student profile.';
          else guardianId=match.id;
        } else if(!prior && value.guardianName) guardianId=randomUUID();
        if((fingerprints.get(code)?.size ?? 0)>1) problem='Repeated student references have conflicting rows. Keep one consistent row per student.';
        const nameMatches=sameNames.filter(student=>student.student_number!==code && `${student.first_name} ${student.last_name}`.toLowerCase()===`${value.firstName} ${value.lastName}`.toLowerCase());
        const sameName=!prior && (nameMatches.length>0 || (fileNames.get(`${value.firstName} ${value.lastName}`.toLowerCase())?.size ?? 0)>1);
        if(decision==='skip') { action='skip'; problem=null; }
        else if(problem) action='reject';
        else if(prior) { if(decision==='update') action='update'; else { action='review'; problem='This student reference exists. Choose update or skip.'; } }
        else if(sameName && decision!=='create') { action='review'; problem='A different student has this name. Confirm a separate student or skip.'; }
        if(seen.has(rowHash) && action!=='reject') { action='skip'; problem='Duplicate row in this file.'; } seen.add(rowHash);
        return {row:index+2,action,studentId,existingStudentId:prior?.student.id ?? null,guardianId,problem,values:value,expectedHash:prior?.signature ?? hash(JSON.stringify(nameMatches.map(student=>student.id).sort()))};
      });
      // Namesakes intentionally created or renamed in this same reviewed import are
      // handled by its row decisions. Track changes to all other matching records.
      const plannedIds=new Set(rows.filter(row=>row.action==='create'||row.action==='update'||applied.includes(row.row)).map(row=>row.studentId));
      for(const row of rows) if(!row.existingStudentId) row.expectedHash=hash(JSON.stringify(sameNames.filter(student=>!plannedIds.has(student.id)&&`${student.first_name} ${student.last_name}`.toLowerCase()===`${row.values.firstName} ${row.values.lastName}`.toLowerCase()).map(student=>student.id).sort()));
      await tx.query("INSERT INTO roster_imports(id,center_id,source_hash,mapping_hash,mapping,preview_token,created_by,expires_at,status,total_rows) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'preview',$9) ON CONFLICT(id) DO UPDATE SET preview_token=EXCLUDED.preview_token,created_by=EXCLUDED.created_by,created_at=NOW(),expires_at=EXCLUDED.expires_at,status='preview'",[id,actor.centerId,sourceHash,mappingHash,JSON.stringify(body.mapping),token,actor.id,expires,rows.length]);
      await tx.query("DELETE FROM roster_import_rows WHERE import_id=$1 AND status!='applied'",[id]);
      const remaining=rows.filter(row=>!applied.includes(row.row));
      for(const row of remaining) await tx.query('INSERT INTO roster_import_rows(import_id,center_id,row_number,action,status,student_id,existing_student_id,guardian_id,expected_hash,payload_json,problem) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,actor.centerId,row.row,row.action,row.action==='skip'?'skipped':row.action==='reject'?'rejected':row.action==='review'?'review':'pending',row.studentId,row.existingStudentId,row.guardianId,row.expectedHash,JSON.stringify(row.values),row.problem]);
      return {importId:id,previewToken:token,status:'preview',totalRows:rows.length,alreadyAppliedRows:applied,expiresAt:expires,rows:remaining.map(({expectedHash,...row})=>row),canCommit:!remaining.some(row=>row.action==='review'),summary:Object.fromEntries(['create','update','skip','reject','review'].map(action=>[action,remaining.filter(row=>row.action===action).length]))};
    }); res.json(result);
  }));

  router.get('/:id',route(async(req,res)=> {
    const actor=actorOf(req);
    res.json(await db.transaction(async tx=> { await expire(tx,actor.centerId); return receipt(tx,actor.centerId,String(req.params.id)); }));
  }));

  router.post('/:id/commit',route(async(req,res)=> {
    if(!identity(req.body) || typeof req.body.previewToken!=='string' || req.body.previewToken.length>100 || Object.keys(req.body).some(key=>key!=='previewToken')) fail('PREVIEW_REQUIRED','Supply the accepted preview token.');
    const actor=actorOf(req), id=String(req.params.id), token=req.body.previewToken;
    const result=await db.transaction(async tx=> {
      await lockOwner(tx,actor);
      const job=(await tx.query('SELECT * FROM roster_imports WHERE center_id=$1 AND id=$2 FOR UPDATE',[actor.centerId,id])).rows[0];
      if(!job) return fail('NOT_FOUND','Import not found.',404);
      if(job.preview_token!==token) fail('PREVIEW_CHANGED','The preview changed. Review the current preview before importing.',409);
      if(job.status==='completed') return receipt(tx,actor.centerId,id);
      if(job.status==='expired' || new Date(job.expires_at).getTime()<=Date.now()) fail('IMPORT_EXPIRED','This preview expired. Upload and review the file again.',409);
      if((await tx.query("SELECT 1 FROM roster_import_rows WHERE import_id=$1 AND status='review' LIMIT 1",[id])).rows.length) fail('DUPLICATES_UNRESOLVED','Resolve duplicate decisions before importing.',409);
      const rows=(await tx.query("SELECT * FROM roster_import_rows WHERE import_id=$1 AND status='pending' ORDER BY row_number LIMIT 10 FOR UPDATE",[id])).rows;
      for(const row of rows) {
        const value=row.payload_json as ImportValues;
        if(row.existing_student_id) {
          const current=await snapshot(tx,actor.centerId,row.student_id,true);
          if(!current || current.signature!==row.expected_hash) fail('PREVIEW_STALE','Records changed after preview. Review the remaining rows before continuing; previously applied batches are preserved.',409);
          const columns: Record<string,unknown>={first_name:value.firstName,last_name:value.lastName};
          for(const field of optional) if(value[field]!==undefined) columns[field==='pickupAlert'?'pickup_alert':field]=field==='subjects'?JSON.stringify(value.subjects):value[field];
          const keys=Object.keys(columns);
          await tx.query(`UPDATE students SET ${keys.map((key,index)=>`${key}=$${index+1}`).join(',')} WHERE center_id=$${keys.length+1} AND id=$${keys.length+2}`,[...Object.values(columns),actor.centerId,row.student_id]);
          if(value.subjects!==undefined) await updateEnrollments(tx,actor.centerId,row.student_id,value.subjects);
        } else {
          if((await tx.query('SELECT id FROM students WHERE center_id=$1 AND student_number=$2',[actor.centerId,value.studentNumber])).rows.length) fail('PREVIEW_STALE','A student reference was created after preview. Review the remaining rows.',409);
          const nameMatches=(await tx.query("SELECT id FROM students WHERE center_id=$1 AND lower(first_name||' '||last_name)=$2 AND id NOT IN (SELECT student_id FROM roster_import_rows WHERE import_id=$3 AND action IN ('create','update') AND status IN ('pending','applied')) ORDER BY id",[actor.centerId,`${value.firstName} ${value.lastName}`.toLowerCase(),id])).rows;
          if(hash(JSON.stringify(nameMatches.map(student=>student.id).sort()))!==row.expected_hash) fail('PREVIEW_STALE','Students with this name changed after preview. Review the remaining rows and confirm any separate students.',409);
          const householdId=randomUUID();
          await tx.query('INSERT INTO households(id,center_id,name) VALUES($1,$2,$3)',[householdId,actor.centerId,`${value.lastName} household`]);
          await tx.query('INSERT INTO students(id,center_id,household_id,student_number,first_name,last_name,grade,subjects,pickup_alert) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[row.student_id,actor.centerId,householdId,value.studentNumber,value.firstName,value.lastName,value.grade??'',JSON.stringify(value.subjects??[]),value.pickupAlert??'']);
          await updateEnrollments(tx,actor.centerId,row.student_id,value.subjects??[]);
          if(row.guardian_id && value.guardianName) {
            await tx.query('INSERT INTO guardians(id,center_id,household_id,name,email,phone) VALUES($1,$2,$3,$4,$5,$6)',[row.guardian_id,actor.centerId,householdId,value.guardianName,value.guardianEmail??'',value.guardianPhone??'']);
            await tx.query('INSERT INTO student_guardians(center_id,student_id,guardian_id,relationship,can_pickup) VALUES($1,$2,$3,$4,FALSE)',[actor.centerId,row.student_id,row.guardian_id,value.guardianRelationship??'']);
          }
          const sequence=/^K-([0-9]+)$/.exec(value.studentNumber!);
          if(sequence && Number(sequence[1])<2147483647) await tx.query('UPDATE centers SET student_sequence=GREATEST(student_sequence,$1) WHERE id=$2',[Number(sequence[1]),actor.centerId]);
        }
        await tx.query("UPDATE roster_import_rows SET status='applied',applied_at=NOW(),payload_json=NULL WHERE import_id=$1 AND row_number=$2",[id,row.row_number]);
        await audit(tx,actor,'Roster imported',row.student_id,JSON.stringify({importId:id,row:row.row_number,action:row.action}));
      }
      const remaining=(await tx.query("SELECT COUNT(*)::integer AS n FROM roster_import_rows WHERE import_id=$1 AND status='pending'",[id])).rows[0].n;
      await tx.query('UPDATE roster_imports SET status=$1 WHERE id=$2',[remaining?'committing':'completed',id]);
      if(!remaining) await tx.query('UPDATE roster_import_rows SET payload_json=NULL WHERE import_id=$1',[id]);
      return receipt(tx,actor.centerId,id);
    }); res.json(result);
  }));
  return router;
}
