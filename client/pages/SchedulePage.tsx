import { useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus, Repeat2, Users } from 'lucide-react';
import type { PageProps, Schedule, Subject } from '../../shared/types';
import { mutate } from '../api';
import { Badge, Modal, SubjectTags } from '../components';
import { errorMessage, fullName, localDate } from '../utils';
import { Field, formatSlotTime, PageIntro } from './page-components';

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const timeMinutes = (time: string) => { const [hours, minutes] = time.split(':').map(Number); return hours * 60 + minutes; };
const addDays = (date: Date, daysToAdd: number) => new Date(date.getTime() + daysToAdd * 86400000);

function layOutSlots(slots: Schedule[]) {
  const laneEnds: number[] = [];
  const arranged = slots.sort((a, b) => a.startTime.localeCompare(b.startTime)).map(slot => {
    const start = timeMinutes(slot.startTime);
    let lane = laneEnds.findIndex(end => end <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = start + slot.durationMinutes;
    return { slot, lane };
  });
  return { arranged, lanes: Math.max(laneEnds.length, 1) };
}

export default function SchedulePage({ data, refresh, notify, onStudent }: PageProps) {
  const today = localDate(data.serverTime, data.center.timezone);
  const [offset, setOffset] = useState(0);
  const [subject, setSubject] = useState('all');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ studentId: '', dayOfWeek: 1, startTime: '15:00', durationMinutes: 30, subject: 'Math' as Subject });
  const activeStudents = data.students.filter(student => student.status === 'active');
  const slots = data.schedules.filter(slot => slot.active && (subject === 'all' || slot.subject === subject));
  const week = useMemo(() => {
    const base = new Date(`${today}T12:00:00Z`);
    const monday = addDays(base, -((base.getUTCDay() + 6) % 7) + offset * 7);
    return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  }, [today, offset]);
  const minimumHour = Math.min(12, ...slots.map(slot => Math.floor(timeMinutes(slot.startTime) / 60)));
  const maximumHour = Math.max(19, ...slots.map(slot => Math.ceil((timeMinutes(slot.startTime) + slot.durationMinutes) / 60)));
  const totalMinutes = (maximumHour - minimumHour) * 60;
  const gridHeight = Math.max(560, (maximumHour - minimumHour) * 74);
  const hours = Array.from({ length: maximumHour - minimumHour + 1 }, (_, index) => minimumHour + index);
  const weekLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).formatRange(week[0], week[6]);
  const studentFor = (slot: Schedule) => data.students.find(student => student.id === slot.studentId);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try { await mutate('/schedules', form); await refresh(); setAdding(false); notify('Weekly lesson added to the schedule.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  };
  const cancel = async () => {
    if (!selected) return;
    setSaving(true);
    try { await mutate(`/schedules/${selected.id}`, { active: false }, 'PATCH'); await refresh(); setSelected(null); notify('Recurring lesson removed from the schedule.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  };
  const openAdd = () => { const first = activeStudents[0]; setForm({ studentId: first?.id || '', dayOfWeek: 1, startTime: '15:00', durationMinutes: 30, subject: first?.subjects[0] || 'Math' }); setAdding(true); };

  return <>
    <PageIntro eyebrow="CENTER CALENDAR" title="Make room for progress." description="Your students' recurring weekly lessons, at a glance." action={<button className="btn btn-primary" onClick={openAdd} disabled={!activeStudents.length}><Plus size={17} />Add lesson</button>} />
    <div className="schedule-overview"><div><CalendarDays size={19} /><strong>{data.schedules.filter(slot => slot.active).length}</strong><span>weekly lessons</span></div><div><Users size={19} /><strong>{new Set(data.schedules.filter(slot => slot.active).map(slot => slot.studentId)).size}</strong><span>students scheduled</span></div><div><Repeat2 size={18} /><span>Lessons repeat each week</span></div></div>
    <section className="card calendar-card"><div className="calendar-toolbar"><div className="calendar-date-navigation"><button className="icon-button" aria-label="Previous week" onClick={() => setOffset(current => current - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Next week" onClick={() => setOffset(current => current + 1)}><ChevronRight size={18} /></button><h2>{weekLabel}</h2><button className="btn btn-secondary btn-sm" onClick={() => setOffset(0)}>This week</button></div><select aria-label="Filter lessons by subject" value={subject} onChange={event => setSubject(event.target.value)}><option value="all">All subjects</option><option>Math</option><option>Reading</option></select></div>
      <div className="calendar-scroll"><div className="weekly-calendar"><div className="calendar-week-heading"><div className="calendar-timezone">{new Intl.DateTimeFormat('en-US', { timeZone: data.center.timezone, timeZoneName: 'short' }).formatToParts(new Date(data.serverTime)).find(part => part.type === 'timeZoneName')?.value}</div>{week.map(date => <div key={date.toISOString()} className={`calendar-day-heading ${date.toISOString().slice(0, 10) === today ? 'is-today' : ''}`}><span>{days[date.getUTCDay()].slice(0, 3)}</span><strong>{date.getUTCDate()}</strong></div>)}</div>
        <div className="calendar-body" style={{ height: gridHeight }}><div className="calendar-times">{hours.map(hour => <span key={hour} style={{ top: `${((hour - minimumHour) * 60 / totalMinutes) * 100}%` }}>{hour % 12 || 12} {hour >= 12 ? 'PM' : 'AM'}</span>)}</div>{week.map(date => {
          const { arranged, lanes } = layOutSlots(slots.filter(slot => slot.dayOfWeek === date.getUTCDay()));
          return <div className={`calendar-day ${date.toISOString().slice(0, 10) === today ? 'is-today' : ''}`} key={date.toISOString()}>{hours.map(hour => <div className="calendar-hour-line" key={hour} style={{ top: `${((hour - minimumHour) * 60 / totalMinutes) * 100}%` }} />)}{arranged.map(({ slot, lane }) => {
            const student = studentFor(slot);
            return <button key={slot.id} className={`calendar-lesson ${slot.subject === 'Math' ? 'math' : 'reading'}`} style={{ top: `${((timeMinutes(slot.startTime) - minimumHour * 60) / totalMinutes) * 100}%`, height: Math.max(slot.durationMinutes / totalMinutes * gridHeight - 3, 32), left: `calc(${lane / lanes * 100}% + 4px)`, width: `calc(${100 / lanes}% - 8px)` }} onClick={() => setSelected(slot)} title={`${student ? fullName(student) : 'Student'} · ${slot.subject} · ${formatSlotTime(slot.startTime)} · ${slot.durationMinutes} min`}><strong>{student ? fullName(student) : 'Student'}</strong><span>{formatSlotTime(slot.startTime)} · {slot.subject}</span></button>;
          })}</div>;
        })}</div></div></div><div className="calendar-footer"><span><i className="subject-dot math" />Math</span><span><i className="subject-dot reading" />Reading</span><p>Recurring weekly schedule · {data.center.timezone.replace('_', ' ')}</p></div>
    </section>
    {!activeStudents.length && <p className="page-footnote">Add a student in the directory before creating their lesson schedule.</p>}
    {adding && <Modal title="Add a weekly lesson" subtitle="This time slot will repeat every week until removed." onClose={() => !saving && setAdding(false)}><form onSubmit={save}><div className="form-grid">
      <Field label="Student" wide><select required value={form.studentId} onChange={event => { const student = activeStudents.find(item => item.id === event.target.value); setForm(current => ({ ...current, studentId: event.target.value, subject: student?.subjects[0] || 'Math' })); }}>{activeStudents.map(student => <option key={student.id} value={student.id}>{fullName(student)}</option>)}</select></Field>
      <Field label="Subject"><select value={form.subject} onChange={event => setForm(current => ({ ...current, subject: event.target.value as Subject }))}>{(activeStudents.find(student => student.id === form.studentId)?.subjects || ['Math', 'Reading']).map(item => <option key={item}>{item}</option>)}</select></Field>
      <Field label="Day of the week"><select value={form.dayOfWeek} onChange={event => setForm(current => ({ ...current, dayOfWeek: Number(event.target.value) }))}>{[1, 2, 3, 4, 5, 6, 0].map(day => <option key={day} value={day}>{days[day]}</option>)}</select></Field>
      <Field label="Start time"><input required type="time" value={form.startTime} onChange={event => setForm(current => ({ ...current, startTime: event.target.value }))} /></Field><Field label="Duration"><select value={form.durationMinutes} onChange={event => setForm(current => ({ ...current, durationMinutes: Number(event.target.value) }))}>{[15, 30, 45, 60, 90].map(duration => <option key={duration} value={duration}>{duration} minutes</option>)}</select></Field>
    </div><p className="page-footnote">Lesson times use {data.center.timezone.replace('_', ' ')}.</p><div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Adding lesson...' : 'Add weekly lesson'}</button></div></form></Modal>}
    {selected && <Modal title={studentFor(selected) ? fullName(studentFor(selected)!) : 'Weekly lesson'} subtitle={`${days[selected.dayOfWeek]} · ${formatSlotTime(selected.startTime)}`} onClose={() => !saving && setSelected(null)}><div className="lesson-details"><SubjectTags subjects={[selected.subject]} /><Badge tone="blue">Weekly</Badge><p><Clock3 size={16} />{selected.durationMinutes} minute lesson</p></div><div className="notice-box">Removing this lesson cancels its recurring time slot for every week. Recorded attendance stays in the student's history.</div><div className="modal-actions split"><button type="button" className="btn btn-ghost danger-text" disabled={saving} onClick={cancel}>{saving ? 'Removing...' : 'Remove weekly lesson'}</button><button type="button" className="btn btn-primary" disabled={saving} onClick={() => { const student = studentFor(selected); if (student) { setSelected(null); onStudent(student); } }}>View student</button></div></Modal>}
  </>;
}
