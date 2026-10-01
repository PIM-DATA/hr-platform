import type { Prisma } from '@prisma/client';
import {
  blockingGrantPermissions, isPrivilegedAccount,
  AUDIT_ACTIONS, ROLES,
  type CreateUserInput, type EmployeeOption, type UpdateUserInput, type UpdateUserRolesInput,
  type UserDto, type UserListQuery,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { auditService, diffFields } from '../../services/audit/audit.service';
import { isScopeWithin } from '../../services/authorization/authorization.service';
import { accessOf, assertCanAdministerAccount, assertNoSelfEscalation } from './account-guard';
import type { AuthContext } from '../auth/auth.types';

type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
type Tx = Prisma.TransactionClient;

const userInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  userRoles: { include: { role: { select: { id: true, code: true, name: true, rolePermissions: { select: { permission: { select: { code: true } } } } } } } },
} satisfies Prisma.UserInclude;
type UserRecord = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** Only safe fields ever leave the service. */
function toDto(u: UserRecord): UserDto {
  return {
    id: u.id,
    email: u.email,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    employee: u.employee,
    roles: u.userRoles.map(({ role }) => ({ id: role.id, code: role.code, name: role.name })).sort((a, b) => a.code.localeCompare(b.code)),
    // Privileged = can administer RBAC or privileged accounts (Task 45); decided by permissions, never a role name.
    privileged: isPrivilegedAccount(u.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code))),
  };
}

const SORT_MAP: Record<UserListQuery['sortBy'], (dir: 'asc' | 'desc') => Prisma.UserOrderByWithRelationInput> = {
  email: (dir) => ({ email: dir }),
  createdAt: (dir) => ({ createdAt: dir }),
  lastLoginAt: (dir) => ({ lastLoginAt: dir }),
};

function actorMeta(actor: Actor) {
  return { userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent };
}

async function findOrThrow(tx: Tx | typeof prisma, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: userInclude });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  return user;
}

/**
 * Validates role codes and blocks privilege escalation. A role may be granted only when BOTH hold:
 *   1. no permission blocks it (blockingGrantPermissions: its permissions ⊆ the actor's, except that a `roles.manage`
 *      holder may grant business permissions it lacks — never administration ones) → else ROLE_ESCALATION_NOT_ALLOWED
 *   2. its data scope ≤ the actor's effective data scope         → else ROLE_SCOPE_ESCALATION_NOT_ALLOWED
 * (no role-name checks). Roles the target already holds are exempt, so an admin can edit a user without "re-granting" them.
 */
async function resolveRoles(tx: Tx | typeof prisma, roleCodes: string[], actor: Actor, alreadyHeld: string[] = []) {
  const codes = [...new Set(roleCodes)];
  const roles = await tx.role.findMany({ where: { code: { in: codes } }, include: { rolePermissions: { include: { permission: { select: { code: true } } } } } });
  if (roles.length !== codes.length) {
    const found = new Set(roles.map((r) => r.code));
    const missing = codes.filter((c) => !found.has(c));
    throw new AppError(400, 'INVALID_ROLE', `Unknown role(s): ${missing.join(', ')}`, missing.map((m) => ({ field: 'roleCodes', message: `Unknown role ${m}` })));
  }
  const escalating = roles.filter((r) => !alreadyHeld.includes(r.code) && blockingGrantPermissions(actor.auth.permissions, r.rolePermissions.map((rp) => rp.permission.code)).length > 0);
  if (escalating.length > 0) {
    throw new AppError(403, 'ROLE_ESCALATION_NOT_ALLOWED', `You cannot grant roles with permissions you do not have: ${escalating.map((r) => r.code).join(', ')}`);
  }
  const widerScope = roles.filter((r) => !alreadyHeld.includes(r.code) && !isScopeWithin(r.dataScope, actor.auth.dataScope));
  if (widerScope.length > 0) {
    throw new AppError(403, 'ROLE_SCOPE_ESCALATION_NOT_ALLOWED', `You cannot grant roles with a wider data scope (${widerScope.map((r) => `${r.code}=${r.dataScope}`).join(', ')}) than your own (${actor.auth.dataScope})`);
  }
  return roles;
}

async function assertEmailAvailable(tx: Tx | typeof prisma, email: string, exceptUserId?: string) {
  const existing = await tx.user.findUnique({ where: { email } });
  if (existing && existing.id !== exceptUserId) throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'A user with this email already exists');
}

async function assertEmployeeLinkable(tx: Tx | typeof prisma, employeeId: string, exceptUserId?: string) {
  const employee = await tx.employee.findUnique({ where: { id: employeeId }, include: { user: { select: { id: true } } } });
  if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  if (employee.user && employee.user.id !== exceptUserId) {
    throw new AppError(409, 'EMPLOYEE_ALREADY_LINKED', 'This employee is already linked to another user account');
  }
}

