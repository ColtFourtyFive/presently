import { IMPORT_FIELDS, type ImportMapping } from '../../shared/import-types';

export const MAX_IMPORT_BYTES = 512 * 1024;

export async function readRosterFile(file: File): Promise<{ csv: string; headers: string[]; mapping: ImportMapping }> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Choose a CSV file no larger than 512 KiB. Split larger rosters into files of up to 500 students.');
  let csv: string;
  try { csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('This file is not valid UTF-8. Export it as CSV UTF-8 and choose the file again.'); }
  if (!csv.trim()) throw new Error('This CSV is empty. Include a header row and at least one student.');
  const source = csv.replace(/^\uFEFF/, '');
  const headers: string[] = []; let value = ''; let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') { if (quoted && source[index + 1] === '"') { value += '"'; index++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { headers.push(value.trim()); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { headers.push(value.trim()); value = ''; break; }
    else value += char;
    if (index === source.length - 1) headers.push(value.trim());
  }
  if (quoted) throw new Error('The CSV header has an unfinished quoted field. Check its quotation marks.');
  if (!headers.length || headers.length > 40 || headers.some(header => !header) || new Set(headers).size !== headers.length) throw new Error('Use 1 to 40 distinct, non-empty column headers.');
  const normalize = (input: string) => input.toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases: Record<string, string[]> = { studentNumber: ['studentid', 'studentcode', 'studentref', 'studentnumber'], pickupAlert: ['pickupalert', 'pickuprestriction'], guardianName: ['parentname'], guardianEmail: ['parentemail'], guardianPhone: ['parentphone'] };
  const mapping = Object.fromEntries(IMPORT_FIELDS.map(([key, label]) => [key, headers.find(header => [normalize(key), normalize(label), ...(aliases[key] || [])].includes(normalize(header))) || ''])) as ImportMapping;
  return { csv: source, headers, mapping };
}

export function downloadCsv(filename: string, rows: unknown[][]): void {
  const cell = (value: unknown) => { const text = String(value ?? ''); return `"${(/^[=+@\-\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`; };
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
