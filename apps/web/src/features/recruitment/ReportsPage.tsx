import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useRecruitmentOptions, useRecruitmentReport } from './recruitment.api';
import { Funnel, REJECTION_LABEL, SOURCE_LABEL, Stat, label } from './recruitment-ui';

/** Counts and averages over applications in a date range. Nobody is named and nobody is ranked. */
export function RecruitmentReportsPage() {
  const options = useRecruitmentOptions();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [organizationId, setOrg] = useState('');
  const report = useRecruitmentReport({ from, to, organizationId });
  const r = report.data;
  return (
    <div className="space-y-4">
      <Card><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <Input label="Applied from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input label="Applied to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => setOrg(e.target.value)} />
      </div></Card>
      {report.isLoading && <LoadingBlock />}
      {report.isError && <Alert>Could not load the report.</Alert>}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Hires" value={r.hires} />
            <Stat label="Average time to hire" value={r.averageTimeToHireDays === null ? '—' : `${r.averageTimeToHireDays} days`} />
            <Stat label="Interviews completed" value={r.interviews.completed} />
            <Stat label="Feedback submitted" value={r.interviews.feedbackSubmitted} />
            <Stat label="Offers accepted" value={r.offers.accepted} />
            <Stat label="Offers declined" value={r.offers.declined} />
          </div>
          <Card><CardHeader title="Funnel" description="Applications in the range, by their current stage." /><div className="p-4"><Funnel funnel={r.funnel} /></div></Card>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Breakdown title="By source" rows={r.bySource.map((s) => ({ label: label(SOURCE_LABEL, s.source), cells: [`${s.applications} applied`, `${s.interviews} interviewed`, `${s.offers} offered`, `${s.hires} hired`] }))} />
            <Breakdown title="By department" rows={r.byDepartment.map((d) => ({ label: d.departmentName, cells: [`${d.applications} applied`, `${d.hires} hired`] }))} />
            <Breakdown title="By job" rows={r.byJob.map((j) => ({ label: j.jobTitle, cells: [`${j.applications} applied`, `${j.hires} hired`] }))} />
            <Breakdown title="Rejection reasons" rows={r.rejectionsByReason.map((x) => ({ label: label(REJECTION_LABEL, x.reasonCode), cells: [`${x.count}`] }))} />
          </div>
          <p className="text-xs text-slate-500">Time to hire = days from application to hire, averaged over hires in the range. Time to fill (from requisition approval) is not reported in this release. Aggregate only — this report names nobody and ranks nobody.</p>
        </>
      )}
    </div>
  );
}

const Breakdown = ({ title, rows }: { title: string; rows: { label: string; cells: string[] }[] }) => (
  <Card>
    <CardHeader title={title} />
    {rows.length === 0 ? <p className="p-4 text-sm text-slate-500">Nothing in this range.</p> : (
      <ul className="divide-y divide-slate-100">{rows.map((r) => <li key={r.label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"><span className="text-slate-800">{r.label}</span><span className="flex flex-wrap gap-3 text-xs tabular-nums text-slate-500">{r.cells.map((c, i) => <span key={i}>{c}</span>)}</span></li>)}</ul>
    )}
  </Card>
);
