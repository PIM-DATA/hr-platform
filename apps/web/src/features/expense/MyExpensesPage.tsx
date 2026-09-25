import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type TravelRequestDetailDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { useMyExpenses } from './expense.api';
import { ExpenseBadge, fmtDate, money } from './expense-ui';
import { NewReportModal, NewTravelModal, ReportModal, ReviewModal, TravelModal } from './ExpenseDialogs';

/** ESS: my travel requests, my expense reports, what was paid — and, for an approver, the requests waiting for me. */
export function MyExpensesPage() {
  const { hasPermission } = useAuth();
  const me = useMyExpenses();
  const [params, setParams] = useSearchParams();
  const [newTravel, setNewTravel] = useState(false); const [newReport, setNewReport] = useState<{ travel: TravelRequestDetailDto | null } | null>(null); const [reviewing, setReviewing] = useState<{ kind: 'report' | 'travel'; id: string } | null>(null);
  const openReport = params.get('report'); const openTravel = params.get('travel');
  const setOpen = (key: 'report' | 'travel', id: string | null) => { const n = new URLSearchParams(params); n.delete('report'); n.delete('travel'); if (id) n.set(key, id); setParams(n, { replace: true }); };
  if (me.isLoading) return <LoadingBlock />;
  if (me.isError) return <Alert>Could not load your expenses.</Alert>;
  const d = me.data!;
  const canSubmit = hasPermission(PERMISSIONS.EXPENSE_SUBMIT);
  const paid = d.reports.filter((r) => r.status === 'PAID' || r.status === 'SENT_TO_PAYROLL');
  return (
    <div className="space-y-4">
      {d.queue.length > 0 && (
        <Card>
          <CardHeader title="Waiting for my decision" description="You see the request, its items and receipts — nothing else about the person." />
          <ul className="divide-y divide-slate-200">{d.queue.map((i) => <li key={i.instanceId} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span><span className="font-medium text-slate-900">{i.requesterName}</span><span className="block text-xs text-slate-500">{i.entityType === 'TRAVEL_REQUEST' ? 'Travel request' : 'Expense report'} · step {i.stepName} · {fmtDate(i.submittedAt)}</span></span><Button size="sm" onClick={() => setReviewing({ kind: i.entityType === 'TRAVEL_REQUEST' ? 'travel' : 'report', id: i.entityId })}>Review</Button></li>)}</ul>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="My travel requests" description="Ask for approval before you travel. An approved trip is the starting point for its expense report." />{canSubmit && <Button onClick={() => setNewTravel(true)}><Plus className="h-4 w-4" /> New travel request</Button>}</div>
        {d.travelRequests.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No travel requests yet.</p> : <ul className="divide-y divide-slate-200">{d.travelRequests.map((t) => <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><button className="min-w-0 text-left" onClick={() => setOpen('travel', t.id)}><span className="font-medium text-brand-700 underline">{t.requestNumber}</span><span className="block text-xs text-slate-500">{t.destination} · {t.startDate} → {t.endDate}{t.expenseReports.length ? ` · ${t.expenseReports.length} report(s)` : ''}</span></button><span className="flex flex-wrap items-center gap-3"><span className="tabular-nums">est. {money(t.estimatedAmount, t.currency)}</span><ExpenseBadge status={t.status} />{t.can.createExpenseReport && canSubmit && <Button size="sm" variant="secondary" onClick={() => setNewReport({ travel: t as TravelRequestDetailDto })}>Create expense report</Button>}</span></li>)}</ul>}
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="My expense reports" description="Items, receipts and the exact total. Submit when the checks are clear." />{canSubmit && <Button onClick={() => setNewReport({ travel: null })}><Plus className="h-4 w-4" /> New expense report</Button>}</div>
        {d.reports.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No expense reports yet.</p> : <ul className="divide-y divide-slate-200">{d.reports.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><button className="min-w-0 text-left" onClick={() => setOpen('report', r.id)}><span className="font-medium text-brand-700 underline">{r.reportNumber}</span><span className="block text-xs text-slate-500">{r.title} · {r.policyName}{r.travelRequestNumber ? ` · trip ${r.travelRequestNumber}` : ''} · {r.itemCount} item(s)</span></button><span className="flex items-center gap-3"><span className="tabular-nums">{money(r.total, r.currency)}</span><ExpenseBadge status={r.status} /></span></li>)}</ul>}
      </Card>
      <Card>
        <CardHeader title="Payments" description="What has been paid or handed to payroll. A payroll handoff is paid when payroll is done." />
        {paid.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">Nothing paid yet.</p> : <ul className="divide-y divide-slate-200">{paid.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span>{r.reportNumber} · {r.title}<span className="block text-xs text-slate-500">{r.paymentMethod ?? '—'}{r.paidDate ? ` · paid ${r.paidDate}` : ' · in payroll'}</span></span><span className="flex items-center gap-3"><span className="tabular-nums">{money(r.total, r.currency)}</span><ExpenseBadge status={r.status} /></span></li>)}</ul>}
      </Card>
      {newTravel && <NewTravelModal policies={d.travelPolicies} onClose={() => setNewTravel(false)} onCreated={(id) => { setNewTravel(false); setOpen('travel', id); }} />}
      {newReport && <NewReportModal policies={d.policies} travel={newReport.travel} onClose={() => setNewReport(null)} onCreated={(id) => { setNewReport(null); setOpen('report', id); }} />}
      {openTravel && <TravelModal id={openTravel} onClose={() => setOpen('travel', null)} onCreateReport={canSubmit ? (t) => { setOpen('travel', null); setNewReport({ travel: t }); } : undefined} />}
      {openReport && <ReportModal id={openReport} onClose={() => setOpen('report', null)} />}
      {reviewing && <ReviewModal kind={reviewing.kind} id={reviewing.id} onClose={() => setReviewing(null)} />}
    </div>
  );
}
