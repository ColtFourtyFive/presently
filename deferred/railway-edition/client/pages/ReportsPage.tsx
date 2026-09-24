import { useMemo, useState } from 'react';
import { ArrowDownToLine, BarChart3, CalendarCheck2, Clock3, Users } from 'lucide-react';
import type { PageProps } from '../../shared/types';
import { Avatar, Badge, EmptyState } from '../components';
import { dateLabel, fullName, localDate, shortTime } from '../utils';
import { Metric, PageIntro } from './page-components';

const dateOffset = (day: string, offset: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10);

export default function ReportsPage({ data, onStudent }: PageProps) {
  const today = localDate(data.serverTime, data.center.timezone);
  const [from, setFrom] = useState(dateOffset(today, -6));
  const [to, setTo] = useState(today);
  const invalid = !from || !to || from > to;
  const visits = useMemo(() => invalid ? [] : data.visits.filter(visit => { const day = localDate(visit.checkedInAt, data.center.timezone); return day >= from && day <= to; }).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt)), [data.visits, data.center.timezone, from, to, invalid]);
  const closed = visits.filter(visit => visit.checkedOutAt && visit.reconciliationStatus === 'clear');
  const canExport = data.user.role === 'owner' || data.user.role === 'manager';
  const averageMinutes = closed.length ? Math.round(closed.reduce((total, visit) => total + Math.max(0, new Date(visit.checkedOutAt!).getTime() - new Date(visit.checkedInAt).getTime()) / 60000, 0) / closed.length) : null;
  const totalDays = invalid ? 0 : Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000) + 1;
  const binDays = totalDays > 90 ? 30 : totalDays > 31 ? 7 : 1;
  const chartData = useMemo(() => {
    if (!totalDays) return [];
    const bins = Array.from({ length: Math.min(Math.ceil(totalDays / binDays), 2000) }, (_, index) => ({ day: dateOffset(from, index * binDays), count: 0 }));
    for (const visit of visits) {
      const day = localDate(visit.checkedInAt, data.center.timezone);
      const index = Math.floor(Math.round((new Date(`${day}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000) / binDays);
      if (bins[index]) bins[index].count++;
    }
    return bins;
  }, [visits, from, totalDays, binDays, data.center.timezone]);
  const active = data.students.filter(student => student.status === 'active');
  const maximum = Math.max(4, ...chartData.map(day => day.count));
  const chartWidth = 650;
  const chartHeight = 210;
  const barWidth = chartData.length ? (chartWidth - 45) / chartData.length : 1;
  const math = active.filter(student => student.subjects.includes('Math')).length;
  const reading = active.filter(student => student.subjects.includes('Reading')).length;
  const setPreset = (days: number) => { setFrom(dateOffset(today, -(days - 1))); setTo(today); };
  return <>
    <PageIntro eyebrow="CENTER INSIGHTS" title="Progress you can see." description="A clear view of attendance and enrollment, grounded in your center's records." action={canExport && <a className={`btn btn-primary${invalid ? ' disabled' : ''}`} href={invalid ? undefined : `/api/reports/attendance.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`} aria-disabled={invalid}><ArrowDownToLine size={17} />Export attendance events</a>} />
    <div className="reports-filter"><div className="date-range-inputs"><label>From<input aria-label="Report start date" type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></label><span>to</span><label>To<input aria-label="Report end date" type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label></div><div className="tabs"><button className={`tab ${from === dateOffset(today, -6) && to === today ? 'active' : ''}`} onClick={() => setPreset(7)}>Last 7 days</button><button className={`tab ${from === dateOffset(today, -29) && to === today ? 'active' : ''}`} onClick={() => setPreset(30)}>Last 30 days</button></div></div>
    {canExport && <p className="page-footnote report-export-note">CSV exports individual attendance events by their effective event date. The charts and table below count visits by check-in date, so their totals can differ.</p>}
    {invalid && <div className="notice-box error" role="alert">Choose a valid start and end date to view attendance.</div>}
    <div className="page-metrics three"><Metric label="Student visits" value={visits.length} detail="Each check-in starts a visit" icon={CalendarCheck2} /><Metric label="Students checked in" value={new Set(visits.map(visit => visit.studentId)).size} detail="Unique students with a recorded check-in" icon={Users} tone="green" /><Metric label="Average verified visit" value={averageMinutes === null ? '—' : <>{averageMinutes}<span className="metric-unit"> min</span></>} detail={`${closed.length} completed ${closed.length === 1 ? 'visit' : 'visits'} with no pending review`} icon={Clock3} tone="purple" /></div>
    <div className="report-chart-layout"><section className="card attendance-chart"><div className="card-header"><div><h2>Attendance over time</h2><p className="muted">{binDays === 1 ? 'Visits by day' : `Visits per ${binDays}-day period`}</p></div><Badge tone="blue">{visits.length} visits</Badge></div>{visits.length ? <div className="chart-plot"><svg viewBox={`0 0 ${chartWidth} ${chartHeight + 45}`} role="img" aria-label={`Attendance from ${from} to ${to}. ${visits.length} visits across ${totalDays} days.`}>{[0, 1, 2, 3, 4].map(tick => { const y = 20 + tick / 4 * (chartHeight - 30); return <g key={tick}><line x1="35" x2={chartWidth - 5} y1={y} y2={y} stroke="#e8edee" strokeDasharray="3 4" /><text x="24" y={y + 4} textAnchor="end" className="chart-axis">{Math.round(maximum * (1 - tick / 4))}</text></g>; })}{chartData.map((day, index) => {
      const height = day.count / maximum * (chartHeight - 30);
      const x = 40 + index * barWidth;
      const label = new Date(`${day.day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      return <g key={day.day}><rect x={x + barWidth * .17} y={chartHeight - 10 - height} width={Math.max(1, barWidth * .58)} height={height} rx={Math.min(5, barWidth * .15)} fill={day.day === today ? '#173e48' : '#8cc4c2'}><title>{label}{binDays > 1 ? `, ${binDays}-day period` : ''}: {day.count} visits</title></rect>{(chartData.length < 11 || index % Math.ceil(chartData.length / 8) === 0) && <text x={x + barWidth * .46} y={chartHeight + 16} textAnchor="middle" className="chart-axis">{label}</text>}</g>;
    })}</svg></div> : <EmptyState icon={BarChart3} title="No attendance in this period" description="Recorded check-ins will appear here. Try a different date range." />}</section>
    <section className="card subject-report"><div className="card-header"><div><h2>Current enrollment</h2><p className="muted">Active students, as of today</p></div></div><div className="enrollment-total"><strong>{active.length}</strong><span>active students</span></div><div className="subject-report-row"><span><i className="subject-dot math" />Math</span><strong>{math}</strong></div><div className="subject-progress"><span style={{ width: `${active.length ? math / active.length * 100 : 0}%` }} /></div><div className="subject-report-row"><span><i className="subject-dot reading" />Reading</span><strong>{reading}</strong></div><div className="subject-progress reading"><span style={{ width: `${active.length ? reading / active.length * 100 : 0}%` }} /></div><p className="page-footnote">{active.filter(student => student.subjects.length > 1).length} students study both subjects. Enrollment counts are current and do not use the attendance date filter.</p></section></div>
    <section className="card"><div className="card-header"><div><h2>Attendance records <span className="count-pill">{visits.length}</span></h2><p className="muted">Visits are included by their check-in date in your center's time zone.</p></div></div>{visits.length ? <div className="table-wrap"><table className="data-table attendance-report-table" role="table"><thead><tr><th>Student</th><th>Date</th><th>Check-in</th><th>Check-out</th><th>Duration</th><th>Status</th></tr></thead><tbody>{visits.map(visit => { const student = data.students.find(item => item.id === visit.studentId); return <tr key={visit.id}><td data-label="Student"><button className="student-name-button" disabled={!student} onClick={() => student && onStudent(student)}><Avatar name={student ? fullName(student) : 'Student'} size="sm" /><strong>{student ? fullName(student) : 'Unknown student'}</strong></button></td><td data-label="Date">{dateLabel(visit.checkedInAt, data.center.timezone)}</td><td data-label="Check-in">{shortTime(visit.checkedInAt, data.center.timezone)}</td><td data-label="Check-out">{visit.checkedOutAt ? shortTime(visit.checkedOutAt, data.center.timezone) : <span className="muted">{visit.reconciliationStatus === 'review_needed' ? 'Presence unverified' : 'Still checked in'}</span>}</td><td data-label="Duration">{visit.reconciliationStatus === 'review_needed' ? <span className="muted">Needs review</span> : visit.checkedOutAt ? `${Math.max(0, Math.round((new Date(visit.checkedOutAt).getTime() - new Date(visit.checkedInAt).getTime()) / 60000))} min` : '—'}</td><td data-label="Status"><Badge tone={visit.reconciliationStatus === 'review_needed' ? 'amber' : visit.status === 'open' ? 'blue' : 'green'}>{visit.reconciliationStatus === 'review_needed' ? 'Needs review' : visit.status === 'open' ? 'At center' : 'Completed'}</Badge></td></tr>; })}</tbody></table></div> : <EmptyState icon={CalendarCheck2} title="No records to show" description="Adjust the date range or record a student's first check-in." />}</section>
  </>;
}
