import { Hono } from 'hono';
import type { AppEnv, Env } from './types';
import { bytes64, digest, newHeader, openSecret, sealPart, sealSecret, type BackupHeader, type BackupManifest, validateBackupArchiveReferences } from './backup-crypto';

export const BACKUP_TABLES=['centers','staff','students','guardians','student_guardians','visits','attendance_events','attendance_corrections','observation_effective_times','observation_corrections','observation_correction_request_keys','reviews','audit_entries','schedules','inquiries','inquiry_stage_history','tasks','interactions','roster_revisions','report_epochs','report_runtime','archive_jobs','archive_members','archive_parts','archive_holds','history_holds','history_hold_releases','history_retention_policies','history_retention_policy_revisions','history_retention_jobs','history_retention_items','history_retention_invalidations','history_retention_permits','history_request_keys','history_visit_heads','history_correction_heads','history_correction_outbox','archive_correction_addendum_builds','archive_correction_addendum_publications','archive_correction_addendum_availability','archive_correction_addendum_reconciliation_jobs','archive_correction_addendum_reconciliation_receipts','archive_correction_checkpoint_builds','archive_correction_checkpoint_publications','archive_correction_checkpoint_members','archive_correction_checkpoint_availability','archive_correction_checkpoint_reconciliation_jobs','archive_correction_checkpoint_reconciliation_receipts','history_record_locations','history_runtime','history_backfill_jobs','archive_semantic_sessions','archive_semantic_lifecycle','archive_semantic_diagnostics','archive_semantic_manifests','archive_semantic_parts','archive_semantic_rows','archive_semantic_runs','archive_semantic_operations','archive_semantic_visit_totals','archive_semantic_review_witnesses','archive_budget_runtime','archive_budget_days','archive_budget_pools','archive_budget_attempts','archive_budget_receipts','archive_budget_controls','archive_publication_builds','archive_publication_parts','archive_publication_records','archive_publication_requests','archive_publications','archive_publication_availability','archive_publication_reconciliation_jobs','archive_publication_reconciliation_receipts','archive_publication_abandonment_jobs','archive_publication_abandonment_diagnostics','archive_compact_builds','archive_compact_identities','archive_compact_requests','archive_compact_publications','archive_compact_reconciliation_jobs','archive_compact_reconciliation_receipts','archive_compact_availability','r2_orphan_inventory_policy','r2_orphan_inventory_runs','r2_orphan_inventory_references','r2_orphan_inventory_objects','r2_orphan_observations','r2_orphan_cleanup_plans','history_evidence_expiry_schedules','history_source_revisions','history_source_eviction_policies','history_source_eviction_policy_revisions','history_source_eviction_capabilities','history_source_eviction_receipts'];
const PART_BYTES=1024*1024;
const MAX_SQL_BYTES=512*1024*1024;
type BackupProvider='r2'|'google-drive';
type Job={storage_provider:BackupProvider;id:string;created_at:string;updated_at:string;status:string;bookmark:string|null;signed_url:string|null;sql_bytes:number|null;offset_bytes:number;next_part:number;counts_json:string;schema_json:string;archives_json:string;drive_folder_id:string|null;manifest_file_id:string|null;lease_until:string|null;lease_token:string;attempts:number;error_code:string|null};
type Part={job_id:string;part:number;drive_file_id:string;header_json:string;plaintext_bytes:number;plaintext_sha256:string;encrypted_bytes:number;encrypted_sha256:string;verified_at:string|null};
type Tokens={refreshToken:string;accessToken?:string;expiresAt?:number};
type QueueMessage={jobId:string};
const now=()=>new Date().toISOString();
const setting=(env:Env,key:string)=>typeof env[key]==='string'?env[key] as string:'';
function required(env:Env,key:string){const value=setting(env,key);if(!value)throw new Error(`CONFIG_${key}`);return value;}
async function resultJSON<T>(response:Response,label:string):Promise<T>{if(!response.ok)throw new Error(`${label}_${response.status}`);return response.json() as Promise<T>;}
const encoder=new TextEncoder();
export async function boundedBytes(response:Response,maximum:number):Promise<Uint8Array>{
  const length=response.headers.get('content-length');
  if(length!==null&&(!Number.isSafeInteger(Number(length))||Number(length)<0||Number(length)>maximum)){await response.body?.cancel();throw new Error('REMOTE_BODY_TOO_LARGE');}
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();let size=0;const chunks:Uint8Array[]=[];
  for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>maximum){await reader.cancel();throw new Error('REMOTE_BODY_TOO_LARGE');}chunks.push(item.value);}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
