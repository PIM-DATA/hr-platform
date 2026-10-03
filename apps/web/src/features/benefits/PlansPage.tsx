import { useState } from 'react';
import { Plus } from 'lucide-react';
import { BENEFIT_OVERRIDE_REASONS, BENEFIT_RULE_TYPES, PERMISSIONS, type BenefitPlanDto, type CreateBenefitPlanInput } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useBenefitCategories, useBenefitPlans, useBenefitsMutations, useBenefitsOptions, useEligibilityOverrides, useEligibilityPreview } from './benefits.api';
import { localToday } from '@/lib/format';
import { BenefitBadge, Table, money, titleCase } from './benefits-ui';

const RULE_LABEL: Record<string, string> = { ORGANIZATION: 'Organization', DEPARTMENT: 'Department', JOB: 'Job', POSITION: 'Position', EMPLOYMENT_TYPE: 'Employment type', EMPLOYMENT_STATUS: 'Employment status', MIN_TENURE_MONTHS: 'Minimum tenure (months)' };

export function PlansPage() {
  const { hasPermission } = useAuth(); const manage = hasPermission(PERMISSIONS.BENEFITS_MANAGE);
  const plans = useBenefitPlans({ includeInactive: true }); const cats = useBenefitCategories(true); const m = useBenefitsMutations(); const toast = useToast();
  const [editing, setEditing] = useState<BenefitPlanDto | 'new' | null>(null); const [eligibility, setEligibility] = useState<BenefitPlanDto | null>(null); const [newCat, setNewCat] = useState<{ code: string; name: string } | null>(null);
  const columns: Column<BenefitPlanDto>[] = [
    { key: 'n', header: 'Plan', render: (p) => <div><div className="font-medium text-slate-900">{p.name}</div><div className="text-xs text-slate-400">{p.code} · {p.categoryName}{p.organizationName ? ` · ${p.organizationName}` : ''}</div></div> },
    { key: 't', header: 'Type', render: (p) => <BenefitBadge status={p.planType} /> },
    { key: 'm', header: 'Entitlement', hideBelow: 'sm', render: (p) => p.planType === 'COVERAGE_ONLY' ? <span className="text-xs text-slate-400">coverage, no balance</span> : <span className="tabular-nums">{money(p.defaultEntitlementAmount, p.currency)}{p.perClaimMaximum ? <span className="block text-xs text-slate-400">per claim ≤ {money(p.perClaimMaximum)}</span> : null}</span> },
    { key: 'r', header: 'Rules', hideBelow: 'md', render: (p) => p.rules.length ? p.rules.map((r) => `${RULE_LABEL[r.ruleType]}: ${r.label}`).join(' · ') : <span className="text-xs text-slate-400">everyone active</span> },
    { key: 'c', header: 'Enrolled', hideBelow: 'md', render: (p) => p.counts.enrollments },
    { key: 's', header: 'Status', render: (p) => <BenefitBadge status={p.status} /> },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Benefit plans" description="A benefit plan is not a payroll component: it describes an entitlement people can claim against, with its own currency, maximum and eligibility. Money rules of an open period are frozen when it opens." />{manage && <div className="flex gap-2"><Button variant="secondary" onClick={() => setNewCat({ code: '', name: '' })}>New category</Button><Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New plan</Button></div>}</div>
        {plans.isError && <Alert className="m-4">Could not load plans.</Alert>}
        <DataTable columns={columns} rows={plans.data ?? []} rowKey={(p) => p.id} loading={plans.isLoading} onRowClick={(p) => (manage ? setEditing(p) : undefined)} emptyTitle="No plans yet" />
      </Card>
      <Card><CardHeader title="Categories" description="Labels for grouping. No rule is derived from a category name." /><Table head={['Code', 'Name', 'Plans', 'Status']} rows={(cats.data ?? []).map((c) => [c.code, c.name, c.planCount, <BenefitBadge key={c.id} status={c.isActive ? 'ACTIVE' : 'INACTIVE'} />])} /></Card>
      {editing && <PlanModal plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onEligibility={(p) => { setEditing(null); setEligibility(p); }} />}
      {eligibility && <EligibilityModal plan={eligibility} onClose={() => setEligibility(null)} />}
      {newCat && <Modal open onClose={() => setNewCat(null)} title="New category" footer={<><Button variant="secondary" onClick={() => setNewCat(null)}>Cancel</Button><Button loading={m.createCategory.isPending} onClick={async () => { try { await m.createCategory.mutateAsync(newCat); toast.success('Category created.'); setNewCat(null); } catch (e) { toast.error(errorMessage(e)); } }}>Create</Button></>}><div className="space-y-3"><Input label="Code" value={newCat.code} onChange={(e) => setNewCat({ ...newCat, code: e.target.value.toUpperCase() })} /><Input label="Name" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} /></div></Modal>}
    </div>
  );
}

