import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdjustBenefitEntitlementInput, BenefitCategoryDto, BenefitClaimDetailDto, BenefitClaimDto, BenefitEnrollmentDto, BenefitEntitlementDetailDto, BenefitEntitlementDto, BenefitPeriodDto, BenefitPlanDto, BenefitsDashboardDto, BenefitsReportDto, ClaimReviewDto,
  CreateBenefitCategoryInput, CreateBenefitClaimInput, CreateBenefitPeriodInput, CreateBenefitPlanInput, EligibilityOverrideDto, EligibilityPreviewDto, EnrollBenefitInput, GenerateEntitlementsInput, MyBenefitsDto, RecordBenefitPaymentInput, SendClaimToPayrollInput, SetEligibilityOverrideInput,
  UpdateBenefitCategoryInput, UpdateBenefitClaimInput, UpdateBenefitPeriodInput, UpdateBenefitPlanInput, WorkflowInboxItemDto,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'benefits';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };
export interface BenefitsOptions { organizations: { id: string; name: string }[]; departments: { id: string; name: string; organizationId: string }[]; jobs: { id: string; title: string }[]; positions: { id: string; title: string; departmentId: string }[]; workflows: { code: string; name: string }[]; payComponents: { id: string; code: string; name: string }[] }

export const useMyBenefits = () => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<MyBenefitsDto>('/benefits/my').then((r) => r.data) });
export const useBenefitsDashboard = () => useQuery({ queryKey: [KEY, 'dashboard'], queryFn: () => api.get<BenefitsDashboardDto>('/benefits/dashboard').then((r) => r.data) });
export const useBenefitsReport = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'report', f], queryFn: () => api.get<BenefitsReportDto>(`/benefits/reports?${qs(f)}`).then((r) => r.data) });
export const useBenefitsOptions = () => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<BenefitsOptions>('/benefits/options').then((r) => r.data), staleTime: 60_000 });
export const useBenefitCategories = (includeInactive = false) => useQuery({ queryKey: [KEY, 'categories', includeInactive], queryFn: () => api.get<BenefitCategoryDto[]>(`/benefits/categories?${qs({ includeInactive })}`).then((r) => r.data) });
export const useBenefitPlans = (f: Record<string, unknown> = {}) => useQuery({ queryKey: [KEY, 'plans', f], queryFn: () => api.get<BenefitPlanDto[]>(`/benefits/plans?${qs(f)}`).then((r) => r.data) });
export const useBenefitPlan = (id: string | null) => useQuery({ queryKey: [KEY, 'plan', id ?? ''], queryFn: () => api.get<BenefitPlanDto>(`/benefits/plans/${id}`).then((r) => r.data), enabled: !!id });
export const useEligibilityPreview = (planId: string | null, includeEmployees: boolean) => useQuery({ queryKey: [KEY, 'preview', planId ?? '', includeEmployees], queryFn: () => api.get<EligibilityPreviewDto>(`/benefits/plans/${planId}/eligibility-preview?${qs({ includeEmployees })}`).then((r) => r.data), enabled: !!planId });
export const useEligibilityOverrides = (planId: string | null) => useQuery({ queryKey: [KEY, 'overrides', planId ?? ''], queryFn: () => api.get<EligibilityOverrideDto[]>(`/benefits/plans/${planId}/overrides`).then((r) => r.data), enabled: !!planId });
export const useBenefitPeriods = (f: Record<string, unknown> = {}) => useQuery({ queryKey: [KEY, 'periods', f], queryFn: () => api.get<BenefitPeriodDto[]>(`/benefits/periods?${qs(f)}`).then((r) => r.data) });
export const useBenefitEnrollments = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'enrollments', f], queryFn: () => api.get<BenefitEnrollmentDto[]>(`/benefits/enrollments?${qs(f)}`) as Promise<Page<BenefitEnrollmentDto>>, placeholderData: (p) => p });
export const useBenefitEntitlements = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'entitlements', f], queryFn: () => api.get<BenefitEntitlementDto[]>(`/benefits/entitlements?${qs(f)}`) as Promise<Page<BenefitEntitlementDto>>, placeholderData: (p) => p });
export const useBenefitEntitlement = (id: string | null) => useQuery({ queryKey: [KEY, 'entitlement', id ?? ''], queryFn: () => api.get<BenefitEntitlementDetailDto>(`/benefits/entitlements/${id}`).then((r) => r.data), enabled: !!id });
export const useBenefitClaims = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'claims', f], queryFn: () => api.get<BenefitClaimDto[]>(`/benefits/claims?${qs(f)}`) as Promise<Page<BenefitClaimDto>>, placeholderData: (p) => p });
export const useBenefitClaim = (id: string | null) => useQuery({ queryKey: [KEY, 'claim', id ?? ''], queryFn: () => api.get<BenefitClaimDetailDto>(`/benefits/claims/${id}`).then((r) => r.data), enabled: !!id });
export const useClaimReview = (id: string | null) => useQuery({ queryKey: [KEY, 'review', id ?? ''], queryFn: () => api.get<ClaimReviewDto>(`/benefits/claims/${id}/review`).then((r) => r.data), enabled: !!id });
export const useBenefitsInbox = (enabled: boolean) => useQuery({ queryKey: [KEY, 'inbox'], queryFn: () => api.get<WorkflowInboxItemDto[]>('/workflow/inbox?module=benefits&pageSize=50').then((r) => r.data), enabled });
export const usePayrollPeriodOptions = (enabled: boolean) => useQuery({ queryKey: [KEY, 'payroll-periods'], queryFn: () => api.get<{ id: string; year: number; month: number; status: string; organizationId: string }[]>('/payroll/periods?pageSize=50').then((r) => r.data), enabled });

