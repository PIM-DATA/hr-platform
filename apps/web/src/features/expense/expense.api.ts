import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateExpenseCategoryInput, CreateExpensePolicyInput, CreateExpenseReportInput, CreateTravelPolicyInput, CreateTravelRequestInput, ExpenseCategoryDto, ExpenseDashboardDto, ExpensePolicyConflictDto, ExpenseItemInput, ExpensePolicyDto, ExpenseReportDetailDto, ExpenseReportDto, ExpenseReportsDto, ExpenseReviewDto,
  MyExpensesDto, RecordExpensePaymentInput, SendExpenseToPayrollInput, TravelPolicyDto, TravelRequestDetailDto, TravelRequestDto, UpdateExpenseCategoryInput, UpdateExpenseItemInput, UpdateExpensePolicyInput, UpdateExpenseReportInput, UpdateTravelPolicyInput, UpdateTravelRequestInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'expense';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };
export interface ExpenseOptions { organizations: { id: string; name: string }[]; departments: { id: string; name: string; organizationId: string }[]; jobs: { id: string; title: string }[]; positions: { id: string; title: string; departmentId: string }[]; reportWorkflows: { code: string; name: string }[]; travelWorkflows: { code: string; name: string }[]; payComponents: { id: string; code: string; name: string }[] }

export const useMyExpenses = () => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<MyExpensesDto>('/expense/my').then((r) => r.data) });
export const useExpenseDashboard = () => useQuery({ queryKey: [KEY, 'dashboard'], queryFn: () => api.get<ExpenseDashboardDto>('/expense/dashboard').then((r) => r.data) });
export const useExpenseReportsAnalytics = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'analytics', f], queryFn: () => api.get<ExpenseReportsDto>(`/expense/reports?${qs(f)}`).then((r) => r.data) });
export const useExpenseOptions = (enabled = true) => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<ExpenseOptions>('/expense/options').then((r) => r.data), staleTime: 60_000, enabled });
export const useExpenseCategories = (includeInactive = false) => useQuery({ queryKey: [KEY, 'categories', includeInactive], queryFn: () => api.get<ExpenseCategoryDto[]>(`/expense/categories?${qs({ includeInactive })}`).then((r) => r.data) });
export const useExpensePolicies = (includeInactive = false, enabled = true) => useQuery({ queryKey: [KEY, 'policies', includeInactive], queryFn: () => api.get<ExpensePolicyDto[]>(`/expense/policies?${qs({ includeInactive })}`).then((r) => r.data), enabled });
export const useExpensePolicyConflicts = () => useQuery({ queryKey: [KEY, 'policy-conflicts'], queryFn: () => api.get<ExpensePolicyConflictDto[]>('/expense/policies/conflicts').then((r) => r.data) });
export const useExpensePolicy = (id: string | null) => useQuery({ queryKey: [KEY, 'policy', id ?? ''], queryFn: () => api.get<ExpensePolicyDto>(`/expense/policies/${id}`).then((r) => r.data), enabled: !!id });
export const useTravelPolicies = (includeInactive = false) => useQuery({ queryKey: [KEY, 'travel-policies', includeInactive], queryFn: () => api.get<TravelPolicyDto[]>(`/expense/travel-policies?${qs({ includeInactive })}`).then((r) => r.data) });
export const useTravelRequests = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'travel', f], queryFn: () => api.get<TravelRequestDto[]>(`/expense/travel?${qs(f)}`) as Promise<Page<TravelRequestDto>>, placeholderData: (p) => p });
export const useTravelRequest = (id: string | null) => useQuery({ queryKey: [KEY, 'travel-one', id ?? ''], queryFn: () => api.get<TravelRequestDetailDto>(`/expense/travel/${id}`).then((r) => r.data), enabled: !!id });
export const useExpenseReports = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'reports', f], queryFn: () => api.get<ExpenseReportDto[]>(`/expense/expense-reports?${qs(f)}`) as Promise<Page<ExpenseReportDto>>, placeholderData: (p) => p });
export const useExpenseReport = (id: string | null) => useQuery({ queryKey: [KEY, 'report', id ?? ''], queryFn: () => api.get<ExpenseReportDetailDto>(`/expense/expense-reports/${id}`).then((r) => r.data), enabled: !!id });
export const useExpenseReview = (kind: 'report' | 'travel', id: string | null) => useQuery({ queryKey: [KEY, 'review', kind, id ?? ''], queryFn: () => api.get<ExpenseReviewDto>(`/expense/${kind === 'report' ? 'expense-reports' : 'travel'}/${id}/review`).then((r) => r.data), enabled: !!id });
export const usePayrollPeriodOptions = (enabled: boolean) => useQuery({ queryKey: [KEY, 'payroll-periods'], queryFn: () => api.get<{ id: string; year: number; month: number; status: string; organizationId: string }[]>('/payroll/periods?pageSize=50').then((r) => r.data), enabled });

