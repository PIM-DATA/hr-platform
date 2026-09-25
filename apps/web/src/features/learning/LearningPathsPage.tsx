import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { LEARNING_STEP_TYPES, PERMISSIONS, type CreateLearningPathInput, type LearningPathDto, type PathAssignmentDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
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
import { useIdp, useIdps } from '@/features/training/training.api';
import { useCertificationDefinitions, useLearningMutations, useLearningOptions, useLearningPaths, useOjtPrograms, usePathAssignment, usePathAssignments } from './learning.api';
import { LearningBadge, Progress, STEP_TYPE_LABEL, fmtDate, titleCase } from './learning-ui';

/** Learning paths: an ordered sequence of things that already exist (courses, OJT programs, IDP activities, certifications). Progress is read from those sources; finishing a path is a record, never a promotion. */
export function LearningPathsPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.LEARNING_PATH_MANAGE);
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'assignments' | 'paths'>('assignments');
  const openId = params.get('open');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('open', id); else n.delete('open'); setParams(n, { replace: true }); };
  return (
    <>
      {manage && <div className="mb-4 flex gap-2">{(['assignments', 'paths'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={`rounded-md border px-3 py-1.5 text-sm ${view === v ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700'}`}>{v === 'assignments' ? 'Assignments' : 'Path catalogue'}</button>)}</div>}
      {view === 'paths' && manage ? <PathsPanel /> : <AssignmentsPanel manage={manage} onOpen={setOpen} />}
      {openId && <AssignmentModal id={openId} onClose={() => setOpen(null)} />}
    </>
  );
}

function AssignmentsPanel({ manage, onOpen }: { manage: boolean; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const [assigning, setAssigning] = useState(false);
  const list = usePathAssignments({ status, page, pageSize: 20 });
  const columns: Column<PathAssignmentDto>[] = [
    { key: 'e', header: 'Employee', render: (a) => <div><div className="font-medium text-slate-900">{a.snapshot.employeeName}</div><div className="text-xs text-slate-400">{a.snapshot.employeeCode} · {a.snapshot.department ?? '—'} · {a.snapshot.job ?? '—'}</div></div> },
    { key: 'p', header: 'Path', render: (a) => <span>{a.pathName}{a.targetJobTitle && <span className="block text-xs text-slate-400">towards {a.targetJobTitle}</span>}</span> },
    { key: 'pr', header: 'Progress', hideBelow: 'sm', render: (a) => <Progress pct={a.progress.pct} hint={`${a.progress.fulfilled}/${a.progress.total} steps`} /> },
    { key: 'd', header: 'Target', hideBelow: 'md', render: (a) => a.targetDate ?? '—' },
    { key: 's', header: 'Status', render: (a) => <LearningBadge status={a.status} /> },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
        <Select options={['ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
        <div />
        {manage && <div className="flex justify-end"><Button onClick={() => setAssigning(true)}><Plus className="h-4 w-4" /> Assign a path</Button></div>}
      </div>
      {list.isError && <Alert className="m-4">Could not load learning path assignments.</Alert>}
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(a) => a.id} loading={list.isLoading} onRowClick={(a) => onOpen(a.id)} emptyTitle="No learning path assignments" emptyDescription="HR assigns a path from the catalogue." />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {assigning && <AssignModal onClose={() => setAssigning(false)} onDone={(id) => { setAssigning(false); onOpen(id); }} />}
    </Card>
  );
}

function AssignModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const m = useLearningMutations(); const paths = useLearningPaths(); const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null); const [pathId, setPathId] = useState(''); const [targetDate, setTargetDate] = useState(''); const [error, setError] = useState<string | null>(null);
  const submit = async () => { if (!employee || !pathId) { setError('Choose the employee and the path.'); return; } try { const a = await m.assignPath.mutateAsync({ id: pathId, input: { employeeId: employee.id, targetDate: targetDate || null } }); toast.success('Path assigned.'); onDone(a.id); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="Assign a learning path" description="The path's steps are copied into the assignment. Steps already satisfied by real completions show as fulfilled at once." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.assignPath.isPending} onClick={submit}>Assign</Button></>}>
      <div className="space-y-3">{error && <Alert>{error}</Alert>}<EmployeePicker value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" /><Select label="Learning path" options={(paths.data ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} placeholder="Choose a path" value={pathId} onChange={(e) => setPathId(e.target.value)} /><Input label="Target date (optional)" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></div>
    </Modal>
  );
}

function AssignmentModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = usePathAssignment(id); const m = useLearningMutations(); const toast = useToast();
  const [confirm, setConfirm] = useState(false); const [fulfil, setFulfil] = useState<string | null>(null); const [idpItemId, setIdpItemId] = useState(''); const [note, setNote] = useState(''); const [error, setError] = useState<string | null>(null);
  const idps = useIdps({ employeeId: q.data?.employeeId ?? '', pageSize: 20 });
  const idp = useIdp(idps.data?.data?.find((p) => p.status === 'ACTIVE')?.id ?? idps.data?.data?.[0]?.id ?? null);
  if (!q.data) return <Modal open onClose={onClose} title="Learning path">{q.isError ? <Alert>Could not load this assignment.</Alert> : <LoadingBlock />}</Modal>;
  const d = q.data;
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); setConfirm(false); setFulfil(null); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.snapshot.employeeName} — ${d.pathName}`} description={`${d.snapshot.employeeCode} · ${d.snapshot.department ?? '—'} · assigned ${fmtDate(d.assignedAt)} by ${d.assignedByName ?? '—'}${d.targetDate ? ` · target ${d.targetDate}` : ''}`}
      footer={<>{d.can.manage && d.status === 'ACTIVE' && <Button variant="danger" onClick={() => setConfirm(true)}>Cancel assignment</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3 text-sm"><LearningBadge status={d.status} /><Progress pct={d.progress.pct} hint={`${d.progress.fulfilled}/${d.progress.total} steps · ${d.progress.requiredOpen} required open`} /></div>
        <ol className="space-y-2">{d.steps.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
            <span className="min-w-0"><span className="font-medium text-slate-900">{s.sequence}. {s.title}</span><span className="block text-xs text-slate-500">{STEP_TYPE_LABEL[s.stepType]} · {s.required ? 'required' : 'optional'}{s.prerequisiteStepId ? ' · after a previous step' : ''}{s.fulfilledAt ? ` · fulfilled ${fmtDate(s.fulfilledAt)}${s.sourceLabel ? ` from ${s.sourceLabel}` : ''}${s.fulfilledBy ? ` by ${s.fulfilledBy}` : ''}` : ''}</span></span>
            <span className="flex items-center gap-2"><LearningBadge status={s.state} />{d.can.manage && d.status === 'ACTIVE' && s.stepType === 'IDP_ACTIVITY' && s.state !== 'FULFILLED' && <Button size="sm" variant="secondary" onClick={() => setFulfil(s.id)}>Confirm done</Button>}</span>
          </li>))}</ol>
        <p className="text-xs text-slate-400">Course, OJT and certification steps are read from those modules. An IDP activity step is confirmed by HR against a completed IDP item. Finishing the path records nothing on the employee's job or grade.</p>
      </div>
      <ConfirmDialog open={confirm} title="Cancel this assignment?" message="The assignment is closed and kept as history." confirmLabel="Cancel assignment" variant="danger" loading={m.cancelAssignment.isPending} onConfirm={() => act(() => m.cancelAssignment.mutateAsync(id), 'Assignment cancelled.')} onCancel={() => setConfirm(false)} error={error} />
      <Modal open={!!fulfil} onClose={() => setFulfil(null)} title="Confirm the IDP activity step" description="Pick the completed IDP item that satisfies this step. The IDP itself is not changed." footer={<><Button variant="secondary" onClick={() => setFulfil(null)}>Cancel</Button><Button loading={m.fulfilStep.isPending} disabled={!idpItemId} onClick={() => act(() => m.fulfilStep.mutateAsync({ id, stepId: fulfil!, input: { idpItemId, note: note || null } }), 'Step fulfilled.')}>Confirm</Button></>}>
        <div className="space-y-3"><Select label="Completed IDP item" options={(idp.data?.items ?? []).filter((i) => i.status === 'COMPLETED').map((i) => ({ value: i.id, label: i.title }))} placeholder={idp.data ? 'Choose a completed item' : 'No development plan found'} value={idpItemId} onChange={(e) => setIdpItemId(e.target.value)} /><Textarea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </Modal>
    </Modal>
  );
}

// ---------- catalogue ----------
function PathsPanel() {
  const paths = useLearningPaths(true); const [editing, setEditing] = useState<LearningPathDto | 'new' | null>(null);
  const columns: Column<LearningPathDto>[] = [
    { key: 'n', header: 'Path', render: (p) => <div><div className="font-medium text-slate-900">{p.name}</div><div className="text-xs text-slate-400">{p.code}{p.targetJobTitle ? ` · towards ${p.targetJobTitle}` : ''}</div></div> },
    { key: 's', header: 'Steps', render: (p) => p.steps.map((s) => s.title).join(' → ') },
    { key: 'a', header: 'Assignments', hideBelow: 'sm', render: (p) => p.assignmentCount },
    { key: 'st', header: 'Status', render: (p) => <LearningBadge status={p.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
  ];
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-200 p-4"><CardHeader title="Learning paths" description="Editing a path never changes an existing assignment." /><Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New path</Button></div>
      <DataTable columns={columns} rows={paths.data ?? []} rowKey={(p) => p.id} loading={paths.isLoading} onRowClick={(p) => setEditing(p)} emptyTitle="No learning paths yet" />
      {editing && <PathModal path={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

type StepDraft = { stepType: string; referenceId: string; title: string; required: boolean; prerequisiteIndex: string };
function PathModal({ path, onClose }: { path: LearningPathDto | null; onClose: () => void }) {
  const m = useLearningMutations(); const opts = useLearningOptions(); const programs = useOjtPrograms(); const defs = useCertificationDefinitions(); const toast = useToast();
  const [code, setCode] = useState(path?.code ?? ''); const [name, setName] = useState(path?.name ?? ''); const [description, setDescription] = useState(path?.description ?? ''); const [targetJobId, setTargetJobId] = useState(path?.targetJobId ?? ''); const [organizationId, setOrganizationId] = useState(path?.organizationId ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(path ? path.steps.map((s) => ({ stepType: s.stepType, referenceId: s.referenceId ?? '', title: s.title, required: s.required, prerequisiteIndex: s.prerequisiteStepId ? String(path.steps.findIndex((x) => x.id === s.prerequisiteStepId)) : '' })) : [{ stepType: 'COURSE', referenceId: '', title: '', required: true, prerequisiteIndex: '' }]);
  const [error, setError] = useState<string | null>(null);
  const refOptions = (t: string) => t === 'COURSE' ? (opts.data?.courses ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.title}` })) : t === 'OJT_PROGRAM' ? (programs.data ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })) : t === 'CERTIFICATION' ? (defs.data ?? []).map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` })) : [];
  const setStep = (i: number, patch: Partial<StepDraft>) => setSteps((x) => x.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const submit = async () => {
    const body: CreateLearningPathInput = { code, name, description: description || null, targetJobId: targetJobId || null, organizationId: organizationId || null, steps: steps.map((s) => ({ stepType: s.stepType as (typeof LEARNING_STEP_TYPES)[number], referenceId: s.stepType === 'IDP_ACTIVITY' ? null : s.referenceId || null, title: s.stepType === 'IDP_ACTIVITY' || s.title ? s.title : undefined, required: s.required, prerequisiteIndex: s.prerequisiteIndex === '' ? null : Number(s.prerequisiteIndex) })) };
    setError(null);
    try { if (path) { const { code: _c, ...rest } = body; void _c; await m.updatePath.mutateAsync({ id: path.id, input: rest }); } else await m.createPath.mutateAsync(body); toast.success(path ? 'Path updated. Existing assignments keep their copy.' : 'Path created.'); onClose(); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={path ? `Edit ${path.name}` : 'New learning path'} description="Steps reference things that already exist. A prerequisite locks a step until the earlier one is fulfilled." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{path && <Button variant="secondary" onClick={() => m.updatePath.mutateAsync({ id: path.id, input: { isActive: !path.isActive } }).then(onClose)}>{path.isActive ? 'Deactivate' : 'Reactivate'}</Button>}<Button loading={m.createPath.isPending || m.updatePath.isPending} onClick={submit}>{path ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" value={code} disabled={!!path} onChange={(e) => setCode(e.target.value.toUpperCase())} /><Input label="Name" className="sm:col-span-2" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Select label="Target job (informational)" options={(opts.data?.jobs ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="None" value={targetJobId} onChange={(e) => setTargetJobId(e.target.value)} /><Select label="Organization" options={(opts.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} /></div>
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Steps (in order)</span><Button size="sm" variant="secondary" onClick={() => setSteps([...steps, { stepType: 'COURSE', referenceId: '', title: '', required: true, prerequisiteIndex: '' }])}>Add step</Button></div>
        {steps.map((s, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-5">
            <Select options={LEARNING_STEP_TYPES.map((t) => ({ value: t, label: STEP_TYPE_LABEL[t] }))} value={s.stepType} onChange={(e) => setStep(i, { stepType: e.target.value, referenceId: '' })} />
            {s.stepType === 'IDP_ACTIVITY' ? <Input className="sm:col-span-2" placeholder="What the IDP activity must be" value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} /> : <Select className="sm:col-span-2" options={refOptions(s.stepType)} placeholder="Choose" value={s.referenceId} onChange={(e) => setStep(i, { referenceId: e.target.value })} />}
            <Select options={steps.slice(0, i).map((_, j) => ({ value: String(j), label: `After step ${j + 1}` }))} placeholder="No prerequisite" value={s.prerequisiteIndex} onChange={(e) => setStep(i, { prerequisiteIndex: e.target.value })} />
            <div className="flex items-center gap-2"><Checkbox label="Required" checked={s.required} onChange={(e) => setStep(i, { required: e.target.checked })} /><Button size="sm" variant="secondary" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>✕</Button></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
