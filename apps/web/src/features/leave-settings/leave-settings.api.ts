import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HolidayDto, LeavePolicyDto, LeaveTypeDto, LeaveWorkflowOptionDto, WorkCalendarDto } from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'leave-settings';
const qs = (q: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };

export const useCalendars = (q: Record<string, unknown> = {}) => useQuery({ queryKey: [KEY, 'calendars', q], queryFn: () => api.get<WorkCalendarDto[]>(`/calendars?${qs({ pageSize: 100, ...q })}`), placeholderData: (p) => p });
export const useHolidays = (calendarId?: string, year?: number) => useQuery({ queryKey: [KEY, 'holidays', calendarId, year], queryFn: () => api.get<HolidayDto[]>(`/calendars/${calendarId}/holidays?${qs({ year })}`).then((r) => r.data), enabled: !!calendarId });
export const useLeaveTypes = (q: Record<string, unknown> = {}) => useQuery({ queryKey: [KEY, 'types', q], queryFn: () => api.get<LeaveTypeDto[]>(`/leave/types?${qs({ pageSize: 100, ...q })}`), placeholderData: (p) => p });
export const useLeavePolicies = (q: Record<string, unknown> = {}) => useQuery({ queryKey: [KEY, 'policies', q], queryFn: () => api.get<LeavePolicyDto[]>(`/leave/policies?${qs({ pageSize: 100, ...q })}`), placeholderData: (p) => p });
export const useLeaveWorkflowOptions = (enabled = true) => useQuery({ queryKey: [KEY, 'workflow-options'], queryFn: () => api.get<LeaveWorkflowOptionDto[]>('/leave/workflow-options').then((r) => r.data), enabled });

/** Generic mutation set for a REST resource path (create/update/activate/deactivate); invalidates the leave-settings + organization caches. */
export function useResourceMutations<T>(base: string) {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['organization'] }); };
  return {
    create: useMutation({ mutationFn: (input: unknown) => api.post<T>(base, input).then((r) => r.data), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: unknown }) => api.patch<T>(`${base}/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    activate: useMutation({ mutationFn: (id: string) => api.patch<T>(`${base}/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    deactivate: useMutation({ mutationFn: (id: string) => api.patch<T>(`${base}/${id}/deactivate`).then((r) => r.data), onSuccess: invalidate }),
  };
}
export function useCalendarExtras() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['organization'] }); };
  return {
    setDefault: useMutation({ mutationFn: ({ organizationId, calendarId }: { organizationId: string; calendarId: string | null }) => api.patch(`/calendars/organizations/${organizationId}/default`, { calendarId }), onSuccess: invalidate }),
    createHoliday: useMutation({ mutationFn: ({ calendarId, input }: { calendarId: string; input: unknown }) => api.post<HolidayDto>(`/calendars/${calendarId}/holidays`, input).then((r) => r.data), onSuccess: invalidate }),
    holidayActive: useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch<HolidayDto>(`/holidays/${id}/${active ? 'activate' : 'deactivate'}`).then((r) => r.data), onSuccess: invalidate }),
  };
}
