import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignServiceRequestInput, CreateHrLetterTemplateInput, CreateServiceRequestInput, CreateServiceRequestTypeInput, FulfillServiceRequestInput, HrLetterDto, HrLetterTemplateDto, IssueHrLetterInput, MyServicesDto,
  RejectServiceRequestInput, ServiceDashboardDto, ServiceMessageInput, ServiceReportsDto, ServiceRequestDetailDto, ServiceRequestDto, ServiceRequestTypeDto, UpdateHrLetterTemplateInput, UpdateServiceRequestInput, UpdateServiceRequestTypeInput, VoidHrLetterInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'employee-services';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };
export interface ServiceOptions {
  organizations: { id: string; name: string }[]; workflows: { code: string; name: string }[];
  letterTokens: { token: string; label: string; sensitive: boolean; available: boolean }[]; fulfillers: { id: string; name: string }[];
}

export const useMyServices = () => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<MyServicesDto>('/employee-services/my').then((r) => r.data) });
export const useServiceDashboard = () => useQuery({ queryKey: [KEY, 'dashboard'], queryFn: () => api.get<ServiceDashboardDto>('/employee-services/dashboard').then((r) => r.data) });
export const useServiceReports = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'reports', f], queryFn: () => api.get<ServiceReportsDto>(`/employee-services/reports?${qs(f)}`).then((r) => r.data) });
export const useServiceOptions = (enabled = true) => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<ServiceOptions>('/employee-services/options').then((r) => r.data), staleTime: 60_000, enabled });
export const useRequestTypes = (includeInactive = false) => useQuery({ queryKey: [KEY, 'types', includeInactive], queryFn: () => api.get<ServiceRequestTypeDto[]>(`/employee-services/request-types?${qs({ includeInactive })}`).then((r) => r.data) });
export const useServiceRequests = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'requests', f], queryFn: () => api.get<ServiceRequestDto[]>(`/employee-services/requests?${qs(f)}`) as Promise<Page<ServiceRequestDto>>, placeholderData: (p) => p });
export const useServiceRequest = (id: string | null) => useQuery({ queryKey: [KEY, 'request', id ?? ''], queryFn: () => api.get<ServiceRequestDetailDto>(`/employee-services/requests/${id}`).then((r) => r.data), enabled: !!id });
export const useServiceReview = (id: string | null) => useQuery({ queryKey: [KEY, 'review', id ?? ''], queryFn: () => api.get<{ request: ServiceRequestDetailDto; workflowInstanceId: string | null; myStepPending: boolean }>(`/employee-services/requests/${id}/review`).then((r) => r.data), enabled: !!id });
export const useLetterTemplates = (includeInactive = false, enabled = true) => useQuery({ queryKey: [KEY, 'templates', includeInactive], queryFn: () => api.get<HrLetterTemplateDto[]>(`/employee-services/letter-templates?${qs({ includeInactive })}`).then((r) => r.data), enabled });
export const useHrLetters = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'letters', f], queryFn: () => api.get<HrLetterDto[]>(`/employee-services/letters?${qs(f)}`) as Promise<Page<HrLetterDto>>, placeholderData: (p) => p });
export const useHrLetter = (id: string | null) => useQuery({ queryKey: [KEY, 'letter', id ?? ''], queryFn: () => api.get<HrLetterDto>(`/employee-services/letters/${id}`).then((r) => r.data), enabled: !!id });

export function useServiceMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['workflow'] }); qc.invalidateQueries({ queryKey: ['documents'] }); };
  const R = '/employee-services/requests';
  return {
    createType: useMutation({ mutationFn: (input: CreateServiceRequestTypeInput) => api.post<ServiceRequestTypeDto>('/employee-services/request-types', input).then((r) => r.data), onSuccess: invalidate }),
    updateType: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateServiceRequestTypeInput }) => api.patch<ServiceRequestTypeDto>(`/employee-services/request-types/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createRequest: useMutation({ mutationFn: (input: CreateServiceRequestInput) => api.post<ServiceRequestDetailDto>(R, input).then((r) => r.data), onSuccess: invalidate }),
    updateRequest: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateServiceRequestInput }) => api.patch<ServiceRequestDetailDto>(`${R}/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    submitRequest: useMutation({ mutationFn: (id: string) => api.post<ServiceRequestDetailDto>(`${R}/${id}/submit`).then((r) => r.data), onSuccess: invalidate }),
    cancelRequest: useMutation({ mutationFn: (id: string) => api.post<ServiceRequestDetailDto>(`${R}/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    attachDocument: useMutation({ mutationFn: ({ id, documentId }: { id: string; documentId: string }) => api.post<ServiceRequestDetailDto>(`${R}/${id}/documents`, { documentId }).then((r) => r.data), onSuccess: invalidate }),
    addMessage: useMutation({ mutationFn: ({ id, input }: { id: string; input: ServiceMessageInput }) => api.post<ServiceRequestDetailDto>(`${R}/${id}/messages`, input).then((r) => r.data), onSuccess: invalidate }),
    assign: useMutation({ mutationFn: ({ id, input }: { id: string; input: AssignServiceRequestInput }) => api.post<ServiceRequestDetailDto>(`${R}/${id}/assign`, input).then((r) => r.data), onSuccess: invalidate }),
    setStatus: useMutation({ mutationFn: ({ id, status }: { id: string; status: 'IN_PROGRESS' | 'WAITING_EMPLOYEE' }) => api.post<ServiceRequestDetailDto>(`${R}/${id}/status`, { status }).then((r) => r.data), onSuccess: invalidate }),
    fulfill: useMutation({ mutationFn: ({ id, input }: { id: string; input: FulfillServiceRequestInput }) => api.post<ServiceRequestDetailDto>(`${R}/${id}/fulfill`, input).then((r) => r.data), onSuccess: invalidate }),
    reject: useMutation({ mutationFn: ({ id, input }: { id: string; input: RejectServiceRequestInput }) => api.post<ServiceRequestDetailDto>(`${R}/${id}/reject`, input).then((r) => r.data), onSuccess: invalidate }),
    createTemplate: useMutation({ mutationFn: (input: CreateHrLetterTemplateInput) => api.post<HrLetterTemplateDto>('/employee-services/letter-templates', input).then((r) => r.data), onSuccess: invalidate }),
    updateTemplate: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateHrLetterTemplateInput }) => api.patch<HrLetterTemplateDto>(`/employee-services/letter-templates/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    issueLetter: useMutation({ mutationFn: (input: IssueHrLetterInput) => api.post<HrLetterDto>('/employee-services/letters', input).then((r) => r.data), onSuccess: invalidate }),
    voidLetter: useMutation({ mutationFn: ({ id, input }: { id: string; input: VoidHrLetterInput }) => api.post<HrLetterDto>(`/employee-services/letters/${id}/void`, input).then((r) => r.data), onSuccess: invalidate }),
    act: useMutation({ mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) => api.post(`/workflow/instances/${instanceId}/actions`, { action, comment: comment || undefined }), onSuccess: invalidate }),
  };
}
