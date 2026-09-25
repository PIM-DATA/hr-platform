import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type OnboardingPlanDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useLifecycleMutations, useOnboardingPlan, useOnboardingPlans, useProbationPolicies, useTemplates } from './lifecycle.api';
import { LifecycleBadge, Progress, SnapshotVsCurrent, TaskRow, titleCase } from './lifecycle-ui';

export function OnboardingPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.ONBOARDING_MANAGE);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const openId = params.get('open');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('open', id); else n.delete('open'); setParams(n, { replace: true }); };
  const list = useOnboardingPlans({ status, page, pageSize: 20 });
  const columns: Column<OnboardingPlanDto>[] = [
    { key: 'e', header: 'New joiner', render: (p) => <div><div className="font-medium text-slate-900">{p.snapshot.employeeName}</div><div className="text-xs text-slate-400">{p.snapshot.employeeCode} · {p.snapshot.department ?? '—'} · {p.snapshot.job ?? p.snapshot.position ?? '—'}</div></div> },
    { key: 'start', header: 'Start', render: (p) => p.startDate },
    { key: 'prog', header: 'Progress', hideBelow: 'sm', render: (p) => <Progress pct={p.progress.pct} hint={`${p.progress.done}/${p.progress.total}`} /> },
    { key: 'flags', header: 'Attention', hideBelow: 'md', render: (p) => <span className="text-xs text-slate-600">{p.overdueTasks > 0 && <span className="mr-2 text-red-700">{p.overdueTasks} overdue</span>}{p.unassignedTasks > 0 && <span className="text-amber-800">{p.unassignedTasks} unassigned</span>}</span> },
    { key: 'status', header: 'Status', render: (p) => <LifecycleBadge status={p.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div />
          {manage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Start onboarding</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load onboarding plans.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(p) => p.id} loading={list.isLoading} onRowClick={(p) => setOpen(p.id)} emptyTitle="No onboarding plans" emptyDescription="Start onboarding for a new employee from a template." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {creating && <CreatePlanModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {openId && <PlanModal id={openId} onClose={() => setOpen(null)} />}
    </>
  );
}

export function CreatePlanModal({ onClose, onCreated, presetEmployeeId }: { onClose: () => void; onCreated: (id: string) => void; presetEmployeeId?: string }) {
  const m = useLifecycleMutations();
  const templates = useTemplates({ type: 'ONBOARDING' });
  const policies = useProbationPolicies();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(presetEmployeeId ? ({ id: presetEmployeeId } as PayrollEmployeeOption) : null);
  const [form, setForm] = useState({ templateId: '', startDate: '', createProbation: false, probationPolicyId: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); if (!employee) return; try { const p = await m.createPlan.mutateAsync({ employeeId: employee.id, templateId: form.templateId || null, startDate: form.startDate || undefined, createProbation: form.createProbation, probationPolicyId: form.probationPolicyId || null }); onCreated(p.id); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="Start onboarding" description="For an employee record that already exists (created by HR or by a recruitment hire). No account is created here." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createPlan.isPending} disabled={!employee}>Create draft plan</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        {!presetEmployeeId && <EmployeePicker value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" />}
        <Select label="Template" options={(templates.data ?? []).map((t) => ({ value: t.id, label: `${t.name} (${t.taskCount} tasks)` }))} placeholder="No template (add tasks by hand)" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} />
        <Input label="Start date (defaults to the hire date)" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        <Checkbox label="Also open a probation case" checked={form.createProbation} onChange={(e) => setForm({ ...form, createProbation: e.target.checked })} />
        {form.createProbation && <Select label="Probation policy" options={(policies.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.durationDays} days)` }))} placeholder="Choose a policy" value={form.probationPolicyId} onChange={(e) => setForm({ ...form, probationPolicyId: e.target.value })} />}
      </div>
    </Modal>
  );
}

function PlanModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.ONBOARDING_MANAGE);
  const plan = useOnboardingPlan(id);
  const m = useLifecycleMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'activate' | 'complete' | 'cancel' | null>(null);
  const [adding, setAdding] = useState(false);
  const [task, setTask] = useState({ title: '', category: 'OTHER', assigneeType: 'HR', dueDate: '', required: true });
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); } catch (e) { toast.error(errorMessage(e)); } };
  if (plan.isLoading) return <Modal open onClose={onClose} title="Onboarding"><LoadingBlock /></Modal>;
  if (!plan.data) return <Modal open onClose={onClose} title="Onboarding"><Alert>Could not load this plan.</Alert></Modal>;
  const d = plan.data;
  return (
    <Modal open onClose={onClose} title={`${d.snapshot.employeeName} — onboarding`} description={`${d.snapshot.employeeCode} · start ${d.startDate}${d.templateName ? ` · ${d.templateName}` : ''}`} size="lg"
      footer={<>{d.can.activate && <Button onClick={() => setConfirm('activate')}>Activate</Button>}{d.can.complete && <Button onClick={() => setConfirm('complete')}>Mark onboarding completed</Button>}{manage && (d.status === 'DRAFT' || d.status === 'ACTIVE') && <Button variant="ghost" onClick={() => setConfirm('cancel')}>Cancel plan</Button>}{manage && (d.status === 'DRAFT' || d.status === 'ACTIVE') && <Button variant="ghost" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Task</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm"><LifecycleBadge status={d.status} /><Progress pct={d.progress.pct} hint={`${d.progress.done}/${d.progress.total} · ${d.progress.requiredOpen} required open`} />{d.unassignedTasks > 0 && <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">{d.unassignedTasks} task(s) unassigned — the new joiner has no account yet; reassign or wait for the account</span>}</div>
        <SnapshotVsCurrent snapshot={d.snapshot} current={d.current} />
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200" data-testid="plan-tasks">{d.tasks.map((t) => <TaskRow key={t.id} task={t} manage={manage} onUpdate={(input) => m.updateOnboardingTask.mutateAsync({ id: t.id, input: input as never })} />)}</ul>
        <p className="text-xs text-slate-400">Progress = completed or skipped tasks ÷ tasks in the checklist (cancelled excluded). A percentage is bookkeeping, not a readiness verdict.</p>
      </div>
      <ConfirmDialog open={confirm === 'activate'} title="Activate this plan?" message="Assignees are resolved and notified. Tasks for a new joiner without an account stay unassigned until HR reassigns them." confirmLabel="Activate" loading={m.activatePlan.isPending} onConfirm={() => { act(() => m.activatePlan.mutateAsync(id), 'Plan activated'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'complete'} title="Mark onboarding completed?" message="Every required task is done. Open optional tasks are cancelled. Nothing changes on the employee record." confirmLabel="Complete" loading={m.completePlan.isPending} onConfirm={() => { act(() => m.completePlan.mutateAsync(id), 'Onboarding completed'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this plan?" message="Open tasks are cancelled and kept as history. The employee record is not affected." confirmLabel="Cancel plan" variant="danger" loading={m.cancelPlan.isPending} onConfirm={() => { act(() => m.cancelPlan.mutateAsync(id), 'Plan cancelled'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a task" footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button onClick={() => { act(() => m.addPlanTask.mutateAsync({ id, input: { title: task.title, category: task.category, assigneeType: task.assigneeType as never, dueDate: task.dueDate, required: task.required } }), 'Task added'); setAdding(false); }} disabled={!task.title || !task.dueDate}>Add</Button></>}>
        <div className="space-y-3"><Input label="Title" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} /><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Category" options={['PRE_START', 'DAY_1', 'FIRST_WEEK', 'FIRST_MONTH', 'DOCUMENT', 'ACCESS', 'OTHER'].map((c) => ({ value: c, label: titleCase(c) }))} value={task.category} onChange={(e) => setTask({ ...task, category: e.target.value })} /><Select label="Assignee" options={['EMPLOYEE', 'MANAGER', 'HR'].map((c) => ({ value: c, label: titleCase(c) }))} value={task.assigneeType} onChange={(e) => setTask({ ...task, assigneeType: e.target.value })} /><Input label="Due" type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })} /></div><Checkbox label="Required" checked={task.required} onChange={(e) => setTask({ ...task, required: e.target.checked })} /></div>
      </Modal>
    </Modal>
  );
}
