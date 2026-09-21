import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface TabItem {
  label: string;
  to: string;
  end?: boolean;
}

/** Route-based tabs (each tab is a nested route). */
export function Tabs({ items }: { items: TabItem[] }) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="Tabs">
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn(
              'whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
