import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompApplyPreviewDto, CompApplyResultDto, CompCycleDto, CompCycleStatus, CompHistoryDto, CompMyPlanDto, CompPopulationPreviewDto, CompReportDto, CompRowDto, CreateCompCycleInput, UpdateCompCycleInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'compensation-planning';
const B = '/compensation-planning';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };
export interface CompOptions { organizations: { id: string; name: string }[]; departments: { id: string; name: string; organizationId: string }[]; planners: { userId: string; name: string }[] }
export interface MyCycle { id: string; code: string; name: string; status: CompCycleStatus; effectiveDate: string; currency: string; rows: number }
export interface ReportCycle { id: string; code: string; name: string; status: CompCycleStatus; effectiveDate: string; currency: string; applied: boolean }

export const useCompOptions = (enabled = true) => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<CompOptions>(`${B}/options`).then((r) => r.data), enabled, staleTime: 60_000 });
export const useCompCycles = (enabled = true) => useQuery({ queryKey: [KEY, 'cycles'], queryFn: () => api.get<CompCycleDto[]>(`${B}/cycles`).then((r) => r.data), enabled });
export const useCompCycle = (id: string | undefined) => useQuery({ queryKey: [KEY, 'cycle', id ?? ''], queryFn: () => api.get<CompCycleDto>(`${B}/cycles/${id}`).then((r) => r.data), enabled: !!id });
export const usePopulation = (id: string | undefined, f: Record<string, unknown>, enabled: boolean) => useQuery({ queryKey: [KEY, 'population', id ?? '', f], queryFn: () => api.get<CompPopulationPreviewDto>(`${B}/cycles/${id}/population?${qs(f)}`).then((r) => r.data), enabled: !!id && enabled, placeholderData: (p) => p });
export const useCycleRows = (id: string | undefined, f: Record<string, unknown>, enabled: boolean) => useQuery({ queryKey: [KEY, 'rows', id ?? '', f], queryFn: () => api.get<CompRowDto[]>(`${B}/cycles/${id}/employees?${qs(f)}`) as Promise<Page<CompRowDto>>, enabled: !!id && enabled, placeholderData: (p) => p });
export const useApplyPreview = (id: string | undefined, enabled: boolean) => useQuery({ queryKey: [KEY, 'apply-preview', id ?? ''], queryFn: () => api.get<CompApplyPreviewDto>(`${B}/cycles/${id}/apply-preview`).then((r) => r.data), enabled: !!id && enabled });
export const useProposalHistory = (id: string | null) => useQuery({ queryKey: [KEY, 'history', id ?? ''], queryFn: () => api.get<CompHistoryDto[]>(`${B}/proposals/${id}/history`).then((r) => r.data), enabled: !!id });
export const useMyCycles = (enabled = true) => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<MyCycle[]>(`${B}/my/cycles`).then((r) => r.data), enabled });
export const useMyPlan = (id: string | undefined) => useQuery({ queryKey: [KEY, 'my', id ?? ''], queryFn: () => api.get<CompMyPlanDto>(`${B}/my/cycles/${id}`).then((r) => r.data), enabled: !!id });
export const useReportCycles = (enabled = true) => useQuery({ queryKey: [KEY, 'report-cycles'], queryFn: () => api.get<ReportCycle[]>(`${B}/reports/cycles`).then((r) => r.data), enabled });
export const useCompReport = (id: string | undefined) => useQuery({ queryKey: [KEY, 'report', id ?? ''], queryFn: () => api.get<CompReportDto>(`${B}/reports/cycles/${id}`).then((r) => r.data), enabled: !!id });

/** Every mutation refreshes the whole module: a proposal change moves the budget, the progress and the grid together. */
export function useCompMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: [KEY] });
  const useM = <A, R>(fn: (a: A) => Promise<R>) => useMutation({ mutationFn: fn, onSuccess: done });
  return {
    createCycle: useM((b: CreateCompCycleInput) => api.post<CompCycleDto>(`${B}/cycles`, b).then((r) => r.data)),
    updateCycle: useM((a: { id: string; body: UpdateCompCycleInput }) => api.patch<CompCycleDto>(`${B}/cycles/${a.id}`, a.body).then((r) => r.data)),
    setExclusion: useM((a: { id: string; employeeId: string; excluded: boolean }) => api.post(`${B}/cycles/${a.id}/exclusions`, { employeeId: a.employeeId, excluded: a.excluded })),
    setBudget: useM((a: { id: string; budgetAmount: string }) => api.put<CompCycleDto>(`${B}/cycles/${a.id}/budget`, { budgetAmount: a.budgetAmount }).then((r) => r.data)),
    transition: useM((a: { id: string; action: 'activate' | 'start-review' | 'finalize' | 'archive' }) => api.post<CompCycleDto>(`${B}/cycles/${a.id}/${a.action}`).then((r) => r.data)),
    apply: useM((id: string) => api.post<CompApplyResultDto>(`${B}/cycles/${id}/apply`).then((r) => r.data)),
    approveAll: useM((a: { id: string; plannerUserId?: string; departmentId?: string }) => api.post<{ approved: number; skipped?: number }>(`${B}/cycles/${a.id}/approve`, { plannerUserId: a.plannerUserId, departmentId: a.departmentId }).then((r) => r.data)),
    approve: useM((proposalId: string) => api.post(`${B}/proposals/${proposalId}/approve`)),
    returnToPlanner: useM((a: { proposalId: string; reasonCode: string }) => api.post(`${B}/proposals/${a.proposalId}/return`, { reasonCode: a.reasonCode })),
    override: useM((a: { proposalId: string; proposedBaseSalary: string; reasonCode: string }) => api.post(`${B}/proposals/${a.proposalId}/override`, { proposedBaseSalary: a.proposedBaseSalary, reasonCode: a.reasonCode })),
    reassign: useM((a: { cycleEmployeeId: string; plannerUserId: string | null; reasonCode: string }) => api.post(`${B}/cycle-employees/${a.cycleEmployeeId}/planner`, { plannerUserId: a.plannerUserId, reasonCode: a.reasonCode })),
    saveProposal: useM((a: { proposalId: string; proposedBaseSalary: string; managerComment?: string | null }) => api.patch<{ status: string; proposedBaseSalary: string; increaseAmount: string; increasePercent: string | null }>(`${B}/proposals/${a.proposalId}`, { proposedBaseSalary: a.proposedBaseSalary, managerComment: a.managerComment }).then((r) => r.data)),
    submitMine: useM((cycleId: string) => api.post<{ submitted: number; status: string }>(`${B}/my/cycles/${cycleId}/submit`).then((r) => r.data)),
  };
}
