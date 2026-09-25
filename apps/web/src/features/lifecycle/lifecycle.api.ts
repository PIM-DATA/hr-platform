import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddPlanTaskInput, CompleteSeparationInput, CreateOffboardingCaseInput, CreateOnboardingPlanInput, CreateProbationCaseInput, CreateProbationPolicyInput, CreateTemplateInput, ExitInterviewInput, LifecycleDashboardDto, LifecycleReportDto, LifecycleTaskDto, LifecycleTemplateDto, MyLifecycleDto,
  OffboardingCaseDetailDto, OffboardingCaseDto, OnboardingPlanDetailDto, OnboardingPlanDto, ProbationCaseDto, ProbationPolicyDto, SubmitProbationReviewInput, UpdateOffboardingCaseInput, UpdateProbationPolicyInput, UpdateTaskInput, UpdateTemplateInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'lifecycle';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
export interface LifecycleOptions { organizations: { id: string; name: string }[]; departments: { id: string; name: string; organizationId: string }[]; documentCategories: { id: string; name: string }[]; users: { id: string; label: string }[] }

export const useMyLifecycle = () => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<MyLifecycleDto>('/lifecycle/my').then((r) => r.data) });
export const useLifecycleDashboard = () => useQuery({ queryKey: [KEY, 'dashboard'], queryFn: () => api.get<LifecycleDashboardDto>('/lifecycle/dashboard').then((r) => r.data) });
export const useLifecycleReport = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'report', f], queryFn: () => api.get<LifecycleReportDto>(`/lifecycle/reports?${qs(f)}`).then((r) => r.data), placeholderData: (p) => p });
export const useLifecycleOptions = () => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<LifecycleOptions>('/lifecycle/options').then((r) => r.data), staleTime: 60_000 });
export const useTemplates = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'templates', f], queryFn: () => api.get<LifecycleTemplateDto[]>(`/lifecycle/templates?${qs(f)}`).then((r) => r.data) });
export const useOnboardingPlans = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'onboarding', f], queryFn: () => api.get<OnboardingPlanDto[]>(`/lifecycle/onboarding?${qs(f)}`), placeholderData: (p) => p });
export const useOnboardingPlan = (id: string | null) => useQuery({ queryKey: [KEY, 'onboarding-plan', id ?? ''], queryFn: () => api.get<OnboardingPlanDetailDto>(`/lifecycle/onboarding/${id}`).then((r) => r.data), enabled: !!id });
export const useProbationPolicies = () => useQuery({ queryKey: [KEY, 'probation-policies'], queryFn: () => api.get<ProbationPolicyDto[]>('/lifecycle/probation/policies').then((r) => r.data) });
export const useProbationCases = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'probation', f], queryFn: () => api.get<ProbationCaseDto[]>(`/lifecycle/probation?${qs(f)}`), placeholderData: (p) => p });
export const useProbationCase = (id: string | null) => useQuery({ queryKey: [KEY, 'probation-case', id ?? ''], queryFn: () => api.get<ProbationCaseDto>(`/lifecycle/probation/${id}`).then((r) => r.data), enabled: !!id });
export const useOffboardingCases = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'offboarding', f], queryFn: () => api.get<OffboardingCaseDto[]>(`/lifecycle/offboarding?${qs(f)}`), placeholderData: (p) => p });
export const useOffboardingCase = (id: string | null) => useQuery({ queryKey: [KEY, 'offboarding-case', id ?? ''], queryFn: () => api.get<OffboardingCaseDetailDto>(`/lifecycle/offboarding/${id}`).then((r) => r.data), enabled: !!id });

