import { useState } from 'react';
import { Printer, Receipt } from 'lucide-react';
import type { PayrollResultItemDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useMyPayslip, useMyPayslips } from './payroll.api';
import { formatFactor, Money, sourceLabel } from './payroll-ui';

/**
 * The employee's own payslips — the only payroll screen an ordinary employee sees.
 *
 * Closed runs only, and only their own: both rules are the server's, this page simply shows what it is given. Every
 * amount is a decimal string formatted for reading; nothing here adds anything up.
 */
export function MyPayslipsPage() {
  const list = useMyPayslips();
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <>
      <Card>
        {list.isError && <Alert className="m-4">Could not load your payslips.</Alert>}
        {list.isLoading ? (
          <LoadingBlock />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            icon={<Receipt className="h-6 w-6" />}
            title="No payslips yet"
            description="A payslip appears here once the payroll for that month has been approved and closed."
          />
        ) : (
          <ul className="divide-y divide-slate-200">
            {(list.data ?? []).map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setOpenId(p.id)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-50 sm:px-5"
                >
                  <span>
                    <span className="block text-sm font-medium text-slate-900">{p.period.label}</span>
                    <span className="block text-xs text-slate-500">
                      {p.period.paymentDate ? `Paid ${p.period.paymentDate}` : 'Payment date not set'}
                    </span>
                  </span>
                  <Money amount={p.netPay} currency={p.currencyCode} className="shrink-0 font-semibold text-slate-900" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <PayslipModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

const ItemRows = ({ items, currency }: { items: PayrollResultItemDto[]; currency: string }) => (
  <>
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
        <Money amount={i.amount} currency={currency} className="shrink-0 text-sm text-slate-900" />
      </div>
    ))}
  </>
);

/** One payslip. Print-friendly through the browser's own print dialog — no PDF dependency was added for this. */
function PayslipModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const slip = useMyPayslip(id);
  const p = slip.data;
  return (
    <Modal
      open={!!id}
      onClose={onClose}
      title={p ? `Payslip · ${p.period.label}` : 'Payslip'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={() => window.print()} disabled={!p}><Printer className="h-4 w-4" /> Print</Button>
        </>
      }
    >
      {slip.isLoading && <LoadingBlock />}
      {slip.isError && <Alert>Could not load this payslip.</Alert>}
      {p && (
        <div id="payslip-print" className="space-y-4">
          <div className="rounded-md bg-slate-50 p-3 text-sm">
            <div className="font-medium text-slate-900">{p.employee.firstName} {p.employee.lastName}</div>
            <div className="text-xs text-slate-500">
              {p.employee.employeeCode}
              {p.employee.position && ` · ${p.employee.position}`}
              {p.employee.department && ` · ${p.employee.department}`}
            </div>
            <div className="mt-1.5 text-xs text-slate-500">
              Period {p.period.periodStart} → {p.period.periodEnd}
              {p.period.paymentDate && ` · paid ${p.period.paymentDate}`}
            </div>
          </div>

          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Earnings</h3>
            <div className="divide-y divide-slate-100"><ItemRows items={p.earnings} currency={p.currencyCode} /></div>
            <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-sm font-medium">
              <span>Gross pay</span><Money amount={p.grossPay} currency={p.currencyCode} />
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Deductions</h3>
            <div className="divide-y divide-slate-100"><ItemRows items={p.deductions} currency={p.currencyCode} /></div>
            <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-sm font-medium">
              <span>Total deductions</span><Money amount={p.totalDeductions} currency={p.currencyCode} />
            </div>
          </section>

          <div className="flex items-center justify-between rounded-md bg-brand-50 px-3 py-2.5">
            <span className="text-sm font-semibold text-brand-900">Net pay</span>
            <Money amount={p.netPay} currency={p.currencyCode} className="text-base font-semibold text-brand-900" />
          </div>

          <p className="text-xs leading-relaxed text-slate-500">{p.notice}</p>
        </div>
      )}
    </Modal>
  );
}
