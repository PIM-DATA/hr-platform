import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { OPENING_STATUSES, PERMISSIONS, type OpeningDto } from '@hr/shared';
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
import { useOpening, useOpenings, useRecruitmentMutations, useRequisitions } from './recruitment.api';
import { OpeningStatusBadge, Section } from './recruitment-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function OpeningsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useOpenings({ status, page, pageSize: 20 });
  const columns: Column<OpeningDto>[] = [
    { key: 'number', header: 'Opening', render: (o) => <div><div className="font-medium text-slate-900">{o.snapshot.title}</div><div className="text-xs text-slate-400">{o.openingNumber} · from {o.requisitionNumber}</div></div> },
    { key: 'where', header: 'Department', hideBelow: 'md', render: (o) => o.snapshot.departmentName ?? <span className="text-slate-400">—</span> },
    { key: 'hm', header: 'Hiring manager', hideBelow: 'lg', render: (o) => o.hiringManager.name ?? <span className="text-slate-400">—</span> },
    { key: 'filled', header: 'Filled', render: (o) => <span className="tabular-nums">{o.filledCount} / {o.openingsCount}{o.isFull && <span className="ml-1 text-xs text-amber-700">full</span>}</span> },
    { key: 'active', header: 'Active applications', hideBelow: 'sm', render: (o) => <span className="tabular-nums">{o.activeApplications}</span> },
    { key: 'status', header: 'Status', render: (o) => <OpeningStatusBadge status={o.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={OPENING_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div className="hidden sm:block" />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Opening</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load openings.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(o) => o.id} loading={list.isLoading} onRowClick={(o) => setOpenId(o.id)} emptyTitle="No openings" emptyDescription="An opening is created from an approved requisition and takes applications once it is opened." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <OpeningFormModal open={creating} onClose={() => setCreating(false)} />
      <OpeningDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function OpeningFormModal({ open, onClose, existing }: { open: boolean; onClose: () => void; existing?: OpeningDto | null }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const approved = useRequisitions({ status: 'APPROVED', page: 1, pageSize: 100 });
  const [requisitionId, setReq] = useState('');
  const [openingsCount, setCount] = useState('1');
  const [description, setDesc] = useState('');
  const [requirementsText, setReqs] = useState('');
  const [targetCloseDate, setTarget] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setReq(existing?.requisitionId ?? ''); setCount(String(existing?.openingsCount ?? 1)); setDesc(existing?.description ?? ''); setReqs(existing?.requirementsText ?? ''); setTarget(existing?.targetCloseDate ?? ''); } }, [open, existing]);
  const chosen = (approved.data?.data ?? []).find((r) => r.id === requisitionId);
  const remaining = chosen ? chosen.requestedOpenings - chosen.openings.filter((o) => o.status !== 'CANCELLED').reduce((n, o) => n + o.openingsCount, 0) : null;
  const submit = async () => {
    setErr(null);
    try {
      if (existing) await m.updateOpening.mutateAsync({ id: existing.id, input: { openingsCount: Number(openingsCount), description: description || null, requirementsText: requirementsText || null, targetCloseDate: targetCloseDate || null } });
      else await m.createOpening.mutateAsync({ requisitionId, openingsCount: Number(openingsCount), description: description || null, requirementsText: requirementsText || null, targetCloseDate: targetCloseDate || null });
      toast.success(existing ? 'Opening updated' : 'Opening drafted');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title={existing ? `Edit ${existing.openingNumber}` : 'New opening'} description="A vacancy inside the ATS. Opening it takes applications here; nothing is published anywhere." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createOpening.isPending || m.updateOpening.isPending} disabled={(!existing && !requisitionId) || !Number(openingsCount)}>{existing ? 'Save' : 'Create draft'}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        {!existing && <Select label="Approved requisition" required options={(approved.data?.data ?? []).map((r) => ({ value: r.id, label: `${r.requisitionNumber} · ${r.snapshot?.jobTitle ?? r.job.title}${r.snapshot?.departmentName ? ` · ${r.snapshot.departmentName}` : ''}` }))} placeholder="Select…" value={requisitionId} onChange={(e) => setReq(e.target.value)} />}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Number of openings" required type="number" min={1} value={openingsCount} onChange={(e) => setCount(e.target.value)} hint={remaining !== null ? `${remaining} of ${chosen!.requestedOpenings} approved head(s) still unallocated` : undefined} />
          <Input label="Target close date" type="date" value={targetCloseDate} onChange={(e) => setTarget(e.target.value)} />
        </div>
        <Textarea label="Description" rows={3} value={description} onChange={(e) => setDesc(e.target.value)} />
        <Textarea label="Requirements" rows={3} value={requirementsText} onChange={(e) => setReqs(e.target.value)} />
      </div>
    </Modal>
  );
}

function OpeningDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const q = useOpening(id);
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'open' | 'hold' | 'close' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const o = q.data;
  const run = async (fn: () => Promise<unknown>, done: string) => { setErr(null); try { await fn(); toast.success(done); } catch (e) { setErr(errorMessage(e)); } setConfirm(null); };
  return (
    <>
      <Modal open={!!id && !editing} onClose={onClose} title={o ? `${o.openingNumber} · ${o.snapshot.title}` : 'Opening'} size="lg"
        footer={o && canManage ? (
          <>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {(o.status === 'DRAFT' || o.status === 'OPEN' || o.status === 'ON_HOLD') && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
            {(o.status === 'DRAFT' || o.status === 'ON_HOLD') && <Button onClick={() => setConfirm('open')}>{o.status === 'DRAFT' ? 'Open for applications' : 'Reopen'}</Button>}
            {o.status === 'OPEN' && <Button variant="secondary" onClick={() => setConfirm('hold')}>Put on hold</Button>}
            {(o.status === 'DRAFT' || o.status === 'OPEN' || o.status === 'ON_HOLD') && <Button variant="danger" onClick={() => setConfirm('close')}>{o.status === 'DRAFT' ? 'Cancel opening' : 'Close opening'}</Button>}
          </>
        ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this opening.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {o && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3"><OpeningStatusBadge status={o.status} /><span className="tabular-nums text-slate-600">{o.filledCount} of {o.openingsCount} filled</span>{o.isFull && <span className="text-xs text-amber-700">headcount reached — closing is your call</span>}{o.openedAt && <span className="text-slate-500">opened {o.openedAt.slice(0, 10)}</span>}{o.targetCloseDate && <span className="text-slate-500">target close {o.targetCloseDate}</span>}</div>
            <Section title="From"><p className="text-slate-700">{o.requisitionNumber} · {o.snapshot.departmentName ?? 'Any department'} · {o.snapshot.organizationName ?? '—'} · hiring manager {o.hiringManager.name ?? '—'}</p></Section>
            {o.description && <Section title="Description"><p className="whitespace-pre-wrap text-slate-700">{o.description}</p></Section>}
            {o.requirementsText && <Section title="Requirements"><p className="whitespace-pre-wrap text-slate-700">{o.requirementsText}</p></Section>}
            <p className="text-xs text-slate-500">{o.activeApplications} active application(s). Applications are managed on the Applications tab.</p>
          </div>
        )}
      </Modal>
      <OpeningFormModal open={editing} onClose={() => setEditing(false)} existing={o} />
      <ConfirmDialog open={confirm === 'open'} title="Open for applications?" message="The opening takes applications inside this system. Nothing is posted or published anywhere." confirmLabel="Open" onConfirm={() => run(() => m.openOpening.mutateAsync(id!), 'Opening is open')} onCancel={() => setConfirm(null)} loading={m.openOpening.isPending} />
      <ConfirmDialog open={confirm === 'hold'} title="Put on hold?" message="No new applications or stage moves while on hold. Existing applications keep their stage." confirmLabel="Hold" onConfirm={() => run(() => m.holdOpening.mutateAsync(id!), 'Opening on hold')} onCancel={() => setConfirm(null)} loading={m.holdOpening.isPending} />
      <ConfirmDialog open={confirm === 'close'} title={o?.status === 'DRAFT' ? 'Cancel this draft?' : 'Close this opening?'} message="Active applications are left as they are for you to reject or withdraw explicitly; nothing is decided for them." confirmLabel={o?.status === 'DRAFT' ? 'Cancel opening' : 'Close opening'} variant="danger" onConfirm={() => run(() => m.closeOpening.mutateAsync(id!), 'Opening closed')} onCancel={() => setConfirm(null)} loading={m.closeOpening.isPending} />
    </>
  );
}
