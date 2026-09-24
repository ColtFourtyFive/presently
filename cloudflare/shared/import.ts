export const IMPORT_FIELDS = [
  'studentCode', 'firstName', 'lastName', 'grade', 'subjects', 'pickupAlert',
  'guardianReference', 'guardianName', 'guardianEmail', 'guardianPhone', 'guardianRelationship', 'pickupAuthority', 'pickupAuthorityNote',
] as const;
export type ImportField = typeof IMPORT_FIELDS[number];
export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  studentCode: 'Student code', firstName: 'First name', lastName: 'Last name', grade: 'Grade', subjects: 'Subjects', pickupAlert: 'Pickup alert',
  guardianReference: 'Family or guardian reference', guardianName: 'Guardian name', guardianEmail: 'Guardian email', guardianPhone: 'Guardian phone',
  guardianRelationship: 'Guardian relationship', pickupAuthority: 'Pickup authority', pickupAuthorityNote: 'Pickup verification note',
};
export const REQUIRED_IMPORT_FIELDS: ImportField[] = ['studentCode', 'firstName', 'lastName'];

export type ImportRow = {
  row: number; action: 'create' | 'update' | 'skip' | 'reject'; status: 'pending' | 'applied' | 'skipped' | 'rejected';
  studentCode: string; studentName: string; problem: string | null;
};
export type ImportPreview = {
  importId: number; status: 'preview' | 'completed' | 'expired'; sourceName: string; totalRows: number;
  createdAt: string; expiresAt: string; completedAt: string | null; remaining: number; rows: ImportRow[];
};
export type ImportSummary = {
  importId: number; status: ImportPreview['status']; sourceName: string; totalRows: number; applied: number; createdAt: string; completedAt: string | null;
};
