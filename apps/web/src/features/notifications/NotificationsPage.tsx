import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { Spinner } from '@/components/ui/Spinner';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useNotificationMutations, useNotifications, useUnreadCount } from './notification.api';
import { NotificationIcon, UnreadDot, notificationLink, relativeTime } from './notification-ui';

/** Full notification inbox. Everything here belongs to the signed-in user — there is no admin view of other inboxes. */
export function NotificationsPage() {
  const [status, setStatus] = useState<'all' | 'unread'>('all');
  const [page, setPage] = useState(1);
  const list = useNotifications({ status, page, pageSize: 20 });
  const unread = useUnreadCount();
  const m = useNotificationMutations();
  const navigate = useNavigate();

  const open = async (n: NotificationDto) => {
    if (!n.readAt) await m.markRead.mutateAsync(n.id).catch(() => undefined);
    const to = notificationLink(n);
    if (to) navigate(to);
  };

  return (
    <>
      <PageHeader title="Notifications" description="Updates about your leave requests and approvals waiting for you." />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
          <div className="flex gap-1" role="tablist" aria-label="Filter notifications">
            {(['all', 'unread'] as const).map((s) => (
              <button
                key={s} role="tab" aria-selected={status === s} type="button"
                onClick={() => { setStatus(s); setPage(1); }}
                className={cn('rounded-md px-3 py-1.5 text-sm font-medium', status === s ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-700')}
              >
                {s === 'all' ? 'All' : `Unread${unread.data ? ` (${unread.data})` : ''}`}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" disabled={!unread.data || m.markAllRead.isPending} loading={m.markAllRead.isPending} onClick={() => m.markAllRead.mutate()}>
            Mark all as read
          </Button>
        </div>
        {list.isError && <Alert className="m-4">Could not load your notifications.</Alert>}
        {list.isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (list.data?.data.length ?? 0) === 0 ? (
          <EmptyState title={status === 'unread' ? 'No unread notifications' : 'No notifications yet'} description="You will be notified when a leave request needs your approval or when yours is decided." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data!.data.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => open(n)} className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/40')}>
                  <NotificationIcon type={n.type} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-sm', n.readAt ? 'text-slate-700' : 'font-semibold text-slate-900')}>{n.title}</span>
                    <span className="block text-sm text-slate-600">{n.body}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                      <UnreadDot unread={!n.readAt} />
                      <span title={formatDateTime(n.createdAt)}>{relativeTime(n.createdAt)}</span>
                    </span>
                  </span>
                  {!n.readAt && (
                    <span onClick={(e) => { e.stopPropagation(); m.markRead.mutate(n.id); }} className="shrink-0 self-center text-xs font-medium text-brand-700 hover:underline">Mark as read</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
    </>
  );
}
