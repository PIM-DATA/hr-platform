import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationDto } from '@hr/shared';
import { api } from '@/lib/api-client';

const qs = (q: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  return p.toString();
};

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (f: Record<string, unknown>) => ['notifications', 'list', f] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
  latest: ['notifications', 'latest'] as const,
};

/** Polled once a minute and on window focus — Phase 2 has no websocket/SSE by design. */
export const useUnreadCount = (enabled = true) =>
  useQuery({
    queryKey: notificationKeys.unreadCount,
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count').then((r) => r.data.count),
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

export const useLatestNotifications = (enabled: boolean) =>
  useQuery({ queryKey: notificationKeys.latest, queryFn: () => api.get<NotificationDto[]>('/notifications/latest').then((r) => r.data), enabled });

export const useNotifications = (f: Record<string, unknown>) =>
  useQuery({ queryKey: notificationKeys.list(f), queryFn: () => api.get<NotificationDto[]>(`/notifications?${qs(f)}`), placeholderData: (p) => p });

export function useNotificationMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: notificationKeys.all });
  return {
    markRead: useMutation({ mutationFn: (id: string) => api.post<NotificationDto>(`/notifications/${id}/read`).then((r) => r.data), onSuccess: invalidate }),
    markAllRead: useMutation({ mutationFn: () => api.post<{ updated: number }>('/notifications/read-all').then((r) => r.data), onSuccess: invalidate }),
  };
}
