import { useEffect, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { isOvernightShift, type ShiftDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useToast } from '@/components/ui/Toast';
import { ApiClientError } from '@/lib/api-client';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { useAttendanceMutations, useShifts } from './attendance.api';
import { formatMinutes } from './attendance-ui';

const PAGE_SIZE = 20;

/** Shift master data. Everything derived from the times (overnight, required minutes) comes from the server. */
export function ShiftsPage() {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ open: boolean; shift: ShiftDto | null }>({ open: false, shift: null });
  const shifts = useShifts({ page, pageSize: PAGE_SIZE });

  const columns: Column<ShiftDto>[] = [
    { key: 'code', header: 'Code', render: (s) => <span className="font-medium text-slate-900">{s.code}</span> },
    { key: 'name', header: 'Name', render: (s) => s.name },
    { key: 'org', header: 'Organization', hideBelow: 'md', render: (s) => s.organization?.name ?? '—' },
    {
      key: 'time',
      header: 'Hours',
      render: (s) => (
        <span>
          {s.startTime}–{s.endTime}
          {s.isOvernight && <span className="ml-1 text-xs text-amber-700">+1 day</span>}
        </span>
      ),
    },
    { key: 'break', header: 'Break', hideBelow: 'lg', render: (s) => formatMinutes(s.breakMinutes) },
    { key: 'required', header: 'Required', hideBelow: 'sm', render: (s) => formatMinutes(s.requiredMinutes) },
    { key: 'grace', header: 'Grace', hideBelow: 'lg', render: (s) => `${s.lateGraceMinutes} / ${s.earlyLeaveGraceMinutes} min` },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right',
      render: (s) => (
        <Button variant="ghost" size="sm" onClick={() => setEditing({ open: true, shift: s })} aria-label={`Edit ${s.code}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setEditing({ open: true, shift: null })}><Plus className="h-4 w-4" /> Add shift</Button>
      </div>
      <Card>
        {shifts.isError && <Alert className="m-4">Could not load shifts.</Alert>}
        <DataTable
          columns={columns}
          rows={shifts.data?.data ?? []}
          rowKey={(s) => s.id}
          loading={shifts.isLoading}
          emptyTitle="No shifts yet"
          emptyDescription="A shift says when the day starts and ends, how long the break is, and how much lateness is forgiven."
        />
        {shifts.data?.meta && <Pagination page={shifts.data.meta.page} pageSize={shifts.data.meta.pageSize} total={shifts.data.meta.total} onPageChange={setPage} />}
      </Card>
      <ShiftFormModal open={editing.open} shift={editing.shift} onClose={() => setEditing({ open: false, shift: null })} />
    </>
  );
}

function ShiftFormModal({ open, shift, onClose }: { open: boolean; shift: ShiftDto | null; onClose: () => void }) {
  const { createShift, updateShift } = useAttendanceMutations();
  const organizations = useOrganizationOptions();
  const toast = useToast();
  const [form, setForm] = useState({ organizationId: '', code: '', name: '', startTime: '08:00', endTime: '17:00', breakMinutes: 60, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10, isActive: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      shift
        ? {
            organizationId: shift.organization?.id ?? '', code: shift.code, name: shift.name,
            startTime: shift.startTime, endTime: shift.endTime, breakMinutes: shift.breakMinutes,
            lateGraceMinutes: shift.lateGraceMinutes, earlyLeaveGraceMinutes: shift.earlyLeaveGraceMinutes, isActive: shift.isActive,
          }
        : { organizationId: '', code: '', name: '', startTime: '08:00', endTime: '17:00', breakMinutes: 60, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10, isActive: true },
    );
  }, [open, shift]);

  const overnight = form.startTime && form.endTime && form.startTime !== form.endTime && isOvernightShift(form.startTime, form.endTime);

  const submit = async () => {
    setError(null);
    try {
      if (shift) {
        await updateShift.mutateAsync({
          id: shift.id,
          input: { name: form.name, startTime: form.startTime, endTime: form.endTime, breakMinutes: form.breakMinutes, lateGraceMinutes: form.lateGraceMinutes, earlyLeaveGraceMinutes: form.earlyLeaveGraceMinutes, isActive: form.isActive },
        });
        toast.success('Shift updated');
      } else {
        await createShift.mutateAsync({
          organizationId: form.organizationId, code: form.code, name: form.name,
          startTime: form.startTime, endTime: form.endTime, breakMinutes: form.breakMinutes,
          lateGraceMinutes: form.lateGraceMinutes, earlyLeaveGraceMinutes: form.earlyLeaveGraceMinutes,
        });
        toast.success('Shift created');
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={shift ? 'Edit shift' : 'Add shift'}
      description={shift ? shift.code : undefined}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={createShift.isPending || updateShift.isPending}>{shift ? 'Save' : 'Create'}</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {!shift && (
          <>
            <Select
              label="Organization"
              options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
              placeholder="Choose an organization"
              value={form.organizationId}
              onChange={(e) => setForm({ ...form, organizationId: e.target.value })}
            />
            <Input label="Code" required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} hint="Unique within the organization, e.g. D1" />
          </>
        )}
        <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Starts" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          <Input label="Ends" type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} hint={overnight ? 'Next day (overnight shift)' : undefined} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Break (min)" type="number" min={0} value={form.breakMinutes} onChange={(e) => setForm({ ...form, breakMinutes: Number(e.target.value) })} />
          <Input label="Late grace" type="number" min={0} value={form.lateGraceMinutes} onChange={(e) => setForm({ ...form, lateGraceMinutes: Number(e.target.value) })} />
          <Input label="Early grace" type="number" min={0} value={form.earlyLeaveGraceMinutes} onChange={(e) => setForm({ ...form, earlyLeaveGraceMinutes: Number(e.target.value) })} />
        </div>
        {shift && <Checkbox label="Active" description="Inactive shifts cannot be assigned to new schedules." checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />}
        <p className="text-xs text-slate-500">
          Grace decides whether a day counts as late — the minutes recorded are always the real ones. Changing a shift
          does not rewrite attendance that was already calculated against it.
        </p>
      </div>
    </Modal>
  );
}
