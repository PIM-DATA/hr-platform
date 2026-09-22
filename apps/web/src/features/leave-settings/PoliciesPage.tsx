import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { EMPLOYMENT_TYPES, type LeavePolicyDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { errorMessage, RowActions, useStatusConfirm } from '@/features/organization/shared';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { useLeavePolicies, useLeaveTypes, useLeaveWorkflowOptions, useResourceMutations } from './leave-settings.api';

export function PoliciesPage() {
  const list = useLeavePolicies();
  const m = useResourceMutations<LeavePolicyDto>('/leave/policies');
  const confirm = useStatusConfirm('policy', m);
  const [form, setForm] = useState<{ open: boolean; row: LeavePolicyDto | null }>({ open: false, row: null });
  const columns: Column<LeavePolicyDto>[] = [
    { key: 'name', header: 'Name', render: (p) => <span className="font-medium text-slate-900">{p.name}</span> },
    { key: 'type', header: 'Leave type', render: (p) => p.leaveType.name },
    { key: 'org', header: 'Organization', hideBelow: 'sm', render: (p) => (p.organization ? p.organization.name : <span className="italic text-slate-500">Global</span>) },
    { key: 'emp', header: 'Employment', hideBelow: 'md', render: (p) => (p.employmentType ? p.employmentType.replace('_', ' ') : <span className="italic text-slate-500">Any</span>) },
    { key: 'units', header: 'Annual units', hideBelow: 'sm', render: (p) => <span className="tabular-nums">{p.annualUnits}</span> },
    { key: 'eff', header: 'Effective', hideBelow: 'lg', render: (p) => <span className="whitespace-nowrap text-slate-600">{p.effectiveFrom} → {p.effectiveTo ?? 'open'}</span> },
    { key: 'wf', header: 'Workflow', hideBelow: 'lg', render: (p) => <span className="font-mono text-xs">{p.workflowDefinitionCode ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (p) => <RowActions isActive={p.isActive} onEdit={() => setForm({ open: true, row: p })} onToggle={() => confirm.ask({ id: p.id, label: p.name, isActive: p.isActive })} /> },
  ];
  return (
    <>
      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <p className="text-sm text-slate-500">Resolution precedence: organization + employment type → organization → employment type → global. New policies start inactive; activation validates overlap and workflow compatibility.</p>
          <Button onClick={() => setForm({ open: true, row: null })}><Plus className="h-4 w-4" /> New policy</Button>
        </div>
        {list.isError && <Alert className="m-4">Could not load policies.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(p) => p.id} loading={list.isLoading} emptyTitle="No policies" />
      </Card>
      <PolicyFormModal open={form.open} row={form.row} onClose={() => setForm({ open: false, row: null })} />
      {confirm.dialog}
    </>
  );
}

const blank = { name: '', leaveTypeId: '', organizationId: '', employmentType: '', annualUnits: '10', isPaid: true, requiresReason: false, requiresAttachment: false, allowHalfDay: true, allowNegativeBalance: false, maxConsecutiveDays: '', minNoticeDays: '', allowBackdate: false, carryForwardMaxUnits: '0', carryForwardExpiryMonths: '', workflowDefinitionCode: '', effectiveFrom: '', effectiveTo: '' };

function PolicyFormModal({ open, row, onClose }: { open: boolean; row: LeavePolicyDto | null; onClose: () => void }) {
  const m = useResourceMutations<LeavePolicyDto>('/leave/policies');
  const toast = useToast();
  const types = useLeaveTypes({ status: 'active' });
  const orgs = useOrganizationOptions();
  const workflows = useLeaveWorkflowOptions(open);
  const [v, setV] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setV(row ? {
      name: row.name, leaveTypeId: row.leaveType.id, organizationId: row.organization?.id ?? '', employmentType: row.employmentType ?? '', annualUnits: String(row.annualUnits), isPaid: row.isPaid, requiresReason: row.requiresReason,
      requiresAttachment: row.requiresAttachment, allowHalfDay: row.allowHalfDay, allowNegativeBalance: row.allowNegativeBalance, maxConsecutiveDays: row.maxConsecutiveDays?.toString() ?? '', minNoticeDays: row.minNoticeDays?.toString() ?? '',
      allowBackdate: row.allowBackdate, carryForwardMaxUnits: String(row.carryForwardMaxUnits), carryForwardExpiryMonths: row.carryForwardExpiryMonths?.toString() ?? '', workflowDefinitionCode: row.workflowDefinitionCode ?? '', effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo ?? '',
    } : blank);
  }, [open, row]);
  const set = (patch: Partial<typeof blank>) => setV((p) => ({ ...p, ...patch }));
  const submit = async () => {
    setErr(null);
    const input = {
      name: v.name, leaveTypeId: v.leaveTypeId, organizationId: v.organizationId || null, employmentType: v.employmentType || null, annualUnits: v.annualUnits, isPaid: v.isPaid, requiresReason: v.requiresReason, requiresAttachment: v.requiresAttachment,
      allowHalfDay: v.allowHalfDay, allowNegativeBalance: v.allowNegativeBalance, maxConsecutiveDays: v.maxConsecutiveDays || null, minNoticeDays: v.minNoticeDays || null, allowBackdate: v.allowBackdate, carryForwardMaxUnits: v.carryForwardMaxUnits || 0,
      carryForwardExpiryMonths: v.carryForwardExpiryMonths || null, workflowDefinitionCode: v.workflowDefinitionCode || null, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo || null,
    };
    try {
      if (row) await m.update.mutateAsync({ id: row.id, input }); else await m.create.mutateAsync(input);
      toast.success(row ? 'Policy updated' : 'Policy created', row ? undefined : 'Activate it when ready — activation validates overlap and workflow.'); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const busy = m.create.isPending || m.update.isPending;
  const Cb = ({ k, label }: { k: keyof typeof blank; label: string }) => <Checkbox label={label} checked={v[k] as boolean} onChange={(e) => set({ [k]: e.target.checked } as Partial<typeof blank>)} />;
  return (
    <Modal open={open} onClose={onClose} size="lg" title={row ? 'Edit policy' : 'New policy'} footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy}>{row ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-5">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Input label="Name" required value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="Annual leave — Company A full-time" /></div>
          <Select label="Leave type" required options={(types.data?.data ?? []).map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))} placeholder="Select…" value={v.leaveTypeId} onChange={(e) => set({ leaveTypeId: e.target.value })} />
          <Select label="Organization" options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Global (any organization)" value={v.organizationId} onChange={(e) => set({ organizationId: e.target.value })} />
          <Select label="Employment type" options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }))} placeholder="Any employment type" value={v.employmentType} onChange={(e) => set({ employmentType: e.target.value })} />
          <Input label="Annual units (days)" type="number" step={0.5} min={0} required value={v.annualUnits} onChange={(e) => set({ annualUnits: e.target.value })} hint="Multiples of 0.5" />
          <Input label="Effective from" type="date" required value={v.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
          <Input label="Effective to" type="date" value={v.effectiveTo} onChange={(e) => set({ effectiveTo: e.target.value })} hint="Leave empty for open-ended" />
          <Select label="Workflow" options={(workflows.data ?? []).map((w) => ({ value: w.code, label: `${w.code} v${w.version} — ${w.steps.map((s) => s.approverType.replace('_', ' ').toLowerCase()).join(' → ')}` }))} placeholder="— required before activation —" value={v.workflowDefinitionCode} onChange={(e) => set({ workflowDefinitionCode: e.target.value })} />
          <Input label="Max consecutive days" type="number" min={1} value={v.maxConsecutiveDays} onChange={(e) => set({ maxConsecutiveDays: e.target.value })} />
          <Input label="Min notice days" type="number" min={0} value={v.minNoticeDays} onChange={(e) => set({ minNoticeDays: e.target.value })} />
          <Input label="Carry-forward max units" type="number" step={0.5} min={0} value={v.carryForwardMaxUnits} onChange={(e) => set({ carryForwardMaxUnits: e.target.value })} />
          <Input label="Carry-forward expiry (months)" type="number" min={1} value={v.carryForwardExpiryMonths} onChange={(e) => set({ carryForwardExpiryMonths: e.target.value })} />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Cb k="isPaid" label="Paid leave" /><Cb k="requiresReason" label="Requires reason" /><Cb k="requiresAttachment" label="Requires attachment" />
          <Cb k="allowHalfDay" label="Allow half day" /><Cb k="allowNegativeBalance" label="Allow negative balance" /><Cb k="allowBackdate" label="Allow backdated requests" />
        </div>
      </div>
    </Modal>
  );
}
