import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { APPLICATION_STAGES, PERMISSIONS, REJECTION_REASONS, type ApplicationDetailDto, type ApplicationDto, type CandidateDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/SearchInput';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useApplication, useApplications, useOffers, useOpenings, useRecruitmentMutations, useRecruitmentOptions } from './recruitment.api';
import { InterviewStatusBadge, InterviewerPicker, OfferStatusBadge, REJECTION_LABEL, SOURCE_LABEL, Section, StageBadge, StageTimeline, fmtDateTime, label } from './recruitment-ui';
import { CandidateFormModal, AddToOpeningModal } from './CandidatesPage';
import { InterviewDetailModal } from './InterviewsPage';
import { OfferFormModal } from './OffersPage';
import type { InterviewerOption } from './recruitment.api';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const ACTIVE = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];

export function ApplicationsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [openingId, setOpeningId] = useState(params.get('openingId') ?? '');
  const [activeOnly, setActiveOnly] = useState(params.get('active') === 'true');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [newCandidate, setNewCandidate] = useState<CandidateDto | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const openings = useOpenings({ page: 1, pageSize: 100 });
  const list = useApplications({ search: useDebounce(search), stage, openingId, active: activeOnly ? 'true' : '', page, pageSize: 20 });
  const columns: Column<ApplicationDto>[] = [
    { key: 'who', header: 'Candidate', render: (a) => <div><div className="font-medium text-slate-900">{a.candidate.firstName} {a.candidate.lastName}</div><div className="text-xs text-slate-400">{a.applicationNumber} · {label(SOURCE_LABEL, a.candidate.source)}</div></div> },
    { key: 'opening', header: 'Opening', render: (a) => <div className="text-slate-800">{a.opening.title}<div className="text-xs text-slate-400">{a.opening.departmentName ?? ''}</div></div> },
    { key: 'applied', header: 'Applied', hideBelow: 'md', render: (a) => a.appliedAt },
    { key: 'interviews', header: 'Interviews', hideBelow: 'lg', render: (a) => <span className="tabular-nums">{a.interviewCount}</span> },
    { key: 'offer', header: 'Offer', hideBelow: 'lg', render: (a) => (a.offerStatus ? <OfferStatusBadge status={a.offerStatus} /> : <span className="text-slate-400">—</span>) },
    { key: 'stage', header: 'Stage', render: (a) => <StageBadge stage={a.stage} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-5">
          <SearchInput placeholder="Candidate or application number…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <Select options={(openings.data?.data ?? []).map((o) => ({ value: o.id, label: `${o.snapshot.title} (${o.openingNumber})` }))} placeholder="All openings" value={openingId} onChange={(e) => { setOpeningId(e.target.value); setPage(1); }} />
          <Select options={APPLICATION_STAGES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All stages" value={stage} onChange={(e) => { setStage(e.target.value); setActiveOnly(false); setPage(1); }} />
          <Select options={[{ value: 'active', label: 'Active only' }, { value: 'all', label: 'Including closed' }]} value={activeOnly ? 'active' : 'all'} onChange={(e) => { setActiveOnly(e.target.value === 'active'); setStage(''); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Application</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load applications.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(a) => a.id} loading={list.isLoading} onRowClick={(a) => setOpenId(a.id)} emptyTitle="No applications" emptyDescription="Add a candidate to an open opening to start a pipeline." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {/* New application = new candidate, then choose the opening. Existing candidates are added from their own record. */}
      <CandidateFormModal open={creating} onClose={() => setCreating(false)} onCreated={(c) => setNewCandidate(c)} />
      <AddToOpeningModal open={!!newCandidate} onClose={() => setNewCandidate(null)} candidateId={newCandidate?.id ?? null} />
      <ApplicationDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

export function ApplicationDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const canOffer = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE_OFFERS);
  const canHire = hasPermission(PERMISSIONS.RECRUITMENT_HIRE);
  const q = useApplication(id);
  const offers = useOffers({ page: 1, pageSize: 50 });
  const [dialog, setDialog] = useState<'move' | 'reject' | 'withdraw' | 'interview' | 'offer' | 'hire' | null>(null);
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const a = q.data;
  const appOffers = useMemo(() => (offers.data?.data ?? []).filter((o) => o.applicationId === id), [offers.data, id]);
  const accepted = appOffers.find((o) => o.status === 'ACCEPTED');
  const liveOffer = appOffers.find((o) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED'].includes(o.status));
  const active = !!a && ACTIVE.includes(a.stage);
  return (
    <>
      <Modal open={!!id && !dialog && !interviewId} onClose={onClose} title={a ? `${a.candidate.firstName} ${a.candidate.lastName} · ${a.opening.title}` : 'Application'} description={a?.applicationNumber} size="lg"
        footer={a ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {canManage && active && <Button variant="danger" onClick={() => setDialog('reject')}>Reject</Button>}
            {canManage && active && <Button variant="secondary" onClick={() => setDialog('withdraw')}>Record withdrawal</Button>}
            {canManage && active && a.opening.status === 'OPEN' && <Button variant="secondary" onClick={() => setDialog('interview')}>Schedule interview</Button>}
            {canOffer && a.stage === 'OFFER' && !liveOffer && <Button variant="secondary" onClick={() => setDialog('offer')}>Draft offer</Button>}
            {canManage && active && a.opening.status === 'OPEN' && <Button onClick={() => setDialog('move')}>Move stage</Button>}
            {canHire && a.stage === 'OFFER' && accepted && <Button onClick={() => setDialog('hire')}>Hire</Button>}
          </div>
        ) : undefined}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this application.</Alert>}
        {a && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-3"><StageBadge stage={a.stage} /><span className="text-slate-500">applied {a.appliedAt}</span><span className="text-slate-500">{label(SOURCE_LABEL, a.candidate.source)}</span>{a.opening.status !== 'OPEN' && <span className="text-xs text-amber-700">opening is {a.opening.status.toLowerCase().replace('_', ' ')}</span>}</div>
            {a.rejection && <Alert tone="info">Rejected {a.rejection.at.slice(0, 10)} · {label(REJECTION_LABEL, a.rejection.reasonCode)}{a.rejection.note && ` · ${a.rejection.note}`}</Alert>}
            {a.withdrawal && <Alert tone="info">Candidate withdrew {a.withdrawal.at.slice(0, 10)}{a.withdrawal.note && ` · ${a.withdrawal.note}`} (recorded by HR)</Alert>}
            {a.hiredEmployeeId && <Alert tone="success">Hired {a.hiredAt?.slice(0, 10)} — employee record created. No user account and no payroll compensation were created by this step.</Alert>}
            <Section title="Pipeline history"><StageTimeline history={a.stageHistory} /></Section>
            <Section title="Interviews">
              {a.interviews.length === 0 ? <p className="text-slate-500">No interviews scheduled.</p> : (
                <ul className="space-y-1">{a.interviews.map((i) => (
                  <li key={i.id}><button type="button" className="flex w-full flex-wrap items-center gap-2 rounded px-1 py-0.5 text-left text-slate-700 hover:bg-slate-50" onClick={() => setInterviewId(i.id)}>
                    <span className="font-medium">{i.title}</span><span className="text-xs text-slate-400">{fmtDateTime(i.scheduledStart, i.timezone)} ({i.timezone})</span><InterviewStatusBadge status={i.status} />
                    <span className="text-xs text-slate-500">{i.interviewers.filter((x) => x.feedbackSubmitted).length}/{i.interviewers.length} feedback</span>
                  </button></li>
                ))}</ul>
              )}
            </Section>
            <Section title="Offers">
              {appOffers.length === 0 ? <p className="text-slate-500">{a.stage === 'OFFER' ? 'No offer drafted yet.' : 'Offers are drafted once the application reaches the OFFER stage.'}</p> : (
                <ul className="space-y-1">{appOffers.map((o) => <li key={o.id} className="flex flex-wrap items-center gap-2 text-slate-700"><span className="font-medium">{o.offerNumber}</span><OfferStatusBadge status={o.status} /><span className="text-xs text-slate-500">start {o.proposedStartDate}</span>{o.compensationVisible && o.baseSalaryProposal && <span className="text-xs tabular-nums text-slate-500">{o.baseSalaryProposal} {o.currencyCode}</span>}</li>)}</ul>
              )}
            </Section>
          </div>
        )}
      </Modal>
      {a && <MoveStageDialog open={dialog === 'move'} onClose={() => setDialog(null)} application={a} />}
      {a && <RejectDialog open={dialog === 'reject'} onClose={() => setDialog(null)} application={a} />}
      {a && <WithdrawDialog open={dialog === 'withdraw'} onClose={() => setDialog(null)} application={a} />}
      {a && <ScheduleInterviewDialog open={dialog === 'interview'} onClose={() => setDialog(null)} application={a} />}
      {a && <OfferFormModal open={dialog === 'offer'} onClose={() => setDialog(null)} applicationId={a.id} />}
      {a && <HireDialog open={dialog === 'hire'} onClose={() => setDialog(null)} application={a} />}
      <InterviewDetailModal id={interviewId} onClose={() => setInterviewId(null)} />
    </>
  );
}

