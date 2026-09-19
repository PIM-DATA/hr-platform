import { Bell, Menu, UserCircle2 } from 'lucide-react';

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
        <div className="text-sm text-slate-500 hidden sm:block">HR Enterprise Platform</div>
      </div>

      <div className="flex items-center gap-2">
        <button className="rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
          <Bell className="h-5 w-5" />
        </button>
        {/* Task 2: current user name + role + logout menu */}
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700">
          <UserCircle2 className="h-6 w-6 text-slate-400" />
          <span className="hidden sm:block">Guest</span>
        </div>
      </div>
    </header>
  );
}
