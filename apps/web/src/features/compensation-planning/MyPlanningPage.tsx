import { useEffect, useState } from 'react';
import type { CompRowDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useCompMutations, useMyCycles, useMyPlan } from './comp.api';
import { CompBadge, HIGH_IMPACT_NOTE, Stat, money } from './comp-ui';

const MONEY = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * The planner's sheet: only the rows assigned to the caller. One input per person — the proposed base salary; the
 * increase and percentage come back from the server. No suggested value, no default increase, no ranking: rows are
 * ordered by department and name.
 */
export function MyPlanningPage() {
  const cycles = useMyCycles();
  const [cycleId, setCycleId] = useState<string>();
  useEffect(() => { if (!cycleId && cycles.data?.length) setCycleId(cycles.data[0]!.id); }, [cycles.data, cycleId]);
  const plan = useMyPlan(cycleId);
  const mut = useCompMutations();
  const toast = useToast();
  const [submitOpen, setSubmitOpen] = useState(false);

  if (cycles.isLoading) return <LoadingBlock />;
  if (!cycles.data?.length) return <p className="text-sm text-slate-500">No salary review is assigned to you right now.</p>;
  const d = plan.data;
  const submit = async () => {
    try { const r = await mut.submitMine.mutateAsync(cycleId!); toast.success('Plan submitted', `${r.submitted} row(s) sent to HR.`); setSubmitOpen(false); }
    catch (e) { toast.error('Could not submit', errorMessage(e)); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">{HIGH_IMPACT_NOTE}</p>
      {cycles.data.length > 1 && <div className="max-w-sm"><Select label="Salary review" value={cycleId ?? ''} onChange={(e) => setCycleId(e.target.value)} options={cycles.data.map((c) => ({ value: c.id, label: `${c.name} (${c.status.toLowerCase()})` }))} /></div>}
      {plan.isLoading && <LoadingBlock />}
      {plan.isError && <Alert>{errorMessage(plan.error)}</Alert>}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Review" value={<span className="text-base">{d.cycle.name}</span>} hint={`Effective ${d.cycle.effectiveDate} · ${d.cycle.currency}`} />
            <Stat label="People" value={d.totals.rows} hint={`${d.totals.addressed} with a proposal · ${d.totals.submitted} submitted`} />
            <Stat label="Current base (your group)" value={money(d.totals.currentBase)} hint={d.cycle.currency} />
            <Stat label="Proposed increase" value={money(d.totals.increase)} hint={`New base ${money(d.totals.proposedBase)}`} />
            <Stat label="Status" value={<CompBadge status={d.cycle.status} />} hint={d.canEdit ? 'You can edit rows that are not submitted' : 'Nothing to edit right now'} />
          </div>
          <Card>
            <CardHeader title="Planning sheet" description="Enter the proposed monthly base salary. Enter the current salary for no change. Decreases are not part of a salary review." />
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50"><tr>{['Employee', 'Job', 'Current salary', 'Proposed salary', 'Increase', 'Increase %', 'Performance context', 'Status', ''].map((h) => <th key={h} scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{d.rows.map((r) => <PlanRow key={r.id} row={r} editable={d.canEdit && canEditRow(d.cycle.status, r.status)} layout="table" />)}</tbody>
              </table>
            </div>
            <div className="divide-y divide-slate-100 md:hidden">{d.rows.map((r) => <PlanRow key={r.id} row={r} editable={d.canEdit && canEditRow(d.cycle.status, r.status)} layout="card" />)}</div>
            <div className="flex flex-col gap-2 border-t border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-500">Performance context is the latest finalized review, shown as a fact. It does not calculate or suggest anything.</p>
              {d.canSubmit && <Button onClick={() => setSubmitOpen(true)}>Submit my plan</Button>}
            </div>
          </Card>
        </>
      )}
      <ConfirmDialog open={submitOpen} title="Submit your plan?" message="Every row you plan must have a proposed salary. After submitting you cannot edit unless HR returns a row to you." confirmLabel="Submit" loading={mut.submitMine.isPending} onConfirm={submit} onCancel={() => setSubmitOpen(false)} />
    </div>
  );
}

const canEditRow = (cycleStatus: string, status: string | null) => (cycleStatus === 'ACTIVE' ? ['NOT_STARTED', 'DRAFT', 'RETURNED'].includes(status ?? '') : cycleStatus === 'REVIEW' && status === 'RETURNED');

