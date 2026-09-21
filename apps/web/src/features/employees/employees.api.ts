import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChangeEmployeeManagerInput, ChangeEmployeePositionInput, CreateEmployeeInput, EmployeeDetail, EmployeeListItem, EmployeeListQuery,
  EmployeeSelectorOption, EmployeeSelectorQuery, ManagerHistoryItem, PositionHistoryItem, UpdateEmployeeProfileInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'employees';
function qs(q: Record<string, unknown>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  return p.toString();
}

export const useEmployees = (q: Partial<EmployeeListQuery>) =>
  useQuery({ queryKey: [KEY, 'list', q], queryFn: () => api.get<EmployeeListItem[]>(`/employees?${qs(q)}`), placeholderData: (p) => p });
export const useEmployee = (id?: string) =>
  useQuery({ queryKey: [KEY, id], queryFn: () => api.get<EmployeeDetail>(`/employees/${id}`).then((r) => r.data), enabled: !!id });
export const usePositionHistory = (id?: string) =>
  useQuery({ queryKey: [KEY, id, 'position-history'], queryFn: () => api.get<PositionHistoryItem[]>(`/employees/${id}/position-history`).then((r) => r.data), enabled: !!id });
export const useManagerHistory = (id?: string) =>
  useQuery({ queryKey: [KEY, id, 'manager-history'], queryFn: () => api.get<ManagerHistoryItem[]>(`/employees/${id}/manager-history`).then((r) => r.data), enabled: !!id });
export const useDirectReports = (id?: string) =>
  useQuery({ queryKey: [KEY, id, 'reports'], queryFn: () => api.get<EmployeeListItem[]>(`/employees/${id}/reports`).then((r) => r.data), enabled: !!id });
export const useEmployeeOptions = (q: EmployeeSelectorQuery, enabled = true) =>
  useQuery({ queryKey: [KEY, 'options', q], queryFn: () => api.get<EmployeeSelectorOption[]>(`/employees/options?${qs(q)}`).then((r) => r.data), enabled, placeholderData: (p) => p });

/** Every mutation invalidates employee queries and the organization cache (counts / department heads). */
export function useEmployeeMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['organization'] });
  };
  return {
    create: useMutation({ mutationFn: (input: CreateEmployeeInput) => api.post<EmployeeDetail>('/employees', input).then((r) => r.data), onSuccess: invalidate }),
    updateProfile: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateEmployeeProfileInput }) => api.patch<EmployeeDetail>(`/employees/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    changePosition: useMutation({ mutationFn: ({ id, input }: { id: string; input: ChangeEmployeePositionInput }) => api.patch<EmployeeDetail>(`/employees/${id}/position`, input).then((r) => r.data), onSuccess: invalidate }),
    changeManager: useMutation({ mutationFn: ({ id, input }: { id: string; input: ChangeEmployeeManagerInput }) => api.patch<EmployeeDetail>(`/employees/${id}/manager`, input).then((r) => r.data), onSuccess: invalidate }),
    activate: useMutation({ mutationFn: (id: string) => api.patch<EmployeeDetail>(`/employees/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    deactivate: useMutation({ mutationFn: (id: string) => api.patch<EmployeeDetail>(`/employees/${id}/deactivate`).then((r) => r.data), onSuccess: invalidate }),
  };
}

export const fullName = (e: { firstName: string; lastName: string; nickname?: string | null }) => `${e.firstName} ${e.lastName}${e.nickname ? ` (${e.nickname})` : ''}`;
