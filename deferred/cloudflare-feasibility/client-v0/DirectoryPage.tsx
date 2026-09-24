import { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, FileUp, GraduationCap, Plus, RefreshCw, Search, Users } from 'lucide-react';
import { Avatar, Badge, EmptyState } from './shared/components';
import { messageOf, request, RequestError } from './api';
import type { DirectoryResult } from '../shared/directory';
import './directory.css';

export default function DirectoryPage({ canManage, disabled, revision, onStudent, onAdd, onImport, onAccessExpired }: { canManage: boolean; disabled: boolean; revision: number; onStudent: (id: string) => void; onAdd: () => void; onImport: () => void; onAccessExpired: () => void }) {
  const [q, setQ] = useState(''), [status, setStatus] = useState('active'), [subject, setSubject] = useState('all');
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [result, setResult] = useState<DirectoryResult | null>(null);
  useEffect(() => {
    let current = true; const controller = new AbortController(); setLoading(true); setError(''); setResult(null);
    const timer = setTimeout(() => {
      void request<DirectoryResult>('/api/admin/directory/query', { method: 'POST', body: JSON.stringify({ q, status, subject, page, pageSize: 25 }), signal: controller.signal })
        .then(value => { if (current) setResult(value); })
        .catch(failure => { if (!current) return; setError(messageOf(failure)); if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); })
        .finally(() => { if (current) setLoading(false); });
    }, 250);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [q, status, subject, page, refresh, revision, onAccessExpired]);
  const filtered = q.trim() !== '' || status !== 'active' || subject !== 'all';
  return <>
    <div className="page-heading"><div><div className="eyebrow">STUDENT DIRECTORY</div><h1>Students and families.</h1><p>Find enrollment details and guardian contacts.</p></div>{canManage && <div className="cf-inline-actions"><button className="btn btn-secondary" disabled={disabled} onClick={onImport}><FileUp size={16} />Import roster</button><button className="btn btn-primary" disabled={disabled} onClick={onAdd}><Plus size={16} />Add student</button></div>}</div>
    <div className="cf-directory-metrics" aria-label="Current enrollment counts">{([{ label: 'Active students', key: 'active', icon: Users }, { label: 'Math enrollments', key: 'math', icon: GraduationCap }, { label: 'Reading enrollments', key: 'reading', icon: BookOpen }] as const).map(item => <div className="card" key={item.key}><item.icon size={20} /><span>{item.label}<strong>{result ? result.counts[item.key] : '—'}</strong></span></div>)}</div>
    {error && <div className="cf-notice error" role="alert">{error}</div>}
    <section className="card"><div className="cf-roster-heading"><div><h2>Your students</h2><p>Counts above include all active students. Filters apply to the directory below.</p></div><button className="btn btn-secondary btn-sm" disabled={loading || disabled} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />Refresh directory</button></div>
      <div className="cf-directory-filters"><div className="cf-search"><Search size={18} /><input aria-label="Search students or guardians" value={q} maxLength={100} placeholder="Student, guardian, email or phone" disabled={disabled} onChange={event => { setQ(event.target.value); setPage(1); }} /></div><label className="field"><span>Subject</span><select aria-label="Filter by subject" value={subject} disabled={disabled} onChange={event => { setSubject(event.target.value); setPage(1); }}><option value="all">All subjects</option><option>Math</option><option>Reading</option></select></label><label className="field"><span>Enrollment</span><select aria-label="Filter by enrollment" value={status} disabled={disabled} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="active">Active students</option><option value="inactive">Inactive students</option><option value="all">All statuses</option></select></label></div>
      {loading ? <p className="cf-table-note" role="status">Finding students...</p> : result?.items.length ? <><div className="table-wrap"><table className="data-table cf-data-table cf-directory-table"><thead><tr><th>Student</th><th>Subjects</th><th>Grade</th><th>Guardian contact</th><th>Enrollment</th><th><span className="sr-only">Open profile</span></th></tr></thead><tbody>{result.items.map(student => <tr key={student.id}><td><button className="cf-student-button" disabled={disabled} onClick={() => onStudent(student.id)}><Avatar name={student.displayName} /><span><strong>{student.displayName}</strong><small>{student.studentCode}</small></span></button></td><td>{student.subjects.join(' · ') || 'Not recorded'}</td><td>{student.grade || 'Not recorded'}</td><td><span className="cf-directory-contact"><strong>{student.contact?.displayName || 'Not recorded'}</strong><small>{student.contact?.phone || student.contact?.email || 'No contact details'}</small></span></td><td><Badge tone={student.active ? 'green' : 'gray'}>{student.active ? 'Active' : 'Inactive'}</Badge></td><td><button className="icon-button" aria-label={`Open profile for ${student.displayName}`} disabled={disabled} onClick={() => onStudent(student.id)}><ArrowUpRight size={17} /></button></td></tr>)}</tbody></table></div></> : !error && <EmptyState icon={Users} title={filtered ? 'No matching students' : 'No active students'} description={filtered ? 'Try another search or change the filters.' : 'Add or import your roster to begin. Inactive records remain available through the enrollment filter.'} />}
      {result && <div className="cf-pagination"><span>{result.total} students · Page {page} of {Math.max(1, Math.ceil(result.total / result.pageSize))}</span><div><button className="btn btn-secondary btn-sm" disabled={disabled || loading || page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={13} />Previous</button><button className="btn btn-secondary btn-sm" disabled={disabled || loading || page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>Next<ChevronRight size={13} /></button></div></div>}
      <p className="cf-table-note">Contact details do not establish pickup permission. Check the guardian's current authority in the student profile.</p>
    </section>
  </>;
}
