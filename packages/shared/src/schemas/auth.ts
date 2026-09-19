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
  /** Widest data scope across the user's roles: SELF | TEAM | ALL */
  dataScope: string;
  /** Synchronizer CSRF token bound to the current session; send as `x-csrf-token` on mutations. */
  csrfToken: string;
}
