import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser, LoginInput, PermissionCode } from '@hr/shared';
import { ApiClientError, setCsrfToken, setUnauthorizedHandler } from '@/lib/api-client';
import { authApi } from '@/features/auth/auth.api';

type Status = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: Status;
  user: AuthUser | null;
  login: (input: LoginInput) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasPermission: (permission: PermissionCode) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Holds the current user in memory only. The session itself is an httpOnly cookie
 * the browser manages; nothing auth-related is written to localStorage/sessionStorage.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const queryClient = useQueryClient();

  const applyUser = useCallback((next: AuthUser | null) => {
    setUser(next);
    setCsrfToken(next?.csrfToken ?? null);
    setStatus(next ? 'authenticated' : 'unauthenticated');
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyUser(await authApi.me());
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) applyUser(null);
      else {
        // API unreachable: treat as logged out but keep the error visible in the console.
        console.error('auth bootstrap failed', err);
        applyUser(null);
      }
    }
  }, [applyUser]);

  // bootstrap: open app → GET /auth/me → authenticated / unauthenticated
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // any later 401 (session expired / user deactivated) drops the auth state → RequireAuth redirects
  useEffect(() => {
    setUnauthorizedHandler(() => {
      applyUser(null);
      queryClient.clear();
    });
    return () => setUnauthorizedHandler(null);
  }, [applyUser, queryClient]);

  const login = useCallback(
    async (input: LoginInput) => {
      const next = await authApi.login(input);
      queryClient.clear();
      applyUser(next);
      return next;
    },
    [applyUser, queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      queryClient.clear();
      applyUser(null);
    }
  }, [applyUser, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      login,
      logout,
      refresh,
      hasPermission: (permission) => user?.permissions.includes(permission) ?? false,
    }),
    [status, user, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** Display name: employee full name when linked, otherwise the email. */
export function displayName(user: AuthUser | null): string {
  if (!user) return '';
  return user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email;
}