/** The explicit move. Forward is routine; backwards asks why, and the reason goes into the history. */
function MoveStageDialog({ open, onClose, application }: { open: boolean; onClose: () => void; application: ApplicationDetailDto }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const order = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
  const [toStage, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setReason(''); const next = order[order.indexOf(application.stage) + 1]; setTo(next ?? ''); } }, [open, application.stage]);
  const backwards = !!toStage && order.indexOf(toStage) < order.indexOf(application.stage);
  const submit = async () => {
    setErr(null);
    try { await m.moveStage.mutateAsync({ id: application.id, input: { toStage: toStage as never, reason: reason || null } }); toast.success(`Moved to ${titleCase(toStage)}`); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Move stage" description={`${application.candidate.firstName} ${application.candidate.lastName} is at ${titleCase(application.stage)}.`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.moveStage.isPending} disabled={!toStage || toStage === application.stage || (backwards && !reason.trim())}>Move</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="To stage" options={['SCREENING', 'INTERVIEW', 'OFFER'].filter((s) => s !== application.stage).map((s) => ({ value: s, label: titleCase(s) }))} value={toStage} onChange={(e) => setTo(e.target.value)} />
        <Textarea label={backwards ? 'Reason (required when moving back)' : 'Reason (optional)'} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        <p className="text-xs text-slate-500">Hired, rejected and withdrawn are separate actions with their own checks — never a stage move.</p>
      </div>
    </Modal>
  );
}

