import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { BENEFIT_ADJUSTMENT_REASONS, BENEFIT_CLAIM_STATUSES, PERMISSIONS, type BenefitClaimDto, type BenefitEnrollmentDto, type BenefitEntitlementDto, type BenefitPeriodDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useBenefitClaims, useBenefitEnrollments, useBenefitEntitlement, useBenefitEntitlements, useBenefitPeriods, useBenefitPlans, useBenefitsDashboard, useBenefitsMutations, useBenefitsReport } from './benefits.api';
import { BalanceBar, BenefitBadge, Stat, Table, fmtDate, money, titleCase } from './benefits-ui';
import { ClaimModal } from './ClaimDialogs';

/** Amounts in different currencies are listed side by side, never added (no FX conversion exists). */
const perCurrency = <T extends { currency: string }>(amounts: T[], key: keyof T) => (amounts.length ? amounts.map((m) => `${m.currency} ${String(m[key])}`).join(' · ') : '—');

// ---------- periods ----------
export function PeriodsPage() {
  const periods = useBenefitPeriods(); const plans = useBenefitPlans(); const m = useBenefitsMutations(); const toast = useToast();
  const [creating, setCreating] = useState(false); const [confirm, setConfirm] = useState<{ id: string; op: 'open' | 'close' } | null>(null); const [d, setD] = useState({ planId: '', name: '', periodStart: `${new Date().getFullYear()}-01-01`, periodEnd: `${new Date().getFullYear()}-12-31`, entitlementAmount: '' }); const [error, setError] = useState<string | null>(null);
  const columns: Column<BenefitPeriodDto>[] = [
    { key: 'n', header: 'Period', render: (p) => <div><div className="font-medium text-slate-900">{p.name}</div><div className="text-xs text-slate-400">{p.planName} · {p.periodStart} → {p.periodEnd}</div></div> },
    { key: 'm', header: 'Frozen rules', hideBelow: 'sm', render: (p) => p.status === 'DRAFT' ? <span className="text-xs text-slate-400">set at open{p.entitlementAmountSnapshot ? ` (planned ${money(p.entitlementAmountSnapshot)})` : ''}</span> : <span className="tabular-nums">{money(p.entitlementAmountSnapshot, p.currencySnapshot)}{p.perClaimMaximumSnapshot ? <span className="block text-xs text-slate-400">per claim ≤ {money(p.perClaimMaximumSnapshot)}{p.requiresDocumentSnapshot ? ' · receipt required' : ''}</span> : null}</span> },
    { key: 'e', header: 'Entitlements', hideBelow: 'md', render: (p) => p.entitlementCount },
    { key: 's', header: 'Status', render: (p) => <BenefitBadge status={p.status} /> },
    { key: 'a', header: '', render: (p) => <span className="flex gap-2">{p.status === 'DRAFT' && <Button size="sm" onClick={() => setConfirm({ id: p.id, op: 'open' })}>Open</Button>}{p.status === 'OPEN' && <Button size="sm" variant="secondary" onClick={() => setConfirm({ id: p.id, op: 'close' })}>Close</Button>}</span> },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Benefit periods" description="Opening a period freezes currency, entitlement, per-claim maximum and the document rule. Later plan edits apply to future periods only." /><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New period</Button></div>
      <DataTable columns={columns} rows={periods.data ?? []} rowKey={(p) => p.id} loading={periods.isLoading} emptyTitle="No periods yet" />
      <ConfirmDialog open={!!confirm} title={confirm?.op === 'open' ? 'Open this period?' : 'Close this period?'} message={confirm?.op === 'open' ? 'The plan\'s money rules are frozen into the period now.' : 'No new claims can be made in it; pending claims continue.'} confirmLabel={confirm?.op === 'open' ? 'Open' : 'Close'} loading={m.openPeriod.isPending || m.closePeriod.isPending} onConfirm={async () => { try { await (confirm!.op === 'open' ? m.openPeriod : m.closePeriod).mutateAsync(confirm!.id); toast.success('Done.'); setConfirm(null); } catch (e) { toast.error(errorMessage(e)); } }} onCancel={() => setConfirm(null)} />
      <Modal open={creating} onClose={() => setCreating(false)} title="New benefit period" footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button loading={m.createPeriod.isPending} onClick={async () => { setError(null); try { await m.createPeriod.mutateAsync({ planId: d.planId, name: d.name, periodStart: d.periodStart, periodEnd: d.periodEnd, entitlementAmount: d.entitlementAmount || null }); toast.success('Period created as a draft.'); setCreating(false); } catch (e) { setError(errorMessage(e)); } }}>Create</Button></>}>
        <div className="space-y-3">{error && <Alert>{error}</Alert>}<Select label="Plan" options={(plans.data ?? []).filter((p) => p.planType !== 'COVERAGE_ONLY').map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} placeholder="Choose" value={d.planId} onChange={(e) => setD({ ...d, planId: e.target.value })} /><Input label="Name" placeholder="2026 Annual Health Benefit" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Start" type="date" value={d.periodStart} onChange={(e) => setD({ ...d, periodStart: e.target.value })} /><Input label="End" type="date" value={d.periodEnd} onChange={(e) => setD({ ...d, periodEnd: e.target.value })} /><Input label="Entitlement (blank = plan default)" inputMode="decimal" value={d.entitlementAmount} onChange={(e) => setD({ ...d, entitlementAmount: e.target.value })} /></div></div>
      </Modal>
    </Card>
  );
}

