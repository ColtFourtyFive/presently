/**
 * Encrypted backup format. Each part is AES-256-GCM with a key derived by HKDF
 * from the installation's 32-byte recovery key, bound to the backup id and part
 * number. The recovery key is held by the owner and never stored in D1 or R2.
 */
const MAGIC = new TextEncoder().encode('PRSNT-B1\n');
export const PART_FORMAT = 'presently-backup-part-v1';
export const MANIFEST_FORMAT = 'presently-d1-backup-v1';
export type BackupHeader = { format: typeof PART_FORMAT; backupId: string; part: number; salt: string; iv: string };
export type BackupManifest = {
  format: typeof MANIFEST_FORMAT; backupId: string; applicationVersion: string; createdAt: string; completedAt: string;
  snapshotBookmark: string; sqlBytes: number; storagePrefix: string;
  parts: { index: number; fileName: string; objectKey: string; plaintextBytes: number; plaintextSha256: string; encryptedBytes: number; encryptedSha256: string }[];
};
export const MAX_PART_BYTES = 1024 * 1024;
export const partFileName = (index: number) => `part-${String(index).padStart(5, '0')}.bin`;

export const bytes64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
export function from64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), b => b.toString(16).padStart(2, '0')).join('');
}

async function partKey(master: string, header: BackupHeader): Promise<CryptoKey> {
  const raw = from64(master);
  if (raw.byteLength !== 32) throw new Error('Recovery key must contain exactly 32 random bytes.');
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: from64(header.salt) as BufferSource, info: new TextEncoder().encode(`${header.format}:${header.backupId}:${header.part}`) },
    key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export function newHeader(backupId: string, part: number): BackupHeader {
  return { format: PART_FORMAT, backupId, part, salt: bytes64(crypto.getRandomValues(new Uint8Array(32))), iv: bytes64(crypto.getRandomValues(new Uint8Array(12))) };
}

function validateHeader(header: BackupHeader) {
  if (header.format !== PART_FORMAT || !/^[\w-]{1,100}$/.test(header.backupId) || !Number.isSafeInteger(header.part) || header.part < -1 || header.part > 8192
    || from64(header.salt).length !== 32 || from64(header.iv).length !== 12) throw new Error('Invalid encrypted backup header.');
}

export async function sealPart(master: string, plaintext: Uint8Array, header: BackupHeader): Promise<Uint8Array> {
  validateHeader(header);
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: from64(header.iv) as BufferSource, additionalData: encoded }, await partKey(master, header), plaintext as BufferSource,
  ));
  const result = new Uint8Array(MAGIC.length + 4 + encoded.length + cipher.length);
  result.set(MAGIC);
  new DataView(result.buffer).setUint32(MAGIC.length, encoded.length);
  result.set(encoded, MAGIC.length + 4);
  result.set(cipher, MAGIC.length + 4 + encoded.length);
  return result;
}

export async function openPart(master: string, envelope: Uint8Array): Promise<{ header: BackupHeader; plaintext: Uint8Array }> {
  if (envelope.length < 40 || !MAGIC.every((b, i) => envelope[i] === b)) throw new Error('Not a supported encrypted backup.');
  const n = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getUint32(MAGIC.length);
  if (n > 2048 || n < 10 || MAGIC.length + 4 + n + 16 > envelope.length) throw new Error('Truncated or invalid backup.');
  const encoded = envelope.slice(MAGIC.length + 4, MAGIC.length + 4 + n);
  const header = JSON.parse(new TextDecoder().decode(encoded)) as BackupHeader;
  validateHeader(header);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: from64(header.iv) as BufferSource, additionalData: encoded }, await partKey(master, header), envelope.slice(MAGIC.length + 4 + n) as BufferSource,
  ));
  return { header, plaintext };
}

/** Verify every part against the encrypted manifest and stream the decrypted SQL in order. */
export async function verifyBackupStream(
  master: string, manifestEnvelope: Uint8Array, readPart: (name: string) => Promise<Uint8Array>, writePart: (bytes: Uint8Array) => Promise<void>,
): Promise<BackupManifest> {
  const opened = await openPart(master, manifestEnvelope);
  if (opened.header.part !== -1) throw new Error('Expected the encrypted manifest.');
  const manifest = JSON.parse(new TextDecoder().decode(opened.plaintext)) as BackupManifest;
  if (manifest.format !== MANIFEST_FORMAT || manifest.backupId !== opened.header.backupId || !Array.isArray(manifest.parts) || manifest.parts.length > 8192
    || !Number.isSafeInteger(manifest.sqlBytes) || manifest.sqlBytes < 0) throw new Error('Invalid backup manifest.');
  let total = 0;
  for (const [index, part] of manifest.parts.entries()) {
    if (part.index !== index || part.fileName !== partFileName(index) || !Number.isSafeInteger(part.plaintextBytes) || part.plaintextBytes < 0
      || part.plaintextBytes > MAX_PART_BYTES || !/^[a-f0-9]{64}$/.test(part.plaintextSha256) || !/^[a-f0-9]{64}$/.test(part.encryptedSha256))
      throw new Error('Invalid backup part list.');
    total += part.plaintextBytes;
  }
  if (total !== manifest.sqlBytes) throw new Error('Backup length does not match its manifest.');
  for (const [index, part] of manifest.parts.entries()) {
    const encrypted = await readPart(part.fileName);
    if (encrypted.length !== part.encryptedBytes || await digest(encrypted) !== part.encryptedSha256) throw new Error(`Encrypted part ${index} failed verification.`);
    const piece = await openPart(master, encrypted);
    if (piece.header.backupId !== manifest.backupId || piece.header.part !== index || piece.plaintext.length !== part.plaintextBytes
      || await digest(piece.plaintext) !== part.plaintextSha256) throw new Error(`Backup part ${index} failed verification.`);
    await writePart(piece.plaintext);
  }
  return manifest;
}

export async function verifyBackup(master: string, manifestEnvelope: Uint8Array, readPart: (name: string) => Promise<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const manifest = await verifyBackupStream(master, manifestEnvelope, readPart, async bytes => {
    length += bytes.length;
    if (length > 256 * 1024 * 1024) throw new Error('Use streaming recovery for exports larger than 256 MiB.');
    chunks.push(bytes);
  });
  const sql = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { sql.set(chunk, offset); offset += chunk.length; }
  return { manifest, sql };
}
