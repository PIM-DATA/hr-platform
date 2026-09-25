import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { EXIT_REASON_CATEGORIES, OFFBOARDING_REASONS, PERMISSIONS, type OffboardingCaseDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useLifecycleMutations, useOffboardingCase, useOffboardingCases, useTemplates } from './lifecycle.api';
import { LifecycleBadge, Progress, SnapshotVsCurrent, TaskRow, titleCase } from './lifecycle-ui';

export function OffboardingPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.OFFBOARDING_MANAGE);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const openId = params.get('open');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('open', id); else n.delete('open'); setParams(n, { replace: true }); };
  const list = useOffboardingCases({ status, page, pageSize: 20 });
  const columns: Column<OffboardingCaseDto>[] = [
    { key: 'e', header: 'Employee', render: (c) => <div><div className="font-medium text-slate-900">{c.snapshot.employeeName}</div><div className="text-xs text-slate-400">{c.snapshot.employeeCode} · {c.snapshot.department ?? '—'} · {titleCase(c.reasonCode)}</div></div> },
    { key: 'last', header: 'Last working day', render: (c) => <span className="tabular-nums">{c.actualLastWorkingDate ?? c.plannedLastWorkingDate}{c.actualLastWorkingDate && c.actualLastWorkingDate !== c.plannedLastWorkingDate && <span className="ml-1 text-xs text-slate-400">(planned {c.plannedLastWorkingDate})</span>}</span> },
    { key: 'prog', header: 'Checklist', hideBelow: 'sm', render: (c) => <Progress pct={c.progress.pct} hint={`${c.progress.done}/${c.progress.total}`} /> },
    { key: 'status', header: 'Status', render: (c) => <LifecycleBadge status={c.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={['DRAFT', 'ACTIVE', 'READY_TO_COMPLETE', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div />
          {manage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Offboarding case</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load offboarding cases.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} onRowClick={(c) => setOpen(c.id)} emptyTitle="No offboarding cases" emptyDescription="Open a case when a departure is agreed. Nothing changes on the employee record until the separation is completed." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {creating && <CreateCaseModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {openId && <CaseModal id={openId} onClose={() => setOpen(null)} />}
    </>
  );
}

function CreateCaseModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const m = useLifecycleMutations();
  const templates = useTemplates({ type: 'OFFBOARDING' });
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [form, setForm] = useState({ templateId: '', reasonCode: 'RESIGNATION', reasonNote: '', plannedLastWorkingDate: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); if (!employee) return; try { const c = await m.createOffboarding.mutateAsync({ employeeId: employee.id, templateId: form.templateId || null, reasonCode: form.reasonCode as never, reasonNote: form.reasonNote || null, plannedLastWorkingDate: form.plannedLastWorkingDate }); onCreated(c.id); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="New offboarding case" description="A draft case with a checklist. The employee record is untouched until you complete the separation." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createOffboarding.isPending} disabled={!employee || !form.plannedLastWorkingDate}>Create draft case</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Reason" options={OFFBOARDING_REASONS.map((r) => ({ value: r, label: titleCase(r) }))} value={form.reasonCode} onChange={(e) => setForm({ ...form, reasonCode: e.target.value })} /><Input label="Planned last working day" type="date" value={form.plannedLastWorkingDate} onChange={(e) => setForm({ ...form, plannedLastWorkingDate: e.target.value })} /><Select label="Template" options={(templates.data ?? []).map((t) => ({ value: t.id, label: `${t.name} (${t.taskCount} tasks)` }))} placeholder="No template" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} /></div>
        <Textarea label="Reason note (HR confidential — never shown to the employee, the manager or executives)" value={form.reasonNote} onChange={(e) => setForm({ ...form, reasonNote: e.target.value })} />
      </div>
    </Modal>
  );
}

function CaseModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.OFFBOARDING_MANAGE);
  const c = useOffboardingCase(id);
  const m = useLifecycleMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'activate' | 'cancel' | 'separation' | null>(null);
  const [sep, setSep] = useState({ actualLastWorkingDate: '', disableAccount: true });
  const [exit, setExit] = useState<{ open: boolean; interviewDate: string; reasonCategory: string; wouldRejoin: string; note: string }>({ open: false, interviewDate: '', reasonCategory: '', wouldRejoin: '', note: '' });
  const [adding, setAdding] = useState(false);
  const [task, setTask] = useState({ title: '', category: 'HANDOVER', assigneeType: 'EMPLOYEE', dueDate: '', required: true });
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); } catch (e) { toast.error(errorMessage(e)); } };
  if (c.isLoading) return <Modal open onClose={onClose} title="Offboarding"><LoadingBlock /></Modal>;
  if (!c.data) return <Modal open onClose={onClose} title="Offboarding"><Alert>Could not load this case.</Alert></Modal>;
  const d = c.data;
  return (
    <Modal open onClose={onClose} title={`${d.snapshot.employeeName} — offboarding`} description={`${d.snapshot.employeeCode} · ${titleCase(d.reasonCode)} · planned last day ${d.plannedLastWorkingDate}`} size="lg"
      footer={<>{d.can.activate && <Button onClick={() => setConfirm('activate')}>Activate</Button>}{d.can.completeSeparation && <Button onClick={() => setConfirm('separation')}>Complete employment separation</Button>}{d.can.cancel && <Button variant="ghost" onClick={() => setConfirm('cancel')}>Cancel case</Button>}{manage && d.status !== 'CANCELLED' && <Button variant="ghost" onClick={() => setExit({ ...exit, open: true, interviewDate: d.exitInterview?.interviewDate ?? '', reasonCategory: d.exitInterview?.reasonCategory ?? '', wouldRejoin: d.exitInterview?.wouldRejoin === null || d.exitInterview?.wouldRejoin === undefined ? '' : String(d.exitInterview.wouldRejoin), note: d.exitInterview?.note ?? '' })}>Exit interview</Button>}{manage && (d.status === 'DRAFT' || d.status === 'ACTIVE' || d.status === 'READY_TO_COMPLETE') && <Button variant="ghost" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Task</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm"><LifecycleBadge status={d.status} /><Progress pct={d.progress.pct} hint={`${d.progress.done}/${d.progress.total} · ${d.progress.requiredOpen} required open`} />{d.separation && <span className="text-xs text-slate-600">separated {new Date(d.separation.completedAt).toLocaleDateString()} · account {d.separation.accountDisabled ? `disabled, ${d.separation.sessionsRevoked} session(s) revoked` : 'left active'}</span>}</div>
        <SnapshotVsCurrent snapshot={d.snapshot} current={d.current} />
        {d.reasonNote !== null && <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><b>HR-confidential reason note:</b> {d.reasonNote || '—'}</div>}
        {d.exitInterview && <div className="rounded-md border border-slate-200 p-2 text-xs text-slate-700"><b>Exit interview</b> {d.exitInterview.interviewDate}{d.exitInterview.reasonCategory && ` · ${titleCase(d.exitInterview.reasonCategory)}`}{d.exitInterview.wouldRejoin !== null && ` · would rejoin: ${d.exitInterview.wouldRejoin ? 'yes' : 'no'}`}{d.exitInterview.note && <div className="mt-1">{d.exitInterview.note}</div>}</div>}
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200" data-testid="case-tasks">{d.tasks.map((t) => <TaskRow key={t.id} task={t} manage={manage} onUpdate={(input) => m.updateOffboardingTask.mutateAsync({ id: t.id, input: input as never })} />)}</ul>
        <p className="text-xs text-slate-400">Completing a task records it. Access revocation, final payroll and asset returns are tracked here, not performed here.</p>
      </div>
      <ConfirmDialog open={confirm === 'activate'} title="Activate this case?" message="Tasks start and assignees are notified. The employee record is not changed." confirmLabel="Activate" loading={m.activateOffboarding.isPending} onConfirm={() => { act(() => m.activateOffboarding.mutateAsync(id), 'Case activated'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this offboarding?" message="The employee stays employed and their account stays active. Open tasks are cancelled and kept as history. No termination date is written." confirmLabel="Cancel offboarding" variant="danger" loading={m.cancelOffboarding.isPending} onConfirm={() => { act(() => m.cancelOffboarding.mutateAsync(id), 'Offboarding cancelled'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <Modal open={confirm === 'separation'} onClose={() => setConfirm(null)} title="Complete employment separation" description="This is the one action that changes the employee record: employment ends on the last working day, the position and manager history close, and the account is disabled with its sessions revoked. Final pay, leave balances, documents and any replacement are handled in their own modules." footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" onClick={() => { act(() => m.completeSeparation.mutateAsync({ id, input: { actualLastWorkingDate: sep.actualLastWorkingDate || undefined, disableAccount: sep.disableAccount } }), 'Separation completed'); setConfirm(null); }} loading={m.completeSeparation.isPending}>Complete separation</Button></>}>
        <div className="space-y-3"><Input label={`Actual last working day (defaults to planned ${d.plannedLastWorkingDate})`} type="date" value={sep.actualLastWorkingDate} onChange={(e) => setSep({ ...sep, actualLastWorkingDate: e.target.value })} /><Checkbox label="Disable the linked user account and revoke its sessions" checked={sep.disableAccount} onChange={(e) => setSep({ ...sep, disableAccount: e.target.checked })} /></div>
      </Modal>
      <Modal open={exit.open} onClose={() => setExit({ ...exit, open: false })} title="Exit interview (HR confidential)" description="A structured note. No sentiment analysis; nothing feeds performance, talent or relations." footer={<><Button variant="secondary" onClick={() => setExit({ ...exit, open: false })}>Cancel</Button><Button onClick={() => { act(() => m.exitInterview.mutateAsync({ id, input: { interviewDate: exit.interviewDate, reasonCategory: (exit.reasonCategory || null) as never, wouldRejoin: exit.wouldRejoin === '' ? null : exit.wouldRejoin === 'true', note: exit.note || null } }), 'Exit interview recorded'); setExit({ ...exit, open: false }); }} disabled={!exit.interviewDate}>Save</Button></>}>
        <div className="space-y-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Interview date" type="date" value={exit.interviewDate} onChange={(e) => setExit({ ...exit, interviewDate: e.target.value })} /><Select label="Main reason" options={EXIT_REASON_CATEGORIES.map((r) => ({ value: r, label: titleCase(r) }))} placeholder="—" value={exit.reasonCategory} onChange={(e) => setExit({ ...exit, reasonCategory: e.target.value })} /><Select label="Would rejoin" options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} placeholder="—" value={exit.wouldRejoin} onChange={(e) => setExit({ ...exit, wouldRejoin: e.target.value })} /></div><Textarea label="Note" value={exit.note} onChange={(e) => setExit({ ...exit, note: e.target.value })} /></div>
      </Modal>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a task" footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button onClick={() => { act(() => m.addOffboardingTask.mutateAsync({ id, input: { title: task.title, category: task.category, assigneeType: task.assigneeType as never, dueDate: task.dueDate, required: task.required } }), 'Task added'); setAdding(false); }} disabled={!task.title || !task.dueDate}>Add</Button></>}>
        <div className="space-y-3"><Input label="Title" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} /><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Category" options={['HANDOVER', 'DOCUMENT', 'ACCESS', 'PAYROLL', 'ASSET', 'EXIT_ADMIN', 'OTHER'].map((x) => ({ value: x, label: titleCase(x) }))} value={task.category} onChange={(e) => setTask({ ...task, category: e.target.value })} /><Select label="Assignee" options={['EMPLOYEE', 'MANAGER', 'HR'].map((x) => ({ value: x, label: titleCase(x) }))} value={task.assigneeType} onChange={(e) => setTask({ ...task, assigneeType: e.target.value })} /><Input label="Due" type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })} /></div><Checkbox label="Required" checked={task.required} onChange={(e) => setTask({ ...task, required: e.target.checked })} /></div>
      </Modal>
    </Modal>
  );
}
