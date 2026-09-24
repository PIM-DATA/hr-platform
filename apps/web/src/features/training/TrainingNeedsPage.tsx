import { useEffect, useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import type { TrainingNeedDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useDepartmentOptions, useJobOptions, useOrganizationOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useSessions, useSuggestedCourses, useTrainingMutations, useTrainingNeed, useTrainingNeeds } from './training.api';
import { NeedStatusBadge, SessionStatusBadge, formatSessionTime } from './training-ui';

/**
 * Training needs analysis.
 *
 * "Generate" asks the competency module for today's gaps and raises a need per real one. Unassessed competencies come
 * back as a list of people to assess, never as needs — inventing a shortfall from "nobody has looked" is exactly the
 * mistake this screen exists not to make.
 */
export function TrainingNeedsPage() {
  const departments = useDepartmentOptions();
  const jobs = useJobOptions();
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [jobId, setJobId] = useState('');
  const [page, setPage] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const needs = useTrainingNeeds({ view: 'all', status, source, departmentId, jobId, page, pageSize: 20 });
  const rows = needs.data?.data ?? [];

  const counts = {
    open: rows.filter((n) => n.status === 'OPEN').length,
    planned: rows.filter((n) => n.status === 'PLANNED').length,
    inProgress: rows.filter((n) => n.status === 'IN_PROGRESS').length,
    fulfilled: rows.filter((n) => n.status === 'FULFILLED').length,
  };

  const columns: Column<TrainingNeedDto>[] = [
    { key: 'emp', header: 'Employee', render: (n) => <div><div className="font-medium text-slate-900">{n.employee.firstName} {n.employee.lastName}</div><div className="text-xs text-slate-400">{n.employee.employeeCode}{n.snapshot.departmentName && ` · ${n.snapshot.departmentName}`}{n.snapshot.jobTitle && ` · ${n.snapshot.jobTitle}`}</div></div> },
    { key: 'need', header: 'Need', render: (n) => <div><div className="text-slate-900">{n.title}</div><div className="text-xs text-slate-400">{n.source === 'COMPETENCY_GAP' ? 'From a competency gap' : 'Raised by HR'}{n.priority === 'HIGH' && ' · high priority'}</div></div> },
    { key: 'gap', header: 'Gap when raised', hideBelow: 'md', render: (n) => (n.gapSnapshot ? <span className="tabular-nums">{n.gapSnapshot.currentLevel ?? '—'} of {n.gapSnapshot.requiredLevel} · gap {n.gapSnapshot.gap}</span> : <span className="text-slate-400">—</span>) },
    { key: 'now', header: 'Gap today', hideBelow: 'lg', render: (n) => (n.currentGapStatus ? <span className={n.currentGapStatus === 'GAP' ? 'text-amber-700' : 'text-emerald-700'}>{n.currentGapStatus === 'GAP' ? 'Still open' : n.currentGapStatus === 'UNASSESSED' ? 'Not assessed' : 'No longer a gap'}</span> : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (n) => <NeedStatusBadge status={n.status} /> },
  ];

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Open', counts.open], ['Planned', counts.planned], ['In progress', counts.inProgress], ['Fulfilled', counts.fulfilled]].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div></div>
        ))}
      </div>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3 xl:grid-cols-6">
          <Select options={['OPEN', 'PLANNED', 'IN_PROGRESS', 'FULFILLED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ') }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <Select options={[{ value: 'COMPETENCY_GAP', label: 'From a gap' }, { value: 'MANUAL', label: 'Raised by HR' }]} placeholder="All sources" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} />
          <Select options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }} />
          <Select options={(jobs.data?.data ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="All jobs" value={jobId} onChange={(e) => { setJobId(e.target.value); setPage(1); }} />
          <div className="flex justify-end gap-2 xl:col-span-2">
            <Button variant="secondary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Manual need</Button>
            <Button onClick={() => setGenerating(true)}><Sparkles className="h-4 w-4" /> Generate from gaps</Button>
          </div>
        </div>
        {needs.isError && <Alert className="m-4">Could not load training needs.</Alert>}
        <DataTable columns={columns} rows={rows} rowKey={(n) => n.id} loading={needs.isLoading} onRowClick={(n) => setOpenId(n.id)} emptyTitle="No training needs" emptyDescription="Generate them from competency gaps, or raise one by hand." />
        {needs.data?.meta && <Pagination {...needs.data.meta} onPageChange={setPage} />}
      </Card>
      <GenerateModal open={generating} onClose={() => setGenerating(false)} />
      <ManualNeedModal open={creating} onClose={() => setCreating(false)} />
      <NeedDetailModal needId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function GenerateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useTrainingMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const [organizationId, setOrganizationId] = useState('');
  const departments = useDepartmentOptions(organizationId || undefined);
  const [departmentId, setDepartmentId] = useState('');
  const [result, setResult] = useState<{ created: number; alreadyOpen: number; assessmentRequired: { employeeCode: string; competencyCode: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setResult(null); setOrganizationId(''); setDepartmentId(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      const r = await m.generateTna.mutateAsync({ organizationId: organizationId || undefined, departmentId: departmentId || undefined, priority: 'NORMAL' });
      setResult(r);
      toast.success(`${r.created} need${r.created === 1 ? '' : 's'} raised${r.alreadyOpen ? `, ${r.alreadyOpen} already open` : ''}`);
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Generate needs from competency gaps" description="One need per employee and competency that is below its requirement today. Gaps that already have an open need are left alone." footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={submit} loading={m.generateTna.isPending}>Generate</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization" options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Everyone" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setDepartmentId(''); }} />
        <Select label="Department" options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Every department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} />
        {result && result.assessmentRequired.length > 0 && (
          <Alert tone="info">
            <span className="font-medium">{result.assessmentRequired.length} competenc{result.assessmentRequired.length === 1 ? 'y has' : 'ies have'} never been assessed.</span> No need was raised for them — nobody knows whether there is a gap. Assess first.
            <ul className="mt-1 list-disc pl-4">{result.assessmentRequired.slice(0, 6).map((r) => <li key={`${r.employeeCode}-${r.competencyCode}`}>{r.employeeCode} · {r.competencyCode}</li>)}{result.assessmentRequired.length > 6 && <li>…and {result.assessmentRequired.length - 6} more</li>}</ul>
          </Alert>
        )}
      </div>
    </Modal>
  );
}

function ManualNeedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useTrainingMutations();
  const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'NORMAL' | 'HIGH'>('NORMAL');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setEmployee(null); setTitle(''); setDescription(''); setPriority('NORMAL'); } }, [open]);
  const submit = async () => {
    setErr(null);
    try {
      await m.createNeed.mutateAsync({ employeeId: employee!.id, title, description: description || null, priority });
      toast.success('Need raised');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Raise a development need" description="For anything a competency gap does not capture — compliance, a new system, a workshop." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createNeed.isPending} disabled={!employee || !title}>Raise need</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker value={employee} onChange={setEmployee} endpoint="/training/employee-options" />
        <Input label="Need" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leadership workshop" />
        <Textarea label="Reason" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <Select label="Priority" options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'HIGH', label: 'High' }]} value={priority} onChange={(e) => setPriority(e.target.value as 'NORMAL' | 'HIGH')} />
      </div>
    </Modal>
  );
}

