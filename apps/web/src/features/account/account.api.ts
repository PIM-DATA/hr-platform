import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangeOwnPasswordInput, ConsumePasswordResetInput, PasswordResetIssuedDto, SessionSummaryDto } from '@hr/shared';
import { api } from '@/lib/api-client';

export const accountKeys = { sessions: ['account', 'sessions'] as const };

export const useMySessions = () =>
  useQuery({ queryKey: accountKeys.sessions, queryFn: () => api.get<SessionSummaryDto[]>('/account/sessions').then((r) => r.data) });

export function useAccountMutations() {
  const qc = useQueryClient();
  return {
    changePassword: useMutation({ mutationFn: (input: ChangeOwnPasswordInput) => api.post<void>('/account/change-password', input) }),
    revokeOtherSessions: useMutation({
      mutationFn: () => api.post<{ revoked: number }>('/account/sessions/revoke-others').then((r) => r.data),
      onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.sessions }),
    }),
  };
}

/**
 * Consuming a reset link. The caller is by definition signed out, so a 401 here must not trigger the global
 * "session expired" handling — the page shows the error itself.
 */
export const consumePasswordReset = (input: ConsumePasswordResetInput) =>
  api.post<void>('/account/reset-password', input, { skipUnauthorizedHandler: true });

/** Administrator recovery actions (permission: account.manage_recovery). */
export function useRecoveryMutations() {
  const qc = useQueryClient();
  return {
    issueResetLink: useMutation({ mutationFn: (userId: string) => api.post<PasswordResetIssuedDto>(`/admin/users/${userId}/password-reset`).then((r) => r.data) }),
    revokeUserSessions: useMutation({
      mutationFn: (userId: string) => api.post<{ revoked: number }>(`/admin/users/${userId}/revoke-sessions`).then((r) => r.data),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    }),
  };
}
