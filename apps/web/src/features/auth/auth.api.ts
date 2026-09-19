import type { AuthUser, LoginInput } from '@hr/shared';
import { api } from '@/lib/api-client';

export const authApi = {
  /** Bootstrap call — a 401 here simply means "not logged in". */
  me: () => api.get<AuthUser>('/auth/me', { skipUnauthorizedHandler: true }).then((r) => r.data),
  login: (input: LoginInput) => api.post<AuthUser>('/auth/login', input, { skipUnauthorizedHandler: true }).then((r) => r.data),
  logout: () => api.post<void>('/auth/logout'),
};
