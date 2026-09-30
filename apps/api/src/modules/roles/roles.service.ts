import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, CRITICAL_PERMISSIONS, ROLES, blockingRoleEditPermissions, type PermissionDto, type RoleDto, type UpdateRolePermissionsInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { assertNoSelfEscalation } from '../users/account-guard';

type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

const roleInclude = {
  rolePermissions: { include: { permission: { select: { code: true } } } },
  _count: { select: { userRoles: true } },
} satisfies Prisma.RoleInclude;
type RoleRecord = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

function toDto(r: RoleRecord): RoleDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    dataScope: r.dataScope,
    isSystem: r.isSystem,
    permissionCodes: r.rolePermissions.map((rp) => rp.permission.code).sort(),
    userCount: r._count.userRoles,
  };
}

export const rolesService = {
  async list(): Promise<RoleDto[]> {
    const rows = await prisma.role.findMany({ include: roleInclude, orderBy: { name: 'asc' } });
    return rows.map(toDto);
  },

  async getById(id: string): Promise<RoleDto> {
    const role = await prisma.role.findUnique({ where: { id }, include: roleInclude });
    if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found');
    return toDto(role);
  },

  async listPermissions(): Promise<PermissionDto[]> {
    return prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }], select: { id: true, code: true, module: true, description: true } });
  },

  /**
   * Replaces the role's permission set (deterministic: the result equals the deduplicated input).
   * Rules: every code must exist; SYSTEM_ADMIN keeps CRITICAL_PERMISSIONS; no self-escalation through a held role and no
   * administration permission beyond the actor's own (Task 45). Old/new audited in the same transaction.
   * Takes effect on the next request of every affected user because req.auth is rebuilt per request.
   */
  async setPermissions(id: string, input: UpdateRolePermissionsInput, actor: Actor): Promise<RoleDto> {
    const codes = [...new Set(input.permissionCodes)].sort();
    const role = await prisma.$transaction(async (tx) => {
      const before = await tx.role.findUnique({ where: { id }, include: roleInclude });
      if (!before) throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found');

      const permissions = await tx.permission.findMany({ where: { code: { in: codes } } });
      if (permissions.length !== codes.length) {
        const found = new Set(permissions.map((p) => p.code));
        const missing = codes.filter((c) => !found.has(c));
        throw new AppError(400, 'INVALID_PERMISSION', `Unknown permission(s): ${missing.join(', ')}`, missing.map((m) => ({ field: 'permissionCodes', message: `Unknown permission ${m}` })));
      }
      if (before.code === ROLES.SYSTEM_ADMIN) {
        const missingCritical = CRITICAL_PERMISSIONS.filter((c) => !codes.includes(c));
        if (missingCritical.length > 0) {
          throw new AppError(409, 'CRITICAL_PERMISSION_REQUIRED', `System Admin must keep: ${missingCritical.join(', ')}`);
        }
      }

      const oldCodes = before.rolePermissions.map((rp) => rp.permission.code).sort();
      // Task 45 separation of duties, decided before anything is written:
      //  - a role the actor holds may lose permissions but never gain one the actor does not already have;
      //  - any other role may gain business permissions (governance of other users), never administration permissions
      //    the actor lacks, and a role carrying roles.manage must stay within the actor's own permissions.
      if (actor.auth.roles.includes(before.code)) {
        assertNoSelfEscalation(actor, { permissions: [...actor.auth.permissions, ...codes], dataScope: actor.auth.dataScope }, 'ROLE_EDIT_HELD_ROLE');
      } else {
        const blocking = blockingRoleEditPermissions(actor.auth.permissions, oldCodes, codes);
        if (blocking.length > 0) {
          throw new AppError(403, 'ROLE_EDIT_ESCALATION_NOT_ALLOWED', `You cannot add administration permissions you do not hold, or build an RBAC administrator role beyond your own permissions: ${blocking.slice(0, 5).join(', ')}${blocking.length > 5 ? ', …' : ''}`);
        }
      }
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: id, permissionId: p.id })) });

      if (JSON.stringify(oldCodes) !== JSON.stringify(codes)) {
        await auditService.log(
          {
            userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
            action: AUDIT_ACTIONS.UPDATE_ROLE_PERMISSIONS, module: 'roles', recordType: 'Role', recordId: id,
            oldValue: { permissions: oldCodes }, newValue: { permissions: codes },
          },
          tx,
        );
      }
      return tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude });
    });
    return toDto(role);
  },
};
