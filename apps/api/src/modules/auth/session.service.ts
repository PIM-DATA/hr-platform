import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { buildAuthContext } from '../../services/authorization/authorization.service';
import { logger } from '../../lib/logger';
import type { AuthContext } from './auth.types';

/**
 * DB-backed sessions.
 *  - Browser holds an opaque 256-bit random token (cookie, httpOnly).
 *  - DB stores only SHA-256(token); a DB leak cannot be replayed as a cookie.
 *  - Each session carries its own random CSRF token (synchronizer pattern).
 */
export const SESSION_TTL_MS = env.SESSION_TTL_HOURS * 60 * 60 * 1000;

export function generateToken(): string {
  return randomBytes(32).toString('base64url'); // 256-bit entropy
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export const sessionService = {
  /** Creates a fresh session and returns the raw token (only ever sent to the browser). */
  async create(userId: string, meta: { ipAddress?: string | null; userAgent?: string | null }) {
    const rawToken = generateToken();
    await prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(rawToken),
        csrfToken: generateToken(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
    return rawToken;
  },

  /**
   * Resolves a raw cookie token to an AuthContext.
   * Returns null when the session is unknown, expired, or the user is inactive
   * (so deactivating a user immediately kills all of their sessions).
   */
  async resolve(rawToken: string): Promise<AuthContext | null> {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: {
        user: {
          include: { userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } },
        },
      },
    });
    if (!session) {
      logger.debug('session rejected: not found');
      return null;
    }
    if (session.expiresAt <= new Date()) {
      logger.debug({ sessionId: session.id, expiresAt: session.expiresAt }, 'session rejected: expired');
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    if (!session.user.isActive) {
      logger.debug({ sessionId: session.id, userId: session.userId }, 'session rejected: user inactive');
      return null;
    }

    return buildAuthContext({
      user: session.user,
      roles: session.user.userRoles.map((ur) => ur.role),
      sessionId: session.id,
      csrfToken: session.csrfToken,
    });
  },

  async revokeByRawToken(rawToken: string) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(rawToken) } });
  },

  /** Used when a user is deactivated or changes password (Task 3+). */
  async revokeAllForUser(userId: string) {
    await prisma.session.deleteMany({ where: { userId } });
  },

  /** Housekeeping; safe to call from a cron / on startup. */
  async deleteExpired() {
    return prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  },
};
