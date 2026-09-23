import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import type { NotificationDto } from '@hr/shared';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { useLatestNotifications, useNotificationMutations, useUnreadCount } from './notification.api';
import { NotificationIcon, UnreadDot, notificationLink, relativeTime } from './notification-ui';

/**
 * Topbar bell: unread badge (hidden at 0, "99+" from 100) plus the ten newest notifications.
 * The count is polled every 60s and on window focus — no websocket/SSE in this phase. Notification queries are
 * user-scoped and the whole query cache is cleared on login/logout/401, so one user never sees another's inbox.
 */
export function NotificationBell() {
  const { status } = useAuth();
  const authenticated = status === 'authenticated';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const unread = useUnreadCount(authenticated);
  const latest = useLatestNotifications(open);
  const m = useNotificationMutations();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const count = unread.data ?? 0;
  const badge = count > 99 ? '99+' : String(count);

  const openNotification = async (n: NotificationDto) => {
    setOpen(false);
    if (!n.readAt) await m.markRead.mutateAsync(n.id).catch(() => undefined); // navigation must not depend on the read call
    const to = notificationLink(n);
    navigate(to ?? '/notifications');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-slate-500 hover:bg-slate-100"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">{badge}</span>
        )}
      </button>

      {open && (
        <div role="menu" aria-label="Notifications" className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <span className="text-sm font-semibold text-slate-900">Notifications</span>
            {count > 0 && (
              <button type="button" className="text-xs font-medium text-brand-700 hover:underline disabled:opacity-50" disabled={m.markAllRead.isPending} onClick={() => m.markAllRead.mutate()}>
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {latest.isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
            {latest.data?.length === 0 && <p className="px-3 py-8 text-center text-sm text-slate-500">No notifications yet</p>}
            <ul>
              {(latest.data ?? []).map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => openNotification(n)} className={cn('flex w-full gap-3 px-3 py-2.5 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/40')}>
                    <NotificationIcon type={n.type} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm', n.readAt ? 'text-slate-700' : 'font-semibold text-slate-900')}>{n.title}</span>
                      <span className="block text-xs text-slate-500">{n.body}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400"><UnreadDot unread={!n.readAt} />{relativeTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-slate-200 p-2">
            <Button variant="secondary" size="sm" className="w-full" onClick={() => { setOpen(false); navigate('/notifications'); }}>View all notifications</Button>
          </div>
        </div>
      )}
    </div>
  );
}
