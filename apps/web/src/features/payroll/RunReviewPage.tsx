import { useState, type ReactNode } from 'react';
import { Calculator, Check, Download, Lock, RefreshCw, Send, Trash2 } from 'lucide-react';
import { PERMISSIONS, type PayrollPeriodDto, type PayrollResultDto, type PayrollResultItemDto, type PayrollRunSummaryDto } from '@hr/shared';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { errorMessage } from '@/features/organization/shared';
import {
  downloadPayrollCsv, usePayComponents, usePayrollMutations, usePayrollPeriod, usePayrollResult, usePayrollResults,
  usePayrollSummary, useReconciliation,
} from './payroll.api';
import { formatFactor, Money, RunStatusBadge, sourceLabel } from './payroll-ui';

/**
 * Reviewing one period's run: what each employee is owed, why, and the checks that must pass before anybody approves
 * it.
 *
 * Nothing on this screen calculates. Every figure — including the totals and the reconciliation verdict — is the
 * server's, because the only arithmetic anybody should trust is the arithmetic that was stored.
 */
export function RunReviewPanel({ periodId, onClose }: { periodId: string | null; onClose: () => void }) {
  const period = usePayrollPeriod(periodId);
  const p = period.data;
  const run = p?.run ?? null;
  return (
    <Modal open={!!periodId} onClose={onClose} title={p ? `Payroll ${p.label}` : 'Payroll'} description={p?.organization?.name} size="lg">
      {period.isLoading && <LoadingBlock />}
      {period.isError && <Alert>Could not load this period.</Alert>}
      {p && !run && <NoRunYet periodId={p.id} status={p.status} />}
      {p && run && <RunReview period={p} run={run} />}
    </Modal>
  );
}

