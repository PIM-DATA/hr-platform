import { useEffect, useState } from 'react';
import { Plus, UserPlus } from 'lucide-react';
import type { AssessmentSummaryDto, CompetencyCycleDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useDepartmentOptions, useJobOptions, useOrganizationOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { useAssessments, useCompetencyCycles, useCompetencyMutations } from './competency.api';
import { AssessmentStatusBadge, CycleStatusBadge } from './competency-ui';

/** HR's view of an assessment round: configure it, assign a population, and walk it through its three steps. */
export function CompetencyCyclesPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const cycles = useCompetencyCycles({ status, page, pageSize: 20 });

  const columns: Column<CompetencyCycleDto>[] = [
    { key: 'name', header: 'Cycle', render: (c) => (
      <div>
        <div className="font-medium text-slate-900">{c.name}</div>
        <div className="text-xs text-slate-400">{c.code}</div>
      </div>
    ) },
    { key: 'period', header: 'Period', hideBelow: 'md', render: (c) => <span className="whitespace-nowrap text-slate-600">{c.periodStart} → {c.periodEnd}</span> },
    { key: 'self', header: 'Self assessment', hideBelow: 'lg', render: (c) => (c.selfAssessmentRequired ? 'Required' : <span className="text-slate-400">Skipped</span>) },
    { key: 'count', header: 'Assessments', className: 'text-right', render: (c) => <span className="tabular-nums">{c.assessmentCount}</span> },
    { key: 'status', header: 'Status', render: (c) => <CycleStatusBadge status={c.status} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2">
          <Select
            options={['DRAFT', 'ACTIVE', 'REVIEW', 'CLOSED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
            placeholder="All statuses"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          />
          <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New cycle</Button></div>
        </div>
        {cycles.isError && <Alert className="m-4">Could not load assessment cycles.</Alert>}
        <DataTable
          columns={columns}
          rows={cycles.data?.data ?? []}
          rowKey={(c) => c.id}
          loading={cycles.isLoading}
          onRowClick={(c) => setOpenId(c.id)}
          emptyTitle="No assessment cycles"
          emptyDescription="A cycle is one round of competency assessment."
        />
        {cycles.data?.meta && <Pagination {...cycles.data.meta} onPageChange={setPage} />}
      </Card>
      <CreateCycleModal open={creating} onClose={() => setCreating(false)} />
      <CycleDetailModal cycleId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function CreateCycleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useCompetencyMutations();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [selfAssessmentRequired, setSelf] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(''); setName(''); setPeriodStart(''); setPeriodEnd(''); setSelf(true); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createCycle.mutateAsync({ code, name, periodStart, periodEnd, selfAssessmentRequired });
      toast.success('Cycle created');
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New assessment cycle"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createCycle.isPending} disabled={!code || !name || !periodStart || !periodEnd}>Create cycle</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="COMP2026" />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Competency Assessment" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Period from" required type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          <Input label="Period to" required type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </div>
        <Checkbox
          label="Ask employees for a self assessment"
          description="Turn this off and the assessment goes straight to the reviewer."
          checked={selfAssessmentRequired}
          onChange={(e) => setSelf(e.target.checked)}
        />
      </div>
    </Modal>
  );
}

function CycleDetailModal({ cycleId, onClose }: { cycleId: string | null; onClose: () => void }) {
  const cycles = useCompetencyCycles({ pageSize: 100 });
  const assessments = useAssessments({ view: 'all', cycleId: cycleId ?? '', pageSize: 100 }, !!cycleId);
  const m = useCompetencyMutations();
  const toast = useToast();
  const [assigning, setAssigning] = useState(false);
  const [confirm, setConfirm] = useState<'activate' | 'open-review' | 'close' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cycle = (cycles.data?.data ?? []).find((c) => c.id === cycleId);
  const rows = assessments.data?.data ?? [];

  const move = async (action: 'activate' | 'open-review' | 'close') => {
    setErr(null);
    try {
      await m.transition.mutateAsync({ id: cycleId!, action });
      toast.success(action === 'activate' ? 'Cycle activated' : action === 'open-review' ? 'Assessment opened' : 'Cycle closed');
      setConfirm(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const columns: Column<AssessmentSummaryDto>[] = [
    { key: 'emp', header: 'Employee', render: (a) => (
      <div>
        <div className="font-medium text-slate-900">{a.employee.firstName} {a.employee.lastName}</div>
        <div className="text-xs text-slate-400">{a.employee.employeeCode}{a.snapshot.jobTitle && ` · ${a.snapshot.jobTitle}`}</div>
      </div>
    ) },
    { key: 'reviewer', header: 'Reviewer', hideBelow: 'md', render: (a) => a.reviewer.name ?? <span className="text-amber-700">Not assigned</span> },
    { key: 'items', header: 'Competencies', className: 'text-right', hideBelow: 'lg', render: (a) => <span className="tabular-nums">{a.itemCount}</span> },
    { key: 'status', header: 'Status', render: (a) => <AssessmentStatusBadge status={a.status} /> },
    { key: 'gaps', header: 'Gaps', className: 'text-right', render: (a) => (a.status === 'FINALIZED' ? <span className="tabular-nums">{a.gapCount}</span> : <span className="text-slate-400">—</span>) },
  ];

  return (
    <>
      <Modal open={!!cycleId} onClose={onClose} title={cycle?.name ?? 'Cycle'} description={cycle ? `${cycle.code} · ${cycle.periodStart} → ${cycle.periodEnd}` : undefined} size="lg">
        {cycles.isLoading && <LoadingBlock />}
        {err && <Alert className="mb-3">{err}</Alert>}
        {cycle && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <CycleStatusBadge status={cycle.status} />
              <span className="text-xs text-slate-500">{cycle.selfAssessmentRequired ? 'Self assessment required' : 'No self assessment'}</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Figure label="Assigned" value={rows.length} />
              <Figure label="Self assessments in" value={rows.filter((a) => !!a.selfSubmittedAt).length} />
              <Figure label="Complete" value={rows.filter((a) => a.status === 'FINALIZED').length} />
            </div>
            <div className="flex flex-wrap gap-2">
              {cycle.status !== 'CLOSED' && <Button variant="secondary" onClick={() => setAssigning(true)}><UserPlus className="h-4 w-4" /> Assign employees</Button>}
              {cycle.status === 'DRAFT' && <Button onClick={() => setConfirm('activate')}>Activate</Button>}
              {cycle.status === 'ACTIVE' && <Button onClick={() => setConfirm('open-review')}>Open assessment</Button>}
              {(cycle.status === 'ACTIVE' || cycle.status === 'REVIEW') && <Button variant="danger" onClick={() => setConfirm('close')}>Close cycle</Button>}
            </div>
            <div className="rounded-md border border-slate-200">
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(a) => a.id}
                loading={assessments.isLoading}
                emptyTitle="Nobody assigned yet"
                emptyDescription="Assign employees whose job has a competency profile."
              />
            </div>
          </div>
        )}
      </Modal>

      <AssignModal cycleId={assigning ? cycleId : null} onClose={() => setAssigning(false)} />

      <ConfirmDialog
        open={confirm === 'activate'}
        title="Activate this cycle"
        message="The assessments become live for the people assigned to them."
        confirmLabel="Activate"
        loading={m.transition.isPending}
        error={err}
        onConfirm={() => move('activate')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'open-review'}
        title="Open the assessment"
        message="Each assessment moves to whoever owes the first one — the employee, or the reviewer when this cycle asks for no self assessment."
        confirmLabel="Open"
        loading={m.transition.isPending}
        error={err}
        onConfirm={() => move('open-review')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'close'}
        title="Close this cycle"
        message="Closing is final: levels, comments and snapshots become history and nothing inside the cycle changes again. Assessments still open will stay unfinished."
        confirmLabel="Close cycle"
        variant="danger"
        loading={m.transition.isPending}
        error={err}
        onConfirm={() => move('close')}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

const Figure = ({ label, value }: { label: string; value: number }) => (
  <div className="rounded-md border border-slate-200 p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);

/** Bulk assignment by filter. Anyone whose job has no competency profile comes back as a skipped row, with a reason. */
function AssignModal({ cycleId, onClose }: { cycleId: string | null; onClose: () => void }) {
  const m = useCompetencyMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const jobs = useJobOptions();
  const [organizationId, setOrganizationId] = useState('');
  const departments = useDepartmentOptions(organizationId || undefined);
  const [departmentId, setDepartmentId] = useState('');
  const [jobId, setJobId] = useState('');
  const [skipped, setSkipped] = useState<{ employeeCode: string; reason: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (cycleId) { setErr(null); setSkipped([]); setOrganizationId(''); setDepartmentId(''); setJobId(''); } }, [cycleId]);

  const submit = async () => {
    setErr(null);
    try {
      const result = await m.assign.mutateAsync({
        cycleId: cycleId!,
        input: { organizationId: organizationId || undefined, departmentId: departmentId || undefined, jobId: jobId || undefined },
      });
      setSkipped(result.skipped);
      toast.success(`${result.created} assessment${result.created === 1 ? '' : 's'} created${result.alreadyAssigned ? `, ${result.alreadyAssigned} already assigned` : ''}`);
      if (result.skipped.length === 0) onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={!!cycleId}
      onClose={onClose}
      title="Assign employees"
      description="Everybody active in the selection whose job has a competency profile gets an assessment."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={submit} loading={m.assign.isPending} disabled={!organizationId && !departmentId && !jobId}>Assign</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization" options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any organization" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setDepartmentId(''); }} />
        <Select label="Department" options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Any department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} />
        <Select label="Job" options={(jobs.data?.data ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="Any job" value={jobId} onChange={(e) => setJobId(e.target.value)} />
        {skipped.length > 0 && (
          <Alert tone="info">
            <span className="font-medium">{skipped.length} employee{skipped.length === 1 ? ' was' : 's were'} skipped.</span>
            <ul className="mt-1 list-disc pl-4">
              {skipped.slice(0, 8).map((s) => <li key={s.employeeCode}>{s.employeeCode} — {s.reason}</li>)}
              {skipped.length > 8 && <li>…and {skipped.length - 8} more</li>}
            </ul>
          </Alert>
        )}
      </div>
    </Modal>
  );
}
