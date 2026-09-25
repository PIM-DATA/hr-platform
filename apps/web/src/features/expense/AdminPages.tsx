import { useState } from 'react';
import { Plus } from 'lucide-react';
import { EXPENSE_CATEGORY_TYPES, EXPENSE_REPORT_STATUSES, EXPENSE_RULE_TYPES, TRAVEL_REQUEST_STATUSES, type ExpenseCategoryDto, type ExpensePolicyDto, type ExpenseReportDto, type TravelPolicyDto, type TravelRequestDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useExpenseCategories, useExpenseDashboard, useExpenseMutations, useExpenseOptions, useExpensePolicies, useExpensePolicyConflicts, useExpenseReports, useExpenseReportsAnalytics, useTravelPolicies, useTravelRequests } from './expense.api';
import { ExpenseBadge, Stat, Table, fmtDate, money, titleCase } from './expense-ui';
import { ReportModal, TravelModal } from './ExpenseDialogs';

const emp = (s: { employeeName: string; employeeCode: string; department: string | null }) => <div><div className="font-medium text-slate-900">{s.employeeName}</div><div className="text-xs text-slate-400">{s.employeeCode} · {s.department ?? '—'}</div></div>;

// ---------- travel requests ----------
export function TravelRequestsPage() {
  const [status, setStatus] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [open, setOpen] = useState<string | null>(null);
  const list = useTravelRequests({ status, search, page, pageSize: 20 });
  const columns: Column<TravelRequestDto>[] = [
    { key: 'n', header: 'Request', render: (r) => <span className="font-medium text-brand-700">{r.requestNumber}<span className="block text-xs font-normal text-slate-400">{r.destination}</span></span> },
    { key: 'e', header: 'Employee', render: (r) => emp(r.snapshot) },
    { key: 'd', header: 'Dates', hideBelow: 'sm', render: (r) => `${r.startDate} → ${r.endDate}` },
    { key: 'a', header: 'Estimate', render: (r) => <span className="tabular-nums">{money(r.estimatedAmount, r.currency)}</span> },
    { key: 's', header: 'Status', render: (r) => <ExpenseBadge status={r.status} /> },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3"><Select options={TRAVEL_REQUEST_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} /><Input placeholder="Search number, destination or employee" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /><p className="self-center text-xs text-slate-500">Purposes are visible on the request itself, never in this list or in reports.</p></div>
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpen(r.id)} emptyTitle="No travel requests" />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {open && <TravelModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

// ---------- expense reports / payments ----------
export function ExpenseReportsPage({ payments = false }: { payments?: boolean }) {
  const [status, setStatus] = useState(payments ? 'READY_FOR_PAYMENT' : ''); const [policyId, setPolicyId] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [open, setOpen] = useState<string | null>(null);
  const list = useExpenseReports({ status, policyId, search, page, pageSize: 20 }); const policies = useExpensePolicies(true);
  const columns: Column<ExpenseReportDto>[] = [
    { key: 'n', header: 'Report', render: (r) => <span className="font-medium text-brand-700">{r.reportNumber}<span className="block text-xs font-normal text-slate-400">{r.title}{r.travelRequestNumber ? ` · ${r.travelRequestNumber}` : ''}</span></span> },
    { key: 'e', header: 'Employee', render: (r) => emp(r.snapshot) },
    { key: 'p', header: 'Policy', hideBelow: 'md', render: (r) => r.policyName },
    { key: 'a', header: 'Total', render: (r) => <span className="font-semibold tabular-nums">{money(r.total, r.currency)}<span className="block text-xs font-normal text-slate-400">{r.itemCount} item(s)</span></span> },
    { key: 's', header: 'Status', render: (r) => <span><ExpenseBadge status={r.status} />{r.paidDate && <span className="block text-xs text-slate-400">paid {r.paidDate}</span>}</span> },
  ];
  const statuses = payments ? ['READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID'] : [...EXPENSE_REPORT_STATUSES];
  return (
    <Card>
      {payments && <div className="border-b border-slate-200 p-4"><CardHeader title="Payments" description="Approved reports waiting for money. Record an external payment, or send a report to a payroll run in review. Neither is automatic." /></div>}
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3"><Select options={statuses.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} /><Select options={(policies.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="All policies" value={policyId} onChange={(e) => { setPolicyId(e.target.value); setPage(1); }} /><Input placeholder="Search number, title or employee" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpen(r.id)} emptyTitle={payments ? 'Nothing waiting for payment' : 'No expense reports'} />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {open && <ReportModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

// ---------- categories ----------
export function CategoriesPage() {
  const cats = useExpenseCategories(true); const m = useExpenseMutations(); const toast = useToast();
  const [editing, setEditing] = useState<ExpenseCategoryDto | 'new' | null>(null); const [d, setD] = useState({ code: '', name: '', description: '', type: 'GENERAL' as (typeof EXPENSE_CATEGORY_TYPES)[number], isActive: true }); const [error, setError] = useState<string | null>(null);
  const start = (c: ExpenseCategoryDto | 'new') => { setError(null); setD(c === 'new' ? { code: '', name: '', description: '', type: 'GENERAL', isActive: true } : { code: c.code, name: c.name, description: c.description ?? '', type: c.type, isActive: c.isActive }); setEditing(c); };
  const save = async () => { setError(null); try { if (editing === 'new') await m.createCategory.mutateAsync({ code: d.code, name: d.name, description: d.description || null, type: d.type }); else if (editing) await m.updateCategory.mutateAsync({ id: editing.id, input: { name: d.name, description: d.description || null, type: d.type, isActive: d.isActive } }); toast.success('Saved.'); setEditing(null); } catch (e) { setError(errorMessage(e)); } };
  const columns: Column<ExpenseCategoryDto>[] = [
    { key: 'c', header: 'Category', render: (c) => <span className="font-medium text-slate-900">{c.name}<span className="block text-xs font-normal text-slate-400">{c.code}{c.description ? ` · ${c.description}` : ''}</span></span> },
    { key: 't', header: 'Type', render: (c) => <ExpenseBadge status={c.type} /> },
    { key: 's', header: 'Active', render: (c) => (c.isActive ? 'Yes' : 'No') },
    { key: 'a', header: '', render: (c) => <Button size="sm" variant="secondary" onClick={() => start(c)}>Edit</Button> },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Expense categories" description="What an item can be. A travel category is meant for trip expenses; a policy rule can restrict it to reports linked to a trip." /><Button onClick={() => start('new')}><Plus className="h-4 w-4" /> New category</Button></div>
      <DataTable columns={columns} rows={cats.data ?? []} rowKey={(c) => c.id} loading={cats.isLoading} emptyTitle="No categories yet" />
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'New category' : 'Edit category'} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={m.createCategory.isPending || m.updateCategory.isPending} disabled={!d.name || (editing === 'new' && !d.code)} onClick={save}>Save</Button></>}>
        <div className="space-y-3">{error && <Alert>{error}</Alert>}<div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Code" placeholder="MEALS" value={d.code} disabled={editing !== 'new'} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} /><Input label="Name" placeholder="Meals" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div><Select label="Type" options={EXPENSE_CATEGORY_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as 'GENERAL' })} /><Input label="Description (optional)" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />{editing !== 'new' && <Checkbox label="Active" checked={d.isActive} onChange={(e) => setD({ ...d, isActive: e.target.checked })} />}</div>
      </Modal>
    </Card>
  );
}

// ---------- policies (expense + travel) ----------
type RuleDraft = { categoryId: string; requiresReceipt: boolean; receiptRequiredAbove: string; perItemMaximum: string; maximumAgeDays: string; allowedForTravelOnly: boolean; descriptionRequired: boolean };
type AppDraft = { ruleType: (typeof EXPENSE_RULE_TYPES)[number]; value: string };
const emptyPolicy = { code: '', name: '', description: '', organizationId: '', currency: 'THB', effectiveFrom: `${new Date().getFullYear()}-01-01`, effectiveTo: '', workflowCode: '', maximumReportAmount: '' };
export function PoliciesPage() {
  const policies = useExpensePolicies(true); const conflicts = useExpensePolicyConflicts(); const travel = useTravelPolicies(true); const cats = useExpenseCategories(); const options = useExpenseOptions(); const m = useExpenseMutations(); const toast = useToast();
  const [editing, setEditing] = useState<ExpensePolicyDto | 'new' | null>(null); const [tEditing, setTEditing] = useState<TravelPolicyDto | 'new' | null>(null); const [error, setError] = useState<string | null>(null);
  const [d, setD] = useState({ ...emptyPolicy }); const [rules, setRules] = useState<RuleDraft[]>([]); const [apps, setApps] = useState<AppDraft[]>([]);
  const [t, setT] = useState({ code: '', name: '', description: '', organizationId: '', currency: 'THB', workflowCode: '', expensePolicyId: '', maximumEstimatedAmount: '', effectiveFrom: `${new Date().getFullYear()}-01-01`, effectiveTo: '' });
  const start = (p: ExpensePolicyDto | 'new') => {
    setError(null);
    if (p === 'new') { setD({ ...emptyPolicy, workflowCode: options.data?.reportWorkflows[0]?.code ?? '' }); setRules([]); setApps([]); }
    else { setD({ code: p.code, name: p.name, description: p.description ?? '', organizationId: p.organizationId ?? '', currency: p.currency, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo ?? '', workflowCode: p.workflowCode, maximumReportAmount: p.maximumReportAmount ?? '' }); setRules(p.rules.map((r) => ({ categoryId: r.categoryId, requiresReceipt: r.requiresReceipt, receiptRequiredAbove: r.receiptRequiredAbove ?? '', perItemMaximum: r.perItemMaximum ?? '', maximumAgeDays: r.maximumAgeDays ? String(r.maximumAgeDays) : '', allowedForTravelOnly: r.allowedForTravelOnly, descriptionRequired: r.descriptionRequired }))); setApps(p.applicability.map((a) => ({ ruleType: a.ruleType, value: a.value }))); }
    setEditing(p);
  };
  const save = async () => {
    setError(null);
    const body = { name: d.name, description: d.description || null, organizationId: d.organizationId || null, currency: d.currency, effectiveFrom: d.effectiveFrom, effectiveTo: d.effectiveTo || null, workflowCode: d.workflowCode, maximumReportAmount: d.maximumReportAmount || null,
      rules: rules.filter((r) => r.categoryId).map((r) => ({ categoryId: r.categoryId, requiresReceipt: r.requiresReceipt, receiptRequiredAbove: r.receiptRequiredAbove || null, perItemMaximum: r.perItemMaximum || null, maximumAgeDays: r.maximumAgeDays ? Number(r.maximumAgeDays) : null, allowedForTravelOnly: r.allowedForTravelOnly, descriptionRequired: r.descriptionRequired })), applicability: apps.filter((a) => a.value) };
    try { if (editing === 'new') await m.createPolicy.mutateAsync({ code: d.code, ...body }); else if (editing) await m.updatePolicy.mutateAsync({ id: editing.id, input: body }); toast.success('Policy saved.'); setEditing(null); } catch (e) { setError(errorMessage(e)); }
  };
  const setStatus = async (p: { id: string }, status: 'ACTIVE' | 'INACTIVE', travelPolicy = false) => { try { await (travelPolicy ? m.updateTravelPolicy : m.updatePolicy).mutateAsync({ id: p.id, input: { status } }); toast.success(status === 'ACTIVE' ? 'Activated.' : 'Deactivated.'); } catch (e) { toast.error(errorMessage(e)); } };
  const valueOptions = (ruleType: AppDraft['ruleType']) => {
    const o = options.data;
    if (ruleType === 'ORGANIZATION') return (o?.organizations ?? []).map((x) => ({ value: x.id, label: x.name }));
    if (ruleType === 'DEPARTMENT') return (o?.departments ?? []).map((x) => ({ value: x.id, label: x.name }));
    if (ruleType === 'JOB') return (o?.jobs ?? []).map((x) => ({ value: x.id, label: x.title }));
    if (ruleType === 'POSITION') return (o?.positions ?? []).map((x) => ({ value: x.id, label: x.title }));
    if (ruleType === 'EMPLOYMENT_TYPE') return ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((x) => ({ value: x, label: titleCase(x) }));
    return ['ACTIVE', 'INACTIVE'].map((x) => ({ value: x, label: titleCase(x) }));
  };
  const pcols: Column<ExpensePolicyDto>[] = [
    { key: 'p', header: 'Policy', render: (p) => <span className="font-medium text-slate-900">{p.name}<span className="block text-xs font-normal text-slate-400">{p.code} · {p.currency} · {p.effectiveFrom} → {p.effectiveTo ?? 'open'} · workflow {p.workflowCode}</span></span> },
    { key: 'r', header: 'Rules', hideBelow: 'md', render: (p) => <span className="text-xs text-slate-600">{p.rules.length === 0 ? 'No category rules' : p.rules.map((r) => `${r.categoryName}${r.perItemMaximum ? ` ≤ ${r.perItemMaximum}` : ''}${r.requiresReceipt ? r.receiptRequiredAbove ? ` (receipt ≥ ${r.receiptRequiredAbove})` : ' (receipt)' : ''}`).join(' · ')}</span> },
    { key: 'a', header: 'Applies to', hideBelow: 'sm', render: (p) => <span className="text-xs text-slate-600">{p.applicability.length === 0 ? 'Nobody until a rule is added' : p.applicability.map((a) => `${titleCase(a.ruleType)}: ${a.label}`).join(' · ')}</span> },
    { key: 's', header: 'Status', render: (p) => <ExpenseBadge status={p.status} /> },
    { key: 'x', header: '', render: (p) => <span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => start(p)}>Edit</Button>{p.status !== 'ACTIVE' ? <Button size="sm" onClick={() => setStatus(p, 'ACTIVE')}>Activate</Button> : <Button size="sm" variant="secondary" onClick={() => setStatus(p, 'INACTIVE')}>Deactivate</Button>}</span> },
  ];
  const tcols: Column<TravelPolicyDto>[] = [
    { key: 'p', header: 'Travel policy', render: (p) => <span className="font-medium text-slate-900">{p.name}<span className="block text-xs font-normal text-slate-400">{p.code} · {p.currency} · workflow {p.workflowCode}{p.expensePolicyName ? ` · expenses under ${p.expensePolicyName}` : ''}{p.maximumEstimatedAmount ? ` · estimate ≤ ${p.maximumEstimatedAmount}` : ''}</span></span> },
    { key: 'n', header: 'Requests', hideBelow: 'sm', render: (p) => p.requestCount },
    { key: 's', header: 'Status', render: (p) => <ExpenseBadge status={p.status} /> },
    { key: 'x', header: '', render: (p) => <span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => { setError(null); setT({ code: p.code, name: p.name, description: p.description ?? '', organizationId: p.organizationId ?? '', currency: p.currency, workflowCode: p.workflowCode, expensePolicyId: p.expensePolicyId ?? '', maximumEstimatedAmount: p.maximumEstimatedAmount ?? '', effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo ?? '' }); setTEditing(p); }}>Edit</Button>{p.status !== 'ACTIVE' ? <Button size="sm" onClick={() => setStatus(p, 'ACTIVE', true)}>Activate</Button> : <Button size="sm" variant="secondary" onClick={() => setStatus(p, 'INACTIVE', true)}>Deactivate</Button>}</span> },
  ];
  const saveTravel = async () => { setError(null); const body = { name: t.name, description: t.description || null, organizationId: t.organizationId || null, currency: t.currency, workflowCode: t.workflowCode, expensePolicyId: t.expensePolicyId || null, maximumEstimatedAmount: t.maximumEstimatedAmount || null, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo || null }; try { if (tEditing === 'new') await m.createTravelPolicy.mutateAsync({ code: t.code, ...body }); else if (tEditing) await m.updateTravelPolicy.mutateAsync({ id: tEditing.id, input: body }); toast.success('Travel policy saved.'); setTEditing(null); } catch (e) { setError(errorMessage(e)); } };
  return (
    <div className="space-y-4">
      {(conflicts.data?.length ?? 0) > 0 && <Alert>Multiple expense policies apply at the same priority. Please update policy applicability before employees can submit: {conflicts.data!.map((c) => `${c.policies.map((p) => p.code).join(' vs ')} (${c.employeeCount} employee${c.employeeCount === 1 ? '' : 's'})`).join('; ')}.</Alert>}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Expense policies" description="Per-category rules (receipts, per-item maximum, age, description) and who the policy applies to. The server assigns each employee the single most specific applicable policy; two at the same level block submission until applicability is fixed. Rules are frozen into each report at submission." /><Button onClick={() => start('new')}><Plus className="h-4 w-4" /> New policy</Button></div>
        <DataTable columns={pcols} rows={policies.data ?? []} rowKey={(p) => p.id} loading={policies.isLoading} emptyTitle="No expense policies yet" />
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Travel policies" description="Which workflow approves a trip and which expense policy the trip's report falls under." /><Button onClick={() => { setError(null); setT({ code: '', name: '', description: '', organizationId: '', currency: 'THB', workflowCode: options.data?.travelWorkflows[0]?.code ?? '', expensePolicyId: '', maximumEstimatedAmount: '', effectiveFrom: `${new Date().getFullYear()}-01-01`, effectiveTo: '' }); setTEditing('new'); }}><Plus className="h-4 w-4" /> New travel policy</Button></div>
        <DataTable columns={tcols} rows={travel.data ?? []} rowKey={(p) => p.id} loading={travel.isLoading} emptyTitle="No travel policies yet" />
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} size="lg" title={editing === 'new' ? 'New expense policy' : 'Edit expense policy'} description="Applicability uses organization, department, job, position, employment type and status only; never protected attributes." footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={m.createPolicy.isPending || m.updatePolicy.isPending} disabled={!d.name || !d.workflowCode || (editing === 'new' && !d.code)} onClick={save}>Save</Button></>}>
        <div className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" placeholder="TH-BIZ" value={d.code} disabled={editing !== 'new'} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} /><Input label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /><Input label="Currency" maxLength={3} value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value.toUpperCase() })} /></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Approval workflow" options={(options.data?.reportWorkflows ?? []).map((w) => ({ value: w.code, label: `${w.code} · ${w.name}` }))} placeholder="Choose" value={d.workflowCode} onChange={(e) => setD({ ...d, workflowCode: e.target.value })} /><Select label="Organization (optional)" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={d.organizationId} onChange={(e) => setD({ ...d, organizationId: e.target.value })} /><Input label="Report maximum (optional)" inputMode="decimal" value={d.maximumReportAmount} onChange={(e) => setD({ ...d, maximumReportAmount: e.target.value })} /></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Effective from" type="date" value={d.effectiveFrom} onChange={(e) => setD({ ...d, effectiveFrom: e.target.value })} /><Input label="Effective to (optional)" type="date" value={d.effectiveTo} onChange={(e) => setD({ ...d, effectiveTo: e.target.value })} /></div>
          <div>
            <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Category rules</span><Button size="sm" variant="secondary" onClick={() => setRules([...rules, { categoryId: '', requiresReceipt: false, receiptRequiredAbove: '', perItemMaximum: '', maximumAgeDays: '', allowedForTravelOnly: false, descriptionRequired: false }])}>Add rule</Button></div>
            {rules.map((r, i) => { const set = (patch: Partial<RuleDraft>) => setRules(rules.map((x, j) => (j === i ? { ...x, ...patch } : x))); return (
              <div key={i} className="mt-2 space-y-2 rounded-lg border border-slate-200 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-4"><Select label="Category" options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose" value={r.categoryId} onChange={(e) => set({ categoryId: e.target.value })} /><Input label="Per-item maximum" inputMode="decimal" value={r.perItemMaximum} onChange={(e) => set({ perItemMaximum: e.target.value })} /><Input label="Receipt required from amount" inputMode="decimal" placeholder="blank = always" value={r.receiptRequiredAbove} onChange={(e) => set({ receiptRequiredAbove: e.target.value })} /><Input label="Maximum age (days)" inputMode="numeric" value={r.maximumAgeDays} onChange={(e) => set({ maximumAgeDays: e.target.value })} /></div>
                <div className="flex flex-wrap gap-4"><Checkbox label="Receipt required" checked={r.requiresReceipt} onChange={(e) => set({ requiresReceipt: e.target.checked })} /><Checkbox label="Description required" checked={r.descriptionRequired} onChange={(e) => set({ descriptionRequired: e.target.checked })} /><Checkbox label="Travel reports only" checked={r.allowedForTravelOnly} onChange={(e) => set({ allowedForTravelOnly: e.target.checked })} /><button className="text-xs text-red-700 underline" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button></div>
              </div>); })}
            <p className="mt-1 text-xs text-slate-400">A receipt threshold is inclusive: an amount equal to it needs a receipt.</p>
          </div>
          <div>
            <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Applies to</span><Button size="sm" variant="secondary" onClick={() => setApps([...apps, { ruleType: 'ORGANIZATION', value: '' }])}>Add rule</Button></div>
            {apps.map((a, i) => <div key={i} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]"><Select options={EXPENSE_RULE_TYPES.map((x) => ({ value: x, label: titleCase(x) }))} value={a.ruleType} onChange={(e) => setApps(apps.map((x, j) => (j === i ? { ruleType: e.target.value as AppDraft['ruleType'], value: '' } : x)))} /><Select options={valueOptions(a.ruleType)} placeholder="Choose" value={a.value} onChange={(e) => setApps(apps.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} /><button className="text-xs text-red-700 underline" onClick={() => setApps(apps.filter((_, j) => j !== i))}>Remove</button></div>)}
            <p className="mt-1 text-xs text-slate-400">Precedence when several policies apply: position, then job, then department, then organization, then employment type or status.</p>
          </div>
        </div>
      </Modal>
      <Modal open={!!tEditing} onClose={() => setTEditing(null)} title={tEditing === 'new' ? 'New travel policy' : 'Edit travel policy'} footer={<><Button variant="secondary" onClick={() => setTEditing(null)}>Cancel</Button><Button loading={m.createTravelPolicy.isPending || m.updateTravelPolicy.isPending} disabled={!t.name || !t.workflowCode || (tEditing === 'new' && !t.code)} onClick={saveTravel}>Save</Button></>}>
        <div className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" placeholder="TH-TRAVEL" value={t.code} disabled={tEditing !== 'new'} onChange={(e) => setT({ ...t, code: e.target.value.toUpperCase() })} /><Input label="Name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /><Input label="Currency" maxLength={3} value={t.currency} onChange={(e) => setT({ ...t, currency: e.target.value.toUpperCase() })} /></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Select label="Approval workflow" options={(options.data?.travelWorkflows ?? []).map((w) => ({ value: w.code, label: `${w.code} · ${w.name}` }))} placeholder="Choose" value={t.workflowCode} onChange={(e) => setT({ ...t, workflowCode: e.target.value })} /><Select label="Expense policy for the trip's report (optional)" options={(policies.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="Employee's default" value={t.expensePolicyId} onChange={(e) => setT({ ...t, expensePolicyId: e.target.value })} /></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Organization (optional)" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={t.organizationId} onChange={(e) => setT({ ...t, organizationId: e.target.value })} /><Input label="Estimate maximum (optional)" inputMode="decimal" value={t.maximumEstimatedAmount} onChange={(e) => setT({ ...t, maximumEstimatedAmount: e.target.value })} /><Input label="Effective from" type="date" value={t.effectiveFrom} onChange={(e) => setT({ ...t, effectiveFrom: e.target.value })} /></div>
        </div>
      </Modal>
    </div>
  );
}

// ---------- dashboard / analytics ----------
export function ExpenseDashboardPage() {
  const q = useExpenseDashboard();
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <Alert>Could not load the dashboard.</Alert>;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Trips pending" value={d.travel.pendingApproval} hint={`${d.travel.approved} approved · ${d.travel.completed} completed`} /><Stat label="Reports pending" value={d.reports.pendingApproval} tone={d.reports.pendingApproval > 0 ? 'warning' : undefined} /><Stat label="Ready for payment" value={d.reports.readyForPayment} hint={`${d.reports.sentToPayroll} in payroll`} /><Stat label="Paid" value={d.reports.paid} hint={`${d.reports.rejected} rejected`} /></div>
      {d.money.map((m) => <Card key={m.currency}><CardHeader title={`Money (${m.currency})`} description="Organization-wide totals of submitted reports. Ready is approved and not yet paid." /><Table head={['Pending approval', 'Ready for payment', 'Paid this month', 'Paid year to date']} rows={[[money(m.pendingTotal), money(m.readyTotal), money(m.paidThisMonth), money(m.paidYearToDate)]]} /></Card>)}
      <Card><CardHeader title="Definitions" /><dl className="grid grid-cols-1 gap-2 p-4 text-xs text-slate-600 sm:grid-cols-2">{Object.entries(d.definitions).map(([k, v]) => <div key={k}><dt className="font-semibold text-slate-800">{k}</dt><dd>{v}</dd></div>)}</dl></Card>
      <p className="text-xs text-slate-400">Generated {fmtDate(d.generatedAt)}. Counts and totals only; no employee, department or purpose appears here.</p>
    </div>
  );
}
export function ExpenseAnalyticsPage() {
  const y = new Date().getFullYear(); const [range, setRange] = useState({ from: `${y}-01-01`, to: `${y}-12-31`, organizationId: '' });
  const options = useExpenseOptions(); const q = useExpenseReportsAnalytics(range);
  const d = q.data;
  return (
    <div className="space-y-4">
      <Card><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4"><Input label="From" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><Input label="To" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /><Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All" value={range.organizationId} onChange={(e) => setRange({ ...range, organizationId: e.target.value })} /><p className="self-end text-xs text-slate-500">Aggregates by policy, category and month. No department, person or purpose by design.</p></div></Card>
      {q.isLoading && <LoadingBlock />}
      {d && <>
        <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By policy</div><Table head={['Policy', 'Currency', 'Reports', 'Submitted', 'Ready', 'Paid', 'Rejected']} rows={d.byPolicy.map((r) => [r.policy, r.currency, r.reports, money(r.submittedTotal), money(r.readyTotal), money(r.paidTotal), r.rejected])} /></Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By category</div><Table head={['Category', 'Currency', 'Items', 'Total']} rows={d.byCategory.map((r) => [r.category, r.currency, r.items, money(r.total)])} /></Card>
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By month</div><Table head={['Month', 'Currency', 'Reports', 'Submitted', 'Paid']} rows={d.byMonth.map((r) => [r.month, r.currency, r.reports, money(r.total), money(r.paid)])} /></Card>
        </div>
        <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Travel</div><div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4"><Stat label="Requests" value={d.travel.requests} /><Stat label="Approved" value={d.travel.approved} /><Stat label="Rejected" value={d.travel.rejected} /><Stat label="Estimated total" value={money(d.travel.estimatedTotal)} /></div><Table head={['Month', 'Requests', 'Estimated']} rows={d.travel.byMonth.map((r) => [r.month, r.requests, money(r.estimatedTotal)])} /></Card>
      </>}
    </div>
  );
}