function backupProvider(env:Env):BackupProvider {
  const provider=setting(env,'BACKUP_PROVIDER')||'r2';
  if(provider!=='r2'&&provider!=='google-drive')throw new Error('CONFIG_BACKUP_PROVIDER');
  return provider;
}
function configurationMissing(env:Env,provider:BackupProvider):string[]{
  const missing=['BACKUP_KEY','CF_ACCOUNT_ID','CF_DATABASE_ID','CF_EXPORT_API_TOKEN'].filter(key=>!setting(env,key));
  if(provider==='r2'){if(!env.BACKUP_BUCKET)missing.push('BACKUP_BUCKET');}
  else {
    for(const key of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'])if(!setting(env,key))missing.push(key);
    if(!['production','internal'].includes(setting(env,'GOOGLE_OAUTH_MODE')))missing.push('GOOGLE_OAUTH_MODE');
  }
  return missing;
}
function assertConfigured(env:Env,provider=backupProvider(env)){
  const missing=configurationMissing(env,provider);if(missing.length)throw new Error(`CONFIG_${missing[0]}`);
}
const storagePrefix=(id:string)=>`backups/${id}/`;

async function googleToken(env:Env):Promise<{accessToken:string;folderId:string}>{
  const row=await env.CRM_DB.prepare('SELECT sealed_tokens,folder_id FROM backup_google WHERE id=1').first<{sealed_tokens:string;folder_id:string}>();if(!row)throw new Error('GOOGLE_NOT_CONNECTED');
  const tokens=await openSecret<Tokens>(required(env,'BACKUP_KEY'),row.sealed_tokens);
  if(tokens.accessToken&&tokens.expiresAt&&tokens.expiresAt>Date.now()+60000)return {accessToken:tokens.accessToken,folderId:row.folder_id};
  const value=await resultJSON<{access_token:string;expires_in:number}>(await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:required(env,'GOOGLE_CLIENT_ID'),client_secret:required(env,'GOOGLE_CLIENT_SECRET'),refresh_token:tokens.refreshToken,grant_type:'refresh_token'})}),'GOOGLE_REFRESH');
  if(!value.access_token)throw new Error('GOOGLE_REFRESH_TOKEN_RESPONSE');tokens.accessToken=value.access_token;tokens.expiresAt=Date.now()+value.expires_in*1000;
  await env.CRM_DB.prepare('UPDATE backup_google SET sealed_tokens=? WHERE id=1').bind(await sealSecret(required(env,'BACKUP_KEY'),tokens)).run();return {accessToken:value.access_token,folderId:row.folder_id};
}
async function driveId(token:string){const v=await resultJSON<{ids:string[]}>(await fetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive',{headers:{authorization:`Bearer ${token}`}}),'DRIVE_ID');if(!v.ids?.[0])throw new Error('DRIVE_ID_RESPONSE');return v.ids[0];}
async function createFolder(token:string,id:string,name:string,parent?:string){
  const existing=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,mimeType,trashed`,{headers:{authorization:`Bearer ${token}`}});
  if(existing.ok){const v=await existing.json() as {mimeType:string;trashed?:boolean};if(v.mimeType!=='application/vnd.google-apps.folder'||v.trashed)throw new Error('DRIVE_FOLDER_INVALID');return;}
  if(existing.status!==404)throw new Error(`DRIVE_FOLDER_${existing.status}`);
  await resultJSON(await fetch('https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({id,name,mimeType:'application/vnd.google-apps.folder',...(parent?{parents:[parent]}:{})})}),'DRIVE_FOLDER_CREATE');
}
async function verifiedFile(token:string,id:string,hash:string,size:number):Promise<boolean>{
  const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,{headers:{authorization:`Bearer ${token}`}});
  if(response.status===404)return false;if(!response.ok)throw new Error(`DRIVE_VERIFY_${response.status}`);
  const file=await boundedBytes(response,Math.min(size,PART_BYTES+4096));if(file.length!==size||await digest(file)!==hash)throw new Error('DRIVE_VERIFY_MISMATCH');return true;
}
async function uploadVerified(token:string,id:string,parent:string,name:string,bytes:Uint8Array,hash:string){
  if(await verifiedFile(token,id,hash,bytes.length))return;
  const boundary=`kumon_${crypto.randomUUID()}`;
  const head=encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({id,name,parents:[parent]})}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail=encoder.encode(`\r\n--${boundary}--\r\n`);const body=new Uint8Array(head.length+bytes.length+tail.length);body.set(head);body.set(bytes,head.length);body.set(tail,head.length+bytes.length);
  const response=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':`multipart/related; boundary=${boundary}`},body:body as BodyInit});
  // An uncertain or duplicate create must be resolved using the preallocated file ID.
  if(!response.ok&&response.status!==409)throw new Error(`DRIVE_UPLOAD_${response.status}`);
  if(!await verifiedFile(token,id,hash,bytes.length))throw new Error('DRIVE_UPLOAD_NOT_VERIFIED');
}
async function enqueue(env:Env,jobId:string,delaySeconds=0){const queue=env.BACKUP_QUEUE as Queue<QueueMessage>|undefined;if(queue)await queue.send({jobId},{delaySeconds});}
async function jobWrite(env:Env,job:Job,sql:string,values:(string|number|null)[]){
  const result=await env.CRM_DB.prepare(`${sql} AND lease_token=?`).bind(...values,job.lease_token).run();
  if(result.meta.changes!==1)throw new Error('BACKUP_LEASE_LOST');
}
export async function startBackup(env:Env):Promise<string>{
  const provider=backupProvider(env);assertConfigured(env,provider);if(provider==='google-drive')await googleToken(env);
  const active=await env.CRM_DB.prepare("SELECT id FROM backup_jobs WHERE status NOT IN ('complete','failed') ORDER BY created_at DESC LIMIT 1").first<{id:string}>();if(active)return active.id;
  const id=crypto.randomUUID(),created=now(),until=new Date(Date.now()+60000).toISOString();
  // The closed table list is compiled into one count query. Each count and both
  // catalogs share the same native transaction that acquires the snapshot lock.
  const inventorySql=`SELECT ${BACKUP_TABLES.map(table=>`(SELECT count(*) FROM ${table}) AS ${table}`).join(',')}`;
  const statements=[
  env.CRM_DB.prepare('UPDATE backup_runtime SET write_locked_until=?,lock_job_id=?,backup_monitor_started_at=COALESCE(backup_monitor_started_at,?) WHERE id=1 AND (write_locked_until IS NULL OR write_locked_until<=?)').bind(until,id,created,created),
    env.CRM_DB.prepare(inventorySql),
    env.CRM_DB.prepare('SELECT version FROM schema_versions ORDER BY version'),
    env.CRM_DB.prepare(`SELECT id AS archiveId,json_extract(manifest_json,'$.kind') AS kind,manifest_key AS manifestObjectKey,manifest_sha256 AS manifestSha256 FROM archive_jobs WHERE status='complete'
      UNION ALL SELECT archive_id AS archiveId,json_extract(root_reference_json,'$.kind') AS kind,manifest_object_key AS manifestObjectKey,manifest_sha256 AS manifestSha256 FROM archive_publications
      UNION ALL SELECT archive_id AS archiveId,json_extract(root_reference_json,'$.kind') AS kind,json_extract(root_reference_json,'$.manifestObjectKey') AS manifestObjectKey,json_extract(root_reference_json,'$.manifestSha256') AS manifestSha256 FROM archive_compact_publications
      UNION ALL SELECT archive_id AS archiveId,json_extract(root_reference_json,'$.kind') AS kind,manifest_object_key AS manifestObjectKey,manifest_sha256 AS manifestSha256 FROM archive_correction_addendum_publications
      UNION ALL SELECT archive_id AS archiveId,json_extract(root_reference_json,'$.kind') AS kind,manifest_object_key AS manifestObjectKey,manifest_sha256 AS manifestSha256 FROM archive_correction_checkpoint_publications
      ORDER BY archiveId,manifestSha256,manifestObjectKey`),
  ];
  const results=await env.CRM_DB.batch<Record<string,unknown>>(statements);if(results[0].meta.changes!==1)throw new Error('BACKUP_ALREADY_LOCKED');
  try{
    const counts:Record<string,number>={};
    if(results[1].results.length!==1)throw new Error('BACKUP_INVENTORY_INVALID');
    for(const [table,n] of Object.entries(results[1].results[0])){
      if(typeof table!=='string'||!BACKUP_TABLES.includes(table)||Object.hasOwn(counts,table)||typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw new Error('BACKUP_INVENTORY_INVALID');
      counts[table]=n;
    }
    if(Object.keys(counts).length!==BACKUP_TABLES.length)throw new Error('BACKUP_INVENTORY_INVALID');
    const schemas=results[2].results.map(row=>Number(row.version));
    const archives=new Map<string,import('../shared/archive-format').ArchiveReference>();
    for(const candidate of results[3].results){
      const checked=[candidate];validateBackupArchiveReferences(checked);const reference=checked[0],previous=archives.get(reference.archiveId);
      if(previous&&(previous.manifestSha256!==reference.manifestSha256||previous.manifestObjectKey!==reference.manifestObjectKey||previous.kind!==reference.kind))throw new Error('BACKUP_ARCHIVE_IDENTITY_CONFLICT');
      if(!previous)archives.set(reference.archiveId,reference);
    }
    const references=[...archives.values()];validateBackupArchiveReferences(references);
    await env.CRM_DB.prepare("INSERT INTO backup_jobs(id,created_at,updated_at,status,counts_json,schema_json,storage_provider,archives_json) VALUES(?,?,?,'export',?,?,?,?)").bind(id,created,created,JSON.stringify(counts),JSON.stringify(schemas),provider,JSON.stringify(references)).run();
    await enqueue(env,id);return id;
  }catch(error){await releaseLock(env,id);throw error;}
}
async function releaseLock(env:Env,id:string){await env.CRM_DB.prepare('UPDATE backup_runtime SET write_locked_until=NULL,lock_job_id=NULL WHERE id=1 AND lock_job_id=?').bind(id).run();}
async function exportStep(env:Env,job:Job){
 const lock=await env.CRM_DB.prepare('SELECT write_locked_until FROM backup_runtime WHERE id=1 AND lock_job_id=?').bind(job.id).first<{write_locked_until:string}>();
 if(!lock||lock.write_locked_until<=now())throw new Error('EXPORT_LOCK_EXPIRED');
 let bookmark=job.bookmark;
 let url:string|undefined;
 // D1 rejects database queries while its export is active. Keep the polling
 // bookmark in this invocation and persist it only after export completes.
 while(Date.now()<Date.parse(lock.write_locked_until)){
  const body={output_format:'polling',...(bookmark?{current_bookmark:bookmark}:{})};
  const value=await resultJSON<{success:boolean;result:{at_bookmark?:string;status?:string;error?:string;result?:{signed_url?:string}}}>(await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(required(env,'CF_ACCOUNT_ID'))}/d1/database/${encodeURIComponent(required(env,'CF_DATABASE_ID'))}/export`,{method:'POST',headers:{authorization:`Bearer ${required(env,'CF_EXPORT_API_TOKEN')}`,'content-type':'application/json'},body:JSON.stringify(body)}),'D1_EXPORT');
  if(!value.success||value.result?.status==='error')throw new Error('D1_EXPORT_FAILED');
  bookmark=value.result.at_bookmark||bookmark;
  if(!bookmark)throw new Error('D1_EXPORT_RESPONSE');
  if(value.result.status==='complete'){url=value.result.result?.signed_url;break;}
  if(value.result.status!=='active')throw new Error('D1_EXPORT_RESPONSE');
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 if(lock.write_locked_until<=now())throw new Error('EXPORT_LOCK_EXPIRED');
 if(!url||new URL(url).protocol!=='https:'||!bookmark)throw new Error('D1_EXPORT_RESPONSE');
  // Signed URL comes only from the authenticated Cloudflare API, never from a request parameter.
  await jobWrite(env,job,"UPDATE backup_jobs SET status='parts',bookmark=?,signed_url=? WHERE id=?",[bookmark,url,job.id]);await releaseLock(env,job.id);return 0;
}
async function ensureFolder(env:Env,job:Job,token:string,parent:string){
  if(!job.drive_folder_id){job.drive_folder_id=await driveId(token);await jobWrite(env,job,'UPDATE backup_jobs SET drive_folder_id=? WHERE id=?',[job.drive_folder_id,job.id]);}
  await createFolder(token,job.drive_folder_id,`Kumon backup ${job.created_at.replaceAll(':','-')} ${job.id}`,parent);return job.drive_folder_id;
}
type BackupStorage={newId:(name:string)=>Promise<string>;upload:(id:string,name:string,bytes:Uint8Array,hash:string)=>Promise<void>};
async function verifiedR2File(bucket:R2Bucket,key:string,hash:string,size:number):Promise<boolean>{
  const object=await bucket.get(key);if(!object)return false;
  if(object.size!==size){await object.body.cancel();throw new Error('R2_VERIFY_MISMATCH');}
  const file=await boundedBytes(new Response(object.body),Math.min(size,PART_BYTES+4096));
  if(file.length!==size||await digest(file)!==hash)throw new Error('R2_VERIFY_MISMATCH');
  return true;
}
async function backupStorage(env:Env,job:Job):Promise<BackupStorage>{
  if(job.storage_provider==='r2'){
    const bucket=env.BACKUP_BUCKET;if(!bucket)throw new Error('CONFIG_BACKUP_BUCKET');
    const prefix=storagePrefix(job.id);
    return {
      newId:async name=>prefix+name,
      async upload(id,name,bytes,hash){
        if(id!==prefix+name)throw new Error('R2_OBJECT_KEY_MISMATCH');
        if(await verifiedR2File(bucket,id,hash,bytes.length))return;
        // Create only: a concurrent retry may have already stored the same
        // ciphertext. Never overwrite an existing object, even after a timeout.
        await bucket.put(id,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:hash,httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'},customMetadata:{format:'kumon-backup-part-v1',backupId:job.id}});
        if(!await verifiedR2File(bucket,id,hash,bytes.length))throw new Error('R2_UPLOAD_NOT_VERIFIED');
      },
    };
  }
  if(job.storage_provider!=='google-drive')throw new Error('CONFIG_BACKUP_PROVIDER');
  const {accessToken,folderId}=await googleToken(env);const folder=await ensureFolder(env,job,accessToken,folderId);
  return {newId:()=>driveId(accessToken),upload:(id,name,bytes,hash)=>uploadVerified(accessToken,id,folder,name,bytes,hash)};
}
async function persistAndUploadPart(env:Env,job:Job,storage:BackupStorage,index:number,plaintext:Uint8Array,fileName:string){
  let part=await env.CRM_DB.prepare('SELECT * FROM backup_parts WHERE job_id=? AND part=?').bind(job.id,index).first<Part>();
  const plainHash=await digest(plaintext);const header:BackupHeader=part?JSON.parse(part.header_json):newHeader(job.id,index);
  if(part&&(part.plaintext_sha256!==plainHash||part.plaintext_bytes!==plaintext.length))throw new Error('BACKUP_SOURCE_CHANGED');
  const encrypted=await sealPart(required(env,'BACKUP_KEY'),plaintext,header);const encryptedHash=await digest(encrypted);
  if(!part){const id=await storage.newId(fileName);const created=await env.CRM_DB.prepare('INSERT INTO backup_parts(job_id,part,drive_file_id,header_json,plaintext_bytes,plaintext_sha256,encrypted_bytes,encrypted_sha256) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM backup_jobs WHERE id=? AND lease_token=?)').bind(job.id,index,id,JSON.stringify(header),plaintext.length,plainHash,encrypted.length,encryptedHash,job.id,job.lease_token).run();if(created.meta.changes!==1)throw new Error('BACKUP_LEASE_LOST');part={job_id:job.id,part:index,drive_file_id:id,header_json:JSON.stringify(header),plaintext_bytes:plaintext.length,plaintext_sha256:plainHash,encrypted_bytes:encrypted.length,encrypted_sha256:encryptedHash,verified_at:null};}
  if(part.encrypted_sha256!==encryptedHash)throw new Error('BACKUP_CIPHER_CHANGED');
  await storage.upload(part.drive_file_id,fileName,encrypted,encryptedHash);
  const verified=await env.CRM_DB.prepare('UPDATE backup_parts SET verified_at=? WHERE job_id=? AND part=? AND EXISTS(SELECT 1 FROM backup_jobs WHERE id=? AND lease_token=?)').bind(now(),job.id,index,job.id,job.lease_token).run();if(verified.meta.changes!==1)throw new Error('BACKUP_LEASE_LOST');return part.drive_file_id;
}
async function partStep(env:Env,job:Job){
  const storage=await backupStorage(env,job);
  const response=await fetch(job.signed_url!,{headers:{Range:`bytes=${job.offset_bytes}-${job.offset_bytes+PART_BYTES-1}`}});
  if(response.status!==206&&!(response.status===200&&job.offset_bytes===0&&Number(response.headers.get('content-length'))<=PART_BYTES))throw new Error(`D1_EXPORT_RANGE_${response.status}`);
  const range=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if(response.status===206&&!range){await response.body?.cancel();throw new Error('D1_EXPORT_SIZE_OR_RANGE');}
  const bytes=await boundedBytes(response,PART_BYTES);
  const total=range?Number(range[3]):bytes.length;
  if(!bytes.length||!Number.isSafeInteger(total)||!total||total>MAX_SQL_BYTES||range&&(Number(range[1])!==job.offset_bytes||Number(range[2])+1!==job.offset_bytes+bytes.length||Number(range[2])>=total)||job.sql_bytes!==null&&job.sql_bytes!==total)throw new Error('D1_EXPORT_SIZE_OR_RANGE');
  await persistAndUploadPart(env,job,storage,job.next_part,bytes,`part-${String(job.next_part).padStart(5,'0')}.kcrm`);
  const offset=job.offset_bytes+bytes.length;await jobWrite(env,job,'UPDATE backup_jobs SET sql_bytes=?,offset_bytes=?,next_part=?,status=? WHERE id=?',[total,offset,job.next_part+1,offset===total?'manifest':'parts',job.id]);return 0;
}
async function manifestStep(env:Env,job:Job){
  const rows=await env.CRM_DB.prepare('SELECT * FROM backup_parts WHERE job_id=? AND part>=0 ORDER BY part').bind(job.id).all<Part>();
  if(rows.results.length!==job.next_part||rows.results.some((p,i)=>p.part!==i||!p.verified_at))throw new Error('BACKUP_PARTS_INCOMPLETE');
  const manifest:BackupManifest={format:'kumon-d1-backup-v1',backupId:job.id,...(job.storage_provider==='r2'?{storageProvider:'r2' as const,storagePrefix:storagePrefix(job.id)}:{}),applicationVersion:setting(env,'APP_VERSION'),schemaVersions:JSON.parse(job.schema_json),createdAt:job.created_at,snapshotBookmark:job.bookmark!,recordCounts:JSON.parse(job.counts_json),archiveReferences:JSON.parse(job.archives_json),sqlBytes:job.sql_bytes!,parts:rows.results.map(p=>({index:p.part,fileName:`part-${String(p.part).padStart(5,'0')}.kcrm`,...(job.storage_provider==='r2'?{objectKey:p.drive_file_id}:{driveFileId:p.drive_file_id}),plaintextBytes:p.plaintext_bytes,plaintextSha256:p.plaintext_sha256,encryptedBytes:p.encrypted_bytes,encryptedSha256:p.encrypted_sha256}))};
  const storage=await backupStorage(env,job);
  const manifestId=await persistAndUploadPart(env,job,storage,-1,encoder.encode(JSON.stringify(manifest)), 'manifest.kcrm');
  await jobWrite(env,job,"UPDATE backup_jobs SET status='complete',completed_at=?,manifest_file_id=?,signed_url=NULL,error_code=NULL WHERE id=?",[now(),manifestId,job.id]);return 0;
}
async function alertFailure(env:Env,id:string,code:string,at=now(),send:typeof fetch=fetch){
 const destination=setting(env,'BACKUP_ALERT_URL');if(!destination)return;
 const retryBefore=new Date(Date.parse(at)-freshnessRetryMs).toISOString();
 const claimed=await env.CRM_DB.prepare("UPDATE backup_jobs SET alert_attempted_at=? WHERE id=? AND status='failed' AND alert_delivered_at IS NULL AND (alert_attempted_at IS NULL OR alert_attempted_at<=?) RETURNING id").bind(at,id,retryBefore).first<{id:string}>();
 if(!claimed)return;
 try{
  const response=await send(destination,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'kumon_backup_failed',backupId:id,code,at})});
  if(response.ok)await env.CRM_DB.prepare('UPDATE backup_jobs SET alert_delivered_at=? WHERE id=? AND alert_delivered_at IS NULL').bind(at,id).run();
 }catch{/* The owner status retains the undelivered attempt for the next retry. */}
}
type FreshnessRuntime={
  backup_monitor_started_at:string|null;
  stale_alert_key:string|null;
  stale_alert_attempted_at:string|null;
  stale_alert_delivered_at:string|null;
};
type CompletedBackup={id:string;completed_at:string};
const freshnessRetryMs=60*60*1000;
export async function retryFailedBackupAlerts(env:Env,observedAt=new Date(),send:typeof fetch=fetch){
 if(!setting(env,'BACKUP_ALERT_URL'))return 0;
 const runtime=await env.CRM_DB.prepare('SELECT backup_monitor_started_at FROM backup_runtime WHERE id=1').first<{backup_monitor_started_at:string|null}>();
 if(!runtime?.backup_monitor_started_at)return 0;
 const at=observedAt.toISOString(),retryBefore=new Date(observedAt.getTime()-freshnessRetryMs).toISOString();
 const due=await env.CRM_DB.prepare("SELECT id,error_code FROM backup_jobs WHERE status='failed' AND alert_delivered_at IS NULL AND error_code IS NOT NULL AND error_code<>'RESTORED_JOB_REQUIRES_REVIEW' AND created_at>=? AND (alert_attempted_at IS NULL OR alert_attempted_at<=?) ORDER BY COALESCE(alert_attempted_at,'') ASC,created_at DESC LIMIT 3").bind(runtime.backup_monitor_started_at,retryBefore).all<{id:string;error_code:string}>();
 for(const job of due.results)await alertFailure(env,job.id,job.error_code,at,send);
 return due.results.length;
}
function backupStaleHours(env:Env){
  const configured=setting(env,'BACKUP_STALE_HOURS');
  if(!configured)return 26;
  const value=Number(configured);
  if(!Number.isInteger(value)||value<2||value>168)throw new Error('CONFIG_BACKUP_STALE_HOURS');
  return value;
}
export async function monitorBackupFreshness(env:Env,observedAt=new Date(),send:typeof fetch=fetch){
  const atMs=observedAt.getTime();if(!Number.isFinite(atMs))throw new Error('BACKUP_MONITOR_TIME');
  const at=observedAt.toISOString(),provider=backupProvider(env),staleAfterHours=backupStaleHours(env);
  let runtime=await env.CRM_DB.prepare('SELECT backup_monitor_started_at,stale_alert_key,stale_alert_attempted_at,stale_alert_delivered_at FROM backup_runtime WHERE id=1').first<FreshnessRuntime>();
  if(!runtime)throw new Error('BACKUP_RUNTIME_MISSING');
  if(!runtime.backup_monitor_started_at){
    await env.CRM_DB.prepare('UPDATE backup_runtime SET backup_monitor_started_at=COALESCE(backup_monitor_started_at,?) WHERE id=1').bind(at).run();
    runtime={...runtime,backup_monitor_started_at:at};
  }
  const completed=await env.CRM_DB.prepare("SELECT id,completed_at FROM backup_jobs WHERE status='complete' AND storage_provider=? ORDER BY completed_at DESC LIMIT 1").bind(provider).first<CompletedBackup>();
  const reference=completed?.completed_at||runtime.backup_monitor_started_at;
  if(!reference)throw new Error('BACKUP_MONITOR_REFERENCE');
  const referenceMs=Date.parse(reference);
  if(!Number.isFinite(referenceMs))throw new Error('BACKUP_MONITOR_REFERENCE');
  const stale=atMs-referenceMs>staleAfterHours*60*60*1000;
  if(!stale){
    if(runtime.stale_alert_key)await env.CRM_DB.prepare('UPDATE backup_runtime SET stale_alert_key=NULL,stale_alert_attempted_at=NULL,stale_alert_delivered_at=NULL WHERE id=1').run();
    return {stale:false,staleAfterHours,attempted:false,delivered:false,lastCompletedAt:completed?.completed_at||null};
  }
  const key=`${provider}:${completed?.id||'none'}:${reference}`;
  if(runtime.stale_alert_key!==key){
    await env.CRM_DB.prepare('UPDATE backup_runtime SET stale_alert_key=?,stale_alert_attempted_at=NULL,stale_alert_delivered_at=NULL WHERE id=1').bind(key).run();
    runtime={...runtime,stale_alert_key:key,stale_alert_attempted_at:null,stale_alert_delivered_at:null};
  }
  if(runtime.stale_alert_delivered_at)return {stale:true,staleAfterHours,attempted:false,delivered:true,lastCompletedAt:completed?.completed_at||null};
  const destination=setting(env,'BACKUP_ALERT_URL');
  if(!destination)return {stale:true,staleAfterHours,attempted:false,delivered:false,lastCompletedAt:completed?.completed_at||null};
  const retryBefore=new Date(atMs-freshnessRetryMs).toISOString();
  const claimed=await env.CRM_DB.prepare('UPDATE backup_runtime SET stale_alert_attempted_at=? WHERE id=1 AND stale_alert_key=? AND stale_alert_delivered_at IS NULL AND (stale_alert_attempted_at IS NULL OR stale_alert_attempted_at<=?) RETURNING id').bind(at,key,retryBefore).first<{id:number}>();
  if(!claimed)return {stale:true,staleAfterHours,attempted:false,delivered:false,lastCompletedAt:completed?.completed_at||null};
  try{
    const response=await send(destination,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'kumon_backup_stale',provider,lastCompletedBackupId:completed?.id||null,lastCompletedAt:completed?.completed_at||null,staleAfterHours,at})});
    if(response.ok){await env.CRM_DB.prepare('UPDATE backup_runtime SET stale_alert_delivered_at=? WHERE id=1 AND stale_alert_key=?').bind(at,key).run();return {stale:true,staleAfterHours,attempted:true,delivered:true,lastCompletedAt:completed?.completed_at||null};}
  }catch{/* Attempt time remains visible and rate limits retry. */}
  return {stale:true,staleAfterHours,attempted:true,delivered:false,lastCompletedAt:completed?.completed_at||null};
}
export async function advanceBackup(env:Env,id:string):Promise<{status:string;delay?:number}>{
  const at=now();const leaseToken=crypto.randomUUID();const claimed=await env.CRM_DB.prepare("UPDATE backup_jobs SET lease_until=?,lease_token=?,updated_at=? WHERE id=? AND status NOT IN ('complete','failed') AND (lease_until IS NULL OR lease_until<=?) RETURNING *").bind(new Date(Date.now()+30000).toISOString(),leaseToken,at,id,at).first<Job>();
  if(!claimed){const row=await env.CRM_DB.prepare('SELECT status FROM backup_jobs WHERE id=?').bind(id).first<{status:string}>();return {status:row?.status||'missing',delay:10};}
  try{
    assertConfigured(env,claimed.storage_provider);
    const delay=claimed.status==='export'?await exportStep(env,claimed):claimed.status==='parts'?await partStep(env,claimed):await manifestStep(env,claimed);
    await jobWrite(env,claimed,'UPDATE backup_jobs SET lease_until=NULL,updated_at=?,attempts=0 WHERE id=?',[now(),id]);
    const row=await env.CRM_DB.prepare('SELECT status FROM backup_jobs WHERE id=?').bind(id).first<{status:string}>();return {status:row!.status,delay};
  }catch(error){
    const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'BACKUP_STEP_FAILED';
    if(code==='BACKUP_LEASE_LOST')return {status:claimed.status,delay:10};
 const terminal=claimed.attempts>=4||/LOCK_EXPIRED|SOURCE_CHANGED|VERIFY_MISMATCH|SIZE_OR_RANGE|TOO_LARGE|CONFIG_|PUBLISHING|D1_EXPORT_401|D1_EXPORT_403/.test(code);
    const changed=await env.CRM_DB.prepare('UPDATE backup_jobs SET lease_until=NULL,updated_at=?,attempts=attempts+1,error_code=?,status=? WHERE id=? AND lease_token=?').bind(now(),code,terminal?'failed':claimed.status,id,leaseToken).run();
    if(changed.meta.changes!==1)return {status:claimed.status,delay:10};
    if(terminal){await env.CRM_DB.prepare('UPDATE backup_jobs SET signed_url=NULL WHERE id=?').bind(id).run();await releaseLock(env,id);await alertFailure(env,id,code);return {status:'failed'};}return {status:claimed.status,delay:5};
  }
}
export async function backupQueue(batch:MessageBatch<QueueMessage>,env:Env){for(const message of batch.messages){const result=await advanceBackup(env,message.body.jobId);if(!['complete','failed','missing'].includes(result.status))await enqueue(env,message.body.jobId,result.delay||0);message.ack();}}
export async function backupScheduled(event:ScheduledController,env:Env,send:typeof fetch=fetch){
  if(setting(env,'BACKUP_ENABLED')!=='true')return;
  if(!env.BACKUP_QUEUE)throw new Error('CONFIG_BACKUP_QUEUE');
  const at=new Date(event.scheduledTime);const hour=Number(setting(env,'BACKUP_HOUR_UTC')||'2');
  const recent=await env.CRM_DB.prepare('SELECT id,created_at,status,updated_at FROM backup_jobs ORDER BY created_at DESC LIMIT 1').first<{id:string;created_at:string;status:string;updated_at:string}>();
  if(recent&&!['complete','failed'].includes(recent.status)){
    if(Date.now()-Date.parse(recent.created_at)>50*60*1000){await env.CRM_DB.prepare("UPDATE backup_jobs SET status='failed',error_code='BACKUP_DEADLINE',signed_url=NULL WHERE id=?").bind(recent.id).run();await releaseLock(env,recent.id);await alertFailure(env,recent.id,'BACKUP_DEADLINE',at.toISOString(),send);}
    else if(Date.now()-Date.parse(recent.updated_at)>60000)await enqueue(env,recent.id);return;
  }
  await retryFailedBackupAlerts(env,at,send);
 await monitorBackupFreshness(env,at,send);
  if(at.getUTCHours()===hour&&recent?.created_at.slice(0,10)!==at.toISOString().slice(0,10))await startBackup(env);
}

