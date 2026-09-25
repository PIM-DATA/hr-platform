import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CertificationDefinitionDto, CompetencyEvidenceDto, CreateCertificationDefinitionInput, CreateLearningPathInput, CreateOjtPlanInput, CreateOjtProgramInput, EmployeeCertificationDto,
  IssueCertificationInput, LearningDashboardDto, LearningPathDto, LearningReportDto, MyLearningDto, OjtPlanActivityDto, OjtPlanDetailDto, OjtPlanDto, OjtProgramDto, PathAssignmentDto,
  RenewCertificationInput, SubmitObservationInput, SubmitOjtAssessmentInput, UpdateCertificationDefinitionInput, UpdateLearningPathInput, UpdateOjtActivityInput, UpdateOjtPlanInput, UpdateOjtProgramInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'learning';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };
export interface LearningOptions { organizations: { id: string; name: string }[]; jobs: { id: string; title: string }[]; competencies: { id: string; code: string; name: string }[]; courses: { id: string; code: string; title: string }[] }

export const useMyLearning = () => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<MyLearningDto>('/learning/my').then((r) => r.data) });
export const useLearningDashboard = () => useQuery({ queryKey: [KEY, 'dashboard'], queryFn: () => api.get<LearningDashboardDto>('/learning/dashboard').then((r) => r.data) });
export const useLearningReport = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'report', f], queryFn: () => api.get<LearningReportDto>(`/learning/reports?${qs(f)}`).then((r) => r.data) });
export const useLearningOptions = () => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<LearningOptions>('/learning/options').then((r) => r.data), staleTime: 60_000 });
export const useOjtPrograms = (includeInactive = false) => useQuery({ queryKey: [KEY, 'programs', includeInactive], queryFn: () => api.get<OjtProgramDto[]>(`/learning/ojt/programs?${qs({ includeInactive })}`).then((r) => r.data) });
export const useOjtPlans = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'plans', f], queryFn: () => api.get<OjtPlanDto[]>(`/learning/ojt/plans?${qs(f)}`) as Promise<Page<OjtPlanDto>>, placeholderData: (p) => p });
export const useOjtPlan = (id: string | null) => useQuery({ queryKey: [KEY, 'plan', id ?? ''], queryFn: () => api.get<OjtPlanDetailDto>(`/learning/ojt/plans/${id}`).then((r) => r.data), enabled: !!id });
export const useCompetencyEvidence = (employeeId: string | null) => useQuery({ queryKey: [KEY, 'evidence', employeeId ?? ''], queryFn: () => api.get<CompetencyEvidenceDto[]>(`/learning/competency-evidence/${employeeId}`).then((r) => r.data), enabled: !!employeeId });
export const useLearningPaths = (includeInactive = false) => useQuery({ queryKey: [KEY, 'paths', includeInactive], queryFn: () => api.get<LearningPathDto[]>(`/learning/paths?${qs({ includeInactive })}`).then((r) => r.data) });
export const usePathAssignments = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'assignments', f], queryFn: () => api.get<PathAssignmentDto[]>(`/learning/path-assignments?${qs(f)}`) as Promise<Page<PathAssignmentDto>>, placeholderData: (p) => p });
export const usePathAssignment = (id: string | null) => useQuery({ queryKey: [KEY, 'assignment', id ?? ''], queryFn: () => api.get<PathAssignmentDto>(`/learning/path-assignments/${id}`).then((r) => r.data), enabled: !!id });
export const useCertificationDefinitions = (includeInactive = false) => useQuery({ queryKey: [KEY, 'cert-defs', includeInactive], queryFn: () => api.get<CertificationDefinitionDto[]>(`/learning/certifications/definitions?${qs({ includeInactive })}`).then((r) => r.data) });
export const useCertifications = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'certs', f], queryFn: () => api.get<EmployeeCertificationDto[]>(`/learning/certifications?${qs(f)}`) as Promise<Page<EmployeeCertificationDto>>, placeholderData: (p) => p });
export const useCertification = (id: string | null) => useQuery({ queryKey: [KEY, 'cert', id ?? ''], queryFn: () => api.get<EmployeeCertificationDto>(`/learning/certifications/${id}`).then((r) => r.data), enabled: !!id });

