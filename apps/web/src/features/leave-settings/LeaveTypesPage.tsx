import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { LeaveTypeDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { errorMessage, RowActions, useStatusConfirm } from '@/features/organization/shared';
import { useLeaveTypes, useResourceMutations } from './leave-settings.api';

export function LeaveTypesPage() {
  const list = useLeaveTypes();
  const m = useResourceMutations<LeaveTypeDto>('/leave/types');
  const confirm = useStatusConfirm('leave type', m);
  const [form, setForm] = useState<{ open: boolean; row: LeaveTypeDto | null }>({ open: false, row: null });
  const columns: Column<LeaveTypeDto>[] = [
    { key: 'code', header: 'Code', render: (t) => <span className="font-mono text-xs">{t.code}</span> },
    { key: 'name', header: 'Name', render: (t) => <span className="font-medium text-slate-900">{t.name}</span> },
    { key: 'desc', header: 'Description', hideBelow: 'md', render: (t) => <span className="text-slate-600">{t.description ?? '—'}</span> },
    { key: 'policies', header: 'Active policies', hideBelow: 'sm', render: (t) => <span className="tabular-nums">{t.activePolicyCount}</span> },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (t) => <RowActions isActive={t.isActive} onEdit={() => setForm({ open: true, row: t })} onToggle={() => confirm.ask({ id: t.id, label: t.name, isActive: t.isActive })} /> },
  ];
  return (
    <>
      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <p className="text-sm text-slate-500">Leave types carry no business rules — those live in policies.</p>
          <Button onClick={() => setForm({ open: true, row: null })}><Plus className="h-4 w-4" /> New leave type</Button>
        </div>
        {list.isError && <Alert className="m-4">Could not load leave types.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(t) => t.id} loading={list.isLoading} emptyTitle="No leave types" emptyDescription="Create ANNUAL, SICK, PERSONAL…" />
      </Card>
      <LeaveTypeFormModal open={form.open} row={form.row} onClose={() => setForm({ open: false, row: null })} />
      {confirm.dialog}
    </>
  );
}

function LeaveTypeFormModal({ open, row, onClose }: { open: boolean; row: LeaveTypeDto | null; onClose: () => void }) {
  const m = useResourceMutations<LeaveTypeDto>('/leave/types');
  const toast = useToast();
  const [v, setV] = useState({ code: '', name: '', description: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setV({ code: row?.code ?? '', name: row?.name ?? '', description: row?.description ?? '' }); } }, [open, row]);
  const submit = async () => {
    setErr(null);
    try {
      const input = { ...v, description: v.description || null };
      if (row) await m.update.mutateAsync({ id: row.id, input }); else await m.create.mutateAsync(input);
      toast.success(row ? 'Leave type updated' : 'Leave type created'); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const busy = m.create.isPending || m.update.isPending;
  return (
    <Modal open={open} onClose={onClose} title={row ? 'Edit leave type' : 'New leave type'} size="sm" footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy}>{row ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <Input label="Code" required placeholder="ANNUAL" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} hint="Globally unique, upper-cased." />
        <Input label="Name" required placeholder="Annual Leave" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Textarea label="Description" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
      </div>
    </Modal>
  );
}
