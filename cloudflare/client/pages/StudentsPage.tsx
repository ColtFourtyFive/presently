import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { History, LogIn, Pencil, Plus, ShieldAlert, Trash2, UserPlus, Users } from 'lucide-react';
import type {
  Correction, Guardian, GuardianInput, Location, Page, PickupAuthority, Student, StudentDetail, StudentInput,
  StudentListItem, Subject, VisitSummary,
} from '../../shared/types';
import { SUBJECTS } from '../../shared/types';
import type { PageProps } from '../App';
import { RequestError, messageOf, type Api } from '../api';
import { AttendanceSheet } from '../attendance';
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Pager, Spinner } from '../components';
import { formatDateTime, formatDuration, formatTime, isoToZonedInput, newRequestId, zonedInputToIso } from '../format';
import './roster.css';

const PAGE_SIZE = 25;
const VISIT_PAGE_SIZE = 10;
const MAX_NEW_GUARDIANS = 2;

type StatusFilter = 'active' | 'inactive' | 'all';
type SubjectFilter = 'all' | Subject;
type Detail = StudentDetail & { page: number };
type Notice = { tone: 'success' | 'warning' | 'info'; text: string } | null;

type StudentDraft = {
  studentCode: string;
  firstName: string;
  lastName: string;
  grade: string;
  subjects: string[];
  pickupAlert: string;
  active: boolean;
};

const EMPTY_STUDENT: StudentDraft = { studentCode: '', firstName: '', lastName: '', grade: '', subjects: [], pickupAlert: '', active: true };
const EMPTY_GUARDIAN: GuardianInput = {
  displayName: '', relationship: '', phone: '', email: '', pickupAuthority: 'unverified', authorityNote: '',
};

