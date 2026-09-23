import { Hono } from 'hono';
import type { AppEnv,Env } from './types';
import { digest } from './backup-crypto';

export const IMPORT_FIELDS=['studentCode','firstName','lastName','grade','subjects','pickupAlert','guardianReference','guardianName','guardianEmail','guardianPhone','guardianRelationship','pickupAuthority','pickupAuthorityNote'] as const;
type Field=typeof IMPORT_FIELDS[number];type Mapping=Partial<Record<Field,string>>;
type PreviewRow={row:number;action:'create'|'update'|'skip'|'reject'|'review';studentId:string|null;existingStudentId:string|null;guardianId:string|null;expectedVersion:string|null;problem:string|null;values:Record<string,unknown>};
type StoredStudent={id:string;student_code:string;first_name:string;last_name:string;updated_at:string;revision:number};
type StoredGuardian={id:string;import_ref:string;display_name:string;email:string;phone:string};
type StoredGuardianLink={student_id:string;guardian_id:string;pickup_authority:string;authority_note:string};
const uuid=()=>crypto.randomUUID();const encoder=new TextEncoder();
const failure=(c:any,code:string,message:string,status=400)=>c.json({error:{code,message}},status);

// Match SQLite lower(), which folds ASCII letters only. Preserve every other
// Unicode character exactly so identical accented names use the same index key.
export const importNameKey=(name:string)=>name.replace(/[A-Z]/g,letter=>letter.toLowerCase());

export function importCommitStatements(db:Pick<Env['CRM_DB'],'prepare'>,id:string,center:string,previewToken:string,rows:number[],appliedAt:string){
  return [
    db.prepare("UPDATE roster_imports SET status='committing' WHERE id=? AND center_id=? AND preview_token=? AND status IN ('preview','committing')").bind(id,center,previewToken),
    ...rows.map(row=>db.prepare("UPDATE roster_import_rows SET status='applied',applied_at=? WHERE import_id=? AND row_number=? AND status='pending' AND EXISTS(SELECT 1 FROM roster_imports WHERE id=? AND center_id=? AND preview_token=? AND status='committing')").bind(appliedAt,id,row,id,center,previewToken)),
    // Applying rows, deciding completion, and clearing the accepted payload are
    // one transaction. A concurrently rebuilt preview must not be finalized by
    // a request that reviewed an older token, even when its pending count was 0.
    db.prepare("UPDATE roster_imports SET status='completed' WHERE id=? AND center_id=? AND preview_token=? AND status='committing' AND NOT EXISTS(SELECT 1 FROM roster_import_rows WHERE import_id=? AND status IN ('pending','review'))").bind(id,center,previewToken,id),
    db.prepare("UPDATE roster_import_rows SET payload_json=NULL WHERE import_id=? AND payload_json IS NOT NULL AND EXISTS(SELECT 1 FROM roster_imports WHERE id=? AND center_id=? AND preview_token=? AND status='completed') AND NOT EXISTS(SELECT 1 FROM roster_import_rows WHERE import_id=? AND status IN ('pending','review'))").bind(id,id,center,previewToken,id),
  ];
}