// ---------- enrollments ----------
export function EnrollmentsPage() {
  const [status, setStatus] = useState(''); const [planId, setPlanId] = useState(''); const [page, setPage] = useState(1);
  const list = useBenefitEnrollments({ status, planId, page, pageSize: 20 }); const plans = useBenefitPlans({ includeInactive: true }); const m = useBenefitsMutations(); const toast = useToast();
  const columns: Column<BenefitEnrollmentDto>[] = [
    { key: 'e', header: 'Employee', render: (r) => <div><div className="font-medium text-slate-900">{r.snapshot.employeeName}</div><div className="text-xs text-slate-400">{r.snapshot.employeeCode} · {r.snapshot.department ?? '—'}</div></div> },
    { key: 'p', header: 'Plan', render: (r) => <span>{r.planName}<span className="block text-xs text-slate-400">{r.categoryName} · {titleCase(r.planType)}</span></span> },
    { key: 'c', header: 'Coverage', hideBelow: 'sm', render: (r) => `${r.coverageStart ?? '—'} → ${r.coverageEnd ?? 'open'}` },
    { key: 's', header: 'Status', render: (r) => <span className="flex items-center gap-2"><BenefitBadge status={r.status} />{r.source && <span className="text-xs text-slate-400">{r.source === 'SELF' ? 'self' : 'HR'}</span>}</span> },
    { key: 'a', header: '', render: (r) => r.status === 'ENROLLED' ? <Button size="sm" variant="secondary" onClick={async () => { try { await m.endEnrollment.mutateAsync(r.id); toast.success('Enrolment ended.'); } catch (e) { toast.error(errorMessage(e)); } }}>End</Button> : null },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3"><Select options={['ELIGIBLE', 'ENROLLED', 'WAIVED', 'ENDED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} /><Select options={(plans.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="All plans" value={planId} onChange={(e) => { setPlanId(e.target.value); setPage(1); }} /><p className="self-center text-xs text-slate-500">Enrol from the plan's eligibility screen. A waiver is the employee's own record and stays.</p></div>
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(r) => r.id} loading={list.isLoading} emptyTitle="No enrolments" />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
    </Card>
  );
}

