import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-slate-200 bg-white shadow-sm', className)} {...rest} />;
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border-b border-slate-200 px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
    </div>
  );
}
