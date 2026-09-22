import { useEffect, useMemo, useState } from 'react';
import { Plus, Star } from 'lucide-react';
import { PERMISSIONS, WEEKDAYS, type HolidayDto, type WorkCalendarDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { errorMessage, RowActions, useStatusConfirm } from '@/features/organization/shared';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { useCalendarExtras, useCalendars, useHolidays, useResourceMutations } from './leave-settings.api';

export function CalendarsPage() {
  const canManage = usePermission(PERMISSIONS.CALENDAR_MANAGE);
  const list = useCalendars();
  const m = useResourceMutations<WorkCalendarDto>('/calendars');
  const extras = useCalendarExtras();
  const toast = useToast();
  const confirm = useStatusConfirm('calendar', m);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; row: WorkCalendarDto | null }>({ open: false, row: null });
  const selected = useMemo(() => list.data?.data.find((c) => c.id === selectedId) ?? list.data?.data[0] ?? null, [list.data, selectedId]);

  const setDefault = async (c: WorkCalendarDto, clear = false) => {
    try { await extras.setDefault.mutateAsync({ organizationId: c.organization.id, calendarId: clear ? null : c.id }); toast.success(clear ? 'Default calendar cleared' : `${c.code} is now the default for ${c.organization.name}`); }
    catch (e) { toast.error('Could not set default', errorMessage(e)); }
  };
  const columns: Column<WorkCalendarDto>[] = [
    { key: 'org', header: 'Organization', render: (c) => c.organization.name },
    { key: 'code', header: 'Code', render: (c) => <span className="font-mono text-xs">{c.code}</span> },
    { key: 'name', header: 'Name', hideBelow: 'sm', render: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
    { key: 'days', header: 'Working days', hideBelow: 'md', render: (c) => <span className="text-xs text-slate-600">{c.workingDays.join(' ')}</span> },
    { key: 'default', header: 'Default', render: (c) => (c.isDefault ? <StatusBadge status="DEFAULT" tone="info" /> : <span className="text-slate-300">—</span>) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage ? [{ key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (c: WorkCalendarDto) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {!c.isDefault && c.isActive && <Button variant="ghost" size="sm" title="Set as organization default" aria-label="Set default" onClick={() => setDefault(c)}><Star className="h-4 w-4" /></Button>}
        <RowActions isActive={c.isActive} onEdit={() => setForm({ open: true, row: c })} onToggle={() => confirm.ask({ id: c.id, label: c.name, isActive: c.isActive })} />
      </div>) }] : []),
  ];
  return (
    <>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_420px]">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 p-4">
            <p className="text-sm text-slate-500">Shared work calendars — used by Leave now and Attendance later. Select a row to manage its holidays.</p>
            {canManage && <Button onClick={() => setForm({ open: true, row: null })}><Plus className="h-4 w-4" /> New calendar</Button>}
          </div>
          {list.isError && <Alert className="m-4">Could not load calendars.</Alert>}
          <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} onRowClick={(c) => setSelectedId(c.id)} emptyTitle="No calendars" emptyDescription="Create a Mon–Fri calendar and set it as the organization default." />
        </Card>
        <HolidaysPanel calendar={selected} canManage={canManage} onClearDefault={selected?.isDefault ? () => setDefault(selected, true) : undefined} />
      </div>
      {canManage && <CalendarFormModal open={form.open} row={form.row} onClose={() => setForm({ open: false, row: null })} />}
      {confirm.dialog}
    </>
  );
}

