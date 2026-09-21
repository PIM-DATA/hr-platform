import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'error' | 'success' | 'info';
const icons = { error: AlertCircle, success: CheckCircle2, info: Info };
const tones: Record<Tone, string> = {
  error: 'border-red-200 bg-red-50 text-red-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  info: 'border-sky-200 bg-sky-50 text-sky-800',
};

export function Alert({ tone = 'error', children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  const Icon = icons[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', tones[tone], className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