function RejectDialog({ open, onClose, application }: { open: boolean; onClose: () => void; application: ApplicationDetailDto }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [reasonCode, setCode] = useState('NOT_A_FIT');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode('NOT_A_FIT'); setNote(''); } }, [open]);
  const submit = async () => { setErr(null); try { await m.rejectApplication.mutateAsync({ id: application.id, input: { reasonCode: reasonCode as never, note: note || null } }); toast.success('Application rejected'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open={open} onClose={onClose} title="Reject application" description="A coded reason is aggregated in reports; the note stays on the application." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={submit} loading={m.rejectApplication.isPending}>Reject</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Reason" options={REJECTION_REASONS.map((r) => ({ value: r, label: REJECTION_LABEL[r] ?? r }))} value={reasonCode} onChange={(e) => setCode(e.target.value)} />
        <Textarea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function WithdrawDialog({ open, onClose, application }: { open: boolean; onClose: () => void; application: ApplicationDetailDto }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setNote(''); } }, [open]);
  const submit = async () => { setErr(null); try { await m.withdrawApplication.mutateAsync({ id: application.id, input: { note: note || null } }); toast.success('Withdrawal recorded'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open={open} onClose={onClose} title="Record withdrawal" description="The candidate told us they are no longer interested. This is HR's record of that; scheduled interviews and open offers are closed." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.withdrawApplication.isPending}>Record withdrawal</Button></>}>
      <div className="space-y-3">{err && <Alert>{err}</Alert>}<Textarea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>
  );
}

