import type { Response } from 'supertest';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/lib/password';
import { seedRolesAndPermissions } from '../prisma/seeders/roles';

export const SESSION_COOKIE = 'hr_session';

/** Returns the `hr_session=<value>` pair from a response's Set-Cookie, or undefined when cleared. */
export function sessionCookie(res: Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const header = raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!header) return undefined;
  const pair = header.split(';')[0];
  const value = pair.split('=')[1];
  return value ? pair : undefined; // `hr_session=;` means cleared
}

export function rawSetCookie(res: Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
}

export async function ensureRoles() {
  await seedRolesAndPermissions(prisma);
}

export async function createUser(opts: { email: string; password: string; role?: string; isActive?: boolean; employeeId?: string }) {
  const role = opts.role ? await prisma.role.findUniqueOrThrow({ where: { code: opts.role } }) : null;
  return prisma.user.create({
    data: {
      email: opts.email,
      passwordHash: await hashPassword(opts.password),
      isActive: opts.isActive ?? true,
      employeeId: opts.employeeId,
      userRoles: role ? { create: { roleId: role.id } } : undefined,
    },
  });
}

export async function cleanUsers() {
  await prisma.session.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Wipes ALL application data in FK-safe order and re-seeds roles/permissions.
 * Every test file calls this in beforeAll so files are independent of execution order
 * (vitest re-orders files by previous failures/durations, so leftovers from another file must never matter).
 */
export async function resetDatabase() {
  await prisma.employeeManager.deleteMany();
  await prisma.employeePosition.deleteMany();
  await prisma.session.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.department.updateMany({ data: { headEmployeeId: null } });
  await prisma.employee.deleteMany();
  await prisma.position.deleteMany();
  await prisma.department.deleteMany();
  await prisma.job.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany(); // custom roles created by tests go too; system roles are re-seeded below
  await prisma.systemSetting.deleteMany();
  await seedRolesAndPermissions(prisma);
}

/** Restores role ↔ permission mapping exactly as defined in @hr/shared (tests that edit roles call this). */
export async function resetRolePermissions() {
  await prisma.rolePermission.deleteMany();
  await seedRolesAndPermissions(prisma);
}

/** Logs in and returns { cookie, csrf, user } ready for authenticated requests. */
export async function loginAs(app: import('express').Express, email: string, password: string) {
  const request = (await import('supertest')).default;
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return { cookie: sessionCookie(res)!, csrf: res.body.data.csrfToken as string, user: res.body.data };
}
