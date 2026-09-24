import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Sparkles } from 'lucide-react';
import { PERMISSIONS, WORKFORCE_PLAN_REASONS, WORKFORCE_PRIORITIES, type WorkforcePlanItemDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useMovements, usePlanItems, useWorkforceMutations, useWorkforceOptions } from './workforce.api';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { CyclePicker, CycleStatusBadge, Delta, DeltaBadge, titleCase, useSelectedCycle } from './workforce-ui';

/**
 * The headcount plan table: department × job, current (snapshot) vs planned, delta, reason, priority, target date and
 * the recruitment demand already in flight. Editable while the cycle is a draft. "Create requisition" is the only
 * bridge to another module and it is a person's explicit choice of openings.
 */
export function HeadcountPlanPage() {
  const { hasPermission } = useAuth();
  const canPlan = hasPermission(PERMISSIONS.WORKFORCE_PLAN) || hasPermission(PERMISSIONS.WORKFORCE_MANAGE);
  const canHandoff = hasPermission(PERMISSIONS.WORKFORCE_MANAGE) && hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const sel = useSelectedCycle();
  const [classification, setClassification] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const items = usePlanItems(sel.selected, { classification, departmentId });
  const options = useWorkforceOptions();
  const m = useWorkforceMutations();
  const toast = useToast();
  const [editing, setEditing] = useState<WorkforcePlanItemDto | null>(null);
  const [handoff, setHandoff] = useState<WorkforcePlanItemDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmInit, setConfirmInit] = useState(false);
  const editable = !!sel.cycle && sel.cycle.status === 'DRAFT' && canPlan;
  const initialize = async () => { if (!sel.selected) return; try { const r = await m.initialize.mutateAsync(sel.selected); toast.success(`${r.created} row(s) added from the current workforce${r.existing ? `, ${r.existing} already present` : ''}`); } catch (e) { toast.error(errorMessage(e)); } setConfirmInit(false); };
  const columns: Column<WorkforcePlanItemDto>[] = [
    { key: 'dept', header: 'Department', render: (r) => <span className="font-medium text-slate-900">{r.departmentName}</span> },
    { key: 'job', header: 'Job', render: (r) => r.jobTitle ?? <span className="text-slate-400">No job assigned</span> },
    { key: 'cur', header: 'Current', render: (r) => <span className="tabular-nums" title={`Snapshot ${new Date(r.snapshotAt).toLocaleDateString()}${r.currentHeadcountLive !== null && r.currentHeadcountLive !== r.currentHeadcountSnapshot ? ` · live today ${r.currentHeadcountLive}` : ''}`}>{r.currentHeadcountSnapshot}{r.currentHeadcountLive !== null && r.currentHeadcountLive !== r.currentHeadcountSnapshot && <span className="ml-1 text-xs text-slate-400">(now {r.currentHeadcountLive})</span>}</span> },
    { key: 'plan', header: 'Planned', render: (r) => <span className="tabular-nums font-medium">{r.plannedHeadcount}</span> },
    { key: 'delta', header: 'Delta', render: (r) => <div className="flex items-center gap-2"><Delta value={r.delta} /><span className="hidden sm:inline"><DeltaBadge classification={r.classification} /></span></div> },
    { key: 'reason', header: 'Reason', hideBelow: 'md', render: (r) => (r.reason ? titleCase(r.reason) : <span className="text-slate-400">—</span>) },
    { key: 'prio', header: 'Priority', hideBelow: 'md', render: (r) => (r.priority ? titleCase(r.priority) : <span className="text-slate-400">—</span>) },
    { key: 'target', header: 'Target', hideBelow: 'lg', render: (r) => r.targetDate ?? <span className="text-slate-400">—</span> },
    { key: 'rec', header: 'Recruitment', hideBelow: 'lg', render: (r) => (
      <div className="text-xs text-slate-600">
        <div>open demand <span className="tabular-nums font-medium">{r.recruitment.openRecruitmentDemand}</span>{r.recruitment.approvedRequisitions > 0 && <> · {r.recruitment.approvedRequisitions} approved req.</>}{r.recruitment.pendingRequisitions > 0 && <> · {r.recruitment.pendingRequisitions} pending</>}</div>
        {r.delta > 0 && <div>remaining <span className="tabular-nums font-medium">{r.remainingDemand}</span></div>}
        {r.requisitions.map((q) => <div key={q.id}><Link to="/hrm/recruitment/requisitions" className="text-brand-700 underline">{q.requisitionNumber}</Link> · {titleCase(q.status)} · {q.requestedOpenings}</div>)}
      </div>
    ) },
    { key: 'actions', header: '', render: (r) => (
      <div className="flex justify-end gap-1">
        {editable && <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>}
        {canHandoff && r.delta > 0 && r.jobId && sel.cycle?.status !== 'ARCHIVED' && <Button size="sm" variant="secondary" onClick={() => setHandoff(r)}>Create requisition</Button>}
      </div>
    ) },
  ];
  return (
    <>
      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
          <CyclePicker value={sel.selected} onChange={sel.set} cycles={sel.cycles} />
          <Select label="Department" options={(options.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} />
          <Select label="Classification" options={[{ value: 'EXPANSION', label: 'Expansion' }, { value: 'NO_CHANGE', label: 'No change' }, { value: 'REDUCTION_PLANNED', label: 'Reduction planned' }]} placeholder="All rows" value={classification} onChange={(e) => setClassification(e.target.value)} />
          <div className="flex flex-wrap items-end justify-end gap-2">
            {editable && <Button variant="secondary" onClick={() => setConfirmInit(true)}><Sparkles className="h-4 w-4" /> Initialize from current workforce</Button>}
            {editable && <Button variant="ghost" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Row</Button>}
          </div>
        </div>
        {sel.cycle && <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-2 text-xs text-slate-500"><CycleStatusBadge status={sel.cycle.status} /> {sel.cycle.periodStart} → {sel.cycle.periodEnd}{sel.cycle.status !== 'DRAFT' && <> · read-only{sel.cycle.status === 'FINALIZED' && ' — current figures frozen at finalization'}</>}</div>}
      </Card>
      {!sel.selected && !sel.loading && <Card className="p-8 text-center text-sm text-slate-500">Create a planning cycle first (Planning cycles tab).</Card>}
      {sel.selected && (
        <Card>
          {items.isLoading && <LoadingBlock />}
          {items.isError && <Alert className="m-4">Could not load the plan.</Alert>}
          {items.data && <DataTable columns={columns} rows={items.data} rowKey={(r) => r.id} emptyTitle="No plan rows yet" emptyDescription={editable ? 'Initialize from the current workforce, then adjust the planned figures.' : 'This plan has no rows.'} />}
        </Card>
      )}
      {sel.selected && <MovementsPanel cycleId={sel.selected} editable={editable} />}
      <ConfirmDialog open={confirmInit} title="Initialize from current workforce?" message="Adds one row per department and job with planned = current. Rows already in the plan are left untouched." confirmLabel="Initialize" loading={m.initialize.isPending} onConfirm={initialize} onCancel={() => setConfirmInit(false)} />
      {editing && <EditItemModal item={editing} onClose={() => setEditing(null)} />}
      {handoff && <HandoffModal item={handoff} onClose={() => setHandoff(null)} />}
      {adding && sel.selected && <AddRowModal cycleId={sel.selected} onClose={() => setAdding(false)} />}
    </>
  );
}

function EditItemModal({ item, onClose }: { item: WorkforcePlanItemDto; onClose: () => void }) {
  const m = useWorkforceMutations();
  const toast = useToast();
  const [form, setForm] = useState({ plannedHeadcount: String(item.plannedHeadcount), reason: item.reason ?? '', priority: item.priority ?? '', targetDate: item.targetDate ?? '', notes: item.notes ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const planned = Number(form.plannedHeadcount);
  const delta = Number.isFinite(planned) ? planned - item.currentHeadcountSnapshot : 0;
  const submit = async () => { setErr(null); try { await m.updateItem.mutateAsync({ id: item.id, input: { plannedHeadcount: planned, reason: (form.reason || null) as never, priority: (form.priority || null) as never, targetDate: form.targetDate || null, notes: form.notes || null } }); toast.success('Plan row updated'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  const remove = async () => { try { await m.removeItem.mutateAsync(item.id); toast.success('Row removed'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title={`${item.departmentName} · ${item.jobTitle ?? 'No job assigned'}`} description={`Current ${item.currentHeadcountSnapshot} (snapshot ${new Date(item.snapshotAt).toLocaleDateString()})`} footer={<><Button variant="ghost" onClick={remove} disabled={item.requisitions.length > 0}>Remove row</Button><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.updateItem.isPending}>Save</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Planned headcount" type="number" min={0} value={form.plannedHeadcount} onChange={(e) => setForm({ ...form, plannedHeadcount: e.target.value })} />
          <div className="self-end text-sm text-slate-600">Delta: <Delta value={delta} /> {delta > 0 ? '(expansion)' : delta < 0 ? '(reduction planned)' : '(no change)'}</div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select label="Reason" options={WORKFORCE_PLAN_REASONS.map((r) => ({ value: r, label: titleCase(r) }))} placeholder="—" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <Select label="Priority" options={WORKFORCE_PRIORITIES.map((r) => ({ value: r, label: titleCase(r) }))} placeholder="—" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          <Input label="Target date" type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
        </div>
        <Textarea label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        {delta < 0 && <p className="text-xs text-slate-500">A planned reduction is a number. The system does not select or list people for it.</p>}
      </div>
    </Modal>
  );
}

function HandoffModal({ item, onClose }: { item: WorkforcePlanItemDto; onClose: () => void }) {
  const m = useWorkforceMutations();
  const toast = useToast();
  const [openings, setOpenings] = useState(String(Math.max(1, item.remainingDemand)));
  const [reason, setReason] = useState('');
  const [start, setStart] = useState(item.targetDate ?? '');
  const [justification, setJustification] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); try { const r = await m.createRequisition.mutateAsync({ id: item.id, input: { requestedOpenings: Number(openings), reason: (reason || undefined) as never, desiredStartDate: start || null, justification: justification || null } }); toast.success(`Requisition ${r.requisitionNumber} created as a draft in Recruitment`); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="Create recruitment requisition" description={`${item.departmentName} · ${item.jobTitle}. The requisition is created as a draft by the recruitment module; submit and approve it there.`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createRequisition.isPending}>Create draft requisition</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><div className="text-xs text-slate-500">Current</div><div className="tabular-nums font-medium">{item.currentHeadcountSnapshot}</div></div>
          <div><div className="text-xs text-slate-500">Planned</div><div className="tabular-nums font-medium">{item.plannedHeadcount}</div></div>
          <div><div className="text-xs text-slate-500">Open recruitment</div><div className="tabular-nums font-medium">{item.recruitment.openRecruitmentDemand}</div></div>
          <div><div className="text-xs text-slate-500">Remaining delta</div><div className="tabular-nums font-medium">{item.remainingDemand}</div></div>
        </div>
        <Input label="Requested openings (your choice)" type="number" min={1} value={openings} onChange={(e) => setOpenings(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="Reason" options={['NEW_HEADCOUNT', 'REPLACEMENT', 'TEMPORARY', 'OTHER'].map((r) => ({ value: r, label: titleCase(r) }))} placeholder={`Default from plan reason${item.reason ? ` (${titleCase(item.reason)})` : ''}`} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Input label="Desired start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <Textarea label="Justification (optional — defaults to the plan figures)" value={justification} onChange={(e) => setJustification(e.target.value)} />
      </div>
    </Modal>
  );
}

function AddRowModal({ cycleId, onClose }: { cycleId: string; onClose: () => void }) {
  const m = useWorkforceMutations();
  const options = useWorkforceOptions();
  const toast = useToast();
  const [departmentId, setDepartmentId] = useState('');
  const [jobId, setJobId] = useState('');
  const [planned, setPlanned] = useState('0');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); try { await m.addItem.mutateAsync({ cycleId, input: { departmentId, jobId: jobId || null, plannedHeadcount: Number(planned) } }); toast.success('Row added'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="Add a plan row" description="For a department and job with nobody today, e.g. a new function. The current figure is read from the live workforce." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.addItem.isPending} disabled={!departmentId}>Add</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Department" options={(options.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Choose" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} />
        <Select label="Job" options={(options.data?.jobs ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="No job" value={jobId} onChange={(e) => setJobId(e.target.value)} />
        <Input label="Planned headcount" type="number" min={0} value={planned} onChange={(e) => setPlanned(e.target.value)} />
      </div>
    </Modal>
  );
}

/** Planned movements: records of intent listed under the plan. The employee master never changes here. */
export function MovementsPanel({ cycleId, editable }: { cycleId: string; editable: boolean }) {
  const { hasPermission } = useAuth();
  const canPlan = hasPermission(PERMISSIONS.WORKFORCE_PLAN) || hasPermission(PERMISSIONS.WORKFORCE_MANAGE);
  const list = useMovements(cycleId, canPlan);
  const m = useWorkforceMutations();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  if (!canPlan) return null;
  return (
    <Card className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900"><span>Planned movements <span className="ml-1 text-xs font-normal text-slate-400">records only — a transfer is executed on the employee's page</span></span>{editable && <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Movement</Button>}</div>
      {adding && <MovementModal cycleId={cycleId} onClose={() => setAdding(false)} />}
      {list.data?.length === 0 && <p className="px-4 py-3 text-sm text-slate-400">None recorded.</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {(list.data ?? []).map((mv) => (
          <li key={mv.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span>{mv.employee ? `${mv.employee.firstName} ${mv.employee.lastName} (${mv.employee.employeeCode})` : 'Unnamed'} · {mv.fromDepartment?.name ?? '?'} → {mv.toDepartment?.name ?? mv.fromDepartment?.name ?? '?'}{mv.toJob && ` · ${mv.toJob.title}`}{mv.targetDate && ` · ${mv.targetDate}`} · {titleCase(mv.status)}</span>
            {mv.status === 'PLANNED' && <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={async () => { try { await m.updateMovement.mutateAsync({ id: mv.id, input: { status: 'COMPLETED_EXTERNALLY' } }); } catch (e) { toast.error(errorMessage(e)); } }}>Mark done externally</Button><Button size="sm" variant="ghost" onClick={async () => { try { await m.updateMovement.mutateAsync({ id: mv.id, input: { status: 'CANCELLED' } }); } catch (e) { toast.error(errorMessage(e)); } }}>Cancel</Button></span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MovementModal({ cycleId, onClose }: { cycleId: string; onClose: () => void }) {
  const m = useWorkforceMutations();
  const options = useWorkforceOptions();
  const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [form, setForm] = useState({ toDepartmentId: '', toJobId: '', targetDate: '', notes: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); try { await m.createMovement.mutateAsync({ cycleId, input: { employeeId: employee?.id ?? null, fromDepartmentId: employee?.department?.id ?? null, toDepartmentId: form.toDepartmentId || null, toJobId: form.toJobId || null, targetDate: form.targetDate || null, notes: form.notes || null } }); toast.success('Planned movement recorded'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="Plan a movement" description="A record of intent for the plan. The employee's record does not change; the transfer is executed on the employee's page when decided." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createMovement.isPending} disabled={!form.toDepartmentId && !form.toJobId}>Record</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker label="Employee (optional)" value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="To department" options={(options.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Unchanged" value={form.toDepartmentId} onChange={(e) => setForm({ ...form, toDepartmentId: e.target.value })} />
          <Select label="To job" options={(options.data?.jobs ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="Unchanged" value={form.toJobId} onChange={(e) => setForm({ ...form, toJobId: e.target.value })} />
        </div>
        <Input label="Target date" type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
        <Textarea label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
    </Modal>
  );
}
