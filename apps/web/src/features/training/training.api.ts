import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddIdpItemInput, CourseDto, CreateCourseInput, CreateIdpInput, CreateSessionInput, CreateTrainingNeedInput,
  EnrollInput, EnrollResultDto, EnrollmentDto, GenerateTnaInput, GenerateTnaResultDto, IdpDetailDto, IdpSummaryDto,
  MyDevelopmentDto, RecordAttendanceInput, RecordResultInput, SessionDto, TeamDevelopmentDto, TrainingNeedDto,
  TrainingReportDto, UpdateCourseInput, UpdateIdpItemInput, UpdateIdpProgressInput, UpdateSessionInput,
  UpdateTrainingNeedInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'training';
export const trainingKeys = {
  me: [KEY, 'me'] as const,
  team: [KEY, 'team'] as const,
  needs: (f: Record<string, unknown>) => [KEY, 'needs', f] as const,
  need: (id: string) => [KEY, 'need', id] as const,
  suggested: (id: string) => [KEY, 'suggested', id] as const,
  courses: (f: Record<string, unknown>) => [KEY, 'courses', f] as const,
  sessions: (f: Record<string, unknown>) => [KEY, 'sessions', f] as const,
  session: (id: string) => [KEY, 'session', id] as const,
  enrollments: (f: Record<string, unknown>) => [KEY, 'enrollments', f] as const,
  idps: (f: Record<string, unknown>) => [KEY, 'idps', f] as const,
  idp: (id: string) => [KEY, 'idp', id] as const,
  report: (f: Record<string, unknown>) => [KEY, 'report', f] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

export const useMyDevelopment = () => useQuery({ queryKey: trainingKeys.me, queryFn: () => api.get<MyDevelopmentDto>('/training/me').then((r) => r.data) });
export const useTeamDevelopment = () => useQuery({ queryKey: trainingKeys.team, queryFn: () => api.get<TeamDevelopmentDto>('/training/team').then((r) => r.data) });

export const useTrainingNeeds = (f: Record<string, unknown>) =>
  useQuery({ queryKey: trainingKeys.needs(f), queryFn: () => api.get<TrainingNeedDto[]>(`/training/needs?${qs(f)}`), placeholderData: (p) => p });
export const useTrainingNeed = (id: string | null) =>
  useQuery({ queryKey: trainingKeys.need(id ?? ''), queryFn: () => api.get<TrainingNeedDto>(`/training/needs/${id}`).then((r) => r.data), enabled: !!id });
export const useSuggestedCourses = (needId: string | null) =>
  useQuery({ queryKey: trainingKeys.suggested(needId ?? ''), queryFn: () => api.get<CourseDto[]>(`/training/needs/${needId}/suggested-courses`).then((r) => r.data), enabled: !!needId });

export const useCourses = (f: Record<string, unknown>) =>
  useQuery({ queryKey: trainingKeys.courses(f), queryFn: () => api.get<CourseDto[]>(`/training/courses?${qs(f)}`), placeholderData: (p) => p });
export const useSessions = (f: Record<string, unknown>) =>
  useQuery({ queryKey: trainingKeys.sessions(f), queryFn: () => api.get<SessionDto[]>(`/training/sessions?${qs(f)}`), placeholderData: (p) => p });
export const useSession = (id: string | null) =>
  useQuery({ queryKey: trainingKeys.session(id ?? ''), queryFn: () => api.get<SessionDto>(`/training/sessions/${id}`).then((r) => r.data), enabled: !!id });
export const useEnrollments = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: trainingKeys.enrollments(f), queryFn: () => api.get<EnrollmentDto[]>(`/training/enrollments?${qs(f)}`), enabled, placeholderData: (p) => p });

export const useIdps = (f: Record<string, unknown>) =>
  useQuery({ queryKey: trainingKeys.idps(f), queryFn: () => api.get<IdpSummaryDto[]>(`/training/idps?${qs(f)}`), placeholderData: (p) => p });
