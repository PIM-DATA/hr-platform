import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, LogOut, Menu } from 'lucide-react';
import { displayName, useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

interface TopbarProps {
  onMenuClick: () => void;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <button onClick={onMenuClick} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <div className="hidden text-sm text-slate-500 sm:block">HR Enterprise Platform</div>
      </div>

      <div className="flex items-center gap-1">
        <button className="rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
          <Bell className="h-5 w-5" />
        </button>
        <UserMenu />
      </div>
    </header>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const name = displayName(user);
  const initials = name
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');
  const roleLabel = user?.roles.map((r) => r.name).join(', ') || '—';

  const onLogout = async () => {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
      navigate('/login', { replace: true });
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-100', open && 'bg-slate-100')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">{initials}</span>
        <span className="hidden text-left sm:block">
          <span className="block max-w-[160px] truncate font-medium text-slate-800">{name}</span>
          <span className="block max-w-[160px] truncate text-xs text-slate-500">{roleLabel}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          <div className="border-b border-slate-100 px-3 py-2 sm:hidden">
            <div className="truncate text-sm font-medium text-slate-800">{name}</div>
            <div className="truncate text-xs text-slate-500">{roleLabel}</div>
          </div>
          <div className="truncate px-3 py-2 text-xs text-slate-500">{user?.email}</div>
          <button
            role="menuitem"
            onClick={onLogout}
            disabled={busy}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
