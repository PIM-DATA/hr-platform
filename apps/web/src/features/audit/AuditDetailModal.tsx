import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { AUDIT_MODULE_LABELS, auditActionLabel } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { PermissionGuard } from '@/components/guards/PermissionGuard';
import { formatDateTime } from '@/lib/format';
import { buildFieldDiff, formatDiffValue } from '@/lib/diff';
import { cn } from '@/lib/utils';
import { useAuditLog } from './audit.api';
import { recordLink } from './recordLink';

export function AuditDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useAuditLog(id ?? undefined);
  const [rawOpen, setRawOpen] = useState(false);
  const rows = useMemo(() => (detail.data ? buildFieldDiff(detail.data.oldValue, detail.data.newValue) : []), [detail.data]);
  const d = detail.data;
  const link = d ? recordLink(d.recordType, d.recordId) : null;

  return (
    <Modal open={!!id} onClose={onClose} title={d ? auditActionLabel(d.action) : 'Audit entry'} description={d ? `${AUDIT_MODULE_LABELS[d.module] ?? d.module} · ${formatDateTime(d.createdAt)}` : undefined} size="lg">
      {detail.isLoading ? (
        <LoadingBlock />
      ) : detail.isError || !d ? (
        <Alert>Could not load this audit entry.</Alert>
      ) : (
        <div className="space-y-5">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row label="Actor">{d.actor ? <span>{d.actor.email} <span className="font-mono text-xs text-slate-400">{d.actor.userId}</span></span> : <span className="italic text-slate-500">System</span>}</Row>
            <Row label="Timestamp"><span title={d.createdAt}>{formatDateTime(d.createdAt)}</span> <span className="font-mono text-xs text-slate-400">{d.createdAt}</span></Row>
            <Row label="Module">{AUDIT_MODULE_LABELS[d.module] ?? d.module}</Row>
            <Row label="Action"><span className="font-mono text-xs">{d.action}</span></Row>
            <Row label="Record">
              {d.recordType}{d.recordId && <span className="ml-1 font-mono text-xs text-slate-500">{d.recordId}</span>}
              {link && (
                <PermissionGuard permission={link.permission}>
                  <Link to={link.to} onClick={onClose} className="ml-2 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">View record <ExternalLink className="h-3 w-3" /></Link>
                </PermissionGuard>
              )}
            </Row>
            <Row label="IP address">{d.ipAddress ?? '—'}</Row>
            <Row label="User agent"><span className="break-all text-xs text-slate-600">{d.userAgent ?? '—'}</span></Row>
          </dl>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Changes</h3>
            {rows.length === 0 ? (
              <p className="text-sm text-slate-500">No payload recorded for this event.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr><th className="px-3 py-2 text-left">Field</th><th className="px-3 py-2 text-left">Before</th><th className="px-3 py-2 text-left">After</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r) => (
                      <tr key={r.field} className={cn(r.changed && 'bg-amber-50/40')}>
                        <td className="px-3 py-2 align-top font-mono text-xs text-slate-700">{r.field}</td>
                        <td className="px-3 py-2 align-top"><Value v={r.before} tone="before" /></td>
                        <td className="px-3 py-2 align-top"><Value v={r.after} tone="after" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <button onClick={() => setRawOpen((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900">
              {rawOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Raw JSON (redacted)
            </button>
            {rawOpen && (
              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(d.oldValue, null, 2) ?? 'null'}</pre>
                <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(d.newValue, null, 2) ?? 'null'}</pre>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  );
}

function Value({ v, tone }: { v: unknown; tone: 'before' | 'after' }) {
  const text = formatDiffValue(v);
  const isComplex = typeof v === 'object' && v !== null;
  if (v === undefined) return <span className="text-slate-400">—</span>;
  return isComplex ? <pre className="max-w-xs whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-xs">{text}</pre>
    : <span className={cn('break-all', tone === 'before' ? 'text-slate-600' : 'text-slate-900')}>{text}</span>;
}
