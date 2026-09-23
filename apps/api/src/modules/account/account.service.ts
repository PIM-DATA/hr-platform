import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type ChangeOwnPasswordInput, type PasswordResetIssuedDto, type SessionSummaryDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { env } from '../../config/env';
import { auditService } from '../../services/audit/audit.service';
import { hashPassword, verifyPassword } from '../../lib/password';
import { hashToken } from '../auth/session.service';
import type { AuthContext } from '../auth/auth.types';
import type { Actor } from '../leave/leave-types.service';

/**
 * Account recovery and session administration.
 *
 * There is no email or SMS provider in this system, so "forgot password" cannot be self-service without pretending to
 * send something. Instead there are two honest paths: a signed-in user changes their own password, or an authorised
 * administrator issues a **one-time link** and hands it over through whatever secure channel the organization already
 * uses. No administrator can set or read anyone's password.
 *
 * Token handling mirrors sessions: 256 bits of randomness, only the SHA-256 hash stored, the raw value shown once.
 * Any password change — by the user or through a reset — revokes every session and every outstanding reset token, so
 * a compromised credential cannot survive the change.
 */
type Tx = Prisma.TransactionClient;

/** 256-bit token, URL-safe so it can be pasted into a link without escaping. */
const generateResetToken = () => randomBytes(32).toString('base64url');
const resetTtlMs = () => env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

/** Deliberately one message for missing, expired, already used and deactivated: the caller learns nothing either way. */
const invalidToken = () => new AppError(400, 'PASSWORD_RESET_TOKEN_INVALID', 'This password reset link is no longer valid. Ask an administrator for a new one.');

/** Everything that must stop working when a password changes, on the caller's transaction. */
async function revokeCredentialsWithTx(tx: Tx, userId: string, options: { keepSessionId?: string } = {}) {
  const sessions = await tx.session.deleteMany({ where: { userId, ...(options.keepSessionId ? { id: { not: options.keepSessionId } } : {}) } });
  const tokens = await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  // `resetLinksRevoked`, not `tokensRevoked`: the audit redactor blanks any key containing "token", and this is a
  // harmless count that is worth keeping readable in the trail.
  return { sessionsRevoked: sessions.count, resetLinksRevoked: tokens.count };
}

