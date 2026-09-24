import type { AttendanceAction, Page } from './types';
import type { FollowUpTask } from './inquiries';

export const frontDeskViews = ['expected', 'awaiting', 'departed', 'observations', 'followups'] as const;
export type FrontDeskView = typeof frontDeskViews[number];
export type FrontDeskDay = { date: string; dayOfWeek: number; fromISO: string; toISO: string; timezone: string; asOf: string };
export type FrontDeskStudent = { studentId: string; studentName: string; studentCode: string; active: boolean };
export type PlannedStudent = FrontDeskStudent & {
  firstLessonTime: string; lessonCount: number; subjects: string[];
  arrivalRecorded: boolean; observationRecorded: boolean; openVisitRecorded: boolean; openVisitNeedsReview: boolean;
};
export type DepartedStudent = FrontDeskStudent & { lastDepartureAt: string; departureCount: number; includesUnmatched: boolean; needsReview: boolean };
export type DailyObservation = FrontDeskStudent & {
  id: string; action: AttendanceAction; observedAt: string; originalObservedAt: string; observationVersion: number; receivedAt: string; actorName: string; channel: 'admin' | 'kiosk'; unmatched: boolean;
};
export type FrontDeskCounts = { expectedStudents: number; expectedLessons: number; awaitingStudents: number; excludedInactiveLessons: number; excludedSubjectLessons: number };
export type FrontDeskItem = PlannedStudent | DepartedStudent | DailyObservation | FollowUpTask;
export type FrontDeskResponse<T extends FrontDeskItem = FrontDeskItem> = Page<T> & { view: FrontDeskView; day: FrontDeskDay; counts?: FrontDeskCounts };
