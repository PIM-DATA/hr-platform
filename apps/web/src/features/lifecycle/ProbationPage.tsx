import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PERMISSIONS, PROBATION_OUTCOMES, type ProbationCaseDto } from '@hr/shared';
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
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useLifecycleMutations, useLifecycleOptions, useProbationCase, useProbationCases, useProbationPolicies } from './lifecycle.api';
import { LifecycleBadge, SnapshotVsCurrent, titleCase } from './lifecycle-ui';

export function ProbationPage() {
  const { hasPermission, user } = useAuth();
  const manage = hasPermission(PERMISSIONS.PROBATION_MANAGE);
  const team = user?.dataScope === 'TEAM';
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const openId = params.get('open');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('open', id); else n.delete('open'); setParams(n, { replace: true }); };
  const list = useProbationCases({ status, page, pageSize: 20, mine: team ? 'true' : undefined });
  const columns: Column<ProbationCaseDto>[] = [
    { key: 'e', header: 'Employee', render: (c) => <div><div className="font-medium text-slate-900">{c.snapshot.employeeName}</div><div className="text-xs text-slate-400">{c.snapshot.employeeCode} · {c.snapshot.department ?? '—'}{c.policyName && ` · ${c.policyName}`}</div></div> },
    { key: 'period', header: 'Period', render: (c) => <span className="tabular-nums">{c.startDate} → {c.currentEndDate}{c.extensions > 0 && <span className="ml-1 text-xs text-amber-800">(+{c.extensions})</span>}</span> },
    { key: 'due', header: 'Due', hideBelow: 'sm', render: (c) => (['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(c.status) ? <span className={c.daysRemaining < 0 ? 'text-red-700' : c.daysRemaining <= 14 ? 'text-amber-800' : 'text-slate-600'}>{c.daysRemaining < 0 ? `${-c.daysRemaining} days overdue` : `in ${c.daysRemaining} days`}</span> : <span className="text-slate-400">—</span>) },
    { key: 'rev', header: 'Reviewer', hideBelow: 'md', render: (c) => c.reviewerName ?? <span className="text-amber-800">unassigned</span> },
    { key: 'status', header: 'Status', render: (c) => <LifecycleBadge status={c.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={['ACTIVE', 'PENDING_REVIEW', 'EXTENDED', 'PASSED', 'NOT_PASSED', 'CANCELLED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div />
          {manage && <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setPoliciesOpen(true)}>Policies</Button><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Probation case</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load probation cases.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} onRowClick={(c) => setOpen(c.id)} emptyTitle="No probation cases" emptyDescription={team ? 'Cases you review or that belong to your team appear here.' : 'Open a case for a new employee from a policy.'} />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {creating && <CreateCaseModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {policiesOpen && <PoliciesModal onClose={() => setPoliciesOpen(false)} />}
      {openId && <CaseModal id={openId} onClose={() => setOpen(null)} />}
    </>
  );
}

function PoliciesModal({ onClose }: { onClose: () => void }) {
  const policies = useProbationPolicies();
  const m = useLifecycleMutations();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', durationDays: '', reviewLeadDays: '14', allowExtension: true, maxExtensionDays: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); try { await m.createPolicy.mutateAsync({ name: form.name, durationDays: Number(form.durationDays), reviewLeadDays: form.reviewLeadDays ? Number(form.reviewLeadDays) : null, allowExtension: form.allowExtension, maxExtensionDays: form.maxExtensionDays ? Number(form.maxExtensionDays) : null }); toast.success('Policy created'); setForm({ ...form, name: '', durationDays: '' }); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="Probation policies" description="Durations are yours to set. Nothing is hardcoded." footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">{(policies.data ?? []).map((p) => <li key={p.id} className="flex items-center justify-between px-3 py-2"><span>{p.name} <span className="text-xs text-slate-400">{p.durationDays} days{p.allowExtension ? ` · extension up to ${p.maxExtensionDays ?? '∞'} days` : ' · no extension'}{p.reviewLeadDays !== null && ` · review ${p.reviewLeadDays} days before`}</span></span></li>)}{policies.data?.length === 0 && <li className="px-3 py-2 text-slate-400">No policies yet.</li>}</ul>
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><Input label="Duration (days)" type="number" min={1} value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: e.target.value })} /><Input label="Review lead (days before end)" type="number" min={0} value={form.reviewLeadDays} onChange={(e) => setForm({ ...form, reviewLeadDays: e.target.value })} /><Input label="Max extension (days, total)" type="number" min={1} value={form.maxExtensionDays} onChange={(e) => setForm({ ...form, maxExtensionDays: e.target.value })} /></div>
        <div className="flex items-center justify-between"><Checkbox label="Allow extension" checked={form.allowExtension} onChange={(e) => setForm({ ...form, allowExtension: e.target.checked })} /><Button size="sm" onClick={submit} loading={m.createPolicy.isPending} disabled={!form.name || !form.durationDays}>Add policy</Button></div>
      </div>
    </Modal>
  );
}

export function CreateCaseModal({ onClose, onCreated, presetEmployeeId }: { onClose: () => void; onCreated: (id: string) => void; presetEmployeeId?: string }) {
  const m = useLifecycleMutations();
  const policies = useProbationPolicies();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(presetEmployeeId ? ({ id: presetEmployeeId } as PayrollEmployeeOption) : null);
  const [form, setForm] = useState({ policyId: '', startDate: '', durationDays: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); if (!employee) return; try { const c = await m.createProbation.mutateAsync({ employeeId: employee.id, policyId: form.policyId || null, startDate: form.startDate || undefined, durationDays: form.durationDays ? Number(form.durationDays) : undefined }); onCreated(c.id); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="Open a probation case" description="The end date is computed from the policy; the reviewer defaults to the employee's manager." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createProbation.isPending} disabled={!employee || (!form.policyId && !form.durationDays)}>Create</Button></>}>
      <div className="space-y-3">{err && <Alert>{err}</Alert>}{!presetEmployeeId && <EmployeePicker value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" />}<div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Policy" options={(policies.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.durationDays} days)` }))} placeholder="Custom duration" value={form.policyId} onChange={(e) => setForm({ ...form, policyId: e.target.value })} /><Input label="Start (defaults to hire date)" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />{!form.policyId && <Input label="Duration (days)" type="number" min={1} value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: e.target.value })} />}</div></div>
    </Modal>
  );
}

function CaseModal({ id, onClose }: { id: string; onClose: () => void }) {
  const c = useProbationCase(id);
  const m = useLifecycleMutations();
  const options = useLifecycleOptions();
  const toast = useToast();
  const [review, setReview] = useState({ outcome: '', comment: '', extensionEndDate: '', reviewDate: '' });
  const [reviewer, setReviewer] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (c.isLoading) return <Modal open onClose={onClose} title="Probation"><LoadingBlock /></Modal>;
  if (!c.data) return <Modal open onClose={onClose} title="Probation"><Alert>Could not load this case.</Alert></Modal>;
  const d = c.data;
  const submit = async () => { setErr(null); try { await m.submitReview.mutateAsync({ id, input: { outcome: review.outcome as never, comment: review.comment || null, extensionEndDate: review.outcome === 'EXTEND' ? review.extensionEndDate : null, reviewDate: review.reviewDate || undefined } }); toast.success('Review recorded'); setReview({ outcome: '', comment: '', extensionEndDate: '', reviewDate: '' }); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title={`${d.snapshot.employeeName} — probation`} description={`${d.snapshot.employeeCode} · ${d.policyName ?? 'custom duration'}`} size="lg" footer={<>{d.can.manage && ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(d.status) && <Button variant="ghost" onClick={async () => { try { await m.cancelProbation.mutateAsync(id); toast.success('Case cancelled'); } catch (e) { toast.error(errorMessage(e)); } }}>Cancel case</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm"><LifecycleBadge status={d.status} /><span>Original end <b>{d.originalEndDate}</b></span><span>· current end <b>{d.currentEndDate}</b></span>{d.finalOutcome && <span>· outcome <b>{titleCase(d.finalOutcome)}</b></span>}{['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(d.status) && <span className="text-xs text-slate-500">· {d.daysRemaining} days remaining</span>}</div>
        <SnapshotVsCurrent snapshot={d.snapshot} current={d.current} />
        <div><div className="mb-1 text-xs font-semibold uppercase text-slate-500">History</div><ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm"><li className="px-3 py-2 text-slate-600">{d.startDate}: probation started, planned end {d.originalEndDate}</li>{d.reviews.map((r) => <li key={r.id} className="px-3 py-2"><div><b>{titleCase(r.outcome)}</b> on {r.reviewDate} by {r.reviewerName ?? 'reviewer'}{r.extensionEndDate && ` → new end ${r.extensionEndDate}`}</div>{r.comment && <div className="text-xs text-slate-600">{r.comment}</div>}</li>)}</ul></div>
        {d.can.manage && ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(d.status) && <div className="flex items-end gap-2"><div className="flex-1"><Select label={`Reviewer${d.reviewerName ? ` (currently ${d.reviewerName})` : ' (unassigned)'}`} options={(options.data?.users ?? []).map((u) => ({ value: u.id, label: u.label }))} placeholder="Choose" value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></div><Button size="sm" variant="secondary" disabled={!reviewer} onClick={async () => { try { await m.reassignReviewer.mutateAsync({ id, reviewerUserId: reviewer }); toast.success('Reviewer reassigned'); } catch (e) { toast.error(errorMessage(e)); } }}>Reassign</Button></div>}
        {d.can.review && (
          <div className="space-y-3 rounded-md border border-brand-200 bg-brand-50 p-3" data-testid="probation-review">
            <div className="text-sm font-semibold text-slate-900">Record your review</div>
            {err && <Alert>{err}</Alert>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Outcome" options={PROBATION_OUTCOMES.map((o) => ({ value: o, label: titleCase(o) }))} placeholder="Choose" value={review.outcome} onChange={(e) => setReview({ ...review, outcome: e.target.value })} /><Input label="Review date" type="date" value={review.reviewDate} onChange={(e) => setReview({ ...review, reviewDate: e.target.value })} />{review.outcome === 'EXTEND' && <Input label="New end date" type="date" value={review.extensionEndDate} onChange={(e) => setReview({ ...review, extensionEndDate: e.target.value })} />}</div>
            <Textarea label="Comment (visible to HR and reviewers, never to the employee)" value={review.comment} onChange={(e) => setReview({ ...review, comment: e.target.value })} />
            <div className="flex items-center justify-between"><p className="text-xs text-slate-500">Your decision. The system shows no score and makes no recommendation; NOT PASS records an outcome and changes no employment status.</p><Button size="sm" onClick={submit} loading={m.submitReview.isPending} disabled={!review.outcome}>Submit review</Button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}
