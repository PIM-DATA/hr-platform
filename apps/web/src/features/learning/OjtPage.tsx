import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { OJT_ACTIVITY_TYPES, PERMISSIONS, type CreateOjtProgramInput, type OjtPlanActivityDto, type OjtPlanDto, type OjtProgramDto } from '@hr/shared';
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
import { useDocuments, useMyDocuments } from '@/features/documents/documents.api';
import { useLearningMutations, useLearningOptions, useOjtPlan, useOjtPlans, useOjtPrograms } from './learning.api';
import { businessDateToday } from '@/lib/format';
import { ACTIVITY_TYPE_LABEL, LearningBadge, Progress, fmtDate, titleCase } from './learning-ui';

/**
 * OJT: programs are the template, plans are frozen copies worked by a trainee and observed by a trainer HR chose.
 * Everything a trainer records is evidence for a human; nothing here changes a competency level.
 */
export function OjtPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.OJT_MANAGE);
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'plans' | 'programs'>('plans');
  const openId = params.get('open');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('open', id); else n.delete('open'); setParams(n, { replace: true }); };
  return (
    <>
      {manage && <div className="mb-4 flex gap-2">{(['plans', 'programs'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={`rounded-md border px-3 py-1.5 text-sm ${view === v ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700'}`}>{v === 'plans' ? 'OJT plans' : 'Programs'}</button>)}</div>}
      {view === 'programs' && manage ? <ProgramsPanel /> : <PlansPanel manage={manage} onOpen={setOpen} />}
      {openId && <PlanModal id={openId} onClose={() => setOpen(null)} />}
    </>
  );
}