/** Number of ACTIVE users holding SYSTEM_ADMIN — the system must never reach zero. */
async function countActiveSystemAdmins(tx: Tx | typeof prisma, excludeUserId?: string) {
  return tx.user.count({
    where: {
      isActive: true,
      id: excludeUserId ? { not: excludeUserId } : undefined,
      userRoles: { some: { role: { code: ROLES.SYSTEM_ADMIN } } },
    },
  });
}

/**
 * Transaction-composable deactivation for the lifecycle module's separation completion: same rules as the admin
 * action (never yourself, never the last System Admin), same effect (is_active=false, all sessions revoked, audited),
 * inside the caller's transaction. Idempotent for an already-inactive account.
 */
export async function deactivateUserWithTx(tx: Tx, id: string, actor: Actor, reason: string): Promise<{ disabled: boolean; sessionsRevoked: number }> {
  if (id === actor.auth.userId) throw new AppError(409, 'SELF_DEACTIVATION_NOT_ALLOWED', 'You cannot deactivate your own account');
  const before = await findOrThrow(tx, id);
  await assertCanAdministerAccount(tx, actor, id, 'DEACTIVATE');
  if (!before.isActive) return { disabled: false, sessionsRevoked: 0 };
  const isSystemAdmin = before.userRoles.some((ur) => ur.role.code === ROLES.SYSTEM_ADMIN);
  if (isSystemAdmin && (await countActiveSystemAdmins(tx, id)) === 0) throw new AppError(409, 'LAST_SYSTEM_ADMIN', 'This is the last active System Admin and cannot be deactivated');
  await tx.user.update({ where: { id }, data: { isActive: false } });
  const revoked = await tx.session.deleteMany({ where: { userId: id } });
  await auditService.log({ ...actorMeta(actor), action: AUDIT_ACTIONS.DEACTIVATE_USER, module: 'users', recordType: 'User', recordId: id, oldValue: { isActive: true }, newValue: { isActive: false, sessionsRevoked: revoked.count, reason } }, tx);
  return { disabled: true, sessionsRevoked: revoked.count };
}

