import type { Page, Student } from './types';

export type DirectoryStudent = Student & { contact: { displayName: string; phone: string; email: string } | null };
export type DirectoryResult = Page<DirectoryStudent> & { counts: { active: number; math: number; reading: number }; asOf: string };
