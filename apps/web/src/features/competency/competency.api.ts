import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssessmentDetailDto, AssessmentSummaryDto, AssignAssessmentsInput, AssignAssessmentsResultDto,
  CompetencyCategoryDto, CompetencyCycleDto, CompetencyDto, CompetencyScaleDto, CreateCompetencyCategoryInput,
  CreateCompetencyCycleInput, CreateCompetencyInput, CreateCompetencyScaleInput, GapReportDto, JobProfileDto,
  ManagerAssessmentItemInput, SelfAssessmentItemInput, SetJobRequirementInput, SkillProfileDto,
  UpdateCompetencyCycleInput, UpdateCompetencyInput, UpdateCompetencyScaleInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'competency';
export const competencyKeys = {
  categories: [KEY, 'categories'] as const,
  scales: [KEY, 'scales'] as const,
  competencies: (f: Record<string, unknown>) => [KEY, 'competencies', f] as const,
  jobProfile: (jobId: string) => [KEY, 'job-profile', jobId] as const,
  cycles: (f: Record<string, unknown>) => [KEY, 'cycles', f] as const,
  assessments: (f: Record<string, unknown>) => [KEY, 'assessments', f] as const,
  assessment: (id: string) => [KEY, 'assessment', id] as const,
  profile: (employeeId: string) => [KEY, 'profile', employeeId] as const,
  gapReport: (f: Record<string, unknown>) => [KEY, 'gap-report', f] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

export const useCompetencyCategories = () =>
  useQuery({ queryKey: competencyKeys.categories, queryFn: () => api.get<CompetencyCategoryDto[]>('/competency/categories').then((r) => r.data) });

export const useCompetencyScales = () =>
  useQuery({ queryKey: competencyKeys.scales, queryFn: () => api.get<CompetencyScaleDto[]>('/competency/scales').then((r) => r.data) });

export const useCompetencies = (f: Record<string, unknown>) =>
  useQuery({ queryKey: competencyKeys.competencies(f), queryFn: () => api.get<CompetencyDto[]>(`/competency/competencies?${qs(f)}`), placeholderData: (p) => p });

export const useJobProfile = (jobId: string | null) =>
  useQuery({ queryKey: competencyKeys.jobProfile(jobId ?? ''), queryFn: () => api.get<JobProfileDto>(`/competency/jobs/${jobId}/profile`).then((r) => r.data), enabled: !!jobId });

export const useCompetencyCycles = (f: Record<string, unknown>) =>
  useQuery({ queryKey: competencyKeys.cycles(f), queryFn: () => api.get<CompetencyCycleDto[]>(`/competency/cycles?${qs(f)}`), placeholderData: (p) => p });

export const useAssessments = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: competencyKeys.assessments(f), queryFn: () => api.get<AssessmentSummaryDto[]>(`/competency/assessments?${qs(f)}`), enabled, placeholderData: (p) => p });

export const useAssessment = (id: string | null) =>
  useQuery({ queryKey: competencyKeys.assessment(id ?? ''), queryFn: () => api.get<AssessmentDetailDto>(`/competency/assessments/${id}`).then((r) => r.data), enabled: !!id });

export const useMySkillProfile = () =>
  useQuery({ queryKey: competencyKeys.profile('me'), queryFn: () => api.get<SkillProfileDto>('/competency/profile/me').then((r) => r.data) });

export const useGapReport = (f: Record<string, unknown>) =>
  useQuery({ queryKey: competencyKeys.gapReport(f), queryFn: () => api.get<GapReportDto>(`/competency/reports/gaps?${qs(f)}`).then((r) => r.data) });

export function useCompetencyMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return {
    createCategory: useMutation({ mutationFn: (input: CreateCompetencyCategoryInput) => api.post<CompetencyCategoryDto>('/competency/categories', input).then((r) => r.data), onSuccess: invalidate }),
    createScale: useMutation({ mutationFn: (input: CreateCompetencyScaleInput) => api.post<CompetencyScaleDto>('/competency/scales', input).then((r) => r.data), onSuccess: invalidate }),
    updateScale: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateCompetencyScaleInput }) => api.patch<CompetencyScaleDto>(`/competency/scales/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    createCompetency: useMutation({ mutationFn: (input: CreateCompetencyInput) => api.post<CompetencyDto>('/competency/competencies', input).then((r) => r.data), onSuccess: invalidate }),
    updateCompetency: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateCompetencyInput }) => api.patch<CompetencyDto>(`/competency/competencies/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    setRequirement: useMutation({
      mutationFn: ({ jobId, input }: { jobId: string; input: SetJobRequirementInput }) => api.put<JobProfileDto>(`/competency/jobs/${jobId}/profile`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    removeRequirement: useMutation({
      mutationFn: ({ jobId, competencyId }: { jobId: string; competencyId: string }) => api.delete<JobProfileDto>(`/competency/jobs/${jobId}/profile/${competencyId}`).then((r) => r.data),
      onSuccess: invalidate,
    }),
    createCycle: useMutation({ mutationFn: (input: CreateCompetencyCycleInput) => api.post<CompetencyCycleDto>('/competency/cycles', input).then((r) => r.data), onSuccess: invalidate }),
    updateCycle: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateCompetencyCycleInput }) => api.patch<CompetencyCycleDto>(`/competency/cycles/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    transition: useMutation({
      mutationFn: ({ id, action }: { id: string; action: 'activate' | 'open-review' | 'close' }) => api.post<CompetencyCycleDto>(`/competency/cycles/${id}/${action}`).then((r) => r.data),
      onSuccess: invalidate,
    }),
    assign: useMutation({
      mutationFn: ({ cycleId, input }: { cycleId: string; input: AssignAssessmentsInput }) => api.post<AssignAssessmentsResultDto>(`/competency/cycles/${cycleId}/assign`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    selfAssess: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: SelfAssessmentItemInput }) => api.patch<AssessmentDetailDto>(`/competency/items/${itemId}/self`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    submitSelf: useMutation({ mutationFn: (id: string) => api.post<AssessmentDetailDto>(`/competency/assessments/${id}/submit-self`).then((r) => r.data), onSuccess: invalidate }),
    managerAssess: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: ManagerAssessmentItemInput }) => api.patch<AssessmentDetailDto>(`/competency/items/${itemId}/manager`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    submitManager: useMutation({ mutationFn: (id: string) => api.post<AssessmentDetailDto>(`/competency/assessments/${id}/submit-manager`).then((r) => r.data), onSuccess: invalidate }),
    reassignReviewer: useMutation({
      mutationFn: ({ id, reviewerEmployeeId }: { id: string; reviewerEmployeeId: string | null }) =>
        api.patch<AssessmentDetailDto>(`/competency/assessments/${id}/reviewer`, { reviewerEmployeeId }).then((r) => r.data),
      onSuccess: invalidate,
    }),
  };
}
