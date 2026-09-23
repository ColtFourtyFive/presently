import { describe, expect, it } from 'vitest';
import { archiveCutoffDate, eligibleArchiveMonths, representativeArchiveMonths } from '../scripts/archive-scale-policy';

describe('realistic archive window selection', () => {
  it('keeps 120 live days and includes the known installation-inception month', () => {
    expect(archiveCutoffDate('2026-09-22', 120)).toBe('2026-05-25');
    const months = eligibleArchiveMonths({
      fixtureFrom: '2024-09-15',
      fixtureTo: '2026-09-21',
      asOf: '2026-09-22',
      liveTierDays: 120,
    });
    expect(months[0]).toBe('2024-09');
    expect(months.at(-1)).toBe('2026-04');
    expect(months).toHaveLength(20);
    expect(representativeArchiveMonths(months, 3)).toEqual(['2024-09', '2025-07', '2026-04']);
  });

  it('validates policy bounds and returns every month when the sample covers all', () => {
    expect(eligibleArchiveMonths({
      fixtureFrom: '2025-01-01',
      fixtureTo: '2025-03-31',
      asOf: '2026-01-01',
      liveTierDays: 90,
    })).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(representativeArchiveMonths(['2025-01', '2025-02'], 4)).toEqual(['2025-01', '2025-02']);
    expect(() => archiveCutoffDate('2026-09-22', 89)).toThrow('90 through 120');
  });
});