export function useBenefitsMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['workflow'] }); qc.invalidateQueries({ queryKey: ['documents'] }); };
  return {
    createCategory: useMutation({ mutationFn: (input: CreateBenefitCategoryInput) => api.post<BenefitCategoryDto>('/benefits/categories', input).then((r) => r.data), onSuccess: invalidate }),
    updateCategory: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateBenefitCategoryInput }) => api.patch<BenefitCategoryDto>(`/benefits/categories/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createPlan: useMutation({ mutationFn: (input: CreateBenefitPlanInput) => api.post<BenefitPlanDto>('/benefits/plans', input).then((r) => r.data), onSuccess: invalidate }),
    updatePlan: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateBenefitPlanInput }) => api.patch<BenefitPlanDto>(`/benefits/plans/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    setOverride: useMutation({ mutationFn: ({ planId, input }: { planId: string; input: SetEligibilityOverrideInput }) => api.post<EligibilityOverrideDto[]>(`/benefits/plans/${planId}/overrides`, input).then((r) => r.data), onSuccess: invalidate }),
    enroll: useMutation({ mutationFn: ({ planId, input }: { planId: string; input: EnrollBenefitInput }) => api.post<BenefitEnrollmentDto>(`/benefits/plans/${planId}/enroll`, input).then((r) => r.data), onSuccess: invalidate }),
    selfEnroll: useMutation({ mutationFn: (planId: string) => api.post<BenefitEnrollmentDto>(`/benefits/plans/${planId}/self-enroll`, {}).then((r) => r.data), onSuccess: invalidate }),
    waive: useMutation({ mutationFn: (planId: string) => api.post<BenefitEnrollmentDto>(`/benefits/plans/${planId}/waive`).then((r) => r.data), onSuccess: invalidate }),
    endEnrollment: useMutation({ mutationFn: (id: string) => api.post<BenefitEnrollmentDto>(`/benefits/enrollments/${id}/end`, {}).then((r) => r.data), onSuccess: invalidate }),
    createPeriod: useMutation({ mutationFn: (input: CreateBenefitPeriodInput) => api.post<BenefitPeriodDto>('/benefits/periods', input).then((r) => r.data), onSuccess: invalidate }),
    updatePeriod: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateBenefitPeriodInput }) => api.patch<BenefitPeriodDto>(`/benefits/periods/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    openPeriod: useMutation({ mutationFn: (id: string) => api.post<BenefitPeriodDto>(`/benefits/periods/${id}/open`).then((r) => r.data), onSuccess: invalidate }),
    closePeriod: useMutation({ mutationFn: (id: string) => api.post<BenefitPeriodDto>(`/benefits/periods/${id}/close`).then((r) => r.data), onSuccess: invalidate }),
    generate: useMutation({ mutationFn: (input: GenerateEntitlementsInput) => api.post<{ created: number; skippedExisting: number; skippedIneligible: number; skippedNotEnrolled: number }>('/benefits/entitlements/generate', input).then((r) => r.data), onSuccess: invalidate }),
    adjust: useMutation({ mutationFn: ({ id, input }: { id: string; input: AdjustBenefitEntitlementInput }) => api.post<BenefitEntitlementDetailDto>(`/benefits/entitlements/${id}/adjust`, input).then((r) => r.data), onSuccess: invalidate }),
    createClaim: useMutation({ mutationFn: (input: CreateBenefitClaimInput) => api.post<BenefitClaimDetailDto>('/benefits/claims', input).then((r) => r.data), onSuccess: invalidate }),
    updateClaim: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateBenefitClaimInput }) => api.patch<BenefitClaimDetailDto>(`/benefits/claims/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    attachDocument: useMutation({ mutationFn: ({ id, documentId }: { id: string; documentId: string }) => api.post<BenefitClaimDetailDto>(`/benefits/claims/${id}/documents`, { documentId }).then((r) => r.data), onSuccess: invalidate }),
    submitClaim: useMutation({ mutationFn: (id: string) => api.post<BenefitClaimDetailDto>(`/benefits/claims/${id}/submit`).then((r) => r.data), onSuccess: invalidate }),
    cancelClaim: useMutation({ mutationFn: (id: string) => api.post<BenefitClaimDetailDto>(`/benefits/claims/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    recordPayment: useMutation({ mutationFn: ({ id, input }: { id: string; input: RecordBenefitPaymentInput }) => api.post<BenefitClaimDetailDto>(`/benefits/claims/${id}/payment`, input).then((r) => r.data), onSuccess: invalidate }),
    sendToPayroll: useMutation({ mutationFn: ({ id, input }: { id: string; input: SendClaimToPayrollInput }) => api.post<BenefitClaimDetailDto>(`/benefits/claims/${id}/send-to-payroll`, input).then((r) => r.data), onSuccess: invalidate }),
    act: useMutation({ mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) => api.post(`/workflow/instances/${instanceId}/actions`, { action, comment: comment || undefined }), onSuccess: invalidate }),
  };
}