function ScheduleInterviewDialog({ open, onClose, application }: { open: boolean; onClose: () => void; application: ApplicationDetailDto }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [roundNumber, setRound] = useState('1');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('11:00');
  const [timezone, setTz] = useState('');
  const [location, setLocation] = useState('');
  const [meetingUrl, setUrl] = useState('');
  const [panel, setPanel] = useState<InterviewerOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setTitle(`Interview round ${application.interviews.length + 1}`); setRound(String(application.interviews.length + 1)); setDate(''); setStart('10:00'); setEnd('11:00'); setTz(''); setLocation(''); setUrl(''); setPanel([]); } }, [open, application.interviews.length]);
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** Wall-clock in the chosen zone → UTC instant. The server stores the instant and the zone; nothing assumes an offset. */
  const toIso = (d: string, t: string) => {
    const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, da, h, mi);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return new Date(guess - (asIfUtc - guess)).toISOString();
  };
  const submit = async () => {
    setErr(null);
    try {
      await m.scheduleInterview.mutateAsync({ applicationId: application.id, input: { title, roundNumber: Number(roundNumber) || null, scheduledStart: toIso(date, start), scheduledEnd: toIso(date, end), timezone: tz, location: location || null, meetingUrl: meetingUrl || null, interviewerUserIds: panel.map((p) => p.userId) } });
      toast.success('Interview scheduled — interviewers notified');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Schedule interview" description="Interviewers are notified in the system. No calendar invite or email is sent from here." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.scheduleInterview.isPending} disabled={!title || !date || !start || !end || panel.length === 0}>Schedule</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} className="sm:col-span-2" />
          <Input label="Round" type="number" min={1} value={roundNumber} onChange={(e) => setRound(e.target.value)} />
          <Input label="Date" required type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Start" required type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <Input label="End" required type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          <Input label="Timezone" placeholder={tz} value={timezone} onChange={(e) => setTz(e.target.value)} hint="IANA name; defaults to your browser's zone." />
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
          <Input label="Meeting link" type="url" value={meetingUrl} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <InterviewerPicker value={panel} onChange={setPanel} />
      </div>
    </Modal>
  );
}

/** The bridge into the employee master. Only what the employee record needs; nothing about the candidate is assumed. */
function HireDialog({ open, onClose, application }: { open: boolean; onClose: () => void; application: ApplicationDetailDto }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const options = useRecruitmentOptions();
  const [employeeCode, setCode] = useState('');
  const [hireDate, setHireDate] = useState('');
  const [positionId, setPosition] = useState('');
  const [employmentType, setType] = useState('FULL_TIME');
  const [email, setEmail] = useState('');
  const [manager, setManager] = useState<PayrollEmployeeOption | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ employeeCode: string } | null>(null);
  useEffect(() => { if (open) { setErr(null); setDone(null); setCode(''); setHireDate(''); setPosition(''); setType('FULL_TIME'); setEmail(''); setManager(null); } }, [open]);
  const submit = async () => {
    setErr(null);
    try {
      const result = await m.hire.mutateAsync({ applicationId: application.id, input: { employeeCode: employeeCode.trim(), hireDate, positionId, employmentType: employmentType as never, email: email.trim(), managerId: manager?.id ?? null } });
      setDone(result);
      toast.success(`Employee ${result.employeeCode} created`);
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Hire candidate" description={`Creates an employee record for ${application.candidate.firstName} ${application.candidate.lastName} from the accepted offer.`} size="lg"
      footer={done ? <Button onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.hire.isPending} disabled={!employeeCode.trim() || !hireDate || !positionId || !email.trim()}>Create employee</Button></>}>
      {done ? (
        <Alert tone="success">Employee {done.employeeCode} was created and the application is now HIRED. No user account was created and no payroll compensation was set up — those are separate decisions in Users and Payroll.</Alert>
      ) : (
        <div className="space-y-3">
          {err && <Alert>{err}</Alert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Employee code" required value={employeeCode} onChange={(e) => setCode(e.target.value)} />
            <Input label="Hire date" required type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} />
            <Select label="Position" required options={(options.data?.positions ?? []).map((p) => ({ value: p.id, label: `${p.title} (${p.code})` }))} placeholder="Select…" value={positionId} onChange={(e) => setPosition(e.target.value)} />
            <Select label="Employment type" options={['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => ({ value: t, label: titleCase(t) }))} value={employmentType} onChange={(e) => setType(e.target.value)} />
            <Input label="Work email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="The employee record's email — not assumed to be the candidate's contact address." className="sm:col-span-2" />
          </div>
          <EmployeePicker label="Manager" value={manager} onChange={setManager} endpoint="/recruitment/employee-options" />
          <p className="text-xs text-slate-500">The candidate's name and phone are copied. Their profile stays in recruitment. Nothing here creates a login or a salary record.</p>
        </div>
      )}
    </Modal>
  );
}
