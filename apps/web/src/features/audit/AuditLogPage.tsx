import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, Search, X } from 'lucide-react';
import { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_MODULE_LABELS, PERMISSIONS, auditActionLabel, type AuditLogListItem } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDateTime } from '@/lib/format';
import { useAuditLogs, useUserSearch } from './audit.api';
import { AuditDetailModal } from './AuditDetailModal';

const PAGE_SIZE = 25;
const RECORD_TYPES = ['User', 'Role', 'Organization', 'Department', 'Job', 'Position', 'Employee'];

/** Local calendar day → UTC ISO bounds. dateFrom inclusive (start of day), dateTo exclusive (start of the next day). */
function dayRangeToIso(from: string, to: string) {
  const dateFrom = from ? new Date(`${from}T00:00:00`).toISOString() : undefined;
  const dateTo = to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined;
  return { dateFrom, dateTo };
}

interface Filters { from: string; to: string; userId: string; userLabel: string; module: string; action: string; recordType: string; recordId: string }
const EMPTY: Filters = { from: '', to: '', userId: '', userLabel: '', module: '', action: '', recordType: '', recordId: '' };

export function AuditLogPage() {
  const [params, setParams] = useSearchParams();
  // applied filters live in the URL (reload / back button keep them); the form is a draft until "Apply"
  const applied = useMemo<Filters>(() => ({ ...EMPTY, ...Object.fromEntries([...params.entries()].filter(([k]) => k in EMPTY)) }), [params]);
  const page = Number(params.get('page') ?? '1') || 1;
  const [draft, setDraft] = useState<Filters>(applied);
  useEffect(() => setDraft(applied), [applied]);

  const { dateFrom, dateTo } = dayRangeToIso(applied.from, applied.to);
  const logs = useAuditLogs({ page, pageSize: PAGE_SIZE, userId: applied.userId, module: applied.module, action: applied.action, recordType: applied.recordType, recordId: applied.recordId, dateFrom, dateTo });
  const [detailId, setDetailId] = useState<string | null>(null);

  const apply = () => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) if (v) next.set(k, v);
    setParams(next);
  };
  const clear = () => { setDraft(EMPTY); setParams(new URLSearchParams()); };
  const goPage = (p: number) => { const next = new URLSearchParams(params); next.set('page', String(p)); setParams(next); };

  const columns: Column<AuditLogListItem>[] = [
    { key: 'time', header: 'Time', render: (r) => <span title={r.createdAt} className="whitespace-nowrap text-slate-700">{formatDateTime(r.createdAt)}</span> },
    { key: 'actor', header: 'Actor', render: (r) => (r.actor ? <span className="break-all">{r.actor.email}</span> : <span className="italic text-slate-500">System</span>) },
    { key: 'module', header: 'Module', hideBelow: 'md', render: (r) => AUDIT_MODULE_LABELS[r.module] ?? r.module },
    { key: 'action', header: 'Action', render: (r) => <span className="font-medium text-slate-900">{auditActionLabel(r.action)}</span> },
    { key: 'record', header: 'Record', render: (r) => <span>{r.recordType}{r.recordId && <span className="ml-1 hidden font-mono text-xs text-slate-400 sm:inline">{r.recordId.slice(0, 10)}…</span>}</span> },
    { key: 'changes', header: 'Changes', hideBelow: 'lg', render: (r) => (r.hasChanges ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">yes</span> : <span className="text-slate-400">—</span>) },
    { key: 'ip', header: 'IP', hideBelow: 'lg', render: (r) => <span className="font-mono text-xs text-slate-500">{r.ipAddress ?? '—'}</span> },
    { key: 'view', header: <span className="sr-only">View</span>, className: 'text-right', render: (r) => <Button variant="ghost" size="sm" onClick={() => setDetailId(r.id)} aria-label="View"><Eye className="h-4 w-4" /></Button> },
  ];

  return (
    <>
      <PageHeader title="Audit logs" description="Who changed what, and when. Append-only — entries can be viewed but never edited or deleted." />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Input label="From" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          <Input label="To" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <ActorFilter value={draft.userId} label={draft.userLabel} onChange={(userId, userLabel) => setDraft({ ...draft, userId, userLabel })} />
          <Select label="Module" options={AUDIT_MODULES.map((m) => ({ value: m, label: AUDIT_MODULE_LABELS[m] ?? m }))} placeholder="All modules" value={draft.module} onChange={(e) => setDraft({ ...draft, module: e.target.value })} />
          <Select label="Action" options={Object.values(AUDIT_ACTIONS).map((a) => ({ value: a, label: auditActionLabel(a) }))} placeholder="All actions" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
          <Select label="Record type" options={RECORD_TYPES.map((t) => ({ value: t, label: t }))} placeholder="All record types" value={draft.recordType} onChange={(e) => setDraft({ ...draft, recordType: e.target.value })} />
          <Input label="Record ID" placeholder="exact id" value={draft.recordId} onChange={(e) => setDraft({ ...draft, recordId: e.target.value })} />
          <div className="flex items-end gap-2">
            <Button onClick={apply}><Search className="h-4 w-4" /> Apply</Button>
            <Button variant="secondary" onClick={clear}><X className="h-4 w-4" /> Clear</Button>
          </div>
        </div>
        {logs.isError && <Alert className="m-4">Could not load audit logs.</Alert>}
        <DataTable columns={columns} rows={logs.data?.data ?? []} rowKey={(r) => r.id} loading={logs.isLoading} onRowClick={(r) => setDetailId(r.id)} emptyTitle="No audit entries" emptyDescription="No events match these filters." />
        {logs.data?.meta && <Pagination {...logs.data.meta} onPageChange={goPage} />}
      </Card>
      <AuditDetailModal id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

/** Actor picker: server-side user search (needs users.view); otherwise a plain user-id input. */
function ActorFilter({ value, label, onChange }: { value: string; label: string; onChange: (userId: string, label: string) => void }) {
  const canSearch = usePermission(PERMISSIONS.USERS_VIEW);
  const [term, setTerm] = useState('');
  const debounced = useDebounce(term, 250);
  const users = useUserSearch(debounced, canSearch && debounced.length > 0);
  if (!canSearch) return <Input label="Actor (user id)" value={value} onChange={(e) => onChange(e.target.value, '')} placeholder="user id" />;
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-slate-700">Actor</label>
      {value ? (
        <div className="flex h-9 items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 text-sm">
          <span className="truncate">{label || value}</span>
          <button onClick={() => onChange('', '')} className="text-slate-400 hover:text-slate-700" aria-label="Clear actor"><X className="h-4 w-4" /></button>
        </div>
      ) : (
        <div className="relative">
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search user email…" className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          {debounced && (users.data?.length ?? 0) > 0 && (
            <ul className="absolute z-20 mt-1 w-full rounded-md border border-slate-200 bg-white py-1 shadow-lg">
              {users.data!.map((u) => (
                <li key={u.id}><button onClick={() => { onChange(u.id, u.email); setTerm(''); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50">{u.email}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
