import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, nineBoxLabel, type TalentCycleDto, type TalentReviewDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useDepartmentOptions } from '@/features/organization/organization.api';
import { usePerformanceCycles } from '@/features/performance/performance.api';
import { useRecruitmentOptions } from '@/features/recruitment/recruitment.api';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useNineBox, useTalentCycle, useTalentCycles, useTalentMutations, useTalentReviewContext, useTalentReviews } from './talent.api';
import { BucketBadge, CycleStatusBadge, DevelopmentActionModal, NineBoxGrid, ReviewStatusBadge, Stat } from './talent-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

/** Reviewers see what is waiting for them; cycle managers see cycles, assignment, the 9-box and every review. */
export function TalentReviewsPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.TALENT_MANAGE);
  const [creating, setCreating] = useState(false);
  const [openCycle, setOpenCycle] = useState<string | null>(null);
  const [openReview, setOpenReview] = useState<string | null>(null);
  const cycles = useTalentCycles({ pageSize: 50 });
  const mine = useTalentReviews({ view: 'mine', pageSize: 100 });
  const reviewColumns: Column<TalentReviewDto>[] = [
    { key: 'who', header: 'Employee', render: (r) => <div><div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div><div className="text-xs text-slate-400">{r.snapshot.jobTitle ?? '—'}{r.snapshot.departmentName && ` · ${r.snapshot.departmentName}`}</div></div> },
    { key: 'cycle', header: 'Cycle', hideBelow: 'sm', render: (r) => r.cycle.name },
    { key: 'perf', header: 'Performance', hideBelow: 'md', render: (r) => (r.performance.ratingLabel ? <span className="flex items-center gap-2">{r.performance.ratingLabel} <span className="text-xs text-slate-400">{r.performance.score}</span><BucketBadge value={r.performance.bucket} /></span> : <span className="text-slate-400">no finalized result</span>) },
    { key: 'status', header: 'Status', render: (r) => <ReviewStatusBadge status={r.status} /> },
  ];
  const cycleColumns: Column<TalentCycleDto>[] = [
    { key: 'name', header: 'Cycle', render: (c) => <div><div className="font-medium text-slate-900">{c.name}</div><div className="text-xs text-slate-400">{c.code} · {c.periodStart} → {c.periodEnd}</div></div> },
    { key: 'perf', header: 'Performance input', hideBelow: 'md', render: (c) => c.performanceCycle?.name ?? <span className="text-slate-400">none</span> },
    { key: 'progress', header: 'Assigned / submitted / finalized', hideBelow: 'sm', render: (c) => <span className="tabular-nums">{c.counts.assigned + c.counts.submitted + c.counts.finalized} / {c.counts.submitted + c.counts.finalized} / {c.counts.finalized}</span> },
    { key: 'status', header: 'Status', render: (c) => <CycleStatusBadge status={c.status} /> },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="My reviews" description="Assessments waiting for you as the assigned reviewer, and those you have submitted." />
        {mine.isError && <Alert className="m-4">Could not load your reviews.</Alert>}
        <DataTable columns={reviewColumns} rows={mine.data?.data ?? []} rowKey={(r) => r.id} loading={mine.isLoading} onRowClick={(r) => setOpenReview(r.id)} emptyTitle="Nothing waiting for you" emptyDescription="Reviews appear here when HR assigns you as somebody's reviewer." />
      </Card>
      {manage && (
        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 p-4"><h2 className="text-sm font-semibold text-slate-900">Talent review cycles</h2><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Cycle</Button></div>
          <DataTable columns={cycleColumns} rows={cycles.data?.data ?? []} rowKey={(c) => c.id} loading={cycles.isLoading} onRowClick={(c) => setOpenCycle(c.id)} emptyTitle="No cycles" emptyDescription="A cycle reads a finalized performance cycle and asks reviewers for a potential judgment." />
        </Card>
      )}
      <CycleFormModal open={creating} onClose={() => setCreating(false)} />
      <CycleDetailModal id={openCycle} onClose={() => setOpenCycle(null)} onOpenReview={setOpenReview} />
      <ReviewModal id={openReview} onClose={() => setOpenReview(null)} />
    </div>
  );
}

function CycleFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useTalentMutations();
  const toast = useToast();
  const options = useRecruitmentOptions();
  const perf = usePerformanceCycles({ pageSize: 100 });
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [periodStart, setStart] = useState(''); const [periodEnd, setEnd] = useState(''); const [organizationId, setOrg] = useState(''); const [performanceCycleId, setPerf] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(''); setName(''); setStart(''); setEnd(''); setOrg(''); setPerf(''); } }, [open]);
  const submit = async () => { setErr(null); try { await m.createCycle.mutateAsync({ code, name, periodStart, periodEnd, organizationId: organizationId || null, performanceCycleId: performanceCycleId || null }); toast.success('Cycle created'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  const finalized = (perf.data?.data ?? []).filter((c) => c.status === 'REVIEW' || c.status === 'CLOSED');
  return (
    <Modal open={open} onClose={onClose} title="New talent review cycle" description="Potential is assessed on a three-level scale whose meaning the organization defines. Performance comes from a finalized performance cycle." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createCycle.isPending} disabled={!code || !name || !periodStart || !periodEnd}>Create</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Period start" required type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} />
          <Input label="Period end" required type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} />
          <Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => setOrg(e.target.value)} />
          <Select label="Performance cycle (finalized)" options={finalized.map((c) => ({ value: c.id, label: `${c.name} (${c.status.toLowerCase()})` }))} placeholder="None — potential only" value={performanceCycleId} onChange={(e) => setPerf(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function CycleDetailModal({ id, onClose, onOpenReview }: { id: string | null; onClose: () => void; onOpenReview: (id: string) => void }) {
  const cycle = useTalentCycle(id);
  const box = useNineBox(id);
  const m = useTalentMutations();
  const toast = useToast();
  const departments = useDepartmentOptions();
  const [cell, setCell] = useState<string | null>(null);
  const [assignDept, setAssignDept] = useState('');
  const [rules, setRules] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<'activate' | 'review' | 'close' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const c = cycle.data;
  const reviews = useTalentReviews({ cycleId: id ?? '', nineBoxCell: cell ?? '', pageSize: 100 }, !!id);
  useEffect(() => { if (c) setRules(Object.fromEntries(c.bucketRules.map((r) => [r.ratingCode, r.bucket]))); }, [c]);
  const run = async (fn: () => Promise<unknown>, done: string) => { setErr(null); try { await fn(); toast.success(done); } catch (e) { setErr(errorMessage(e)); } setConfirm(null); };
  const saveRules = () => run(() => m.setBucketRules.mutateAsync({ id: id!, input: { rules: Object.entries(rules).filter(([, b]) => b).map(([ratingCode, bucket]) => ({ ratingCode, bucket: bucket as never })) } }), 'Bucket rules saved');
  const assign = () => run(async () => { const r = await m.assign.mutateAsync({ id: id!, input: { departmentId: assignDept } }); toast.success(`${r.created} assigned${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`); }, 'Assignment done');
  const reviewColumns: Column<TalentReviewDto>[] = [
    { key: 'who', header: 'Employee', render: (r) => <div><div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div><div className="text-xs text-slate-400">{r.snapshot.jobTitle ?? '—'} · reviewer {r.reviewer.name ?? '—'}</div></div> },
    { key: 'perf', header: 'Performance', hideBelow: 'sm', render: (r) => <BucketBadge value={r.performance.bucket} label={r.performance.ratingLabel ? `${r.performance.ratingLabel} → ${titleCase(r.performance.bucket ?? '')}` : undefined} /> },
    { key: 'pot', header: 'Potential', hideBelow: 'sm', render: (r) => <BucketBadge value={r.potentialLevel} /> },
    { key: 'status', header: 'Status', render: (r) => <ReviewStatusBadge status={r.status} /> },
  ];
  return (
    <>
      <Modal open={!!id} onClose={onClose} title={c?.name ?? 'Cycle'} description={c ? `${c.code} · ${c.periodStart} → ${c.periodEnd}${c.performanceCycle ? ` · performance from ${c.performanceCycle.name}` : ''}` : undefined} size="lg"
        footer={c ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {c.status === 'DRAFT' && <Button onClick={() => setConfirm('activate')}>Activate</Button>}
            {c.status === 'ACTIVE' && <Button variant="secondary" onClick={() => setConfirm('review')}>Stop assigning (review)</Button>}
            {(c.status === 'ACTIVE' || c.status === 'REVIEW') && <Button variant="danger" onClick={() => setConfirm('close')}>Close cycle</Button>}
          </div>
        ) : undefined}>
        {cycle.isLoading && <LoadingBlock />}
        {err && <Alert className="mb-3">{err}</Alert>}
        {c && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-3"><CycleStatusBadge status={c.status} /><span className="text-slate-500">{c.counts.assigned} waiting · {c.counts.submitted} submitted · {c.counts.finalized} finalized</span></div>
            {c.performanceCycle && c.status !== 'CLOSED' && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Performance buckets</h3>
                <p className="mb-2 text-xs text-slate-500">Which rating counts as low, medium or high performance is your decision — map every rating of {c.performanceCycle.name} exactly once.</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {c.performanceCycle.ratingBands.map((b) => <Select key={b.code} label={`${b.label} (${b.code})`} options={['LOW', 'MEDIUM', 'HIGH'].map((x) => ({ value: x, label: titleCase(x) }))} placeholder="Unmapped" value={rules[b.code] ?? ''} onChange={(e) => setRules({ ...rules, [b.code]: e.target.value })} />)}
                </div>
                <div className="mt-2"><Button size="sm" variant="secondary" onClick={saveRules} loading={m.setBucketRules.isPending}>Save buckets</Button></div>
              </section>
            )}
            {c.status === 'ACTIVE' && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Assign employees</h3>
                <div className="flex flex-wrap items-end gap-2">
                  <Select label="Department" options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Select…" value={assignDept} onChange={(e) => setAssignDept(e.target.value)} className="min-w-56" />
                  <Button size="sm" onClick={assign} loading={m.assign.isPending} disabled={!assignDept}>Assign department</Button>
                </div>
                <p className="mt-1 text-xs text-slate-500">Each person's direct manager becomes their reviewer and is notified. Performance is snapshotted from the linked cycle at this moment.</p>
              </section>
            )}
            {box.data && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">9-box</h3>
                <NineBoxGrid box={box.data} onCell={(x) => setCell(cell === x ? null : x)} />
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{cell ? `Reviews in ${nineBoxLabel(cell)}` : 'Reviews'}{cell && <button type="button" className="ml-2 text-xs text-brand-700 underline" onClick={() => setCell(null)}>show all</button>}</h3>
              <DataTable columns={reviewColumns} rows={reviews.data?.data ?? []} rowKey={(r) => r.id} loading={reviews.isLoading} onRowClick={(r) => onOpenReview(r.id)} emptyTitle="No reviews" />
            </section>
          </div>
        )}
      </Modal>
      <ConfirmDialog open={confirm === 'activate'} title="Activate this cycle?" message="Employees can then be assigned and reviewers notified. Bucket rules must be complete first." confirmLabel="Activate" onConfirm={() => run(() => m.activateCycle.mutateAsync(id!), 'Cycle active')} onCancel={() => setConfirm(null)} loading={m.activateCycle.isPending} />
      <ConfirmDialog open={confirm === 'review'} title="Stop assigning?" message="No new employees can be assigned; reviewers can still submit." confirmLabel="Move to review" onConfirm={() => run(() => m.openReview.mutateAsync(id!), 'Cycle in review')} onCancel={() => setConfirm(null)} loading={m.openReview.isPending} />
      <ConfirmDialog open={confirm === 'close'} title="Close this cycle?" message="Submitted assessments become final and the cycle is immutable. Unsubmitted reviews stay unsubmitted." confirmLabel="Close cycle" variant="danger" onConfirm={() => run(() => m.closeCycle.mutateAsync(id!), 'Cycle closed')} onCancel={() => setConfirm(null)} loading={m.closeCycle.isPending} />
    </>
  );
}

