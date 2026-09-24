import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Subject } from '../../shared/types';

export function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="muted">{description}</p></div>{action && <div className="page-heading-action">{action}</div>}</div>;
}

export function Metric({ label, value, detail, icon: Icon, tone = 'blue' }: { label: string; value: ReactNode; detail: string; icon: LucideIcon; tone?: string }) {
  return <div className="card page-metric"><div><span className="page-metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></div><span className={`page-metric-icon ${tone}`}><Icon size={20} /></span></div>;
}

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`field${wide ? ' field-wide' : ''}`}><span>{label}</span>{children}</label>;
}

export function SubjectChoice({ value, onChange }: { value: Subject[]; onChange: (value: Subject[]) => void }) {
  return <div className="subject-choice">{(['Math', 'Reading'] as Subject[]).map(subject => <label className={value.includes(subject) ? 'selected' : ''} key={subject}><input type="checkbox" checked={value.includes(subject)} onChange={event => onChange(event.target.checked ? [...value, subject] : value.filter(item => item !== subject))} />{subject}</label>)}</div>;
}

export function formatSlotTime(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
}

export function centerDateToIso(day: string, timeZone: string) {
  const target = new Date(`${day}T12:00:00Z`).getTime();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(target));
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === name)?.value);
  const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return new Date(target - (localAsUtc - target)).toISOString();
}
