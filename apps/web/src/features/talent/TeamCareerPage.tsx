import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useCareerReadiness, useJobOptions, useTeamCareer, useTalentReviews, type TeamCareerRowDto } from './talent.api';
import { ReadinessTable, ReviewStatusBadge } from './talent-ui';
import { nineBoxLabel } from '@hr/shared';

/** A manager's team: current job, how many paths lead on, development context, and their talent reviews (cell, no comment). */
export function TeamCareerPage() {
  const team = useTeamCareer();
  const reviews = useTalentReviews({ view: 'team', pageSize: 100 });
  const [open, setOpen] = useState<TeamCareerRowDto | null>(null);
  const columns: Column<TeamCareerRowDto>[] = [
    { key: 'who', header: 'Employee', render: (r) => <div><div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div><div className="text-xs text-slate-400">{r.employee.employeeCode}</div></div> },
    { key: 'job', header: 'Current job', render: (r) => r.currentJob?.title ?? <span className="text-slate-400">—</span> },
    { key: 'next', header: 'Next jobs on a path', hideBelow: 'sm', render: (r) => <span className="tabular-nums">{r.nextJobCount}</span> },
    { key: 'dev', header: 'Development', hideBelow: 'md', render: (r) => <span className="text-slate-600">{r.development.openNeeds} open need(s){r.development.activeIdpTitle && ` · ${r.development.activeIdpTitle}`}</span> },
    { key: 'talent', header: 'Talent reviews', hideBelow: 'lg', render: (r) => { const mine = (reviews.data?.data ?? []).filter((x) => x.employee.id === r.employee.id); return mine.length ? <span className="text-slate-600">{mine.map((x) => `${x.cycle.name}: ${x.nineBoxCell ? nineBoxLabel(x.nineBoxCell) : x.status.toLowerCase()}`).join(' · ')}</span> : <span className="text-slate-400">—</span>; } },
  ];
  return (
    <>
      <Card>
        <CardHeader title="Team career summary" description="Your direct reports, their current jobs and how far the defined paths lead. Open somebody to compare them against a target job. Nothing here ranks your team." />
        {team.isError && <Alert className="m-4">Could not load your team.</Alert>}
        <DataTable columns={columns} rows={team.data ?? []} rowKey={(r) => r.employee.id} loading={team.isLoading} onRowClick={setOpen} emptyTitle="No direct reports" />
      </Card>
      <TeamReadinessModal row={open} onClose={() => setOpen(null)} reviews={(reviews.data?.data ?? []).filter((x) => x.employee.id === open?.employee.id).map((x) => ({ id: x.id, cycle: x.cycle.name, status: x.status, cell: x.nineBoxCell }))} />
    </>
  );
}

function TeamReadinessModal({ row, onClose, reviews }: { row: TeamCareerRowDto | null; onClose: () => void; reviews: { id: string; cycle: string; status: string; cell: string | null }[] }) {
  const jobs = useJobOptions();
  const [jobId, setJobId] = useState('');
  const readiness = useCareerReadiness(row?.employee.id ?? null, jobId || null);
  return (
    <Modal open={!!row} onClose={() => { setJobId(''); onClose(); }} title={row ? `${row.employee.firstName} ${row.employee.lastName}` : 'Employee'} description={row?.currentJob?.title} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-4 text-sm">
        <Select label="Compare against job" options={(jobs.data ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="Choose a target job…" value={jobId} onChange={(e) => setJobId(e.target.value)} />
        {readiness.isLoading && <LoadingBlock />}
        {readiness.data && <ReadinessTable readiness={readiness.data} compact />}
        {reviews.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Talent reviews</h3>
            <ul className="space-y-1">{reviews.map((r) => <li key={r.id} className="flex items-center gap-2 text-slate-700">{r.cycle}<ReviewStatusBadge status={r.status} />{r.cell && <span className="text-slate-500">{nineBoxLabel(r.cell)}</span>}</li>)}</ul>
            <p className="mt-1 text-xs text-slate-500">Reviewer comments are visible to the reviewer and HR only.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