/** The review form: context first, then one judgment on the organization's scale, then the cell it lands in. */
function ReviewModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { user, hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.TALENT_MANAGE);
  const ctx = useTalentReviewContext(id);
  const cycle = useTalentCycle(ctx.data?.review.cycle.id ?? null);
  const m = useTalentMutations();
  const toast = useToast();
  const [potentialLevel, setLevel] = useState('');
  const [potentialComment, setComment] = useState('');
  const [reviewer, setReviewer] = useState<PayrollEmployeeOption | null>(null);
  const [devOpen, setDevOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (id) { setErr(null); setLevel(''); setComment(''); setReviewer(null); } }, [id]);
  const r = ctx.data?.review;
  const isReviewer = !!r && r.reviewer.userId === user?.id;
  const canSubmit = isReviewer && r.status === 'ASSIGNED' && (r.cycle.status === 'ACTIVE' || r.cycle.status === 'REVIEW');
  const submit = async () => { setErr(null); try { await m.submitPotential.mutateAsync({ id: id!, input: { potentialLevel: potentialLevel as never, potentialComment: potentialComment || null } }); toast.success('Potential assessment submitted'); } catch (e) { setErr(errorMessage(e)); } };
  const reassign = async () => { setErr(null); try { await m.reassign.mutateAsync({ id: id!, reviewerEmployeeId: reviewer!.id }); toast.success('Reviewer reassigned'); setReviewer(null); } catch (e) { setErr(errorMessage(e)); } };
  const levels = cycle.data?.potentialLevels ?? [];
  return (
    <>
      <Modal open={!!id && !devOpen} onClose={onClose} title={r ? `${r.employee.firstName} ${r.employee.lastName}` : 'Talent review'} description={r ? `${r.cycle.name} · ${r.snapshot.jobTitle ?? '—'}${r.snapshot.departmentName ? ` · ${r.snapshot.departmentName}` : ''}` : undefined} size="lg"
        footer={<div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button>{manage && r && <Button variant="secondary" onClick={() => setDevOpen(true)}>Create development need</Button>}{canSubmit && <Button onClick={submit} loading={m.submitPotential.isPending} disabled={!potentialLevel}>Submit assessment</Button>}</div>}>
        {ctx.isLoading && <LoadingBlock />}
        {ctx.isError && <Alert>Could not load this review.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {r && ctx.data && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-3"><ReviewStatusBadge status={r.status} /><span className="text-slate-500">reviewer {r.reviewer.name ?? 'not assigned'}</span></div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Performance" value={r.performance.ratingLabel ?? '—'} hint={r.performance.score ? `${r.performance.score} · ${r.performance.cycleName}` : 'no finalized result in the linked cycle'} />
              <Stat label="Performance bucket" value={<BucketBadge value={r.performance.bucket} />} />
              <Stat label="Competency vs current job" value={ctx.data.competencySummary ? `${ctx.data.competencySummary.gaps} gap(s)` : '—'} hint={ctx.data.competencySummary ? `${ctx.data.competencySummary.assessed} of ${ctx.data.competencySummary.requirements} assessed` : 'no job profile'} />
              <Stat label="Development" value={ctx.data.development.openNeeds} hint={ctx.data.development.activeIdpTitle ?? 'no active plan'} />
            </div>
            {ctx.data.priorReviews.length > 0 && <p className="text-xs text-slate-500">Earlier cycles: {ctx.data.priorReviews.map((p) => `${p.cycleName} — ${nineBoxLabel(p.nineBoxCell)}`).join(' · ')}</p>}
            {r.status === 'ASSIGNED' && !canSubmit && manage && (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reassign reviewer</h3>
                <EmployeePicker label="New reviewer" value={reviewer} onChange={setReviewer} endpoint="/talent/employee-options" />
                <Button size="sm" variant="secondary" onClick={reassign} loading={m.reassign.isPending} disabled={!reviewer}>Reassign</Button>
              </section>
            )}
            {canSubmit ? (
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Potential assessment</h3>
                <Alert tone="info">Potential is an organizational talent judgment on this cycle's own scale; the organization defines what each level means. Base it on the role and the evidence above — never on age, gender, health, family, religion, pay, absence or disciplinary history.</Alert>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {levels.map((l) => (
                    <button key={l.code} type="button" onClick={() => setLevel(l.code)} className={`rounded-md border p-3 text-left ${potentialLevel === l.code ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                      <div className="font-medium text-slate-900">{l.label}</div>{l.description && <div className="text-xs text-slate-500">{l.description}</div>}
                    </button>
                  ))}
                </div>
                <Textarea label="Comment (reviewer and HR only)" rows={3} value={potentialComment} onChange={(e) => setComment(e.target.value)} />
                <p className="text-xs text-slate-500">Submitted once. The result places the employee in a 9-box cell for the cycle — a picture, not a rank, and nothing happens to anybody because of it.</p>
              </section>
            ) : (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Result</h3>
                <div className="flex flex-wrap items-center gap-3"><span className="text-slate-500">Potential</span><BucketBadge value={r.potentialLevel} label={levels.find((l) => l.code === r.potentialLevel)?.label} /><span className="text-slate-500">9-box</span><span className="text-slate-900">{nineBoxLabel(r.nineBoxCell)}</span></div>
                {r.commentVisible && r.potentialComment && <p className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-slate-700">{r.potentialComment}</p>}
                {r.status === 'ASSIGNED' && <p className="text-xs text-slate-500">Waiting for the assigned reviewer.</p>}
              </section>
            )}
          </div>
        )}
      </Modal>
      {r && <DevelopmentActionModal open={devOpen} onClose={() => setDevOpen(false)} employeeId={r.employee.id} employeeName={`${r.employee.firstName} ${r.employee.lastName}`} competencies={[]} source={{ type: 'TALENT_REVIEW', id: r.id }} />}
    </>
  );
}