export const accountService = {
  /**
   * A signed-in user changes their own password. The current password must be proven, and afterwards **every** session
   * is revoked — including this one — so the browser must sign in again. That is simpler to reason about than keeping
   * one session alive across a credential change.
   */
  async changeOwnPassword(auth: AuthContext, input: ChangeOwnPasswordInput, actor: Actor): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { id: true, passwordHash: true, isActive: true } });
    if (!user || !user.isActive) throw AppError.unauthorized();
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError(400, 'CURRENT_PASSWORD_INCORRECT', 'The current password is not correct');
    }
    const passwordHash = await hashPassword(input.newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      const revoked = await revokeCredentialsWithTx(tx, user.id);
      await auditService.log(
        { userId: auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action: AUDIT_ACTIONS.CHANGE_OWN_PASSWORD, module: 'account', recordType: 'User', recordId: user.id, newValue: revoked },
        tx,
      );
    });
  },

  /**
   * Issues a one-time reset link for another user. Any previously issued, unused token is revoked in the same
   * transaction, so at most one link is ever live. The raw token is returned exactly once and never logged.
   */
  async issuePasswordReset(targetUserId: string, actor: Actor): Promise<PasswordResetIssuedDto> {
    if (targetUserId === actor.auth.userId) {
      throw new AppError(400, 'USE_CHANGE_PASSWORD', 'Change your own password from your account settings instead of issuing a reset link to yourself');
    }
    const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, email: true, isActive: true } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (!user.isActive) throw new AppError(409, 'USER_INACTIVE', 'Reactivate the account before issuing a password reset link');

    const rawToken = generateResetToken();
    const expiresAt = new Date(Date.now() + resetTtlMs());
    await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt, createdByUserId: actor.auth.userId } });
      // The audit records that a link was issued and when it expires — never the token itself.
      await auditService.log(
        { userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action: AUDIT_ACTIONS.ISSUE_PASSWORD_RESET, module: 'account', recordType: 'User', recordId: user.id, newValue: { expiresAt: expiresAt.toISOString(), ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES } },
        tx,
      );
    });
    return {
      // Built from configured application URL, never from the request Host header (host-header injection).
      resetUrl: `${env.publicAppUrl}/reset-password?token=${encodeURIComponent(rawToken)}`,
      token: rawToken,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, email: user.email },
    };
  },

  /**
   * Consumes a reset token: one transaction, row-locked, so two concurrent attempts with the same token can never both
   * set a password. Everything about the account's old credentials is revoked at the same time.
   */
  async consumePasswordReset(rawToken: string, newPassword: string, actor: Omit<Actor, 'auth'> & { auth?: AuthContext }): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const passwordHash = await hashPassword(newPassword); // hashed before the transaction: bcrypt is deliberately slow
    await prisma.$transaction(async (tx) => {
      // Lock the row first: the state decision below must not be made on a stale read.
      await tx.$executeRaw`SELECT "id" FROM "password_reset_tokens" WHERE "token_hash" = ${tokenHash} FOR UPDATE`;
      const token = await tx.passwordResetToken.findUnique({ where: { tokenHash }, include: { user: { select: { id: true, isActive: true } } } });
      if (!token || token.usedAt || token.revokedAt || token.expiresAt <= new Date() || !token.user.isActive) throw invalidToken();

      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      await tx.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      const revoked = await revokeCredentialsWithTx(tx, token.userId);
      await auditService.log(
        { userId: token.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action: AUDIT_ACTIONS.RESET_USER_PASSWORD, module: 'account', recordType: 'User', recordId: token.userId, newValue: { ...revoked, viaResetLink: true } },
        tx,
      );
    });
  },

  /** The caller's own sessions. Token hashes are never part of the shape. */
  async listOwnSessions(auth: AuthContext): Promise<SessionSummaryDto[]> {
    const rows = await prisma.session.findMany({
      where: { userId: auth.userId },
      select: { id: true, createdAt: true, expiresAt: true, ipAddress: true, userAgent: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id, current: s.id === auth.sessionId, createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString(),
      ipAddress: s.ipAddress, userAgent: s.userAgent,
    }));
  },

  /** Signs the caller out everywhere except the browser they are using now. */
  async revokeOtherSessions(auth: AuthContext, actor: Actor): Promise<{ revoked: number }> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.session.deleteMany({ where: { userId: auth.userId, id: { not: auth.sessionId } } });
      await auditService.log(
        { userId: auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action: AUDIT_ACTIONS.REVOKE_OTHER_SESSIONS, module: 'account', recordType: 'User', recordId: auth.userId, newValue: { sessionsRevoked: count } },
        tx,
      );
      return { revoked: count };
    });
  },

  /** Administrative "sign this person out everywhere" — for a lost laptop or a suspected compromise. */
  async revokeUserSessions(targetUserId: string, actor: Actor): Promise<{ revoked: number }> {
    const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.session.deleteMany({ where: { userId: targetUserId } });
      await auditService.log(
        { userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action: AUDIT_ACTIONS.ADMIN_REVOKE_USER_SESSIONS, module: 'account', recordType: 'User', recordId: targetUserId, newValue: { sessionsRevoked: count } },
        tx,
      );
      return { revoked: count };
    });
  },

  /**
   * Operational cleanup of spent reset tokens (see `npm run ops:cleanup-reset-tokens`). Expired, used and revoked
   * rows are security artifacts with no value once they are older than the retention the operator chooses.
   */
  async cleanupResetTokens(olderThanDays: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const { count } = await prisma.passwordResetToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return { deleted: count };
  },
};

export { revokeCredentialsWithTx };
