import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateOvertimePolicyInput, CreateOvertimeRequestInput, OvertimePolicyDto, OvertimePreviewDto, OvertimeReportDto,
  OvertimeRequestDto, UpdateOvertimePolicyInput, UpdateOvertimeRequestInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'overtime';
export const overtimeKeys = {
  requests: (f: Record<string, unknown>) => [KEY, 'requests', f] as const,
  request: (id: string) => [KEY, 'request', id] as const,
  policies: (f: Record<string, unknown>) => [KEY, 'policies', f] as const,
  report: (f: Record<string, unknown>) => [KEY, 'report', f] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

export const useOvertimeRequests = (f: Record<string, unknown>) =>
  useQuery({ queryKey: overtimeKeys.requests(f), queryFn: () => api.get<OvertimeRequestDto[]>(`/attendance/overtime/requests?${qs(f)}`), placeholderData: (p) => p });

export const useOvertimeRequest = (id: string | null) =>
  useQuery({ queryKey: overtimeKeys.request(id ?? ''), queryFn: () => api.get<OvertimeRequestDto>(`/attendance/overtime/requests/${id}`).then((r) => r.data), enabled: !!id });

export const useOvertimePolicies = (f: Record<string, unknown>) =>
  useQuery({ queryKey: overtimeKeys.policies(f), queryFn: () => api.get<OvertimePolicyDto[]>(`/attendance/overtime/policies?${qs(f)}`), placeholderData: (p) => p });

export const useOvertimeReport = (f: { from: string; to: string; departmentId?: string; employeeId?: string }, enabled = true) =>
  useQuery({ queryKey: overtimeKeys.report(f), queryFn: () => api.get<OvertimeReportDto>(`/attendance/overtime/reports/overview?${qs(f)}`).then((r) => r.data), enabled });

export function useOvertimeMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['workflow'] });
  };
  return {
    /** Reads the day and returns what could be claimed. Deliberately a mutation hook: it is a POST and never cached. */
    preview: useMutation({ mutationFn: (attendanceDate: string) => api.post<OvertimePreviewDto>('/attendance/overtime/preview', { attendanceDate }).then((r) => r.data) }),
    create: useMutation({ mutationFn: (input: CreateOvertimeRequestInput) => api.post<OvertimeRequestDto>('/attendance/overtime/requests', input).then((r) => r.data), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateOvertimeRequestInput }) => api.patch<OvertimeRequestDto>(`/attendance/overtime/requests/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    submit: useMutation({ mutationFn: (id: string) => api.post<OvertimeRequestDto>(`/attendance/overtime/requests/${id}/submit`).then((r) => r.data), onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: (id: string) => api.post<OvertimeRequestDto>(`/attendance/overtime/requests/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    /** Approve and reject go through the shared workflow endpoint — overtime has no approval mutation of its own. */
    decide: useMutation({
      mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) =>
        api.post(`/workflow/instances/${instanceId}/actions`, { action, comment }),
      onSuccess: invalidate,
    }),
    createPolicy: useMutation({ mutationFn: (input: CreateOvertimePolicyInput) => api.post<OvertimePolicyDto>('/attendance/overtime/policies', input).then((r) => r.data), onSuccess: invalidate }),
    updatePolicy: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateOvertimePolicyInput }) => api.patch<OvertimePolicyDto>(`/attendance/overtime/policies/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
  };
}
