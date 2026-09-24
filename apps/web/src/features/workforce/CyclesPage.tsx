import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type WorkforceCycleDto } from '@hr/shared';
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
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useWorkforceCycles, useWorkforceMutations, useWorkforceOptions } from './workforce.api';
import { CycleStatusBadge, titleCase } from './workforce-ui';

export function CyclesPage() {
  const { hasPermission } = useAuth();
  const plan = hasPermission(PERMISSIONS.WORKFORCE_PLAN) || hasPermission(PERMISSIONS.WORKFORCE_MANAGE);
  const manage = hasPermission(PERMISSIONS.WORKFORCE_MANAGE);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; status: string; name: string } | null>(null);
  const list = useWorkforceCycles({ status, page, pageSize: 20 });
  const m = useWorkforceMutations();
  const toast = useToast();
  const columns: Column<WorkforceCycleDto>[] = [
    { key: 'name', header: 'Cycle', render: (c) => <div><div className="font-medium text-slate-900">{c.name}</div><div className="text-xs text-slate-400">{c.code} · {c.organizationName ?? 'All organizations'}</div></div> },
    { key: 'period', header: 'Period', hideBelow: 'sm', render: (c) => <span className="tabular-nums">{c.periodStart} → {c.periodEnd}</span> },
    { key: 'rows', header: 'Rows', hideBelow: 'md', render: (c) => <span className="tabular-nums">{c.itemCount}</span> },
    { key: 'status', header: 'Status', render: (c) => <CycleStatusBadge status={c.status} /> },
    { key: 'actions', header: '', render: (c) => (
      <div className="flex flex-wrap justify-end gap-1">
        {plan && c.status === 'DRAFT' && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setConfirm({ id: c.id, status: 'ACTIVE', name: c.name }); }}>Send to review</Button>}
        {plan && c.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setConfirm({ id: c.id, status: 'DRAFT', name: c.name }); }}>Back to draft</Button>}
        {manage && c.status === 'ACTIVE' && <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setConfirm({ id: c.id, status: 'FINALIZED', name: c.name }); }}>Finalize</Button>}
        {manage && (c.status === 'FINALIZED' || c.status === 'DRAFT') && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setConfirm({ id: c.id, status: 'ARCHIVED', name: c.name }); }}>Archive</Button>}
      </div>
    ) },
  ];
  const messages: Record<string, string> = { ACTIVE: 'The plan becomes read-only for review. You can send it back to draft.', DRAFT: 'The plan becomes editable again.', FINALIZED: 'Current headcount is re-captured on every row and the plan is frozen. Nothing is created, closed, transferred or opened — execution happens through the operational modules.', ARCHIVED: 'The cycle becomes historical. It stays readable.' };
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={['DRAFT', 'ACTIVE', 'FINALIZED', 'ARCHIVED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div />
          {plan && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Planning cycle</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load planning cycles.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} emptyTitle="No planning cycles" emptyDescription="A cycle holds one headcount plan for a period, e.g. 2027 Workforce Plan." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <CycleFormModal open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog open={!!confirm} title={confirm ? `${titleCase(confirm.status)}: ${confirm.name}?` : ''} message={confirm ? messages[confirm.status] : ''} confirmLabel={confirm ? titleCase(confirm.status) : 'Confirm'} loading={m.transitionCycle.isPending}
        onConfirm={async () => { if (!confirm) return; try { await m.transitionCycle.mutateAsync({ id: confirm.id, status: confirm.status }); toast.success(`Cycle ${confirm.status.toLowerCase()}`); } catch (e) { toast.error(errorMessage(e)); } setConfirm(null); }} onCancel={() => setConfirm(null)} />
    </>
  );
}

function CycleFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useWorkforceMutations();
  const options = useWorkforceOptions();
  const toast = useToast();
  const year = new Date().getFullYear() + 1;
  const [form, setForm] = useState({ code: `WFP-${year}`, name: `${year} Workforce Plan`, organizationId: '', periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, description: '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => { setErr(null); try { await m.createCycle.mutateAsync({ code: form.code, name: form.name, organizationId: form.organizationId || null, periodStart: form.periodStart, periodEnd: form.periodEnd, description: form.description || null }); toast.success('Planning cycle created'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open={open} onClose={onClose} title="New planning cycle" description="A container for one headcount plan. Initialize it from the current workforce on the Headcount plan tab." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createCycle.isPending}>Create</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Code" value={form.code} onChange={set('code')} /><Input label="Name" value={form.name} onChange={set('name')} /></div>
        <Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={form.organizationId} onChange={set('organizationId')} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Period start" type="date" value={form.periodStart} onChange={set('periodStart')} /><Input label="Period end" type="date" value={form.periodEnd} onChange={set('periodEnd')} /></div>
        <Textarea label="Description" value={form.description} onChange={set('description')} />
      </div>
    </Modal>
  );
}