type Draft = { code: string; name: string; description: string; categoryId: string; organizationId: string; planType: string; currency: string; defaultEntitlementAmount: string; perClaimMaximum: string; requiresDocument: boolean; employeeSelectable: boolean; allowPostEmploymentClaims: boolean; sensitivity: string; workflowDefinitionCode: string; effectiveFrom: string; effectiveTo: string; rules: { ruleType: string; value: string }[] };
function PlanModal({ plan, onClose, onEligibility }: { plan: BenefitPlanDto | null; onClose: () => void; onEligibility: (p: BenefitPlanDto) => void }) {
  const m = useBenefitsMutations(); const opts = useBenefitsOptions(); const cats = useBenefitCategories(); const toast = useToast();
  const [d, setD] = useState<Draft>(plan ? { code: plan.code, name: plan.name, description: plan.description ?? '', categoryId: plan.categoryId, organizationId: plan.organizationId ?? '', planType: plan.planType, currency: plan.currency ?? 'THB', defaultEntitlementAmount: plan.defaultEntitlementAmount ?? '', perClaimMaximum: plan.perClaimMaximum ?? '', requiresDocument: plan.requiresDocument, employeeSelectable: plan.employeeSelectable, allowPostEmploymentClaims: plan.allowPostEmploymentClaims, sensitivity: plan.sensitivity, workflowDefinitionCode: plan.workflowDefinitionCode ?? '', effectiveFrom: plan.effectiveFrom, effectiveTo: plan.effectiveTo ?? '', rules: plan.rules.map((r) => ({ ruleType: r.ruleType, value: r.value })) } : { code: '', name: '', description: '', categoryId: '', organizationId: '', planType: 'REIMBURSEMENT', currency: 'THB', defaultEntitlementAmount: '', perClaimMaximum: '', requiresDocument: true, employeeSelectable: false, allowPostEmploymentClaims: false, sensitivity: 'NORMAL', workflowDefinitionCode: '', effectiveFrom: localToday(), effectiveTo: '', rules: [] });
  const [error, setError] = useState<string | null>(null);
  const monetary = d.planType !== 'COVERAGE_ONLY';
  const valueOptions = (t: string) => t === 'ORGANIZATION' ? (opts.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name })) : t === 'DEPARTMENT' ? (opts.data?.departments ?? []).map((o) => ({ value: o.id, label: o.name })) : t === 'JOB' ? (opts.data?.jobs ?? []).map((o) => ({ value: o.id, label: o.title })) : t === 'POSITION' ? (opts.data?.positions ?? []).map((o) => ({ value: o.id, label: o.title })) : t === 'EMPLOYMENT_TYPE' ? ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((v) => ({ value: v, label: titleCase(v) })) : t === 'EMPLOYMENT_STATUS' ? ['ACTIVE', 'ON_LEAVE'].map((v) => ({ value: v, label: titleCase(v) })) : null;
  const body = (): CreateBenefitPlanInput => ({ code: d.code, name: d.name, description: d.description || null, categoryId: d.categoryId, organizationId: d.organizationId || null, planType: d.planType as CreateBenefitPlanInput['planType'], currency: monetary ? d.currency : null, defaultEntitlementAmount: monetary && d.defaultEntitlementAmount ? d.defaultEntitlementAmount : null, perClaimMaximum: monetary && d.perClaimMaximum ? d.perClaimMaximum : null, requiresDocument: d.requiresDocument, employeeSelectable: d.employeeSelectable, allowPostEmploymentClaims: d.allowPostEmploymentClaims, sensitivity: d.sensitivity as 'NORMAL', workflowDefinitionCode: monetary ? d.workflowDefinitionCode || null : null, effectiveFrom: d.effectiveFrom, effectiveTo: d.effectiveTo || null, rules: d.rules.filter((r) => r.value).map((r) => ({ ruleType: r.ruleType as 'ORGANIZATION', value: r.value })) });
  const save = async (status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED') => { setError(null); try { if (plan) { const { code: _c, planType: _t, ...rest } = body(); void _c; void _t; await m.updatePlan.mutateAsync({ id: plan.id, input: { ...rest, ...(status ? { status } : {}) } }); } else await m.createPlan.mutateAsync(body()); toast.success(status === 'ACTIVE' ? 'Plan activated.' : plan ? 'Plan saved. Open periods keep their snapshot.' : 'Plan created as a draft.'); onClose(); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} size="lg" title={plan ? `${plan.name}` : 'New benefit plan'} description="Eligibility uses employee-master facts only (organization, department, job, position, employment type and status, tenure). There is no field for age, gender, health or any other protected attribute."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{plan && <Button variant="secondary" onClick={() => onEligibility(plan)}>Eligibility preview</Button>}{plan && plan.status === 'DRAFT' && <Button variant="secondary" onClick={() => save('ACTIVE')}>Activate</Button>}{plan && plan.status === 'ACTIVE' && <Button variant="secondary" onClick={() => save('INACTIVE')}>Deactivate</Button>}<Button loading={m.createPlan.isPending || m.updatePlan.isPending} onClick={() => save()}>{plan ? 'Save' : 'Create draft'}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" value={d.code} disabled={!!plan} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} /><Input label="Name" className="sm:col-span-2" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Category" options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose" value={d.categoryId} onChange={(e) => setD({ ...d, categoryId: e.target.value })} /><Select label="Plan type" disabled={!!plan} options={[{ value: 'REIMBURSEMENT', label: 'Reimbursement' }, { value: 'ALLOWANCE', label: 'Allowance (welfare budget)' }, { value: 'COVERAGE_ONLY', label: 'Coverage only' }]} value={d.planType} onChange={(e) => setD({ ...d, planType: e.target.value })} /><Select label="Organization" options={(opts.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={d.organizationId} onChange={(e) => setD({ ...d, organizationId: e.target.value })} /></div>
        {monetary && <div className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Input label="Currency" value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value.toUpperCase() })} /><Input label="Entitlement per period" inputMode="decimal" placeholder="10000.00" value={d.defaultEntitlementAmount} onChange={(e) => setD({ ...d, defaultEntitlementAmount: e.target.value })} /><Input label="Per-claim maximum" inputMode="decimal" placeholder="5000.00" value={d.perClaimMaximum} onChange={(e) => setD({ ...d, perClaimMaximum: e.target.value })} /><Select label="Claim approval workflow" options={(opts.data?.workflows ?? []).map((w) => ({ value: w.code, label: `${w.code} · ${w.name}` }))} placeholder="Choose (benefits / BENEFIT_CLAIM)" value={d.workflowDefinitionCode} onChange={(e) => setD({ ...d, workflowDefinitionCode: e.target.value })} /></div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Effective from" type="date" value={d.effectiveFrom} onChange={(e) => setD({ ...d, effectiveFrom: e.target.value })} /><Input label="Effective to (optional)" type="date" value={d.effectiveTo} onChange={(e) => setD({ ...d, effectiveTo: e.target.value })} /><Select label="Sensitivity" options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'CONFIDENTIAL', label: 'Confidential (description hidden from approvers)' }]} value={d.sensitivity} onChange={(e) => setD({ ...d, sensitivity: e.target.value })} /></div>
        <div className="flex flex-wrap gap-4">{monetary && <Checkbox label="Receipt document required" checked={d.requiresDocument} onChange={(e) => setD({ ...d, requiresDocument: e.target.checked })} />}<Checkbox label="Employee may enrol or waive" checked={d.employeeSelectable} onChange={(e) => setD({ ...d, employeeSelectable: e.target.checked })} />{monetary && <Checkbox label="Allow claims after employment ends" checked={d.allowPostEmploymentClaims} onChange={(e) => setD({ ...d, allowPostEmploymentClaims: e.target.checked })} />}</div>
        <Textarea label="Description" rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        <div>
          <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Eligibility rules (same type: any; different types: all)</span><Button size="sm" variant="secondary" onClick={() => setD({ ...d, rules: [...d.rules, { ruleType: 'ORGANIZATION', value: '' }] })}>Add rule</Button></div>
          {d.rules.map((r, i) => { const vo = valueOptions(r.ruleType); return <div key={i} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3"><Select options={BENEFIT_RULE_TYPES.map((t) => ({ value: t, label: RULE_LABEL[t] }))} value={r.ruleType} onChange={(e) => setD({ ...d, rules: d.rules.map((x, j) => (j === i ? { ruleType: e.target.value, value: '' } : x)) })} />{vo ? <Select options={vo} placeholder="Choose" value={r.value} onChange={(e) => setD({ ...d, rules: d.rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} /> : <Input type="number" placeholder="Months" value={r.value} onChange={(e) => setD({ ...d, rules: d.rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />}<Button size="sm" variant="secondary" onClick={() => setD({ ...d, rules: d.rules.filter((_, j) => j !== i) })}>Remove</Button></div>; })}
        </div>
      </div>
    </Modal>
  );
}

function EligibilityModal({ plan, onClose }: { plan: BenefitPlanDto; onClose: () => void }) {
  const [withList, setWithList] = useState(false); const preview = useEligibilityPreview(plan.id, withList); const overrides = useEligibilityOverrides(plan.id); const m = useBenefitsMutations(); const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null); const [enrolling, setEnrolling] = useState<PayrollEmployeeOption | null>(null); const [ov, setOv] = useState({ mode: 'INCLUDE', reasonCode: 'CONTRACT_TERM', note: '' });
  return (
    <Modal open onClose={onClose} size="lg" title={`Eligibility — ${plan.name}`} description="A preview creates nothing. Eligible means the plan's criteria are met; it is not an enrolment, a payment or an approval." footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-4 text-sm">
        {preview.data && <div className="flex flex-wrap items-center gap-4"><span>Eligible <b className="tabular-nums">{preview.data.eligible}</b></span><span>Not eligible <b className="tabular-nums">{preview.data.ineligible}</b></span><span className="text-xs text-slate-500">as of {preview.data.asOfDate}</span><Button size="sm" variant="secondary" onClick={() => setWithList(!withList)}>{withList ? 'Hide list' : 'Show employees'}</Button></div>}
        {withList && preview.data?.employees && <div className="max-h-64 overflow-auto rounded border border-slate-200"><Table head={['Employee', 'Department', 'Eligible', 'Reasons']} rows={preview.data.employees.map((e) => [`${e.name} (${e.employeeCode})`, e.department ?? '—', e.eligible ? 'yes' : 'no', e.reasons.join('; ')])} /></div>}
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Enrol an employee (HR)</div>
          <div className="mt-2 flex flex-wrap items-end gap-2"><EmployeePicker value={enrolling} onChange={setEnrolling} endpoint="/workforce/employee-options" /><Button size="sm" disabled={!enrolling} onClick={async () => { try { await m.enroll.mutateAsync({ planId: plan.id, input: { employeeId: enrolling!.id } }); toast.success('Enrolled.'); setEnrolling(null); } catch (e) { toast.error(errorMessage(e)); } }}>Enrol</Button></div>
        </div>
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Manual override (explicit HR decision, kept as history)</div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4"><div className="sm:col-span-2"><EmployeePicker value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" /></div><Select label="Decision" options={[{ value: 'INCLUDE', label: 'Include' }, { value: 'EXCLUDE', label: 'Exclude' }]} value={ov.mode} onChange={(e) => setOv({ ...ov, mode: e.target.value })} /><Select label="Reason" options={BENEFIT_OVERRIDE_REASONS.map((r) => ({ value: r, label: titleCase(r) }))} value={ov.reasonCode} onChange={(e) => setOv({ ...ov, reasonCode: e.target.value })} /></div>
          <div className="mt-2 flex flex-wrap items-end gap-2"><Input label="Note (optional)" value={ov.note} onChange={(e) => setOv({ ...ov, note: e.target.value })} /><Button size="sm" disabled={!employee} onClick={async () => { try { await m.setOverride.mutateAsync({ planId: plan.id, input: { employeeId: employee!.id, mode: ov.mode as 'INCLUDE', reasonCode: ov.reasonCode as 'OTHER', note: ov.note || null } }); toast.success('Override recorded.'); setEmployee(null); } catch (e) { toast.error(errorMessage(e)); } }}>Record</Button></div>
          {(overrides.data ?? []).length > 0 && <div className="mt-3"><Table head={['Employee', 'Decision', 'Reason', 'Status', 'By']} rows={overrides.data!.map((o) => [`${o.employeeName} (${o.employeeCode})`, o.mode, titleCase(o.reasonCode), o.supersededAt ? 'superseded' : 'current', o.createdByName ?? '—'])} /></div>}
        </div>
      </div>
    </Modal>
  );
}
