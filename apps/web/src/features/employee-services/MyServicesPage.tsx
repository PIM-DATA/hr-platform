import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { useMyServices } from './services.api';
import { ServiceBadge, fmtDate, titleCase } from './services-ui';
import { LetterModal, NewRequestModal, RequestModal, ReviewModal } from './ServiceDialogs';

/** Employee self-service: my requests and their conversation, plus the requests waiting for me as an approver. */
export function MyServicesPage() {
  const { hasPermission } = useAuth();
  const me = useMyServices();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false); const [reviewing, setReviewing] = useState<string | null>(null);
  const openRequest = params.get('request'); const openLetter = params.get('letter');
  const setOpen = (key: 'request' | 'letter', id: string | null) => { const n = new URLSearchParams(params); n.delete('request'); n.delete('letter'); if (id) n.set(key, id); setParams(n, { replace: true }); };
  if (me.isLoading) return <LoadingBlock />;
  if (me.isError) return <Alert>Could not load your requests.</Alert>;
  const d = me.data!;
  const open = d.requests.filter((r) => ['DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE'].includes(r.status));
  const closed = d.requests.filter((r) => !open.includes(r));
  const row = (r: (typeof d.requests)[number]) => (
    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
      <button className="min-w-0 text-left" onClick={() => setOpen('request', r.id)}>
        <span className="font-medium text-brand-700 underline">{r.requestNumber}</span>
        <span className="block text-xs text-slate-500">{r.subject} · {r.requestTypeName}{r.messageCount ? ` · ${r.messageCount} message(s)` : ''}{r.letterCount ? ` · ${r.letterCount} letter(s)` : ''}</span>
      </button>
      <span className="flex flex-wrap items-center gap-3">
        {r.status === 'WAITING_EMPLOYEE' && <span className="text-xs font-semibold text-amber-700">HR is waiting for you</span>}
        {r.dueDate && <span className={`text-xs ${r.overdue ? 'font-semibold text-red-700' : 'text-slate-400'}`}>target {r.dueDate}</span>}
        <ServiceBadge status={r.status} />
      </span>
    </li>
  );
  return (
    <div className="space-y-4">
      {d.queue.length > 0 && (
        <Card>
          <CardHeader title="Requests waiting for my decision" description="You see the request and the answers the employee submitted, and nothing else about them." />
          <ul className="divide-y divide-slate-200">{d.queue.map((i) => <li key={i.instanceId} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span><span className="font-medium text-slate-900">{i.requesterName}</span><span className="block text-xs text-slate-500">step {i.stepName} · {fmtDate(i.submittedAt)}</span></span><Button size="sm" onClick={() => setReviewing(i.entityId)}>Review</Button></li>)}</ul>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Open requests" description="What you have asked HR for and where each one stands." />{hasPermission(PERMISSIONS.SERVICE_REQUEST_CREATE) && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New request</Button>}</div>
        {open.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">Nothing open.</p> : <ul className="divide-y divide-slate-200">{open.map(row)}</ul>}
      </Card>
      {closed.length > 0 && <Card><CardHeader title="Closed requests" />{<ul className="divide-y divide-slate-200">{closed.map(row)}</ul>}</Card>}
      <Card>
        <CardHeader title="My letters" description="Letters HR has issued for you. Open one to read or print it." />
        {d.letters.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No letters yet.</p> : <ul className="divide-y divide-slate-200">{d.letters.map((l) => <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><button className="min-w-0 text-left" onClick={() => setOpen('letter', l.id)}><span className="font-medium text-brand-700 underline">{l.letterNumber}</span><span className="block text-xs text-slate-500">{titleCase(l.letterType)} · issued {l.issuedDate}</span></button><ServiceBadge status={l.status} /></li>)}</ul>}
      </Card>
      {creating && <NewRequestModal catalog={d.catalog} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen('request', id); }} />}
      {openRequest && <RequestModal id={openRequest} onClose={() => setOpen('request', null)} onOpenLetter={(lid) => setOpen('letter', lid)} />}
      {openLetter && <LetterModal id={openLetter} onClose={() => setOpen('letter', null)} />}
      {reviewing && <ReviewModal id={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

/** The employee's letters on their own tab, so a letter can be found without opening its request. */
export function MyLettersPage() {
  const me = useMyServices();
  const [params, setParams] = useSearchParams();
  const openLetter = params.get('letter');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('letter', id); else n.delete('letter'); setParams(n, { replace: true }); };
  if (me.isLoading) return <LoadingBlock />;
  if (me.isError) return <Alert>Could not load your letters.</Alert>;
  const letters = me.data!.letters;
  return (
    <Card>
      <CardHeader title="My letters" description="Employment and salary letters issued to you. Each one is a frozen record of what was true when it was issued; open it to read or print it." />
      {letters.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No letters yet. Ask for one through a request.</p> : <ul className="divide-y divide-slate-200">{letters.map((l) => <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><button className="min-w-0 text-left" onClick={() => setOpen(l.id)}><span className="font-medium text-brand-700 underline">{l.letterNumber}</span><span className="block text-xs text-slate-500">{titleCase(l.letterType)}{l.subject ? ` · ${l.subject}` : ''} · issued {l.issuedDate}</span></button><ServiceBadge status={l.status} /></li>)}</ul>}
      {openLetter && <LetterModal id={openLetter} onClose={() => setOpen(null)} />}
    </Card>
  );
}
