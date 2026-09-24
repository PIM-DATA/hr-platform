import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddCareerStepInput, AddPoolMemberInput, AssignTalentReviewsInput, CareerPathDto, CareerReadinessDto, CreateCareerPathInput, CreateDevelopmentActionInput,
  CreateSuccessionPlanInput, CreateTalentCycleInput, CreateTalentPoolInput, MyCareerDto, NineBoxDto, NominateSuccessorInput, RemovePoolMemberInput, RemoveSuccessorInput,
  SetBucketRulesInput, SubmitPotentialInput, SuccessionCandidateContextDto, SuccessionCandidateDto, SuccessionPlanDto, SuccessionReportDto, TalentCycleDto, TalentPoolDto,
  TalentPoolMemberDto, TalentReportDto, TalentReviewContextDto, TalentReviewDto, TrainingNeedDto, UpdateCareerPathInput, UpdateSuccessionPlanInput, UpdateSuccessorInput,
  UpdateTalentCycleInput, UpdateTalentPoolInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'talent';
export const talentKeys = {
  myCareer: [KEY, 'career', 'me'] as const,
  team: [KEY, 'career', 'team'] as const,
  readiness: (employeeId: string, jobId: string) => [KEY, 'career', 'readiness', employeeId, jobId] as const,
  paths: (includeInactive: boolean) => [KEY, 'career', 'paths', includeInactive] as const,
  jobOptions: [KEY, 'career', 'job-options'] as const,
  cycles: (f: Record<string, unknown>) => [KEY, 'cycles', f] as const,
  cycle: (id: string) => [KEY, 'cycle', id] as const,
  nineBox: (id: string) => [KEY, 'nine-box', id] as const,
  reviews: (f: Record<string, unknown>) => [KEY, 'reviews', f] as const,
  review: (id: string) => [KEY, 'review', id] as const,
  reviewContext: (id: string) => [KEY, 'review-context', id] as const,
  pools: (includeInactive: boolean) => [KEY, 'pools', includeInactive] as const,
  poolMembers: (id: string, includeRemoved: boolean) => [KEY, 'pool-members', id, includeRemoved] as const,
  plans: (f: Record<string, unknown>) => [KEY, 'succession', f] as const,
  plan: (id: string) => [KEY, 'succession-plan', id] as const,
  candidateContext: (id: string) => [KEY, 'candidate-context', id] as const,
  reportTalent: [KEY, 'reports', 'talent'] as const,
  reportSuccession: [KEY, 'reports', 'succession'] as const,
};
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };

export interface TeamCareerRowDto { employee: { id: string; employeeCode: string; firstName: string; lastName: string }; currentJob: { id: string; code: string; title: string } | null; departmentName: string | null; nextJobCount: number; development: { openNeeds: number; activeIdpId: string | null; activeIdpTitle: string | null } }
export interface PositionOptionDto { id: string; code: string; title: string; department: { name: string }; job: { title: string } | null }

export const useMyCareer = (enabled = true) => useQuery({ queryKey: talentKeys.myCareer, queryFn: () => api.get<MyCareerDto>('/talent/career/me').then((r) => r.data), enabled });
export const useTeamCareer = () => useQuery({ queryKey: talentKeys.team, queryFn: () => api.get<TeamCareerRowDto[]>('/talent/career/team').then((r) => r.data) });
export const useCareerReadiness = (employeeId: string | null, targetJobId: string | null) =>
  useQuery({ queryKey: talentKeys.readiness(employeeId ?? '', targetJobId ?? ''), queryFn: () => api.get<CareerReadinessDto>(`/talent/career/readiness?${qs({ employeeId, targetJobId })}`).then((r) => r.data), enabled: !!targetJobId });
