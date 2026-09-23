import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatLeaveUnits, type LeaveReportOverviewDto } from '@hr/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { useLeaveReport, useLeaveReportOptions } from './leave.api';
import { formatBusinessDate, leaveErrorMessage } from './leave-ui';

type Filters = { from: string; to: string; leaveTypeId: string; organizationId: string; departmentId: string };
const defaultFilters = (): Filters => {
  const year = new Date().getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31`, leaveTypeId: '', organizationId: '', departmentId: '' };
};

/**
 * Leave reports: aggregates of the requests this user can already read (same `leave.view` + data scope as the lists).
 * Every number comes from the server; the page only renders. Figures are attributed by request START DATE and exclude
 * drafts — the wording on screen says so, because a request spanning a month boundary counts in its start month.
 */
export function ReportsPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [applied, setApplied] = useState<Filters>(defaultFilters);
  const options = useLeaveReportOptions();
  const report = useLeaveReport(applied);
  const navigate = useNavigate();
  const set = (key: keyof Filters, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const data = report.data as LeaveReportOverviewDto | undefined;
  const showOrganization = user?.dataScope === 'ALL' && (options.data?.organizations.length ?? 0) > 1;

  return (
    <div className="space-y-5">
      <Card>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-6">
          <Input label="From" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          <Input label="To" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} />
          <Select label="Leave type" placeholder="All leave types" value={filters.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)}
            options={(options.data?.leaveTypes ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          <Select label="Department" placeholder="All departments" value={filters.departmentId} onChange={(e) => set('departmentId', e.target.value)}
            options={(options.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} />
          {showOrganization && (
            <Select label="Organization" placeholder="All organizations" value={filters.organizationId} onChange={(e) => set('organizationId', e.target.value)}
              options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} />
          )}
          <div className="flex items-end gap-2">
            <Button className="flex-1" onClick={() => setApplied(filters)} loading={report.isFetching}>Apply</Button>
            <Button variant="secondary" onClick={() => { const d = defaultFilters(); setFilters(d); setApplied(d); }}>Reset</Button>
          </div>
        </div>
      </Card>

      {report.isError && <Alert>{leaveErrorMessage(report.error, 'Could not load the leave report.')}</Alert>}
      {report.isLoading && <div className="flex justify-center py-16"><Spinner /></div>}

      {data && (
        <>
          <p className="text-xs text-slate-500">
            {formatBusinessDate(data.period.from)} → {formatBusinessDate(data.period.to)} · requests are counted in the period containing their <strong>start date</strong>, using the days recorded when they were submitted. Drafts are excluded.
          </p>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Submitted requests', value: String(data.summary.submittedRequests), hint: `${data.summary.approvedRequests} approved · ${data.summary.rejectedRequests} rejected · ${data.summary.cancelledRequests} cancelled` },
              { label: 'Approved days', value: formatLeaveUnits(data.summary.approvedUnits), hint: `${data.summary.approvedRequests} request(s)` },
              { label: 'Pending requests', value: String(data.summary.pendingRequests), hint: 'Waiting for a decision', to: '/hrm/leave/requests?status=PENDING' },
              { label: 'Pending days', value: formatLeaveUnits(data.summary.pendingUnits), hint: 'Reserved, not yet approved' },
            ].map((kpi) => (
              <Card key={kpi.label} className={cn('p-4', kpi.to && user?.dataScope === 'ALL' && 'cursor-pointer hover:border-brand-300')} onClick={kpi.to && user?.dataScope === 'ALL' ? () => navigate(kpi.to!) : undefined}>
                <div className="text-xs uppercase tracking-wide text-slate-500">{kpi.label}</div>
                <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{kpi.value}</div>
                <div className="mt-1 text-xs text-slate-500">{kpi.hint}</div>
              </Card>
            ))}
          </section>

          {data.summary.submittedRequests === 0 ? (
            <Card><EmptyState title="No leave activity for this period" description="No submitted leave requests start within the selected dates." /></Card>
          ) : (
            <>
              <section className="grid gap-4 lg:grid-cols-2">
                <Card className="p-4">
                  <h2 className="text-sm font-semibold text-slate-900">Monthly trend</h2>
                  <p className="mb-3 text-xs text-slate-500">Approved days per month (by start date)</p>
                  <TrendBars trend={data.trend} />
                </Card>

                <Card className="p-4">
                  <h2 className="text-sm font-semibold text-slate-900">Pending aging</h2>
                  <p className="mb-3 text-xs text-slate-500">How long pending requests have been waiting since submission</p>
                  <ul className="space-y-2">
                    {data.pendingAging.map((b) => (
                      <li key={b.bucket} className="flex items-center gap-3">
                        <span className="w-20 shrink-0 text-sm text-slate-600">{b.label}</span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <span className="block h-full rounded-full bg-amber-400" style={{ width: `${pct(b.count, Math.max(...data.pendingAging.map((x) => x.count), 1))}%` }} />
                        </span>
                        <span className="w-8 shrink-0 text-right text-sm font-medium tabular-nums text-slate-900">{b.count}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>

              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-slate-900">By leave type</h2>
                <BreakdownTable
                  rows={data.byLeaveType.map((t) => ({ key: t.leaveTypeId, name: `${t.name}`, sub: t.code, submitted: t.submittedRequests, approvedUnits: t.approvedUnits, pendingUnits: t.pendingUnits }))}
                />
              </Card>

              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-slate-900">By department</h2>
                <p className="mb-3 text-xs text-slate-500">The department recorded on each request when it was submitted, so transfers do not rewrite history.</p>
                <BreakdownTable
                  rows={data.byDepartment.map((d) => ({ key: d.departmentId ?? 'unassigned', name: d.departmentName, sub: null, submitted: d.submittedRequests, approvedUnits: d.approvedUnits, pendingUnits: d.pendingUnits }))}
                />
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

const pct = (value: number, max: number) => (max <= 0 ? 0 : Math.round((value / max) * 100));

/** Dependency-free CSS bars — exact numbers stay readable next to each bar. */
function TrendBars({ trend }: { trend: LeaveReportOverviewDto['trend'] }) {
  const max = Math.max(...trend.map((t) => t.approvedUnits), 1);
  return (
    <ul className="space-y-1.5">
      {trend.map((t) => (
        <li key={t.month} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-xs tabular-nums text-slate-500">{t.month}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            <span className="block h-full rounded-full bg-brand-500" style={{ width: `${pct(t.approvedUnits, max)}%` }} />
          </span>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-700">{formatLeaveUnits(t.approvedUnits)} d</span>
          <span className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-slate-400 sm:block">{t.submittedRequests} req.</span>
        </li>
      ))}
    </ul>
  );
}

function BreakdownTable({ rows }: { rows: { key: string; name: string; sub: string | null; submitted: number; approvedUnits: number; pendingUnits: number }[] }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-slate-500">Nothing to show for this period.</p>;
  const max = Math.max(...rows.map((r) => r.approvedUnits), 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 font-medium">Name</th>
            <th className="py-2 text-right font-medium">Requests</th>
            <th className="py-2 text-right font-medium">Approved days</th>
            <th className="py-2 text-right font-medium">Pending days</th>
            <th className="hidden py-2 pl-4 font-medium sm:table-cell">Share of approved days</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-2">
                <span className="font-medium text-slate-900">{r.name}</span>
                {r.sub && <span className="ml-2 font-mono text-[11px] text-slate-400">{r.sub}</span>}
              </td>
              <td className="py-2 text-right tabular-nums text-slate-700">{r.submitted}</td>
              <td className="py-2 text-right font-medium tabular-nums text-slate-900">{formatLeaveUnits(r.approvedUnits)}</td>
              <td className="py-2 text-right tabular-nums text-slate-700">{formatLeaveUnits(r.pendingUnits)}</td>
              <td className="hidden py-2 pl-4 sm:table-cell">
                <span className="block h-2 overflow-hidden rounded-full bg-slate-100">
                  <span className="block h-full rounded-full bg-brand-500" style={{ width: `${pct(r.approvedUnits, max)}%` }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
