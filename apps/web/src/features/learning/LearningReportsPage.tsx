import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { useLearningDashboard, useLearningReport } from './learning.api';
import { Stat, Table } from './learning-ui';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">{title}</div>{children}</Card>;

/** Counts and rates by department, program, path and certification. No name, comment or certificate number ever appears here. */
export function LearningReportsPage() {
  const { hasPermission } = useAuth();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`); const [to, setTo] = useState(`${year}-12-31`);
  const dash = useLearningDashboard(); const r = useLearningReport({ from, to });
  if (dash.isError || r.isError) return <Alert>Could not load the learning report.</Alert>;
  const s = dash.data; const d = r.data;
  return (
    <div className="space-y-4">
      {s && (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Active OJT plans" value={s.ojt.active} hint={`${s.ojt.completedLast90Days} completed in 90 days`} />
          <Stat label="Awaiting assessment" value={s.ojt.awaitingAssessment} tone={s.ojt.awaitingAssessment > 0 ? 'warning' : undefined} hint={`${s.ojt.activitiesNeedingObservation} activities need observation`} />
          <Stat label="Active learning paths" value={s.paths.active} hint={`avg progress ${s.paths.avgProgressPct ?? '—'}% · ${s.paths.completedLast90Days} completed in 90 days`} />
          <Stat label="Certifications expiring soon" value={s.certifications.expiringSoon} tone={s.certifications.expiringSoon > 0 ? 'warning' : undefined} hint={`${s.certifications.active} active · ${s.certifications.expired} expired · ${s.certifications.revoked} revoked`} />
        </div>
        <details className="text-xs text-slate-500"><summary className="cursor-pointer">How these numbers are defined</summary><ul className="mt-1 list-disc pl-5">{Object.entries(s.definitions).map(([k, v]) => <li key={k}>{v}</li>)}</ul></details>
      </>)}
      <Card><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3"><Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div></Card>
      {r.isLoading && <LoadingBlock />}
      {d && (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="OJT plans in range" value={d.ojt.plans} hint={`${d.ojt.completed} completed · ${d.ojt.cancelled} cancelled · avg ${d.ojt.avgCompletionDays ?? '—'} days`} /><Stat label="Paths assigned" value={d.paths.assigned} hint={`${d.paths.inProgress} in progress · ${d.paths.completed} completed`} /><Stat label="Certifications active" value={d.certifications.active} hint={`${d.certifications.expiringSoon} expiring soon`} /><Stat label="Expired / revoked" value={`${d.certifications.expired} / ${d.certifications.revoked}`} /></div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Section title="OJT by program"><Table head={['Program', 'Plans', 'Completed', 'Activities done']} rows={d.ojt.byProgram.map((x) => [x.program, x.plans, x.completed, `${x.activitiesCompleted}/${x.activities}`])} /></Section>
          <Section title="OJT by department"><Table head={['Department', 'Plans', 'Completed']} rows={d.ojt.byDepartment.map((x) => [x.department, x.plans, x.completed])} /></Section>
          <Section title="Learning paths"><Table head={['Path', 'Assigned', 'Completed', 'Steps fulfilled']} rows={d.paths.byPath.map((x) => [x.path, x.assigned, x.completed, x.stepsFulfilledPct === null ? '—' : `${x.stepsFulfilledPct}%`])} /></Section>
          <Section title="Learning paths by department"><Table head={['Department', 'Assigned', 'Completed']} rows={d.paths.byDepartment.map((x) => [x.department, x.assigned, x.completed])} /></Section>
          <Section title="Certifications"><Table head={['Certification', 'Active', 'Expiring soon', 'Expired', 'Revoked']} rows={d.certifications.byDefinition.map((x) => [x.certification, x.active, x.expiringSoon, x.expired, x.revoked])} /></Section>
          <Section title="Certifications by department"><Table head={['Department', 'Active', 'Expiring soon', 'Expired']} rows={d.certifications.byDepartment.map((x) => [x.department, x.active, x.expiringSoon, x.expired])} /></Section>
        </div>
      </>)}
      {hasPermission(PERMISSIONS.REPORTS_VIEW) && <p className="text-xs text-slate-500">Report Center datasets: <Link to="/hrm/reports/builder" className="text-brand-700 underline">OJT summary</Link>, <Link to="/hrm/reports/builder" className="text-brand-700 underline">Learning path summary</Link> and <Link to="/hrm/reports/builder" className="text-brand-700 underline">Certification summary</Link> — aggregates only.</p>}
    </div>
  );
}
