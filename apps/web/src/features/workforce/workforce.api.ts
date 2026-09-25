import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddWorkforcePlanItemInput, CreateOrgDesignNodeInput, CreateOrgDesignPositionInput, CreateOrgDesignScenarioInput, CreatePlannedMovementInput, CreateWorkforceCycleInput, OrgDesignComparisonDto, OrgDesignScenarioDto, OrgDesignTreeDto,
  PlannedMovementDto, RequisitionFromPlanInput, ScenarioComparisonDto, UpdateOrgDesignNodeInput, UpdateOrgDesignPositionInput, UpdateOrgDesignScenarioInput, UpdatePlannedMovementInput, UpdateWorkforceCycleInput, UpdateWorkforcePlanItemInput,
  VacancyDto, WorkforceCycleDto, WorkforceDashboardDto, WorkforcePlanItemDto,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'workforce';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
export interface WorkforceOptions { organizations: { id: string; name: string }[]; departments: { id: string; name: string; organizationId: string; parentId: string | null }[]; jobs: { id: string; title: string; code: string }[] }

export const useWorkforceOptions = () => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<WorkforceOptions>('/workforce/options').then((r) => r.data), staleTime: 60_000 });
export const useWorkforceDashboard = (cycleId: string | null) => useQuery({ queryKey: [KEY, 'dashboard', cycleId ?? ''], queryFn: () => api.get<WorkforceDashboardDto>(`/workforce/dashboard?${qs({ cycleId })}`).then((r) => r.data), placeholderData: (p) => p });
export const useVacancies = (organizationId?: string) => useQuery({ queryKey: [KEY, 'vacancies', organizationId ?? ''], queryFn: () => api.get<VacancyDto[]>(`/workforce/vacancies?${qs({ organizationId })}`).then((r) => r.data) });
export const useWorkforceCycles = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'cycles', f], queryFn: () => api.get<WorkforceCycleDto[]>(`/workforce/cycles?${qs(f)}`), placeholderData: (p) => p });
export const useWorkforceCycle = (id: string | null) => useQuery({ queryKey: [KEY, 'cycle', id ?? ''], queryFn: () => api.get<WorkforceCycleDto>(`/workforce/cycles/${id}`).then((r) => r.data), enabled: !!id });
export const usePlanItems = (cycleId: string | null, f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'items', cycleId ?? '', f], queryFn: () => api.get<WorkforcePlanItemDto[]>(`/workforce/cycles/${cycleId}/items?${qs(f)}`).then((r) => r.data), enabled: !!cycleId, placeholderData: (p) => p });
export const useMovements = (cycleId: string | null, enabled: boolean) => useQuery({ queryKey: [KEY, 'movements', cycleId ?? ''], queryFn: () => api.get<PlannedMovementDto[]>(`/workforce/cycles/${cycleId}/movements`).then((r) => r.data), enabled: !!cycleId && enabled });
export const useScenarios = (f: Record<string, unknown>, enabled = true) => useQuery({ queryKey: [KEY, 'scenarios', f], queryFn: () => api.get<OrgDesignScenarioDto[]>(`/workforce/scenarios?${qs(f)}`), placeholderData: (p) => p, enabled });
export const useScenarioTree = (id: string | null) => useQuery({ queryKey: [KEY, 'scenario', id ?? ''], queryFn: () => api.get<OrgDesignTreeDto>(`/workforce/scenarios/${id}`).then((r) => r.data), enabled: !!id });
export const useScenarioComparison = (id: string | null) => useQuery({ queryKey: [KEY, 'scenario-comparison', id ?? ''], queryFn: () => api.get<OrgDesignComparisonDto>(`/workforce/scenarios/${id}/comparison`).then((r) => r.data), enabled: !!id });
export const useCompareScenarios = (a: string | null, b: string | null) => useQuery({ queryKey: [KEY, 'compare', a ?? '', b ?? ''], queryFn: () => api.get<ScenarioComparisonDto>(`/workforce/scenarios/${a}/compare?with=${b}`).then((r) => r.data), enabled: !!a && !!b && a !== b });