export const usersService = {
  async list(query: UserListQuery): Promise<{ data: UserDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.UserWhereInput = {};
    if (query.status) where.isActive = query.status === 'active';
    if (query.role) where.userRoles = { some: { role: { code: query.role } } };
    if (query.search) {
      const s = query.search;
      where.OR = [
        { email: { contains: s, mode: 'insensitive' } },
        { employee: { employeeCode: { contains: s, mode: 'insensitive' } } },
        { employee: { firstName: { contains: s, mode: 'insensitive' } } },
        { employee: { lastName: { contains: s, mode: 'insensitive' } } },
      ];
    }
    const [total, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: SORT_MAP[query.sortBy](query.sortDir),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data: rows.map(toDto), meta: { page: query.page, pageSize: query.pageSize, total } };
  },

  async getById(id: string): Promise<UserDto> {
    return toDto(await findOrThrow(prisma, id));
  },

  async create(input: CreateUserInput, actor: Actor): Promise<UserDto> {
    const passwordHash = await hashPassword(input.password);
    const user = await prisma.$transaction(async (tx) => {
      await assertEmailAvailable(tx, input.email);
      if (input.employeeId) await assertEmployeeLinkable(tx, input.employeeId);
      const roles = await resolveRoles(tx, input.roleCodes, actor);
      const created = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          employeeId: input.employeeId ?? null,
          userRoles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
        include: userInclude,
      });
      await auditService.log(
        {
          ...actorMeta(actor),
          action: AUDIT_ACTIONS.CREATE_USER,
          module: 'users',
          recordType: 'User',
          recordId: created.id,
          newValue: { email: created.email, employeeId: created.employeeId, roles: roles.map((r) => r.code).sort() },
        },
        tx,
      );
      return created;
    });
    return toDto(user);
  },

  async update(id: string, input: UpdateUserInput, actor: Actor): Promise<UserDto> {
    const user = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      // Every PATCH field is identity-relevant (login e-mail, the employee record behind SELF-scope data).
      await assertCanAdministerAccount(tx, actor, id, 'UPDATE');
      if (input.email !== undefined) await assertEmailAvailable(tx, input.email, id);
      if (input.employeeId) await assertEmployeeLinkable(tx, input.employeeId, id);

      const after = await tx.user.update({
        where: { id },
        data: { email: input.email, employeeId: input.employeeId === undefined ? undefined : input.employeeId },
        include: userInclude,
      });
      const diff = diffFields(
        { email: before.email, employeeId: before.employeeId },
        { email: after.email, employeeId: after.employeeId },
      );
      if (Object.keys(diff.new).length > 0) {
        await auditService.log(
          { ...actorMeta(actor), action: AUDIT_ACTIONS.UPDATE_USER, module: 'users', recordType: 'User', recordId: id, oldValue: diff.old, newValue: diff.new },
          tx,
        );
      }
      return after;
    });
    return toDto(user);
  },

  async setRoles(id: string, input: UpdateUserRolesInput, actor: Actor): Promise<UserDto> {
    const user = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      await assertCanAdministerAccount(tx, actor, id, 'SET_ROLES');
      const oldCodes = before.userRoles.map((ur) => ur.role.code).sort();
      const roles = await resolveRoles(tx, input.roleCodes, actor, oldCodes);
      const newCodes = roles.map((r) => r.code).sort();

      const losesSystemAdmin = oldCodes.includes(ROLES.SYSTEM_ADMIN) && !newCodes.includes(ROLES.SYSTEM_ADMIN);
      if (losesSystemAdmin) {
        if (id === actor.auth.userId) {
          throw new AppError(409, 'SELF_ROLE_REMOVAL_NOT_ALLOWED', 'You cannot remove the System Admin role from your own account');
        }
        if (before.isActive && (await countActiveSystemAdmins(tx, id)) === 0) {
          throw new AppError(409, 'LAST_SYSTEM_ADMIN', 'This is the last active System Admin; assign the role to another user first');
        }
      }
      // roles.manage administers OTHER people's access: an assignment to yourself may never add a permission or widen scope.
      if (id === actor.auth.userId) {
        assertNoSelfEscalation(actor, accessOf(roles), 'SELF_ROLE_ASSIGNMENT');
      }

      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      if (JSON.stringify(oldCodes) !== JSON.stringify(newCodes)) {
        await auditService.log(
          { ...actorMeta(actor), action: AUDIT_ACTIONS.UPDATE_USER_ROLES, module: 'users', recordType: 'User', recordId: id, oldValue: { roles: oldCodes }, newValue: { roles: newCodes } },
          tx,
        );
      }
      return findOrThrow(tx, id);
    });
    return toDto(user);
  },

  /** Deactivate: is_active=false + revoke ALL sessions + audit, atomically. */
  async deactivate(id: string, actor: Actor): Promise<UserDto> {
    if (id === actor.auth.userId) throw new AppError(409, 'SELF_DEACTIVATION_NOT_ALLOWED', 'You cannot deactivate your own account');
    const user = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      await assertCanAdministerAccount(tx, actor, id, 'DEACTIVATE');
      if (!before.isActive) return before;
      const isSystemAdmin = before.userRoles.some((ur) => ur.role.code === ROLES.SYSTEM_ADMIN);
      if (isSystemAdmin && (await countActiveSystemAdmins(tx, id)) === 0) {
        throw new AppError(409, 'LAST_SYSTEM_ADMIN', 'This is the last active System Admin and cannot be deactivated');
      }
      const after = await tx.user.update({ where: { id }, data: { isActive: false }, include: userInclude });
      const revoked = await tx.session.deleteMany({ where: { userId: id } });
      await auditService.log(
        { ...actorMeta(actor), action: AUDIT_ACTIONS.DEACTIVATE_USER, module: 'users', recordType: 'User', recordId: id, oldValue: { isActive: true }, newValue: { isActive: false, sessionsRevoked: revoked.count } },
        tx,
      );
      return after;
    });
    return toDto(user);
  },

  /** Activate: is_active=true only. Old sessions were deleted at deactivation, so the user must log in again. */
  async activate(id: string, actor: Actor): Promise<UserDto> {
    const user = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      await assertCanAdministerAccount(tx, actor, id, 'ACTIVATE');
      if (before.isActive) return before;
      const after = await tx.user.update({ where: { id }, data: { isActive: true }, include: userInclude });
      await auditService.log(
        { ...actorMeta(actor), action: AUDIT_ACTIONS.ACTIVATE_USER, module: 'users', recordType: 'User', recordId: id, oldValue: { isActive: false }, newValue: { isActive: true } },
        tx,
      );
      return after;
    });
    return toDto(user);
  },

  /** Employees available for linking to a user account (for the user form). */
  async employeeOptions(search: string | undefined, includeUserId: string | undefined): Promise<EmployeeOption[]> {
    const rows = await prisma.employee.findMany({
      where: {
        employmentStatus: 'ACTIVE',
        OR: [{ user: null }, ...(includeUserId ? [{ user: { id: includeUserId } }] : [])],
        ...(search
          ? { AND: [{ OR: [{ employeeCode: { contains: search, mode: 'insensitive' } }, { firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] }] }
          : {}),
      },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { id: true } } },
      orderBy: { employeeCode: 'asc' },
      take: 50,
    });
    return rows.map((r) => ({ id: r.id, employeeCode: r.employeeCode, firstName: r.firstName, lastName: r.lastName, linkedUserId: r.user?.id ?? null }));
  },
};
