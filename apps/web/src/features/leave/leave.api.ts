import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LeaveApprovalItemDto, LeaveCalendarEntryDto, LeaveRequestDetailDto, LeaveRequestDto, LeaveRequestPreviewDto, LeaveTypeOptionDto, MyBalanceDto,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const qs = (q: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  return p.toString();
};

/** Targeted query keys so a mutation invalidates only what it actually changed. */
export const leaveKeys = {
  all: ['leave'] as const,
  myRequests: (f: Record<string, unknown>) => ['leave', 'my-requests', f] as const,
  request: (id: string | undefined) => ['leave', 'request', id] as const,
  balancesMe: (asOfDate?: string) => ['leave', 'balances-me', asOfDate ?? 'today'] as const,
  approvals: (f: Record<string, unknown>) => ['leave', 'approvals', f] as const,
  calendar: (f: Record<string, unknown>) => ['leave', 'calendar', f] as const,
  requests: (f: Record<string, unknown>) => ['leave', 'requests', f] as const,
  types: ['leave', 'type-options'] as const,
};

export const useMyLeaveRequests = (f: Record<string, unknown>) =>
  useQuery({ queryKey: leaveKeys.myRequests(f), queryFn: () => api.get<LeaveRequestDto[]>(`/leave/requests/me?${qs(f)}`), placeholderData: (p) => p });

export const useLeaveRequest = (id?: string) =>
  useQuery({ queryKey: leaveKeys.request(id), queryFn: () => api.get<LeaveRequestDetailDto>(`/leave/requests/${id}`).then((r) => r.data), enabled: !!id });

export const useMyBalances = (asOfDate?: string) =>
  useQuery({ queryKey: leaveKeys.balancesMe(asOfDate), queryFn: () => api.get<MyBalanceDto[]>(`/leave/balances/me?${qs({ asOfDate })}`).then((r) => r.data) });

export const useLeaveApprovals = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: leaveKeys.approvals(f), queryFn: () => api.get<LeaveApprovalItemDto[]>(`/leave/approvals?${qs(f)}`), enabled, placeholderData: (p) => p });

export const useLeaveCalendar = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: leaveKeys.calendar(f), queryFn: () => api.get<LeaveCalendarEntryDto[]>(`/leave/calendar?${qs(f)}`).then((r) => r.data), enabled, placeholderData: (p) => p });

export const useAllLeaveRequests = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: leaveKeys.requests(f), queryFn: () => api.get<LeaveRequestDto[]>(`/leave/requests?${qs(f)}`), enabled, placeholderData: (p) => p });

/** Leave types for filters/forms — served by the entitlement options endpoint for permission holders, so it may 403. */
export const useLeaveTypeOptions = () =>
  useQuery({ queryKey: leaveKeys.types, queryFn: () => api.get<LeaveTypeOptionDto[]>('/leave/type-options').then((r) => r.data), retry: false });

/**
 * Every leave mutation goes through the Task 11 endpoints; the frontend never computes units, resolves policies or
 * decides approvals. `invalidate()` refreshes the leave caches (lists, detail, balances, approvals, calendar) plus the
 * dashboard, which shows leave counters — never the whole query cache.
 */
export function useLeaveMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: leaveKeys.all });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['notifications'] }); // submit/approve/reject publish notifications for someone
  };
  return {
    preview: useMutation({ mutationFn: (input: unknown) => api.post<LeaveRequestPreviewDto>('/leave/requests/preview', input).then((r) => r.data) }),
    create: useMutation({ mutationFn: (input: unknown) => api.post<LeaveRequestDto>('/leave/requests', input).then((r) => r.data), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: unknown }) => api.patch<LeaveRequestDto>(`/leave/requests/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    submit: useMutation({ mutationFn: (id: string) => api.post<LeaveRequestDto>(`/leave/requests/${id}/submit`).then((r) => r.data), onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: (id: string) => api.post<LeaveRequestDto>(`/leave/requests/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    /** Approve/reject use the generic workflow endpoint — there is no leave-specific approval mutation. */
    act: useMutation({
      mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) =>
        api.post(`/workflow/instances/${instanceId}/actions`, { action, comment: comment || undefined }),
      onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ['workflow'] }); },
    }),
  };
}
