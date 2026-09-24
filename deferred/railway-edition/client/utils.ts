import type { Student, Bootstrap } from '../shared/types';
export const fullName = (student: Student) => `${student.firstName} ${student.lastName}`;
export const initials = (name: string) => name.trim().split(/\s+/).map(n=>n[0]).slice(0,2).join('').toUpperCase();
export const shortTime = (value: string, zone = 'America/Los_Angeles') => new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:zone}).format(new Date(value));
export const dateLabel = (value: string, zone = 'America/Los_Angeles') => new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:zone}).format(new Date(value));
export const localDate = (value: string | Date, zone = 'America/Los_Angeles') => new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:zone}).format(new Date(value));
export const todayVisits = (data: Bootstrap) => data.visits.filter(v=>localDate(v.checkedInAt,data.center.timezone)===localDate(new Date(),data.center.timezone));
export const openVisit = (data: Bootstrap, id: string) => data.visits.find(v=>v.studentId===id && v.status==='open');
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