export function useWorkforceMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['recruitment'] }); };
  return {
    createCycle: useMutation({ mutationFn: (input: CreateWorkforceCycleInput) => api.post<WorkforceCycleDto>('/workforce/cycles', input).then((r) => r.data), onSuccess: invalidate }),
    updateCycle: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateWorkforceCycleInput }) => api.patch<WorkforceCycleDto>(`/workforce/cycles/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    transitionCycle: useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api.post<WorkforceCycleDto>(`/workforce/cycles/${id}/transition`, { status }).then((r) => r.data), onSuccess: invalidate }),
    initialize: useMutation({ mutationFn: (id: string) => api.post<{ created: number; existing: number }>(`/workforce/cycles/${id}/initialize`).then((r) => r.data), onSuccess: invalidate }),
    addItem: useMutation({ mutationFn: ({ cycleId, input }: { cycleId: string; input: AddWorkforcePlanItemInput }) => api.post<WorkforcePlanItemDto>(`/workforce/cycles/${cycleId}/items`, input).then((r) => r.data), onSuccess: invalidate }),
    updateItem: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateWorkforcePlanItemInput }) => api.patch<WorkforcePlanItemDto>(`/workforce/items/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    removeItem: useMutation({ mutationFn: (id: string) => api.delete(`/workforce/items/${id}`), onSuccess: invalidate }),
    createRequisition: useMutation({ mutationFn: ({ id, input }: { id: string; input: RequisitionFromPlanInput }) => api.post<{ id: string; requisitionNumber: string }>(`/workforce/items/${id}/requisition`, input).then((r) => r.data), onSuccess: invalidate }),
    createMovement: useMutation({ mutationFn: ({ cycleId, input }: { cycleId: string; input: CreatePlannedMovementInput }) => api.post<PlannedMovementDto>(`/workforce/cycles/${cycleId}/movements`, input).then((r) => r.data), onSuccess: invalidate }),
    updateMovement: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdatePlannedMovementInput }) => api.patch<PlannedMovementDto>(`/workforce/movements/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createScenario: useMutation({ mutationFn: (input: CreateOrgDesignScenarioInput) => api.post<OrgDesignScenarioDto>('/workforce/scenarios', input).then((r) => r.data), onSuccess: invalidate }),
    updateScenario: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateOrgDesignScenarioInput }) => api.patch<OrgDesignScenarioDto>(`/workforce/scenarios/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    transitionScenario: useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api.post<OrgDesignScenarioDto>(`/workforce/scenarios/${id}/transition`, { status }).then((r) => r.data), onSuccess: invalidate }),
    duplicateScenario: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.post<OrgDesignScenarioDto>(`/workforce/scenarios/${id}/duplicate`, { name }).then((r) => r.data), onSuccess: invalidate }),
    importCurrent: useMutation({ mutationFn: (id: string) => api.post<{ created: number }>(`/workforce/scenarios/${id}/import-current`).then((r) => r.data), onSuccess: invalidate }),
    createNode: useMutation({ mutationFn: ({ scenarioId, input }: { scenarioId: string; input: CreateOrgDesignNodeInput }) => api.post<{ id: string }>(`/workforce/scenarios/${scenarioId}/nodes`, input).then((r) => r.data), onSuccess: invalidate }),
    updateNode: useMutation({ mutationFn: ({ scenarioId, nodeId, input }: { scenarioId: string; nodeId: string; input: UpdateOrgDesignNodeInput }) => api.patch(`/workforce/scenarios/${scenarioId}/nodes/${nodeId}`, input), onSuccess: invalidate }),
    deleteNode: useMutation({ mutationFn: ({ scenarioId, nodeId }: { scenarioId: string; nodeId: string }) => api.delete(`/workforce/scenarios/${scenarioId}/nodes/${nodeId}`), onSuccess: invalidate }),
    createPosition: useMutation({ mutationFn: ({ scenarioId, input }: { scenarioId: string; input: CreateOrgDesignPositionInput }) => api.post<{ id: string }>(`/workforce/scenarios/${scenarioId}/positions`, input).then((r) => r.data), onSuccess: invalidate }),
    updatePosition: useMutation({ mutationFn: ({ scenarioId, positionId, input }: { scenarioId: string; positionId: string; input: UpdateOrgDesignPositionInput }) => api.patch(`/workforce/scenarios/${scenarioId}/positions/${positionId}`, input), onSuccess: invalidate }),
    deletePosition: useMutation({ mutationFn: ({ scenarioId, positionId }: { scenarioId: string; positionId: string }) => api.delete(`/workforce/scenarios/${scenarioId}/positions/${positionId}`), onSuccess: invalidate }),
  };
}
