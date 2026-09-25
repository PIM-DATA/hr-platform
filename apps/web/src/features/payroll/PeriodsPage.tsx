import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, calendarMonthRange, payrollPeriodLabel, type PayrollPeriodDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { usePayrollMutations, usePayrollPeriods } from './payroll.api';
import { Money, PayrollStatusBadge } from './payroll-ui';
import { RunReviewPanel } from './RunReviewPage';

const thisYear = new Date().getFullYear();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Payroll periods — one month, one organization, one run.
 *
 * Opening a period does not calculate anything; calculating produces a run that can be reviewed, submitted for
 * approval and finally closed. A closed period is finished: there is no reopen, by design.
 */
export function PeriodsPage() {
  const canManage = usePermission(PERMISSIONS.PAYROLL_MANAGE);
  const orgs = useOrganizationOptions();
  const [organizationId, setOrganizationId] = useState('');
  const [year, setYear] = useState(String(thisYear));
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PayrollPeriodDto | null>(null);
  const list = usePayrollPeriods({ organizationId, year, status, page, pageSize: 20 });

  const columns: Column<PayrollPeriodDto>[] = [
    { key: 'period', header: 'Period', render: (p) => (
      <div>
        <div className="font-medium text-slate-900">{p.label}</div>
        <div className="text-xs text-slate-400">{p.organization?.name ?? '—'}</div>
      </div>
    ) },
    { key: 'range', header: 'Salary month', hideBelow: 'md', render: (p) => <span className="whitespace-nowrap text-slate-600">{p.periodStart} → {p.periodEnd}</span> },
    { key: 'attendance', header: 'Attendance window', hideBelow: 'lg', render: (p) => <span className="whitespace-nowrap text-slate-600">{p.attendanceFrom} → {p.attendanceTo}</span> },
    { key: 'payment', header: 'Payment', hideBelow: 'lg', render: (p) => p.paymentDate ?? <span className="text-slate-400">—</span> },
    { key: 'employees', header: 'Employees', className: 'text-right', render: (p) => <span className="tabular-nums">{p.run?.employeeCount ?? '—'}</span> },
    { key: 'net', header: 'Net total', className: 'text-right', render: (p) => (p.run ? <Money amount={p.run.netTotal} currency={p.currencyCode} /> : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (p) => <PayrollStatusBadge status={p.status} /> },
    // Dates are editable while the period is still open. Once a run exists the window it was calculated against is
    // part of that result, so the server refuses the change and the screen does not offer it.
    { key: 'actions', header: '', render: (p) => (canManage && p.status === 'OPEN' && !p.run ? <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setEditing(p); }}>Edit dates</Button> : null) },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Select options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setPage(1); }} />
          <Select options={[thisYear - 1, thisYear, thisYear + 1].map((n) => ({ value: String(n), label: String(n) }))} placeholder="All years" value={year} onChange={(e) => { setYear(e.target.value); setPage(1); }} />
          <Select options={['OPEN', 'REVIEW', 'APPROVED', 'CLOSED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Open period</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load payroll periods.</Alert>}
        <DataTable
          columns={columns}
          rows={list.data?.data ?? []}
          rowKey={(p) => p.id}
          loading={list.isLoading}
          onRowClick={(p) => setOpenId(p.id)}
          emptyTitle="No payroll periods"
          emptyDescription="Open a month to calculate payroll for it."
        />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <OpenPeriodModal open={creating} onClose={() => setCreating(false)} />
      {editing && <EditPeriodModal period={editing} onClose={() => setEditing(null)} />}
      <RunReviewPanel periodId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

/**
 * Opening a period. The salary month defaults to the calendar month and the attendance window defaults to the same
 * range — a customer with a cut-off on the 20th changes it here, which is exactly why both are editable.
 */
function OpenPeriodModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const [organizationId, setOrganizationId] = useState('');
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [attendanceFrom, setAttendanceFrom] = useState('');
  const [attendanceTo, setAttendanceTo] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // The month decides the defaults; anything the user has typed after that is theirs to keep.
  useEffect(() => {
    const range = calendarMonthRange(year, month);
    setPeriodStart(range.start);
    setPeriodEnd(range.end);
    setAttendanceFrom(range.start);
    setAttendanceTo(range.end);
  }, [year, month]);
  useEffect(() => { if (open) { setErr(null); setPaymentDate(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createPeriod.mutateAsync({
        organizationId, year, month, periodStart, periodEnd, attendanceFrom, attendanceTo,
        paymentDate: paymentDate || null,
      });
      toast.success(`${payrollPeriodLabel(year, month)} is open`);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a payroll period"
      description="One month for one organization. Opening it calculates nothing yet."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createPeriod.isPending} disabled={!organizationId}>Open period</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization" required options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Select an organization" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Year" options={[thisYear - 1, thisYear, thisYear + 1].map((n) => ({ value: String(n), label: String(n) }))} value={String(year)} onChange={(e) => setYear(Number(e.target.value))} />
          <Select label="Month" options={MONTHS.map((label, i) => ({ value: String(i + 1), label }))} value={String(month)} onChange={(e) => setMonth(Number(e.target.value))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Salary month from" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          <Input label="Salary month to" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Attendance from" type="date" value={attendanceFrom} onChange={(e) => setAttendanceFrom(e.target.value)} hint="The cut-off window need not be the salary month." />
          <Input label="Attendance to" type="date" value={attendanceTo} onChange={(e) => setAttendanceTo(e.target.value)} />
        </div>
        <Input label="Payment date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} hint="Optional — shown on the payslip." />
      </div>
    </Modal>
  );
}

/**
 * Correcting the windows of a period that has not been calculated yet: the salary month, the attendance cut-off and
 * the payment date. The organization, the year and the month identify the period and never change. Once a run exists
 * the period's windows are part of a calculated result, so the server refuses the edit and this button is not offered.
 */
function EditPeriodModal({ period, onClose }: { period: PayrollPeriodDto; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const [d, setD] = useState({ periodStart: period.periodStart, periodEnd: period.periodEnd, attendanceFrom: period.attendanceFrom, attendanceTo: period.attendanceTo, paymentDate: period.paymentDate ?? '' });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await m.updatePeriod.mutateAsync({ id: period.id, input: { ...d, paymentDate: d.paymentDate || null } });
      toast.success('Period updated.');
      onClose();
    } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${period.label}`} description={`${period.organization?.name ?? 'Organization'} · ${period.currencyCode} · status ${period.status.toLowerCase()}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.updatePeriod.isPending} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Salary month from" type="date" value={d.periodStart} onChange={(e) => setD({ ...d, periodStart: e.target.value })} />
          <Input label="Salary month to" type="date" value={d.periodEnd} onChange={(e) => setD({ ...d, periodEnd: e.target.value })} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Attendance window from" type="date" value={d.attendanceFrom} onChange={(e) => setD({ ...d, attendanceFrom: e.target.value })} />
          <Input label="Attendance window to" type="date" value={d.attendanceTo} onChange={(e) => setD({ ...d, attendanceTo: e.target.value })} />
        </div>
        <Input label="Payment date (optional)" type="date" value={d.paymentDate} onChange={(e) => setD({ ...d, paymentDate: e.target.value })} />
        <p className="text-xs text-slate-500">The attendance window need not be the salary month: a cut-off part-way through the previous month is normal. The server decides whether the change is allowed for this period\u2019s state.</p>
      </div>
    </Modal>
  );
}
