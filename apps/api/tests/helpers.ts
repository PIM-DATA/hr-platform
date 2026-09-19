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
