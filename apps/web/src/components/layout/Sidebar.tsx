import { NavLink } from 'react-router-dom';
import { Building2, X } from 'lucide-react';
import { MENU, type MenuItem } from '@/config/menu';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  // Items with a `permission` are shown only when the user has it; groups without visible items disappear.
  // (UX only — every API endpoint enforces permissions itself.)
  const { hasPermission } = useAuth();
  const allowed = (p: MenuItem['permission']) => !p || (Array.isArray(p) ? p.some(hasPermission) : hasPermission(p));
  const groups = MENU.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.permission)) })).filter((g) => g.items.length > 0);

  return (
    <>
      {/* mobile overlay */}
      {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-900/60 lg:hidden" onClick={onClose} aria-hidden />}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-sidebar text-sidebar-text transition-transform duration-200 lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white">
              <Building2 className="h-4.5 w-4.5" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-white">HR Platform</div>
              <div className="text-[11px] text-slate-400">Enterprise</div>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-sidebar-hover hover:text-white lg:hidden" aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {groups.map((group, gi) => (
            <div key={group.label ?? gi} className={cn(gi > 0 && 'mt-5')}>
              {group.label && (
                <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{group.label}</div>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.path}>
                    <SidebarLink item={item} onNavigate={onClose} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-white/10 px-5 py-3 text-[11px] text-slate-500">v0.1.0 · Phase 1</div>
      </aside>
    </>
  );
}

function SidebarLink({ item, onNavigate }: { item: MenuItem; onNavigate: () => void }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-600 text-white' : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0 opacity-80" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.comingSoon && (
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-300 group-hover:bg-white/15">Soon</span>
      )}
    </NavLink>
  );
}
