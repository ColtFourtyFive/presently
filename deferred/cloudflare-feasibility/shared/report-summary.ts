import type { ReportRange } from './attendance-report';

export type AttendanceDay = {
  date: string; visits: number; students: number; closedVisits: number;
  verifiedClosedVisits: number; pendingReviewVisits: number; verifiedMinutes: number;
};
export type AttendanceSummary = {
  range: ReportRange; asOf: string;
  totals: Omit<AttendanceDay, 'date' | 'students'> & { uniqueStudents: number; averageVerifiedMinutes: number | null };
  days: AttendanceDay[];
  enrollment: { activeStudents: number; inactiveStudents: number; math: number; reading: number; both: number };
};