function HolidaysPanel({ calendar, canManage, onClearDefault }: { calendar: WorkCalendarDto | null; canManage: boolean; onClearDefault?: () => void }) {
  const year = new Date().getFullYear();
  const [y, setY] = useState(year);
  const holidays = useHolidays(calendar?.id, y);
  const extras = useCalendarExtras();
  const toast = useToast();
  const [draft, setDraft] = useState({ date: '', name: '' });
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    if (!calendar) return; setErr(null);
    try { await extras.createHoliday.mutateAsync({ calendarId: calendar.id, input: draft }); setDraft({ date: '', name: '' }); toast.success('Holiday added'); } catch (e) { setErr(errorMessage(e)); }
  };
  const columns: Column<HolidayDto>[] = [
    { key: 'date', header: 'Date', render: (h) => <span className="font-mono text-xs">{h.date}</span> },
    { key: 'name', header: 'Name', render: (h) => h.name },
    { key: 'status', header: 'Status', render: (h) => <StatusBadge status={h.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage ? [{ key: 'a', header: '', className: 'text-right', render: (h: HolidayDto) => <Button variant="ghost" size="sm" onClick={() => extras.holidayActive.mutateAsync({ id: h.id, active: !h.isActive }).catch((e) => toast.error('Failed', errorMessage(e)))}>{h.isActive ? 'Deactivate' : 'Activate'}</Button> }] : []),
  ];
  return (
    <Card>
      <CardHeader title={calendar ? `${calendar.code} · holidays ${y}` : 'Holidays'} description={calendar ? `${calendar.organization.name} · ${calendar.workingDays.join(', ')}${calendar.isDefault ? ' · organization default' : ''}` : 'Select a calendar'} />
      {calendar && (
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <Select options={[year - 1, year, year + 1, year + 2].map((n) => ({ value: String(n), label: String(n) }))} value={String(y)} onChange={(e) => setY(Number(e.target.value))} className="w-28" />
            {onClearDefault && canManage && <Button variant="secondary" size="sm" onClick={onClearDefault}>Clear default</Button>}
          </div>
          {canManage && (
            <div className="flex flex-col gap-2 rounded-md border border-dashed border-slate-300 p-3 sm:flex-row sm:items-end">
              <Input label="Date" type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
              <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Songkran" />
              <Button onClick={add} loading={extras.createHoliday.isPending}><Plus className="h-4 w-4" /> Add</Button>
            </div>
          )}
          {err && <Alert>{err}</Alert>}
          <DataTable columns={columns} rows={holidays.data ?? []} rowKey={(h) => h.id} loading={holidays.isLoading} emptyTitle="No holidays this year" />
        </div>
      )}
    </Card>
  );
}

function CalendarFormModal({ open, row, onClose }: { open: boolean; row: WorkCalendarDto | null; onClose: () => void }) {
  const m = useResourceMutations<WorkCalendarDto>('/calendars');
  const orgs = useOrganizationOptions();
  const toast = useToast();
  const [v, setV] = useState({ organizationId: '', code: '', name: '', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] as string[] });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setV({ organizationId: row?.organization.id ?? '', code: row?.code ?? '', name: row?.name ?? '', workingDays: row?.workingDays ?? ['MON', 'TUE', 'WED', 'THU', 'FRI'] }); } }, [open, row]);
  const toggle = (d: string, on: boolean) => setV((p) => ({ ...p, workingDays: on ? [...p.workingDays, d] : p.workingDays.filter((x) => x !== d) }));
  const submit = async () => {
    setErr(null);
    try {
      if (row) await m.update.mutateAsync({ id: row.id, input: { code: v.code, name: v.name, workingDays: v.workingDays } }); else await m.create.mutateAsync(v);
      toast.success(row ? 'Calendar updated' : 'Calendar created'); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const busy = m.create.isPending || m.update.isPending;
  return (
    <Modal open={open} onClose={onClose} title={row ? 'Edit calendar' : 'New calendar'} size="sm" footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy}>{row ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization" required disabled={!!row} options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Select…" value={v.organizationId} onChange={(e) => setV({ ...v, organizationId: e.target.value })} />
        <Input label="Code" required placeholder="STD" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} hint="Unique within the organization." />
        <Input label="Name" required placeholder="Standard Mon–Fri" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <fieldset><legend className="mb-2 text-sm font-medium text-slate-700">Working days</legend>
          <div className="grid grid-cols-4 gap-2">{WEEKDAYS.map((d) => <Checkbox key={d} label={d} checked={v.workingDays.includes(d)} onChange={(e) => toggle(d, e.target.checked)} />)}</div>
        </fieldset>
      </div>
    </Modal>
  );
}
