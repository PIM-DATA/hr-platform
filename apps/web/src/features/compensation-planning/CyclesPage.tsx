import { useAuth } from '@/hooks/useAuth';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { COMP_OVERRIDE_REASONS, COMP_PLANNER_REASONS, COMP_RETURN_REASONS, type CompCycleDto, type CompRowDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useApplyPreview, useCompCycle, useCompCycles, useCompMutations, useCompOptions, useCycleRows, usePopulation, useProposalHistory } from './comp.api';
import { CompBadge, HIGH_IMPACT_NOTE, Stat, money, titleCase, useCompAccess } from './comp-ui';

const MONEY = /^\d{1,13}(\.\d{1,2})?$/;
const reasonOptions = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: titleCase(x) }));

export function CyclesPage() {
  const a = useCompAccess();
  const cycles = useCompCycles();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2"><p className="text-sm text-slate-500">{HIGH_IMPACT_NOTE}</p>{a.manage && <Button onClick={() => setOpen(true)}>New salary review</Button>}</div>
      {cycles.isLoading && <LoadingBlock />}
      {cycles.isError && <Alert>{errorMessage(cycles.error)}</Alert>}
      <Card>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr>{['Review', 'Organization', 'Effective', 'Status', 'Population', 'Progress', 'Budget used'].map((h) => <th key={h} scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(cycles.data ?? []).length === 0 && <tr><td colSpan={7} className="px-4 py-4 text-sm text-slate-400">No salary review yet.</td></tr>}
              {(cycles.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2"><Link className="font-medium text-brand-700 underline" to={`/hrm/compensation/cycles/${c.id}`}>{c.name}</Link><div className="text-xs text-slate-500">{c.code}</div></td>
                  <td className="px-4 py-2">{c.organization.name}</td>
                  <td className="px-4 py-2 tabular-nums">{c.effectiveDate}</td>
                  <td className="px-4 py-2"><CompBadge status={c.status} />{c.appliedAt && <div className="mt-1 text-xs text-emerald-700">Applied</div>}</td>
                  <td className="px-4 py-2 tabular-nums">{c.population ? `${c.population.eligible} of ${c.population.total}` : '—'}</td>
                  <td className="px-4 py-2 tabular-nums">{c.progress ? `${c.progress.approved} approved · ${c.progress.submitted + c.progress.hrReview} submitted` : '—'}</td>
                  <td className="px-4 py-2 tabular-nums">{c.budget ? `${money(c.budget.used)} / ${money(c.budget.amount)} ${c.currency}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <CreateCycleModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function CreateCycleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const opts = useCompOptions(open);
  const mut = useCompMutations();
  const toast = useToast();
  const [f, setF] = useState({ code: '', name: '', organizationId: '', effectiveDate: '', currency: 'THB', showPerformanceContext: true });
  const save = async () => {
    try { await mut.createCycle.mutateAsync(f); toast.success('Salary review created'); onClose(); }
    catch (e) { toast.error('Could not create', errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New salary review" description="A cycle plans base salary for one organization in one currency, effective on one date."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={mut.createCycle.isPending} disabled={!f.code || !f.name || !f.organizationId || !f.effectiveDate} onClick={save}>Create</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="SR2027" />
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="2027 Salary Review" />
        <Select label="Organization" value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value })} placeholder="Choose…" options={(opts.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} />
        <Input label="Effective date" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} />
        <Input label="Currency" value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
        <div className="flex items-end pb-2"><Checkbox label="Show finalized performance result as context" checked={f.showPerformanceContext} onChange={(e) => setF({ ...f, showPerformanceContext: e.target.checked })} /></div>
      </div>
    </Modal>
  );
}

export function CycleDetailPage() {
  const { id } = useParams();
  const a = useCompAccess();
  const cycle = useCompCycle(id);
  const c = cycle.data;
  if (cycle.isLoading) return <LoadingBlock />;
  if (cycle.isError || !c) return <Alert>{errorMessage(cycle.error)}</Alert>;
  return (
    <div className="space-y-4">
      <Link to="/hrm/compensation/cycles" className="text-sm text-brand-700 underline">← All salary reviews</Link>
      <CycleSummary c={c} />
      <CycleActions c={c} />
      {c.status === 'DRAFT' && a.manage && <PopulationCard c={c} />}
      {c.status !== 'DRAFT' && <ProposalsCard c={c} />}
      {c.status === 'FINALIZED' && a.apply && <ApplyCard c={c} />}
    </div>
  );
}

function CycleSummary({ c }: { c: CompCycleDto }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat label={c.code} value={<span className="text-base">{c.name}</span>} hint={`${c.organization.name} · effective ${c.effectiveDate} · ${c.currency}`} />
      <Stat label="Status" value={<CompBadge status={c.status} />} hint={c.appliedAt ? `Applied ${c.appliedAt.slice(0, 10)}` : c.status === 'FINALIZED' ? 'Finalized — no salary changed until Apply' : undefined} />
      <Stat label="Population" value={c.population ? c.population.eligible : '—'} hint={c.population ? `${c.population.total} in scope · ${c.population.missingCompensation} without a salary record · ${c.population.currencyMismatch} other currency` : 'Frozen at activation'} />
      <Stat label="Progress" value={c.progress ? `${c.progress.approved} / ${c.population?.eligible ?? 0}` : '—'} hint={c.progress ? `approved · ${c.progress.submitted + c.progress.hrReview} submitted · ${c.progress.notStarted + c.progress.draft} open · ${c.progress.returned} returned` : undefined} />
      <Stat label="Budget" value={c.budget ? money(c.budget.remaining) : '—'} tone={c.budget?.overBudget ? 'danger' : undefined} hint={c.budget ? `remaining of ${money(c.budget.amount)} · used ${money(c.budget.used)} ${c.currency}` : 'No budget set'} />
    </div>
  );
}

function CycleActions({ c }: { c: CompCycleDto }) {
  const a = useCompAccess();
  const mut = useCompMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | 'activate' | 'start-review' | 'finalize' | 'archive'>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budget, setBudget] = useState(c.budget?.amount ?? '');
  const text: Record<string, [string, string]> = {
    activate: ['Activate this salary review?', 'The population and each person\'s current salary, department, job and manager are frozen as of today. Planners are notified.'],
    'start-review': ['Start HR review?', 'Every plannable row must be submitted. Submitted proposals move to HR review.'],
    finalize: ['Finalize this salary review?', 'Every proposal must be approved and the total increase within the budget. The plan is then frozen. No salary changes until someone applies it.'],
    archive: ['Archive this salary review?', 'An archived review can no longer be applied.'],
  };
  const run = async () => {
    try { await mut.transition.mutateAsync({ id: c.id, action: confirm! }); toast.success('Done'); setConfirm(null); }
    catch (e) { toast.error('Not possible yet', errorMessage(e)); setConfirm(null); }
  };
  const saveBudget = async () => {
    try { await mut.setBudget.mutateAsync({ id: c.id, budgetAmount: budget.trim() }); toast.success('Budget saved'); setBudgetOpen(false); }
    catch (e) { toast.error('Could not save', errorMessage(e)); }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {a.budget && ['DRAFT', 'ACTIVE', 'REVIEW'].includes(c.status) && <Button variant="secondary" onClick={() => { setBudget(c.budget?.amount ?? ''); setBudgetOpen(true); }}>{c.budget ? 'Change budget' : 'Set budget'}</Button>}
      {a.manage && c.status === 'DRAFT' && <Button onClick={() => setConfirm('activate')}>Activate</Button>}
      {(a.manage || a.review) && c.status === 'ACTIVE' && <Button onClick={() => setConfirm('start-review')}>Start HR review</Button>}
      {a.finalize && c.status === 'REVIEW' && <Button onClick={() => setConfirm('finalize')}>Finalize</Button>}
      {a.manage && (c.status === 'DRAFT' || c.status === 'FINALIZED') && <Button variant="ghost" onClick={() => setConfirm('archive')}>Archive</Button>}
      <ConfirmDialog open={!!confirm} title={confirm ? text[confirm]![0] : ''} message={confirm ? text[confirm]![1] : ''} loading={mut.transition.isPending} onConfirm={run} onCancel={() => setConfirm(null)} />
      <Modal open={budgetOpen} onClose={() => setBudgetOpen(false)} title="Increase budget" description={`A ceiling on the total base-salary increase in ${c.currency}. It reserves no payroll money.`}
        footer={<><Button variant="secondary" onClick={() => setBudgetOpen(false)}>Cancel</Button><Button disabled={!MONEY.test(budget.trim())} loading={mut.setBudget.isPending} onClick={saveBudget}>Save</Button></>}>
        <Input label={`Budget (${c.currency})`} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} error={budget && !MONEY.test(budget.trim()) ? 'Use an amount like 100000 or 100000.50' : undefined} />
      </Modal>
    </div>
  );
}

function PopulationCard({ c }: { c: CompCycleDto }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const pop = usePopulation(c.id, { page, pageSize: 50, search }, true);
  const mut = useCompMutations();
  const toast = useToast();
  const d = pop.data;
  const toggle = async (employeeId: string, excluded: boolean) => {
    try { await mut.setExclusion.mutateAsync({ id: c.id, employeeId, excluded }); } catch (e) { toast.error('Could not change', errorMessage(e)); }
  };
  return (
    <Card>
      <CardHeader title="Population preview" description="Active employees of the organization as of today. Nobody is included or left out because of performance, potential, age, tenure or any personal attribute — only the facts below, and your explicit exclusions." />
      <div className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-64"><Input label="Search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
        {d && <p className="text-sm text-slate-600">{d.counts.eligible} plannable · {d.counts.missingCompensation} without a salary record · {d.counts.currencyMismatch} other currency · {d.counts.excluded} excluded</p>}
      </div>
      {pop.isLoading && <LoadingBlock />}
      {d && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr>{['Employee', 'Department', 'Job', 'Manager', 'Current salary', 'Plannable', 'In review'].map((h) => <th key={h} scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{d.rows.map((r) => (
              <tr key={r.employeeId} className={r.excluded ? 'opacity-50' : ''}>
                <td className="px-4 py-2"><div className="font-medium">{r.name}</div><div className="text-xs text-slate-500">{r.code}</div></td>
                <td className="px-4 py-2">{r.department}</td><td className="px-4 py-2">{r.job ?? '—'}</td><td className="px-4 py-2">{r.managerName ?? '—'}</td>
                <td className="px-4 py-2 tabular-nums">{money(r.currentBaseSalary, r.currency)}</td>
                <td className="px-4 py-2"><CompBadge status={r.eligibility} /></td>
                <td className="px-4 py-2"><Checkbox label={r.excluded ? 'Excluded' : 'Included'} checked={!r.excluded} onChange={(e) => toggle(r.employeeId, !e.target.checked)} /></td>
              </tr>
            ))}</tbody>
          </table>
          <Pagination page={page} pageSize={50} total={d.meta.total} onPageChange={setPage} />
        </div>
      )}
    </Card>
  );
}

function ProposalsCard({ c }: { c: CompCycleDto }) {
  const a = useCompAccess();
  const opts = useCompOptions();
  const mut = useCompMutations();
  const toast = useToast();
  const [f, setF] = useState({ page: 1, departmentId: '', plannerUserId: '', status: '', search: '' });
  const rows = useCycleRows(c.id, { ...f, pageSize: 50 }, true);
  const [action, setAction] = useState<null | { kind: 'return' | 'override' | 'planner' | 'history'; row: CompRowDto }>(null);
  const { user } = useAuth();
  const mine = (r: CompRowDto) => !!user?.employee && r.employee.id === user.employee.id;
  const departments = (opts.data?.departments ?? []).filter((d) => d.organizationId === c.organization.id);
  const approveAll = async () => {
    try { const r = await mut.approveAll.mutateAsync({ id: c.id, plannerUserId: f.plannerUserId || undefined, departmentId: f.departmentId || undefined }); toast.success(`${r.approved} proposal(s) approved${r.skipped ? ` · ${r.skipped} left for another reviewer (your own row, or an amount you set)` : ''}`); }
    catch (e) { toast.error('Could not approve', errorMessage(e)); }
  };
  const approve = async (row: CompRowDto) => { try { await mut.approve.mutateAsync(row.proposalId!); } catch (e) { toast.error('Could not approve', errorMessage(e)); } };
  return (
    <Card>
      <CardHeader title="Proposals" description="Sorted by department and name only. Performance context is the latest finalized review, a fact — never an input to any number." />
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Input label="Search" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value, page: 1 })} />
        <Select label="Department" value={f.departmentId} placeholder="All" onChange={(e) => setF({ ...f, departmentId: e.target.value, page: 1 })} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
        <Select label="Planner" value={f.plannerUserId} placeholder="All" onChange={(e) => setF({ ...f, plannerUserId: e.target.value, page: 1 })} options={(c.planners.filter((p) => p.userId) as { userId: string; name: string | null }[]).map((p) => ({ value: p.userId, label: p.name ?? '—' }))} />
        <Select label="Status" value={f.status} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} options={['NOT_STARTED', 'DRAFT', 'SUBMITTED', 'HR_REVIEW', 'APPROVED', 'RETURNED'].map((s) => ({ value: s, label: titleCase(s) }))} />
        <div className="flex items-end">{a.review && c.status === 'REVIEW' && <Button variant="secondary" loading={mut.approveAll.isPending} onClick={approveAll}>Approve all under review{f.plannerUserId || f.departmentId ? ' (filtered)' : ''}</Button>}</div>
      </div>
      {c.planners.some((p) => !p.userId) && <div className="px-4"><Alert tone="info">{c.planners.find((p) => !p.userId)!.rows} plannable row(s) have no planner. Assign one from the row actions.</Alert></div>}
      {rows.isLoading && <LoadingBlock />}
      {rows.data && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr>{['Employee', 'Department', 'Planner', 'Current', 'Proposed', 'Increase', 'Performance context', 'Status', ''].map((h) => <th key={h} scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{rows.data.data.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2"><div className="font-medium">{r.employee.name}</div><div className="text-xs text-slate-500">{r.employee.code} · {r.job ?? '—'}</div>{r.managerComment && <div className="mt-1 max-w-xs text-xs italic text-slate-500">“{r.managerComment}”</div>}</td>
                <td className="px-3 py-2">{r.department ?? '—'}</td>
                <td className="px-3 py-2">{r.planner?.name ?? (r.eligibility === 'ELIGIBLE' ? <span className="text-amber-700">None</span> : '—')}</td>
                <td className="px-3 py-2 tabular-nums">{money(r.currentBaseSalary)}</td>
                <td className="px-3 py-2 tabular-nums">{money(r.proposedBaseSalary)}</td>
                <td className="px-3 py-2 tabular-nums">{money(r.increaseAmount)}{r.increasePercent ? ` (${r.increasePercent}%)` : ''}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{r.performance ? `${r.performance.rating ?? '—'}${r.performance.score ? ` (${r.performance.score})` : ''}` : '—'}</td>
                <td className="px-3 py-2">{r.eligibility === 'ELIGIBLE' ? <CompBadge status={r.status ?? 'NOT_STARTED'} /> : <CompBadge status={r.eligibility} />}{r.applied && <div className="mt-1 text-xs text-emerald-700">Applied</div>}</td>
                <td className="px-3 py-2"><div className="flex flex-wrap gap-1">
                  {r.proposalId && <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'history', row: r })}>History</Button>}
                  {/* Task 51: nobody reviews their own salary — the API refuses it; another reviewer does it */}
                  {mine(r) && <span className="text-xs text-slate-500">Yours — another reviewer decides</span>}
                  {!mine(r) && a.review && c.status === 'REVIEW' && r.status === 'HR_REVIEW' && <Button size="sm" variant="secondary" onClick={() => approve(r)}>Approve</Button>}
                  {!mine(r) && a.review && c.status === 'REVIEW' && ['HR_REVIEW', 'APPROVED'].includes(r.status ?? '') && <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'override', row: r })}>Change</Button>}
                  {!mine(r) && a.review && ['ACTIVE', 'REVIEW'].includes(c.status) && ['SUBMITTED', 'HR_REVIEW', 'APPROVED'].includes(r.status ?? '') && <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'return', row: r })}>Return</Button>}
                  {a.manage && ['ACTIVE', 'REVIEW'].includes(c.status) && r.eligibility === 'ELIGIBLE' && <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'planner', row: r })}>Planner</Button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
          <Pagination page={f.page} pageSize={50} total={rows.data.meta.total} onPageChange={(page) => setF({ ...f, page })} />
        </div>
      )}
      {action?.kind === 'history' && <HistoryModal row={action.row} onClose={() => setAction(null)} />}
      {action?.kind === 'return' && <ReasonModal title={`Return ${action.row.employee.name}'s proposal`} reasons={COMP_RETURN_REASONS} onClose={() => setAction(null)} onSave={(reasonCode) => mut.returnToPlanner.mutateAsync({ proposalId: action.row.proposalId!, reasonCode })} />}
      {action?.kind === 'override' && <ReasonModal title={`Change ${action.row.employee.name}'s proposed salary`} reasons={COMP_OVERRIDE_REASONS} amount={action.row.proposedBaseSalary ?? ''} currency={c.currency} onClose={() => setAction(null)} onSave={(reasonCode, amount) => mut.override.mutateAsync({ proposalId: action.row.proposalId!, proposedBaseSalary: amount!, reasonCode })} />}
      {action?.kind === 'planner' && <PlannerModal row={action.row} planners={opts.data?.planners ?? []} onClose={() => setAction(null)} onSave={(plannerUserId, reasonCode) => mut.reassign.mutateAsync({ cycleEmployeeId: action.row.id, plannerUserId, reasonCode })} />}
    </Card>
  );
}

function ReasonModal({ title, reasons, amount, currency, onClose, onSave }: { title: string; reasons: readonly string[]; amount?: string; currency?: string; onClose: () => void; onSave: (reasonCode: string, amount?: string) => Promise<unknown> }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [value, setValue] = useState(amount ?? '');
  const [busy, setBusy] = useState(false);
  const withAmount = amount !== undefined;
  const ok = !!reason && (!withAmount || MONEY.test(value.trim()));
  const save = async () => { setBusy(true); try { await onSave(reason, withAmount ? value.trim() : undefined); toast.success('Saved'); onClose(); } catch (e) { toast.error('Could not save', errorMessage(e)); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} title={title} description="Recorded in the proposal's history with your name and the reason." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!ok} loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        {withAmount && <Input label={`Proposed salary (${currency})`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}
        <Select label="Reason" value={reason} placeholder="Choose…" onChange={(e) => setReason(e.target.value)} options={reasonOptions(reasons)} />
      </div>
    </Modal>
  );
}

function PlannerModal({ row, planners, onClose, onSave }: { row: CompRowDto; planners: { userId: string; name: string }[]; onClose: () => void; onSave: (plannerUserId: string | null, reasonCode: string) => Promise<unknown> }) {
  const toast = useToast();
  const [who, setWho] = useState(row.planner?.userId ?? '');
  const [reason, setReason] = useState('');
  const save = async () => { try { await onSave(who || null, reason); toast.success('Planner changed'); onClose(); } catch (e) { toast.error('Could not change', errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title={`Planner for ${row.employee.name}`} description="The activation snapshot is kept; this records an explicit reassignment." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!reason} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        <Select label="Planner" value={who} placeholder="No planner" onChange={(e) => setWho(e.target.value)} options={planners.map((p) => ({ value: p.userId, label: p.name }))} />
        <Select label="Reason" value={reason} placeholder="Choose…" onChange={(e) => setReason(e.target.value)} options={reasonOptions(COMP_PLANNER_REASONS)} />
      </div>
    </Modal>
  );
}

function HistoryModal({ row, onClose }: { row: CompRowDto; onClose: () => void }) {
  const h = useProposalHistory(row.proposalId);
  return (
    <Modal open onClose={onClose} title={`History — ${row.employee.name}`} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {h.isLoading && <LoadingBlock />}
      <ol className="space-y-2 text-sm">{(h.data ?? []).map((x, i) => (
        <li key={i} className="rounded border border-slate-100 p-2"><div className="font-medium">{titleCase(x.action)}{x.reasonCode ? ` · ${titleCase(x.reasonCode)}` : ''}</div>
          <div className="text-xs text-slate-500">{x.at.slice(0, 16).replace('T', ' ')} · {x.actorName ?? '—'}{x.oldProposedBaseSalary !== x.newProposedBaseSalary ? ` · ${money(x.oldProposedBaseSalary)} → ${money(x.newProposedBaseSalary)}` : ''}</div></li>
      ))}</ol>
    </Modal>
  );
}

function ApplyCard({ c }: { c: CompCycleDto }) {
  const preview = useApplyPreview(c.id, true);
  const mut = useCompMutations();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const p = preview.data;
  const run = async () => {
    try { const r = await mut.apply.mutateAsync(c.id); toast.success('Applied to salary history', `${r.applied} new salary record(s), ${r.noChange} without change.`); setOpen(false); }
    catch (e) { toast.error('Not applied', errorMessage(e)); setOpen(false); }
  };
  return (
    <Card>
      <CardHeader title="Apply to salary history" description={`Creates new salary records effective ${c.effectiveDate} through the payroll compensation source. Existing records are closed the day before, never rewritten. All or nothing.`} />
      <div className="space-y-3 p-4">
        {preview.isLoading && <LoadingBlock />}
        {preview.isError && <Alert>{errorMessage(preview.error)}</Alert>}
        {p && (p.alreadyApplied ? <Alert tone="success">This review was applied on {c.appliedAt?.slice(0, 10)}.</Alert> : <>
          <p className="text-sm text-slate-700">{p.toApply} salary change(s) · {p.noChange} without change.</p>
          {p.blockers.length > 0 && <Alert tone="error"><div className="font-medium">Reconcile before applying:</div><ul className="mt-1 list-disc pl-5">{p.blockers.map((b) => <li key={b.employeeCode}>{b.employeeCode} {b.employeeName} — {b.reason === 'SOURCE_COMPENSATION_CHANGED' ? 'salary record changed since the review started' : b.reason === 'EMPLOYEE_NOT_ACTIVE' ? 'no longer an active employee' : 'current salary already paid past the new start date'}</li>)}</ul></Alert>}
          <Button disabled={p.blockers.length > 0} onClick={() => setOpen(true)}>Apply {p.toApply} change(s)</Button>
        </>)}
      </div>
      <ConfirmDialog open={open} title="Apply this salary review?" message={`New salary records will start on ${c.effectiveDate}. This cannot be undone from this screen.`} confirmLabel="Apply" loading={mut.apply.isPending} onConfirm={run} onCancel={() => setOpen(false)} />
    </Card>
  );
}
