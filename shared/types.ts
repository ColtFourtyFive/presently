export type Subject = 'Math' | 'Reading';
export type Role = 'owner' | 'manager' | 'front_desk' | 'instructor';
export type Page = 'today' | 'students' | 'imports' | 'inquiries' | 'schedule' | 'reports' | 'settings';
export interface Staff { id: string; name: string; email: string; role: Role }
export interface Center { id: string; name: string; timezone: string; location: string; operatingHours: string }
export interface Guardian { id: string; name: string; relationship: string; email: string; phone: string; canPickup: boolean }
export interface Student { id: string; studentNumber: string; firstName: string; lastName: string; grade: string; subjects: Subject[]; status: 'active' | 'inactive'; guardians: Guardian[]; pickupAlert: string; createdAt: string }
export interface Schedule { id: string; studentId: string; dayOfWeek: number; startTime: string; durationMinutes: number; subject: Subject; active: boolean }
export interface Visit { id: string; studentId: string; checkedInAt: string; checkedOutAt: string | null; status: 'open' | 'closed'; releaseBasis: string | null; reconciliationStatus: 'clear' | 'review_needed' }
export interface AttendanceEvent { id: string; studentId: string; visitId: string | null; action: 'check_in' | 'check_out' | 'exceptional_departure'; occurredAt: string; receivedAt: string; actorName: string; reason: string | null; captureMode: string }
export interface AttendanceCorrection { id: string; eventId: string; originalOccurredAt: string; correctedOccurredAt: string; reason: string; actorName: string; createdAt: string }
export type InquiryStage = 'New' | 'Contacted' | 'Assessment scheduled' | 'Assessment completed' | 'Enrolled' | 'Closed lost' | 'Do not contact';
export interface Inquiry { id: string; contactName: string; studentName: string; email: string; phone: string; subjects: Subject[]; stage: InquiryStage; source: string; ownerName: string; nextAction: string; dueAt: string | null; notes: string; createdAt: string; convertedStudentId: string | null }
export interface Task { id: string; title: string; detail: string; dueAt: string; completedAt: string | null; type: 'follow_up' | 'assessment' | 'operations'; inquiryId: string | null }
export interface Incident { id: string; studentId: string; visitId: string | null; type: string; summary: string; status: 'open' | 'resolved'; createdAt: string; resolvedAt: string | null }
export interface AuditEntry { id: string; actorName: string; action: string; entityId: string; detail: string; createdAt: string }
export interface Interaction { id: string; studentId: string; channel: 'Phone' | 'Email' | 'Meeting' | 'Other'; summary: string; actorName: string; occurredAt: string }
export interface Bootstrap { center: Center; user: Staff; students: Student[]; schedules: Schedule[]; visits: Visit[]; events: AttendanceEvent[]; corrections?: AttendanceCorrection[]; inquiries: Inquiry[]; tasks: Task[]; incidents: Incident[]; audit: AuditEntry[]; interactions: Interaction[]; serverTime: string; demo: boolean }
export interface LiveAttendance { centerId: string; user: Staff; from: string; serverTime: string; complete: boolean; visits: Visit[]; events: AttendanceEvent[]; incidents: Incident[]; corrections: AttendanceCorrection[] }
export interface StudentInput { firstName: string; lastName: string; grade: string; subjects: Subject[]; guardianName: string; guardianEmail: string; guardianPhone: string; pickupAlert?: string }
export interface InquiryInput { contactName: string; studentName: string; email: string; phone: string; subjects: Subject[]; source: string; nextAction: string; dueAt?: string; notes?: string }
export interface AttendanceInput { eventId: string; studentId: string; action: AttendanceEvent['action']; guardianId?: string; reason?: string }
export interface PageProps { data: Bootstrap; refresh: () => Promise<void>; notify: (message: string, kind?: 'success' | 'error') => void; onStudent: (student: Student) => void }
