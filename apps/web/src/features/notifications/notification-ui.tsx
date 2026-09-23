import { CalendarCheck, CalendarX, CheckCheck, Inbox, Send } from 'lucide-react';
import { NOTIFICATION_TYPES, type NotificationDto } from '@hr/shared';
import { cn } from '@/lib/utils';

const ICONS: Record<string, typeof Inbox> = {
  [NOTIFICATION_TYPES.APPROVAL_REQUIRED]: CheckCheck,
  [NOTIFICATION_TYPES.LEAVE_SUBMITTED]: Send,
  [NOTIFICATION_TYPES.LEAVE_APPROVED]: CalendarCheck,
  [NOTIFICATION_TYPES.LEAVE_REJECTED]: CalendarX,
};
const TONES: Record<string, string> = {
  [NOTIFICATION_TYPES.APPROVAL_REQUIRED]: 'bg-amber-100 text-amber-700',
  [NOTIFICATION_TYPES.LEAVE_APPROVED]: 'bg-emerald-100 text-emerald-700',
  [NOTIFICATION_TYPES.LEAVE_REJECTED]: 'bg-red-100 text-red-700',
};

export function NotificationIcon({ type, className }: { type: string; className?: string }) {
  const Icon = ICONS[type] ?? Inbox;
  return (
    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', TONES[type] ?? 'bg-slate-100 text-slate-500', className)} aria-hidden>
      <Icon className="h-4 w-4" />
    </span>
  );
}

/** Relative time for the inbox ("5 min ago"); exact timestamps stay on the record itself. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Where a notification points. Leave notifications reuse the Task 12 Leave screens via query params. */
export function notificationLink(n: NotificationDto): string | null {
  const requestId = n.data?.leaveRequestId ?? (n.source.entityType === 'LEAVE_REQUEST' ? n.source.entityId : null);
  if (!requestId) return null;
  return n.type === NOTIFICATION_TYPES.APPROVAL_REQUIRED
    ? `/hrm/leave/approvals?request=${requestId}`
    : `/hrm/leave?request=${requestId}`;
}

/** Unread is conveyed by text ("Unread") and weight, not colour alone. */
export function UnreadDot({ unread }: { unread: boolean }) {
  if (!unread) return null;
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium text-brand-700">
      <span className="h-1.5 w-1.5 rounded-full bg-brand-600" aria-hidden />
      Unread
    </span>
  );
}