export function useExpenseMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['workflow'] }); qc.invalidateQueries({ queryKey: ['documents'] }); };
  const R = '/expense/expense-reports';
  return {
    createCategory: useMutation({ mutationFn: (input: CreateExpenseCategoryInput) => api.post<ExpenseCategoryDto>('/expense/categories', input).then((r) => r.data), onSuccess: invalidate }),
    updateCategory: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateExpenseCategoryInput }) => api.patch<ExpenseCategoryDto>(`/expense/categories/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createPolicy: useMutation({ mutationFn: (input: CreateExpensePolicyInput) => api.post<ExpensePolicyDto>('/expense/policies', input).then((r) => r.data), onSuccess: invalidate }),
    updatePolicy: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateExpensePolicyInput }) => api.patch<ExpensePolicyDto>(`/expense/policies/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createTravelPolicy: useMutation({ mutationFn: (input: CreateTravelPolicyInput) => api.post<TravelPolicyDto>('/expense/travel-policies', input).then((r) => r.data), onSuccess: invalidate }),
    updateTravelPolicy: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTravelPolicyInput }) => api.patch<TravelPolicyDto>(`/expense/travel-policies/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createTravel: useMutation({ mutationFn: (input: CreateTravelRequestInput) => api.post<TravelRequestDetailDto>('/expense/travel', input).then((r) => r.data), onSuccess: invalidate }),
    updateTravel: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTravelRequestInput }) => api.patch<TravelRequestDetailDto>(`/expense/travel/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    submitTravel: useMutation({ mutationFn: (id: string) => api.post<TravelRequestDetailDto>(`/expense/travel/${id}/submit`).then((r) => r.data), onSuccess: invalidate }),
    cancelTravel: useMutation({ mutationFn: (id: string) => api.post<TravelRequestDetailDto>(`/expense/travel/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    completeTravel: useMutation({ mutationFn: (id: string) => api.post<TravelRequestDetailDto>(`/expense/travel/${id}/complete`).then((r) => r.data), onSuccess: invalidate }),
    createReport: useMutation({ mutationFn: (input: CreateExpenseReportInput) => api.post<ExpenseReportDetailDto>(R, input).then((r) => r.data), onSuccess: invalidate }),
    updateReport: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateExpenseReportInput }) => api.patch<ExpenseReportDetailDto>(`${R}/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    addItem: useMutation({ mutationFn: ({ id, input }: { id: string; input: ExpenseItemInput }) => api.post<ExpenseReportDetailDto>(`${R}/${id}/items`, input).then((r) => r.data), onSuccess: invalidate }),
    updateItem: useMutation({ mutationFn: ({ id, itemId, input }: { id: string; itemId: string; input: UpdateExpenseItemInput }) => api.patch<ExpenseReportDetailDto>(`${R}/${id}/items/${itemId}`, input).then((r) => r.data), onSuccess: invalidate }),
    removeItem: useMutation({ mutationFn: ({ id, itemId }: { id: string; itemId: string }) => api.delete<ExpenseReportDetailDto>(`${R}/${id}/items/${itemId}`).then((r) => r.data), onSuccess: invalidate }),
    attachReceipt: useMutation({ mutationFn: ({ id, itemId, documentId }: { id: string; itemId: string; documentId: string }) => api.post<ExpenseReportDetailDto>(`${R}/${id}/items/${itemId}/receipts`, { documentId }).then((r) => r.data), onSuccess: invalidate }),
    submitReport: useMutation({ mutationFn: (id: string) => api.post<ExpenseReportDetailDto>(`${R}/${id}/submit`).then((r) => r.data), onSuccess: invalidate }),
    cancelReport: useMutation({ mutationFn: (id: string) => api.post<ExpenseReportDetailDto>(`${R}/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    recordPayment: useMutation({ mutationFn: ({ id, input }: { id: string; input: RecordExpensePaymentInput }) => api.post<ExpenseReportDetailDto>(`${R}/${id}/payment`, input).then((r) => r.data), onSuccess: invalidate }),
    sendToPayroll: useMutation({ mutationFn: ({ id, input }: { id: string; input: SendExpenseToPayrollInput }) => api.post<ExpenseReportDetailDto>(`${R}/${id}/send-to-payroll`, input).then((r) => r.data), onSuccess: invalidate }),
    act: useMutation({ mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) => api.post(`/workflow/instances/${instanceId}/actions`, { action, comment: comment || undefined }), onSuccess: invalidate }),
  };
}
