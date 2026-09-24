import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcknowledgementDto, ActionTypeDto, ApprovalProjectionDto, CaseCategoryDto, CaseDetailDto, CaseSummaryDto,
  CreateActionInput, CreateActionTypeInput, CreateCaseInput, DeclineAcknowledgementInput, DisciplinaryActionDto,
  DisciplinaryPolicyDto, EmployeeRelationsReportDto, LetterTemplateDto, MyDisciplinaryRecordDto, UpdateActionInput,
  UpdateActionTypeInput, UpdateCaseInput, UpsertLetterTemplateInput, UpsertPolicyInput, WorkflowInboxItemDto,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'employee-relations';
export const erKeys = {
  myRecords: [KEY, 'my-records'] as const,
  myRecord: (id: string) => [KEY, 'my-record', id] as const,
  actionTypes: [KEY, 'action-types'] as const,
  categories: [KEY, 'categories'] as const,
  policies: [KEY, 'policies'] as const,
  templates: [KEY, 'templates'] as const,
  cases: (f: Record<string, unknown>) => [KEY, 'cases', f] as const,
  case: (id: string) => [KEY, 'case', id] as const,
  actions: (f: Record<string, unknown>) => [KEY, 'actions', f] as const,
  approval: (id: string) => [KEY, 'approval', id] as const,
  inbox: [KEY, 'inbox'] as const,
  report: (f: Record<string, unknown>) => [KEY, 'report', f] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

export const useMyRecords = () => useQuery({ queryKey: erKeys.myRecords, queryFn: () => api.get<MyDisciplinaryRecordDto[]>('/employee-relations/my/records').then((r) => r.data) });
export const useMyRecord = (id: string | null) =>
  useQuery({ queryKey: erKeys.myRecord(id ?? ''), queryFn: () => api.get<MyDisciplinaryRecordDto>(`/employee-relations/my/records/${id}`).then((r) => r.data), enabled: !!id });

export const useActionTypes = (includeInactive = false) =>
  useQuery({ queryKey: [...erKeys.actionTypes, includeInactive], queryFn: () => api.get<ActionTypeDto[]>(`/employee-relations/action-types?includeInactive=${includeInactive}`).then((r) => r.data) });
export const useCaseCategories = () => useQuery({ queryKey: erKeys.categories, queryFn: () => api.get<CaseCategoryDto[]>('/employee-relations/categories').then((r) => r.data) });
export const useDisciplinaryPolicies = () => useQuery({ queryKey: erKeys.policies, queryFn: () => api.get<DisciplinaryPolicyDto[]>('/employee-relations/policies').then((r) => r.data) });
export const useLetterTemplates = () => useQuery({ queryKey: erKeys.templates, queryFn: () => api.get<LetterTemplateDto[]>('/employee-relations/letter-templates').then((r) => r.data) });

export const useCases = (f: Record<string, unknown>) =>
  useQuery({ queryKey: erKeys.cases(f), queryFn: () => api.get<CaseSummaryDto[]>(`/employee-relations/cases?${qs(f)}`), placeholderData: (p) => p });
export const useCase = (id: string | null) =>
  useQuery({ queryKey: erKeys.case(id ?? ''), queryFn: () => api.get<CaseDetailDto>(`/employee-relations/cases/${id}`).then((r) => r.data), enabled: !!id });
export const useActions = (f: Record<string, unknown>) =>
  useQuery({ queryKey: erKeys.actions(f), queryFn: () => api.get<DisciplinaryActionDto[]>(`/employee-relations/actions?${qs(f)}`), placeholderData: (p) => p });
export const useApprovalProjection = (actionId: string | null) =>
  useQuery({ queryKey: erKeys.approval(actionId ?? ''), queryFn: () => api.get<ApprovalProjectionDto>(`/employee-relations/actions/${actionId}/approval`).then((r) => r.data), enabled: !!actionId });
/** The caller's pending employee-relations approvals, from the shared workflow inbox. */
export const useErInbox = (enabled: boolean) =>
  useQuery({ queryKey: erKeys.inbox, queryFn: () => api.get<WorkflowInboxItemDto[]>('/workflow/inbox?module=employee_relations&pageSize=50').then((r) => r.data), enabled });
export const useErReport = (f: Record<string, unknown>) =>
  useQuery({ queryKey: erKeys.report(f), queryFn: () => api.get<EmployeeRelationsReportDto>(`/employee-relations/reports/overview?${qs(f)}`).then((r) => r.data) });

export function useErMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['workflow'] });
  };
  return {
    acknowledge: useMutation({ mutationFn: (id: string) => api.post<AcknowledgementDto>(`/employee-relations/my/records/${id}/acknowledge`).then((r) => r.data), onSuccess: invalidate }),
    createActionType: useMutation({ mutationFn: (input: CreateActionTypeInput) => api.post<ActionTypeDto>('/employee-relations/action-types', input).then((r) => r.data), onSuccess: invalidate }),
    updateActionType: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateActionTypeInput }) => api.patch<ActionTypeDto>(`/employee-relations/action-types/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    upsertPolicy: useMutation({ mutationFn: (input: UpsertPolicyInput) => api.put<DisciplinaryPolicyDto>('/employee-relations/policies', input).then((r) => r.data), onSuccess: invalidate }),
    upsertTemplate: useMutation({ mutationFn: (input: UpsertLetterTemplateInput) => api.put<LetterTemplateDto>('/employee-relations/letter-templates', input).then((r) => r.data), onSuccess: invalidate }),
    createCase: useMutation({ mutationFn: (input: CreateCaseInput) => api.post<CaseDetailDto>('/employee-relations/cases', input).then((r) => r.data), onSuccess: invalidate }),
    updateCase: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateCaseInput }) => api.patch<CaseDetailDto>(`/employee-relations/cases/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    caseAction: useMutation({ mutationFn: ({ id, action }: { id: string; action: 'close' | 'cancel' }) => api.post<CaseDetailDto>(`/employee-relations/cases/${id}/${action}`).then((r) => r.data), onSuccess: invalidate }),
    createAction: useMutation({ mutationFn: ({ caseId, input }: { caseId: string; input: CreateActionInput }) => api.post<CaseDetailDto>(`/employee-relations/cases/${caseId}/actions`, input).then((r) => r.data), onSuccess: invalidate }),
    updateAction: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateActionInput }) => api.patch<CaseDetailDto>(`/employee-relations/actions/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    actionOp: useMutation({ mutationFn: ({ id, op }: { id: string; op: 'submit' | 'cancel' }) => api.post<CaseDetailDto>(`/employee-relations/actions/${id}/${op}`).then((r) => r.data), onSuccess: invalidate }),
    recordDeclined: useMutation({ mutationFn: ({ id, input }: { id: string; input: DeclineAcknowledgementInput }) => api.post<CaseDetailDto>(`/employee-relations/actions/${id}/declined`, input).then((r) => r.data), onSuccess: invalidate }),
    /** Approve and reject go through the shared workflow endpoint — employee relations has no approval mutation of its own. */
    decide: useMutation({
      mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) => api.post(`/workflow/instances/${instanceId}/actions`, { action, comment }),
      onSuccess: invalidate,
    }),
  };
}
