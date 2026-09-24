import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, SUCCESSION_CRITICALITIES, SUCCESSOR_READINESS, nineBoxLabel, type SuccessionCandidateDto, type SuccessionPlanDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useCandidateContext, usePositionOptions, useSuccessionPlan, useSuccessionPlans, useTalentMutations, type PositionOptionDto } from './talent.api';
import { CriticalityBadge, DevelopmentActionModal, PlanStatusBadge, READINESS_LABEL, ReadinessTable, Section, Stat, SuccessorReadinessBadge } from './talent-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function SuccessionPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.SUCCESSION_MANAGE);
  const [status, setStatus] = useState('');
  const [criticality, setCriticality] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useSuccessionPlans({ status, criticality, page, pageSize: 20 });
  const columns: Column<SuccessionPlanDto>[] = [
    { key: 'pos', header: 'Position', render: (p) => <div><div className="font-medium text-slate-900">{p.snapshot.positionTitle}</div><div className="text-xs text-slate-400">{p.position.code} · {p.snapshot.departmentName ?? '—'}</div></div> },
    { key: 'inc', header: 'Incumbent', hideBelow: 'md', render: (p) => (p.incumbents.length ? p.incumbents.map((i) => `${i.firstName} ${i.lastName}`).join(', ') : <span className="text-slate-400">vacant</span>) },
    { key: 'crit', header: 'Criticality', hideBelow: 'sm', render: (p) => <CriticalityBadge value={p.criticality} /> },
    { key: 'succ', header: 'Successors', render: (p) => <span className="tabular-nums">{p.counts.active}</span> },
    { key: 'ready', header: 'Ready now', hideBelow: 'sm', render: (p) => <span className="tabular-nums">{p.counts.readyNow}</span> },
    { key: 'status', header: 'Status', render: (p) => <PlanStatusBadge status={p.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={['DRAFT', 'ACTIVE', 'CLOSED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <Select options={SUCCESSION_CRITICALITIES.map((c) => ({ value: c, label: titleCase(c) }))} placeholder="All criticalities" value={criticality} onChange={(e) => { setCriticality(e.target.value); setPage(1); }} />
          {manage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Succession plan</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load succession plans.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(p) => p.id} loading={list.isLoading} onRowClick={(p) => setOpenId(p.id)} emptyTitle="No succession plans" emptyDescription="A plan names a position and the people who could take it over. Criticality and readiness are set by people." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <PlanFormModal open={creating} onClose={() => setCreating(false)} />
      <PlanDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function PlanFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useTalentMutations();
  const toast = useToast();
  const [term, setTerm] = useState('');
  const search = useDebounce(term, 250);
  const positions = usePositionOptions(search, open && search.trim().length > 0);
  const [position, setPosition] = useState<PositionOptionDto | null>(null);
  const [criticality, setCriticality] = useState('NORMAL');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setTerm(''); setPosition(null); setCriticality('NORMAL'); setNotes(''); } }, [open]);
  const submit = async () => { setErr(null); try { await m.createPlan.mutateAsync({ positionId: position!.id, criticality: criticality as never, notes: notes || null }); toast.success('Succession plan created'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open={open} onClose={onClose} title="New succession plan" description="For a position — the real seat somebody would take over. Its job and department are frozen on the plan as they are today." size="md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createPlan.isPending} disabled={!position}>Create plan</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        {position ? (
          <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"><span>{position.title} <span className="text-xs text-slate-500">{position.code} · {position.department.name}</span></span><Button size="sm" variant="ghost" onClick={() => setPosition(null)}>Change</Button></div>
        ) : (
          <>
            <Input label="Position" placeholder="Search by title or code…" value={term} onChange={(e) => setTerm(e.target.value)} />
            {positions.data && term && <ul className="max-h-40 divide-y divide-slate-100 overflow-auto rounded-md border border-slate-200 bg-white text-sm">{positions.data.length === 0 && <li className="px-3 py-2 text-slate-500">No matching positions</li>}{positions.data.map((p) => <li key={p.id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-50" onClick={() => setPosition(p)}><span>{p.title}</span><span className="text-xs text-slate-400">{p.code} · {p.department.name}</span></button></li>)}</ul>}
          </>
        )}
        <Select label="Criticality" options={SUCCESSION_CRITICALITIES.map((c) => ({ value: c, label: titleCase(c) }))} value={criticality} onChange={(e) => setCriticality(e.target.value)} />
        <Textarea label="Notes (succession managers only)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="text-xs text-slate-500">Criticality is your judgment. The system does not infer it from salary, headcount or performance.</p>
      </div>
    </Modal>
  );
}

function PlanDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.SUCCESSION_MANAGE);
  const q = useSuccessionPlan(id);
  const m = useTalentMutations();
  const toast = useToast();
  const [nominating, setNominating] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const p = q.data;
  const setStatus = async (status: 'ACTIVE' | 'CLOSED') => { setErr(null); try { await m.updatePlan.mutateAsync({ id: id!, input: { status } }); toast.success(status === 'ACTIVE' ? 'Plan active' : 'Plan closed'); } catch (e) { setErr(errorMessage(e)); } };
  const columns: Column<SuccessionCandidateDto>[] = [
    { key: 'who', header: 'Candidate', render: (c) => <div><div className="font-medium text-slate-900">{c.employee.firstName} {c.employee.lastName}</div><div className="text-xs text-slate-400">{c.employee.employeeCode} · when nominated: {c.snapshot.jobTitle ?? '—'}</div></div> },
    { key: 'ready', header: 'Readiness', render: (c) => <SuccessorReadinessBadge value={c.readiness} /> },
    { key: 'target', header: 'Target date', hideBelow: 'sm', render: (c) => c.targetReadinessDate ?? <span className="text-slate-400">—</span> },
    { key: 'nom', header: 'Nominated', hideBelow: 'md', render: (c) => <span className="text-slate-600">{c.nominatedAt.slice(0, 10)}{c.nominatedBy && ` by ${c.nominatedBy}`}</span> },
    { key: 'status', header: 'Status', hideBelow: 'sm', render: (c) => (c.status === 'ACTIVE' ? <span className="text-emerald-700">active</span> : <span className="text-slate-500">removed {c.removedAt?.slice(0, 10)}</span>) },
  ];
  return (
    <>
      <Modal open={!!id && !nominating && !candidateId} onClose={onClose} title={p?.snapshot.positionTitle ?? 'Succession plan'} description={p ? `${p.position.code} · ${p.snapshot.jobTitle ?? '—'} · ${p.snapshot.departmentName ?? '—'} · ${p.snapshot.organizationName ?? ''}` : undefined} size="lg"
        footer={p ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {manage && p.status === 'DRAFT' && <Button variant="secondary" onClick={() => setStatus('ACTIVE')} loading={m.updatePlan.isPending}>Activate</Button>}
            {manage && p.status !== 'CLOSED' && <Button variant="danger" onClick={() => setStatus('CLOSED')} loading={m.updatePlan.isPending}>Close plan</Button>}
            {manage && p.status !== 'CLOSED' && <Button onClick={() => setNominating(true)}>Nominate successor</Button>}
          </div>
        ) : undefined}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this plan.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {p && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3"><PlanStatusBadge status={p.status} /><CriticalityBadge value={p.criticality} /><span className="text-slate-500">incumbent: {p.incumbents.length ? p.incumbents.map((i) => `${i.firstName} ${i.lastName}`).join(', ') : 'vacant'}</span></div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Successors" value={p.counts.active} /><Stat label="Ready now" value={p.counts.readyNow} /><Stat label="Ready soon" value={p.counts.readySoon} /><Stat label="Developing" value={p.counts.developing} /></div>
            {p.notes && <Section title="Notes"><p className="whitespace-pre-wrap text-slate-700">{p.notes}</p></Section>}
            <Section title="Candidates">
              <DataTable columns={columns} rows={p.candidates} rowKey={(c) => c.id} onRowClick={(c) => setCandidateId(c.id)} emptyTitle="No successors nominated" emptyDescription="Nominations are made by people. The system never proposes one." />
              <p className="mt-2 text-xs text-slate-500">Listed in nomination order — not ranked. Readiness is a recorded judgment; open a candidate to see the facts next to it. Candidates are not notified.</p>
            </Section>
          </div>
        )}
      </Modal>
      {p && <NominateModal open={nominating} onClose={() => setNominating(false)} plan={p} />}
      <CandidateModal id={candidateId} onClose={() => setCandidateId(null)} />
    </>
  );
}

function NominateModal({ open, onClose, plan }: { open: boolean; onClose: () => void; plan: SuccessionPlanDto }) {
  const m = useTalentMutations();
  const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [readiness, setReadiness] = useState('DEVELOPING');
  const [targetReadinessDate, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setEmployee(null); setReadiness('DEVELOPING'); setDate(''); setNotes(''); } }, [open]);
  const submit = async () => { setErr(null); try { await m.nominate.mutateAsync({ id: plan.id, input: { employeeId: employee!.id, readiness: readiness as never, targetReadinessDate: targetReadinessDate || null, notes: notes || null } }); toast.success('Successor nominated'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open={open} onClose={onClose} title={`Nominate a successor for ${plan.snapshot.positionTitle}`} description="Your nomination, with the readiness you judge. The candidate's current job is frozen on the nomination; the candidate is not notified." size="md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.nominate.isPending} disabled={!employee}>Nominate</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker label="Employee" value={employee} onChange={setEmployee} endpoint="/talent/employee-options" />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Readiness" options={SUCCESSOR_READINESS.map((r) => ({ value: r, label: READINESS_LABEL[r] ?? r }))} value={readiness} onChange={(e) => setReadiness(e.target.value)} />
          <Input label="Target readiness date" type="date" value={targetReadinessDate} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Textarea label="Notes (succession managers only)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="text-xs text-slate-500">Readiness is a human decision. Competency gaps and performance are evidence you can open on the candidate — nothing derives "ready now" from a score.</p>
      </div>
    </Modal>
  );
}

function CandidateModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.SUCCESSION_MANAGE);
  const ctx = useCandidateContext(id);
  const m = useTalentMutations();
  const toast = useToast();
  const [readiness, setReadiness] = useState('');
  const [devOpen, setDevOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = ctx.data;
  useEffect(() => { if (c) setReadiness(c.candidate.readiness); }, [c]);
  const save = async () => { setErr(null); try { await m.updateCandidate.mutateAsync({ id: id!, input: { readiness: readiness as never } }); toast.success('Readiness updated'); } catch (e) { setErr(errorMessage(e)); } };
  const remove = async () => { setErr(null); try { await m.removeCandidate.mutateAsync({ id: id!, input: {} }); toast.success('Nomination removed — the record is kept'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  const gapCompetencies = (c?.readiness?.competencies ?? []).filter((x) => x.status === 'GAP' || x.status === 'UNASSESSED').map((x) => ({ id: x.competencyId, name: x.competencyName, gapNeeded: x.gapNeeded }));
  return (
    <>
      <Modal open={!!id && !devOpen} onClose={onClose} title={c ? `${c.candidate.employee.firstName} ${c.candidate.employee.lastName}` : 'Candidate'} description={c ? `Nominated for ${c.plan.positionTitle} on ${c.candidate.nominatedAt.slice(0, 10)}${c.candidate.nominatedBy ? ` by ${c.candidate.nominatedBy}` : ''}` : undefined} size="lg"
        footer={c ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {manage && c.candidate.status === 'ACTIVE' && <><Button variant="danger" onClick={remove} loading={m.removeCandidate.isPending}>Remove nomination</Button><Button variant="secondary" onClick={() => setDevOpen(true)}>Create development need</Button><Button onClick={save} loading={m.updateCandidate.isPending} disabled={readiness === c.candidate.readiness}>Save readiness</Button></>}
          </div>
        ) : undefined}>
        {ctx.isLoading && <LoadingBlock />}
        {ctx.isError && <Alert>Could not load this candidate.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {c && (
          <div className="space-y-5 text-sm">
            <Section title="Historical nomination context">
              <p className="text-slate-700">Then: {c.candidate.snapshot.jobTitle ?? '—'}{c.candidate.snapshot.departmentName && ` · ${c.candidate.snapshot.departmentName}`} · readiness <SuccessorReadinessBadge value={c.candidate.readiness} />{c.candidate.targetReadinessDate && ` · target ${c.candidate.targetReadinessDate}`}{c.candidate.status === 'REMOVED' && <span className="ml-2 text-slate-500">removed {c.candidate.removedAt?.slice(0, 10)}{c.candidate.removalReason && ` · ${c.candidate.removalReason}`}</span>}</p>
              {c.candidate.notes && <p className="mt-1 whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-2 text-slate-700">{c.candidate.notes}</p>}
              {manage && c.candidate.status === 'ACTIVE' && <div className="mt-2 max-w-xs"><Select label="Readiness (your judgment)" options={SUCCESSOR_READINESS.map((r) => ({ value: r, label: READINESS_LABEL[r] ?? r }))} value={readiness} onChange={(e) => setReadiness(e.target.value)} /></div>}
            </Section>
            <Section title="Current development context">
              <p className="mb-2 text-slate-700">Now: {c.currentJob?.title ?? '—'}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Latest performance" value={c.performance?.ratingLabel ?? '—'} hint={c.performance ? `${c.performance.score} · ${c.performance.cycleName}` : 'no finalized result'} />
                <Stat label="Latest talent review" value={c.talentReview ? nineBoxLabel(c.talentReview.nineBoxCell) : '—'} hint={c.talentReview?.cycleName} />
                <Stat label="Development" value={c.development.openNeeds} hint={c.development.activeIdpTitle ?? 'no active plan'} />
              </div>
              <div className="mt-3">{c.readiness ? <ReadinessTable readiness={c.readiness} compact /> : <p className="text-slate-500">The target position has no job, so there is no competency profile to compare against.</p>}</div>
              <p className="mt-2 text-xs text-slate-500">Facts side by side, no composite score. What they add up to is the decision of the people running this plan.</p>
            </Section>
          </div>
        )}
      </Modal>
      {c && <DevelopmentActionModal open={devOpen} onClose={() => setDevOpen(false)} employeeId={c.candidate.employee.id} employeeName={`${c.candidate.employee.firstName} ${c.candidate.employee.lastName}`} competencies={gapCompetencies} source={{ type: 'SUCCESSION', id: c.candidate.id }} />}
    </>
  );
}
