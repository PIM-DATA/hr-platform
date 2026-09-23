import { z } from 'zod';

/**
 * THE password policy. Every path where a person sets a password — creating a user, changing your own, using a reset
 * link, bootstrapping the first administrator — validates with `passwordField` and nothing else. A second definition
 * is how a system ends up refusing 11 characters at the front door and accepting them at the back one.
 *
 * 12 characters is the production baseline from Task 15 (the bootstrap command), applied everywhere rather than only
 * to that command. Deliberately length-only: composition rules (a symbol, an uppercase letter, 90-day rotation) push
 * people towards predictable passwords and are not asked for by any requirement here. Breached-password checking is a
 * documented gap.
 *
 * The only exception is the development seed (`SEED_ADMIN_PASSWORD` / `SEED_DEMO_PASSWORD`), which never runs in
 * production — see `apps/api/src/config/env.ts`, where that exception is stated explicitly.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const changeOwnPasswordSchema = z
  .object({ currentPassword: z.string().min(1, 'Current password is required').max(PASSWORD_MAX_LENGTH), newPassword: passwordField })
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
