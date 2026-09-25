import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddPayrollAdjustmentInput, CompensationDto, CreateCompensationInput, CreatePayComponentInput, CreatePayItemInput,
  CreatePayrollPeriodInput, CreatePayrollPolicyInput, PayComponentDto, PayItemDto, PayrollPeriodDto,
  PayrollPolicyDto, PayrollReconciliationDto, PayrollResultDto, PayrollRunSummaryDto, PayrollSummaryDto, PayslipDto,
  UpdatePayComponentInput,
  UpdatePayItemInput,
  UpdatePayrollPolicyInput,
  UpdatePayrollPeriodInput,
} from '@hr/shared';
import { api, ApiClientError, getCsrfToken } from '@/lib/api-client';

const KEY = 'payroll';
export const payrollKeys = {
  periods: (f: Record<string, unknown>) => [KEY, 'periods', f] as const,
  period: (id: string) => [KEY, 'period', id] as const,
  results: (runId: string, f: Record<string, unknown>) => [KEY, 'results', runId, f] as const,
  result: (id: string) => [KEY, 'result', id] as const,
  reconciliation: (runId: string) => [KEY, 'reconciliation', runId] as const,
  summary: (runId: string) => [KEY, 'summary', runId] as const,
  compensations: (f: Record<string, unknown>) => [KEY, 'compensations', f] as const,
  components: (f: Record<string, unknown>) => [KEY, 'components', f] as const,
  payItems: (f: Record<string, unknown>) => [KEY, 'pay-items', f] as const,
  policies: (organizationId?: string) => [KEY, 'policies', organizationId ?? ''] as const,
  payslips: [KEY, 'payslips'] as const,
  payslip: (id: string) => [KEY, 'payslip', id] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

// ---------- employee ----------
export const useMyPayslips = () =>
  useQuery({ queryKey: payrollKeys.payslips, queryFn: () => api.get<{ id: string; period: { id: string; label: string; paymentDate: string | null }; netPay: string; currencyCode: string }[]>('/payroll/payslips/me').then((r) => r.data) });

export const useMyPayslip = (id: string | null) =>
  useQuery({ queryKey: payrollKeys.payslip(id ?? ''), queryFn: () => api.get<PayslipDto>(`/payroll/payslips/me/${id}`).then((r) => r.data), enabled: !!id });

// ---------- administration ----------
export const usePayrollPeriods = (f: Record<string, unknown>) =>
  useQuery({ queryKey: payrollKeys.periods(f), queryFn: () => api.get<PayrollPeriodDto[]>(`/payroll/periods?${qs(f)}`), placeholderData: (p) => p });

export const usePayrollPeriod = (id: string | null) =>
  useQuery({ queryKey: payrollKeys.period(id ?? ''), queryFn: () => api.get<PayrollPeriodDto>(`/payroll/periods/${id}`).then((r) => r.data), enabled: !!id });

export const usePayrollResults = (runId: string | null, f: Record<string, unknown>) =>
  useQuery({ queryKey: payrollKeys.results(runId ?? '', f), queryFn: () => api.get<PayrollResultDto[]>(`/payroll/runs/${runId}/results?${qs(f)}`), enabled: !!runId, placeholderData: (p) => p });

export const usePayrollResult = (id: string | null) =>
  useQuery({ queryKey: payrollKeys.result(id ?? ''), queryFn: () => api.get<PayrollResultDto>(`/payroll/results/${id}`).then((r) => r.data), enabled: !!id });

export const useReconciliation = (runId: string | null) =>
  useQuery({ queryKey: payrollKeys.reconciliation(runId ?? ''), queryFn: () => api.get<PayrollReconciliationDto>(`/payroll/runs/${runId}/reconciliation`).then((r) => r.data), enabled: !!runId });

export const usePayrollSummary = (runId: string | null) =>
  useQuery({ queryKey: payrollKeys.summary(runId ?? ''), queryFn: () => api.get<PayrollSummaryDto>(`/payroll/runs/${runId}/summary`).then((r) => r.data), enabled: !!runId });

export const useCompensations = (f: Record<string, unknown>) =>
  useQuery({ queryKey: payrollKeys.compensations(f), queryFn: () => api.get<CompensationDto[]>(`/payroll/compensations?${qs(f)}`), placeholderData: (p) => p });

export const usePayComponents = (f: Record<string, unknown>) =>
  useQuery({ queryKey: payrollKeys.components(f), queryFn: () => api.get<PayComponentDto[]>(`/payroll/components?${qs(f)}`), placeholderData: (p) => p });

export const usePayItems = (f: Record<string, unknown>) =>
  useQuery({ queryKey: payrollKeys.payItems(f), queryFn: () => api.get<PayItemDto[]>(`/payroll/pay-items?${qs(f)}`), placeholderData: (p) => p });

export const usePayrollPolicies = (organizationId?: string) =>
  useQuery({ queryKey: payrollKeys.policies(organizationId), queryFn: () => api.get<PayrollPolicyDto[]>(`/payroll/policies?${qs({ organizationId })}`).then((r) => r.data) });

export function usePayrollMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['workflow'] });
  };
  return {
    createPeriod: useMutation({ mutationFn: (input: CreatePayrollPeriodInput) => api.post<PayrollPeriodDto>('/payroll/periods', input).then((r) => r.data), onSuccess: invalidate }),
    calculate: useMutation({ mutationFn: (periodId: string) => api.post<PayrollRunSummaryDto>(`/payroll/periods/${periodId}/calculate`).then((r) => r.data), onSuccess: invalidate }),
    submit: useMutation({ mutationFn: (runId: string) => api.post<PayrollRunSummaryDto>(`/payroll/runs/${runId}/submit`).then((r) => r.data), onSuccess: invalidate }),
    close: useMutation({ mutationFn: (runId: string) => api.post<PayrollRunSummaryDto>(`/payroll/runs/${runId}/close`).then((r) => r.data), onSuccess: invalidate }),
    /** Approve and reject go through the shared workflow endpoint — payroll has no approval mutation of its own. */
    decide: useMutation({
      mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) =>
        api.post(`/workflow/instances/${instanceId}/actions`, { action, comment }),
      onSuccess: invalidate,
    }),
    addAdjustment: useMutation({
      mutationFn: ({ resultId, input }: { resultId: string; input: AddPayrollAdjustmentInput }) => api.post<PayrollResultDto>(`/payroll/results/${resultId}/adjustments`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    removeAdjustment: useMutation({ mutationFn: (itemId: string) => api.delete<PayrollResultDto>(`/payroll/adjustments/${itemId}`).then((r) => r.data), onSuccess: invalidate }),
    createCompensation: useMutation({ mutationFn: (input: CreateCompensationInput) => api.post<CompensationDto>('/payroll/compensations', input).then((r) => r.data), onSuccess: invalidate }),
    closeCompensation: useMutation({
      mutationFn: ({ id, effectiveTo }: { id: string; effectiveTo: string }) => api.patch<CompensationDto>(`/payroll/compensations/${id}`, { effectiveTo }).then((r) => r.data),
      onSuccess: invalidate,
    }),
    createComponent: useMutation({ mutationFn: (input: CreatePayComponentInput) => api.post<PayComponentDto>('/payroll/components', input).then((r) => r.data), onSuccess: invalidate }),
    createPayItem: useMutation({ mutationFn: (input: CreatePayItemInput) => api.post<PayItemDto>('/payroll/pay-items', input).then((r) => r.data), onSuccess: invalidate }),
    createPolicy: useMutation({ mutationFn: (input: CreatePayrollPolicyInput) => api.post<PayrollPolicyDto>('/payroll/policies', input).then((r) => r.data), onSuccess: invalidate }),
    // Administration (Task 41): the backend has always accepted these edits; the screens now offer them.
    updateComponent: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdatePayComponentInput }) => api.patch<PayComponentDto>(`/payroll/components/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    updatePayItem: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdatePayItemInput }) => api.patch<PayItemDto>(`/payroll/pay-items/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    updatePolicy: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdatePayrollPolicyInput }) => api.patch<PayrollPolicyDto>(`/payroll/policies/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    updatePeriod: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdatePayrollPeriodInput }) => api.patch<PayrollPeriodDto>(`/payroll/periods/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
  };
}

/** Downloads a run as CSV. Built by hand because the endpoint answers with a file, not the usual `{ data }`. */
export async function downloadPayrollCsv(runId: string, label: string): Promise<void> {
  const base = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api/v1`;
  const csrf = getCsrfToken();
  const res = await fetch(`${base}/payroll/runs/${runId}/export`, { credentials: 'include', headers: csrf ? { 'x-csrf-token': csrf } : undefined });
  if (!res.ok) throw new ApiClientError(res.status, { code: 'EXPORT_FAILED', message: 'Could not export this payroll run' });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `payroll-${label}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
