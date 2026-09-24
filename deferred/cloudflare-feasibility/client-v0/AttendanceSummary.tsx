import { useEffect, useState } from 'react';
import { BarChart3, CalendarCheck2, Clock3, Users } from 'lucide-react';
import type { AttendanceSummary as Summary } from '../shared/report-summary';
import { request, messageOf } from './api';
import { Badge, EmptyState } from './shared/components';
import { displayDate, displayTime } from './utils';
import './ReportSummary.css';

export const reportDateOffset = (day: string, offset: number) => new Date(Date.parse(`${day}T12:00:00.000Z`) + offset * 86400000).toISOString().slice(0, 10);
const dateLabel = (day: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

export default function AttendanceSummary({ from, to, revision }: { from: string; to: string; revision: number }) {
  const [summary, setSummary] = useState<Summary | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let current = true; setSummary(null); setError('');
    void request<Summary>(`/api/admin/reports/attendance/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal: controller.signal })
      .then(value => { if (current) setSummary(value); }).catch(failure => { if (current) setError(messageOf(failure)); });
    return () => { current = false; controller.abort(); };
  }, [from, to, revision]);
  if (error) return <div className="cf-notice error" role="alert">Attendance summary could not load. {error}</div>;
  if (!summary || summary.range.from !== from || summary.range.to !== to) return <section className="card cf-report-loading" aria-busy="true"><p>Loading attendance summary...</p></section>;
  const { totals, enrollment } = summary;
  const binSize = summary.days.length > 90 ? 30 : summary.days.length > 31 ? 7 : 1;
  const bins = Array.from({ length: Math.ceil(summary.days.length / binSize) }, (_, index) => {
    const days = summary.days.slice(index * binSize, (index + 1) * binSize);
    return { from: days[0].date, to: days.at(-1)!.date, count: days.reduce((sum, day) => sum + day.visits, 0) };
  });
  const maximum = Math.max(4, ...bins.map(bin => bin.count)), width = 660, height = 220, barWidth = 610 / bins.length;
  return <div className="cf-report-summary">
    <p className="cf-report-scope">Attendance recorded in this workspace. Visits use the effective arrival date in {summary.range.timezone.replaceAll('_', ' ')}, including both {from} and {to}. A visit may finish after the selected dates.</p>
    <div className="cf-report-metrics">
      <div className="card"><CalendarCheck2 size={22} /><div><span>Student visits</span><strong>{totals.visits.toLocaleString()}</strong><small>Each recorded arrival starts a visit</small></div></div>
      <div className="card"><Users size={22} /><div><span>Students checked in</span><strong>{totals.uniqueStudents.toLocaleString()}</strong><small>Unique students in this period</small></div></div>
      <div className="card"><Clock3 size={22} /><div><span>Average verified visit</span><strong>{totals.averageVerifiedMinutes === null ? '—' : `${Math.round(totals.averageVerifiedMinutes)} min`}</strong><small>{totals.verifiedClosedVisits.toLocaleString()} closed visits with no pending review</small></div></div>
    </div>
    <div className="cf-report-chart-layout">
      <section className="card cf-report-chart"><div className="cf-report-card-heading"><div><h2>Attendance over time</h2><p>{binSize === 1 ? 'Visits by day' : `Visits in groups of up to ${binSize} days`}</p></div><Badge tone="blue">{totals.visits.toLocaleString()} visits</Badge></div>
        {totals.visits ? <svg viewBox={`0 0 ${width} ${height + 38}`} role="img" aria-label={`${totals.visits} visits from ${from} through ${to}. Daily counts are available below.`}>
          {[0, 1, 2, 3, 4].map(tick => { const y = 20 + tick * 45; return <g key={tick}><line x1="38" x2="650" y1={y} y2={y} stroke="#e4ebef" strokeDasharray="3 4" /><text x="28" y={y + 4} textAnchor="end" className="cf-report-axis">{Math.round(maximum * (1 - tick / 4))}</text></g>; })}
          {bins.map((bin, index) => { const barHeight = bin.count / maximum * 180, x = 40 + index * barWidth; return <g key={bin.from}><rect x={x + barWidth * .15} y={200 - barHeight} width={Math.max(1, barWidth * .7)} height={barHeight} rx={Math.min(4, barWidth * .12)} fill="#6d9fb1"><title>{bin.from}{bin.to !== bin.from ? ` through ${bin.to}` : ''}: {bin.count} visits</title></rect>{(bins.length < 9 || index % Math.ceil(bins.length / 7) === 0) && <text x={x + barWidth * .5} y="233" textAnchor="middle" className="cf-report-axis">{dateLabel(bin.from)}</text>}</g>; })}
        </svg> : <EmptyState icon={BarChart3} title="No attendance in this period" description="Recorded arrivals will appear here. Try another date range." />}
        <details className="cf-report-day-table"><summary>View daily counts</summary><div className="table-wrap"><table className="data-table"><thead><tr><th>Date</th><th>Visits</th><th>Students</th><th>Verified closed visits</th></tr></thead><tbody>{summary.days.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.visits}</td><td>{day.students}</td><td>{day.verifiedClosedVisits}</td></tr>)}</tbody></table></div></details>
      </section>
      <section className="card cf-report-enrollment"><div className="cf-report-card-heading"><div><h2>Current enrollment</h2><p>As of {displayDate(summary.asOf, summary.range.timezone)} · {displayTime(summary.asOf, summary.range.timezone)}</p></div></div>
        <div className="cf-report-enrollment-total"><strong>{enrollment.activeStudents.toLocaleString()}</strong><span>active students</span></div>
        {(['math', 'reading'] as const).map(subject => <div className={`cf-report-subject ${subject}`} key={subject}><div><span>{subject === 'math' ? 'Math' : 'Reading'}</span><strong>{enrollment[subject].toLocaleString()}</strong></div><div className="cf-report-subject-track"><span style={{ width: `${enrollment.activeStudents ? enrollment[subject] / enrollment.activeStudents * 100 : 0}%` }} /></div></div>)}
        <p>{enrollment.both.toLocaleString()} students study both subjects. Current enrollment does not use the attendance date filter.</p>
      </section>
    </div>
  </div>;
}
