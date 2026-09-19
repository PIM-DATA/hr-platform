import { cn } from '@/lib/utils';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';

const tones: Record<Tone, string> = {
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  danger: 'bg-red-50 text-red-700 ring-red-600/20',
  info: 'bg-brand-50 text-brand-700 ring-brand-600/20',
};

/** Maps common status strings to a tone; pass `tone` to override. */
export function StatusBadge({ status, tone, className }: { status: string; tone?: Tone; className?: string }) {
  const resolved: Tone = tone ?? (
    /^(ACTIVE|OK|APPROVED|ONLINE)$/i.test(status) ? 'success'
    : /^(INACTIVE|DISABLED|TERMINATED|REJECTED)$/i.test(status) ? 'danger'
    : /^(PENDING|WAITING)$/i.test(status) ? 'warning'
    : 'neutral'
  );
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tones[resolved], className)}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