export const backupRouter=new Hono<AppEnv>();
backupRouter.use('*',async(c,next)=>{if(c.get('actor')?.role!=='owner')return c.json({error:{code:'FORBIDDEN',message:'Only the owner can manage backups.'}},403);await next();});
backupRouter.get('/',async c=>{
  const provider=backupProvider(c.env);
  const connected=await c.env.CRM_DB.prepare('SELECT connected_at FROM backup_google WHERE id=1').first();
  const jobs=await c.env.CRM_DB.prepare('SELECT id,created_at,updated_at,status,sql_bytes,error_code,completed_at,alert_attempted_at,alert_delivered_at,storage_provider,manifest_file_id FROM backup_jobs ORDER BY created_at DESC LIMIT 10').all<{id:string;storage_provider:BackupProvider;manifest_file_id:string|null}>();
  const lastSuccess=await c.env.CRM_DB.prepare("SELECT completed_at FROM backup_jobs WHERE status='complete' AND storage_provider=? ORDER BY completed_at DESC LIMIT 1").bind(provider).first<{completed_at:string}>();
  const freshness=await c.env.CRM_DB.prepare('SELECT backup_monitor_started_at,stale_alert_attempted_at,stale_alert_delivered_at FROM backup_runtime WHERE id=1').first<{backup_monitor_started_at:string|null;stale_alert_attempted_at:string|null;stale_alert_delivered_at:string|null}>();
  const storageConfigured=provider==='r2'?!!c.env.BACKUP_BUCKET:!!connected;
  const missingConfiguration=configurationMissing(c.env,provider);
  if(provider==='google-drive'&&!connected)missingConfiguration.push('GOOGLE_CONNECTION');
  const configured=missingConfiguration.length===0;
  const staleAfterHours=backupStaleHours(c.env);
  return c.json({provider,storageConfigured,configured,missingConfiguration,schedulingConfigured:configured&&!!c.env.BACKUP_QUEUE,connected:storageConfigured,enabled:setting(c.env,'BACKUP_ENABLED')==='true',queueConfigured:!!c.env.BACKUP_QUEUE,oauthPublishingDeclared:['production','internal'].includes(setting(c.env,'GOOGLE_OAUTH_MODE')),stale:!lastSuccess||Date.now()-Date.parse(lastSuccess.completed_at)>staleAfterHours*3600000,alertConfigured:!!setting(c.env,'BACKUP_ALERT_URL'),freshnessAlert:{staleAfterHours,monitorStartedAt:freshness?.backup_monitor_started_at||null,attemptedAt:freshness?.stale_alert_attempted_at||null,deliveredAt:freshness?.stale_alert_delivered_at||null},jobs:jobs.results.map(job=>({...job,storagePrefix:job.storage_provider==='r2'?storagePrefix(job.id):null,manifestKey:job.storage_provider==='r2'?job.manifest_file_id:null}))});
});
backupRouter.post('/connect',async c=>{
  if(backupProvider(c.env)!=='google-drive')return c.json({error:{code:'BACKUP_PROVIDER_R2',message:'This installation uses Cloudflare R2; no Google connection is needed.'}},409);
  assertConfigured(c.env,'google-drive');const state=crypto.randomUUID()+crypto.randomUUID();const verifier=bytes64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const hash=await digest(encoder.encode(state));await c.env.CRM_DB.prepare('INSERT INTO backup_oauth(state_hash,staff_id,sealed_verifier,expires_at) VALUES(?,?,?,?)').bind(hash,c.get('actor').id,await sealSecret(required(c.env,'BACKUP_KEY'),verifier),new Date(Date.now()+600000).toISOString()).run();
  const challenge=bytes64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:required(c.env,'GOOGLE_CLIENT_ID'),redirect_uri:new URL('/api/admin/backups/google/callback',c.req.url).href,response_type:'code',scope:'https://www.googleapis.com/auth/drive.file',access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();return c.json({url:url.href});
});
backupRouter.get('/google/callback',async c=>{
  if(backupProvider(c.env)!=='google-drive')return c.json({error:{code:'BACKUP_PROVIDER_R2',message:'This installation uses Cloudflare R2; no Google connection is needed.'}},409);
  const state=c.req.query('state'),code=c.req.query('code');if(!state||!code)return c.json({error:{code:'OAUTH_DENIED',message:'Google Drive connection was not completed.'}},400);
  const row=await c.env.CRM_DB.prepare('DELETE FROM backup_oauth WHERE state_hash=? AND staff_id=? AND expires_at>? RETURNING sealed_verifier').bind(await digest(encoder.encode(state)),c.get('actor').id,now()).first<{sealed_verifier:string}>();if(!row)return c.json({error:{code:'OAUTH_STATE',message:'The connection request expired. Start again.'}},400);
  const token=await resultJSON<{refresh_token?:string;access_token:string;expires_in:number}>(await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:required(c.env,'GOOGLE_CLIENT_ID'),client_secret:required(c.env,'GOOGLE_CLIENT_SECRET'),code,code_verifier:await openSecret<string>(required(c.env,'BACKUP_KEY'),row.sealed_verifier),redirect_uri:new URL('/api/admin/backups/google/callback',c.req.url).href,grant_type:'authorization_code'})}),'GOOGLE_CONNECT');
  if(!token.refresh_token)throw new Error('GOOGLE_REFRESH_TOKEN_REQUIRED');const folder=await driveId(token.access_token);await createFolder(token.access_token,folder,'Kumon CRM encrypted backups');
  await c.env.CRM_DB.prepare('INSERT INTO backup_google(id,sealed_tokens,folder_id,connected_by,connected_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sealed_tokens=excluded.sealed_tokens,folder_id=excluded.folder_id,connected_by=excluded.connected_by,connected_at=excluded.connected_at').bind(await sealSecret(required(c.env,'BACKUP_KEY'),{refreshToken:token.refresh_token,accessToken:token.access_token,expiresAt:Date.now()+token.expires_in*1000}),folder,c.get('actor').id,now()).run();return c.redirect('/admin?drive=connected');
});
backupRouter.post('/start',async c=>{
  const missing=configurationMissing(c.env,backupProvider(c.env));
  if(missing.length)return c.json({error:{code:'BACKUP_NOT_CONFIGURED',message:'Configure backup storage, encryption, and database export before starting a backup.'},missingConfiguration:missing},503);
  if(!c.env.BACKUP_QUEUE&&setting(c.env,'APP_ENV')!=='local')return c.json({error:{code:'BACKUP_QUEUE_REQUIRED',message:'The backup job runner must be configured before starting a backup.'}},503);
  return c.json({jobId:await startBackup(c.env)},202);
});
backupRouter.post('/:id/advance',async c=>{if(setting(c.env,'APP_ENV')!=='local')return c.notFound();return c.json(await advanceBackup(c.env,c.req.param('id')));});
