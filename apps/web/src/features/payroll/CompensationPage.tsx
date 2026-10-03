import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { CompensationDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useCompensations, usePayrollMutations } from './payroll.api';
import { Money } from './payroll-ui';
import { EmployeePicker, type PayrollEmployeeOption } from './employee-picker';

/**
 * Salary history.
 *
 * A raise is a **new record**, never an edit: the previous salary is closed with an end date and a new one opens the
 * next day. That is what makes a payslip from three months ago still explainable — and why a record a payroll run has
 * already used shows as in use and cannot be re-priced.
 */
export function CompensationPage() {
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<CompensationDto | null>(null);
  const list = useCompensations({ employeeId: employee?.id, page, pageSize: 20 });
  const { user } = useAuth();

  const columns: Column<CompensationDto>[] = [
    { key: 'emp', header: 'Employee', render: (c) => (
      <div>
        <div className="font-medium text-slate-900">{c.employee.firstName} {c.employee.lastName}</div>
        <div className="text-xs text-slate-400">{c.employee.employeeCode}{c.employee.department && ` · ${c.employee.department.name}`}</div>
      </div>
    ) },
    { key: 'salary', header: 'Base salary', className: 'text-right', render: (c) => <Money amount={c.baseSalary} currency={c.currencyCode} className="font-medium text-slate-900" /> },
    { key: 'type', header: 'Frequency', hideBelow: 'md', render: (c) => c.salaryType.charAt(0) + c.salaryType.slice(1).toLowerCase() },
    { key: 'from', header: 'Effective', render: (c) => <span className="whitespace-nowrap text-slate-600">{c.effectiveFrom} → {c.effectiveTo ?? 'open'}</span> },
    { key: 'inUse', header: 'Used by payroll', hideBelow: 'lg', render: (c) => (c.inUse ? 'Yes' : <span className="text-slate-400">No</span>) },
    { key: 'note', header: 'Note', hideBelow: 'lg', render: (c) => c.note ?? <span className="text-slate-400">—</span> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (c) => (
      // Task 51: your own salary is changed by another payroll administrator (the API refuses it too)
      c.employee.id === user?.employee?.id
        ? <span className="text-xs text-slate-500">Yours — another administrator</span>
        : c.effectiveTo === null
          ? <Button variant="ghost" size="sm" onClick={() => setClosing(c)}>Close</Button>
          : null
    ) },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-[1fr_auto]">
          <div className="max-w-sm"><EmployeePicker label="Filter by employee" value={employee} onChange={(e) => { setEmployee(e); setPage(1); }} /></div>
          <div className="flex items-end justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Record salary</Button></div>
        </div>
        {list.isError && <Alert className="m-4">Could not load compensation records.</Alert>}
        <DataTable
          columns={columns}
          rows={list.data?.data ?? []}
          rowKey={(c) => c.id}
          loading={list.isLoading}
          emptyTitle="No compensation records"
          emptyDescription="Record a base salary before running payroll for someone."
        />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <RecordSalaryModal open={creating} onClose={() => setCreating(false)} />
      <CloseSalaryModal record={closing} onClose={() => setClosing(null)} />
    </>
  );
}

function RecordSalaryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [baseSalary, setBaseSalary] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setEmployee(null); setBaseSalary(''); setEffectiveFrom(''); setNote(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createCompensation.mutateAsync({
        employeeId: employee!.id, baseSalary, effectiveFrom, salaryType: 'MONTHLY', currencyCode: 'THB',
        note: note.trim() || null,
      });
      toast.success('Salary recorded');
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a salary"
      description="A new record, effective from a date. Close the previous one first if its period would overlap."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createCompensation.isPending} disabled={!employee || !baseSalary || !effectiveFrom}>Record salary</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker value={employee} onChange={setEmployee} />
        <Input label="Monthly base salary" required inputMode="decimal" placeholder="30000.00" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} hint="At most two decimal places." />
        <Input label="Effective from" required type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        <Textarea label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Annual review, promotion…" />
      </div>
    </Modal>
  );
}

/** Ending a salary. Only the end date moves — the amount itself is frozen, so a run that used it stays explainable. */
function CloseSalaryModal({ record, onClose }: { record: CompensationDto | null; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const [effectiveTo, setEffectiveTo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (record) { setErr(null); setEffectiveTo(''); } }, [record]);

  const submit = async () => {
    setErr(null);
    try {
      await m.closeCompensation.mutateAsync({ id: record!.id, effectiveTo });
      toast.success('Salary record closed');
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={!!record}
      onClose={onClose}
      title="Close this salary record"
      description={record ? `${record.employee.firstName} ${record.employee.lastName}, effective from ${record.effectiveFrom}` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.closeCompensation.isPending} disabled={!effectiveTo}>Close record</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Input label="Last day this salary applies" required type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
        <p className="text-xs text-slate-500">Record the new salary separately, effective from the following day.</p>
      </div>
    </Modal>
  );
}
