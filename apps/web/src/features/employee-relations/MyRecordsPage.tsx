import { useState } from 'react';
import { FileText, Printer } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useErMutations, useMyRecord, useMyRecords } from './er.api';
import { ValidityBadge, WarningLetterView } from './er-ui';

/**
 * What an employee sees: the documents issued to them, and nothing else — no drafts, no case narrative, no proposals
 * that were refused. Acknowledging here means "I have received this", and the screen says so before the button.
 */
export function MyRecordsPage() {
  const records = useMyRecords();
  const [openId, setOpenId] = useState<string | null>(null);
  if (records.isLoading) return <LoadingBlock />;
  if (records.isError) return <Alert>Could not load your records.</Alert>;
  const rows = records.data ?? [];

  return (
    <>
      <Card>
        {rows.length === 0 ? (
          <EmptyState icon={<FileText className="h-6 w-6" />} title="No documents" description="Nothing has been issued to you." />
        ) : (
          <ul className="divide-y divide-slate-200">
            {rows.map((r) => (
              <li key={r.id}>
                <button onClick={() => setOpenId(r.id)} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-slate-50 sm:px-5">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">{r.letter?.subject ?? r.actionTypeName}</span>
                    <span className="block text-xs text-slate-500">Issued {r.issuedDate} · {r.caseNumber}{r.validUntil && ` · on record until ${r.validUntil}`}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <ValidityBadge validity={r.validity} />
                    {r.requiresAcknowledgement && (r.acknowledgedAt
                      ? <span className="text-xs text-emerald-700">Receipt acknowledged {r.acknowledgedAt.slice(0, 10)}</span>
                      : <span className="text-xs text-amber-700">Receipt not yet acknowledged</span>)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <RecordModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function RecordModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const record = useMyRecord(id);
  const m = useErMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = record.data;

  const acknowledge = async () => {
    setErr(null);
    try { await m.acknowledge.mutateAsync(r!.id); toast.success('Receipt acknowledged'); setConfirm(false); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <>
      <Modal open={!!id} onClose={onClose} title={r?.letter?.subject ?? r?.actionTypeName ?? 'Document'} description={r ? `${r.caseNumber} · issued ${r.issuedDate}` : undefined} size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {r?.letter && <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>}
            {r?.requiresAcknowledgement && !r.acknowledgedAt && <Button onClick={() => setConfirm(true)}>Acknowledge receipt</Button>}
          </>
        }
      >
        {record.isLoading && <LoadingBlock />}
        {record.isError && <Alert>Could not load this document.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {r && (
          <div className="space-y-4">
            {r.letter ? <WarningLetterView letter={r.letter} printId="payslip-print" /> : (
              <p className="text-sm text-slate-600">A {r.actionTypeName.toLowerCase()} was recorded on {r.issuedDate}. This action type does not produce a letter.</p>
            )}
            {r.requiresAcknowledgement && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Acknowledging receipt means you have received this document.</p>
                <p className="mt-1">It does not mean you agree with its contents or admit to what it describes. If you wish to respond, follow your organization's process.</p>
                {r.acknowledgementDueDate && !r.acknowledgedAt && <p className="mt-1 text-xs text-slate-500">Requested by {r.acknowledgementDueDate}.</p>}
                {r.acknowledgedAt && <p className="mt-1 text-xs text-emerald-700">You acknowledged receipt on {r.acknowledgedAt.slice(0, 10)}.</p>}
              </div>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={confirm}
        title="Acknowledge receipt"
        message="This records that you have received the document. It is not an admission and does not mean you agree with it."
        confirmLabel="I have received this document"
        loading={m.acknowledge.isPending}
        error={err}
        onConfirm={acknowledge}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
