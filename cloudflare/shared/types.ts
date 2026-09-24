export const PRODUCT_NAME = 'Presently';
export const PRODUCT_TAGLINE = 'Student check-in and check-out for Kumon centers';
export const NON_AFFILIATION_NOTICE = 'Presently is an independent product. It is not affiliated with, endorsed by, or sponsored by Kumon North America, Inc. or Kumon Institute of Education Co., Ltd.';

export type Role = 'owner' | 'manager' | 'front_desk' | 'instructor';
export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', manager: 'Manager', front_desk: 'Front desk', instructor: 'Instructor' };
export type Channel = 'admin' | 'kiosk';

export type Actor = { id: number; email: string | null; displayName: string; role: Role; channel: Channel; deviceId?: number };
export type Business = { name: string; timezone: string; backupHour: number };
export type Location = { id: number; name: string; timezone: string; address: string; operatingHours: string; active: boolean };
export type Staff = {
  id: number; email: string | null; displayName: string; role: Role; active: boolean;
  kioskEnabled: boolean; hasPin: boolean; locationIds: number[];
};
export type Device = { id: number; locationId: number; label: string; createdAt: string; expiresAt: string; revokedAt: string | null };

export type PickupAuthority = 'unverified' | 'allowed' | 'denied';
export type Guardian = {
  id: number; displayName: string; relationship: string; phone: string; email: string;
  pickupAuthority: PickupAuthority; authorityNote: string;
};
/** What a shared kiosk may show: no contact details or verification notes. */
export type KioskGuardian = { id: number; displayName: string; relationship: string; pickupAuthority: PickupAuthority };
export type Subject = 'Math' | 'Reading';
export const SUBJECTS: Subject[] = ['Math', 'Reading'];
export type Student = {
  id: number; locationId: number; studentCode: string; firstName: string; lastName: string; displayName: string;
  grade: string; subjects: string[]; pickupAlert: string; active: boolean; revision: number; createdAt: string;
};
export type StudentListItem = Student & { present: boolean; contact: { displayName: string; phone: string; email: string } | null };

export type AttendanceAction = 'check_in' | 'check_out' | 'exceptional_departure';
export type DepartureType = 'check_out' | 'exceptional_departure';
export type ReviewStatus = 'none' | 'pending' | 'resolved';
export type VisitSummary = {
  id: number; locationId: number; studentId: number; studentName: string; studentCode: string; active: boolean;
  checkInAt: string; checkOutAt: string | null; originalCheckInAt: string; originalCheckOutAt: string | null;
  checkInBy: string; checkOutBy: string | null; guardianName: string | null;
  departureType: DepartureType | null; reviewStatus: ReviewStatus; version: number; corrected: boolean;
};
export type AttendanceRequest = { eventId: string; studentId: number; action: AttendanceAction; observedAt: string; guardianId?: number; reason?: string };
export type AttendanceEvent = {
  id: number; requestId: string; studentId: number; visitId: number | null; action: AttendanceAction;
  observedAt: string; receivedAt: string; actorId: number; actorName: string; channel: Channel;
  guardianId: number | null; reason: string | null;
};
export type AttendanceResult = { event: AttendanceEvent; visit: VisitSummary | null; replayed: boolean };
export type Correction = {
  id: number; visitId: number; priorCheckInAt: string; priorCheckOutAt: string | null;
  checkInAt: string; checkOutAt: string | null; reason: string; actorName: string; recordedAt: string;
};
export type CorrectionInput = { correctionId: string; expectedVersion: number; checkInAt: string; checkOutAt: string | null; reason: string };
export type Review = {
  id: number; eventId: number; visitId: number | null; studentId: number; studentName: string; reason: string;
  status: 'pending' | 'resolved'; createdAt: string; resolvedAt: string | null; resolution: string | null;
};

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type StudentDetail = { student: Student; guardians: Guardian[]; visits: VisitSummary[]; corrections: Correction[]; visitTotal: number };
export type KioskStudentDetail = { student: Student; guardians: KioskGuardian[]; openVisit: VisitSummary | null };
export type AdminSession = { business: Business; locations: Location[]; actor: Actor };
export type KioskStatus = {
  enrolled: boolean; location: Location | null; device?: Device; operator?: Actor;
  staff: { id: number; displayName: string }[]; sessionExpiresAt?: string;
};
export type RosterResponse = { items: VisitSummary[]; asOf: string; limit: number; truncated: boolean; revision: number };
export type RosterPollResponse = RosterResponse | { unchanged: true; asOf: string; revision: number };

export type GuardianInput = Omit<Guardian, 'id'>;
export type StudentInput = {
  studentCode: string; firstName: string; lastName: string; grade?: string; active?: boolean;
  subjects?: string[]; pickupAlert?: string; guardians?: GuardianInput[];
};
export type StaffInput = {
  email?: string | null; displayName: string; role: Role; active?: boolean; kioskEnabled?: boolean; pin?: string; locationIds?: number[];
};

export type HistoryRange = { from: string; to: string; timezone: string };
export type AttendanceDay = {
  date: string; visits: number; students: number; closedVisits: number;
  verifiedClosedVisits: number; pendingReviewVisits: number; verifiedMinutes: number;
};
export type AttendanceSummary = {
  range: HistoryRange; asOf: string;
  totals: Omit<AttendanceDay, 'date' | 'students'> & { uniqueStudents: number; averageVerifiedMinutes: number | null };
  days: AttendanceDay[];
  enrollment: { activeStudents: number; inactiveStudents: number; math: number; reading: number; both: number };
};

export type AuditSource = 'admin' | 'attendance' | 'correction';
export type AuditEntry = {
  key: string; actorName: string; action: string; entityType: string; entityId: string;
  recordedAt: string; detail: string; source: AuditSource;
};
export type AuditPage = { items: AuditEntry[]; nextCursor: string | null; range: HistoryRange };

export type BackupJob = {
  id: string; status: 'export' | 'parts' | 'manifest' | 'complete' | 'failed'; reason: 'scheduled' | 'manual';
  createdAt: string; completedAt: string | null; sqlBytes: number | null; parts: number; errorCode: string | null;
};
export type BackupStatus = {
  configured: boolean; enabled: boolean; missing: string[]; backupHour: number; timezone: string;
  lastCompletedAt: string | null; stale: boolean; jobs: BackupJob[];
};

export type ApiError = { error: { code: string; message: string } };
