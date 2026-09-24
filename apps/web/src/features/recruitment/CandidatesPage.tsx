import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { CANDIDATE_SOURCES, CANDIDATE_STATUSES, PERMISSIONS, type CandidateDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { SearchInput } from '@/components/ui/SearchInput';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { useApplications, useCandidate, useCandidates, useDuplicateCheck, useOpenings, useRecruitmentMutations } from './recruitment.api';
import { CandidateStatusBadge, SOURCE_LABEL, Section, StageBadge, label } from './recruitment-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function CandidatesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useCandidates({ search: useDebounce(search), status, source, page, pageSize: 20 });
  const columns: Column<CandidateDto>[] = [
    { key: 'name', header: 'Candidate', render: (c) => <div><div className="font-medium text-slate-900">{c.firstName} {c.lastName}</div><div className="text-xs text-slate-400">{c.candidateNumber}</div></div> },
    { key: 'contact', header: 'Contact', hideBelow: 'md', render: (c) => <div className="text-slate-700">{c.email ?? '—'}<div className="text-xs text-slate-400">{c.phone ?? ''}</div></div> },
    { key: 'current', header: 'Current role', hideBelow: 'lg', render: (c) => (c.currentTitle || c.currentCompany ? `${c.currentTitle ?? ''}${c.currentTitle && c.currentCompany ? ' · ' : ''}${c.currentCompany ?? ''}` : <span className="text-slate-400">—</span>) },
    { key: 'source', header: 'Source', hideBelow: 'sm', render: (c) => label(SOURCE_LABEL, c.source) },
    { key: 'apps', header: 'Applications', hideBelow: 'sm', render: (c) => <span className="tabular-nums">{c.applicationCount}</span> },
    { key: 'status', header: 'Status', render: (c) => <CandidateStatusBadge status={c.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <SearchInput placeholder="Name, number or email…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <Select options={CANDIDATE_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <Select options={CANDIDATE_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] ?? s }))} placeholder="All sources" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Candidate</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load candidates.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} onRowClick={(c) => setOpenId(c.id)} emptyTitle="No candidates" emptyDescription="Candidates are entered by recruiters. There is no public application form." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <CandidateFormModal open={creating} onClose={() => setCreating(false)} />
      <CandidateDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

export function CandidateFormModal({ open, onClose, existing, onCreated }: { open: boolean; onClose: () => void; existing?: CandidateDto | null; onCreated?: (c: CandidateDto) => void }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', currentCompany: '', currentTitle: '', locationText: '', source: 'MANUAL', sourceDetail: '', summary: '' });
  const [allowDuplicate, setAllow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null); setAllow(false);
    setF({ firstName: existing?.firstName ?? '', lastName: existing?.lastName ?? '', email: existing?.email ?? '', phone: existing?.phone ?? '', currentCompany: existing?.currentCompany ?? '', currentTitle: existing?.currentTitle ?? '', locationText: existing?.locationText ?? '', source: existing?.source ?? 'MANUAL', sourceDetail: existing?.sourceDetail ?? '', summary: existing?.summary ?? '' });
  }, [open, existing]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const dupEmail = useDebounce(f.email.trim(), 400);
  const dupPhone = useDebounce(f.phone.trim(), 400);
  const duplicates = useDuplicateCheck(dupEmail, dupPhone, open && !existing);
  const dupes = (duplicates.data ?? []).filter((d) => d.id !== existing?.id);

  const submit = async () => {
    setErr(null);
    const nul = (v: string) => (v.trim() ? v.trim() : null);
    const body = { firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: nul(f.email), phone: nul(f.phone), currentCompany: nul(f.currentCompany), currentTitle: nul(f.currentTitle), locationText: nul(f.locationText), source: f.source as never, sourceDetail: nul(f.sourceDetail), summary: nul(f.summary) };
    try {
      if (existing) { await m.updateCandidate.mutateAsync({ id: existing.id, input: body }); toast.success('Candidate updated'); }
      else { const created = await m.createCandidate.mutateAsync({ ...body, allowDuplicate }); toast.success('Candidate added'); onCreated?.(created); }
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title={existing ? `Edit ${existing.candidateNumber}` : 'New candidate'} description="Name, contact and current role — the minimum a recruiter needs. Nothing protected is asked for or stored." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createCandidate.isPending || m.updateCandidate.isPending} disabled={!f.firstName.trim() || !f.lastName.trim() || (dupes.length > 0 && !existing && !allowDuplicate)}>{existing ? 'Save' : 'Add candidate'}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="First name" required value={f.firstName} onChange={set('firstName')} />
          <Input label="Last name" required value={f.lastName} onChange={set('lastName')} />
          <Input label="Email" type="email" value={f.email} onChange={set('email')} />
          <Input label="Phone" value={f.phone} onChange={set('phone')} />
          <Input label="Current title" value={f.currentTitle} onChange={set('currentTitle')} />
          <Input label="Current company" value={f.currentCompany} onChange={set('currentCompany')} />
          <Input label="Location" value={f.locationText} onChange={set('locationText')} />
          <Select label="Source" options={CANDIDATE_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] ?? s }))} value={f.source} onChange={set('source')} />
          <Input label="Source detail" placeholder="e.g. referred by, board name" value={f.sourceDetail} onChange={set('sourceDetail')} />
        </div>
        <Textarea label="Summary" rows={3} value={f.summary} onChange={set('summary')} />
        {dupes.length > 0 && !existing && (
          <Alert tone="info">
            <div className="space-y-1.5">
              <div>Possible duplicate: {dupes.map((d) => `${d.firstName} ${d.lastName} (${d.candidateNumber}, same ${d.matchedOn})`).join('; ')}.</div>
              <Checkbox label="Create anyway" description="Records are never merged automatically; this adds a separate candidate." checked={allowDuplicate} onChange={(e) => setAllow(e.target.checked)} />
            </div>
          </Alert>
        )}
      </div>
    </Modal>
  );
}

function CandidateDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const q = useCandidate(id);
  const apps = useApplications({ candidateId: id ?? '', page: 1, pageSize: 50 });
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = q.data;
  const archive = async (status: 'ARCHIVED' | 'ACTIVE') => { setErr(null); try { await m.updateCandidate.mutateAsync({ id: id!, input: { status } }); toast.success(status === 'ARCHIVED' ? 'Candidate archived' : 'Candidate restored'); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <>
      <Modal open={!!id && !editing && !applying} onClose={onClose} title={c ? `${c.firstName} ${c.lastName}` : 'Candidate'} description={c?.candidateNumber} size="lg"
        footer={c && canManage ? (
          <>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {c.status === 'ACTIVE' && <Button variant="secondary" onClick={() => archive('ARCHIVED')} loading={m.updateCandidate.isPending}>Archive</Button>}
            {c.status === 'ARCHIVED' && <Button variant="secondary" onClick={() => archive('ACTIVE')} loading={m.updateCandidate.isPending}>Restore</Button>}
            {c.status !== 'HIRED' && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
            {c.status === 'ACTIVE' && <Button onClick={() => setApplying(true)}>Add to opening</Button>}
          </>
        ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this candidate.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {c && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3"><CandidateStatusBadge status={c.status} /><span className="text-slate-500">{label(SOURCE_LABEL, c.source)}{c.sourceDetail && ` · ${c.sourceDetail}`}</span><span className="text-slate-500">added {c.createdAt.slice(0, 10)}</span></div>
            <Section title="Contact"><p className="text-slate-700">{c.email ?? '—'} · {c.phone ?? '—'}{c.locationText && ` · ${c.locationText}`}</p></Section>
            {(c.currentTitle || c.currentCompany) && <Section title="Current role"><p className="text-slate-700">{c.currentTitle ?? ''}{c.currentTitle && c.currentCompany ? ' at ' : ''}{c.currentCompany ?? ''}</p></Section>}
            {c.summary && <Section title="Summary"><p className="whitespace-pre-wrap text-slate-700">{c.summary}</p></Section>}
            {c.hiredEmployeeId && <Alert tone="success">Hired — an employee record now exists. The candidate record is kept as history.</Alert>}
            <Section title="Applications">
              {apps.data?.data.length ? (
                <ul className="space-y-1">{apps.data.data.map((a) => <li key={a.id} className="flex flex-wrap items-center gap-2 text-slate-700"><span className="font-medium">{a.opening.title}</span><span className="text-xs text-slate-400">{a.applicationNumber} · applied {a.appliedAt}</span><StageBadge stage={a.stage} /></li>)}</ul>
              ) : <p className="text-slate-500">No applications yet.</p>}
            </Section>
            <p className="text-xs text-slate-500">Candidates are archived, never deleted: the applications, interviews and offers that reference them are a record of decisions.</p>
          </div>
        )}
      </Modal>
      <CandidateFormModal open={editing} onClose={() => setEditing(false)} existing={c} />
      <AddToOpeningModal open={applying} onClose={() => setApplying(false)} candidateId={id} />
    </>
  );
}

export function AddToOpeningModal({ open, onClose, candidateId }: { open: boolean; onClose: () => void; candidateId: string | null }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const openings = useOpenings({ status: 'OPEN', page: 1, pageSize: 100 });
  const [openingId, setOpening] = useState('');
  const [appliedAt, setApplied] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setOpening(''); setApplied(''); } }, [open]);
  const submit = async () => {
    setErr(null);
    try { await m.createApplication.mutateAsync({ candidateId: candidateId!, openingId, appliedAt: appliedAt || undefined }); toast.success('Application created'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add to an opening" description="Creates an application at the APPLIED stage." size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createApplication.isPending} disabled={!openingId}>Create application</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Open opening" required options={(openings.data?.data ?? []).map((o) => ({ value: o.id, label: `${o.snapshot.title}${o.snapshot.departmentName ? ` · ${o.snapshot.departmentName}` : ''} (${o.openingNumber})` }))} placeholder="Select…" value={openingId} onChange={(e) => setOpening(e.target.value)} />
        <Input label="Applied on" type="date" value={appliedAt} onChange={(e) => setApplied(e.target.value)} hint="Defaults to today in the organization's timezone." />
      </div>
    </Modal>
  );
}