/** One need: the gap it came from, what has been booked against it, and courses that could address it. */
function NeedDetailModal({ needId, onClose }: { needId: string | null; onClose: () => void }) {
  const need = useTrainingNeed(needId);
  const suggested = useSuggestedCourses(needId);
  const m = useTrainingMutations();
  const toast = useToast();
  const [sessionCourseId, setSessionCourseId] = useState('');
  const sessions = useSessions({ courseId: sessionCourseId, status: 'OPEN', pageSize: 20 });
  const [sessionId, setSessionId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const n = need.data;
  useEffect(() => { setSessionCourseId(''); setSessionId(''); setErr(null); }, [needId]);

  const book = async () => {
    setErr(null);
    try {
      const r = await m.enroll.mutateAsync({ sessionId, input: { employeeIds: [n!.employee.id], source: 'TNA', trainingNeedId: n!.id } });
      if (r.enrolled) toast.success('Booked'); else setErr(r.skipped[0]?.reason ?? 'Already booked');
    } catch (e) { setErr(errorMessage(e)); }
  };
  const setStatus = async (status: 'CANCELLED' | 'FULFILLED') => {
    setErr(null);
    try { await m.updateNeed.mutateAsync({ id: n!.id, input: { status } }); toast.success('Updated'); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={!!needId} onClose={onClose} title={n?.title ?? 'Need'} description={n ? `${n.employee.firstName} ${n.employee.lastName} · ${n.snapshot.jobTitle ?? '—'}` : undefined} size="lg">
      {need.isLoading && <LoadingBlock />}
      {err && <Alert className="mb-3">{err}</Alert>}
      {n && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <NeedStatusBadge status={n.status} />
            {n.gapSnapshot && <span className="text-slate-600">When raised: assessed <b>{n.gapSnapshot.currentLevel ?? '—'}</b>, required <b>{n.gapSnapshot.requiredLevel}</b>, gap <b>{n.gapSnapshot.gap}</b></span>}
            {n.currentGapStatus && <span className="text-xs text-slate-500">Today: {n.currentGapStatus === 'GAP' ? 'still below requirement' : n.currentGapStatus === 'UNASSESSED' ? 'not assessed' : 'no longer a gap'}</span>}
          </div>
          {n.description && <p className="text-sm text-slate-600">{n.description}</p>}

          {n.enrollments.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Training booked</div>
              <ul className="divide-y divide-slate-100 text-sm">{n.enrollments.map((e) => <li key={e.id} className="flex justify-between py-1.5"><span>{e.courseTitle}</span><span className="text-slate-500">{e.status.toLowerCase().replace('_', ' ')}</span></li>)}</ul>
            </div>
          )}

          {!['FULFILLED', 'CANCELLED'].includes(n.status) && (
            <div className="space-y-3 rounded-md border border-slate-200 p-3">
              <div className="text-sm font-medium text-slate-700">Book a session</div>
              {suggested.data && suggested.data.length > 0 && <p className="text-xs text-slate-500">Courses relevant to {n.competency?.name}: {suggested.data.map((c) => c.title).join(', ')}. Relevance is not a promise that a level will change.</p>}
              <Select label="Course" options={(suggested.data ?? []).map((c) => ({ value: c.id, label: c.title }))} placeholder={suggested.data?.length ? 'Choose a course' : 'No course is mapped to this competency'} value={sessionCourseId} onChange={(e) => { setSessionCourseId(e.target.value); setSessionId(''); }} disabled={!suggested.data?.length} />
              <Select label="Open session" options={(sessions.data?.data ?? []).map((s) => ({ value: s.id, label: `${formatSessionTime(s.startAt, s.timezone)}${s.seatsLeft !== null ? ` · ${s.seatsLeft} seats left` : ''}` }))} placeholder={sessionCourseId ? 'Choose a session' : 'Choose a course first'} value={sessionId} onChange={(e) => setSessionId(e.target.value)} disabled={!sessionCourseId} />
              <div className="flex justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStatus('CANCELLED')}>Cancel need</Button>
                <Button onClick={book} loading={m.enroll.isPending} disabled={!sessionId}>Book</Button>
              </div>
            </div>
          )}
          {sessions.data?.data.length === 0 && sessionCourseId && <p className="text-xs text-slate-500">No open session for that course yet. <SessionStatusBadge status="OPEN" /> sessions appear here.</p>}
        </div>
      )}
    </Modal>
  );
}
