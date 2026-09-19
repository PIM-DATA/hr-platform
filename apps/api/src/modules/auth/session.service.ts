import { createHash, randomBytes } from 'node:crypto';
import { DATA_SCOPES, type DataScope } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
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

const SCOPE_RANK: Record<DataScope, number> = { SELF: 0, TEAM: 1, ALL: 2 };
function widestScope(scopes: string[]): DataScope {
  return scopes.reduce<DataScope>((best, s) => {
    const scope = (s in SCOPE_RANK ? s : DATA_SCOPES.SELF) as DataScope;
    return SCOPE_RANK[scope] > SCOPE_RANK[best] ? scope : best;
  }, DATA_SCOPES.SELF);
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
    if (!session) return null;
    if (session.expiresAt <= new Date()) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    if (!session.user.isActive) return null;

    const roles = session.user.userRoles.map((ur) => ur.role);
    const permissions = new Set<string>();
    for (const role of roles) for (const rp of role.rolePermissions) permissions.add(rp.permission.code);

    return {
      userId: session.user.id,
      email: session.user.email,
      employeeId: session.user.employeeId,
      roles: roles.map((r) => r.code),
      permissions: [...permissions],
      dataScope: widestScope(roles.map((r) => r.dataScope)),
      sessionId: session.id,
      csrfToken: session.csrfToken,
    };
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