export function useLearningMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['training'] }); qc.invalidateQueries({ queryKey: ['documents'] }); };
  return {
    createProgram: useMutation({ mutationFn: (input: CreateOjtProgramInput) => api.post<OjtProgramDto>('/learning/ojt/programs', input).then((r) => r.data), onSuccess: invalidate }),
    updateProgram: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateOjtProgramInput }) => api.patch<OjtProgramDto>(`/learning/ojt/programs/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createPlan: useMutation({ mutationFn: (input: CreateOjtPlanInput) => api.post<OjtPlanDetailDto>('/learning/ojt/plans', input).then((r) => r.data), onSuccess: invalidate }),
    updatePlan: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateOjtPlanInput }) => api.patch<OjtPlanDetailDto>(`/learning/ojt/plans/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    activatePlan: useMutation({ mutationFn: (id: string) => api.post<OjtPlanDetailDto>(`/learning/ojt/plans/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    completePlan: useMutation({ mutationFn: (id: string) => api.post<OjtPlanDetailDto>(`/learning/ojt/plans/${id}/complete`).then((r) => r.data), onSuccess: invalidate }),
    cancelPlan: useMutation({ mutationFn: (id: string) => api.post<OjtPlanDetailDto>(`/learning/ojt/plans/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    assess: useMutation({ mutationFn: ({ id, input }: { id: string; input: SubmitOjtAssessmentInput }) => api.post<OjtPlanDetailDto>(`/learning/ojt/plans/${id}/assessments`, input).then((r) => r.data), onSuccess: invalidate }),
    handoff: useMutation({ mutationFn: ({ id, competencyIds, note }: { id: string; competencyIds?: string[]; note?: string }) => api.post<CompetencyEvidenceDto[]>(`/learning/ojt/plans/${id}/competency-evidence`, { competencyIds, note }).then((r) => r.data), onSuccess: invalidate }),
    updateActivity: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateOjtActivityInput }) => api.patch<OjtPlanActivityDto>(`/learning/ojt/activities/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    observe: useMutation({ mutationFn: ({ id, input }: { id: string; input: SubmitObservationInput }) => api.post<OjtPlanActivityDto>(`/learning/ojt/activities/${id}/observations`, input).then((r) => r.data), onSuccess: invalidate }),
    createPath: useMutation({ mutationFn: (input: CreateLearningPathInput) => api.post<LearningPathDto>('/learning/paths', input).then((r) => r.data), onSuccess: invalidate }),
    updatePath: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateLearningPathInput }) => api.patch<LearningPathDto>(`/learning/paths/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    assignPath: useMutation({ mutationFn: ({ id, input }: { id: string; input: { employeeId: string; targetDate?: string | null } }) => api.post<PathAssignmentDto>(`/learning/paths/${id}/assignments`, input).then((r) => r.data), onSuccess: invalidate }),
    fulfilStep: useMutation({ mutationFn: ({ id, stepId, input }: { id: string; stepId: string; input: { idpItemId?: string | null; note?: string | null } }) => api.post<PathAssignmentDto>(`/learning/path-assignments/${id}/steps/${stepId}/fulfil`, input).then((r) => r.data), onSuccess: invalidate }),
    cancelAssignment: useMutation({ mutationFn: (id: string) => api.post<PathAssignmentDto>(`/learning/path-assignments/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    createDefinition: useMutation({ mutationFn: (input: CreateCertificationDefinitionInput) => api.post<CertificationDefinitionDto>('/learning/certifications/definitions', input).then((r) => r.data), onSuccess: invalidate }),
    updateDefinition: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateCertificationDefinitionInput }) => api.patch<CertificationDefinitionDto>(`/learning/certifications/definitions/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    issue: useMutation({ mutationFn: (input: IssueCertificationInput) => api.post<EmployeeCertificationDto>('/learning/certifications', input).then((r) => r.data), onSuccess: invalidate }),
    renew: useMutation({ mutationFn: ({ id, input }: { id: string; input: RenewCertificationInput }) => api.post<EmployeeCertificationDto>(`/learning/certifications/${id}/renew`, input).then((r) => r.data), onSuccess: invalidate }),
    revoke: useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<EmployeeCertificationDto>(`/learning/certifications/${id}/revoke`, { reason }).then((r) => r.data), onSuccess: invalidate }),
  };
}
