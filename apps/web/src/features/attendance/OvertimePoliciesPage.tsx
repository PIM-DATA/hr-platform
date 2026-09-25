import { useEffect, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { PERMISSIONS, formatOvertimeMinutes, type OvertimePolicyDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { ApiClientError } from '@/lib/api-client';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { useWorkflowDefinitions } from '@/features/workflow/workflow.api';
import { useOvertimeMutations, useOvertimePolicies } from './overtime.api';
import { formatBusinessDate } from './attendance-ui';

const PAGE_SIZE = 20;

/**
 * Overtime policy: what a day type is worth and what a claim may not exceed.
 *
 * Multipliers are ratios a customer configures — the system never assumes 1.5, and never turns them into money.
 * Once a claim has snapshotted a policy, its rates stop being editable: that is what keeps approved overtime from
 * being quietly re-priced.
 */
export function OvertimePoliciesPage() {
  const canManage = usePermission(PERMISSIONS.OT_MANAGE_POLICY);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ open: boolean; policy: OvertimePolicyDto | null }>({ open: false, policy: null });
  const policies = useOvertimePolicies({ page, pageSize: PAGE_SIZE });

  const columns: Column<OvertimePolicyDto>[] = [
    { key: 'name', header: 'Policy', render: (p) => <span className="font-medium text-slate-900">{p.name}</span> },
    { key: 'org', header: 'Organization', hideBelow: 'md', render: (p) => p.organization?.name ?? '—' },
    { key: 'period', header: 'Effective', render: (p) => `${formatBusinessDate(p.effectiveFrom)} → ${p.effectiveTo ? formatBusinessDate(p.effectiveTo) : 'open'}` },
    { key: 'rates', header: 'Rates (work / off / holiday)', render: (p) => `×${p.workdayMultiplier} · ×${p.offDayMultiplier} · ×${p.holidayMultiplier}` },
    {
      key: 'limits',
      header: 'Limits',
      hideBelow: 'lg',
      render: (p) => (
        <span className="text-slate-600">
          {p.minimumEligibleMinutes ? `min ${formatOvertimeMinutes(p.minimumEligibleMinutes)}` : 'no minimum'}
          {' · '}
          {p.maximumApprovedMinutesPerDay ? `max ${formatOvertimeMinutes(p.maximumApprovedMinutesPerDay)}/day` : 'no daily cap'}
        </span>
      ),
    },
    { key: 'workflow', header: 'Workflow', hideBelow: 'lg', render: (p) => p.workflowDefinitionCode },
    {
      key: 'status',
      header: 'Status',
      render: (p) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={p.isActive ? 'ACTIVE' : 'INACTIVE'} />
          {p.inUse && <span className="text-xs text-slate-500">claimed</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right',
      render: (p) =>
        canManage ? (
          <Button variant="ghost" size="sm" onClick={() => setEditing({ open: true, policy: p })} aria-label={`Edit ${p.name}`}>
            <Pencil className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      {canManage && (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setEditing({ open: true, policy: null })}><Plus className="h-4 w-4" /> Add policy</Button>
        </div>
      )}
      <Card>
        {policies.isError && <Alert className="m-4">Could not load overtime policies.</Alert>}
        <DataTable
          columns={columns}
          rows={policies.data?.data ?? []}
          rowKey={(p) => p.id}
          loading={policies.isLoading}
          emptyTitle="No overtime policy yet"
          emptyDescription="Without a policy in force, overtime cannot be claimed for a day."
        />
        {policies.data?.meta && <Pagination page={policies.data.meta.page} pageSize={policies.data.meta.pageSize} total={policies.data.meta.total} onPageChange={setPage} />}
      </Card>
      <PolicyFormModal open={editing.open} policy={editing.policy} onClose={() => setEditing({ open: false, policy: null })} />
    </>
  );
}

function PolicyFormModal({ open, policy, onClose }: { open: boolean; policy: OvertimePolicyDto | null; onClose: () => void }) {
  const { createPolicy, updatePolicy } = useOvertimeMutations();
  const organizations = useOrganizationOptions();
  const canPickWorkflow = usePermission(PERMISSIONS.WORKFLOW_MANAGE_DEFINITIONS);
  const workflows = useWorkflowDefinitions(canPickWorkflow); // the picker is for editors; viewers never fire a request they may not make
  const toast = useToast();
  const empty = {
    organizationId: '', name: '', effectiveFrom: '', effectiveTo: '',
    workdayMultiplier: '1.5', offDayMultiplier: '2', holidayMultiplier: '3',
    minimumEligibleMinutes: '30', maximumApprovedMinutesPerDay: '240', workflowDefinitionCode: '', isActive: true,
  };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      policy
        ? {
            organizationId: policy.organization?.id ?? '', name: policy.name,
            effectiveFrom: policy.effectiveFrom, effectiveTo: policy.effectiveTo ?? '',
            workdayMultiplier: String(policy.workdayMultiplier), offDayMultiplier: String(policy.offDayMultiplier), holidayMultiplier: String(policy.holidayMultiplier),
            minimumEligibleMinutes: policy.minimumEligibleMinutes === null ? '' : String(policy.minimumEligibleMinutes),
            maximumApprovedMinutesPerDay: policy.maximumApprovedMinutesPerDay === null ? '' : String(policy.maximumApprovedMinutesPerDay),
            workflowDefinitionCode: policy.workflowDefinitionCode, isActive: policy.isActive,
          }
        : empty,
    );
    // `empty` is a literal recreated each render; excluding it keeps the effect tied to the dialog opening.

  }, [open, policy]);

  const number = (value: string) => (value.trim() === '' ? null : Number(value));

  const submit = async () => {
    setError(null);
    try {
      if (policy) {
        await updatePolicy.mutateAsync({
          id: policy.id,
          input: {
            name: form.name,
            effectiveTo: form.effectiveTo || null,
            ...(policy.inUse
              ? {} // rates are frozen once claimed — the form disables them too
              : {
                  workdayMultiplier: Number(form.workdayMultiplier),
                  offDayMultiplier: Number(form.offDayMultiplier),
                  holidayMultiplier: Number(form.holidayMultiplier),
                  minimumEligibleMinutes: number(form.minimumEligibleMinutes),
                  maximumApprovedMinutesPerDay: number(form.maximumApprovedMinutesPerDay),
                  workflowDefinitionCode: form.workflowDefinitionCode,
                }),
            isActive: form.isActive,
          },
        });
        toast.success('Policy updated');
      } else {
        await createPolicy.mutateAsync({
          organizationId: form.organizationId,
          name: form.name,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
          workdayMultiplier: Number(form.workdayMultiplier),
          offDayMultiplier: Number(form.offDayMultiplier),
          holidayMultiplier: Number(form.holidayMultiplier),
          minimumEligibleMinutes: number(form.minimumEligibleMinutes),
          maximumApprovedMinutesPerDay: number(form.maximumApprovedMinutesPerDay),
          workflowDefinitionCode: form.workflowDefinitionCode,
        });
        toast.success('Policy created');
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  const overtimeWorkflows = (workflows.data ?? []).filter((w) => w.entityType === 'OVERTIME_REQUEST' && w.isActive);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={policy ? 'Edit overtime policy' : 'Add overtime policy'}
      description={policy?.inUse ? 'Claims already use this policy, so its rates are frozen' : undefined}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={createPolicy.isPending || updatePolicy.isPending}>{policy ? 'Save' : 'Create'}</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {!policy && (
          <Select
            label="Organization"
            options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
            placeholder="Choose an organization"
            value={form.organizationId}
            onChange={(e) => setForm({ ...form, organizationId: e.target.value })}
          />
        )}
        <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="ot-from" className="block text-sm font-medium text-slate-700">Effective from</label>
            <input id="ot-from" type="date" value={form.effectiveFrom} disabled={!!policy} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm shadow-sm disabled:bg-slate-50" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ot-to" className="block text-sm font-medium text-slate-700">Effective to</label>
            <input id="ot-to" type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm shadow-sm" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Workday ×" type="number" step="0.1" min={0.1} value={form.workdayMultiplier} disabled={policy?.inUse} onChange={(e) => setForm({ ...form, workdayMultiplier: e.target.value })} />
          <Input label="Off day ×" type="number" step="0.1" min={0.1} value={form.offDayMultiplier} disabled={policy?.inUse} onChange={(e) => setForm({ ...form, offDayMultiplier: e.target.value })} />
          <Input label="Holiday ×" type="number" step="0.1" min={0.1} value={form.holidayMultiplier} disabled={policy?.inUse} onChange={(e) => setForm({ ...form, holidayMultiplier: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Minimum minutes" type="number" min={0} value={form.minimumEligibleMinutes} disabled={policy?.inUse} onChange={(e) => setForm({ ...form, minimumEligibleMinutes: e.target.value })} hint="Below this, a day is not overtime" />
          <Input label="Maximum minutes a day" type="number" min={1} value={form.maximumApprovedMinutesPerDay} disabled={policy?.inUse} onChange={(e) => setForm({ ...form, maximumApprovedMinutesPerDay: e.target.value })} />
        </div>
        <Select
          label="Approval workflow"
          options={overtimeWorkflows.map((w) => ({ value: w.code, label: `${w.code} · ${w.name}` }))}
          placeholder="Choose an overtime workflow"
          value={form.workflowDefinitionCode}
          disabled={policy?.inUse}
          onChange={(e) => setForm({ ...form, workflowDefinitionCode: e.target.value })}
        />
        {policy && <Checkbox label="Active" description="An inactive policy is not used to resolve new claims." checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />}
        <p className="text-xs text-slate-500">
          Multipliers are ratios your organization decides; nothing here assumes a legal rate, and no money is
          calculated. Active policies for one organization may not overlap in time, so any day resolves to exactly one.
        </p>
      </div>
    </Modal>
  );
}
