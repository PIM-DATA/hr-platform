import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateWorkflowDefinitionInput, WorkflowDefinitionDto } from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'workflow';

export const useWorkflowDefinitions = () =>
  useQuery({ queryKey: [KEY, 'definitions'], queryFn: () => api.get<WorkflowDefinitionDto[]>('/workflow/definitions').then((r) => r.data) });

export function useWorkflowDefinitionMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });
  return {
    createVersion: useMutation({ mutationFn: (input: CreateWorkflowDefinitionInput) => api.post<WorkflowDefinitionDto>('/workflow/definitions', input).then((r) => r.data), onSuccess: invalidate }),
    activate: useMutation({ mutationFn: (id: string) => api.post<WorkflowDefinitionDto>(`/workflow/definitions/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    deactivate: useMutation({ mutationFn: (id: string) => api.post<WorkflowDefinitionDto>(`/workflow/definitions/${id}/deactivate`).then((r) => r.data), onSuccess: invalidate }),
  };
}
