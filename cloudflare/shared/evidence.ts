/**
 * The eight baseline check-in/check-out requirements franchisees certify each
 * year, summarized in our own words. Each one separates what the software can
 * show from what only the center can attest.
 */
export type RequirementNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type Requirement = { number: RequirementNumber; title: string; summary: string; centerAttests: string };

export const REQUIREMENTS: Requirement[] = [
  { number: 1, title: 'Digital system', summary: 'Check-in and check-out are recorded in a digital system rather than paper, manual logs, or spreadsheets.',
    centerAttests: 'Presently is the center’s primary check-in/check-out method; paper or spreadsheet logs are not the baseline.' },
  { number: 2, title: 'Unique student identification', summary: 'Every student can be uniquely identified in the system.',
    centerAttests: 'Staff identify each student by the student code or name shown in Presently.' },
  { number: 3, title: 'Actual arrival and departure', summary: 'Entries reflect when students actually arrived and left, not records entered later for bookkeeping.',
    centerAttests: 'Staff record arrivals and departures when they happen; late entries are corrected by a manager with a reason.' },
  { number: 4, title: 'Staff oversight and training', summary: 'Staff understand the check-in/check-out process and follow it every day.',
    centerAttests: 'Every staff member who records attendance has been trained on the process this year.' },
  { number: 5, title: 'Current student awareness', summary: 'Staff can see who is present now and review historical attendance when needed.',
    centerAttests: 'Staff know how to open the live roster and attendance history.' },
  { number: 6, title: 'Backup and data preservation', summary: 'Attendance data is preserved, and staff can keep track of attendance if the system is unavailable.',
    centerAttests: 'The center has adopted the written outage procedure and keeps the recovery key safe.' },
  { number: 7, title: 'Handling of student information', summary: 'Student information is protected and limited to what the check-in/check-out workflow needs.',
    centerAttests: 'Only staff who need student information have access, and devices are kept locked when unattended.' },
  { number: 8, title: 'Reviewable and retained records', summary: 'Attendance records can be reviewed when needed and are kept for at least two years.',
    centerAttests: 'The center will not delete attendance records less than two years old and keeps its backups.' },
];

export type SoftwareStatus = 'met' | 'attention';
export type EvidenceFact = { label: string; value: string };
export type Attestation = { confirmed: boolean; note: string; attestedBy: string; attestedAt: string };
export type EvidenceItem = {
  number: RequirementNumber; status: SoftwareStatus; facts: EvidenceFact[]; attention: string[]; attestation: Attestation | null;
};
export type EvidenceReport = {
  year: number; generatedAt: string; generatedBy: string;
  location: { id: number; name: string; timezone: string; address: string };
  business: string; period: { from: string; to: string };
  items: EvidenceItem[];
};
