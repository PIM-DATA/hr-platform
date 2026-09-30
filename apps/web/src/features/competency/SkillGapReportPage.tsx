import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useDepartmentOptions, useJobOptions } from '@/features/organization/organization.api';
import { useCompetencyCycles, useGapReport } from './competency.api';

/**
 * The HR gap picture — aggregates only, over finalized assessments.
 *
 * Coverage is measured against what the cycle actually assigned, never against the whole employee master: a cycle
 * that deliberately covered one department is complete when that department is done, not 4% done.
 */
export function SkillGapReportPage() {
  const cycles = useCompetencyCycles({ pageSize: 50 });
  const departments = useDepartmentOptions();
  const jobs = useJobOptions();
  const [cycleId, setCycleId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [jobId, setJobId] = useState('');
  const report = useGapReport({ cycleId, departmentId, jobId });
  const r = report.data;

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <Select label="Cycle" options={(cycles.data?.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.status.toLowerCase()})` }))} placeholder="All cycles" value={cycleId} onChange={(e) => setCycleId(e.target.value)} />
          <Select label="Department" options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} />
          <Select label="Job" options={(jobs.data?.data ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="All jobs" value={jobId} onChange={(e) => setJobId(e.target.value)} />
        </div>
      </Card>

      {report.isLoading && <LoadingBlock />}
      {report.isError && <Alert>Could not load the gap report.</Alert>}

      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Assigned" value={r.coverage.assigned} />
            <Figure label="Assessments complete" value={`${r.coverage.finalized} · ${r.coverage.coveragePercent}%`} />
            <Figure label="Employees below a requirement" value={r.suppression ? <Withheld min={r.suppression.minimumGroupSize} /> : r.totals.employeesWithGap} />
            <Figure label="Average gap" value={r.suppression ? <Withheld min={r.suppression.minimumGroupSize} /> : (r.totals.averageGapNeeded ?? '—')} />
          </div>

          <Card>
            <CardHeader title="Where the gaps are" description="Competencies ranked by how many people are below what their job asks for." />
            {r.topGaps.length === 0 ? (
              <EmptyState title="Nothing assessed yet" description="Gaps appear once assessments are finalized." />
            ) : (
              <ul className="divide-y divide-slate-100 px-5 py-2">
                {r.topGaps.map((row) => (
                  <li key={row.competencyId} className="flex items-center justify-between py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block text-slate-900">{row.competencyName}</span>
                      <span className="block text-xs text-slate-400">{row.assessed} assessed</span>
                    </span>
                    <span className="flex items-center gap-4 text-slate-600">
                      <span className="tabular-nums">{row.belowRequirement === null ? 'withheld (small group)' : `${row.belowRequirement} below`}</span>
                      <span className="tabular-nums">avg {row.averageGap ?? '—'}</span>
                      <span className="tabular-nums">max {row.maxGap ?? '—'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Breakdown title="By department" rows={r.byDepartment.map((d) => ({ label: d.departmentName, assessed: d.assessed, withGap: d.withGap, gapItems: d.gapItems }))} />
            <Breakdown title="By job" rows={r.byJob.map((j) => ({ label: j.jobTitle, assessed: j.assessed, withGap: j.withGap, gapItems: j.gapItems }))} />
          </div>
        </>
      )}
    </div>
  );
}

const Withheld = ({ min }: { min: number }) => <span className="text-sm font-normal text-slate-500">Withheld — fewer than {min} people</span>;

const Figure = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);

const Breakdown = ({ title, rows }: { title: string; rows: { label: string; assessed: number; withGap: number | null; gapItems: number | null }[] }) => (
  <Card>
    <CardHeader title={title} description="From each assessment's own snapshot, not from where people sit today." />
    <ul className="divide-y divide-slate-100 px-5 py-2">
      {rows.length === 0 && <li className="py-2 text-sm text-slate-400">Nothing to show yet.</li>}
      {rows.map((row) => (
        <li key={row.label} className="flex items-center justify-between py-2 text-sm">
          <span className="text-slate-700">{row.label}</span>
          <span className="flex items-center gap-4 text-slate-600">
            <span className="tabular-nums">{row.assessed} assessed</span>
            {row.withGap === null ? <span className="text-slate-400">withheld (fewer than 5 people)</span> : <>
              <span className="tabular-nums">{row.withGap} with a gap</span>
              <span className="tabular-nums">{row.gapItems} items</span>
            </>}
          </span>
        </li>
      ))}
    </ul>
  </Card>
);
