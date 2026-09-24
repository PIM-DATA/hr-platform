import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, REQUISITION_REASONS, REQUISITION_STATUSES, type RequisitionDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useRecruitmentMutations, useRecruitmentOptions, useRequisition, useRequisitions } from './recruitment.api';
import { OpeningStatusBadge, REASON_LABEL, RequisitionStatusBadge, Section, label } from './recruitment-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function RequisitionsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useRequisitions({ status, page, pageSize: 20 });
  const columns: Column<RequisitionDto>[] = [
    { key: 'number', header: 'Requisition', render: (r) => <div><div className="font-medium text-slate-900">{r.requisitionNumber}</div><div className="text-xs text-slate-400">{r.snapshot?.jobTitle ?? r.job.title}{r.position && ` · ${r.position.title}`}</div></div> },
    { key: 'where', header: 'Department', hideBelow: 'md', render: (r) => r.snapshot?.departmentName ?? r.department?.name ?? <span className="text-slate-400">—</span> },
    { key: 'hm', header: 'Hiring manager', hideBelow: 'lg', render: (r) => r.hiringManager.name ?? <span className="text-slate-400">—</span> },
    { key: 'heads', header: 'Openings', render: (r) => <span className="tabular-nums">{r.openings.filter((o) => o.status !== 'CANCELLED').reduce((n, o) => n + o.openingsCount, 0)} / {r.requestedOpenings}</span> },
    { key: 'reason', header: 'Reason', hideBelow: 'lg', render: (r) => label(REASON_LABEL, r.reason) },
    { key: 'status', header: 'Status', render: (r) => <RequisitionStatusBadge status={r.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={REQUISITION_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div className="hidden sm:block" />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Requisition</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load requisitions.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpenId(r.id)} emptyTitle="No requisitions" emptyDescription="A requisition asks for headcount and goes through approval before any opening exists." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <RequisitionFormModal open={creating} onClose={() => setCreating(false)} />
      <RequisitionDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function RequisitionFormModal({ open, onClose, existing }: { open: boolean; onClose: () => void; existing?: RequisitionDto | null }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const options = useRecruitmentOptions();
  const [organizationId, setOrg] = useState('');
  const [departmentId, setDept] = useState('');
  const [jobId, setJob] = useState('');
  const [positionId, setPosition] = useState('');
  const [hm, setHm] = useState<PayrollEmployeeOption | null>(null);
  const [requestedOpenings, setCount] = useState('1');
  const [employmentType, setType] = useState('');
  const [reason, setReason] = useState('NEW_HEADCOUNT');
  const [desiredStartDate, setStart] = useState('');
  const [justification, setJust] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setOrg(existing?.organization?.id ?? ''); setDept(existing?.department?.id ?? ''); setJob(existing?.job.id ?? ''); setPosition(existing?.position?.id ?? '');
    setHm(existing?.hiringManager.employeeId ? { id: existing.hiringManager.employeeId, employeeCode: '', firstName: existing.hiringManager.name ?? '', lastName: '' } as PayrollEmployeeOption : null);
    setCount(String(existing?.requestedOpenings ?? 1)); setType(existing?.employmentType ?? ''); setReason(existing?.reason ?? 'NEW_HEADCOUNT'); setStart(existing?.desiredStartDate ?? ''); setJust(existing?.justification ?? '');
  }, [open, existing]);
  const departments = useMemo(() => (options.data?.departments ?? []).filter((d) => !organizationId || d.organizationId === organizationId), [options.data, organizationId]);
  const positions = useMemo(() => (options.data?.positions ?? []).filter((p) => (!departmentId || p.departmentId === departmentId) && (!jobId || p.jobId === jobId)), [options.data, departmentId, jobId]);

  const submit = async () => {
    setErr(null);
    const input = { organizationId, departmentId: departmentId || null, jobId, positionId: positionId || null, hiringManagerEmployeeId: hm?.id ?? null, requestedOpenings: Number(requestedOpenings), employmentType: (employmentType || null) as never, reason: reason as never, desiredStartDate: desiredStartDate || null, justification: justification || null };
    try {
      if (existing) await m.updateRequisition.mutateAsync({ id: existing.id, input });
      else await m.createRequisition.mutateAsync(input);
      toast.success(existing ? 'Requisition updated' : 'Requisition drafted');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title={existing ? `Edit ${existing.requisitionNumber}` : 'New requisition'} description="A request for headcount. It is a draft until you submit it for approval." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createRequisition.isPending || m.updateRequisition.isPending} disabled={!organizationId || !jobId || !Number(requestedOpenings)}>{existing ? 'Save' : 'Create draft'}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="Organization" required options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Select…" value={organizationId} onChange={(e) => { setOrg(e.target.value); setDept(''); setPosition(''); }} />
          <Select label="Department" options={departments.map((d) => ({ value: d.id, label: d.name }))} placeholder="Any" value={departmentId} onChange={(e) => { setDept(e.target.value); setPosition(''); }} />
          <Select label="Job" required options={(options.data?.jobs ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="Select…" value={jobId} onChange={(e) => { setJob(e.target.value); setPosition(''); }} />
          <Select label="Position" options={positions.map((p) => ({ value: p.id, label: `${p.title} (${p.code})` }))} placeholder="Not specified" value={positionId} onChange={(e) => setPosition(e.target.value)} />
          <Input label="Openings requested" required type="number" min={1} value={requestedOpenings} onChange={(e) => setCount(e.target.value)} />
          <Select label="Employment type" options={['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => ({ value: t, label: titleCase(t) }))} placeholder="Not specified" value={employmentType} onChange={(e) => setType(e.target.value)} />
          <Select label="Reason" required options={REQUISITION_REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] ?? r }))} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Input label="Desired start" type="date" value={desiredStartDate} onChange={(e) => setStart(e.target.value)} />
        </div>
        <EmployeePicker label="Hiring manager" value={hm} onChange={setHm} endpoint="/recruitment/employee-options" />
        <Textarea label="Justification" rows={3} value={justification} onChange={(e) => setJust(e.target.value)} />
      </div>
    </Modal>
  );
}

function RequisitionDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const q = useRequisition(id);
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'submit' | 'cancel' | 'close' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const r = q.data;
  const run = async (fn: () => Promise<unknown>, done: string) => { setErr(null); try { await fn(); toast.success(done); setConfirm(null); } catch (e) { setErr(errorMessage(e)); setConfirm(null); } };
  return (
    <>
      <Modal open={!!id && !editing} onClose={onClose} title={r ? `${r.requisitionNumber} · ${r.snapshot?.jobTitle ?? r.job.title}` : 'Requisition'} size="lg"
        footer={r && canManage ? (
          <>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {r.status === 'DRAFT' && <><Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel requisition</Button><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button onClick={() => setConfirm('submit')}>Submit for approval</Button></>}
            {r.status === 'APPROVED' && <Button variant="secondary" onClick={() => setConfirm('close')}>Close requisition</Button>}
          </>
        ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this requisition.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {r && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3"><RequisitionStatusBadge status={r.status} /><span className="text-slate-500">{label(REASON_LABEL, r.reason)}</span>{r.submittedAt && <span className="text-slate-500">submitted {r.submittedAt.slice(0, 10)}</span>}{r.approvedAt && <span className="text-slate-500">approved {r.approvedAt.slice(0, 10)}</span>}</div>
            <Section title={r.snapshot ? 'As approved (frozen at submit)' : 'Request'}>
              <p className="text-slate-800"><span className="font-medium">{r.requestedOpenings}</span> × {r.snapshot?.jobTitle ?? r.job.title}{(r.snapshot?.positionTitle ?? r.position?.title) && ` (${r.snapshot?.positionTitle ?? r.position?.title})`}{r.employmentType && ` · ${titleCase(r.employmentType)}`}</p>
              <p className="text-slate-600">{r.snapshot?.departmentName ?? r.department?.name ?? 'Any department'} · {r.snapshot?.organizationName ?? r.organization?.name} · hiring manager {r.snapshot?.hiringManagerName ?? r.hiringManager.name ?? '—'}{r.desiredStartDate && ` · desired start ${r.desiredStartDate}`}</p>
            </Section>
            {r.justification && <Section title="Justification"><p className="whitespace-pre-wrap text-slate-700">{r.justification}</p></Section>}
            <Section title="Openings">
              {r.openings.length === 0 ? <p className="text-slate-500">{r.status === 'APPROVED' ? 'No openings yet — create one from the Openings tab.' : 'Openings can be created once the requisition is approved.'}</p> : (
                <ul className="space-y-1">{r.openings.map((o) => <li key={o.id} className="flex items-center gap-2 text-slate-700"><span className="font-medium">{o.openingNumber}</span><OpeningStatusBadge status={o.status} /><span className="tabular-nums text-slate-500">{o.filledCount} / {o.openingsCount} filled</span></li>)}</ul>
              )}
            </Section>
          </div>
        )}
      </Modal>
      <RequisitionFormModal open={editing} onClose={() => setEditing(false)} existing={r} />
      <ConfirmDialog open={confirm === 'submit'} title="Submit for approval?" message="The organization, department, job, position and hiring manager are frozen as they are now; the approver decides on this snapshot." confirmLabel="Submit" onConfirm={() => run(() => m.submitRequisition.mutateAsync(id!), 'Submitted for approval')} onCancel={() => setConfirm(null)} loading={m.submitRequisition.isPending} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this draft?" message="The draft is kept as a record but can no longer be submitted." confirmLabel="Cancel requisition" variant="danger" onConfirm={() => run(() => m.cancelRequisition.mutateAsync(id!), 'Requisition cancelled')} onCancel={() => setConfirm(null)} loading={m.cancelRequisition.isPending} />
      <ConfirmDialog open={confirm === 'close'} title="Close this requisition?" message="Its openings must already be closed or cancelled. Closing records that hiring against it is over." confirmLabel="Close requisition" onConfirm={() => run(() => m.closeRequisition.mutateAsync(id!), 'Requisition closed')} onCancel={() => setConfirm(null)} loading={m.closeRequisition.isPending} />
    </>
  );
}