export function parseCsv(csv:string):{headers:string[];rows:string[][]}{
  if(encoder.encode(csv).length>512*1024)throw new Error('CSV must be no larger than 512 KB.');
  csv=csv.replace(/^\uFEFF/,'');if(csv.includes('\u0000'))throw new Error('CSV contains unsupported NUL characters.');
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  const pushCell=()=>{if(cell.length>2000)throw new Error('A CSV field exceeds 2,000 characters.');row.push(cell);cell='';closed=false;if(row.length>40)throw new Error('CSV supports at most 40 columns.');};
  const pushRow=()=>{pushCell();if(row.some(v=>v.trim()))rows.push(row);row=[];if(rows.length>501)throw new Error('Import at most 500 rows per file.');};
  for(let i=0;i<csv.length;i++){
    const ch=csv[i];if(quoted){if(ch==='"'){if(csv[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
    if(ch==='"'){if(cell||closed)throw new Error('Malformed CSV quoting.');quoted=true;}
    else if(ch===',')pushCell();else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&csv[i+1]==='\n')i++;pushRow();}
    else {if(closed)throw new Error('Unexpected text after a quoted CSV field.');cell+=ch;}
  }
  if(quoted)throw new Error('CSV has an unclosed quoted field.');if(cell||row.length||closed)pushRow();
  const headers=rows.shift()?.map(h=>h.trim())||[];if(!headers.length||!rows.length)throw new Error('CSV needs a header and at least one data row.');
  if(headers.some(h=>!h)||new Set(headers.map(h=>h.toLowerCase())).size!==headers.length)throw new Error('CSV headers must be nonempty and unique.');
  if(rows.some(r=>r.length!==headers.length))throw new Error('Each CSV row must have the same number of columns as the header.');return {headers,rows};
}
function mapRow(headers:string[],cells:string[],mapping:Mapping,version:string){
  const value:Record<string,unknown>={};for(const field of IMPORT_FIELDS){const column=mapping[field];if(column)value[field]=cells[headers.indexOf(column)].trim();}
  if(mapping.subjects){
    const subjects=String(value.subjects).split(/[;,|]/).map(x=>x.trim()).filter(Boolean).map(x=>/^math$/i.test(x)?'Math':/^reading$/i.test(x)?'Reading':x);
    value.subjects=[...new Set(subjects)];
  }
  if(mapping.pickupAuthority)value.pickupAuthority=String(value.pickupAuthority).toLowerCase()||'unverified';
  value.appliedVersion=version;return value;
}
function validate(value:Record<string,unknown>,link?:StoredGuardianLink):string|null{
  if(!value.studentCode||!value.firstName||!value.lastName)return 'Student code, first name, and last name are required.';
  if(String(value.studentCode).length>80||String(value.firstName).length>100||String(value.lastName).length>100)return 'Student identity fields are too long.';
  if(String(value.grade??'').length>30)return 'Grade must be at most 30 characters.';
  if(((value.subjects as string[]|undefined)||[]).some(s=>!['Math','Reading'].includes(s)))return 'Subjects must be Math, Reading, or both.';
  if(!['unverified','allowed','denied'].includes(String(value.pickupAuthority??'unverified')))return 'Pickup authority must be unverified, allowed, or denied.';
  if((value.pickupAuthority??link?.pickup_authority)==='allowed'&&!(value.pickupAuthorityNote??link?.authority_note))return 'Allowed pickup requires a verification note.';
  if(!value.guardianName&&[value.guardianReference,value.guardianEmail,value.guardianPhone,value.guardianRelationship,value.pickupAuthorityNote].some(Boolean))return 'Guardian name is required when guardian information is supplied.';
  if(value.pickupAuthority&&value.pickupAuthority!=='unverified'&&!value.guardianName)return 'Pickup authority requires an identified guardian.';
  if(value.guardianEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value.guardianEmail)))return 'Guardian email is not valid.';
  if(String(value.pickupAlert).length>500||String(value.pickupAuthorityNote).length>500)return 'Pickup notes must be at most 500 characters.';return null;
}
export async function cleanExpiredImports(env:Env){
  const time=new Date().toISOString();await env.CRM_DB.batch([env.CRM_DB.prepare("UPDATE roster_imports SET status='expired' WHERE status IN ('preview','committing') AND expires_at<=?").bind(time),env.CRM_DB.prepare("UPDATE roster_import_rows SET payload_json=NULL WHERE import_id IN (SELECT id FROM roster_imports WHERE status IN ('expired','completed')) AND payload_json IS NOT NULL")]);
}
async function receipt(env:Env,id:string,center:string){
  const job=await env.CRM_DB.prepare('SELECT id,status,total_rows,preview_token,created_at,expires_at FROM roster_imports WHERE id=? AND center_id=?').bind(id,center).first();if(!job)return null;
  const rows=await env.CRM_DB.prepare('SELECT row_number AS row,action,status,student_id AS studentId,guardian_id AS guardianId,problem,applied_at AS appliedAt FROM roster_import_rows WHERE import_id=? ORDER BY row_number').bind(id).all();
  return {importId:id,status:job.status,totalRows:job.total_rows,previewToken:job.preview_token,createdAt:job.created_at,expiresAt:job.expires_at,rows:rows.results,remaining:rows.results.filter(r=>r.status==='pending').length};
}
export const importRouter=new Hono<AppEnv>();
importRouter.use('*',async(c,next)=>{if(!['owner','manager'].includes(c.get('actor')?.role))return failure(c,'FORBIDDEN','Only owners and managers can import student records.',403);await next();});
importRouter.get('/',async c=>{
  const page=Number(c.req.query('page')||1),pageSize=25;
  if(!Number.isInteger(page)||page<1||page>10000)return failure(c,'INVALID_PAGE','Choose a positive history page.');
  const center=String(c.env.CENTER_ID||'main-center');
  const results=await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare(`SELECT i.id AS importId,i.status,i.total_rows AS totalRows,i.created_at AS createdAt,i.expires_at AS expiresAt,
      (SELECT count(*) FROM roster_import_rows r WHERE r.import_id=i.id AND r.status='pending') AS remaining
      FROM roster_imports i WHERE i.center_id=? ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?`).bind(center,pageSize,(page-1)*pageSize),
    c.env.CRM_DB.prepare('SELECT count(*) AS n FROM roster_imports WHERE center_id=?').bind(center),
  ]);
  return c.json({imports:results[0].results,total:Number((results[1].results[0] as {n:number}).n),page,pageSize});
});
importRouter.post('/preview',async c=>{
  const contentLength=Number(c.req.header('content-length')||0);if(contentLength>800*1024)return failure(c,'IMPORT_SIZE','Import request is too large.',413);
  const reader=c.req.raw.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>800*1024){await reader.cancel();return failure(c,'IMPORT_SIZE','Import request is too large.',413);}chunks.push(part.value);}
  const raw=new Uint8Array(size);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.length;}
  let body:{csv:string;mapping:Mapping;decisions?:Record<string,'create'|'update'|'skip'>;revalidate?:boolean};
  try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{return failure(c,'IMPORT_FORMAT','Supply a valid UTF-8 JSON import request.');}
  if(!body||Array.isArray(body))return failure(c,'IMPORT_FORMAT','Supply a CSV file and column mapping.');
  if(typeof body.csv!=='string'||!body.mapping||typeof body.mapping!=='object')return failure(c,'IMPORT_FORMAT','Supply a CSV file and column mapping.');
  let parsed:{headers:string[];rows:string[][]};try{parsed=parseCsv(body.csv);}catch(e){return failure(c,'CSV_INVALID',e instanceof Error?e.message:'Invalid CSV.');}
  const mapping:Mapping={};for(const key of IMPORT_FIELDS){const column=body.mapping[key];if(column!==undefined&&column!==''&&(!parsed.headers.includes(column)||typeof column!=='string'))return failure(c,'MAPPING_INVALID',`The ${key} column does not exist.`);if(column)mapping[key]=column;}
  if(!mapping.studentCode||!mapping.firstName||!mapping.lastName)return failure(c,'MAPPING_REQUIRED','Map a stable student code, first name, and last name.');
  if(new Set(Object.values(mapping)).size!==Object.values(mapping).length)return failure(c,'MAPPING_DUPLICATE','Each CSV column can map to only one field.');
  const center=String(c.env.CENTER_ID||'main-center'),sourceHash=await digest(encoder.encode(body.csv)),mappingHash=await digest(encoder.encode(JSON.stringify(mapping)));
  const old=await c.env.CRM_DB.prepare('SELECT id,status FROM roster_imports WHERE center_id=? AND source_hash=? AND mapping_hash=?').bind(center,sourceHash,mappingHash).first<{id:string;status:string}>();
  if(old&&(old.status==='completed'||old.status==='committing'&&!body.revalidate))return c.json(await receipt(c.env,old.id,center));
  const applied=old?(await c.env.CRM_DB.prepare("SELECT row_number FROM roster_import_rows WHERE import_id=? AND status='applied'").bind(old.id).all<{row_number:number}>()).results.map(r=>r.row_number):[];
  const time=new Date().toISOString(),id=old?.id||uuid(),token=uuid(),expires=new Date(Date.now()+60*60000).toISOString();
  const values=parsed.rows.map(row=>mapRow(parsed.headers,row,mapping,time));
  const normalizedNames=values.map(v=>importNameKey(`${v.firstName} ${v.lastName}`));
  const codes=[...new Set(values.map(v=>String(v.studentCode)))],names=[...new Set(normalizedNames)],refs=[...new Set(values.map(v=>String(v.guardianReference||'')).filter(Boolean))];
  const [byCodes,byNames,guardians]=await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare('SELECT id,student_code,first_name,last_name,updated_at,revision FROM students WHERE center_id=? AND student_code IN (SELECT value FROM json_each(?)) LIMIT 501').bind(center,JSON.stringify(codes)),
    c.env.CRM_DB.prepare("SELECT id,student_code,first_name,last_name,updated_at,revision FROM students WHERE center_id=? AND lower(first_name || ' ' || last_name) IN (SELECT value FROM json_each(?)) LIMIT 1001").bind(center,JSON.stringify(names)),
    c.env.CRM_DB.prepare('SELECT id,import_ref,display_name,email,phone FROM guardians WHERE center_id=? AND import_ref IN (SELECT value FROM json_each(?)) LIMIT 501').bind(center,JSON.stringify(refs))]);
  if(byNames.results.length===1001)return failure(c,'TOO_MANY_MATCHES','Split this file into smaller files to review duplicate names safely.');
  // Keep every code for a normalized name: a single stored match would hide
  // ambiguity when distinct students share that name. Build once per preview.
  const nameCodes=new Map<string,Set<string>>();
  for(const student of byNames.results as unknown as StoredStudent[]){
    const name=importNameKey(`${student.first_name} ${student.last_name}`);
    let matches=nameCodes.get(name);if(!matches){matches=new Set<string>();nameCodes.set(name,matches);}matches.add(student.student_code);
  }
  const existing=new Map((byCodes.results as unknown as StoredStudent[]).map(s=>[s.student_code,s]));const guardianMap=new Map((guardians.results as unknown as StoredGuardian[]).map(g=>[g.import_ref,g]));
  const linkKeys=values.map(value=>[existing.get(String(value.studentCode))?.id,guardianMap.get(String(value.guardianReference||''))?.id]).filter(pair=>pair[0]&&pair[1]);
  const links=linkKeys.length?(await c.env.CRM_DB.prepare("SELECT DISTINCT l.student_id,l.guardian_id,l.pickup_authority,l.authority_note FROM json_each(?) requested JOIN student_guardians l ON l.student_id=json_extract(requested.value,'$[0]') AND l.guardian_id=json_extract(requested.value,'$[1]') LIMIT 501").bind(JSON.stringify(linkKeys)).all<StoredGuardianLink>()).results:[];
  const linkMap=new Map(links.map(link=>[`${link.student_id}:${link.guardian_id}`,link]));
  const studentIds=new Map<string,string>(),guardianIds=new Map<string,string>(),studentValues=new Map<string,string>(),guardianValues=new Map<string,string>(),seen=new Set<string>();
  const preview:PreviewRow[]=values.map((value,index)=>{
    const code=String(value.studentCode),prior=existing.get(code),guardianRef=String(value.guardianReference||''),previousGuardian=guardianMap.get(guardianRef),decision=body.decisions?.[code];
    let problem=validate(value,prior&&previousGuardian?linkMap.get(`${prior.id}:${previousGuardian.id}`):undefined);let action:PreviewRow['action']=prior?'review':'create';
    const identity=JSON.stringify([value.firstName,value.lastName,value.grade,value.subjects,value.pickupAlert]);
    if(studentValues.has(code)&&studentValues.get(code)!==identity)problem='Repeated student codes have conflicting student information.';studentValues.set(code,identity);
    const guardianInfo=JSON.stringify([value.guardianName,value.guardianEmail,value.guardianPhone]);
    if(guardianRef&&guardianValues.has(guardianRef)&&guardianValues.get(guardianRef)!==guardianInfo)problem='A guardian reference has conflicting contact information.';if(guardianRef)guardianValues.set(guardianRef,guardianInfo);
    if(previousGuardian&&([['guardianName','display_name'],['guardianEmail','email'],['guardianPhone','phone']] as const).some(([field,column])=>mapping[field]&&previousGuardian[column]!==value[field]))problem='An existing guardian reference has different contact information. Review the guardian record first.';
    const matchingCodes=nameCodes.get(normalizedNames[index]);
    const sameName=!!matchingCodes&&(matchingCodes.size>1||!matchingCodes.has(code));
    if(!prior&&sameName&&decision!=='create'){action='review';problem=problem||'A different student has the same name. Confirm a separate student or skip.';}
    if(prior)problem=problem||'This student code already exists. Choose update or skip.';
    if(decision==='skip'){action='skip';problem=null;}else if(prior&&decision==='update'){action='update';if(problem==='This student code already exists. Choose update or skip.')problem=null;}else if(!prior&&decision==='create'){action='create';if(problem==='A different student has the same name. Confirm a separate student or skip.')problem=null;}
    const rowHash=JSON.stringify(value);if(seen.has(rowHash)){action='skip';problem='Duplicate row in this file.';}seen.add(rowHash);
    if(problem&&action!=='review'&&action!=='skip')action='reject';
    const studentId=prior?.id||studentIds.get(code)||uuid();studentIds.set(code,studentId);
    const guardianKey=guardianRef||`${code}:row:${index}`;const guardianId=value.guardianName?(previousGuardian?.id||guardianIds.get(guardianKey)||uuid()):null;if(guardianId)guardianIds.set(guardianKey,guardianId);
    return {row:index+2,action,studentId,existingStudentId:prior?.id||null,guardianId,expectedVersion:prior?String(prior.revision):null,problem,values:value};
  });
  const statements=[];
  if(old)statements.push(c.env.CRM_DB.prepare("DELETE FROM roster_import_rows WHERE import_id=? AND status!='applied'").bind(id));
  statements.push(c.env.CRM_DB.prepare("INSERT INTO roster_imports(id,center_id,source_hash,mapping_hash,preview_token,created_by,created_at,expires_at,status,total_rows,mapping_json) VALUES(?,?,?,?,?,?,?,?,'preview',?,?) ON CONFLICT(id) DO UPDATE SET preview_token=excluded.preview_token,created_by=excluded.created_by,created_at=excluded.created_at,expires_at=excluded.expires_at,status='preview',total_rows=excluded.total_rows,mapping_json=excluded.mapping_json").bind(id,center,sourceHash,mappingHash,token,c.get('actor').id,time,expires,preview.length,JSON.stringify(mapping)));
  const appliedRows=new Set(applied);
  const remaining=preview.filter(r=>!appliedRows.has(r.row));
  statements.push(c.env.CRM_DB.prepare("INSERT INTO roster_import_rows(import_id,row_number,action,status,student_id,guardian_id,expected_student_revision,payload_json,problem) SELECT ?,json_extract(value,'$.row'),json_extract(value,'$.action'),CASE json_extract(value,'$.action') WHEN 'skip' THEN 'skipped' WHEN 'reject' THEN 'rejected' WHEN 'review' THEN 'review' ELSE 'pending' END,json_extract(value,'$.studentId'),json_extract(value,'$.guardianId'),json_extract(value,'$.expectedVersion'),json_extract(value,'$.values'),json_extract(value,'$.problem') FROM json_each(?)").bind(id,JSON.stringify(remaining)));
  await c.env.CRM_DB.batch(statements);return c.json({importId:id,previewToken:token,status:'preview',totalRows:preview.length,alreadyAppliedRows:applied,expiresAt:expires,rows:remaining,canCommit:!remaining.some(r=>r.action==='review'),summary:Object.fromEntries(['create','update','skip','reject','review'].map(action=>[action,remaining.filter(r=>r.action===action).length]))});
});
importRouter.get('/:id',async c=>{const result=await receipt(c.env,c.req.param('id'),String(c.env.CENTER_ID||'main-center'));return result?c.json(result):failure(c,'NOT_FOUND','Import receipt not found.',404);});
importRouter.post('/:id/commit',async c=>{
  const body=await c.req.json<{previewToken:string}>(),id=c.req.param('id'),center=String(c.env.CENTER_ID||'main-center');
  const job=await c.env.CRM_DB.prepare('SELECT * FROM roster_imports WHERE id=? AND center_id=?').bind(id,center).first<{status:string;preview_token:string;expires_at:string}>();if(!job)return failure(c,'NOT_FOUND','Import not found.',404);
  if(job.preview_token!==body.previewToken)return failure(c,'PREVIEW_CHANGED','The preview changed. Review the current preview before importing.',409);
  if(job.status==='completed')return c.json(await receipt(c.env,id,center));
  if(job.expires_at<=new Date().toISOString()||job.status==='expired')return failure(c,'IMPORT_EXPIRED','This preview expired. Upload and review the file again.',409);
  const unresolved=await c.env.CRM_DB.prepare("SELECT count(*) AS n FROM roster_import_rows WHERE import_id=? AND status='review'").bind(id).first<{n:number}>();if(unresolved!.n)return failure(c,'DUPLICATES_UNRESOLVED','Resolve every duplicate decision before importing.',409);
  const rows=await c.env.CRM_DB.prepare("SELECT row_number FROM roster_import_rows WHERE import_id=? AND status='pending' ORDER BY row_number LIMIT 10").bind(id).all<{row_number:number}>();
  const statements=importCommitStatements(c.env.CRM_DB,id,center,body.previewToken,rows.results.map(row=>row.row_number),new Date().toISOString());
  try{const results=await c.env.CRM_DB.batch(statements);if(results[0].meta.changes!==1)return failure(c,'PREVIEW_CHANGED','The accepted preview changed. Review it again before importing.',409);}catch(error){const message=error instanceof Error?error.message:'';if(/IMPORT_STALE|IMPORT_GUARDIAN_CHANGED|IMPORT_PICKUP_EVIDENCE_REQUIRED|UNIQUE constraint/.test(message))return failure(c,'PREVIEW_STALE','Relevant records changed after preview. Applied rows are recorded in the receipt; review the remaining rows before continuing.',409);throw error;}
  return c.json(await receipt(c.env,id,center));
});