// ---------- entitlements ----------
export function EntitlementsPage() {
  const [planId, setPlanId] = useState(''); const [periodId, setPeriodId] = useState(''); const [page, setPage] = useState(1); const [open, setOpen] = useState<string | null>(null); const [generating, setGenerating] = useState(false);
  const list = useBenefitEntitlements({ planId, periodId, page, pageSize: 20 }); const plans = useBenefitPlans({ includeInactive: true }); const periods = useBenefitPeriods(planId ? { planId } : {}); const m = useBenefitsMutations(); const toast = useToast();
  const [genPeriod, setGenPeriod] = useState('');
  const columns: Column<BenefitEntitlementDto>[] = [
    { key: 'e', header: 'Employee', render: (r) => <div><div className="font-medium text-slate-900">{r.snapshot.employeeName}</div><div className="text-xs text-slate-400">{r.snapshot.employeeCode} · {r.snapshot.department ?? '—'}</div></div> },
    { key: 'p', header: 'Plan / period', render: (r) => <span>{r.planName}<span className="block text-xs text-slate-400">{r.periodName}</span></span> },
    { key: 'g', header: 'Granted', hideBelow: 'sm', render: (r) => <span className="tabular-nums">{money(r.balance.granted)}</span> },
    { key: 'r', header: 'Reserved', hideBelow: 'md', render: (r) => <span className="tabular-nums">{money(r.balance.reserved)}</span> },
    { key: 'u', header: 'Used', hideBelow: 'md', render: (r) => <span className="tabular-nums">{money(r.balance.consumed)}</span> },
    { key: 'a', header: 'Available', render: (r) => <span className="font-semibold tabular-nums">{money(r.balance.available, r.balance.currency)}</span> },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4"><Select options={(plans.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="All plans" value={planId} onChange={(e) => { setPlanId(e.target.value); setPeriodId(''); setPage(1); }} /><Select options={(periods.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="All periods" value={periodId} onChange={(e) => { setPeriodId(e.target.value); setPage(1); }} /><div /><div className="flex justify-end"><Button onClick={() => setGenerating(true)}>Generate entitlements</Button></div></div>
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpen(r.id)} emptyTitle="No entitlements" emptyDescription="Open a period and generate entitlements for its enrolled, eligible employees." />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      <Modal open={generating} onClose={() => setGenerating(false)} title="Generate entitlements" description="One account with a GRANT per enrolled and currently eligible employee of the open period. Running it again creates nothing for employees who already have one." footer={<><Button variant="secondary" onClick={() => setGenerating(false)}>Cancel</Button><Button loading={m.generate.isPending} disabled={!genPeriod} onClick={async () => { try { const r = await m.generate.mutateAsync({ periodId: genPeriod }); toast.success(`Created ${r.created}; existing ${r.skippedExisting}; not eligible ${r.skippedIneligible}; not enrolled ${r.skippedNotEnrolled}.`); setGenerating(false); } catch (e) { toast.error(errorMessage(e)); } }}>Generate</Button></>}>
        <Select label="Open period" options={(periods.data ?? []).filter((p) => p.status === 'OPEN').map((p) => ({ value: p.id, label: `${p.planName} · ${p.name}` }))} placeholder={planId ? 'Choose' : 'Choose a plan first'} value={genPeriod} onChange={(e) => setGenPeriod(e.target.value)} />
      </Modal>
      {open && <EntitlementModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
function EntitlementModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useBenefitEntitlement(id); const m = useBenefitsMutations(); const toast = useToast(); const { hasPermission } = useAuth();
  const [adj, setAdj] = useState({ amount: '', reasonCode: 'DATA_CORRECTION', note: '' }); const [error, setError] = useState<string | null>(null);
  if (!q.data) return <Modal open onClose={onClose} title="Entitlement">{q.isError ? <Alert>Could not load.</Alert> : <LoadingBlock />}</Modal>;
  const d = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.snapshot.employeeName} — ${d.planName}`} description={`${d.periodName} · ${d.periodStart} → ${d.periodEnd} · ${d.snapshot.department ?? '—'} at grant`} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><BalanceBar balance={d.balance} /></div>
        <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ledger (append-only; the balance is derived from these rows)</div><Table head={['When', 'Type', 'Amount', 'Claim', 'Reason', 'By']} rows={d.ledger.map((l) => [fmtDate(l.createdAt), titleCase(l.entryType), <span key={l.id} className="tabular-nums">{l.amount}</span>, l.claimNumber ?? '—', l.reasonCode ? titleCase(l.reasonCode) : '—', l.createdByName ?? '—'])} /></div>
        {hasPermission(PERMISSIONS.BENEFITS_MANAGE) && d.periodStatus !== 'CLOSED' && <div className="rounded-lg border border-slate-200 p-3"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Adjustment (a new ledger row with a reason; nothing is edited)</div><div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4"><Input label="Amount (±)" inputMode="decimal" placeholder="1000.00 or -500.00" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /><Select label="Reason" options={BENEFIT_ADJUSTMENT_REASONS.map((r) => ({ value: r, label: titleCase(r) }))} value={adj.reasonCode} onChange={(e) => setAdj({ ...adj, reasonCode: e.target.value })} /><Input label="Note (HR only)" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /><div className="flex items-end"><Button loading={m.adjust.isPending} disabled={!adj.amount} onClick={async () => { setError(null); try { await m.adjust.mutateAsync({ id, input: { amount: adj.amount, reasonCode: adj.reasonCode as 'OTHER', note: adj.note || null } }); toast.success('Adjustment recorded.'); setAdj({ ...adj, amount: '', note: '' }); } catch (e) { setError(errorMessage(e)); } }}>Record</Button></div></div></div>}
      </div>
    </Modal>
  );
}

// ---------- claims and payments ----------
export function ClaimsPage({ payments = false }: { payments?: boolean }) {
  const [status, setStatus] = useState(payments ? 'READY_FOR_PAYMENT' : ''); const [planId, setPlanId] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [open, setOpen] = useState<string | null>(null);
  const list = useBenefitClaims({ status, planId, search, page, pageSize: 20 }); const plans = useBenefitPlans({ includeInactive: true });
  const columns: Column<BenefitClaimDto>[] = [
    { key: 'n', header: 'Claim', render: (c) => <div><div className="font-medium text-slate-900">{c.claimNumber}</div><div className="text-xs text-slate-400">{c.snapshot.employeeName} · {c.snapshot.employeeCode}</div></div> },
    { key: 'p', header: 'Plan', hideBelow: 'sm', render: (c) => <span>{c.planName}<span className="block text-xs text-slate-400">service {c.serviceDate}{c.submittedDate ? ` · submitted ${c.submittedDate}` : ''}</span></span> },
    { key: 'a', header: 'Amount', render: (c) => <span className="tabular-nums">{money(c.claimedAmount, c.currency)}{c.approvedAmount && c.approvedAmount !== c.claimedAmount ? <span className="block text-xs text-slate-400">approved {c.approvedAmount}</span> : null}</span> },
    { key: 'd', header: 'Docs', hideBelow: 'md', render: (c) => c.documentCount },
    { key: 's', header: 'Status', render: (c) => <BenefitBadge status={c.status} /> },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
        <Select options={(payments ? ['READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID'] : [...BENEFIT_CLAIM_STATUSES]).map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
        <Select options={(plans.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="All plans" value={planId} onChange={(e) => { setPlanId(e.target.value); setPage(1); }} />
        <Input placeholder="Search claim number or employee" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      {payments && <p className="border-b border-slate-200 px-4 py-2 text-xs text-slate-500">Approved claims waiting for payment. Recording a payment is bookkeeping; sending to payroll adds a manual line to a run in review and marks the claim "sent to payroll", not paid.</p>}
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} onRowClick={(c) => setOpen(c.id)} emptyTitle="No claims" />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {open && <ClaimModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

// ---------- dashboard and reports ----------
export function BenefitsDashboardPage() {
  const q = useBenefitsDashboard();
  if (q.isError) return <Alert>Could not load the dashboard.</Alert>;
  if (!q.data) return <LoadingBlock />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Active plans" value={d.plans.active} hint={`${d.plans.draft} draft · ${d.plans.inactive} inactive`} /><Stat label="Enrolled" value={d.enrollments.enrolled} hint={`${d.enrollments.waived} waived`} /><Stat label="Claims pending approval" value={d.claims.pendingApproval} tone={d.claims.pendingApproval > 0 ? 'warning' : undefined} hint={`${d.claims.draft} drafts`} /><Stat label="Ready for payment" value={d.claims.readyForPayment} tone={d.claims.readyForPayment > 0 ? 'warning' : undefined} hint={`${d.claims.sentToPayroll} sent to payroll · ${d.claims.paid} paid`} /></div>
      {d.money.map((m) => <Card key={m.currency}><CardHeader title={`Money (${m.currency})`} description="Organization-wide totals. Consumed is approved, not paid." /><Table head={['Granted', 'Reserved', 'Consumed', 'Available', 'Pending claims', 'Approved', 'Paid']} rows={[[m.granted, m.reserved, m.consumed, m.available, m.claimedPending, m.approved, m.paid]]} /></Card>)}
      <details className="text-xs text-slate-500"><summary className="cursor-pointer">How these numbers are defined</summary><ul className="mt-1 list-disc pl-5">{Object.entries(d.definitions).map(([k, v]) => <li key={k}>{v}</li>)}</ul></details>
    </div>
  );
}
export function BenefitsReportsPage() {
  const { hasPermission } = useAuth(); const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`); const [to, setTo] = useState(`${year}-12-31`);
  const r = useBenefitsReport({ from, to });
  if (r.isError) return <Alert>Could not load the report.</Alert>;
  const d = r.data;
  return (
    <div className="space-y-4">
      <Card><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3"><Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div></Card>
      {r.isLoading && <LoadingBlock />}
      {d && (<>
        <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By plan (organization-wide; no department breakdown by design)</div><Table head={['Plan', 'Category', 'Type', 'Enrolled', 'Granted', 'Consumed', 'Available', 'Claims', 'Approved', 'Rejected', 'Approved amount', 'Paid amount']} rows={d.byPlan.map((x) => [x.plan, x.category, titleCase(x.planType), x.enrolled, perCurrency(x.amounts, 'granted'), perCurrency(x.amounts, 'consumed'), perCurrency(x.amounts, 'available'), x.claims, x.approvedClaims, x.rejectedClaims, perCurrency(x.amounts, 'approvedAmount'), perCurrency(x.amounts, 'paidAmount')])} /></Card>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By category</div><Table head={['Category', 'Plans', 'Enrolled', 'Claims', 'Approved amount']} rows={d.byCategory.map((x) => [x.category, x.plans, x.enrolled, x.claims, perCurrency(x.amounts, 'approvedAmount')])} /></Card>
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Claims by status</div><Table head={['Status', 'Count', 'Claimed amount']} rows={d.claimsByStatus.map((x) => [titleCase(x.status), x.count, perCurrency(x.amounts, 'amount')])} /></Card>
        </div>
      </>)}
      {hasPermission(PERMISSIONS.REPORTS_VIEW) && <p className="text-xs text-slate-500">Report Center datasets: <Link to="/hrm/reports/builder" className="text-brand-700 underline">Benefit enrolment summary</Link>, <Link to="/hrm/reports/builder" className="text-brand-700 underline">Benefit entitlement summary</Link>, <Link to="/hrm/reports/builder" className="text-brand-700 underline">Benefit claim summary</Link> — aggregates, exact decimals, no person.</p>}
    </div>
  );
}
