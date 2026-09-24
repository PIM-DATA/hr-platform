import { useEffect, useState } from 'react';
import { Plus, UserPlus } from 'lucide-react';
import { PERMISSIONS, type EnrollmentDto, type SessionDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useCourses, useEnrollments, useSession, useSessions, useTrainingMutations } from './training.api';
import { EnrollmentStatusBadge, SessionStatusBadge, deliveryLabel, formatDuration, formatSessionTime } from './training-ui';

/**
 * Sessions: when a course runs, who is on it, and what came of it for each of them.
 *
 * Completing a session completes nothing for anybody — one attendee may have passed, another failed, a third not
 * turned up — so each person's outcome is recorded by hand, and a recorded outcome is final.
 */
export function SessionsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.TRAINING_MANAGE);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const sessions = useSessions({ status, page, pageSize: 20 });

  const columns: Column<SessionDto>[] = [
    { key: 'course', header: 'Course', render: (s) => <div><div className="font-medium text-slate-900">{s.course.title}</div><div className="text-xs text-slate-400">{deliveryLabel(s.course.deliveryMethod)} · {formatDuration(s.course.durationMinutes)}</div></div> },
    { key: 'when', header: 'When', render: (s) => <span className="whitespace-nowrap text-slate-600">{formatSessionTime(s.startAt, s.timezone)}</span> },
    { key: 'where', header: 'Where', hideBelow: 'md', render: (s) => s.location ?? (s.meetingUrl ? 'Online' : <span className="text-slate-400">—</span>) },
    { key: 'seats', header: 'Booked', className: 'text-right', render: (s) => <span className="tabular-nums">{s.enrolledCount}{s.capacity !== null && ` / ${s.capacity}`}</span> },
    { key: 'status', header: 'Status', render: (s) => <SessionStatusBadge status={s.status} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2">
          <Select options={['DRAFT', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ') }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Session</Button></div>}
        </div>
        {sessions.isError && <Alert className="m-4">Could not load sessions.</Alert>}
        <DataTable columns={columns} rows={sessions.data?.data ?? []} rowKey={(s) => s.id} loading={sessions.isLoading} onRowClick={(s) => setOpenId(s.id)} emptyTitle="No sessions scheduled" />
        {sessions.data?.meta && <Pagination {...sessions.data.meta} onPageChange={setPage} />}
      </Card>
      <CreateSessionModal open={creating} onClose={() => setCreating(false)} />
      <SessionDetailModal sessionId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

/** Local wall-clock inputs plus an IANA zone become UTC instants; the server stores nothing else. */
function CreateSessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useTrainingMutations();
  const toast = useToast();
  const courses = useCourses({ status: 'active', pageSize: 100 });
  const orgs = useOrganizationOptions();
  const [courseId, setCourseId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const [location, setLocation] = useState('');
  const [capacity, setCapacity] = useState('');
  const [instructorName, setInstructor] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCourseId(''); setDate(''); setLocation(''); setCapacity(''); setInstructor(''); } }, [open]);

  /** Wall-clock → instant in the chosen zone, without a date library: offset the guess by what the zone says it is. */
  const toInstant = (day: string, time: string) => {
    const guess = new Date(`${day}T${time}:00Z`);
    const inZone = new Date(guess.toLocaleString('en-US', { timeZone: timezone }));
    const inUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
    return new Date(guess.getTime() - (inZone.getTime() - inUtc.getTime())).toISOString();
  };

  const submit = async () => {
    setErr(null);
    try {
      await m.createSession.mutateAsync({
        courseId, organizationId: organizationId || null, startAt: toInstant(date, start), endAt: toInstant(date, end), timezone,
        location: location || null, capacity: capacity ? Number(capacity) : null, instructorName: instructorName || null,
      });
      toast.success('Session scheduled');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Schedule a session" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createSession.isPending} disabled={!courseId || !date}>Schedule</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Course" required options={(courses.data?.data ?? []).map((c) => ({ value: c.id, label: c.title }))} placeholder="Choose a course" value={courseId} onChange={(e) => setCourseId(e.target.value)} />
        <Select label="Organization" options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
        <div className="grid grid-cols-3 gap-3">
          <Input label="Date" required type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Starts" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <Input label="Ends" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <Input label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} hint="IANA name, e.g. Asia/Bangkok. Times above are read in this zone." />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room, or leave blank for online" />
          <Input label="Capacity" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} hint="Blank for no limit." />
        </div>
        <Input label="Instructor" value={instructorName} onChange={(e) => setInstructor(e.target.value)} />
      </div>
    </Modal>
  );
}

function SessionDetailModal({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.TRAINING_MANAGE);
  const canEnroll = hasPermission(PERMISSIONS.TRAINING_ENROLL);
  const canRecord = hasPermission(PERMISSIONS.TRAINING_RECORD_RESULT);
  const session = useSession(sessionId);
  const enrollments = useEnrollments({ view: 'all', sessionId: sessionId ?? '', pageSize: 100 }, !!sessionId && (canManage || canEnroll));
  const m = useTrainingMutations();
  const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [confirm, setConfirm] = useState<'open' | 'start' | 'complete' | 'cancel' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const s = session.data;
  const rows = enrollments.data?.data ?? [];
  const open = s?.status === 'OPEN' || s?.status === 'IN_PROGRESS';

  const act = async (action: 'open' | 'start' | 'complete' | 'cancel') => {
    setErr(null);
    try { await m.sessionAction.mutateAsync({ id: s!.id, action }); toast.success('Session updated'); setConfirm(null); } catch (e) { setErr(errorMessage(e)); }
  };
  const book = async () => {
    setErr(null);
    try {
      const r = await m.enroll.mutateAsync({ sessionId: s!.id, input: { employeeIds: [employee!.id], source: 'MANUAL' } });
      if (r.enrolled) { toast.success('Booked'); setEmployee(null); } else setErr(r.skipped[0]?.reason ?? 'Already booked');
    } catch (e) { setErr(errorMessage(e)); }
  };
  const record = async (e: EnrollmentDto, kind: 'ATTENDED' | 'NO_SHOW' | 'COMPLETED' | 'FAILED' | 'CANCEL') => {
    setErr(null);
    try {
      if (kind === 'CANCEL') await m.cancelEnrollment.mutateAsync(e.id);
      else if (kind === 'ATTENDED' || kind === 'NO_SHOW') await m.recordAttendance.mutateAsync({ id: e.id, input: { status: kind } });
      else await m.recordResult.mutateAsync({ id: e.id, input: { status: kind } });
    } catch (ex) { setErr(errorMessage(ex)); }
  };

  return (
    <>
      <Modal open={!!sessionId} onClose={onClose} title={s?.course.title ?? 'Session'} description={s ? `${formatSessionTime(s.startAt, s.timezone)} → ${formatSessionTime(s.endAt, s.timezone)} (${s.timezone})` : undefined} size="lg">
        {session.isLoading && <LoadingBlock />}
        {err && <Alert className="mb-3">{err}</Alert>}
        {s && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <SessionStatusBadge status={s.status} />
              <span className="text-slate-600">{s.enrolledCount} booked{s.capacity !== null && ` of ${s.capacity}`}</span>
              {s.location && <span className="text-slate-600">{s.location}</span>}
              {s.instructorName && <span className="text-slate-600">{s.instructorName}</span>}
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {s.status === 'DRAFT' && <Button onClick={() => setConfirm('open')}>Open for booking</Button>}
                {s.status === 'OPEN' && <Button onClick={() => setConfirm('start')}>Start</Button>}
                {(s.status === 'OPEN' || s.status === 'IN_PROGRESS') && <Button variant="secondary" onClick={() => setConfirm('complete')}>Mark completed</Button>}
                {!['COMPLETED', 'CANCELLED'].includes(s.status) && <Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel session</Button>}
              </div>
            )}
            {canEnroll && open && (
              <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-3 sm:flex-row sm:items-end">
                <div className="flex-1"><EmployeePicker label="Book an employee" value={employee} onChange={setEmployee} endpoint="/training/employee-options" /></div>
                <Button onClick={book} loading={m.enroll.isPending} disabled={!employee}><UserPlus className="h-4 w-4" /> Book</Button>
              </div>
            )}
            {(canManage || canEnroll) && (
              <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
                {rows.length === 0 && <li className="p-3 text-sm text-slate-400">Nobody booked yet.</li>}
                {rows.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{e.employee.firstName} {e.employee.lastName}</span>
                      <span className="block text-xs text-slate-500">{e.employee.employeeCode}{e.employee.departmentName && ` · ${e.employee.departmentName}`} · {e.source === 'TNA' ? 'from a need' : e.source === 'IDP' ? 'from a plan' : 'booked by HR'}{e.score && ` · score ${e.score}`}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <EnrollmentStatusBadge status={e.status} />
                      {canRecord && e.status === 'ENROLLED' && <><Button variant="ghost" size="sm" onClick={() => record(e, 'ATTENDED')}>Attended</Button><Button variant="ghost" size="sm" onClick={() => record(e, 'NO_SHOW')}>No-show</Button></>}
                      {canRecord && (e.status === 'ENROLLED' || e.status === 'ATTENDED') && <><Button variant="ghost" size="sm" onClick={() => record(e, 'COMPLETED')}>Completed</Button><Button variant="ghost" size="sm" onClick={() => record(e, 'FAILED')}>Failed</Button></>}
                      {canEnroll && (e.status === 'ENROLLED' || e.status === 'ATTENDED') && <Button variant="ghost" size="sm" onClick={() => record(e, 'CANCEL')}>Cancel</Button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog open={confirm === 'open'} title="Open for booking" message="People can be booked onto this session." confirmLabel="Open" loading={m.sessionAction.isPending} error={err} onConfirm={() => act('open')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'start'} title="Start the session" message="Attendance and results can be recorded from now on." confirmLabel="Start" loading={m.sessionAction.isPending} error={err} onConfirm={() => act('start')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'complete'} title="Mark the session completed" message="This closes the session. It does not complete anybody's record — each person's attendance and result stay as you recorded them." confirmLabel="Mark completed" loading={m.sessionAction.isPending} error={err} onConfirm={() => act('complete')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel the session" message="Every booking still open is cancelled, the people on it are told, and any need that was waiting on it goes back to planned." confirmLabel="Cancel session" variant="danger" loading={m.sessionAction.isPending} error={err} onConfirm={() => act('cancel')} onCancel={() => setConfirm(null)} />
    </>
  );
}
