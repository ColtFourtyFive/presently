export async function readCsvFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (file.size > 512 * 1024) throw new Error('Choose a CSV file no larger than 512 KB. Split larger rosters into separate files.');
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('This file is not valid UTF-8. Export or save it as a UTF-8 CSV and try again.');
  }
}
