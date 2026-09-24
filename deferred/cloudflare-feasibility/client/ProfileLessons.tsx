import { useEffect, useState } from 'react';
import type { Student } from '../shared/types';
import type { SchedulesResponse } from '../shared/schedules';
import { messageOf, request, RequestError } from './api';

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export default function ProfileLessons({ student, timezone, onAccessExpired }: { student: Student; timezone: string; onAccessExpired: () => void }) {
  const [page, setPage] = useState(1), [result, setResult] = useState<SchedulesResponse | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    setLoading(true); setResult(null); setError('');
    void request<SchedulesResponse>(`/api/admin/schedules?studentId=${encodeURIComponent(student.id)}&active=true&page=${page}&pageSize=10`, { signal: controller.signal })
      .then(value => { if (current) setResult(value); })
      .catch(failure => { if (!current) return; setError(messageOf(failure)); if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [student.id, student.revision, page, onAccessExpired]);
  return <><h4>Weekly lessons</h4><p className="cf-table-note">{timezone.replaceAll('_', ' ')}. Scheduled lessons do not confirm attendance.</p>{error ? <p className="cf-notice error" role="alert">{error}</p> : loading ? <p className="cf-table-note">Loading lessons...</p> : result?.items.length ? <><div className="cf-student-history">{result.items.map(lesson => <div key={lesson.id}><div><strong>{days[lesson.dayOfWeek]} · {lesson.startTime}</strong>{lesson.subject} · {lesson.durationMinutes} minutes{(!student.active || !student.subjects.includes(lesson.subject)) && <small>Not currently expected: check enrollment and subject.</small>}</div></div>)}</div>{result.total > result.pageSize && <div className="cf-pagination"><span>Page {page} of {Math.ceil(result.total / result.pageSize)}</span><div><button className="btn btn-secondary btn-sm" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous lessons</button><button className="btn btn-secondary btn-sm" disabled={page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>Next lessons</button></div></div>}</> : <p className="cf-table-note">No active weekly lessons. Add lessons from Schedule.</p>}</>;
}
