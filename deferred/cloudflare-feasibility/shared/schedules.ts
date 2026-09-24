import type { Page } from './types';

export type ScheduleSubject = 'Math' | 'Reading';
export type ScheduleInput = { studentId: string; dayOfWeek: number; startTime: string; durationMinutes: number; subject: ScheduleSubject };
export type Schedule = ScheduleInput & {
  id: string; studentName: string; studentCode: string; studentActive: boolean;
  active: boolean; createdAt: string; updatedAt: string;
};
export type SchedulesResponse = Page<Schedule> & { timezone: string };
