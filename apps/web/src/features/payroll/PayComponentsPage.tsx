import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type PayComponentDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { errorMessage } from '@/features/organization/shared';
import { usePayComponents, usePayrollMutations } from './payroll.api';

/**
 * The things a payslip line can be.
 *
 * System components are the engine's own — base salary, overtime pay, the attendance and leave deductions. They exist
 * on every deployment, their codes never change, and they cannot be switched off: a payslip from last year still
 * refers to them by name.
 */
export function PayComponentsPage() {
  const canManage = usePermission(PERMISSIONS.PAYROLL_MANAGE);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = usePayComponents({ type, status, page, pageSize: 20 });

  const columns: Column<PayComponentDto>[] = [
    { key: 'name', header: 'Component', render: (c) => (
      <div>
        <div className="font-medium text-slate-900">{c.name}</div>
        <div className="text-xs text-slate-400">{c.code}</div>
      </div>
    ) },
    { key: 'type', header: 'Type', render: (c) => <StatusBadge status={c.type === 'EARNING' ? 'Earning' : 'Deduction'} tone={c.type === 'EARNING' ? 'success' : 'warning'} /> },
    { key: 'calc', header: 'Amount from', hideBelow: 'md', render: (c) => ({ FIXED: 'A fixed amount', MANUAL: 'Entered per run', SYSTEM: 'Calculated by payroll' })[c.calculationType] ?? c.calculationType },
    { key: 'recurring', header: 'Recurring', hideBelow: 'lg', render: (c) => (c.recurringAllowed ? 'Allowed' : <span className="text-slate-400">No</span>) },
    { key: 'origin', header: 'Origin', hideBelow: 'sm', render: (c) => (c.isSystem ? 'System' : 'Custom') },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.isActive ? 'Active' : 'Inactive'} tone={c.isActive ? 'success' : 'neutral'} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={[{ value: 'EARNING', label: 'Earnings' }, { value: 'DEDUCTION', label: 'Deductions' }]} placeholder="All types" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} />
          <Select options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add component</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load pay components.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} emptyTitle="No pay components" />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <AddComponentModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function AddComponentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'EARNING' | 'DEDUCTION'>('EARNING');
  const [calculationType, setCalculationType] = useState<'FIXED' | 'MANUAL'>('FIXED');
  const [taxable, setTaxable] = useState(true);
  const [recurringAllowed, setRecurringAllowed] = useState(true);
  const [description, setDescription] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(''); setName(''); setType('EARNING'); setCalculationType('FIXED'); setTaxable(true); setRecurringAllowed(true); setDescription(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createComponent.mutateAsync({ code, name, type, calculationType, taxable, recurringAllowed, description: description.trim() || null });
      toast.success('Component added');
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a pay component"
      description="A component's meaning is fixed once payslips refer to it, so choose the code carefully."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createComponent.isPending} disabled={!code || !name}>Add component</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="TRANSPORT_ALLOWANCE" hint="Upper case, digits and underscore." />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Transport allowance" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" options={[{ value: 'EARNING', label: 'Earning' }, { value: 'DEDUCTION', label: 'Deduction' }]} value={type} onChange={(e) => setType(e.target.value as 'EARNING' | 'DEDUCTION')} />
          <Select label="Amount from" options={[{ value: 'FIXED', label: 'A fixed amount' }, { value: 'MANUAL', label: 'Entered per run' }]} value={calculationType} onChange={(e) => setCalculationType(e.target.value as 'FIXED' | 'MANUAL')} />
        </div>
        <Checkbox label="May be set up as a recurring item" checked={recurringAllowed} onChange={(e) => setRecurringAllowed(e.target.checked)} />
        <Checkbox label="Taxable" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
        <p className="text-xs text-slate-500">This release calculates no tax. The taxable flag is recorded for a later statutory engine and nothing reads it yet.</p>
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </Modal>
  );
}
