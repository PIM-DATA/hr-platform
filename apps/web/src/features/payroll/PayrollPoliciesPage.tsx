import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type PayrollPolicyDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { usePayrollMutations, usePayrollPolicies } from './payroll.api';

/**
 * The numbers that turn a monthly salary into a daily and a minute rate.
 *
 * There is no default hiding in the code: how many days a month is divided by, and how many hours a working day has,
 * are a customer's decision and are configured here. Every rate on every payslip is derived from these two figures.
 */
export function PayrollPoliciesPage() {
  const canManage = usePermission(PERMISSIONS.PAYROLL_MANAGE);
  const [organizationId, setOrganizationId] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PayrollPolicyDto | null>(null);
  const orgs = useOrganizationOptions();
  const list = usePayrollPolicies(organizationId || undefined);

  const columns: Column<PayrollPolicyDto>[] = [
    { key: 'name', header: 'Policy', render: (p) => (
      <div>
        <div className="font-medium text-slate-900">{p.name}</div>
        <div className="text-xs text-slate-400">{p.organization?.name ?? '—'}</div>
      </div>
    ) },
    { key: 'divisor', header: 'Divisor days', className: 'text-right', render: (p) => <span className="tabular-nums">{p.monthlyDivisorDays}</span> },
    { key: 'hours', header: 'Hours / day', className: 'text-right', render: (p) => <span className="tabular-nums">{p.dailyWorkHours}</span> },
    { key: 'deductions', header: 'Deducts', hideBelow: 'md', render: (p) => [p.absenceDeductionEnabled && 'absence', p.lateDeductionEnabled && 'lateness'].filter(Boolean).join(', ') || <span className="text-slate-400">nothing</span> },
    { key: 'workflow', header: 'Approval', hideBelow: 'lg', render: (p) => p.workflowDefinitionCode },
    { key: 'period', header: 'Effective', render: (p) => <span className="whitespace-nowrap text-slate-600">{p.effectiveFrom} → {p.effectiveTo ?? 'open'}</span> },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.isActive ? 'Active' : 'Inactive'} tone={p.isActive ? 'success' : 'neutral'} /> },
    { key: 'actions', header: '', render: (p) => (canManage ? <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>Edit</Button> : null) },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2">
          <Select options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add policy</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load payroll policies.</Alert>}
        <DataTable
          columns={columns}
          rows={list.data ?? []}
          rowKey={(p) => p.id}
          loading={list.isLoading}
          emptyTitle="No payroll policy"
          emptyDescription="An organization needs a policy in force before its payroll can be calculated."
        />
      </Card>
      <AddPolicyModal open={creating} onClose={() => setCreating(false)} />
      {editing && <EditPolicyModal policy={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function AddPolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const [organizationId, setOrganizationId] = useState('');
  const [name, setName] = useState('');
  const [monthlyDivisorDays, setMonthlyDivisorDays] = useState('30');
  const [dailyWorkHours, setDailyWorkHours] = useState('8');
  const [workflowDefinitionCode, setWorkflowDefinitionCode] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [absenceDeductionEnabled, setAbsence] = useState(true);
  const [lateDeductionEnabled, setLate] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setOrganizationId(''); setName(''); setWorkflowDefinitionCode(''); setEffectiveFrom(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createPolicy.mutateAsync({
        organizationId, name,
        monthlyDivisorDays: Number(monthlyDivisorDays), dailyWorkHours: Number(dailyWorkHours),
        newHireProration: 'CALENDAR_DAYS', terminationProration: 'CALENDAR_DAYS',
        absenceDeductionEnabled, lateDeductionEnabled,
        workflowDefinitionCode, effectiveFrom, currencyCode: 'THB',
      });
      toast.success('Payroll policy added');
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a payroll policy"
      description="One policy in force per organization at a time."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createPolicy.isPending} disabled={!organizationId || !name || !workflowDefinitionCode || !effectiveFrom}>Add policy</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization" required options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Select an organization" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
        <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly payroll" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Monthly divisor days" required inputMode="decimal" value={monthlyDivisorDays} onChange={(e) => setMonthlyDivisorDays(e.target.value)} hint="Salary ÷ this = daily rate." />
          <Input label="Working hours per day" required inputMode="decimal" value={dailyWorkHours} onChange={(e) => setDailyWorkHours(e.target.value)} hint="Daily rate ÷ this = hourly rate." />
        </div>
        <Input label="Approval workflow code" required value={workflowDefinitionCode} onChange={(e) => setWorkflowDefinitionCode(e.target.value)} hint="A workflow definition for the payroll module." />
        <Input label="Effective from" required type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        <Checkbox label="Deduct for unexcused absence" checked={absenceDeductionEnabled} onChange={(e) => setAbsence(e.target.checked)} />
        <Checkbox label="Deduct for lateness" description="Off by default: many employers handle lateness through discipline rather than pay." checked={lateDeductionEnabled} onChange={(e) => setLate(e.target.checked)} />
      </div>
    </Modal>
  );
}

