import type { Prisma } from '@prisma/client';
import { PERMISSIONS, isPrivilegedAccount, selfEscalation, type DataScope } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { computeEffectivePermissions, resolveDataScope, type RoleWithPermissions } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';

/**
 * Task 45 — one place for the two account-security boundaries.
 *
 * 1. Privileged accounts. An account is privileged when its effective permissions include RBAC or privileged-account
 *    administration (`PRIVILEGED_ACCOUNT_PERMISSIONS`). Resetting, signing out, editing, (de)activating or re-roling such an
 *    account requires `users.manage_privileged` — otherwise an ordinary account administrator could take over (reset
 *    link, e-mail change), lock out (deactivate, sign-out) or re-shape (roles) an identity above their own authority.
 * 2. Self-escalation. `roles.manage` administers other people's access. No change the actor makes to their own access —
 *    roles assigned to themselves, permissions added to a role they hold — may add a permission or widen their scope.
 *
 * Refusals are 403 with a stable code, write nothing, and leave a structured warning in the log (the existing policy
 * audits successful changes only; denied requests are visible in the request log).
 */
type Db = Prisma.TransactionClient | typeof prisma;
type Actor = { auth: AuthContext };
export type AccountAction = 'PASSWORD_RESET' | 'REVOKE_SESSIONS' | 'UPDATE' | 'SET_ROLES' | 'ACTIVATE' | 'DEACTIVATE';

const log = logger.child({ module: 'account-guard' });
const rolesInclude = { userRoles: { include: { role: { include: { rolePermissions: { include: { permission: { select: { code: true } } } } } } } } } satisfies Prisma.UserInclude;

/** Effective permissions and scope of a stored account, from its roles as they are in the database now. */
export async function effectiveAccess(db: Db, userId: string): Promise<{ permissions: string[]; dataScope: DataScope } | null> {
  const user = await db.user.findUnique({ where: { id: userId }, include: rolesInclude });
  if (!user) return null;
  const roles: RoleWithPermissions[] = user.userRoles.map((ur) => ur.role);
  return { permissions: computeEffectivePermissions(roles), dataScope: resolveDataScope(roles) };
}

export const privilegedAccountRefused = () =>
  new AppError(403, 'PRIVILEGED_ACCOUNT_PROTECTED', 'This is a privileged administrator account. Only a privileged-account administrator can change it.');

/**
 * Refuses an account-security action on a privileged target unless the actor holds `users.manage_privileged`.
 * Actions on your own account are governed elsewhere (change your own password, no self-deactivation, no removal of
 * your own System Admin role, and `assertNoSelfEscalation`), so the actor's own account is not a "target" here.
 */
export async function assertCanAdministerAccount(db: Db, actor: Actor, targetUserId: string, action: AccountAction): Promise<void> {
  if (targetUserId === actor.auth.userId) return;
  if (actor.auth.permissions.includes(PERMISSIONS.USERS_MANAGE_PRIVILEGED)) return;
  const target = await effectiveAccess(db, targetUserId);
  if (!target) return; // the caller reports USER_NOT_FOUND
  if (!isPrivilegedAccount(target.permissions)) return;
  log.warn({ event: 'privileged_account_action_refused', action, actorUserId: actor.auth.userId, targetUserId }, 'privileged account action refused');
  throw privilegedAccountRefused();
}

export const selfEscalationRefused = (gained: string[], scopeWidened: boolean) =>
  new AppError(403, 'SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED', `You cannot widen your own access${scopeWidened ? ' (data scope)' : ''}${gained.length ? `: ${gained.slice(0, 5).join(', ')}${gained.length > 5 ? ', …' : ''}` : ''}. Another administrator must make this change.`);

/** Refuses a change to the actor's own access that would add permissions or widen scope. */
export function assertNoSelfEscalation(actor: Actor, after: { permissions: readonly string[]; dataScope: string }, context: string): void {
  const { gained, scopeWidened } = selfEscalation({ permissions: actor.auth.permissions, dataScope: actor.auth.dataScope }, after);
  if (gained.length === 0 && !scopeWidened) return;
  log.warn({ event: 'self_escalation_refused', context, actorUserId: actor.auth.userId, gainedCount: gained.length, scopeWidened }, 'self escalation refused');
  throw selfEscalationRefused(gained, scopeWidened);
}