export const useCareerPaths = (includeInactive = false) => useQuery({ queryKey: talentKeys.paths(includeInactive), queryFn: () => api.get<CareerPathDto[]>(`/talent/career/paths?includeInactive=${includeInactive}`).then((r) => r.data) });
export const useJobOptions = () => useQuery({ queryKey: talentKeys.jobOptions, queryFn: () => api.get<{ id: string; code: string; title: string }[]>('/talent/career/job-options').then((r) => r.data), staleTime: 60_000 });
export const useTalentCycles = (f: Record<string, unknown>) => useQuery({ queryKey: talentKeys.cycles(f), queryFn: () => api.get<TalentCycleDto[]>(`/talent/cycles?${qs(f)}`), placeholderData: (p) => p });
export const useTalentCycle = (id: string | null) => useQuery({ queryKey: talentKeys.cycle(id ?? ''), queryFn: () => api.get<TalentCycleDto>(`/talent/cycles/${id}`).then((r) => r.data), enabled: !!id });
export const useNineBox = (id: string | null) => useQuery({ queryKey: talentKeys.nineBox(id ?? ''), queryFn: () => api.get<NineBoxDto>(`/talent/cycles/${id}/nine-box`).then((r) => r.data), enabled: !!id });
export const useTalentReviews = (f: Record<string, unknown>, enabled = true) => useQuery({ queryKey: talentKeys.reviews(f), queryFn: () => api.get<TalentReviewDto[]>(`/talent/reviews?${qs(f)}`), placeholderData: (p) => p, enabled });
export const useTalentReviewContext = (id: string | null) => useQuery({ queryKey: talentKeys.reviewContext(id ?? ''), queryFn: () => api.get<TalentReviewContextDto>(`/talent/reviews/${id}/context`).then((r) => r.data), enabled: !!id });
export const useTalentPools = (includeInactive = false) => useQuery({ queryKey: talentKeys.pools(includeInactive), queryFn: () => api.get<TalentPoolDto[]>(`/talent/pools?includeInactive=${includeInactive}`).then((r) => r.data) });
export const usePoolMembers = (id: string | null, includeRemoved = false) => useQuery({ queryKey: talentKeys.poolMembers(id ?? '', includeRemoved), queryFn: () => api.get<TalentPoolMemberDto[]>(`/talent/pools/${id}/members?includeRemoved=${includeRemoved}`).then((r) => r.data), enabled: !!id });
export const useSuccessionPlans = (f: Record<string, unknown>) => useQuery({ queryKey: talentKeys.plans(f), queryFn: () => api.get<SuccessionPlanDto[]>(`/talent/succession/plans?${qs(f)}`), placeholderData: (p) => p });
export const useSuccessionPlan = (id: string | null) => useQuery({ queryKey: talentKeys.plan(id ?? ''), queryFn: () => api.get<SuccessionPlanDto>(`/talent/succession/plans/${id}`).then((r) => r.data), enabled: !!id });
export const useCandidateContext = (id: string | null) => useQuery({ queryKey: talentKeys.candidateContext(id ?? ''), queryFn: () => api.get<SuccessionCandidateContextDto>(`/talent/succession/candidates/${id}/context`).then((r) => r.data), enabled: !!id });
export const usePositionOptions = (search: string, enabled: boolean) => useQuery({ queryKey: [KEY, 'position-options', search], queryFn: () => api.get<PositionOptionDto[]>(`/talent/succession/position-options?${qs({ search })}`).then((r) => r.data), enabled });
export const useTalentReport = () => useQuery({ queryKey: talentKeys.reportTalent, queryFn: () => api.get<TalentReportDto>('/talent/reports/talent').then((r) => r.data) });
export const useSuccessionReport = () => useQuery({ queryKey: talentKeys.reportSuccession, queryFn: () => api.get<SuccessionReportDto>('/talent/reports/succession').then((r) => r.data) });

