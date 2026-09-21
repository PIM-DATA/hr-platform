import { useQuery } from '@tanstack/react-query';
import type { AuditListQuery, AuditLogDetail, AuditLogListItem, UserDto } from '@hr/shared';
import { api } from '@/lib/api-client';

function qs(q: Record<string, unknown>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  return p.toString();
}

export const useAuditLogs = (q: Partial<Record<keyof AuditListQuery, string | number>>) =>
  useQuery({ queryKey: ['audit', 'list', q], queryFn: () => api.get<AuditLogListItem[]>(`/audit-logs?${qs(q)}`), placeholderData: (p) => p });

export const useAuditLog = (id?: string) =>
  useQuery({ queryKey: ['audit', id], queryFn: () => api.get<AuditLogDetail>(`/audit-logs/${id}`).then((r) => r.data), enabled: !!id });

/** Actor picker source (requires users.view); small server-side search, never the whole directory. */
export const useUserSearch = (search: string, enabled: boolean) =>
  useQuery({ queryKey: ['users', 'search', search], queryFn: () => api.get<UserDto[]>(`/users?search=${encodeURIComponent(search)}&pageSize=10`).then((r) => r.data), enabled });