/**
 * Editing a policy changes how payroll calculated from now on derives its rates. A run that is already calculated
 * keeps the figures it used, and a closed run is never recalculated — so a divisor change is a decision about future
 * payroll, not a retrospective correction. The organization, the currency and the start date are fixed: a different
 * basis is a new policy with its own effective period.
 */
function EditPolicyModal({ policy, onClose }: { policy: PayrollPolicyDto; onClose: () => void }) {
  const m = usePayrollMutations();
  const toast = useToast();
  const [d, setD] = useState({
    name: policy.name, monthlyDivisorDays: policy.monthlyDivisorDays, dailyWorkHours: policy.dailyWorkHours,
    newHireProration: policy.newHireProration, terminationProration: policy.terminationProration,
    absenceDeductionEnabled: policy.absenceDeductionEnabled, lateDeductionEnabled: policy.lateDeductionEnabled,
    workflowDefinitionCode: policy.workflowDefinitionCode, effectiveTo: policy.effectiveTo ?? '', isActive: policy.isActive,
  });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    // Only what actually changed is sent. A policy that has already calculated a period refuses a change to how it
    // calculates, and sending an unchanged divisor would trip that refusal on a rename.
    const input: Record<string, unknown> = {};
    if (d.name !== policy.name) input.name = d.name;
    if (Number(d.monthlyDivisorDays) !== Number(policy.monthlyDivisorDays)) input.monthlyDivisorDays = Number(d.monthlyDivisorDays);
    if (Number(d.dailyWorkHours) !== Number(policy.dailyWorkHours)) input.dailyWorkHours = Number(d.dailyWorkHours);
    if (d.newHireProration !== policy.newHireProration) input.newHireProration = d.newHireProration;
    if (d.terminationProration !== policy.terminationProration) input.terminationProration = d.terminationProration;
    if (d.absenceDeductionEnabled !== policy.absenceDeductionEnabled) input.absenceDeductionEnabled = d.absenceDeductionEnabled;
    if (d.lateDeductionEnabled !== policy.lateDeductionEnabled) input.lateDeductionEnabled = d.lateDeductionEnabled;
    if (d.workflowDefinitionCode !== policy.workflowDefinitionCode) input.workflowDefinitionCode = d.workflowDefinitionCode;
    if ((d.effectiveTo || null) !== policy.effectiveTo) input.effectiveTo = d.effectiveTo || null;
    if (d.isActive !== policy.isActive) input.isActive = d.isActive;
    if (Object.keys(input).length === 0) { onClose(); return; }
    try {
      await m.updatePolicy.mutateAsync({ id: policy.id, input });
      toast.success('Policy updated.');
      onClose();
    } catch (e) { setError(errorMessage(e)); }
  };
  const proration = [{ value: 'CALENDAR_DAYS', label: 'Calendar days' }, { value: 'WORKING_DAYS', label: 'Working days' }];
  return (
    <Modal open onClose={onClose} size="lg" title={`Edit ${policy.name}`} description={`${policy.organization?.name ?? 'Organization'} · ${policy.currencyCode} · in force from ${policy.effectiveFrom}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.updatePolicy.isPending} disabled={!d.name || !d.monthlyDivisorDays || !d.dailyWorkHours} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Input label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Days a monthly salary is divided by" inputMode="decimal" value={d.monthlyDivisorDays} onChange={(e) => setD({ ...d, monthlyDivisorDays: e.target.value })} />
          <Input label="Hours in a working day" inputMode="decimal" value={d.dailyWorkHours} onChange={(e) => setD({ ...d, dailyWorkHours: e.target.value })} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="New hire proration" options={proration} value={d.newHireProration} onChange={(e) => setD({ ...d, newHireProration: e.target.value as 'CALENDAR_DAYS' })} />
          <Select label="Termination proration" options={proration} value={d.terminationProration} onChange={(e) => setD({ ...d, terminationProration: e.target.value as 'CALENDAR_DAYS' })} />
        </div>
        <div className="flex flex-wrap gap-4">
          <Checkbox label="Deduct for absence" checked={d.absenceDeductionEnabled} onChange={(e) => setD({ ...d, absenceDeductionEnabled: e.target.checked })} />
          <Checkbox label="Deduct for lateness" checked={d.lateDeductionEnabled} onChange={(e) => setD({ ...d, lateDeductionEnabled: e.target.checked })} />
          <Checkbox label="Active" checked={d.isActive} onChange={(e) => setD({ ...d, isActive: e.target.checked })} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Approval workflow code" value={d.workflowDefinitionCode} onChange={(e) => setD({ ...d, workflowDefinitionCode: e.target.value })} />
          <Input label="In force until (blank = open)" type="date" min={policy.effectiveFrom} value={d.effectiveTo} onChange={(e) => setD({ ...d, effectiveTo: e.target.value })} />
        </div>
        <p className="text-xs text-slate-500">Applies to payroll calculated from now on. Runs already calculated keep the figures they used, and a closed run is never recalculated. Once a period has been calculated with this policy the server refuses a change to how it calculates: supersede it with a new policy instead.</p>
      </div>
    </Modal>
  );
}