export const useIdp = (id: string | null) =>
  useQuery({ queryKey: trainingKeys.idp(id ?? ''), queryFn: () => api.get<IdpDetailDto>(`/training/idps/${id}`).then((r) => r.data), enabled: !!id });

export const useTrainingReport = (f: Record<string, unknown>) =>
  useQuery({ queryKey: trainingKeys.report(f), queryFn: () => api.get<TrainingReportDto>(`/training/reports/overview?${qs(f)}`).then((r) => r.data) });

export function useTrainingMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return {
    generateTna: useMutation({ mutationFn: (input: GenerateTnaInput) => api.post<GenerateTnaResultDto>('/training/needs/generate', input).then((r) => r.data), onSuccess: invalidate }),
    createNeed: useMutation({ mutationFn: (input: CreateTrainingNeedInput) => api.post<TrainingNeedDto>('/training/needs', input).then((r) => r.data), onSuccess: invalidate }),
    updateNeed: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateTrainingNeedInput }) => api.patch<TrainingNeedDto>(`/training/needs/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createCourse: useMutation({ mutationFn: (input: CreateCourseInput) => api.post<CourseDto>('/training/courses', input).then((r) => r.data), onSuccess: invalidate }),
    updateCourse: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateCourseInput }) => api.patch<CourseDto>(`/training/courses/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    createSession: useMutation({ mutationFn: (input: CreateSessionInput) => api.post<SessionDto>('/training/sessions', input).then((r) => r.data), onSuccess: invalidate }),
    updateSession: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateSessionInput }) => api.patch<SessionDto>(`/training/sessions/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    sessionAction: useMutation({
      mutationFn: ({ id, action }: { id: string; action: 'open' | 'start' | 'complete' | 'cancel' }) => api.post<SessionDto>(`/training/sessions/${id}/${action}`).then((r) => r.data),
      onSuccess: invalidate,
    }),
    enroll: useMutation({ mutationFn: ({ sessionId, input }: { sessionId: string; input: EnrollInput }) => api.post<EnrollResultDto>(`/training/sessions/${sessionId}/enroll`, input).then((r) => r.data), onSuccess: invalidate }),
    recordAttendance: useMutation({ mutationFn: ({ id, input }: { id: string; input: RecordAttendanceInput }) => api.post<EnrollmentDto>(`/training/enrollments/${id}/attendance`, input).then((r) => r.data), onSuccess: invalidate }),
    recordResult: useMutation({ mutationFn: ({ id, input }: { id: string; input: RecordResultInput }) => api.post<EnrollmentDto>(`/training/enrollments/${id}/result`, input).then((r) => r.data), onSuccess: invalidate }),
    cancelEnrollment: useMutation({ mutationFn: (id: string) => api.post<EnrollmentDto>(`/training/enrollments/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    createIdp: useMutation({ mutationFn: (input: CreateIdpInput) => api.post<IdpDetailDto>('/training/idps', input).then((r) => r.data), onSuccess: invalidate }),
    idpAction: useMutation({ mutationFn: ({ id, action }: { id: string; action: 'activate' | 'complete' }) => api.post<IdpDetailDto>(`/training/idps/${id}/${action}`).then((r) => r.data), onSuccess: invalidate }),
    addIdpItem: useMutation({ mutationFn: ({ idpId, input }: { idpId: string; input: AddIdpItemInput }) => api.post<IdpDetailDto>(`/training/idps/${idpId}/items`, input).then((r) => r.data), onSuccess: invalidate }),
    updateIdpItem: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateIdpItemInput }) => api.patch<IdpDetailDto>(`/training/idp-items/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    updateProgress: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateIdpProgressInput }) => api.patch<IdpDetailDto>(`/training/idp-items/${id}/progress`, input).then((r) => r.data), onSuccess: invalidate }),
  };
}
