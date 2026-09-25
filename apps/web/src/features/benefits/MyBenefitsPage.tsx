import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type BenefitEntitlementDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useBenefitsInbox, useBenefitsMutations, useMyBenefits } from './benefits.api';
import { BalanceBar, BenefitBadge, fmtDate, money } from './benefits-ui';
import { ClaimModal, ReviewModal } from './ClaimDialogs';

/** ESS: what I am enrolled in, what I can still claim, my claims, my coverage — and, for an approver, the claims waiting for me. */
export function MyBenefitsPage() {
  const { hasPermission } = useAuth();
  const me = useMyBenefits(); const m = useBenefitsMutations(); const toast = useToast();
  const inbox = useBenefitsInbox(hasPermission(PERMISSIONS.WORKFLOW_APPROVE));
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false); const [reviewing, setReviewing] = useState<string | null>(null);
  const openId = params.get('open');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('open', id); else n.delete('open'); setParams(n, { replace: true }); };
  if (me.isLoading) return <LoadingBlock />;
  if (me.isError) return <Alert>Could not load your benefits.</Alert>;
  const d = me.data!;
  const openEntitlements = d.entitlements.filter((e) => e.periodStatus === 'OPEN');
  return (
    <div className="space-y-4">
      {(inbox.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader title="Claims waiting for my decision" description="You see the claim, its documents and remaining entitlement — nothing else about the person." />
          <ul className="divide-y divide-slate-200">{inbox.data!.map((i) => <li key={i.instanceId} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span><span className="font-medium text-slate-900">{i.requesterEmployee.firstName} {i.requesterEmployee.lastName}</span><span className="block text-xs text-slate-500">{i.definitionName} · step {i.stepName} · {fmtDate(i.submittedAt)}</span></span><Button size="sm" onClick={() => setReviewing(i.entityId)}>Review</Button></li>)}</ul>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="My entitlements" description="Granted, reserved by pending claims, used by approved claims, and what is still available. All figures exact." />{hasPermission(PERMISSIONS.BENEFITS_CLAIM) && openEntitlements.length > 0 && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New claim</Button>}</div>
        {d.entitlements.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No monetary entitlement yet.</p> : <ul className="divide-y divide-slate-200">{d.entitlements.map((e) => <li key={e.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-900">{e.planName}<span className="block text-xs text-slate-500">{e.periodName} · {e.periodStart} → {e.periodEnd}{e.perClaimMaximum ? ` · per claim up to ${money(e.perClaimMaximum)}` : ''}{e.requiresDocument ? ' · receipt required' : ''}</span></span><BenefitBadge status={e.periodStatus} /></div><div className="mt-2"><BalanceBar balance={e.balance} /></div></li>)}</ul>}
      </Card>
      <Card>
        <CardHeader title="My claims" />
        {d.claims.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No claims yet.</p> : <ul className="divide-y divide-slate-200">{d.claims.map((c) => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><button className="min-w-0 text-left" onClick={() => setOpen(c.id)}><span className="font-medium text-brand-700 underline">{c.claimNumber}</span><span className="block text-xs text-slate-500">{c.planName} · service {c.serviceDate}{c.documentCount ? ` · ${c.documentCount} document(s)` : ''}</span></button><span className="flex items-center gap-3"><span className="tabular-nums">{money(c.claimedAmount, c.currency)}</span><BenefitBadge status={c.status} /></span></li>)}</ul>}
      </Card>
      <Card>
        <CardHeader title="Enrolments and coverage" description="Plans you are enrolled in. A coverage-only benefit has dates and a status, not a balance." />
        {d.enrollments.length + d.coverage.length + d.selectablePlans.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">Nothing to show.</p> : (
          <ul className="divide-y divide-slate-200">
            {[...d.enrollments, ...d.coverage].map((e) => <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span><span className="font-medium text-slate-900">{e.planName}</span><span className="block text-xs text-slate-500">{e.categoryName} · {e.planType === 'COVERAGE_ONLY' ? 'coverage' : 'monetary'}{e.coverageStart ? ` · from ${e.coverageStart}` : ''}{e.coverageEnd ? ` to ${e.coverageEnd}` : ''}</span></span><BenefitBadge status={e.status} /></li>)}
            {d.selectablePlans.filter((p) => p.enrollmentStatus !== 'ENROLLED').map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span><span className="font-medium text-slate-900">{p.name}</span><span className="block text-xs text-slate-500">{p.categoryName} · optional{p.eligible ? '' : ` · not eligible: ${p.reasons.join('; ')}`}</span></span><span className="flex gap-2">{p.eligible && <Button size="sm" onClick={async () => { try { await m.selfEnroll.mutateAsync(p.id); toast.success('Enrolled.'); } catch (e) { toast.error(errorMessage(e)); } }}>Enrol</Button>}{p.enrollmentStatus !== 'WAIVED' && <Button size="sm" variant="secondary" onClick={async () => { try { await m.waive.mutateAsync(p.id); toast.success('Waived.'); } catch (e) { toast.error(errorMessage(e)); } }}>Waive</Button>}</span></li>)}
          </ul>
        )}
      </Card>
      {creating && <NewClaimModal entitlements={openEntitlements} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {openId && <ClaimModal id={openId} onClose={() => setOpen(null)} />}
      {reviewing && <ReviewModal id={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

function NewClaimModal({ entitlements, onClose, onCreated }: { entitlements: BenefitEntitlementDto[]; onClose: () => void; onCreated: (id: string) => void }) {
  const m = useBenefitsMutations(); const toast = useToast();
  const [entId, setEntId] = useState(entitlements[0]?.id ?? ''); const [amount, setAmount] = useState(''); const [serviceDate, setServiceDate] = useState(new Date().toISOString().slice(0, 10)); const [description, setDescription] = useState(''); const [error, setError] = useState<string | null>(null);
  const ent = entitlements.find((e) => e.id === entId);
  const submit = async () => { if (!ent) return; setError(null); try { const c = await m.createClaim.mutateAsync({ planId: ent.planId, periodId: ent.periodId, claimedAmount: amount, serviceDate, description: description || null }); toast.success('Draft claim created. Attach your receipt, then submit.'); onCreated(c.id); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="New claim" description="Choose the benefit and period, the date of the expense and the amount. You attach the receipt and submit from the claim." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.createClaim.isPending} disabled={!ent || !amount} onClick={submit}>Create draft</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Select label="Benefit and period" options={entitlements.map((e) => ({ value: e.id, label: `${e.planName} · ${e.periodName}` }))} value={entId} onChange={(e) => setEntId(e.target.value)} />
        {ent && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"><div>Available <span className="font-semibold tabular-nums text-slate-900">{money(ent.balance.available, ent.balance.currency)}</span>{ent.perClaimMaximum && <> · per-claim maximum <span className="tabular-nums">{money(ent.perClaimMaximum)}</span></>}{ent.requiresDocument && ' · a receipt document is required'}</div></div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label={`Amount (${ent?.balance.currency ?? ''})`} inputMode="decimal" placeholder="1250.50" value={amount} onChange={(e) => setAmount(e.target.value)} /><Input label="Service date" type="date" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} /></div>
        <Textarea label="Description (optional)" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /><p className="text-xs text-slate-500">Do not enter passwords, medical diagnosis, or unnecessary sensitive personal information.</p>
      </div>
    </Modal>
  );
}
