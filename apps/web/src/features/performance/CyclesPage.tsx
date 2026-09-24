import { useEffect, useState } from 'react';
import { Plus, UserPlus } from 'lucide-react';
import type { PerformanceCycleDto, PlanSummaryDto, RatingBandInput } from '@hr/shared';
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
import { useOrganizationOptions, useDepartmentOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { useKpis, usePerformanceCycle, usePerformanceCycles, usePerformanceMutations, usePlan, usePlans } from './performance.api';
import { CycleStatusBadge, PlanStatusBadge, ProgressBar, Score, formatMeasure, formatWeight, measurementLabel } from './performance-ui';

const DEFAULT_BANDS: RatingBandInput[] = [
  { code: 'EXCEPTIONAL', label: 'Exceptional', minScore: '4.50', maxScore: '5.00' },
  { code: 'EXCEEDS', label: 'Exceeds expectations', minScore: '3.50', maxScore: '4.49' },
  { code: 'MEETS', label: 'Meets expectations', minScore: '2.50', maxScore: '3.49' },
  { code: 'PARTIAL', label: 'Partially meets', minScore: '1.00', maxScore: '2.49' },
];

/**
 * The HR view of a cycle: configure it, assign a population, give each plan its KPIs, then walk it through its three
 * deliberate steps — activate, open the review, close.
 */
export function CyclesPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const cycles = usePerformanceCycles({ status, page, pageSize: 20 });

  const columns: Column<PerformanceCycleDto>[] = [
    { key: 'name', header: 'Cycle', render: (c) => (
      <div>
        <div className="font-medium text-slate-900">{c.name}</div>
        <div className="text-xs text-slate-400">{c.code}{c.organization && ` · ${c.organization.name}`}</div>
      </div>
    ) },
    { key: 'period', header: 'Period', hideBelow: 'md', render: (c) => <span className="whitespace-nowrap text-slate-600">{c.periodStart} → {c.periodEnd}</span> },
    { key: 'scale', header: 'Scale', hideBelow: 'lg', render: (c) => `${c.minScore}–${c.maxScore}` },
    { key: 'self', header: 'Self review', hideBelow: 'lg', render: (c) => (c.selfReviewRequired ? 'Required' : <span className="text-slate-400">Skipped</span>) },
    { key: 'plans', header: 'Plans', className: 'text-right', render: (c) => <span className="tabular-nums">{c.planCount}</span> },
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
        {cycles.isError && <Alert className="m-4">Could not load performance cycles.</Alert>}
        <DataTable
          columns={columns}
          rows={cycles.data?.data ?? []}
          rowKey={(c) => c.id}
          loading={cycles.isLoading}
          onRowClick={(c) => setOpenId(c.id)}
          emptyTitle="No performance cycles"
          emptyDescription="A cycle is the period people are appraised for."
        />
        {cycles.data?.meta && <Pagination {...cycles.data.meta} onPageChange={setPage} />}
      </Card>
      <CreateCycleModal open={creating} onClose={() => setCreating(false)} />
      <CycleDetailModal cycleId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function CreateCycleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = usePerformanceMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [selfReviewRequired, setSelfReviewRequired] = useState(true);
  const [minScore, setMinScore] = useState('1');
  const [maxScore, setMaxScore] = useState('5');
  const [scoreStep, setScoreStep] = useState('0.1');
  const [bands, setBands] = useState<RatingBandInput[]>(DEFAULT_BANDS);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(''); setName(''); setPeriodStart(''); setPeriodEnd(''); setBands(DEFAULT_BANDS); } }, [open]);

  const setBand = (index: number, patch: Partial<RatingBandInput>) =>
    setBands((current) => current.map((b, i) => (i === index ? { ...b, ...patch } : b)));

  const submit = async () => {
    setErr(null);
    try {
      await m.createCycle.mutateAsync({
        code, name, organizationId: organizationId || null, periodStart, periodEnd,
        selfReviewRequired, minScore, maxScore, scoreStep, ratingBands: bands,
      });
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
      title="New performance cycle"
      description="The scale and the rating bands can only be changed while the cycle is a draft."
      size="lg"
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
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ANNUAL2026" />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Annual Performance" />
        </div>
        <Select label="Organization" options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Period from" required type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          <Input label="Period to" required type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Lowest score" inputMode="decimal" value={minScore} onChange={(e) => setMinScore(e.target.value)} />
          <Input label="Highest score" inputMode="decimal" value={maxScore} onChange={(e) => setMaxScore(e.target.value)} />
          <Input label="Step" inputMode="decimal" value={scoreStep} onChange={(e) => setScoreStep(e.target.value)} hint="0.1 allows 3.5, not 3.55." />
        </div>
        <Checkbox label="Ask employees for a self review" description="Turn this off and the review goes straight to the reviewer." checked={selfReviewRequired} onChange={(e) => setSelfReviewRequired(e.target.checked)} />
        <div>
          <div className="mb-1 text-sm font-medium text-slate-700">Rating bands</div>
          <p className="mb-2 text-xs text-slate-500">They must not overlap and must cover the whole scale before the cycle can be activated.</p>
          <div className="space-y-2">
            {bands.map((band, index) => (
              <div key={band.code} className="grid grid-cols-[1fr_auto_auto] gap-2">
                <Input aria-label={`${band.code} label`} value={band.label} onChange={(e) => setBand(index, { label: e.target.value })} />
                <Input aria-label={`${band.code} from`} className="w-20" inputMode="decimal" value={band.minScore} onChange={(e) => setBand(index, { minScore: e.target.value })} />
                <Input aria-label={`${band.code} to`} className="w-20" inputMode="decimal" value={band.maxScore} onChange={(e) => setBand(index, { maxScore: e.target.value })} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** A cycle's own screen: its stage, the plans in it, and the two things HR does — assign people and give them KPIs. */
function CycleDetailModal({ cycleId, onClose }: { cycleId: string | null; onClose: () => void }) {
  const cycle = usePerformanceCycle(cycleId);
  const plans = usePlans({ view: 'all', cycleId: cycleId ?? '', pageSize: 100 }, !!cycleId);
  const m = usePerformanceMutations();
  const toast = useToast();
  const [assigning, setAssigning] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'activate' | 'open-review' | 'close' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const c = cycle.data;
  const rows = plans.data?.data ?? [];

  const move = async (action: 'activate' | 'open-review' | 'close') => {
    setErr(null);
    try {
      await m.transition.mutateAsync({ id: c!.id, action });
      toast.success(action === 'activate' ? 'Cycle activated' : action === 'open-review' ? 'Review opened' : 'Cycle closed');
      setConfirm(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const columns: Column<PlanSummaryDto>[] = [
    { key: 'emp', header: 'Employee', render: (p) => (
      <div>
        <div className="font-medium text-slate-900">{p.employee.firstName} {p.employee.lastName}</div>
        <div className="text-xs text-slate-400">{p.employee.employeeCode}{p.snapshot.departmentName && ` · ${p.snapshot.departmentName}`}</div>
      </div>
    ) },
    { key: 'reviewer', header: 'Reviewer', hideBelow: 'md', render: (p) => p.reviewer.name ?? <span className="text-amber-700">Not assigned</span> },
    { key: 'weight', header: 'Weights', className: 'text-right', render: (p) => (
      <span className={p.totalWeight === '100.00' ? 'tabular-nums text-slate-600' : 'tabular-nums font-medium text-amber-700'}>{formatWeight(p.totalWeight)}</span>
    ) },
    { key: 'progress', header: 'Progress', hideBelow: 'lg', render: (p) => <ProgressBar percent={p.progressPercent} /> },
    { key: 'status', header: 'Status', render: (p) => <PlanStatusBadge status={p.status} /> },
    { key: 'score', header: 'Result', className: 'text-right', render: (p) => (p.status === 'FINALIZED' ? <Score value={p.weightedScore} className="font-medium" /> : <span className="text-slate-400">—</span>) },
  ];

  const completion = {
    assigned: rows.length,
    selfSubmitted: rows.filter((p) => !!p.selfSubmittedAt).length,
    finalized: rows.filter((p) => p.status === 'FINALIZED').length,
  };

  return (
    <>
      <Modal open={!!cycleId} onClose={onClose} title={c?.name ?? 'Cycle'} description={c ? `${c.code} · ${c.periodStart} → ${c.periodEnd}` : undefined} size="lg">
        {cycle.isLoading && <LoadingBlock />}
        {err && <Alert className="mb-3">{err}</Alert>}
        {c && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <CycleStatusBadge status={c.status} />
              <span className="text-xs text-slate-500">Scale {c.minScore}–{c.maxScore} · step {c.scoreStep}</span>
              <span className="text-xs text-slate-500">{c.selfReviewRequired ? 'Self review required' : 'No self review'}</span>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Figure label="Assigned" value={completion.assigned} />
              <Figure label="Self reviews in" value={completion.selfSubmitted} />
              <Figure label="Complete" value={completion.finalized} />
            </div>

            <div className="flex flex-wrap gap-2">
              {c.status !== 'CLOSED' && <Button variant="secondary" onClick={() => setAssigning(true)}><UserPlus className="h-4 w-4" /> Assign employees</Button>}
              {c.status === 'DRAFT' && <Button onClick={() => setConfirm('activate')}>Activate</Button>}
              {c.status === 'ACTIVE' && <Button onClick={() => setConfirm('open-review')}>Open review</Button>}
              {(c.status === 'REVIEW' || c.status === 'ACTIVE') && <Button variant="danger" onClick={() => setConfirm('close')}>Close cycle</Button>}
            </div>

            <div className="rounded-md border border-slate-200">
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(p) => p.id}
                loading={plans.isLoading}
                onRowClick={(p) => setPlanId(p.id)}
                emptyTitle="Nobody assigned yet"
                emptyDescription="Assign employees to give them a plan."
              />
            </div>
          </div>
        )}
      </Modal>

      <AssignModal cycleId={assigning ? cycleId : null} onClose={() => setAssigning(false)} />
      <PlanStructureModal planId={planId} onClose={() => setPlanId(null)} />

      <ConfirmDialog
        open={confirm === 'activate'}
        title="Activate this cycle"
        message="Employees can record progress against their plans. The score scale and rating bands are frozen from now on."
        confirmLabel="Activate"
        loading={m.transition.isPending}
        error={err}
        onConfirm={() => move('activate')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'open-review'}
        title="Open the review"
        message="Every plan moves to its first assessment and the KPIs, weights and targets are frozen."
        confirmLabel="Open review"
        loading={m.transition.isPending}
        error={err}
        onConfirm={() => move('open-review')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'close'}
        title="Close this cycle"
        message="Closing is final: scores, comments and plans become history and nothing inside the cycle can be changed again. Reviews that are still open will stay unfinished."
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

const Figure = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-md border border-slate-200 p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);

/** Bulk assignment — a whole department or job at once, because assigning a hundred people singly is not a workflow. */
function AssignModal({ cycleId, onClose }: { cycleId: string | null; onClose: () => void }) {
  const m = usePerformanceMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const [organizationId, setOrganizationId] = useState('');
  const departments = useDepartmentOptions(organizationId || undefined);
  const [departmentId, setDepartmentId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (cycleId) { setErr(null); setOrganizationId(''); setDepartmentId(''); } }, [cycleId]);

  const submit = async () => {
    setErr(null);
    try {
      const result = await m.assign.mutateAsync({
        cycleId: cycleId!,
        input: { organizationId: organizationId || undefined, departmentId: departmentId || undefined },
      });
      toast.success(`${result.created} plan${result.created === 1 ? '' : 's'} created${result.alreadyAssigned ? `, ${result.alreadyAssigned} already assigned` : ''}`);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={!!cycleId}
      onClose={onClose}
      title="Assign employees"
      description="Everybody active in the selection gets a plan. Anyone already assigned is left alone."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.assign.isPending} disabled={!organizationId && !departmentId}>Assign</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization" options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Select an organization" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setDepartmentId(''); }} />
        <Select label="Department" options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} />
      </div>
    </Modal>
  );
}

/** One plan's KPIs: HR's to build until the review opens, and frozen afterwards. */
function PlanStructureModal({ planId, onClose }: { planId: string | null; onClose: () => void }) {
  const plan = usePlan(planId);
  const kpis = useKpis({ status: 'active', pageSize: 100 });
  const m = usePerformanceMutations();
  const [kpiId, setKpiId] = useState('');
  const [weight, setWeight] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [targetText, setTargetText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const p = plan.data;
  const editable = p ? ['DRAFT', 'ACTIVE'].includes(p.status) && p.cycle.status !== 'CLOSED' : false;

  const add = async () => {
    setErr(null);
    try {
      await m.addItem.mutateAsync({ planId: p!.id, input: { kpiId, weight, targetValue: targetValue || null, targetText: targetText || null } });
      setKpiId(''); setWeight(''); setTargetValue(''); setTargetText('');
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const remove = async (itemId: string) => {
    setErr(null);
    try { await m.removeItem.mutateAsync(itemId); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={!!planId} onClose={onClose} title={p ? `${p.employee.firstName} ${p.employee.lastName}` : 'Plan'} description={p?.cycle.name} size="lg">
      {plan.isLoading && <LoadingBlock />}
      {err && <Alert className="mb-3">{err}</Alert>}
      {p && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <PlanStatusBadge status={p.status} />
            <span className={p.totalWeight === '100.00' ? 'text-slate-500' : 'font-medium text-amber-700'}>Weights {formatWeight(p.totalWeight)}</span>
            <span className="text-slate-500">Reviewer {p.reviewer.name ?? 'not assigned'}</span>
          </div>
          {!editable && <Alert tone="info">The KPIs, weights and targets are frozen once the review starts.</Alert>}

          <ul className="divide-y divide-slate-200">
            {p.items.length === 0 && <li className="py-2 text-sm text-slate-400">No KPIs yet.</li>}
            {p.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block text-sm text-slate-900">{item.kpiName}</span>
                  <span className="block text-xs text-slate-500">
                    {formatWeight(item.weight)} · {measurementLabel(item.measurementType)}
                    {(item.targetValue || item.targetText) && ` · target ${formatMeasure(item.targetValue) ?? item.targetText}`}
                  </span>
                </span>
                {editable && <Button variant="ghost" size="sm" onClick={() => remove(item.id)}>Remove</Button>}
              </li>
            ))}
          </ul>

          {editable && (
            <div className="space-y-3 rounded-md border border-slate-200 p-3">
              <Select
                label="KPI"
                options={(kpis.data?.data ?? []).map((k) => ({ value: k.id, label: `${k.name} (${measurementLabel(k.measurementType)})` }))}
                placeholder="Choose from the library"
                value={kpiId}
                onChange={(e) => {
                  setKpiId(e.target.value);
                  const chosen = (kpis.data?.data ?? []).find((k) => k.id === e.target.value);
                  if (chosen?.defaultWeight) setWeight(chosen.defaultWeight);
                }}
              />
              <div className="grid grid-cols-3 gap-3">
                <Input label="Weight %" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
                <Input label="Target value" inputMode="decimal" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} />
                <Input label="Target (text)" value={targetText} onChange={(e) => setTargetText(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <Button onClick={add} loading={m.addItem.isPending} disabled={!kpiId || !weight}>Add KPI</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