function PlansPanel({ manage, onOpen }: { manage: boolean; onOpen: (id: string) => void }) {
  const { hasPermission } = useAuth();
  const [status, setStatus] = useState(''); const [mine, setMine] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [creating, setCreating] = useState(false);
  const list = useOjtPlans({ status, mine, search, page, pageSize: 20 });
  const columns: Column<OjtPlanDto>[] = [
    { key: 'e', header: 'Trainee', render: (p) => <div><div className="font-medium text-slate-900">{p.snapshot.employeeName}</div><div className="text-xs text-slate-400">{p.planNumber} · {p.snapshot.department ?? '—'} · {p.snapshot.job ?? '—'}</div></div> },
    { key: 'prog', header: 'Program', render: (p) => <span>{p.programName}<span className="block text-xs text-slate-400">Trainer {p.trainer?.name ?? '— not set'}</span></span> },
    { key: 'dates', header: 'Start', hideBelow: 'md', render: (p) => `${p.startDate}${p.targetEndDate ? ` → ${p.targetEndDate}` : ''}` },
    { key: 'pr', header: 'Progress', hideBelow: 'sm', render: (p) => <Progress pct={p.progress.pct} hint={`${p.progress.completed}/${p.progress.total}`} /> },
    { key: 'status', header: 'Status', render: (p) => <LearningBadge status={p.status} /> },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4">
        <Select options={['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
        <Select options={[...(hasPermission(PERMISSIONS.OJT_TRAIN) ? [{ value: 'trainer', label: 'Plans I train' }] : []), { value: 'trainee', label: 'My own plans' }]} placeholder="All visible plans" value={mine} onChange={(e) => { setMine(e.target.value); setPage(1); }} />
        <Input placeholder="Search trainee or plan number" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        {manage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New OJT plan</Button></div>}
      </div>
      {list.isError && <Alert className="m-4">Could not load OJT plans.</Alert>}
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(p) => p.id} loading={list.isLoading} onRowClick={(p) => onOpen(p.id)} emptyTitle="No OJT plans" emptyDescription="HR creates a plan from a program and assigns a trainer." />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {creating && <CreatePlanModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </Card>
  );
}

function CreatePlanModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const m = useLearningMutations(); const programs = useOjtPrograms(); const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null); const [trainer, setTrainer] = useState<PayrollEmployeeOption | null>(null);
  const [programId, setProgramId] = useState(''); const [startDate, setStartDate] = useState(businessDateToday()); const [targetEndDate, setTargetEndDate] = useState(''); const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!employee || !programId) { setError('Choose the trainee and the program.'); return; }
    try { const p = await m.createPlan.mutateAsync({ employeeId: employee.id, programId, trainerEmployeeId: trainer?.id ?? null, startDate, targetEndDate: targetEndDate || null }); toast.success(`Plan ${p.planNumber} created as a draft.`); onCreated(p.id); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal open onClose={onClose} title="New OJT plan" description="The program, its activities and criteria are copied into the plan now. Later program edits do not touch it. The trainer must have an active account." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.createPlan.isPending} onClick={submit}>Create draft</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <EmployeePicker label="Trainee" value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" />
        <Select label="Program" options={(programs.data ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} placeholder="Choose a program" value={programId} onChange={(e) => setProgramId(e.target.value)} />
        <EmployeePicker label="Trainer (chosen by HR)" value={trainer} onChange={setTrainer} endpoint="/workforce/employee-options" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /><Input label="Target end (optional)" type="date" value={targetEndDate} onChange={(e) => setTargetEndDate(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function PlanModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useOjtPlan(id); const m = useLearningMutations(); const toast = useToast();
  const [confirm, setConfirm] = useState<'activate' | 'complete' | 'cancel' | 'handoff' | null>(null); const [assessing, setAssessing] = useState(false); const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'COMPLETED' | 'MORE_PRACTICE_REQUIRED'>('COMPLETED'); const [comment, setComment] = useState('');
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); setConfirm(null); setAssessing(false); } catch (e) { setError(errorMessage(e)); } };
  if (!q.data) return <Modal open onClose={onClose} title="OJT plan">{q.isError ? <Alert>Could not load this plan.</Alert> : <LoadingBlock />}</Modal>;
  const d = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.snapshot.employeeName} — ${d.programName}`} description={`${d.planNumber} · ${d.snapshot.employeeCode} · ${d.snapshot.department ?? '—'} · trainer ${d.trainer?.name ?? 'not set'} · ${d.startDate}${d.targetEndDate ? ` → ${d.targetEndDate}` : ''}`}
      footer={<>{d.can.manage && d.status === 'DRAFT' && <Button onClick={() => setConfirm('activate')}>Activate</Button>}{d.can.assess && <Button variant="secondary" onClick={() => setAssessing(true)}>Record assessment</Button>}{d.can.complete && <Button onClick={() => setConfirm('complete')}>Mark OJT completed</Button>}{d.can.handoff && <Button variant="secondary" onClick={() => setConfirm('handoff')}>Use as competency evidence</Button>}{d.can.manage && (d.status === 'DRAFT' || d.status === 'ACTIVE') && <Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel plan</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3 text-sm"><LearningBadge status={d.status} /><Progress pct={d.progress.pct} hint={`${d.progress.completed}/${d.progress.total} activities · ${d.progress.requiredOpen} required open`} /></div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Competency objectives</div>
          <ul className="mt-1 flex flex-wrap gap-2 text-xs">{d.competencies.map((c) => <li key={c.competencyId} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">{c.competencyName}{c.targetLevel ? ` · OJT objective: level ${c.targetLevel}` : ''}{c.importance ? ` · ${titleCase(c.importance)}` : ''}{d.evidenceHandoffs.some((e) => e.competencyId === c.competencyId) && <span className="ml-1 text-emerald-700">evidence handed off</span>}</li>)}</ul>
          <p className="mt-1 text-xs text-slate-400">The target level describes the evidence expected, not a level this plan grants. Levels change only through a competency assessment.</p>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Activities</div>
          {d.activities.map((a) => <ActivityRow key={a.id} plan={d} a={a} />)}
        </div>
        {d.assessment.length > 0 && <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assessments</div><ul className="mt-1 space-y-1 text-sm">{d.assessment.map((x, i) => <li key={i} className="rounded border border-slate-200 p-2"><LearningBadge status={x.outcome} /> <span className="text-xs text-slate-500">by {x.assessorName ?? '—'} · {fmtDate(x.submittedAt)}</span>{x.comment && <p className="mt-1 text-slate-700">{x.comment}</p>}</li>)}</ul></div>}
      </div>
      <ConfirmDialog open={confirm === 'activate'} title="Activate this plan?" message="Activities, criteria and the trainer are frozen. The trainee and trainer are notified." confirmLabel="Activate" loading={m.activatePlan.isPending} onConfirm={() => act(() => m.activatePlan.mutateAsync(id), 'Plan activated.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'complete'} title="Mark OJT completed?" message="Every required activity is completed or skipped. A linked training need is marked fulfilled. No competency level changes." confirmLabel="Complete" loading={m.completePlan.isPending} onConfirm={() => act(() => m.completePlan.mutateAsync(id), 'OJT completed.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this plan?" message="The plan is closed and kept as history. A linked training need goes back to open." confirmLabel="Cancel plan" variant="danger" loading={m.cancelPlan.isPending} onConfirm={() => act(() => m.cancelPlan.mutateAsync(id), 'Plan cancelled.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'handoff'} title="Use this OJT as competency evidence?" message="One evidence pointer per program competency is recorded for the assessor to read during the next competency assessment, carrying the OJT objective level only. No level is observed or changed." confirmLabel="Record evidence" loading={m.handoff.isPending} onConfirm={() => act(() => m.handoff.mutateAsync({ id }), 'Evidence recorded for the competency assessor.')} onCancel={() => setConfirm(null)} error={error} />
      <Modal open={assessing} onClose={() => setAssessing(false)} title="Final assessment" description="A human judgement by the trainer. 'More practice required' keeps the plan active and fails nobody." footer={<><Button variant="secondary" onClick={() => setAssessing(false)}>Cancel</Button><Button loading={m.assess.isPending} onClick={() => act(() => m.assess.mutateAsync({ id, input: { outcome, comment: comment || null } }), 'Assessment recorded.')}>Submit</Button></>}>
        <div className="space-y-3"><Select label="Outcome" options={[{ value: 'COMPLETED', label: 'Completed' }, { value: 'MORE_PRACTICE_REQUIRED', label: 'More practice required' }]} value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} /><Textarea label="Comment (trainer and HR only)" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
      </Modal>
    </Modal>
  );
}

function ActivityRow({ plan, a }: { plan: OjtPlanDto; a: OjtPlanActivityDto }) {
  const m = useLearningMutations(); const toast = useToast();
  const [reflection, setReflection] = useState(a.employeeReflection ?? ''); const [trainerComment, setTrainerComment] = useState(a.trainerComment ?? ''); const [docId, setDocId] = useState(''); const [error, setError] = useState<string | null>(null); const [open, setOpen] = useState(false);
  // Evidence picker: the trainee lists their own documents (documents.view_own); a trainer or HR with documents.view lists the trainee's. Nobody is asked for a list they may not read.
  const { user, hasPermission } = useAuth();
  const wantsPicker = a.can.linkEvidence && !a.documentTitle && a.status !== 'COMPLETED' && a.status !== 'SKIPPED';
  const isTrainee = !!user?.employee && user.employee.id === plan.employeeId;
  const canList = hasPermission(PERMISSIONS.DOCUMENTS_VIEW) || hasPermission(PERMISSIONS.DOCUMENTS_MANAGE);
  const mine = useMyDocuments(wantsPicker && isTrainee);
  const theirs = useDocuments({ ownerEmployeeId: plan.employeeId, pageSize: 50 }, wantsPicker && !isTrainee && canList);
  const docOptions = (isTrainee ? mine.data ?? [] : theirs.data?.data ?? []).map((x) => ({ value: x.id, label: `${x.documentNumber} · ${x.title}` }));
  const run = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); } catch (e) { setError(errorMessage(e)); } };
  const final = a.status === 'COMPLETED' || a.status === 'SKIPPED';
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <button className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className="min-w-0"><span className="font-medium text-slate-900">{a.sequence}. {a.title}</span><span className="block text-xs text-slate-500">{ACTIVITY_TYPE_LABEL[a.activityType]} · {a.required ? 'required' : 'optional'}{a.expectedDays ? ` · ~${a.expectedDays} days` : ''}{a.requiresEvidence ? ' · document evidence required' : ''}</span></span>
        <LearningBadge status={a.status} />
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          {error && <Alert>{error}</Alert>}
          {a.description && <p className="text-slate-600">{a.description}</p>}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Observation criteria</div>
            <ul className="mt-1 space-y-1">{a.observations.map((o) => (
              <li key={o.criterionId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 bg-slate-50 px-2 py-1.5">
                <span>{o.criterion}{o.required && <span className="ml-1 text-xs text-slate-400">(required)</span>}{o.observedAt && <span className="ml-2 text-xs text-slate-400">{o.observerName ?? ''} · {o.observedAt}</span>}{o.comment && <span className="block text-xs text-slate-600">{o.comment}</span>}</span>
                <span className="flex items-center gap-1">{o.result ? <LearningBadge status={o.result} /> : <span className="text-xs text-slate-400">not yet observed</span>}
                  {a.can.observe && !final && (['MEETS', 'NEEDS_PRACTICE', 'NOT_OBSERVED'] as const).map((r) => <Button key={r} size="sm" variant="secondary" onClick={() => run(() => m.observe.mutateAsync({ id: a.id, input: { criterionId: o.criterionId, result: r } }), 'Observation recorded.')}>{r === 'MEETS' ? 'Meets' : r === 'NEEDS_PRACTICE' ? 'Needs practice' : 'Not observed'}</Button>)}
                </span>
              </li>))}</ul>
          </div>
          {a.blockers.length > 0 && !final && <ul className="list-disc pl-5 text-xs text-amber-800">{a.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
          {a.documentTitle ? <p className="text-xs text-slate-600">Evidence: {a.documentTitle}</p> : a.can.linkEvidence && (
            <div className="flex flex-wrap items-end gap-2"><Select label="Link evidence document (Document Center)" options={docOptions} placeholder={isTrainee || canList ? 'Choose a document you can access' : 'No document access'} value={docId} onChange={(e) => setDocId(e.target.value)} /><Button size="sm" variant="secondary" disabled={!docId} onClick={() => run(() => m.updateActivity.mutateAsync({ id: a.id, input: { documentId: docId } }), 'Evidence linked.')}>Link</Button></div>
          )}
          {a.can.reflect && !final && <div className="flex flex-wrap items-end gap-2"><Textarea label="My reflection" rows={2} value={reflection} onChange={(e) => setReflection(e.target.value)} /><Button size="sm" variant="secondary" onClick={() => run(() => m.updateActivity.mutateAsync({ id: a.id, input: { employeeReflection: reflection || null } }), 'Reflection saved.')}>Save</Button></div>}
          {!a.can.reflect && a.employeeReflection && <p className="text-xs text-slate-600">Trainee reflection: {a.employeeReflection}</p>}
          {(plan.can.train || plan.can.manage) && !final && <div className="flex flex-wrap items-end gap-2"><Textarea label="Trainer comment (trainer and HR only)" rows={2} value={trainerComment} onChange={(e) => setTrainerComment(e.target.value)} /><Button size="sm" variant="secondary" onClick={() => run(() => m.updateActivity.mutateAsync({ id: a.id, input: { trainerComment: trainerComment || null } }), 'Comment saved.')}>Save</Button></div>}
          {a.can.updateStatus && !final && <div className="flex flex-wrap gap-2">
            {a.status === 'PENDING' && <Button size="sm" onClick={() => run(() => m.updateActivity.mutateAsync({ id: a.id, input: { status: 'IN_PROGRESS' } }), 'Activity started.')}>Start</Button>}
            <Button size="sm" disabled={a.blockers.length > 0} onClick={() => run(() => m.updateActivity.mutateAsync({ id: a.id, input: { status: 'COMPLETED' } }), 'Activity completed.')}>Mark completed</Button>
            {(!a.required || plan.can.manage) && <Button size="sm" variant="secondary" onClick={() => run(() => m.updateActivity.mutateAsync({ id: a.id, input: { status: 'SKIPPED' } }), 'Activity skipped.')}>Skip</Button>}
          </div>}
        </div>
      )}
    </div>
  );
}

// ---------- programs ----------
function ProgramsPanel() {
  const programs = useOjtPrograms(true); const [editing, setEditing] = useState<OjtProgramDto | 'new' | null>(null);
  const columns: Column<OjtProgramDto>[] = [
    { key: 'n', header: 'Program', render: (p) => <div><div className="font-medium text-slate-900">{p.name}</div><div className="text-xs text-slate-400">{p.code}{p.jobTitle ? ` · ${p.jobTitle}` : ''}{p.organizationName ? ` · ${p.organizationName}` : ''}</div></div> },
    { key: 'c', header: 'Competencies', hideBelow: 'sm', render: (p) => p.competencies.map((c) => c.competencyName).join(', ') || '—' },
    { key: 'a', header: 'Activities', render: (p) => `${p.activities.length} (${p.activities.filter((a) => a.required).length} required)` },
    { key: 'p', header: 'Plans', hideBelow: 'md', render: (p) => p.planCount },
    { key: 's', header: 'Status', render: (p) => <LearningBadge status={p.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
  ];
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-200 p-4"><CardHeader title="OJT programs" description="A program is a template. Plans copy it; editing a program never changes an existing plan." /><Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New program</Button></div>
      <DataTable columns={columns} rows={programs.data ?? []} rowKey={(p) => p.id} loading={programs.isLoading} onRowClick={(p) => setEditing(p)} emptyTitle="No programs yet" />
      {editing && <ProgramModal program={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

type Draft = { code: string; name: string; description: string; organizationId: string; jobId: string; durationDays: string; competencies: { competencyId: string; targetLevel: string; importance: string }[]; activities: { title: string; description: string; activityType: string; required: boolean; expectedDays: string; documentEvidenceRequired: boolean; criteria: { criterion: string; required: boolean }[] }[] };
function ProgramModal({ program, onClose }: { program: OjtProgramDto | null; onClose: () => void }) {
  const m = useLearningMutations(); const opts = useLearningOptions(); const toast = useToast();
  const [d, setD] = useState<Draft>(program ? { code: program.code, name: program.name, description: program.description ?? '', organizationId: program.organizationId ?? '', jobId: program.jobId ?? '', durationDays: program.durationDays ? String(program.durationDays) : '', competencies: program.competencies.map((c) => ({ competencyId: c.competencyId, targetLevel: c.targetLevel ? String(c.targetLevel) : '', importance: c.importance ?? '' })), activities: program.activities.map((a) => ({ title: a.title, description: a.description ?? '', activityType: a.activityType, required: a.required, expectedDays: a.expectedDays ? String(a.expectedDays) : '', documentEvidenceRequired: a.documentEvidenceRequired, criteria: a.criteria.map((c) => ({ criterion: c.criterion, required: c.required })) })) } : { code: '', name: '', description: '', organizationId: '', jobId: '', durationDays: '', competencies: [], activities: [{ title: '', description: '', activityType: 'OBSERVE', required: true, expectedDays: '', documentEvidenceRequired: false, criteria: [{ criterion: '', required: true }] }] });
  const [error, setError] = useState<string | null>(null);
  const setAct = (i: number, patch: Partial<Draft['activities'][number]>) => setD((x) => ({ ...x, activities: x.activities.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
  const submit = async () => {
    const body: CreateOjtProgramInput = { code: d.code, name: d.name, description: d.description || null, organizationId: d.organizationId || null, jobId: d.jobId || null, durationDays: d.durationDays ? Number(d.durationDays) : null,
      competencies: d.competencies.filter((c) => c.competencyId).map((c) => ({ competencyId: c.competencyId, targetLevel: c.targetLevel ? Number(c.targetLevel) : null, importance: (c.importance || null) as 'CORE' | 'SUPPORTING' | null })),
      activities: d.activities.map((a) => ({ title: a.title, description: a.description || null, activityType: a.activityType as (typeof OJT_ACTIVITY_TYPES)[number], required: a.required, expectedDays: a.expectedDays ? Number(a.expectedDays) : null, documentEvidenceRequired: a.documentEvidenceRequired, criteria: a.criteria.filter((c) => c.criterion.trim()).map((c) => ({ criterion: c.criterion, required: c.required })) })) };
    setError(null);
    try { if (program) { const { code: _c, ...rest } = body; void _c; await m.updateProgram.mutateAsync({ id: program.id, input: rest }); } else await m.createProgram.mutateAsync(body); toast.success(program ? 'Program updated. Existing plans keep their copy.' : 'Program created.'); onClose(); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={program ? `Edit ${program.name}` : 'New OJT program'} description="Competency objectives state the level of evidence expected — they grant nothing. Activities carry the criteria a trainer observes." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{program && <Button variant="secondary" onClick={() => m.updateProgram.mutateAsync({ id: program.id, input: { isActive: !program.isActive } }).then(onClose)}>{program.isActive ? 'Deactivate' : 'Reactivate'}</Button>}<Button loading={m.createProgram.isPending || m.updateProgram.isPending} onClick={submit}>{program ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" value={d.code} disabled={!!program} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} /><Input label="Name" className="sm:col-span-2" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Organization" options={(opts.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={d.organizationId} onChange={(e) => setD({ ...d, organizationId: e.target.value })} /><Select label="Target job" options={(opts.data?.jobs ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="Any" value={d.jobId} onChange={(e) => setD({ ...d, jobId: e.target.value })} /><Input label="Duration (days)" type="number" value={d.durationDays} onChange={(e) => setD({ ...d, durationDays: e.target.value })} /></div>
        <Textarea label="Description" rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        <div>
          <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Competency objectives</span><Button size="sm" variant="secondary" onClick={() => setD({ ...d, competencies: [...d.competencies, { competencyId: '', targetLevel: '', importance: 'CORE' }] })}>Add</Button></div>
          {d.competencies.map((c, i) => <div key={i} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4"><Select className="sm:col-span-2" options={(opts.data?.competencies ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` }))} placeholder="Competency" value={c.competencyId} onChange={(e) => setD({ ...d, competencies: d.competencies.map((x, j) => (j === i ? { ...x, competencyId: e.target.value } : x)) })} /><Input type="number" placeholder="Expected level" value={c.targetLevel} onChange={(e) => setD({ ...d, competencies: d.competencies.map((x, j) => (j === i ? { ...x, targetLevel: e.target.value } : x)) })} /><div className="flex gap-2"><Select options={[{ value: 'CORE', label: 'Core' }, { value: 'SUPPORTING', label: 'Supporting' }]} value={c.importance} onChange={(e) => setD({ ...d, competencies: d.competencies.map((x, j) => (j === i ? { ...x, importance: e.target.value } : x)) })} /><Button size="sm" variant="secondary" onClick={() => setD({ ...d, competencies: d.competencies.filter((_, j) => j !== i) })}>✕</Button></div></div>)}
        </div>
        <div>
          <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Activities (in order)</span><Button size="sm" variant="secondary" onClick={() => setD({ ...d, activities: [...d.activities, { title: '', description: '', activityType: 'PRACTICE', required: true, expectedDays: '', documentEvidenceRequired: false, criteria: [{ criterion: '', required: true }] }] })}>Add activity</Button></div>
          {d.activities.map((a, i) => (
            <div key={i} className="mt-2 space-y-2 rounded-lg border border-slate-200 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4"><Input className="sm:col-span-2" placeholder={`Activity ${i + 1} title`} value={a.title} onChange={(e) => setAct(i, { title: e.target.value })} /><Select options={OJT_ACTIVITY_TYPES.map((t) => ({ value: t, label: ACTIVITY_TYPE_LABEL[t] }))} value={a.activityType} onChange={(e) => setAct(i, { activityType: e.target.value })} /><Input type="number" placeholder="Expected days" value={a.expectedDays} onChange={(e) => setAct(i, { expectedDays: e.target.value })} /></div>
              <div className="flex flex-wrap items-center gap-4"><Checkbox label="Required" checked={a.required} onChange={(e) => setAct(i, { required: e.target.checked })} /><Checkbox label="Document evidence required" checked={a.documentEvidenceRequired} onChange={(e) => setAct(i, { documentEvidenceRequired: e.target.checked })} /><Button size="sm" variant="secondary" onClick={() => setD({ ...d, activities: d.activities.filter((_, j) => j !== i) })}>Remove activity</Button></div>
              <div className="space-y-1">{a.criteria.map((c, k) => <div key={k} className="flex flex-wrap items-center gap-2"><Input className="min-w-0 flex-1" placeholder="Observation criterion" value={c.criterion} onChange={(e) => setAct(i, { criteria: a.criteria.map((x, l) => (l === k ? { ...x, criterion: e.target.value } : x)) })} /><Checkbox label="Required" checked={c.required} onChange={(e) => setAct(i, { criteria: a.criteria.map((x, l) => (l === k ? { ...x, required: e.target.checked } : x)) })} /><Button size="sm" variant="secondary" onClick={() => setAct(i, { criteria: a.criteria.filter((_, l) => l !== k) })}>✕</Button></div>)}<Button size="sm" variant="secondary" onClick={() => setAct(i, { criteria: [...a.criteria, { criterion: '', required: true }] })}>Add criterion</Button></div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
