import { z } from 'zod';

/**
 * One password policy for every path that sets a password (own change, admin-issued reset, bootstrap).
 * Deliberately length-only: composition rules (a symbol, an uppercase letter, 90-day rotation) push people towards
 * predictable passwords and are not asked for by any requirement here. Breached-password checking is a documented gap.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(128, 'Password must be at most 128 characters');

export const changeOwnPasswordSchema = z
  .object({ currentPassword: z.string().min(1, 'Current password is required').max(128), newPassword: passwordField })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'The new password must be different from the current one', path: ['newPassword'] });
export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>;

/** The raw token travels in the body, never in a query string (query strings end up in logs and browser history). */
export const consumePasswordResetSchema = z.object({ token: z.string().min(32).max(200), newPassword: passwordField });
export type ConsumePasswordResetInput = z.infer<typeof consumePasswordResetSchema>;

export interface PasswordResetIssuedDto {
  /** Shown exactly once — never stored by the server in readable form and never returned again. */
  resetUrl: string;
  token: string;
  expiresAt: string;
  user: { id: string; email: string };
}

export interface SessionSummaryDto {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}
