import { useMemo, useState, type FormEvent } from 'react';
import { ArrowUpRight, BookOpen, GraduationCap, Plus, Search, Users, FileUp } from 'lucide-react';
import type { PageProps, StudentInput, Subject } from '../../shared/types';
import { mutate } from '../api';
import { Avatar, Badge, EmptyState, Modal, SubjectTags } from '../components';
import { errorMessage, fullName } from '../utils';
import { Field, Metric, PageIntro, SubjectChoice } from './page-components';

const blankStudent: StudentInput = { firstName: '', lastName: '', grade: '', subjects: ['Math'], guardianName: '', guardianEmail: '', guardianPhone: '', pickupAlert: '' };

export default function StudentsPage({ data, refresh, notify, onStudent, onImport }: PageProps & { onImport: () => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [subject, setSubject] = useState('all');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<StudentInput>({ ...blankStudent });
  const [saving, setSaving] = useState(false);
  const active = data.students.filter(student => student.status === 'active');
  const students = useMemo(() => data.students.filter(student => {
    const searchable = `${fullName(student)} ${student.studentNumber} ${student.guardians.map(guardian => `${guardian.name} ${guardian.email} ${guardian.phone}`).join(' ')}`.toLowerCase();
    return searchable.includes(query.toLowerCase().trim()) && (status === 'all' || student.status === status) && (subject === 'all' || student.subjects.includes(subject as Subject));
  }).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)), [data.students, query, status, subject]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.subjects.length) return notify('Choose at least one subject.', 'error');
    setSaving(true);
    try { await mutate('/students', form); await refresh(); setAdding(false); setForm({ ...blankStudent }); notify('Student added.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  };
  const update = (key: keyof StudentInput, value: string) => setForm(current => ({ ...current, [key]: value }));

  return <>
    <PageIntro eyebrow="STUDENT DIRECTORY" title="Every student. One place." description="Keep families, subjects, and the details that matter connected." action={<>{['owner', 'manager'].includes(data.user.role) && <button className="btn btn-secondary" onClick={onImport}><FileUp size={17} />Import roster</button>}<button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={17} />Add student</button></>} />
    <div className="page-metrics three student-metrics">
      <Metric label="Active students" value={active.length} detail="Currently enrolled at your center" icon={Users} />
      <Metric label="Math enrollments" value={active.filter(student => student.subjects.includes('Math')).length} detail="Active students studying math" icon={GraduationCap} tone="purple" />
      <Metric label="Reading enrollments" value={active.filter(student => student.subjects.includes('Reading')).length} detail="Active students studying reading" icon={BookOpen} tone="green" />
    </div>
    <section className="card directory-card">
      <div className="card-header"><div><h2>Your students <span className="count-pill">{students.length}</span></h2><p className="muted">A little more context for every interaction.</p></div></div>
      <div className="toolbar directory-toolbar">
        <div className="search-input"><Search size={17} /><input aria-label="Search students" placeholder="Search students or guardians..." value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="filter-group"><select aria-label="Filter by subject" value={subject} onChange={event => setSubject(event.target.value)}><option value="all">All subjects</option><option>Math</option><option>Reading</option></select><select aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value)}><option value="active">Active students</option><option value="inactive">Inactive students</option><option value="all">All statuses</option></select></div>
      </div>
      {students.length ? <div className="table-wrap"><table className="data-table student-table" role="table"><thead><tr><th>Student</th><th>Subjects</th><th>Grade</th><th>Primary contact</th><th>Status</th><th><span className="sr-only">Open profile</span></th></tr></thead><tbody>{students.map(student => <tr key={student.id}>
        <td data-label="Student"><button className="student-name-button" onClick={() => onStudent(student)}><Avatar name={fullName(student)} /><span><strong>{fullName(student)}</strong><small>{student.studentNumber}</small></span></button></td>
        <td data-label="Subjects"><SubjectTags subjects={student.subjects} /></td><td data-label="Grade"><span className="muted">{student.grade || 'Not recorded'}</span></td>
        <td data-label="Primary contact"><span className="table-text-stack"><strong>{student.guardians[0]?.name || 'No guardian recorded'}</strong><small>{student.guardians[0]?.phone || student.guardians[0]?.email || 'Add contact details'}</small></span></td>
        <td data-label="Status"><Badge tone={student.status === 'active' ? 'green' : 'gray'}>{student.status === 'active' ? 'Active' : 'Inactive'}</Badge></td>
        <td><button className="icon-button" title={`Open ${fullName(student)}'s profile`} onClick={() => onStudent(student)}><ArrowUpRight size={18} /></button></td>
      </tr>)}</tbody></table></div> : <EmptyState icon={Users} title="No students found" description={query || subject !== 'all' ? 'Try another name or change your filters.' : 'Add your first student to start building your center directory.'} action={<button className="btn btn-secondary" onClick={() => setAdding(true)}><Plus size={16} />Add student</button>} />}
      <div className="table-footer">{students.length} {students.length === 1 ? 'student' : 'students'} shown<span>Subject totals count enrollments, so a student may appear in both.</span></div>
    </section>
    {adding && <Modal title="Add a student" subtitle="Start with student and guardian details. You can add a schedule from the calendar." onClose={() => !saving && setAdding(false)} wide><form onSubmit={save}><div className="form-grid">
      <Field label="First name"><input required maxLength={80} value={form.firstName} onChange={event => update('firstName', event.target.value)} autoFocus /></Field>
      <Field label="Last name"><input required maxLength={80} value={form.lastName} onChange={event => update('lastName', event.target.value)} /></Field>
      <Field label="Grade"><input required placeholder="e.g. Grade 3" maxLength={30} value={form.grade} onChange={event => update('grade', event.target.value)} /></Field>
      <Field label="Subjects"><SubjectChoice value={form.subjects} onChange={subjects => setForm(current => ({ ...current, subjects }))} /></Field>
      <div className="form-section-label">Parent or guardian</div>
      <Field label="Guardian name" wide><input required maxLength={120} value={form.guardianName} onChange={event => update('guardianName', event.target.value)} /></Field>
      <Field label="Email address"><input type="email" value={form.guardianEmail} onChange={event => update('guardianEmail', event.target.value)} /></Field>
      <Field label="Phone number"><input type="tel" maxLength={40} required value={form.guardianPhone} onChange={event => update('guardianPhone', event.target.value)} /></Field>
      <Field label="Pickup note" wide><textarea rows={2} placeholder="Any instructions staff should see before release" maxLength={500} value={form.pickupAlert} onChange={event => update('pickupAlert', event.target.value)} /></Field>
    </div><div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setAdding(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding student...' : 'Add student'}</button></div></form></Modal>}
  </>;
}