function NoRunYet({ periodId, status }: { periodId: string; status: string }) {
  const canRun = usePermission(PERMISSIONS.PAYROLL_RUN);
  const m = usePayrollMutations();
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const calculate = async () => {
    setErr(null);
    try {
      await m.calculate.mutateAsync(periodId);
      toast.success('Payroll calculated');
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  return (
    <div className="space-y-3">
      {err && <Alert>{err}</Alert>}
      <p className="text-sm text-slate-600">
        This period is {status.toLowerCase()} and has not been calculated yet. Calculating reads salary, recurring
        items, approved overtime, unpaid leave and attendance for the period, and produces one result per employee.
      </p>
      {canRun && <Button onClick={calculate} loading={m.calculate.isPending}><Calculator className="h-4 w-4" /> Calculate payroll</Button>}
    </div>
  );
}

function RunReview({ period, run }: { period: PayrollPeriodDto; run: PayrollRunSummaryDto }) {
  const canRun = usePermission(PERMISSIONS.PAYROLL_RUN);
  const canManage = usePermission(PERMISSIONS.PAYROLL_MANAGE);
  const m = usePayrollMutations();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'calculate' | 'submit' | 'close' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const results = usePayrollResults(run.id, { page, pageSize: 20 });
  const reconciliation = useReconciliation(run.id);
  const editable = run.status === 'REVIEW' && !run.workflowInstanceId;

  const columns: Column<PayrollResultDto>[] = [
    { key: 'emp', header: 'Employee', render: (r) => (
      <div>
        <div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div>
        <div className="text-xs text-slate-400">{r.employee.employeeCode}{r.employee.department && ` · ${r.employee.department.name}`}</div>
      </div>
    ) },
    { key: 'gross', header: 'Gross', className: 'text-right', render: (r) => <Money amount={r.grossPay} currency={r.currencyCode} /> },
    { key: 'ded', header: 'Deductions', className: 'text-right', hideBelow: 'sm', render: (r) => <Money amount={r.totalDeductions} currency={r.currencyCode} /> },
    { key: 'net', header: 'Net', className: 'text-right', render: (r) => <Money amount={r.netPay} currency={r.currencyCode} className={r.netPay.startsWith('-') ? 'font-semibold text-red-600' : 'font-semibold text-slate-900'} /> },
  ];

  const act = async (what: 'calculate' | 'submit' | 'close') => {
    setErr(null);
    try {
      if (what === 'calculate') { await m.calculate.mutateAsync(period.id); toast.success('Payroll recalculated'); }
      if (what === 'submit') { await m.submit.mutateAsync(run.id); toast.success('Sent for approval'); }
      if (what === 'close') { await m.close.mutateAsync(run.id); toast.success('Payroll closed'); }
      setConfirm(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      {err && <Alert>{err}</Alert>}

      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge run={run} />
        <span className="text-xs text-slate-500">version {run.version}</span>
        {run.status === 'REVIEW' && run.workflowInstanceId && (
          <span className="text-xs text-slate-500">· decided on the approvals screen</span>
        )}
      </div>

      {!run.inputsCurrent && (
        <Alert>
          Attendance, leave, overtime or a salary changed after this run was calculated. It has to be recalculated
          before it can be approved.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Employees" value={String(run.employeeCount)} />
        <Figure label="Gross" value={<Money amount={run.grossTotal} currency={run.currencyCode} />} />
        <Figure label="Deductions" value={<Money amount={run.deductionTotal} currency={run.currencyCode} />} />
        <Figure label="Net" value={<Money amount={run.netTotal} currency={run.currencyCode} />} />
      </div>

      {reconciliation.data && !reconciliation.data.ok && (
        <Alert>
          <span className="font-medium">This run does not reconcile.</span>
          <ul className="mt-1 list-disc pl-4">
            {reconciliation.data.problems.map((problem) => <li key={problem}>{problem}</li>)}
            {reconciliation.data.negativeNetEmployees.map((n) => <li key={n.employeeCode}>{n.employeeCode} has a negative net pay of {n.netPay}.</li>)}
          </ul>
        </Alert>
      )}
      {reconciliation.data?.ok && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" /> Gross minus deductions equals net for every employee.</p>
      )}

      <div className="flex flex-wrap gap-2">
        {canRun && editable && (
          <Button variant="secondary" onClick={() => setConfirm('calculate')}>
            <RefreshCw className="h-4 w-4" /> Recalculate
          </Button>
        )}
        {canRun && editable && (
          <Button onClick={() => setConfirm('submit')} disabled={!run.inputsCurrent || reconciliation.data?.ok === false}>
            <Send className="h-4 w-4" /> Send for approval
          </Button>
        )}
        {canRun && run.status === 'APPROVED' && (
          <Button onClick={() => setConfirm('close')}><Lock className="h-4 w-4" /> Close payroll</Button>
        )}
        <Button variant="secondary" onClick={() => setShowSummary(true)}>Summary</Button>
        {canManage && (
          <Button variant="secondary" onClick={() => downloadPayrollCsv(run.id, period.label).catch((e) => setErr(errorMessage(e)))}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={results.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={results.isLoading}
        onRowClick={(r) => setOpenResult(r.id)}
        emptyTitle="No results"
        emptyDescription="Nobody was paid in this run."
      />
      {results.data?.meta && <Pagination {...results.data.meta} onPageChange={setPage} />}

      <ConfirmDialog
        open={confirm === 'calculate'}
        title="Recalculate payroll"
        message="Every calculated line is rebuilt from the current attendance, leave, overtime and salary. Manual adjustments are kept."
        confirmLabel="Recalculate"
        loading={m.calculate.isPending}
        error={err}
        onConfirm={() => act('calculate')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'submit'}
        title="Send for approval"
        message="The run is checked once more and then goes to the approver. While it waits, it cannot be changed."
        confirmLabel="Send"
        loading={m.submit.isPending}
        error={err}
        onConfirm={() => act('submit')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'close'}
        title="Close this payroll"
        message="Closing is final: the amounts can never be recalculated or adjusted, and payslips become visible to employees. There is no reopen."
        confirmLabel="Close payroll"
        variant="danger"
        loading={m.close.isPending}
        error={err}
        onConfirm={() => act('close')}
        onCancel={() => setConfirm(null)}
      />
      <ResultDetailModal id={openResult} editable={editable && canManage} onClose={() => setOpenResult(null)} />
      <SummaryModal runId={showSummary ? run.id : null} onClose={() => setShowSummary(false)} />
    </div>
  );
}

const Figure = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="rounded-md border border-slate-200 p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-sm font-semibold text-slate-900">{value}</div>
  </div>
);

/** One employee's result: every line, what produced it, and — while the run is in review — manual adjustments. */
function ResultDetailModal({ id, editable, onClose }: { id: string | null; editable: boolean; onClose: () => void }) {
  const result = usePayrollResult(id);
  const m = usePayrollMutations();
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = result.data;

  const remove = async (itemId: string) => {
    setErr(null);
    try { await m.removeAdjustment.mutateAsync(itemId); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={!!id} onClose={onClose} title={r ? `${r.employee.firstName} ${r.employee.lastName}` : 'Result'} description={r?.employee.employeeCode} size="lg">
      {result.isLoading && <LoadingBlock />}
      {result.isError && <Alert>Could not load this result.</Alert>}
      {err && <Alert className="mb-3">{err}</Alert>}
      {r && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-5">
            <span>Absent days<br /><span className="font-medium text-slate-900">{r.inputs.absentDays}</span></span>
            <span>Late minutes<br /><span className="font-medium text-slate-900">{r.inputs.lateMinutes}</span></span>
            <span>Unpaid leave<br /><span className="font-medium text-slate-900">{r.inputs.unpaidLeaveUnits}</span></span>
            <span>Approved OT<br /><span className="font-medium text-slate-900">{r.inputs.approvedOtMinutes} min</span></span>
            <span>Prorated days<br /><span className="font-medium text-slate-900">{r.inputs.proratedDays ?? '—'}</span></span>
          </div>

          <LineGroup title="Earnings" items={r.items.filter((i) => i.type === 'EARNING')} currency={r.currencyCode} editable={editable} onRemove={remove} />
          <LineGroup title="Deductions" items={r.items.filter((i) => i.type === 'DEDUCTION')} currency={r.currencyCode} editable={editable} onRemove={remove} />

          <div className="space-y-1 border-t border-slate-200 pt-3 text-sm">
            <div className="flex justify-between"><span className="text-slate-600">Gross pay</span><Money amount={r.grossPay} currency={r.currencyCode} /></div>
            <div className="flex justify-between"><span className="text-slate-600">Total deductions</span><Money amount={r.totalDeductions} currency={r.currencyCode} /></div>
            <div className="flex justify-between font-semibold text-slate-900"><span>Net pay</span><Money amount={r.netPay} currency={r.currencyCode} /></div>
          </div>

          {r.netPay.startsWith('-') && (
            <Alert>This employee&apos;s net pay is negative. The run cannot be approved until that is resolved.</Alert>
          )}

          {editable && (
            adding
              ? <AdjustmentForm resultId={r.id} onDone={() => setAdding(false)} />
              : <Button variant="secondary" onClick={() => setAdding(true)}>Add a manual adjustment</Button>
          )}
        </div>
      )}
    </Modal>
  );
}

function LineGroup({ title, items, currency, editable, onRemove }: {
  title: string; items: PayrollResultItemDto[]; currency: string; editable: boolean; onRemove: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="divide-y divide-slate-100">
        {items.length === 0 && <div className="py-1.5 text-sm text-slate-400">None</div>}
        {items.map((i) => (
          <div key={i.id} className="flex items-start justify-between gap-3 py-1.5">
            <span className="min-w-0">
              <span className="block text-sm text-slate-800">{i.componentName}</span>
              <span className="block text-xs text-slate-500">
                {sourceLabel(i.source)}
                {i.quantity && ` · ${formatFactor(i.quantity)}${i.rate ? ` × ${formatFactor(i.rate)}` : ''}${i.multiplier ? ` × ${formatFactor(i.multiplier)}` : ''}`}
                {i.description && ` · ${i.description}`}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Money amount={i.amount} currency={currency} className="text-sm text-slate-900" />
              {/* Only manual lines can be removed: a calculated line is the engine's and is rebuilt, never edited. A line
                  handed over by benefits or expense is an approved reimbursement and stays (Task 48). */}
              {i.sourceLinked && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600" title="Handed over by benefits or expense; it cannot be removed in payroll">{i.referenceType === 'BENEFIT_CLAIM' ? 'Benefit claim' : 'Expense report'}</span>}
              {editable && i.isManual && !i.sourceLinked && (
                <Button variant="ghost" size="sm" aria-label="Remove adjustment" title="Remove adjustment" onClick={() => onRemove(i.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AdjustmentForm({ resultId, onDone }: { resultId: string; onDone: () => void }) {
  const m = usePayrollMutations();
  const components = usePayComponents({ status: 'active', pageSize: 100 });
  const [componentId, setComponentId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    try {
      await m.addAdjustment.mutateAsync({ resultId, input: { componentId, amount, note } });
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3">
      {err && <Alert>{err}</Alert>}
      <Select
        label="Component"
        required
        options={(components.data?.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.type === 'EARNING' ? 'earning' : 'deduction'})` }))}
        placeholder="Select a component"
        value={componentId}
        onChange={(e) => setComponentId(e.target.value)}
      />
      <Input label="Amount" required inputMode="decimal" placeholder="1000.00" value={amount} onChange={(e) => setAmount(e.target.value)} hint="A positive amount. A deduction component subtracts it." />
      <Textarea label="Reason" required rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why does this adjustment exist?" />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>Cancel</Button>
        <Button onClick={submit} loading={m.addAdjustment.isPending} disabled={!componentId || !amount || note.trim().length < 3}>Add adjustment</Button>
      </div>
    </div>
  );
}

function SummaryModal({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const summary = usePayrollSummary(runId);
  const s = summary.data;
  return (
    <Modal open={!!runId} onClose={onClose} title={s ? `Summary · ${s.periodLabel}` : 'Summary'} size="lg">
      {summary.isLoading && <LoadingBlock />}
      {summary.isError && <Alert>Could not load the summary.</Alert>}
      {s && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Employees" value={String(s.employeeCount)} />
            <Figure label="Gross" value={<Money amount={s.grossTotal} currency={s.currencyCode} />} />
            <Figure label="Deductions" value={<Money amount={s.deductionTotal} currency={s.currencyCode} />} />
            <Figure label="Net" value={<Money amount={s.netTotal} currency={s.currencyCode} />} />
          </div>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">By component</h3>
            <div className="divide-y divide-slate-100">
              {s.byComponent.map((c) => (
                <div key={c.componentCode} className="flex items-center justify-between py-1.5 text-sm">
                  <span>{c.componentName} <span className="text-xs text-slate-400">· {c.employees} employee{c.employees === 1 ? '' : 's'}</span></span>
                  <Money amount={c.amount} currency={s.currencyCode} className={c.type === 'DEDUCTION' ? 'text-red-600' : 'text-slate-900'} />
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">By department</h3>
            <div className="divide-y divide-slate-100">
              {s.byDepartment.map((d) => (
                <div key={d.departmentId ?? 'none'} className="flex items-center justify-between py-1.5 text-sm">
                  <span>{d.departmentName} <span className="text-xs text-slate-400">· {d.employees} employee{d.employees === 1 ? '' : 's'}</span></span>
                  <Money amount={d.netTotal} currency={s.currencyCode} />
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
