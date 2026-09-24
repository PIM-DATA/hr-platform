import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplicationDetailDto, ApplicationDto, CandidateDto, CreateApplicationInput, CreateCandidateInput, CreateOfferInput, CreateOpeningInput,
  CreateRequisitionInput, DuplicateCandidateDto, HireCandidateInput, HireResultDto, InterviewDto, MoveStageInput, OfferDto, OpeningDto,
  RecruitmentDashboardDto, RecruitmentPolicyDto, RecruitmentReportDto, RejectApplicationInput, RequisitionDto, ScheduleInterviewInput,
  SubmitFeedbackInput, UpdateCandidateInput, UpdateInterviewInput, UpdateOfferInput, UpdateOpeningInput, UpdateRequisitionInput,
  UpsertRecruitmentPolicyInput, WithdrawApplicationInput, WorkflowInboxItemDto,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'recruitment';
export const recruitmentKeys = {
  dashboard: [KEY, 'dashboard'] as const,
  options: [KEY, 'options'] as const,
  policies: [KEY, 'policies'] as const,
  requisitions: (f: Record<string, unknown>) => [KEY, 'requisitions', f] as const,
  requisition: (id: string) => [KEY, 'requisition', id] as const,
  openings: (f: Record<string, unknown>) => [KEY, 'openings', f] as const,
  opening: (id: string) => [KEY, 'opening', id] as const,
  candidates: (f: Record<string, unknown>) => [KEY, 'candidates', f] as const,
  candidate: (id: string) => [KEY, 'candidate', id] as const,
  duplicates: (email: string, phone: string) => [KEY, 'duplicates', email, phone] as const,
  applications: (f: Record<string, unknown>) => [KEY, 'applications', f] as const,
  application: (id: string) => [KEY, 'application', id] as const,
  interviews: (f: Record<string, unknown>) => [KEY, 'interviews', f] as const,
  interview: (id: string) => [KEY, 'interview', id] as const,
  offers: (f: Record<string, unknown>) => [KEY, 'offers', f] as const,
  offer: (id: string) => [KEY, 'offer', id] as const,
  inbox: [KEY, 'inbox'] as const,
  report: (f: Record<string, unknown>) => [KEY, 'report', f] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

export interface RecruitmentOptions {
  organizations: { id: string; code: string; name: string; timezone: string }[];
  departments: { id: string; code: string; name: string; organizationId: string }[];
  jobs: { id: string; code: string; title: string }[];
  positions: { id: string; code: string; title: string; departmentId: string; jobId: string }[];
}
export interface InterviewerOption { userId: string; employeeCode: string | null; name: string; departmentName: string | null }

export const useRecruitmentDashboard = () => useQuery({ queryKey: recruitmentKeys.dashboard, queryFn: () => api.get<RecruitmentDashboardDto>('/recruitment/dashboard').then((r) => r.data) });
export const useRecruitmentOptions = () => useQuery({ queryKey: recruitmentKeys.options, queryFn: () => api.get<RecruitmentOptions>('/recruitment/options').then((r) => r.data), staleTime: 60_000 });
export const useRecruitmentPolicies = () => useQuery({ queryKey: recruitmentKeys.policies, queryFn: () => api.get<RecruitmentPolicyDto[]>('/recruitment/policies').then((r) => r.data) });
export const useInterviewerOptions = (search: string, enabled: boolean) =>
  useQuery({ queryKey: [KEY, 'interviewer-options', search], queryFn: () => api.get<InterviewerOption[]>(`/recruitment/interviewer-options?${qs({ search, limit: 20 })}`).then((r) => r.data), enabled });

export const useRequisitions = (f: Record<string, unknown>) => useQuery({ queryKey: recruitmentKeys.requisitions(f), queryFn: () => api.get<RequisitionDto[]>(`/recruitment/requisitions?${qs(f)}`), placeholderData: (p) => p });
export const useRequisition = (id: string | null) => useQuery({ queryKey: recruitmentKeys.requisition(id ?? ''), queryFn: () => api.get<RequisitionDto>(`/recruitment/requisitions/${id}`).then((r) => r.data), enabled: !!id });
export const useOpenings = (f: Record<string, unknown>) => useQuery({ queryKey: recruitmentKeys.openings(f), queryFn: () => api.get<OpeningDto[]>(`/recruitment/openings?${qs(f)}`), placeholderData: (p) => p });
export const useOpening = (id: string | null) => useQuery({ queryKey: recruitmentKeys.opening(id ?? ''), queryFn: () => api.get<OpeningDto>(`/recruitment/openings/${id}`).then((r) => r.data), enabled: !!id });
export const useCandidates = (f: Record<string, unknown>) => useQuery({ queryKey: recruitmentKeys.candidates(f), queryFn: () => api.get<CandidateDto[]>(`/recruitment/candidates?${qs(f)}`), placeholderData: (p) => p });
export const useCandidate = (id: string | null) => useQuery({ queryKey: recruitmentKeys.candidate(id ?? ''), queryFn: () => api.get<CandidateDto>(`/recruitment/candidates/${id}`).then((r) => r.data), enabled: !!id });
export const useDuplicateCheck = (email: string, phone: string, enabled: boolean) =>
  useQuery({ queryKey: recruitmentKeys.duplicates(email, phone), queryFn: () => api.get<DuplicateCandidateDto[]>(`/recruitment/candidates/duplicates?${qs({ email, phone })}`).then((r) => r.data), enabled: enabled && (!!email || !!phone) });
export const useApplications = (f: Record<string, unknown>) => useQuery({ queryKey: recruitmentKeys.applications(f), queryFn: () => api.get<ApplicationDto[]>(`/recruitment/applications?${qs(f)}`), placeholderData: (p) => p });
export const useApplication = (id: string | null) => useQuery({ queryKey: recruitmentKeys.application(id ?? ''), queryFn: () => api.get<ApplicationDetailDto>(`/recruitment/applications/${id}`).then((r) => r.data), enabled: !!id });
export const useInterviews = (f: Record<string, unknown>) => useQuery({ queryKey: recruitmentKeys.interviews(f), queryFn: () => api.get<InterviewDto[]>(`/recruitment/interviews?${qs(f)}`), placeholderData: (p) => p });
export const useInterview = (id: string | null) => useQuery({ queryKey: recruitmentKeys.interview(id ?? ''), queryFn: () => api.get<InterviewDto>(`/recruitment/interviews/${id}`).then((r) => r.data), enabled: !!id });
export const useOffers = (f: Record<string, unknown>) => useQuery({ queryKey: recruitmentKeys.offers(f), queryFn: () => api.get<OfferDto[]>(`/recruitment/offers?${qs(f)}`), placeholderData: (p) => p });
export const useOffer = (id: string | null) => useQuery({ queryKey: recruitmentKeys.offer(id ?? ''), queryFn: () => api.get<OfferDto>(`/recruitment/offers/${id}`).then((r) => r.data), enabled: !!id });
/** The caller's pending recruitment approvals (requisitions and offers), from the shared workflow inbox. */
export const useRecruitmentInbox = (enabled: boolean) => useQuery({ queryKey: recruitmentKeys.inbox, queryFn: () => api.get<WorkflowInboxItemDto[]>('/workflow/inbox?module=recruitment&pageSize=50').then((r) => r.data), enabled });
export const useRecruitmentReport = (f: Record<string, unknown>) => useQuery({ queryKey: recruitmentKeys.report(f), queryFn: () => api.get<RecruitmentReportDto>(`/recruitment/reports/summary?${qs(f)}`).then((r) => r.data) });

export function useRecruitmentMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['workflow'] });
    qc.invalidateQueries({ queryKey: ['employees'] });
  };
  const post = <T,>(url: string, body?: unknown) => api.post<T>(url, body).then((r) => r.data);
  return {
    upsertPolicy: useMutation({ mutationFn: (input: UpsertRecruitmentPolicyInput) => api.put<RecruitmentPolicyDto>('/recruitment/policies', input).then((r) => r.data), onSuccess: invalidate }),
    createRequisition: useMutation({ mutationFn: (input: CreateRequisitionInput) => post<RequisitionDto>('/recruitment/requisitions', input), onSuccess: invalidate }),
    updateRequisition: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateRequisitionInput }) => api.patch<RequisitionDto>(`/recruitment/requisitions/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    submitRequisition: useMutation({ mutationFn: (id: string) => post<RequisitionDto>(`/recruitment/requisitions/${id}/submit`), onSuccess: invalidate }),
    cancelRequisition: useMutation({ mutationFn: (id: string) => post<RequisitionDto>(`/recruitment/requisitions/${id}/cancel`), onSuccess: invalidate }),
    closeRequisition: useMutation({ mutationFn: (id: string) => post<RequisitionDto>(`/recruitment/requisitions/${id}/close`), onSuccess: invalidate }),
    createOpening: useMutation({ mutationFn: (input: CreateOpeningInput) => post<OpeningDto>('/recruitment/openings', input), onSuccess: invalidate }),
    updateOpening: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateOpeningInput }) => api.patch<OpeningDto>(`/recruitment/openings/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    openOpening: useMutation({ mutationFn: (id: string) => post<OpeningDto>(`/recruitment/openings/${id}/open`), onSuccess: invalidate }),
    holdOpening: useMutation({ mutationFn: (id: string) => post<OpeningDto>(`/recruitment/openings/${id}/hold`), onSuccess: invalidate }),
    closeOpening: useMutation({ mutationFn: (id: string) => post<OpeningDto>(`/recruitment/openings/${id}/close`), onSuccess: invalidate }),
    createCandidate: useMutation({ mutationFn: (input: CreateCandidateInput) => post<CandidateDto>('/recruitment/candidates', input), onSuccess: invalidate }),
    updateCandidate: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateCandidateInput }) => api.patch<CandidateDto>(`/recruitment/candidates/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createApplication: useMutation({ mutationFn: (input: CreateApplicationInput) => post<ApplicationDto>('/recruitment/applications', input), onSuccess: invalidate }),
    moveStage: useMutation({ mutationFn: ({ id, input }: { id: string; input: MoveStageInput }) => post<ApplicationDetailDto>(`/recruitment/applications/${id}/move-stage`, input), onSuccess: invalidate }),
    rejectApplication: useMutation({ mutationFn: ({ id, input }: { id: string; input: RejectApplicationInput }) => post<ApplicationDetailDto>(`/recruitment/applications/${id}/reject`, input), onSuccess: invalidate }),
    withdrawApplication: useMutation({ mutationFn: ({ id, input }: { id: string; input: WithdrawApplicationInput }) => post<ApplicationDetailDto>(`/recruitment/applications/${id}/withdraw`, input), onSuccess: invalidate }),
    scheduleInterview: useMutation({ mutationFn: ({ applicationId, input }: { applicationId: string; input: ScheduleInterviewInput }) => post<InterviewDto>(`/recruitment/applications/${applicationId}/interviews`, input), onSuccess: invalidate }),
    updateInterview: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateInterviewInput }) => api.patch<InterviewDto>(`/recruitment/interviews/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    submitFeedback: useMutation({ mutationFn: ({ id, input }: { id: string; input: SubmitFeedbackInput }) => post<InterviewDto>(`/recruitment/interviews/${id}/feedback`, input), onSuccess: invalidate }),
    createOffer: useMutation({ mutationFn: (input: CreateOfferInput) => post<OfferDto>('/recruitment/offers', input), onSuccess: invalidate }),
    updateOffer: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateOfferInput }) => api.patch<OfferDto>(`/recruitment/offers/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    submitOffer: useMutation({ mutationFn: (id: string) => post<OfferDto>(`/recruitment/offers/${id}/submit`), onSuccess: invalidate }),
    markOfferSent: useMutation({ mutationFn: (id: string) => post<OfferDto>(`/recruitment/offers/${id}/mark-sent`), onSuccess: invalidate }),
    recordOfferAccepted: useMutation({ mutationFn: (id: string) => post<OfferDto>(`/recruitment/offers/${id}/record-accepted`), onSuccess: invalidate }),
    recordOfferDeclined: useMutation({ mutationFn: (id: string) => post<OfferDto>(`/recruitment/offers/${id}/record-declined`), onSuccess: invalidate }),
    withdrawOffer: useMutation({ mutationFn: (id: string) => post<OfferDto>(`/recruitment/offers/${id}/withdraw`), onSuccess: invalidate }),
    hire: useMutation({ mutationFn: ({ applicationId, input }: { applicationId: string; input: HireCandidateInput }) => post<HireResultDto>(`/recruitment/applications/${applicationId}/hire`, input), onSuccess: invalidate }),
    /** Approve and reject go through the shared workflow endpoint — recruitment has no approval mutation of its own. */
    decide: useMutation({ mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) => api.post(`/workflow/instances/${instanceId}/actions`, { action, comment }), onSuccess: invalidate }),
  };
}