function PlanRow({ row, editable, layout }: { row: CompRowDto; editable: boolean; layout: 'table' | 'card' }) {
  const mut = useCompMutations();
  const toast = useToast();
  const [value, setValue] = useState(row.proposedBaseSalary ?? '');
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState(row.managerComment ?? '');
  useEffect(() => { setValue(row.proposedBaseSalary ?? ''); setComment(row.managerComment ?? ''); }, [row.proposedBaseSalary, row.managerComment]);
  const plannable = row.eligibility === 'ELIGIBLE' && !!row.proposalId;
  const invalid = value !== '' && !MONEY.test(value.trim());
  const dirty = value.trim() !== (row.proposedBaseSalary ?? '');
  const save = async (withComment?: string | null) => {
    try {
      await mut.saveProposal.mutateAsync({ proposalId: row.proposalId!, proposedBaseSalary: value.trim(), ...(withComment !== undefined ? { managerComment: withComment } : {}) });
      toast.success('Saved', row.employee.name);
    } catch (e) { toast.error('Could not save', errorMessage(e)); }
  };
  const input = plannable && editable
    ? <div className="flex items-center gap-2"><input aria-label={`Proposed salary for ${row.employee.name}`} inputMode="decimal" className={`w-32 rounded-md border px-2 py-1 text-right tabular-nums ${invalid ? 'border-red-400' : 'border-slate-300'}`} value={value} placeholder={row.currentBaseSalary ?? ''} onChange={(e) => setValue(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={!dirty || invalid || !value} loading={mut.saveProposal.isPending} onClick={() => save()}>Save</Button></div>
    : <span className="tabular-nums">{money(row.proposedBaseSalary)}</span>;
  const perf = row.performance ? `${row.performance.rating ?? '—'}${row.performance.score ? ` (${row.performance.score})` : ''} · ${row.performance.cycleName}` : '—';
  const status = plannable ? <CompBadge status={row.status ?? 'NOT_STARTED'} /> : <CompBadge status={row.eligibility} />;
  const commentButton = plannable && editable && <Button size="sm" variant="ghost" onClick={() => setCommentOpen(true)}>{row.managerComment ? 'Edit note' : 'Add note'}</Button>;
  const modal = (
    <Modal open={commentOpen} onClose={() => setCommentOpen(false)} title={`Note for ${row.employee.name}`} description="Optional and confidential: seen by you and HR review only, never in reports, notifications or the employee's data export."
      footer={<><Button variant="secondary" onClick={() => setCommentOpen(false)}>Cancel</Button><Button disabled={!MONEY.test((value || row.currentBaseSalary || '').trim())} onClick={async () => { if (!value) setValue(row.currentBaseSalary ?? ''); await mut.saveProposal.mutateAsync({ proposalId: row.proposalId!, proposedBaseSalary: (value || row.currentBaseSalary || '').trim(), managerComment: comment.trim() || null }).then(() => { toast.success('Note saved'); setCommentOpen(false); }).catch((e) => toast.error('Could not save', errorMessage(e))); }}>Save note</Button></>}>
      <Textarea label="Note" maxLength={500} rows={4} value={comment} onChange={(e) => setComment(e.target.value)} />
      <p className="mt-2 text-xs text-slate-500">Saving a note also saves the proposed salary shown in the row (the current salary if none was entered).</p>
    </Modal>
  );
  if (layout === 'card') return (
    <div className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-2"><div><div className="font-medium text-slate-900">{row.employee.name}</div><div className="text-xs text-slate-500">{row.employee.code} · {row.job ?? '—'}</div></div>{status}</div>
      <div className="grid grid-cols-2 gap-2 text-sm"><div><div className="text-xs text-slate-500">Current</div><div className="tabular-nums">{money(row.currentBaseSalary)}</div></div><div><div className="text-xs text-slate-500">Increase</div><div className="tabular-nums">{money(row.increaseAmount)}{row.increasePercent ? ` (${row.increasePercent}%)` : ''}</div></div></div>
      <div><div className="mb-1 text-xs text-slate-500">Proposed salary</div>{input}</div>
      <div className="text-xs text-slate-500">Performance context: {perf}</div>
      {commentButton}{modal}
    </div>
  );
  return (
    <tr>
      <td className="px-3 py-2"><div className="font-medium text-slate-900">{row.employee.name}</div><div className="text-xs text-slate-500">{row.employee.code}</div></td>
      <td className="px-3 py-2">{row.job ?? '—'}</td>
      <td className="px-3 py-2 tabular-nums">{money(row.currentBaseSalary)}</td>
      <td className="px-3 py-2">{input}</td>
      <td className="px-3 py-2 tabular-nums">{money(row.increaseAmount)}</td>
      <td className="px-3 py-2 tabular-nums">{row.increasePercent ? `${row.increasePercent}%` : '—'}</td>
      <td className="px-3 py-2 text-xs text-slate-600">{perf}</td>
      <td className="px-3 py-2">{status}</td>
      <td className="px-3 py-2">{commentButton}{modal}</td>
    </tr>
  );
}

