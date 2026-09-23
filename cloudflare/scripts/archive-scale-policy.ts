const DAY_MS = 86_400_000;

export type ArchiveMonthPolicyInput = Readonly<{
  fixtureFrom: string;
  fixtureTo: string;
  asOf: string;
  liveTierDays: number;
}>;

function parseDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a calendar date.`);
  }
  return date;
}

function firstOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function nextMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export function archiveCutoffDate(asOf: string, liveTierDays: number): string {
  if (!Number.isInteger(liveTierDays) || liveTierDays < 90 || liveTierDays > 120) {
    throw new Error('liveTierDays must be an integer from 90 through 120.');
  }
  const date = parseDate(asOf, 'asOf');
  return new Date(date.getTime() - liveTierDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Returns archive-eligible operational months wholly outside the live detail
 * window. The first month is included because the fixture start is the known
 * installation inception, so there are no earlier records to omit.
 */
export function eligibleArchiveMonths(input: ArchiveMonthPolicyInput): string[] {
  const from = parseDate(input.fixtureFrom, 'fixtureFrom');
  const to = parseDate(input.fixtureTo, 'fixtureTo');
  const cutoff = parseDate(archiveCutoffDate(input.asOf, input.liveTierDays), 'cutoff');
  if (from > to) throw new Error('fixtureFrom must not be after fixtureTo.');

  let month = firstOfMonth(from);
  const representedUntil = new Date(to.getTime() + DAY_MS);
  const eligibleUntil = representedUntil < cutoff ? representedUntil : cutoff;
  const result: string[] = [];

  while (nextMonth(month) <= eligibleUntil) {
    result.push(month.toISOString().slice(0, 7));
    month = nextMonth(month);
  }
  return result;
}

export function representativeArchiveMonths(months: readonly string[], requested: number): string[] {
  if (!Number.isInteger(requested) || requested < 1) throw new Error('requested must be a positive integer.');
  if (requested >= months.length) return [...months];
  if (requested === 1) return [months[0]];

  const selected = new Set<number>();
  for (let index = 0; index < requested; index += 1) {
    selected.add(Math.round(index * (months.length - 1) / (requested - 1)));
  }
  return [...selected].sort((a, b) => a - b).map(index => months[index]);
}
