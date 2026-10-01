import { AUDIT_ACTIONS, type AuthUser, type LoginInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/password';
import { auditService } from '../../services/audit/audit.service';
import { sessionService } from './session.service';
import type { AuthContext } from './auth.types';

type Meta = { ipAddress: string | null; userAgent: string | null };

// Compared against when the email is unknown so both branches cost one bcrypt verify (no timing oracle).
const dummyHashPromise = hashPassword('dummy-password-for-constant-time-compare');

const meInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  userRoles: { include: { role: { select: { code: true, name: true } } } },
} as const;

export const authService = {
  /**
   * Verifies credentials and opens a new session.
   * Unknown email and wrong password return the identical INVALID_CREDENTIALS error.
   */
  async login(input: LoginInput, meta: Meta): Promise<{ rawToken: string; userId: string }> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHashPromise));

    if (!user || !ok) {
      await auditService.log({
        userId: user?.id ?? null,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        module: 'auth',
        recordType: 'User',
        recordId: user?.id ?? null,
        newValue: { email: input.email, reason: 'INVALID_CREDENTIALS' },
        ...meta,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (!user.isActive) {
      await auditService.log({
        userId: user.id,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        module: 'auth',
        recordType: 'User',
        recordId: user.id,
        newValue: { email: input.email, reason: 'ACCOUNT_INACTIVE' },
        ...meta,
      });
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated');
    }

    const rawToken = await sessionService.create(user.id, meta);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await auditService.log({
      userId: user.id,
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      module: 'auth',
      recordType: 'User',
      recordId: user.id,
      ...meta,
    });
    return { rawToken, userId: user.id };
  },

  async logout(rawToken: string, auth: AuthContext | undefined, meta: Meta) {
    await sessionService.revokeByRawToken(rawToken);
    if (auth) {
      await auditService.log({
        userId: auth.userId,
        action: AUDIT_ACTIONS.LOGOUT,
        module: 'auth',
        recordType: 'User',
        recordId: auth.userId,
        ...meta,
      });
    }
  },

  /** Builds the public "current user" payload. Never includes passwordHash / tokens. */
  async getMe(auth: AuthContext): Promise<AuthUser> {
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, include: meInclude });
    if (!user) throw AppError.unauthorized();
    return {
      id: user.id,
      email: user.email,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      employee: user.employee,
      roles: user.userRoles.map((ur) => ur.role),
      permissions: auth.permissions,
      permissionScopes: auth.permissionScopes,
      csrfToken: auth.csrfToken,
    };
  },
};
