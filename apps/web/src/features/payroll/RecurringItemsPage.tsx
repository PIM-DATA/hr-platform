import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { PayItemDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { usePayComponents, usePayItems, usePayrollMutations } from './payroll.api';
import { Money } from './payroll-ui';
import { EmployeePicker, type PayrollEmployeeOption } from './employee-picker';

/**
 * Recurring pay: an allowance or a deduction that appears every month while it is in force.
 *
 * The amount is fixed per item, and a run copies it onto the payslip with the component's name frozen at that moment.
 * Changing an item later changes future runs only — a closed payslip keeps what it was paid.
 */
export function RecurringItemsPage() {
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PayItemDto | null>(null);
  const list = usePayItems({ employeeId: employee?.id, page, pageSize: 20 });

  const columns: Column<PayItemDto>[] = [
    { key: 'emp', header: 'Employee', render: (i) => (
      <div>
        <div className="font-medium text-slate-900">{i.employee.firstName} {i.employee.lastName}</div>
        <div className="text-xs text-slate-400">{i.employee.employeeCode}</div>
      </div>
    ) },
    { key: 'component', header: 'Component', render: (i) => (
      <div>
        <div className="text-slate-900">{i.component.name}</div>
        <div className="text-xs text-slate-400">{i.component.type === 'EARNING' ? 'Earning' : 'Deduction'}</div>
      </div>
    ) },
    { key: 'amount', header: 'Amount', className: 'text-right', render: (i) => <Money amount={i.amount} className="font-medium text-slate-900" /> },
    { key: 'period', header: 'Effective', render: (i) => <span className="whitespace-nowrap text-slate-600">{i.effectiveFrom} → {i.effectiveTo ?? 'open'}</span> },
    { key: 'note', header: 'Note', hideBelow: 'lg', render: (i) => i.note ?? <span className="text-slate-400">—</span> },
    { key: 'actions', header: '', render: (i) => <Button size="sm" variant="secondary" onClick={() => setEditing(i)}>Edit</Button> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-[1fr_auto]">
          <div className="max-w-sm"><EmployeePicker label="Filter by employee" value={employee} onChange={(e) => { setEmployee(e); setPage(1); }} /></div>
          <div className="flex items-end justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add recurring item</Button></div>
        </div>
        {list.isError && <Alert className="m-4">Could not load recurring items.</Alert>}
        <DataTable
          columns={columns}
          rows={list.data?.data ?? []}
          rowKey={(i) => i.id}
          loading={list.isLoading}
          emptyTitle="No recurring items"
          emptyDescription="Allowances and standing deductions live here."
        />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <AddItemModal open={creating} onClose={() => setCreating(false)} />
      {editing && <EditItemModal item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function AddItemModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const components = usePayComponents({ status: 'active', pageSize: 100 });
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [componentId, setComponentId] = useState('');
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setEmployee(null); setComponentId(''); setAmount(''); setEffectiveFrom(''); setEffectiveTo(''); setNote(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createPayItem.mutateAsync({
        employeeId: employee!.id, componentId, amount, effectiveFrom,
        effectiveTo: effectiveTo || null, note: note.trim() || null,
      });
      toast.success('Recurring item added');
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  // Only components that allow it can recur — the server refuses the rest, so the picker does not offer them.
  const options = (components.data?.data ?? []).filter((c) => c.recurringAllowed && !c.isSystem);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a recurring item"
      description="One active item per employee and component."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createPayItem.isPending} disabled={!employee || !componentId || !amount || !effectiveFrom}>Add item</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker value={employee} onChange={setEmployee} />
        <Select
          label="Component"
          required
          options={options.map((c) => ({ value: c.id, label: `${c.name} (${c.type === 'EARNING' ? 'earning' : 'deduction'})` }))}
          placeholder="Select a component"
          value={componentId}
          onChange={(e) => setComponentId(e.target.value)}
        />
        <Input label="Amount per month" required inputMode="decimal" placeholder="1000.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Effective from" required type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          <Input label="Effective to" type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} hint="Leave empty for open-ended." />
        </div>
        <Textarea label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

/**
 * Editing a recurring item changes what future payroll copies onto a payslip. It never touches a run that has been
 * calculated or closed: those payslips keep the amount they were paid, with the component name frozen at that time.
 * The employee and the component are fixed — a different employee or component is a different item.
 */
function EditItemModal({ item, onClose }: { item: PayItemDto; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const [amount, setAmount] = useState(item.amount);
  const [effectiveTo, setEffectiveTo] = useState(item.effectiveTo ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await m.updatePayItem.mutateAsync({ id: item.id, input: { amount, effectiveTo: effectiveTo || null, note: note || null } });
      toast.success('Recurring item updated.');
      onClose();
    } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${item.component.name}`} description={`${item.employee.firstName} ${item.employee.lastName} · in force from ${item.effectiveFrom}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.updatePayItem.isPending} disabled={!amount} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input label="In force until (blank = open)" type="date" min={item.effectiveFrom} value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
        </div>
        <Textarea label="Note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="text-xs text-slate-500">Applies to payroll calculated from now on. A run that is already calculated or closed is not recalculated, and an end date in the past stops the item from the following run.</p>
      </div>
    </Modal>
  );
}