const AUTHORITY: Record<PickupAuthority, { label: string; option: string; tone: 'green' | 'amber' | 'red' }> = {
  allowed: { label: 'Pickup allowed', option: 'Allowed to pick up (verified)', tone: 'green' },
  unverified: { label: 'Pickup not verified', option: 'Not verified yet', tone: 'amber' },
  denied: { label: 'Pickup denied', option: 'Not allowed to pick up', tone: 'red' },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function draftOf(student: Student): StudentDraft {
  return {
    studentCode: student.studentCode,
    firstName: student.firstName,
    lastName: student.lastName,
    grade: student.grade,
    subjects: [...student.subjects],
    pickupAlert: student.pickupAlert,
    active: student.active,
  };
}

function studentProblem(draft: StudentDraft): string | null {
  if (!draft.firstName.trim() || !draft.lastName.trim()) return 'Enter the student’s first and last name.';
  if (!draft.studentCode.trim()) return 'Enter a student code. It keeps records matched across imports.';
  if (draft.studentCode.trim().length > 60) return 'Student code must be at most 60 characters.';
  if (draft.firstName.trim().length > 100 || draft.lastName.trim().length > 100) return 'Names must be at most 100 characters.';
  if (draft.grade.trim().length > 30) return 'Grade must be at most 30 characters.';
  if (draft.pickupAlert.trim().length > 1000) return 'Pickup alert must be at most 1,000 characters.';
  return null;
}

function guardianProblem(guardian: GuardianInput): string | null {
  if (!guardian.displayName.trim()) return 'Enter the guardian’s name.';
  if (guardian.email.trim() && !EMAIL_PATTERN.test(guardian.email.trim())) return 'Guardian email is not valid.';
  if (guardian.pickupAuthority === 'allowed' && guardian.authorityNote.trim().length < 5)
    return 'Record how pickup authority was verified (at least 5 characters).';
  return null;
}

function trimGuardian(guardian: GuardianInput): GuardianInput {
  return {
    displayName: guardian.displayName.trim(),
    relationship: guardian.relationship.trim(),
    phone: guardian.phone.trim(),
    email: guardian.email.trim(),
    pickupAuthority: guardian.pickupAuthority,
    authorityNote: guardian.authorityNote.trim(),
  };
}

/** Only the fields the manager actually changed, so concurrent edits to other fields are not overwritten. */
function changedStudentFields(student: Student, draft: StudentDraft): Partial<StudentInput> {
  const changes: Partial<StudentInput> = {};
  if (draft.studentCode.trim() !== student.studentCode) changes.studentCode = draft.studentCode.trim();
  if (draft.firstName.trim() !== student.firstName) changes.firstName = draft.firstName.trim();
  if (draft.lastName.trim() !== student.lastName) changes.lastName = draft.lastName.trim();
  if (draft.grade.trim() !== student.grade) changes.grade = draft.grade.trim();
  if (draft.pickupAlert.trim() !== student.pickupAlert) changes.pickupAlert = draft.pickupAlert.trim();
  if (draft.active !== student.active) changes.active = draft.active;
  const sorted = (list: string[]) => [...list].sort().join('\n');
  if (sorted(draft.subjects) !== sorted(student.subjects)) changes.subjects = draft.subjects;
  return changes;
}

function changedGuardianFields(guardian: Guardian, draft: GuardianInput): Partial<GuardianInput> {
  const changes: Partial<GuardianInput> = {};
  const next = trimGuardian(draft);
  for (const key of Object.keys(next) as (keyof GuardianInput)[]) {
    if (next[key] !== guardian[key]) Object.assign(changes, { [key]: next[key] });
  }
  return changes;
}

function uncertainMessage(error: unknown, fallback: string) {
  return error instanceof RequestError && error.uncertain ? fallback : messageOf(error);
}

// ---------------------------------------------------------------------------
// Roster list
// ---------------------------------------------------------------------------

export default function StudentsPage({ api, session, location }: PageProps) {
  const role = session.actor.role;
  const canEdit = role === 'owner' || role === 'manager';
  const canOpen = role !== 'instructor';
  const showContacts = role !== 'instructor';

  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [subject, setSubject] = useState<SubjectFilter>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<StudentListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Wait for typing to pause before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ q, status, subject, page: String(page), pageSize: String(PAGE_SIZE) });
    api.get<Page<StudentListItem>>(`/students?${params}`, controller.signal)
      .then(value => {
        setData(value);
        setError('');
      })
      .catch(e => {
        if (!controller.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, q, status, subject, page, refreshKey]);

  const refresh = useCallback(() => setRefreshKey(key => key + 1), []);
  const filtered = q !== '' || status !== 'active' || subject !== 'all';

  return (
    <div className="content">
      <PageHeader
        title="Roster"
        description={`Students enrolled at ${location.name}.`}
        actions={canEdit && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <UserPlus size={18} aria-hidden="true" /> Add student
          </Button>
        )}
      />

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <div className="toolbar" role="search">
        <Field label="Search">
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={showContacts ? 'Name, code, or guardian' : 'Name or code'}
            maxLength={100}
          />
        </Field>
        <Field label="Status">
          <select
            value={status}
            onChange={e => {
              setStatus(e.target.value as StatusFilter);
              setPage(1);
            }}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All students</option>
          </select>
        </Field>
        <Field label="Subject">
          <select
            value={subject}
            onChange={e => {
              setSubject(e.target.value as SubjectFilter);
              setPage(1);
            }}
          >
            <option value="all">All subjects</option>
            {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      <Alert>{error}</Alert>

      <Card>
        {!data && loading && <Spinner label="Loading roster" />}
        {data && data.items.length === 0 && (
          <EmptyState icon={Users} title={filtered ? 'No students match' : 'No students yet'}>
            <p>
              {filtered
                ? 'Try a different search or filter.'
                : canEdit ? 'Add a student or import a roster CSV to get started.' : 'Ask a manager to add students.'}
            </p>
          </EmptyState>
        )}
        {data && data.items.length > 0 && (
          <>
            <div className="table-wrap" aria-busy={loading || undefined}>
              <table>
                <caption className="visually-hidden">
                  Students, page {data.page}. {canOpen ? 'Select a name to open the profile.' : ''}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Code</th>
                    <th scope="col">Grade</th>
                    <th scope="col">Subjects</th>
                    {showContacts && <th scope="col">Primary contact</th>}
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map(student => (
                    <tr
                      key={student.id}
                      className={canOpen ? 'clickable' : undefined}
                      onClick={canOpen ? () => setOpenId(student.id) : undefined}
                    >
                      <td>
                        {canOpen
                          ? (
                            <button
                              type="button"
                              className="link-button"
                              onClick={event => {
                                event.stopPropagation();
                                setOpenId(student.id);
                              }}
                            >
                              {student.displayName}
                            </button>
                          )
                          : <strong>{student.displayName}</strong>}
                      </td>
                      <td>{student.studentCode}</td>
                      <td>{student.grade || '—'}</td>
                      <td>{student.subjects.length ? student.subjects.join(', ') : '—'}</td>
                      {showContacts && (
                        <td>
                          {student.contact
                            ? (
                              <>
                                {student.contact.displayName}
                                {student.contact.phone && <span className="cell-sub">{student.contact.phone}</span>}
                                {student.contact.email && <span className="cell-sub">{student.contact.email}</span>}
                              </>
                            )
                            : <span className="muted">None on file</span>}
                        </td>
                      )}
                      <td>
                        <span className="badge-list">
                          {student.present && <Badge tone="green">Present</Badge>}
                          {!student.active && <Badge>Inactive</Badge>}
                          {student.pickupAlert && <Badge tone="red">Pickup alert</Badge>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">{data.total} {data.total === 1 ? 'student' : 'students'}</span>
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </div>
          </>
        )}
      </Card>

      {openId !== null && (
        <StudentProfile
          api={api}
          location={location}
          studentId={openId}
          canEdit={canEdit}
          canRecord={canOpen}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}

      {adding && (
        <AddStudentModal
          api={api}
          onClose={() => setAdding(false)}
          onCreated={(student, warning) => {
            setAdding(false);
            setNotice(warning
              ? { tone: 'warning', text: warning }
              : { tone: 'success', text: `${student.displayName} was added to the roster.` });
            refresh();
            setOpenId(student.id);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared form fields
// ---------------------------------------------------------------------------

function StudentFields({ value, onChange, showActive }: {
  value: StudentDraft;
  onChange: (value: StudentDraft) => void;
  showActive: boolean;
}) {
  const set = <K extends keyof StudentDraft>(key: K, next: StudentDraft[K]) => onChange({ ...value, [key]: next });
  const otherSubjects = value.subjects.filter(s => !SUBJECTS.includes(s as Subject));
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="First name">
          <input value={value.firstName} onChange={e => set('firstName', e.target.value)} maxLength={100} required autoComplete="off" />
        </Field>
        <Field label="Last name">
          <input value={value.lastName} onChange={e => set('lastName', e.target.value)} maxLength={100} required autoComplete="off" />
        </Field>
        <Field label="Student code" hint="A stable code from your center’s records. Imports match students by this code.">
          <input value={value.studentCode} onChange={e => set('studentCode', e.target.value)} maxLength={60} required autoComplete="off" />
        </Field>
        <Field label="Grade">
          <input value={value.grade} onChange={e => set('grade', e.target.value)} maxLength={30} autoComplete="off" />
        </Field>
      </div>
      <fieldset>
        <legend>Subjects</legend>
        <div className="row">
          {SUBJECTS.map(s => (
            <label key={s} className="checkbox">
              <input
                type="checkbox"
                checked={value.subjects.includes(s)}
                onChange={e => set('subjects', e.target.checked ? [...value.subjects, s] : value.subjects.filter(x => x !== s))}
              />
              {s}
            </label>
          ))}
        </div>
        {otherSubjects.length > 0 && <p className="muted small">Also listed from an import: {otherSubjects.join(', ')}. These are kept.</p>}
      </fieldset>
      <Field
        label="Pickup alert"
        hint="Shown to staff before every departure. While set, normal checkout is blocked. Leave empty if there is none."
      >
        <textarea rows={3} value={value.pickupAlert} onChange={e => set('pickupAlert', e.target.value)} maxLength={1000} />
      </Field>
      {showActive && (
        <label className="checkbox">
          <input type="checkbox" checked={value.active} onChange={e => set('active', e.target.checked)} />
          Active (can be checked in)
        </label>
      )}
    </div>
  );
}

function GuardianFields({ value, onChange }: { value: GuardianInput; onChange: (value: GuardianInput) => void }) {
  const set = <K extends keyof GuardianInput>(key: K, next: GuardianInput[K]) => onChange({ ...value, [key]: next });
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="Name">
          <input value={value.displayName} onChange={e => set('displayName', e.target.value)} maxLength={150} required autoComplete="off" />
        </Field>
        <Field label="Relationship" hint="For example: Mother, Grandfather, Nanny.">
          <input value={value.relationship} onChange={e => set('relationship', e.target.value)} maxLength={100} autoComplete="off" />
        </Field>
        <Field label="Phone">
          <input type="tel" value={value.phone} onChange={e => set('phone', e.target.value)} maxLength={50} autoComplete="off" />
        </Field>
        <Field label="Email">
          <input type="email" value={value.email} onChange={e => set('email', e.target.value)} maxLength={200} autoComplete="off" />
        </Field>
      </div>
      <Field label="Pickup authority" hint="Only verified guardians can be chosen at checkout.">
        <select value={value.pickupAuthority} onChange={e => set('pickupAuthority', e.target.value as PickupAuthority)}>
          {(Object.keys(AUTHORITY) as PickupAuthority[]).map(key => (
            <option key={key} value={key}>{AUTHORITY[key].option}</option>
          ))}
        </select>
      </Field>
      <Field
        label="Verification note"
        hint={value.pickupAuthority === 'allowed'
          ? 'Required: how authority was verified, for example “Photo ID checked against enrollment form”.'
          : 'Optional context, such as a custody order on file.'}
      >
        <textarea rows={2} value={value.authorityNote} onChange={e => set('authorityNote', e.target.value)} maxLength={1000} />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add student
// ---------------------------------------------------------------------------

function AddStudentModal({ api, onClose, onCreated }: {
  api: Api;
  onClose: () => void;
  onCreated: (student: Student, warning?: string) => void;
}) {
  const [draft, setDraft] = useState<StudentDraft>(EMPTY_STUDENT);
  const [guardians, setGuardians] = useState<GuardianInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = studentProblem(draft) ?? guardians.map(guardianProblem).find(Boolean) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    const input: StudentInput = {
      studentCode: draft.studentCode.trim(),
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      grade: draft.grade.trim(),
      subjects: draft.subjects,
      pickupAlert: draft.pickupAlert.trim(),
      active: draft.active,
      guardians: guardians.map(trimGuardian),
    };
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ student: Student }>('/students', input);
      onCreated(result.student);
    } catch (e) {
      if (e instanceof RequestError && e.code === 'DUPLICATE_RECORD') {
        setError(`A student with code ${input.studentCode} already exists at this location. If you just retried after a connection problem, the student may already be saved: search the roster for this code.`);
      } else {
        setError(uncertainMessage(e, 'Not confirmed. The connection dropped before the server replied. Search the roster for this student code before trying again.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add student" wide onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <StudentFields value={draft} onChange={setDraft} showActive={false} />
        <fieldset>
          <legend>Guardians</legend>
          <p className="muted small">Add up to {MAX_NEW_GUARDIANS} now. You can add more from the student’s profile.</p>
          {guardians.map((guardian, index) => (
            <div key={index} className="form-panel">
              <div className="guardian-item-head">
                <h3>Guardian {index + 1}</h3>
                <Button variant="ghost" onClick={() => setGuardians(list => list.filter((_, i) => i !== index))}>
                  <Trash2 size={16} aria-hidden="true" /> Remove guardian {index + 1}
                </Button>
              </div>
              <GuardianFields
                value={guardian}
                onChange={next => setGuardians(list => list.map((g, i) => (i === index ? next : g)))}
              />
            </div>
          ))}
          {guardians.length < MAX_NEW_GUARDIANS && (
            <div>
              <Button onClick={() => setGuardians(list => [...list, { ...EMPTY_GUARDIAN }])}>
                <Plus size={16} aria-hidden="true" /> Add guardian
              </Button>
            </div>
          )}
        </fieldset>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>Add student</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Student profile
// ---------------------------------------------------------------------------

function StudentProfile({ api, location, studentId, canEdit, canRecord, onClose, onChanged }: {
  api: Api;
  location: Location;
  studentId: number;
  canEdit: boolean;
  canRecord: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const timezone = location.timezone;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [visitPage, setVisitPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [editingStudent, setEditingStudent] = useState(false);
  const [guardianForm, setGuardianForm] = useState<'new' | number | null>(null);
  const [correctingId, setCorrectingId] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams({ page: String(visitPage), pageSize: String(VISIT_PAGE_SIZE) });
      const value = await api.get<Detail>(`/students/${studentId}?${params}`, signal);
      setDetail(value);
      setError('');
      return value;
    } catch (e) {
      if (!signal?.aborted) setError(messageOf(e));
      return null;
    }
  }, [api, studentId, visitPage]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const student = detail?.student ?? null;
  const correcting = detail?.visits.find(v => v.id === correctingId) ?? null;

  if (recording && canRecord) {
    return (
      <AttendanceSheet
        api={api}
        studentId={studentId}
        timezone={timezone}
        onClose={() => setRecording(false)}
        onRecorded={() => {
          void load();
          onChanged();
        }}
      />
    );
  }

  if (correcting && canEdit) {
    return (
      <CorrectionModal
        key={correcting.id}
        api={api}
        visit={correcting}
        corrections={detail?.corrections.filter(c => c.visitId === correcting.id) ?? []}
        timezone={timezone}
        onClose={() => setCorrectingId(null)}
        onStale={() => load()}
        onSaved={() => {
          setCorrectingId(null);
          setNotice({ tone: 'success', text: 'Correction saved. The original observation and the previous times are kept in the visit’s history.' });
          void load();
          onChanged();
        }}
      />
    );
  }

  async function reloadAfterConflict(message: string) {
    await load();
    setNotice({ tone: 'warning', text: message });
  }

  return (
    <Modal
      title={student?.displayName ?? 'Student'}
      subtitle={student ? `Student code ${student.studentCode}` : undefined}
      wide
      onClose={onClose}
    >
      {!detail && !error && <Spinner label="Loading profile" />}
      <Alert>{error}</Alert>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {detail && student && (
        <>
          <div className="row">
            {!student.active && <Badge>Inactive</Badge>}
            {detail.visits.some(v => v.checkOutAt === null) && <Badge tone="green">Present</Badge>}
            <span style={{ flex: 1 }} />
            {canRecord && (
              <Button variant="primary" onClick={() => setRecording(true)}>
                <LogIn size={18} aria-hidden="true" /> Check in / out
              </Button>
            )}
          </div>

          {student.pickupAlert && !editingStudent && (
            <div className="pickup-alert">
              <ShieldAlert size={20} aria-hidden="true" />
              <div>
                <strong>Pickup alert</strong>
                <p>{student.pickupAlert}</p>
              </div>
            </div>
          )}

          <Card
            title="Student"
            actions={canEdit && !editingStudent && (
              <Button variant="ghost" onClick={() => { setEditingStudent(true); setNotice(null); }}>
                <Pencil size={16} aria-hidden="true" /> Edit student
              </Button>
            )}
          >
            {editingStudent
              ? (
                <StudentEditor
                  key={student.revision}
                  api={api}
                  student={student}
                  onCancel={() => setEditingStudent(false)}
                  onSaved={() => {
                    setEditingStudent(false);
                    setNotice({ tone: 'success', text: 'Student saved.' });
                    void load();
                    onChanged();
                  }}
                  onStale={() => reloadAfterConflict('Someone else changed this student while you were editing. Your changes were not saved. The latest details are shown; make your changes again.')}
                />
              )
              : (
                <dl className="facts">
                  <dt>First name</dt>
                  <dd>{student.firstName}</dd>
                  <dt>Last name</dt>
                  <dd>{student.lastName}</dd>
                  <dt>Student code</dt>
                  <dd>{student.studentCode}</dd>
                  <dt>Grade</dt>
                  <dd>{student.grade || '—'}</dd>
                  <dt>Subjects</dt>
                  <dd>{student.subjects.length ? student.subjects.join(', ') : '—'}</dd>
                  <dt>Status</dt>
                  <dd>{student.active ? 'Active' : 'Inactive'}</dd>
                  <dt>Pickup alert</dt>
                  <dd>{student.pickupAlert || 'None'}</dd>
                </dl>
              )}
          </Card>

          <Card
            title="Guardians"
            actions={canEdit && guardianForm === null && (
              <Button variant="ghost" onClick={() => { setGuardianForm('new'); setNotice(null); }}>
                <Plus size={16} aria-hidden="true" /> Add guardian
              </Button>
            )}
          >
            {guardianForm === 'new' && (
              <GuardianEditor
                api={api}
                studentId={student.id}
                revision={student.revision}
                onCancel={() => setGuardianForm(null)}
                onSaved={() => {
                  setGuardianForm(null);
                  setNotice({ tone: 'success', text: 'Guardian added.' });
                  void load();
                  onChanged();
                }}
                onStale={() => reloadAfterConflict('This student changed while you were editing. Nothing was saved.')}
              />
            )}
            {detail.guardians.length === 0 && guardianForm !== 'new' && (
              <p className="muted">No guardians on file. Without a verified guardian, only an exceptional departure can be recorded.</p>
            )}
            <div className="guardian-list">
              {detail.guardians.map(guardian => (
                guardianForm === guardian.id
                  ? (
                    <GuardianEditor
                      key={`${guardian.id}-${student.revision}`}
                      api={api}
                      studentId={student.id}
                      revision={student.revision}
                      guardian={guardian}
                      onCancel={() => setGuardianForm(null)}
                      onSaved={() => {
                        setGuardianForm(null);
                        setNotice({ tone: 'success', text: `${guardian.displayName} was updated.` });
                        void load();
                        onChanged();
                      }}
                      onStale={() => reloadAfterConflict('This student or guardian changed while you were editing. Your changes were not saved. The latest details are shown; make your changes again.')}
                    />
                  )
                  : (
                    <GuardianCard
                      key={guardian.id}
                      guardian={guardian}
                      onEdit={canEdit && guardianForm === null ? () => { setGuardianForm(guardian.id); setNotice(null); } : undefined}
                    />
                  )
              ))}
            </div>
          </Card>

          <Card title="Recent visits">
            <VisitsTable
              visits={detail.visits}
              corrections={detail.corrections}
              timezone={timezone}
              onCorrect={canEdit ? visit => { setCorrectingId(visit.id); setNotice(null); } : undefined}
            />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">{detail.visitTotal} {detail.visitTotal === 1 ? 'visit' : 'visits'} in total. Times shown in {timezone}.</span>
              <Pager page={detail.page} pageSize={VISIT_PAGE_SIZE} total={detail.visitTotal} onPage={setVisitPage} />
            </div>
          </Card>
        </>
      )}
    </Modal>
  );
}

function GuardianCard({ guardian, onEdit }: { guardian: Guardian; onEdit?: () => void }) {
  const authority = AUTHORITY[guardian.pickupAuthority];
  return (
    <div className="guardian-item">
      <div className="guardian-item-head">
        <div>
          <strong>{guardian.displayName}</strong>
          {guardian.relationship && <span className="muted"> · {guardian.relationship}</span>}
        </div>
        <div className="row">
          <Badge tone={authority.tone}>{authority.label}</Badge>
          {onEdit && (
            <Button variant="ghost" onClick={onEdit} aria-label={`Edit ${guardian.displayName}`}>
              <Pencil size={16} aria-hidden="true" /> Edit
            </Button>
          )}
        </div>
      </div>
      <div className="row small">
        {guardian.phone ? <a href={`tel:${guardian.phone}`}>{guardian.phone}</a> : <span className="muted">No phone</span>}
        {guardian.email ? <a href={`mailto:${guardian.email}`}>{guardian.email}</a> : <span className="muted">No email</span>}
      </div>
      {guardian.authorityNote && <p className="small"><span className="muted">Verification: </span>{guardian.authorityNote}</p>}
    </div>
  );
}

function StudentEditor({ api, student, onCancel, onSaved, onStale }: {
  api: Api;
  student: Student;
  onCancel: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const [draft, setDraft] = useState<StudentDraft>(() => draftOf(student));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    const problem = studentProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const changes = changedStudentFields(student, draft);
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.patch<{ student: Student }>(`/students/${student.id}`, { ...changes, expectedRevision: student.revision });
      onSaved();
    } catch (e) {
      if (e instanceof RequestError && e.code === 'STALE_STUDENT') {
        onStale();
        return;
      }
      setError(uncertainMessage(e, 'Not confirmed. The connection dropped before the server replied. Save again: if the first save went through, you will be asked to reload.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <StudentFields value={draft} onChange={setDraft} showActive />
      {!draft.active && student.active && (
        <Alert tone="warning">Inactive students cannot be checked in. Their history is kept.</Alert>
      )}
      <Alert>{error}</Alert>
      <div className="form-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy}>Save student</Button>
      </div>
    </form>
  );
}

function GuardianEditor({ api, studentId, revision, guardian, onCancel, onSaved, onStale }: {
  api: Api;
  studentId: number;
  revision: number;
  guardian?: Guardian;
  onCancel: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const [draft, setDraft] = useState<GuardianInput>(() => (guardian
    ? {
      displayName: guardian.displayName, relationship: guardian.relationship, phone: guardian.phone, email: guardian.email,
      pickupAuthority: guardian.pickupAuthority, authorityNote: guardian.authorityNote,
    }
    : { ...EMPTY_GUARDIAN }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    const problem = guardianProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (guardian) {
        const changes = changedGuardianFields(guardian, draft);
        if (Object.keys(changes).length === 0) {
          onCancel();
          return;
        }
        await api.patch(`/students/${studentId}/guardians/${guardian.id}`, { ...changes, expectedRevision: revision });
      } else {
        await api.post(`/students/${studentId}/guardians`, trimGuardian(draft));
      }
      onSaved();
    } catch (e) {
      if (e instanceof RequestError && e.code === 'STALE_STUDENT') {
        onStale();
        return;
      }
      setError(uncertainMessage(e, guardian
        ? 'Not confirmed. The connection dropped before the server replied. Save again: if the first save went through, you will be asked to reload.'
        : 'Not confirmed. The connection dropped before the server replied. Close this form and check the guardian list before adding again, to avoid a duplicate.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-panel" onSubmit={save} noValidate aria-label={guardian ? `Edit ${guardian.displayName}` : 'Add guardian'}>
      <h3>{guardian ? `Edit ${guardian.displayName}` : 'Add guardian'}</h3>
      <GuardianFields value={draft} onChange={setDraft} />
      <Alert>{error}</Alert>
      <div className="form-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy}>{guardian ? 'Save guardian' : 'Add guardian'}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Visits and corrections
// ---------------------------------------------------------------------------

function VisitsTable({ visits, corrections, timezone, onCorrect }: {
  visits: VisitSummary[];
  corrections: Correction[];
  timezone: string;
  onCorrect?: (visit: VisitSummary) => void;
}) {
  if (visits.length === 0) {
    return <EmptyState icon={History} title="No visits yet" />;
  }
  const byVisit = new Map<number, Correction[]>();
  for (const correction of corrections) byVisit.set(correction.visitId, [...(byVisit.get(correction.visitId) ?? []), correction]);
  const columns = onCorrect ? 7 : 6;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Arrival</th>
            <th scope="col">Departure</th>
            <th scope="col">Duration</th>
            <th scope="col">Recorded by</th>
            <th scope="col">Picked up by</th>
            <th scope="col">Status</th>
            {onCorrect && <th scope="col"><span className="visually-hidden">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {visits.map(visit => {
            const history = byVisit.get(visit.id) ?? [];
            return (
              <VisitRows key={visit.id} visit={visit} history={history} timezone={timezone} columns={columns} onCorrect={onCorrect} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VisitRows({ visit, history, timezone, columns, onCorrect }: {
  visit: VisitSummary;
  history: Correction[];
  timezone: string;
  columns: number;
  onCorrect?: (visit: VisitSummary) => void;
}) {
  const range = (from: string, to: string | null) => `${formatDateTime(from, timezone)} – ${to ? formatTime(to, timezone) : 'open'}`;
  return (
    <>
      <tr>
        <td>{formatDateTime(visit.checkInAt, timezone)}</td>
        <td>{visit.checkOutAt ? formatDateTime(visit.checkOutAt, timezone) : <Badge tone="green">Here now</Badge>}</td>
        <td>{visit.checkOutAt ? formatDuration(visit.checkInAt, visit.checkOutAt) : `${formatDuration(visit.checkInAt, null)} so far`}</td>
        <td>
          In: {visit.checkInBy}
          {visit.checkOutBy && <span className="cell-sub">Out: {visit.checkOutBy}</span>}
        </td>
        <td>{visit.guardianName ?? (visit.checkOutAt ? '—' : '')}</td>
        <td>
          <span className="badge-list">
            {visit.corrected && <Badge tone="blue">Corrected</Badge>}
            {visit.departureType === 'exceptional_departure' && <Badge tone="amber">Exceptional departure</Badge>}
            {visit.reviewStatus === 'pending' && <Badge tone="red">Review pending</Badge>}
            {visit.reviewStatus === 'resolved' && <Badge>Review resolved</Badge>}
          </span>
        </td>
        {onCorrect && (
          <td>
            <Button variant="ghost" onClick={() => onCorrect(visit)} aria-label={`Correct times for visit on ${formatDateTime(visit.checkInAt, timezone)}`}>
              <Pencil size={16} aria-hidden="true" /> Correct
            </Button>
          </td>
        )}
      </tr>
      {history.length > 0 && (
        <tr className="corrections-row">
          <td colSpan={columns}>
            <span className="small muted">
              Originally observed: {range(visit.originalCheckInAt, visit.originalCheckOutAt)}
            </span>
            <ol className="correction-list" aria-label="Corrections">
              {history.map(correction => (
                <li key={correction.id}>
                  {range(correction.priorCheckInAt, correction.priorCheckOutAt)} changed to{' '}
                  <strong>{range(correction.checkInAt, correction.checkOutAt)}</strong> by {correction.actorName} on{' '}
                  {formatDateTime(correction.recordedAt, timezone)}. Reason: {correction.reason}
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

function CorrectionModal({ api, visit, corrections, timezone, onClose, onSaved, onStale }: {
  api: Api;
  visit: VisitSummary;
  corrections: Correction[];
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
  onStale: () => Promise<unknown>;
}) {
  const [arrival, setArrival] = useState(() => isoToZonedInput(visit.checkInAt, timezone));
  const [departure, setDeparture] = useState(() => isoToZonedInput(visit.checkOutAt, timezone));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  // One id per form: a retry after a lost reply cannot record the correction twice.
  const correctionId = useRef(newRequestId());
  const seenVersion = useRef(visit.version);

  // When the visit is reloaded after a conflict, start from its latest times.
  useEffect(() => {
    if (seenVersion.current === visit.version) return;
    seenVersion.current = visit.version;
    correctionId.current = newRequestId();
    setArrival(isoToZonedInput(visit.checkInAt, timezone));
    setDeparture(isoToZonedInput(visit.checkOutAt, timezone));
  }, [visit.version, visit.checkInAt, visit.checkOutAt, timezone]);

  const open = visit.checkOutAt === null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checkInAt = arrival ? zonedInputToIso(arrival, timezone) : null;
    const checkOutAt = departure ? zonedInputToIso(departure, timezone) : null;
    if (!checkInAt) {
      setError('Enter the arrival time.');
      return;
    }
    if (!open && !checkOutAt) {
      setError('Enter the departure time. A completed visit cannot be reopened.');
      return;
    }
    if (checkOutAt && Date.parse(checkOutAt) < Date.parse(checkInAt)) {
      setError('Departure cannot be before arrival.');
      return;
    }
    if (Date.parse(checkInAt) > Date.now() + 60000 || (checkOutAt && Date.parse(checkOutAt) > Date.now() + 60000)) {
      setError('Corrected times cannot be in the future.');
      return;
    }
    if (checkInAt === visit.checkInAt && checkOutAt === visit.checkOutAt) {
      setError('Change at least one time, or cancel.');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Explain why the times need correcting (at least 5 characters).');
      return;
    }
    setBusy(true);
    setError('');
    setWarning('');
    try {
      await api.post(`/visits/${visit.id}/corrections`, {
        correctionId: correctionId.current,
        expectedVersion: visit.version,
        checkInAt,
        checkOutAt,
        reason: reason.trim(),
      });
      onSaved();
    } catch (e) {
      if (e instanceof RequestError && e.code === 'STALE_VISIT') {
        await onStale();
        setWarning('This visit changed since you opened it. The latest times are now filled in. Review them and submit again.');
      } else {
        setError(uncertainMessage(e, 'Not confirmed. The connection dropped before the server replied. Submit again without changing anything to retry safely.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Correct visit times" subtitle={`${visit.studentName} · times in ${timezone}`} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <Alert tone="info">
          A correction never erases the record. The original observation ({formatDateTime(visit.originalCheckInAt, timezone)}
          {visit.originalCheckOutAt ? ` – ${formatTime(visit.originalCheckOutAt, timezone)}` : ''}), the times before this change,
          your reason, and your name are all kept.
        </Alert>
        {corrections.length > 0 && (
          <p className="small muted">This visit has been corrected {corrections.length} {corrections.length === 1 ? 'time' : 'times'} before.</p>
        )}
        <Alert tone="warning">{warning}</Alert>
        <div className="grid-2">
          <Field label="Arrival">
            <input type="datetime-local" value={arrival} onChange={e => setArrival(e.target.value)} required />
          </Field>
          <Field label="Departure" hint={open ? 'Leave empty if the student is still here.' : undefined}>
            <input type="datetime-local" value={departure} onChange={e => setDeparture(e.target.value)} required={!open} />
          </Field>
        </div>
        <Field label="Reason for correction" hint="For example: “Checked in late on the kiosk; arrival confirmed by instructor.”">
          <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} required />
        </Field>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>Save correction</Button>
        </div>
      </form>
    </Modal>
  );
}
