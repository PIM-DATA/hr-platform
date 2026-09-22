import { useEffect, useState } from 'react';
import { Eye, Plus, SlidersHorizontal } from 'lucide-react';
import { availableUnits, type EntitlementDto, type LeaveEmployeeOptionDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useToast } from '@/components/ui/Toast';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDateTime } from '@/lib/format';
import { errorMessage } from '@/features/organization/shared';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { useEntitlement, useEntitlementLedger, useEntitlementMutations, useEntitlementPreview, useEntitlements, useLeaveEmployeeOptions, useLeaveTypeOptions } from './leave-settings.api';

// Leave units are half-day precise; the shared formatNumber rounds to whole numbers.
const formatNumber = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
const units = (n: number) => (n === 0 ? '0' : `${n > 0 ? '+' : ''}${formatNumber(n)}`);
const year = new Date().getFullYear();

export function EntitlementsPage() {
  const orgs = useOrganizationOptions();
  const types = useLeaveTypeOptions();
  const [search, setSearch] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [yr, setYr] = useState(String(year));
  const [page, setPage] = useState(1);
  const list = useEntitlements({ search: useDebounce(search), organizationId, leaveTypeId, year: yr, page, pageSize: 20 });
  const [addOpen, setAddOpen] = useState(false);
  const [adjustFor, setAdjustFor] = useState<EntitlementDto | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const columns: Column<EntitlementDto>[] = [
    { key: 'emp', header: 'Employee', render: (e) => <div><div className="font-medium text-slate-900">{e.employee.firstName} {e.employee.lastName}</div><div className="text-xs text-slate-400">{e.employee.employeeCode} · {e.employee.organization.name}</div></div> },
    { key: 'type', header: 'Leave type', render: (e) => e.leaveType.name },
    { key: 'period', header: 'Period', hideBelow: 'md', render: (e) => <span className="whitespace-nowrap text-slate-600">{e.periodStart} → {e.periodEnd}</span> },
    { key: 'policy', header: 'Policy', hideBelow: 'lg', render: (e) => <span className="text-slate-600">{e.policy.name}{!e.policy.isActive && <span className="ml-1 text-xs text-slate-400">(inactive)</span>}</span> },
    { key: 'g', header: 'Granted', hideBelow: 'sm', className: 'text-right', render: (e) => <span className="tabular-nums">{formatNumber(e.granted)}</span> },
    { key: 'cf', header: 'Carry fwd', hideBelow: 'lg', className: 'text-right', render: (e) => <span className="tabular-nums">{formatNumber(e.carriedForward)}</span> },
    { key: 'adj', header: 'Adj.', hideBelow: 'lg', className: 'text-right', render: (e) => <span className="tabular-nums">{units(e.adjustment)}</span> },
    { key: 'res', header: 'Reserved', hideBelow: 'lg', className: 'text-right', render: (e) => <span className="tabular-nums">{formatNumber(e.reserved)}</span> },
    { key: 'used', header: 'Used', hideBelow: 'md', className: 'text-right', render: (e) => <span className="tabular-nums">{formatNumber(e.used)}</span> },
    { key: 'avail', header: 'Available', className: 'text-right', render: (e) => <span className={`font-semibold tabular-nums ${e.available < 0 ? 'text-red-600' : 'text-slate-900'}`}>{formatNumber(e.available)}</span> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (e) => (
      <div className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
        <Button variant="ghost" size="sm" aria-label="Adjust" title="Adjust balance" onClick={() => setAdjustFor(e)}><SlidersHorizontal className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" aria-label="Detail" title="Ledger" onClick={() => setDetailId(e.id)}><Eye className="h-4 w-4" /></Button>
      </div>) },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-5">
          <Input placeholder="Search employee…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <Select options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setPage(1); }} />
          <Select options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="All leave types" value={leaveTypeId} onChange={(e) => { setLeaveTypeId(e.target.value); setPage(1); }} />
          <Select options={[year - 1, year, year + 1].map((n) => ({ value: String(n), label: String(n) }))} placeholder="All years" value={yr} onChange={(e) => { setYr(e.target.value); setPage(1); }} />
          <div className="flex justify-end"><Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add entitlement</Button></div>
        </div>
        {list.isError && <Alert className="m-4">Could not load entitlements.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(e) => e.id} loading={list.isLoading} onRowClick={(e) => setDetailId(e.id)} emptyTitle="No entitlements" emptyDescription="Generate an entitlement for one employee, leave type and period." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <AddEntitlementModal open={addOpen} onClose={() => setAddOpen(false)} />
      <AdjustModal entitlement={adjustFor} onClose={() => setAdjustFor(null)} />
      <EntitlementDetailModal id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

function AddEntitlementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useEntitlementMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const types = useLeaveTypeOptions();
  const [orgFilter, setOrgFilter] = useState('');
  const [term, setTerm] = useState('');
  const debounced = useDebounce(term, 250);
  const employees = useLeaveEmployeeOptions(debounced, orgFilter || undefined, open && !!debounced);
  const [employee, setEmployee] = useState<LeaveEmployeeOptionDto | null>(null);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [periodStart, setPeriodStart] = useState(`${year}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(`${year}-12-31`);
  const [err, setErr] = useState<string | null>(null);
  const canPreview = !!employee && !!leaveTypeId && /^\d{4}-\d{2}-\d{2}$/.test(periodStart);
  const preview = useEntitlementPreview({ employeeId: employee?.id ?? '', leaveTypeId, periodStart }, open && canPreview);
  useEffect(() => { if (open) { setErr(null); setEmployee(null); setTerm(''); setLeaveTypeId(''); setPeriodStart(`${year}-01-01`); setPeriodEnd(`${year}-12-31`); } }, [open]);
  const submit = async () => {
    setErr(null);
    try { const e = await m.generate.mutateAsync({ employeeId: employee?.id, leaveTypeId, periodStart, periodEnd }); toast.success('Entitlement generated', `${e.employee.employeeCode} · ${e.leaveType.name} · granted ${e.granted}`); onClose(); }
    catch (x) { setErr(errorMessage(x)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add entitlement" description="One employee, one leave type, one period. The policy and granted units are derived by the server at the period start."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.generate.isPending} disabled={!canPreview || !preview.data}>Generate</Button></>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization filter" options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={orgFilter} onChange={(e) => { setOrgFilter(e.target.value); setEmployee(null); }} />
        {employee ? (
          <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm"><span><span className="font-medium">{employee.firstName} {employee.lastName}</span> <span className="font-mono text-xs text-slate-500">{employee.employeeCode}</span> · {employee.organization.name} · {employee.employmentType.replace('_', ' ')}</span><button className="text-xs text-slate-500" onClick={() => setEmployee(null)}>change</button></div>
        ) : (
          <div className="relative">
            <Input label="Employee" placeholder="Search by code or name…" value={term} onChange={(e) => setTerm(e.target.value)} />
            {debounced && (employees.data?.length ?? 0) > 0 && <ul className="absolute z-20 mt-1 w-full rounded-md border border-slate-200 bg-white py-1 shadow-lg">{employees.data!.map((e) => <li key={e.id}><button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50" onClick={() => { setEmployee(e); setTerm(''); }}>{e.firstName} {e.lastName} <span className="font-mono text-xs text-slate-500">{e.employeeCode}</span> <span className="text-xs text-slate-500">· {e.department.name} · {e.employmentType.replace('_', ' ')}</span></button></li>)}</ul>}
          </div>
        )}
        <Select label="Leave type" required options={(types.data ?? []).map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))} placeholder="Select…" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} />
        <div className="grid grid-cols-2 gap-3"><Input label="Period start" type="date" required value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /><Input label="Period end" type="date" required value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></div>
        {canPreview && (preview.isError ? <Alert>{errorMessage(preview.error)}</Alert> : preview.data && (
          <div className="rounded-md border border-brand-200 bg-brand-50 p-3 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Policy preview (resolved at {preview.data.periodStart})</div>
            <div className="mt-1 font-medium text-slate-900">{preview.data.policy.name}</div>
            <div className="text-xs text-slate-600">Annual units {preview.data.policy.annualUnits} · negative balance {preview.data.policy.allowNegativeBalance ? 'allowed' : 'not allowed'} · carry-forward max {preview.data.policy.carryForwardMaxUnits} · effective {preview.data.policy.effectiveFrom} → {preview.data.policy.effectiveTo ?? 'open'}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function AdjustModal({ entitlement, onClose }: { entitlement: EntitlementDto | null; onClose: () => void }) {
  const m = useEntitlementMutations();
  const toast = useToast();
  const [unitsIn, setUnitsIn] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (entitlement) { setUnitsIn(''); setNote(''); setErr(null); } }, [entitlement]);
  if (!entitlement) return null;
  const delta = Number(unitsIn) || 0;
  const after = availableUnits({ ...entitlement, adjustment: entitlement.adjustment + delta });
  const submit = async () => {
    setErr(null);
    try { await m.adjust.mutateAsync({ id: entitlement.id, input: { units: unitsIn, note } }); toast.success('Balance adjusted'); onClose(); } catch (x) { setErr(errorMessage(x)); }
  };
  const Row = ({ l, v }: { l: string; v: number }) => <div className="flex justify-between"><span className="text-slate-500">{l}</span><span className="tabular-nums">{formatNumber(v)}</span></div>;
  return (
    <Modal open onClose={onClose} title="Adjust balance" description={`${entitlement.employee.employeeCode} · ${entitlement.leaveType.name} · ${entitlement.periodStart} → ${entitlement.periodEnd}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.adjust.isPending} disabled={!unitsIn || !note}>Apply adjustment</Button></>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <div className="space-y-1 rounded-md bg-slate-50 p-3 text-sm"><Row l="Granted" v={entitlement.granted} /><Row l="Carry forward" v={entitlement.carriedForward} /><Row l="Adjustment" v={entitlement.adjustment} /><Row l="Reserved" v={entitlement.reserved} /><Row l="Used" v={entitlement.used} /><div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Available</span><span className="tabular-nums">{formatNumber(entitlement.available)}</span></div></div>
        <Input label="Adjustment (+/−, multiples of 0.5)" type="number" step={0.5} required value={unitsIn} onChange={(e) => setUnitsIn(e.target.value)} placeholder="+1 or -0.5" />
        <Input label="Reason / note" required value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. compensation for public-holiday work" />
        <div className="rounded-md border border-slate-200 p-3 text-sm"><span className="text-slate-500">Available after adjustment (preview): </span><span className={`font-semibold tabular-nums ${after < 0 ? 'text-red-600' : 'text-slate-900'}`}>{formatNumber(after)}</span>{after < 0 && !entitlement.policy.allowNegativeBalance && <span className="ml-2 text-xs text-red-600">policy does not allow a negative balance</span>}</div>
      </div>
    </Modal>
  );
}

function EntitlementDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const e = useEntitlement(id ?? undefined);
  const [page, setPage] = useState(1);
  const ledger = useEntitlementLedger(id ?? undefined, page);
  const m = useEntitlementMutations();
  const toast = useToast();
  const [cf, setCf] = useState({ units: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setPage(1); setCf({ units: '', note: '' }); setErr(null); }, [id]);
  const carry = async () => { if (!id) return; setErr(null); try { await m.carryForward.mutateAsync({ id, input: { units: cf.units, note: cf.note || null } }); toast.success('Carry-forward recorded'); setCf({ units: '', note: '' }); } catch (x) { setErr(errorMessage(x)); } };
  const d = e.data;
  return (
    <Modal open={!!id} onClose={onClose} size="lg" title={d ? `${d.employee.firstName} ${d.employee.lastName} · ${d.leaveType.name}` : 'Entitlement'} description={d ? `${d.employee.employeeCode} · ${d.periodStart} → ${d.periodEnd} · policy ${d.policy.name}${d.policy.isActive ? '' : ' (inactive)'} · resolved ${d.policyResolvedDate}` : undefined}>
      {d && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
            {[['Granted', d.granted], ['Carry fwd', d.carriedForward], ['Adjustment', d.adjustment], ['Reserved', d.reserved], ['Used', d.used], ['Available', d.available]].map(([l, v]) => (
              <div key={l as string} className={`rounded-md border p-2 ${l === 'Available' ? 'border-brand-200 bg-brand-50' : 'border-slate-200'}`}><div className="text-[11px] uppercase tracking-wide text-slate-500">{l}</div><div className={`text-lg font-semibold tabular-nums ${(v as number) < 0 ? 'text-red-600' : 'text-slate-900'}`}>{formatNumber(v as number)}</div></div>
            ))}
          </div>
          <div className="rounded-md border border-dashed border-slate-300 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Carry-forward (manual, max {d.policy.carryForwardMaxUnits} per policy)</div>
            {err && <Alert className="mb-2">{err}</Alert>}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end"><Input label="Units" type="number" step={0.5} min={0.5} value={cf.units} onChange={(ev) => setCf({ ...cf, units: ev.target.value })} /><Input label="Note" value={cf.note} onChange={(ev) => setCf({ ...cf, note: ev.target.value })} placeholder="from previous period" /><Button variant="secondary" onClick={carry} loading={m.carryForward.isPending} disabled={!cf.units}>Record</Button></div>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Ledger (newest first)</div>
            <DataTable
              columns={[
                { key: 't', header: 'Time', render: (r) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(r.createdAt)}</span> },
                { key: 'type', header: 'Type', render: (r) => <StatusBadge status={r.entryType} tone={['GRANT', 'CARRY_FORWARD'].includes(r.entryType) ? 'success' : ['RESERVE', 'USE'].includes(r.entryType) ? 'warning' : 'neutral'} /> },
                { key: 'u', header: 'Units', className: 'text-right', render: (r) => <span className={`tabular-nums ${r.units < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{units(r.units)}</span> },
                { key: 'ref', header: 'Reference', hideBelow: 'md', render: (r) => (r.referenceType ? <span className="font-mono text-xs">{r.referenceType} {r.referenceId}</span> : <span className="text-slate-300">—</span>) },
                { key: 'note', header: 'Note', hideBelow: 'sm', render: (r) => <span className="text-slate-600">{r.note ?? '—'}</span> },
                { key: 'actor', header: 'Actor', hideBelow: 'lg', render: (r) => <span className="text-xs text-slate-500">{r.actor?.email ?? 'system'}</span> },
              ]}
              rows={ledger.data?.data ?? []} rowKey={(r) => r.id} loading={ledger.isLoading} emptyTitle="No ledger entries" emptyDescription="A zero-unit policy creates no GRANT row." />
            {ledger.data?.meta && <Pagination {...ledger.data.meta} onPageChange={setPage} />}
          </div>
        </div>
      )}
    </Modal>
  );
}
