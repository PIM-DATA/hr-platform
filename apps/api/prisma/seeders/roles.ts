import type { PrismaClient } from '@prisma/client';
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from '@hr/shared';

/**
 * Upserts permissions + roles + role_permissions from @hr/shared.
 * Idempotent; only ADDS missing role permissions (never removes ones granted via the Roles page).
 * Shared by prisma/seed.ts and the test suite.
 */
export async function seedRolesAndPermissions(prisma: PrismaClient) {
  for (const p of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { module: p.module, description: p.description },
      create: { code: p.code, module: p.module, description: p.description },
    });
  }
  const permissions = await prisma.permission.findMany();
  const idByCode = new Map(permissions.map((p) => [p.code, p.id]));

  for (const r of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description, dataScope: r.dataScope, isSystem: true },
      create: { code: r.code, name: r.name, description: r.description, dataScope: r.dataScope, isSystem: true },
    });
    for (const code of r.permissions) {
      const permissionId = idByCode.get(code)!;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }
  return { permissions: PERMISSION_DEFINITIONS.length, roles: ROLE_DEFINITIONS.length };
}
