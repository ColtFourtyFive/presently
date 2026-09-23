import type { Subject } from './types.js';

export const IMPORT_FIELDS = [
  ['studentNumber', 'Student reference', true], ['firstName', 'First name', true], ['lastName', 'Last name', true],
  ['grade', 'Grade', false], ['subjects', 'Subjects', false], ['pickupAlert', 'Pickup restriction', false],
  ['guardianName', 'Guardian name', false], ['guardianEmail', 'Guardian email', false],
  ['guardianPhone', 'Guardian phone', false], ['guardianRelationship', 'Guardian relationship', false],
] as const;
export type ImportField = typeof IMPORT_FIELDS[number][0];
export type ImportMapping = Partial<Record<ImportField, string>>;
export type ImportDecision = 'create' | 'update' | 'skip';
export type ImportAction = ImportDecision | 'reject' | 'review';
export type ImportStatus = 'preview' | 'committing' | 'completed' | 'expired';
export type ImportValues = Partial<Record<Exclude<ImportField, 'subjects'>, string>> & { subjects?: Subject[] };
export interface ImportPreviewRow {
  row: number; action: ImportAction; studentId: string; existingStudentId: string | null;
  guardianId: string | null; problem: string | null; values: ImportValues;
}
export interface ImportPreview {
  importId: string; previewToken: string; status: 'preview'; totalRows: number; alreadyAppliedRows: number[];
  expiresAt: string; rows: ImportPreviewRow[]; canCommit: boolean; summary: Record<ImportAction, number>;
}
export interface ImportReceiptRow {
  row: number; action: ImportAction; status: 'pending' | 'applied' | 'skipped' | 'rejected' | 'review';
  studentId: string; guardianId: string | null; problem: string | null; appliedAt: string | null;
}
export interface ImportSummary {
  importId: string; status: ImportStatus; totalRows: number; remaining: number; createdAt: string; expiresAt: string;
}
export interface ImportReceipt extends ImportSummary { previewToken: string; rows: ImportReceiptRow[] }
export interface ImportPreviewRequest { csv: string; mapping: ImportMapping; decisions?: Record<string, ImportDecision>; revalidate?: boolean }
