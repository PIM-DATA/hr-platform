import { useEffect, useState } from 'react';
import { OFFER_STATUSES, PERMISSIONS, type OfferDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useOffer, useOffers, useRecruitmentMutations, useRecruitmentOptions } from './recruitment.api';
import { OfferStatusBadge, Section } from './recruitment-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function OffersPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useOffers({ status, page, pageSize: 20 });
  const columns: Column<OfferDto>[] = [
    { key: 'who', header: 'Candidate', render: (o) => <div><div className="font-medium text-slate-900">{o.candidate.firstName} {o.candidate.lastName}</div><div className="text-xs text-slate-400">{o.offerNumber} · {o.applicationNumber}</div></div> },
    { key: 'opening', header: 'Opening', render: (o) => <div className="text-slate-800">{o.opening.title}{o.position && <div className="text-xs text-slate-400">{o.position.title}</div>}</div> },
    { key: 'start', header: 'Start', hideBelow: 'md', render: (o) => o.proposedStartDate },
    { key: 'salary', header: 'Base salary', hideBelow: 'sm', render: (o) => (o.compensationVisible ? <span className="tabular-nums">{o.baseSalaryProposal ?? '—'} {o.baseSalaryProposal && o.currencyCode}</span> : <span className="text-slate-400">hidden</span>) },
    { key: 'status', header: 'Status', render: (o) => <OfferStatusBadge status={o.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={OFFER_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
        </div>
        {list.isError && <Alert className="m-4">Could not load offers.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(o) => o.id} loading={list.isLoading} onRowClick={(o) => setOpenId(o.id)} emptyTitle="No offers" emptyDescription="Offers are drafted from an application at the OFFER stage." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <OfferDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

export function OfferFormModal({ open, onClose, applicationId, existing }: { open: boolean; onClose: () => void; applicationId?: string; existing?: OfferDto | null }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const options = useRecruitmentOptions();
  const [proposedStartDate, setStart] = useState('');
  const [employmentType, setType] = useState('FULL_TIME');
  const [positionId, setPosition] = useState('');
  const [baseSalaryProposal, setSalary] = useState('');
  const [currencyCode, setCurrency] = useState('THB');
  const [otherTermsText, setTerms] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setStart(existing?.proposedStartDate ?? ''); setType(existing?.employmentType ?? 'FULL_TIME'); setPosition(existing?.position?.id ?? ''); setSalary(existing?.baseSalaryProposal ?? ''); setCurrency(existing?.currencyCode ?? 'THB'); setTerms(existing?.otherTermsText ?? ''); } }, [open, existing]);
  const submit = async () => {
    setErr(null);
    const body = { proposedStartDate, employmentType: employmentType as never, positionId: positionId || null, baseSalaryProposal: baseSalaryProposal.trim() || null, currencyCode: currencyCode.toUpperCase(), otherTermsText: otherTermsText || null };
    try {
      if (existing) await m.updateOffer.mutateAsync({ id: existing.id, input: body });
      else await m.createOffer.mutateAsync({ applicationId: applicationId!, ...body });
      toast.success(existing ? 'Offer updated' : 'Offer drafted');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title={existing ? `Edit ${existing.offerNumber}` : 'Draft offer'} description="A proposal to the candidate. The salary is confidential to offer managers and the approver; payroll is told nothing by this." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createOffer.isPending || m.updateOffer.isPending} disabled={!proposedStartDate}>{existing ? 'Save' : 'Create draft'}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Proposed start date" required type="date" value={proposedStartDate} onChange={(e) => setStart(e.target.value)} />
          <Select label="Employment type" options={['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => ({ value: t, label: titleCase(t) }))} value={employmentType} onChange={(e) => setType(e.target.value)} />
          <Select label="Position" options={(options.data?.positions ?? []).map((p) => ({ value: p.id, label: `${p.title} (${p.code})` }))} placeholder="Not specified" value={positionId} onChange={(e) => setPosition(e.target.value)} className="sm:col-span-2" />
          <Input label="Base salary proposal" inputMode="decimal" placeholder="e.g. 45000.00" value={baseSalaryProposal} onChange={(e) => setSalary(e.target.value)} hint="Monthly base, two decimals at most." />
          <Input label="Currency" maxLength={3} value={currencyCode} onChange={(e) => setCurrency(e.target.value)} />
        </div>
        <Textarea label="Other terms" rows={3} value={otherTermsText} onChange={(e) => setTerms(e.target.value)} />
      </div>
    </Modal>
  );
}

function OfferDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canOffer = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE_OFFERS);
  const q = useOffer(id);
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'submit' | 'sent' | 'accepted' | 'declined' | 'withdraw' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const o = q.data;
  const run = async (fn: () => Promise<unknown>, done: string) => { setErr(null); try { await fn(); toast.success(done); } catch (e) { setErr(errorMessage(e)); } setConfirm(null); };
  return (
    <>
      <Modal open={!!id && !editing} onClose={onClose} title={o ? `${o.offerNumber} · ${o.candidate.firstName} ${o.candidate.lastName}` : 'Offer'} description={o ? `${o.opening.title} · ${o.applicationNumber}` : undefined} size="lg"
        footer={o && canOffer ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {['DRAFT', 'APPROVED', 'SENT', 'ACCEPTED'].includes(o.status) && <Button variant="danger" onClick={() => setConfirm('withdraw')}>Withdraw</Button>}
            {o.status === 'DRAFT' && <><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button onClick={() => setConfirm('submit')}>Submit for approval</Button></>}
            {o.status === 'APPROVED' && <Button onClick={() => setConfirm('sent')}>Mark as sent</Button>}
            {o.status === 'SENT' && <><Button variant="secondary" onClick={() => setConfirm('declined')}>Record declined</Button><Button onClick={() => setConfirm('accepted')}>Record accepted</Button></>}
          </div>
        ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this offer.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {o && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3"><OfferStatusBadge status={o.status} />{o.submittedAt && <span className="text-slate-500">submitted {o.submittedAt.slice(0, 10)}</span>}{o.approvedAt && <span className="text-slate-500">approved {o.approvedAt.slice(0, 10)}</span>}{o.sentAt && <span className="text-slate-500">sent {o.sentAt.slice(0, 10)}</span>}{o.acceptedAt && <span className="text-emerald-700">accepted {o.acceptedAt.slice(0, 10)}</span>}{o.declinedAt && <span className="text-red-700">declined {o.declinedAt.slice(0, 10)}</span>}{o.withdrawnAt && <span className="text-slate-500">withdrawn {o.withdrawnAt.slice(0, 10)}</span>}</div>
            <Section title="Terms">
              <p className="text-slate-700">Start {o.proposedStartDate}{o.employmentType && ` · ${titleCase(o.employmentType)}`}{o.position && ` · ${o.position.title}`}</p>
              {o.compensationVisible ? <p className="text-slate-900">Base salary proposal <span className="font-medium tabular-nums">{o.baseSalaryProposal ?? '—'}{o.baseSalaryProposal && ` ${o.currencyCode}`}</span></p> : <p className="text-slate-500">Compensation is visible only to offer managers and the approver.</p>}
              {o.otherTermsText && <p className="mt-1 whitespace-pre-wrap text-slate-700">{o.otherTermsText}</p>}
            </Section>
            {(o.status === 'APPROVED' || o.status === 'SENT' || o.status === 'ACCEPTED' || o.status === 'DECLINED') && <p className="text-xs text-slate-500">Approved offers are frozen. To change the terms, withdraw this offer and draft a new one.</p>}
            {o.status === 'ACCEPTED' && <Alert tone="info">Accepted offers change nothing by themselves. Hiring is a separate step on the application, for someone with the hire permission.</Alert>}
          </div>
        )}
      </Modal>
      <OfferFormModal open={editing} onClose={() => setEditing(false)} existing={o} />
      <ConfirmDialog open={confirm === 'submit'} title="Submit for approval?" message="The approver sees the terms including the salary. Once approved, the offer is frozen." confirmLabel="Submit" onConfirm={() => run(() => m.submitOffer.mutateAsync(id!), 'Submitted for approval')} onCancel={() => setConfirm(null)} loading={m.submitOffer.isPending} />
      <ConfirmDialog open={confirm === 'sent'} title="Mark as sent?" message="Records that the offer was given to the candidate outside this system. Nothing is emailed from here." confirmLabel="Mark as sent" onConfirm={() => run(() => m.markOfferSent.mutateAsync(id!), 'Marked as sent')} onCancel={() => setConfirm(null)} loading={m.markOfferSent.isPending} />
      <ConfirmDialog open={confirm === 'accepted'} title="Record acceptance?" message="HR's record that the candidate accepted. The application stays at OFFER until somebody hires." confirmLabel="Record accepted" onConfirm={() => run(() => m.recordOfferAccepted.mutateAsync(id!), 'Acceptance recorded')} onCancel={() => setConfirm(null)} loading={m.recordOfferAccepted.isPending} />
      <ConfirmDialog open={confirm === 'declined'} title="Record decline?" message="HR's record that the candidate declined. The application stays open for you to decide what happens next." confirmLabel="Record declined" onConfirm={() => run(() => m.recordOfferDeclined.mutateAsync(id!), 'Decline recorded')} onCancel={() => setConfirm(null)} loading={m.recordOfferDeclined.isPending} />
      <ConfirmDialog open={confirm === 'withdraw'} title="Withdraw this offer?" message="The offer is kept as a record and can no longer be used. Draft a new offer if terms change." confirmLabel="Withdraw" variant="danger" onConfirm={() => run(() => m.withdrawOffer.mutateAsync(id!), 'Offer withdrawn')} onCancel={() => setConfirm(null)} loading={m.withdrawOffer.isPending} />
    </>
  );
}
