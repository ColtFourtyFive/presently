import { useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, Mail, MessageCircle, Phone, Plus, Search, UserPlus } from 'lucide-react';
import type { Inquiry, InquiryInput, InquiryStage, PageProps } from '../../shared/types';
import { mutate } from '../api';
import { Avatar, Badge, EmptyState, Modal, SubjectTags } from '../components';
import { dateLabel, errorMessage, localDate } from '../utils';
import { centerDateToIso, Field, PageIntro, SubjectChoice } from './page-components';

const activeStages: InquiryStage[] = ['New', 'Contacted', 'Assessment scheduled', 'Assessment completed'];
const allStages: InquiryStage[] = [...activeStages, 'Enrolled', 'Closed lost', 'Do not contact'];
const emptyInquiry: InquiryInput = { contactName: '', studentName: '', email: '', phone: '', subjects: ['Math'], source: 'Website', nextAction: '', dueAt: '', notes: '' };
const stageColors = ['blue', 'purple', 'amber', 'green'];

export default function InquiriesPage({ data, refresh, notify, onStudent }: PageProps) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState('active');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Inquiry | null>(null);
  const [form, setForm] = useState<InquiryInput>({ ...emptyInquiry });
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState({ stage: 'New' as InquiryStage, nextAction: '', dueAt: '', notes: '' });
  const visible = data.inquiries.filter(inquiry => `${inquiry.contactName} ${inquiry.studentName} ${inquiry.email} ${inquiry.phone}`.toLowerCase().includes(query.toLowerCase().trim()));
  const activeCount = data.inquiries.filter(inquiry => activeStages.includes(inquiry.stage)).length;
  const closed = visible.filter(inquiry => !activeStages.includes(inquiry.stage));
  const openInquiry = (inquiry: Inquiry) => { setSelected(inquiry); setEdit({ stage: inquiry.stage, nextAction: inquiry.nextAction, dueAt: inquiry.dueAt ? localDate(inquiry.dueAt, data.center.timezone) : '', notes: inquiry.notes }); };
  const saveNew = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.subjects.length) return notify('Choose at least one subject.', 'error');
    setSaving(true);
    try { await mutate('/inquiries', { ...form, dueAt: form.dueAt ? centerDateToIso(form.dueAt, data.center.timezone) : undefined }); await refresh(); setAdding(false); setForm({ ...emptyInquiry }); notify('Inquiry added to the pipeline.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  };
  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    try { await mutate(`/inquiries/${selected.id}`, { ...edit, dueAt: edit.dueAt ? centerDateToIso(edit.dueAt, data.center.timezone) : null }, 'PATCH'); await refresh(); setSelected(null); notify('Inquiry updated.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  };
  const convert = async () => {
    if (!selected) return;
    setSaving(true);
    try { await mutate(`/inquiries/${selected.id}/convert`, {}); await refresh(); setSelected(null); notify('Student enrolled. Their profile is now in the student directory.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  };
  const update = (key: keyof InquiryInput, value: string) => setForm(current => ({ ...current, [key]: value }));

  return <>
    <PageIntro eyebrow="FAMILY RELATIONSHIPS" title="A thoughtful first step." description="Follow every family's journey from first hello to their first lesson." action={<button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={17} />New inquiry</button>} />
    <div className="pipeline-summary"><div><span className="pipeline-summary-icon"><MessageCircle size={21} /></span><strong>{activeCount}</strong><span>active inquiries</span></div><div><span className="pipeline-summary-icon green"><Check size={20} /></span><strong>{data.inquiries.filter(inquiry => inquiry.stage === 'Enrolled').length}</strong><span>converted to enrollment</span></div><p>A clear next step keeps the conversation moving.</p></div>
    <div className="pipeline-toolbar"><div className="tabs"><button className={`tab ${view === 'active' ? 'active' : ''}`} onClick={() => setView('active')}>Active pipeline <span>{activeCount}</span></button><button className={`tab ${view === 'closed' ? 'active' : ''}`} onClick={() => setView('closed')}>Enrolled & closed</button></div><div className="search-input"><Search size={17} /><input aria-label="Search inquiries" placeholder="Find a family..." value={query} onChange={event => setQuery(event.target.value)} /></div></div>
    {view === 'active' ? <div className="pipeline-board">{activeStages.map((stage, index) => {
      const inquiries = visible.filter(inquiry => inquiry.stage === stage).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return <section className={`pipeline-column pipeline-${stageColors[index]}`} key={stage}><div className="pipeline-column-heading"><span className="stage-dot" /><h2>{stage}</h2><span className="pipeline-count">{inquiries.length}</span></div><div className="pipeline-cards">{inquiries.map(inquiry => <button className="card inquiry-card" key={inquiry.id} onClick={() => openInquiry(inquiry)}>
        <div className="inquiry-source"><span>{inquiry.source || 'Source not recorded'}</span><ArrowRight size={15} /></div><h3>{inquiry.studentName || inquiry.contactName}</h3><p>{inquiry.contactName}{inquiry.studentName ? ' · Parent / guardian' : ''}</p><SubjectTags subjects={inquiry.subjects} />
        <div className="inquiry-next-action"><span>NEXT STEP</span><p>{inquiry.nextAction || 'Add a next step'}</p></div><div className="inquiry-card-footer"><span className={inquiry.dueAt && localDate(inquiry.dueAt, data.center.timezone) < localDate(data.serverTime, data.center.timezone) ? 'due-overdue' : ''}><CalendarDays size={13} />{inquiry.dueAt ? dateLabel(inquiry.dueAt, data.center.timezone) : 'No due date'}</span><Avatar name={inquiry.ownerName || 'Unassigned'} size="sm" /></div>
      </button>)}{!inquiries.length && <div className="pipeline-empty"><span>No inquiries here</span><small>{query ? 'Try a different search.' : index === 0 ? 'New families will appear here.' : 'Move an inquiry here when it is ready.'}</small></div>}</div></section>;
    })}</div> : <section className="card">{closed.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Family</th><th>Subjects</th><th>Outcome</th><th>Source</th><th>Created</th></tr></thead><tbody>{closed.map(inquiry => <tr key={inquiry.id}><td><button className="student-name-button" onClick={() => openInquiry(inquiry)}><Avatar name={inquiry.studentName || inquiry.contactName} /><span><strong>{inquiry.studentName || inquiry.contactName}</strong><small>{inquiry.contactName}</small></span></button></td><td><SubjectTags subjects={inquiry.subjects} /></td><td><Badge tone={inquiry.stage === 'Enrolled' ? 'green' : 'gray'}>{inquiry.stage}</Badge></td><td>{inquiry.source}</td><td>{dateLabel(inquiry.createdAt, data.center.timezone)}</td></tr>)}</tbody></table></div> : <EmptyState icon={UserPlus} title="No completed inquiries yet" description="Enrolled families and closed inquiries will appear here." />}</section>}
    <p className="page-footnote">Open a family card to record notes, update the next step, or enroll a student.</p>
    {adding && <Modal title="Welcome a new family" subtitle="Capture their interest and give the conversation a next step." onClose={() => !saving && setAdding(false)} wide><form onSubmit={saveNew}><div className="form-grid">
      <Field label="Parent or guardian name"><input required maxLength={120} autoFocus value={form.contactName} onChange={event => update('contactName', event.target.value)} /></Field><Field label="Student name"><input required maxLength={120} value={form.studentName} onChange={event => update('studentName', event.target.value)} /></Field>
      <Field label="Email address"><input type="email" value={form.email} onChange={event => update('email', event.target.value)} /></Field><Field label="Phone number"><input type="tel" maxLength={40} required value={form.phone} onChange={event => update('phone', event.target.value)} /></Field>
      <Field label="Interested in"><SubjectChoice value={form.subjects} onChange={subjects => setForm(current => ({ ...current, subjects }))} /></Field><Field label="How they found us"><select value={form.source} onChange={event => update('source', event.target.value)}>{['Website', 'Walk-in', 'Phone', 'Referral', 'Community event', 'Other'].map(source => <option key={source}>{source}</option>)}</select></Field>
      <Field label="Next step"><input required maxLength={300} placeholder="e.g. Call to arrange an assessment" value={form.nextAction} onChange={event => update('nextAction', event.target.value)} /></Field><Field label="Follow-up date"><input type="date" value={form.dueAt} onChange={event => update('dueAt', event.target.value)} /></Field>
      <Field label="Notes" wide><textarea rows={3} maxLength={2000} placeholder="What would be useful for the next conversation?" value={form.notes} onChange={event => update('notes', event.target.value)} /></Field>
    </div><div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Adding inquiry...' : 'Add inquiry'}</button></div></form></Modal>}
    {selected && <Modal title={selected.studentName || selected.contactName} subtitle={`Family inquiry · ${selected.source || 'Source not recorded'}`} onClose={() => !saving && setSelected(null)} wide><div className="inquiry-contact-strip"><Avatar name={selected.contactName} /><div><strong>{selected.contactName}</strong><span>{selected.email && <a href={`mailto:${selected.email}`}><Mail size={13} />{selected.email}</a>}{selected.phone && <a href={`tel:${selected.phone}`}><Phone size={13} />{selected.phone}</a>}</span></div></div><form onSubmit={saveEdit}><div className="form-grid">
      <Field label="Pipeline stage"><select disabled={selected.stage === 'Enrolled'} value={edit.stage} onChange={event => setEdit(current => ({ ...current, stage: event.target.value as InquiryStage }))}>{allStages.filter(stage => stage !== 'Enrolled' || selected.stage === 'Enrolled').map(stage => <option key={stage}>{stage}</option>)}</select></Field>
      <Field label="Follow-up date"><input type="date" value={edit.dueAt} onChange={event => setEdit(current => ({ ...current, dueAt: event.target.value }))} /></Field>
      <Field label="Next step" wide><input maxLength={300} value={edit.nextAction} onChange={event => setEdit(current => ({ ...current, nextAction: event.target.value }))} /></Field><Field label="Conversation notes" wide><textarea rows={4} maxLength={2000} value={edit.notes} onChange={event => setEdit(current => ({ ...current, notes: event.target.value }))} /></Field>
    </div><div className="modal-actions inquiry-actions">{selected.convertedStudentId ? <button type="button" className="btn btn-secondary" onClick={() => { const student = data.students.find(item => item.id === selected.convertedStudentId); if (student) { setSelected(null); onStudent(student); } }}>View student<ArrowRight size={15} /></button> : selected.stage !== 'Do not contact' && selected.stage !== 'Closed lost' ? <button type="button" className="btn btn-secondary" disabled={saving} onClick={convert}><UserPlus size={16} />Enroll student</button> : <span /> }<button className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</button></div></form>{!selected.convertedStudentId && <p className="page-footnote">Enrollment creates a student profile using this family's saved contact details and subjects.</p>}</Modal>}
  </>;
}
