import type { ArchiveReference } from '../shared/archive-format';
const MAGIC = new TextEncoder().encode('KCRM-B1\n');
export type BackupHeader = { format: 'kumon-backup-part-v1'; backupId: string; part: number; salt: string; iv: string };
export const bytes64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
export function from64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), b => b.toString(16).padStart(2, '0')).join('');
}
async function partKey(master: string, header: BackupHeader): Promise<CryptoKey> {
  const raw = from64(master);
  if (raw.byteLength !== 32) throw new Error('Recovery key must contain exactly 32 random bytes.');
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:from64(header.salt) as BufferSource,info:new TextEncoder().encode(`${header.format}:${header.backupId}:${header.part}`)}, key, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
}
export function newHeader(backupId: string, part: number): BackupHeader {
  return {format:'kumon-backup-part-v1',backupId,part,salt:bytes64(crypto.getRandomValues(new Uint8Array(32))),iv:bytes64(crypto.getRandomValues(new Uint8Array(12)))};
}
function validateHeader(header: BackupHeader) {
  if (header.format !== 'kumon-backup-part-v1' || !/^[\w-]{1,100}$/.test(header.backupId) || !Number.isSafeInteger(header.part) || header.part < -2 || header.part > 8192 || from64(header.salt).length !== 32 || from64(header.iv).length !== 12) throw new Error('Invalid encrypted backup header.');
}
export async function sealPart(master: string, plaintext: Uint8Array, header: BackupHeader): Promise<Uint8Array> {
  validateHeader(header);
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:from64(header.iv) as BufferSource,additionalData:encoded},await partKey(master,header),plaintext as BufferSource));
  const result = new Uint8Array(MAGIC.length + 4 + encoded.length + cipher.length);
  result.set(MAGIC); new DataView(result.buffer).setUint32(MAGIC.length,encoded.length); result.set(encoded,MAGIC.length+4); result.set(cipher,MAGIC.length+4+encoded.length);
  return result;
}
export async function openPart(master: string, envelope: Uint8Array): Promise<{header:BackupHeader;plaintext:Uint8Array}> {
  if (envelope.length < 40 || !MAGIC.every((b,i)=>envelope[i]===b)) throw new Error('Not a supported encrypted backup.');
  const n = new DataView(envelope.buffer,envelope.byteOffset,envelope.byteLength).getUint32(MAGIC.length);
  if (n > 2048 || n < 10 || MAGIC.length+4+n+16 > envelope.length) throw new Error('Truncated or invalid backup.');
  const encoded=envelope.slice(MAGIC.length+4,MAGIC.length+4+n);
  const header=JSON.parse(new TextDecoder().decode(encoded)) as BackupHeader;validateHeader(header);
  const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(header.iv) as BufferSource,additionalData:encoded},await partKey(master,header),envelope.slice(MAGIC.length+4+n) as BufferSource));
  return {header,plaintext};
}
export async function sealSecret(key:string,value:unknown):Promise<string> {return bytes64(await sealPart(key,new TextEncoder().encode(JSON.stringify(value)),newHeader(crypto.randomUUID(),-2)));}
export async function openSecret<T>(key:string,value:string):Promise<T> {return JSON.parse(new TextDecoder().decode((await openPart(key,from64(value))).plaintext)) as T;}

export type BackupManifest = {
  format:'kumon-d1-backup-v1'; backupId:string; applicationVersion:string; schemaVersions:number[];
  createdAt:string; snapshotBookmark:string; recordCounts:Record<string,number>; sqlBytes:number;
  storageProvider?:'r2'|'google-drive'; storagePrefix?:string;
  archiveReferences?:ArchiveReference[];
  parts:{index:number;fileName:string;driveFileId?:string;objectKey?:string;plaintextBytes:number;plaintextSha256:string;encryptedBytes:number;encryptedSha256:string}[];
};
/** The encrypted SQL manifest pins exact historical objects at its snapshot. */
export function validateBackupArchiveReferences(value: unknown): asserts value is ArchiveReference[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid backup archive references.');
  const identities = new Set<string>();
  for (const reference of value) {
    if (!reference || typeof reference !== 'object' || !/^[A-Za-z0-9_-]{1,100}$/.test(reference.archiveId) || !['monthly', 'addendum'].includes(reference.kind) || !/^[a-f0-9]{64}$/.test(reference.manifestSha256) || typeof reference.manifestObjectKey !== 'string') throw new Error('Invalid backup archive reference.');
    const segments = reference.manifestObjectKey.split('/');
    if (segments.length !== 5 || segments[0] !== 'archives' || !/^[A-Za-z0-9_-]{1,100}$/.test(segments[1]) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(segments[2]) || segments[3] !== reference.archiveId || segments[4] !== `manifest-${reference.manifestSha256}.kca` || identities.has(reference.archiveId)) throw new Error('Invalid or duplicate backup archive object.');
    identities.add(reference.archiveId);
  }
}
export type BackupArchiveVerifier = (references: readonly ArchiveReference[]) => Promise<void>;

