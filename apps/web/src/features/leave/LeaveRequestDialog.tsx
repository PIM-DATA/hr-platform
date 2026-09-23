import { useEffect, useState } from 'react';
import { CalendarClock, Info } from 'lucide-react';
import type { LeaveRequestDto, LeaveRequestPreviewDto } from '@hr/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useLeaveMutations, useLeaveTypeOptions } from './leave.api';
import { formatBusinessDate, formatLeaveUnits, leaveErrorMessage } from './leave-ui';

type Form = { leaveTypeId: string; startDate: string; endDate: string; startPart: 'FULL' | 'PM'; endPart: 'FULL' | 'AM'; reason: string; attachmentRef: string };
const emptyForm = (): Form => ({ leaveTypeId: '', startDate: '', endDate: '', startPart: 'FULL', endPart: 'FULL', reason: '', attachmentRef: '' });
const formOf = (r: LeaveRequestDto): Form => ({ leaveTypeId: r.leaveType.id, startDate: r.startDate, endDate: r.endDate, startPart: r.startPart, endPart: r.endPart, reason: r.reason ?? '', attachmentRef: r.attachmentRef ?? '' });
/** Fields that change what the server would calculate — any edit makes an existing preview stale. */
const previewInputs = (f: Form) => [f.leaveTypeId, f.startDate, f.endDate, f.startPart, f.endPart, f.reason.trim(), f.attachmentRef.trim()].join('|');

/**
 * Create or edit a leave request. The server is the only calculator: units, policy, calendar, balance and workflow all
 * come from `POST /leave/requests/preview`. Submitting goes through the real lifecycle (create draft → submit), and the
 * preview is never treated as a guarantee — submit revalidates everything and its error is shown here.
 */
