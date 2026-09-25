import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddSurveyQuestionInput, AssignAudienceInput, BreakdownRowDto, CommentDto, CreateQuestionBankInput, CreateSurveyInput, EngagementDashboardDto, IdentifiedResponseDto, MySurveyDto, ParticipationRowDto, QuestionBankDto,
  ResultsFilter, SubmitResponseInput, SurveyDetailDto, SurveyDto, SurveyFormDto, SurveyResultsDto, UpdateQuestionBankInput, UpdateSurveyInput, UpdateSurveyQuestionInput,
} from '@hr/shared';
import { api, ApiClientError, getCsrfToken } from '@/lib/api-client';

const KEY = 'engagement';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
export interface EngagementOptions { organizations: { id: string; name: string }[]; departments: { id: string; name: string; organizationId: string }[]; jobs: { id: string; title: string }[]; positions: { id: string; title: string; code: string; departmentId: string }[] }

export const useMySurveys = () => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<MySurveyDto[]>('/engagement/my/surveys').then((r) => r.data) });
export const useSurveyForm = (id: string | null) => useQuery({ queryKey: [KEY, 'form', id ?? ''], queryFn: () => api.get<SurveyFormDto>(`/engagement/my/surveys/${id}`).then((r) => r.data), enabled: !!id });
export const useEngagementOptions = (enabled = true) => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<EngagementOptions>('/engagement/options').then((r) => r.data), enabled, staleTime: 60_000 });
export const useQuestionBank = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'bank', f], queryFn: () => api.get<QuestionBankDto[]>(`/engagement/questions?${qs(f)}`).then((r) => r.data), placeholderData: (p) => p });
export const useEngagementDashboard = () => useQuery({ queryKey: [KEY, 'dashboard'], queryFn: () => api.get<EngagementDashboardDto>('/engagement/dashboard').then((r) => r.data) });
export const useSurveys = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'surveys', f], queryFn: () => api.get<SurveyDto[]>(`/engagement/surveys?${qs(f)}`), placeholderData: (p) => p });
export const useSurvey = (id: string | null) => useQuery({ queryKey: [KEY, 'survey', id ?? ''], queryFn: () => api.get<SurveyDetailDto>(`/engagement/surveys/${id}`).then((r) => r.data), enabled: !!id });
export const useSurveyResults = (id: string | null, f: ResultsFilter) => useQuery({ queryKey: [KEY, 'results', id ?? '', f], queryFn: () => api.get<SurveyResultsDto>(`/engagement/surveys/${id}/results?${qs(f)}`).then((r) => r.data), enabled: !!id, placeholderData: (p) => p });
export const useBreakdown = (id: string | null, by: string, f: ResultsFilter) => useQuery({ queryKey: [KEY, 'breakdown', id ?? '', by, f], queryFn: () => api.get<BreakdownRowDto[]>(`/engagement/surveys/${id}/breakdown?${qs({ by, ...f })}`).then((r) => r.data), enabled: !!id });
export const useParticipation = (id: string | null, f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'participation', id ?? '', f], queryFn: () => api.get<ParticipationRowDto[]>(`/engagement/surveys/${id}/participation?${qs(f)}`), enabled: !!id, placeholderData: (p) => p });
export const useComments = (id: string | null, enabled: boolean) => useQuery({ queryKey: [KEY, 'comments', id ?? ''], queryFn: () => api.get<CommentDto[]>(`/engagement/surveys/${id}/comments`).then((r) => r.data), enabled: !!id && enabled, retry: false });
export const useIdentifiedResponses = (id: string | null, enabled: boolean) => useQuery({ queryKey: [KEY, 'responses', id ?? ''], queryFn: () => api.get<IdentifiedResponseDto[]>(`/engagement/surveys/${id}/responses`).then((r) => r.data), enabled: !!id && enabled, retry: false });

export function useEngagementMutations() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: [KEY] }); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  return {
    submit: useMutation({ mutationFn: ({ id, input }: { id: string; input: SubmitResponseInput }) => api.post<{ completedAt: string }>(`/engagement/my/surveys/${id}/responses`, input).then((r) => r.data), onSuccess: invalidate }),
    createQuestion: useMutation({ mutationFn: (input: CreateQuestionBankInput) => api.post<QuestionBankDto>('/engagement/questions', input).then((r) => r.data), onSuccess: invalidate }),
    updateQuestion: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateQuestionBankInput }) => api.patch<QuestionBankDto>(`/engagement/questions/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createSurvey: useMutation({ mutationFn: (input: CreateSurveyInput) => api.post<SurveyDto>('/engagement/surveys', input).then((r) => r.data), onSuccess: invalidate }),
    updateSurvey: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateSurveyInput }) => api.patch<SurveyDto>(`/engagement/surveys/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    deleteSurvey: useMutation({ mutationFn: (id: string) => api.delete(`/engagement/surveys/${id}`), onSuccess: invalidate }),
    duplicateSurvey: useMutation({ mutationFn: ({ id, code, name }: { id: string; code: string; name: string }) => api.post<SurveyDto>(`/engagement/surveys/${id}/duplicate`, { code, name }).then((r) => r.data), onSuccess: invalidate }),
    addQuestion: useMutation({ mutationFn: ({ id, input }: { id: string; input: AddSurveyQuestionInput }) => api.post(`/engagement/surveys/${id}/questions`, input), onSuccess: invalidate }),
    updateSurveyQuestion: useMutation({ mutationFn: ({ id, qid, input }: { id: string; qid: string; input: UpdateSurveyQuestionInput }) => api.patch(`/engagement/surveys/${id}/questions/${qid}`, input), onSuccess: invalidate }),
    removeQuestion: useMutation({ mutationFn: ({ id, qid }: { id: string; qid: string }) => api.delete(`/engagement/surveys/${id}/questions/${qid}`), onSuccess: invalidate }),
    assignAudience: useMutation({ mutationFn: ({ id, input }: { id: string; input: AssignAudienceInput }) => api.put<{ assigned: number }>(`/engagement/surveys/${id}/audience`, input).then((r) => r.data), onSuccess: invalidate }),
    open: useMutation({ mutationFn: (id: string) => api.post<SurveyDto>(`/engagement/surveys/${id}/open`).then((r) => r.data), onSuccess: invalidate }),
    close: useMutation({ mutationFn: (id: string) => api.post<SurveyDto>(`/engagement/surveys/${id}/close`).then((r) => r.data), onSuccess: invalidate }),
    archive: useMutation({ mutationFn: (id: string) => api.post<SurveyDto>(`/engagement/surveys/${id}/archive`).then((r) => r.data), onSuccess: invalidate }),
  };
}

export async function downloadResultsCsv(surveyId: string, code: string, f: ResultsFilter): Promise<void> {
  const base = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api/v1`;
  const csrf = getCsrfToken();
  const res = await fetch(`${base}/engagement/surveys/${surveyId}/results.csv?${qs(f)}`, { credentials: 'include', headers: csrf ? { 'x-csrf-token': csrf } : undefined });
  if (!res.ok) throw new ApiClientError(res.status, { code: 'EXPORT_FAILED', message: 'Could not export the results' });
  const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `engagement-${code}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