export async function verifyBackupStream(master:string, manifestEnvelope:Uint8Array, readPart:(name:string)=>Promise<Uint8Array>,writePart:(bytes:Uint8Array)=>Promise<void>,verifyArchives?:BackupArchiveVerifier):Promise<BackupManifest> {
  const opened=await openPart(master,manifestEnvelope);
  if(opened.header.part!==-1)throw new Error('Expected the encrypted manifest.');
  const manifest=JSON.parse(new TextDecoder().decode(opened.plaintext)) as BackupManifest;
  if(manifest.format!=='kumon-d1-backup-v1'||manifest.backupId!==opened.header.backupId||!Array.isArray(manifest.parts)||manifest.parts.length>512||!Number.isSafeInteger(manifest.sqlBytes)||manifest.sqlBytes<0||manifest.sqlBytes>512*1024*1024)throw new Error('Invalid backup manifest.');
  if (manifest.archiveReferences !== undefined) validateBackupArchiveReferences(manifest.archiveReferences);
  else if (manifest.schemaVersions?.some(version => version >= 8)) throw new Error('Backup manifest is missing its archive snapshot.');
  if (manifest.archiveReferences?.length && !verifyArchives) throw new Error('Backup requires historical archive verification.');
  let total=0;
  for(const [index,part] of manifest.parts.entries()){
    if(part.index!==index||part.fileName!==`part-${String(index).padStart(5,'0')}.kcrm`||!Number.isSafeInteger(part.plaintextBytes)||part.plaintextBytes<0||part.plaintextBytes>1024*1024||!Number.isSafeInteger(part.encryptedBytes)||part.encryptedBytes<16||part.encryptedBytes>1024*1024+4096||!/^[a-f0-9]{64}$/.test(part.plaintextSha256)||!/^[a-f0-9]{64}$/.test(part.encryptedSha256))throw new Error('Invalid backup part metadata.');
    total+=part.plaintextBytes;
  }
  if(total!==manifest.sqlBytes)throw new Error('Backup length does not match its manifest.');
  let offset=0;
  for(const [index,part] of manifest.parts.entries()) {
    if(part.index!==index||part.fileName!==`part-${String(index).padStart(5,'0')}.kcrm`||part.plaintextBytes<0||offset+part.plaintextBytes>manifest.sqlBytes)throw new Error('Invalid backup part sequence.');
    const encrypted=await readPart(part.fileName);
    if(encrypted.length!==part.encryptedBytes||await digest(encrypted)!==part.encryptedSha256)throw new Error(`Encrypted part ${index} failed verification.`);
    const piece=await openPart(master,encrypted);
    if(piece.header.backupId!==manifest.backupId||piece.header.part!==index||piece.plaintext.length!==part.plaintextBytes||await digest(piece.plaintext)!==part.plaintextSha256)throw new Error(`Backup part ${index} failed verification.`);
    await writePart(piece.plaintext);offset+=piece.plaintext.length;
  }
  if(offset!==manifest.sqlBytes)throw new Error('Backup length does not match its manifest.');
  if (manifest.archiveReferences?.length) await verifyArchives!(manifest.archiveReferences);
  return manifest;
}
export async function verifyBackup(master:string,manifestEnvelope:Uint8Array,readPart:(name:string)=>Promise<Uint8Array>,verifyArchives?:BackupArchiveVerifier):Promise<{manifest:BackupManifest;sql:Uint8Array}>{
  const chunks:Uint8Array[]=[];let length=0;
  const manifest=await verifyBackupStream(master,manifestEnvelope,readPart,async bytes=>{length+=bytes.length;if(length>128*1024*1024)throw new Error('Use streaming recovery for exports larger than 128 MiB.');chunks.push(bytes);},verifyArchives);
  const sql=new Uint8Array(length);let offset=0;for(const chunk of chunks){sql.set(chunk,offset);offset+=chunk.length;}return {manifest,sql};
}
