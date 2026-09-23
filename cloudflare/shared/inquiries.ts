import type { Page, Student } from './types';

export const inquiryStages = ['New', 'Contacted', 'Assessment scheduled', 'Assessment completed', 'Enrolled', 'Closed lost', 'Do not contact'] as const;
export type InquiryStage = typeof inquiryStages[number];
export type InquirySubject = 'Math' | 'Reading';
export type Inquiry = {
  id: string; contactName: string; studentName: string; email: string; phone: string; subjects: InquirySubject[];
  stage: InquiryStage; source: string; ownerName: string; nextAction: string; dueAt: string | null; notes: string;
  createdAt: string; updatedAt: string; convertedStudentId: string | null; version: number;
};
export type InquiryInput = {
  inquiryId?: string; contactName: string; studentName: string; email: string; phone: string; subjects: InquirySubject[];
  source: string; nextAction: string; dueAt?: string | null; notes?: string;
};
export type InquiryUpdate = { expectedVersion: number; stage?: InquiryStage; nextAction?: string; dueAt?: string | null; notes?: string; ownerName?: string };
export type InquiryList = Page<Inquiry> & { counts: { active: number; enrolled: number }; timezone: string };
export type InquiryHistory = { id: string; fromStage: InquiryStage | null; toStage: InquiryStage; actorName: string; createdAt: string };
export type FollowUpTask = { id: string; title: string; detail: string; dueAt: string; completedAt: string | null; type: 'follow_up' | 'assessment' | 'operations'; inquiryId: string | null };
export type InquiryConversion = { studentId: string; student: Student; inquiry: Inquiry; replayed: boolean };