export function useTalentMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['training'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  const post = <T,>(url: string, body?: unknown) => api.post<T>(url, body).then((r) => r.data);
  return {
    createPath: useMutation({ mutationFn: (input: CreateCareerPathInput) => post<CareerPathDto>('/talent/career/paths', input), onSuccess: invalidate }),
    updatePath: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateCareerPathInput }) => api.patch<CareerPathDto>(`/talent/career/paths/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    addStep: useMutation({ mutationFn: ({ id, input }: { id: string; input: AddCareerStepInput }) => post<CareerPathDto>(`/talent/career/paths/${id}/steps`, input), onSuccess: invalidate }),
    removeStep: useMutation({ mutationFn: ({ id, stepId }: { id: string; stepId: string }) => api.delete<CareerPathDto>(`/talent/career/paths/${id}/steps/${stepId}`).then((r) => r.data), onSuccess: invalidate }),
    createCycle: useMutation({ mutationFn: (input: CreateTalentCycleInput) => post<TalentCycleDto>('/talent/cycles', input), onSuccess: invalidate }),
    updateCycle: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTalentCycleInput }) => api.patch<TalentCycleDto>(`/talent/cycles/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    setBucketRules: useMutation({ mutationFn: ({ id, input }: { id: string; input: SetBucketRulesInput }) => api.put<TalentCycleDto>(`/talent/cycles/${id}/bucket-rules`, input).then((r) => r.data), onSuccess: invalidate }),
    activateCycle: useMutation({ mutationFn: (id: string) => post<TalentCycleDto>(`/talent/cycles/${id}/activate`), onSuccess: invalidate }),
    openReview: useMutation({ mutationFn: (id: string) => post<TalentCycleDto>(`/talent/cycles/${id}/open-review`), onSuccess: invalidate }),
    closeCycle: useMutation({ mutationFn: (id: string) => post<TalentCycleDto>(`/talent/cycles/${id}/close`), onSuccess: invalidate }),
    assign: useMutation({ mutationFn: ({ id, input }: { id: string; input: AssignTalentReviewsInput }) => post<{ created: number; skipped: { employeeCode: string; reason: string }[] }>(`/talent/cycles/${id}/assign`, input), onSuccess: invalidate }),
    reassign: useMutation({ mutationFn: ({ id, reviewerEmployeeId }: { id: string; reviewerEmployeeId: string }) => post<TalentReviewDto>(`/talent/reviews/${id}/reassign`, { reviewerEmployeeId }), onSuccess: invalidate }),
    submitPotential: useMutation({ mutationFn: ({ id, input }: { id: string; input: SubmitPotentialInput }) => post<TalentReviewDto>(`/talent/reviews/${id}/potential`, input), onSuccess: invalidate }),
    createPool: useMutation({ mutationFn: (input: CreateTalentPoolInput) => post<TalentPoolDto>('/talent/pools', input), onSuccess: invalidate }),
    updatePool: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTalentPoolInput }) => api.patch<TalentPoolDto>(`/talent/pools/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    addMember: useMutation({ mutationFn: ({ id, input }: { id: string; input: AddPoolMemberInput }) => post<TalentPoolMemberDto>(`/talent/pools/${id}/members`, input), onSuccess: invalidate }),
    removeMember: useMutation({ mutationFn: ({ id, memberId, input }: { id: string; memberId: string; input: RemovePoolMemberInput }) => post<TalentPoolMemberDto>(`/talent/pools/${id}/members/${memberId}/remove`, input), onSuccess: invalidate }),
    createPlan: useMutation({ mutationFn: (input: CreateSuccessionPlanInput) => post<SuccessionPlanDto>('/talent/succession/plans', input), onSuccess: invalidate }),
    updatePlan: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateSuccessionPlanInput }) => api.patch<SuccessionPlanDto>(`/talent/succession/plans/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    nominate: useMutation({ mutationFn: ({ id, input }: { id: string; input: NominateSuccessorInput }) => post<SuccessionCandidateDto>(`/talent/succession/plans/${id}/candidates`, input), onSuccess: invalidate }),
    updateCandidate: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateSuccessorInput }) => api.patch<SuccessionCandidateDto>(`/talent/succession/candidates/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    removeCandidate: useMutation({ mutationFn: ({ id, input }: { id: string; input: RemoveSuccessorInput }) => post<SuccessionCandidateDto>(`/talent/succession/candidates/${id}/remove`, input), onSuccess: invalidate }),
    createDevelopmentAction: useMutation({ mutationFn: (input: CreateDevelopmentActionInput) => post<TrainingNeedDto>('/talent/development-actions', input), onSuccess: invalidate }),
  };
}