export function LeaveRequestDialog({ open, request, onClose, onOpenDetail }: { open: boolean; request?: LeaveRequestDto; onClose: () => void; onOpenDetail?: (id: string) => void }) {
  const m = useLeaveMutations();
  const toast = useToast();
  const types = useLeaveTypeOptions();
  const [form, setForm] = useState<Form>(emptyForm);
  const [preview, setPreview] = useState<{ key: string; data: LeaveRequestPreviewDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(request ? formOf(request) : emptyForm());
    setPreview(null); setError(null); setPreviewError(null);
  }, [open, request]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value, ...(key === 'startDate' && !f.endDate ? { endDate: value as string } : {}) }));
  const complete = !!form.leaveTypeId && !!form.startDate && !!form.endDate && form.startDate <= form.endDate;
  const stale = !preview || preview.key !== previewInputs(form);
  const payload = () => ({ leaveTypeId: form.leaveTypeId, startDate: form.startDate, endDate: form.endDate, startPart: form.startPart, endPart: form.endPart, reason: form.reason.trim() || null, attachmentRef: form.attachmentRef.trim() || null });
  const busy = m.preview.isPending || m.create.isPending || m.update.isPending || m.submit.isPending;

  const runPreview = async () => {
    setPreviewError(null); setError(null);
    try { setPreview({ key: previewInputs(form), data: await m.preview.mutateAsync(payload()) }); }
    catch (e) { setPreview(null); setPreviewError(leaveErrorMessage(e)); }
  };
  /** Saves the draft (create or update) and returns its id. */
  const saveDraft = async () => (request ? (await m.update.mutateAsync({ id: request.id, input: payload() })).id : (await m.create.mutateAsync(payload())).id);

  const onSaveDraft = async () => {
    setError(null);
    try { const id = await saveDraft(); toast.success('Draft saved', 'You can submit it any time from My leave.'); onClose(); onOpenDetail?.(id); }
    catch (e) { setError(leaveErrorMessage(e)); }
  };
  const onSubmit = async () => {
    setError(null);
    try {
      const id = await saveDraft();
      const submitted = await m.submit.mutateAsync(id);
      toast.success(submitted.status === 'APPROVED' ? 'Leave approved' : 'Leave request submitted', `${formatLeaveUnits(submitted.units)} day(s) · ${submitted.status === 'APPROVED' ? 'auto-approved' : 'waiting for approval'}`);
      onClose(); onOpenDetail?.(id);
    } catch (e) {
      // the request stays a draft; balances/preview may have changed since the preview, so refresh and ask for a new one
      setError(leaveErrorMessage(e));
      setPreview(null);
    }
  };

  const p = preview?.data;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={request ? 'Edit leave request' : 'New leave request'}
      description="Days, policy rules and the approval route are calculated by the server. Preview before submitting."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={onSaveDraft} loading={m.create.isPending || m.update.isPending} disabled={!complete || busy}>Save draft</Button>
          <Button onClick={onSubmit} loading={m.submit.isPending} disabled={!complete || stale || busy}>Submit</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Select label="Leave type" required value={form.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)} placeholder="Select a leave type…"
          options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        {types.isError && <p className="text-xs text-slate-500">Leave types could not be loaded. Please contact HR if this persists.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Start date" type="date" required value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          <Select label="First day" value={form.startPart} onChange={(e) => set('startPart', e.target.value as 'FULL' | 'PM')}
            options={[{ value: 'FULL', label: 'Full day' }, { value: 'PM', label: 'Afternoon only (PM)' }]} />
          <Input label="End date" type="date" required value={form.endDate} min={form.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} />
          <Select label="Last day" value={form.endPart} onChange={(e) => set('endPart', e.target.value as 'FULL' | 'AM')}
            options={[{ value: 'FULL', label: 'Full day' }, { value: 'AM', label: 'Morning only (AM)' }]} />
        </div>
        <Textarea label="Reason" rows={2} value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Optional unless the leave type requires one" />
        <Input label="Attachment reference" value={form.attachmentRef} onChange={(e) => set('attachmentRef', e.target.value)}
          placeholder="e.g. a document number (file upload is not available yet)" />

        <div className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-slate-900"><CalendarClock className="h-4 w-4 text-slate-400" /> Preview</h3>
            <Button size="sm" variant="secondary" onClick={runPreview} loading={m.preview.isPending} disabled={!complete || busy}>{stale ? 'Preview' : 'Refresh preview'}</Button>
          </div>
          {previewError && <Alert className="mt-3">{previewError}</Alert>}
          {!p && !previewError && <p className="mt-2 text-sm text-slate-500">Choose a leave type and dates, then preview to see the days, your balance and who approves it.</p>}
          {p && stale && <p className="mt-2 flex items-start gap-1.5 text-sm text-amber-700"><Info className="mt-0.5 h-4 w-4 shrink-0" /> The request changed — preview again before submitting.</p>}
          {p && !stale && (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Leave</dt><dd className="text-right font-medium text-slate-900">{p.leaveType.name}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Working days</dt><dd className="text-right font-semibold tabular-nums text-slate-900">{formatLeaveUnits(p.units)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Available now</dt><dd className="text-right tabular-nums">{formatLeaveUnits(p.entitlement.available)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Remaining after</dt><dd className={`text-right font-semibold tabular-nums ${p.remainingAfter < 0 ? 'text-red-600' : 'text-slate-900'}`}>{formatLeaveUnits(p.remainingAfter)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Entitlement period</dt><dd className="text-right text-slate-700">{formatBusinessDate(p.entitlement.periodStart)} → {formatBusinessDate(p.entitlement.periodEnd)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Work calendar</dt><dd className="text-right text-slate-700">{p.calendar.name}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Approval</dt><dd className="text-right text-slate-700">{p.workflow.name}</dd></div>
              <div className="border-t border-slate-100 pt-2">
                <dt className="text-slate-500">Rules for {p.policy.name}</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {[
                    p.policy.requiresReason && 'Reason required',
                    p.policy.requiresAttachment && 'Attachment required',
                    !p.policy.allowHalfDay && 'No half days',
                    !p.policy.allowBackdate && 'No backdating',
                    p.policy.minNoticeDays ? `${p.policy.minNoticeDays} day(s) notice` : null,
                    p.policy.maxConsecutiveDays ? `Max ${p.policy.maxConsecutiveDays} consecutive day(s)` : null,
                    p.policy.allowNegativeBalance && 'Negative balance allowed',
                  ].filter(Boolean).map((rule) => (
                    <span key={rule as string} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{rule}</span>
                  ))}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </Modal>
  );
}
