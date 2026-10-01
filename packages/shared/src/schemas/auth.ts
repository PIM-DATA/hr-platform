import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Shape returned by GET /auth/me and POST /auth/login. Never contains hashes or tokens. */
export interface AuthUser {
  id: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
  } | null;
  roles: { code: string; name: string }[];
  permissions: string[];
  /**
   * Task 50 (T44-P1-21): permission → data scope (widest among the roles that grant THAT permission). There is no
   * user-wide scope: a UI decision about a module reads the scope of that module's permission (`scopeOf`).
   */
  permissionScopes: Record<string, 'SELF' | 'TEAM' | 'ALL'>;
  /** Synchronizer CSRF token bound to the current session; send as `x-csrf-token` on mutations. */
  csrfToken: string;
}