export function useLifecycleMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['employees'] }); };
  return {
    createTemplate: useMutation({ mutationFn: (input: CreateTemplateInput) => api.post<LifecycleTemplateDto>('/lifecycle/templates', input).then((r) => r.data), onSuccess: invalidate }),
    updateTemplate: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTemplateInput }) => api.patch<LifecycleTemplateDto>(`/lifecycle/templates/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createPlan: useMutation({ mutationFn: (input: CreateOnboardingPlanInput) => api.post<OnboardingPlanDetailDto>('/lifecycle/onboarding', input).then((r) => r.data), onSuccess: invalidate }),
    addPlanTask: useMutation({ mutationFn: ({ id, input }: { id: string; input: AddPlanTaskInput }) => api.post<LifecycleTaskDto>(`/lifecycle/onboarding/${id}/tasks`, input).then((r) => r.data), onSuccess: invalidate }),
    activatePlan: useMutation({ mutationFn: (id: string) => api.post<OnboardingPlanDetailDto>(`/lifecycle/onboarding/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    completePlan: useMutation({ mutationFn: (id: string) => api.post<OnboardingPlanDetailDto>(`/lifecycle/onboarding/${id}/complete`).then((r) => r.data), onSuccess: invalidate }),
    cancelPlan: useMutation({ mutationFn: (id: string) => api.post<OnboardingPlanDetailDto>(`/lifecycle/onboarding/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    updateOnboardingTask: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) => api.patch<LifecycleTaskDto>(`/lifecycle/onboarding-tasks/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createPolicy: useMutation({ mutationFn: (input: CreateProbationPolicyInput) => api.post<ProbationPolicyDto>('/lifecycle/probation/policies', input).then((r) => r.data), onSuccess: invalidate }),
    updatePolicy: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateProbationPolicyInput }) => api.patch<ProbationPolicyDto>(`/lifecycle/probation/policies/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createProbation: useMutation({ mutationFn: (input: CreateProbationCaseInput) => api.post<ProbationCaseDto>('/lifecycle/probation', input).then((r) => r.data), onSuccess: invalidate }),
    reassignReviewer: useMutation({ mutationFn: ({ id, reviewerUserId }: { id: string; reviewerUserId: string }) => api.post<ProbationCaseDto>(`/lifecycle/probation/${id}/reviewer`, { reviewerUserId }).then((r) => r.data), onSuccess: invalidate }),
    submitReview: useMutation({ mutationFn: ({ id, input }: { id: string; input: SubmitProbationReviewInput }) => api.post<ProbationCaseDto>(`/lifecycle/probation/${id}/reviews`, input).then((r) => r.data), onSuccess: invalidate }),
    cancelProbation: useMutation({ mutationFn: (id: string) => api.post<ProbationCaseDto>(`/lifecycle/probation/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    createOffboarding: useMutation({ mutationFn: (input: CreateOffboardingCaseInput) => api.post<OffboardingCaseDetailDto>('/lifecycle/offboarding', input).then((r) => r.data), onSuccess: invalidate }),
    updateOffboarding: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateOffboardingCaseInput }) => api.patch<OffboardingCaseDetailDto>(`/lifecycle/offboarding/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    addOffboardingTask: useMutation({ mutationFn: ({ id, input }: { id: string; input: AddPlanTaskInput }) => api.post<LifecycleTaskDto>(`/lifecycle/offboarding/${id}/tasks`, input).then((r) => r.data), onSuccess: invalidate }),
    activateOffboarding: useMutation({ mutationFn: (id: string) => api.post<OffboardingCaseDetailDto>(`/lifecycle/offboarding/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    cancelOffboarding: useMutation({ mutationFn: (id: string) => api.post<OffboardingCaseDetailDto>(`/lifecycle/offboarding/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    exitInterview: useMutation({ mutationFn: ({ id, input }: { id: string; input: ExitInterviewInput }) => api.post<OffboardingCaseDetailDto>(`/lifecycle/offboarding/${id}/exit-interview`, input).then((r) => r.data), onSuccess: invalidate }),
    completeSeparation: useMutation({ mutationFn: ({ id, input }: { id: string; input: CompleteSeparationInput }) => api.post<OffboardingCaseDetailDto>(`/lifecycle/offboarding/${id}/complete-separation`, input).then((r) => r.data), onSuccess: invalidate }),
    updateOffboardingTask: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) => api.patch<LifecycleTaskDto>(`/lifecycle/offboarding-tasks/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
  };
}
