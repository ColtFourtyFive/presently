/** Formatting always uses the location's time zone, not the device's. */
export function formatTime(iso: string | null | undefined, timezone: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function formatDateTime(iso: string | null | undefined, timezone: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function formatDate(iso: string | null | undefined, timezone: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}
export function formatDuration(fromIso: string, toIso: string | null) {
  const minutes = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
/** Today's calendar date (YYYY-MM-DD) in a time zone. */
export function localDate(timezone: string, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);

/**
 * Convert a wall-clock time entered for the location ("2026-09-24T15:30") to an
 * ISO instant, independent of the device's own time zone.
 */
export function zonedInputToIso(value: string, timezone: string) {
  const target = Date.parse(`${value}:00.000Z`);
  if (!Number.isFinite(target)) return null;
  let candidate = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
    candidate += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`);
  }
  return new Date(candidate).toISOString();
}
/** The inverse of zonedInputToIso, for prefilling datetime-local inputs. */
export function isoToZonedInput(iso: string | null, timezone: string) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Quote every cell and neutralize spreadsheet formulas. */
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function downloadFile(name: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const newRequestId = () => crypto.randomUUID();
