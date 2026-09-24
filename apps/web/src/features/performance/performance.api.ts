import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddPlanItemInput, AssignPlansInput, AssignPlansResultDto, CreateKpiInput, CreatePerformanceCycleInput,
  CycleReportDto, KpiDto, ManagerAssessmentInput, PerformanceCycleDto, PlanDetailDto, PlanSummaryDto,
  SelfAssessmentInput, UpdateKpiInput, UpdatePerformanceCycleInput, UpdatePlanInput, UpdatePlanItemInput,
  UpdateProgressInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'performance';
export const performanceKeys = {
  cycles: (f: Record<string, unknown>) => [KEY, 'cycles', f] as const,
  cycle: (id: string) => [KEY, 'cycle', id] as const,
  kpis: (f: Record<string, unknown>) => [KEY, 'kpis', f] as const,
  plans: (f: Record<string, unknown>) => [KEY, 'plans', f] as const,
  plan: (id: string) => [KEY, 'plan', id] as const,
  report: (cycleId: string, departmentId?: string) => [KEY, 'report', cycleId, departmentId ?? ''] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

export const usePerformanceCycles = (f: Record<string, unknown>) =>
  useQuery({ queryKey: performanceKeys.cycles(f), queryFn: () => api.get<PerformanceCycleDto[]>(`/performance/cycles?${qs(f)}`), placeholderData: (p) => p });

export const usePerformanceCycle = (id: string | null) =>
  useQuery({ queryKey: performanceKeys.cycle(id ?? ''), queryFn: () => api.get<PerformanceCycleDto>(`/performance/cycles/${id}`).then((r) => r.data), enabled: !!id });

export const useKpis = (f: Record<string, unknown>) =>
  useQuery({ queryKey: performanceKeys.kpis(f), queryFn: () => api.get<KpiDto[]>(`/performance/kpis?${qs(f)}`), placeholderData: (p) => p });

export const usePlans = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: performanceKeys.plans(f), queryFn: () => api.get<PlanSummaryDto[]>(`/performance/plans?${qs(f)}`), enabled, placeholderData: (p) => p });

export const usePlan = (id: string | null) =>
  useQuery({ queryKey: performanceKeys.plan(id ?? ''), queryFn: () => api.get<PlanDetailDto>(`/performance/plans/${id}`).then((r) => r.data), enabled: !!id });

export const useCycleReport = (cycleId: string | null, departmentId?: string) =>
  useQuery({
    queryKey: performanceKeys.report(cycleId ?? '', departmentId),
    queryFn: () => api.get<CycleReportDto>(`/performance/cycles/${cycleId}/report?${qs({ departmentId })}`).then((r) => r.data),
    enabled: !!cycleId,
  });

export function usePerformanceMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return {
    createCycle: useMutation({ mutationFn: (input: CreatePerformanceCycleInput) => api.post<PerformanceCycleDto>('/performance/cycles', input).then((r) => r.data), onSuccess: invalidate }),
    updateCycle: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdatePerformanceCycleInput }) => api.patch<PerformanceCycleDto>(`/performance/cycles/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    /** activate | open-review | close — the three deliberate steps a cycle takes. */
    transition: useMutation({
      mutationFn: ({ id, action }: { id: string; action: 'activate' | 'open-review' | 'close' }) => api.post<PerformanceCycleDto>(`/performance/cycles/${id}/${action}`).then((r) => r.data),
      onSuccess: invalidate,
    }),
    assign: useMutation({
      mutationFn: ({ cycleId, input }: { cycleId: string; input: AssignPlansInput }) => api.post<AssignPlansResultDto>(`/performance/cycles/${cycleId}/assign`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    createKpi: useMutation({ mutationFn: (input: CreateKpiInput) => api.post<KpiDto>('/performance/kpis', input).then((r) => r.data), onSuccess: invalidate }),
    updateKpi: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateKpiInput }) => api.patch<KpiDto>(`/performance/kpis/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    updatePlan: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdatePlanInput }) => api.patch<PlanDetailDto>(`/performance/plans/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    addItem: useMutation({
      mutationFn: ({ planId, input }: { planId: string; input: AddPlanItemInput }) => api.post<PlanDetailDto>(`/performance/plans/${planId}/items`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    updateItem: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: UpdatePlanItemInput }) => api.patch<PlanDetailDto>(`/performance/items/${itemId}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    removeItem: useMutation({ mutationFn: (itemId: string) => api.delete<PlanDetailDto>(`/performance/items/${itemId}`).then((r) => r.data), onSuccess: invalidate }),
    updateProgress: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: UpdateProgressInput }) => api.patch<PlanDetailDto>(`/performance/items/${itemId}/progress`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    selfAssess: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: SelfAssessmentInput }) => api.patch<PlanDetailDto>(`/performance/items/${itemId}/self`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    submitSelf: useMutation({ mutationFn: (planId: string) => api.post<PlanDetailDto>(`/performance/plans/${planId}/submit-self`).then((r) => r.data), onSuccess: invalidate }),
    managerAssess: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: ManagerAssessmentInput }) => api.patch<PlanDetailDto>(`/performance/items/${itemId}/manager`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    submitManager: useMutation({ mutationFn: (planId: string) => api.post<PlanDetailDto>(`/performance/plans/${planId}/submit-manager`).then((r) => r.data), onSuccess: invalidate }),
  };
}
