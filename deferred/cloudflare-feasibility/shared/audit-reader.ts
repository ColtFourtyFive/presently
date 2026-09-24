export type AuditFilters = { from: string; to: string; actor: string; action: string; entityType: string; entityId: string };
export type AuditSource = 'stored-audit' | 'attendance-event-projection' | 'attendance-correction-projection';
export type AuditActivityEntry = {
  id: string; actorId: string | null; actorName: string; action: string; entityType: string; entityId: string;
  recordedAt: string; detail: string; detailTruncated: boolean; source: AuditSource;
};
export type AuditActivityPage = {
  items: AuditActivityEntry[]; nextCursor: string | null; scanned: number; searchComplete: boolean;
  range: { from: string; to: string; timezone: string }; asOf: string;
  provenance: { view: 'audit_timeline'; storage: 'current-database'; evictionEnabled: false; snapshot: false };
};
