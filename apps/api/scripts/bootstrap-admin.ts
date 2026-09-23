/**
 * Production bootstrap: reference data (permissions + roles) and ONE system administrator.
 *
 * Deliberately a separate, explicit command — never part of application startup and never part of the demo seed.
 * It creates no sample company, no demo accounts and no test data.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... npm run bootstrap:admin
 *
 * Safety: refuses to overwrite an existing account, refuses obvious placeholder passwords, and applies the shared
 * password policy (`passwordField`) — the same rule the application enforces, so a
 * password that cannot be set inside the app cannot be smuggled in through the bootstrap either. The password is read
 * from the environment and never logged or echoed.
 */
import { PrismaClient } from '@prisma/client';
import { PASSWORD_MIN_LENGTH, ROLES, passwordField } from '@hr/shared';
import { seedRolesAndPermissions } from '../prisma/seeders/roles';
import { env } from '../src/config/env';
import { hashPassword } from '../src/lib/password';

const prisma = new PrismaClient({ datasourceUrl: env.databaseUrl });
const PLACEHOLDERS = ['change-me-locally', 'changeme', 'password', 'secret', 'demo', 'test1234', 'admin'];

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  const problems: string[] = [];
  if (!email) problems.push('BOOTSTRAP_ADMIN_EMAIL is required');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('BOOTSTRAP_ADMIN_EMAIL is not a valid email address');
  if (!password) problems.push('BOOTSTRAP_ADMIN_PASSWORD is required');
  else {
    // The shared policy, not a copy of it: one rule for every path that sets a password.
    const checked = passwordField.safeParse(password);
    if (!checked.success) problems.push(`BOOTSTRAP_ADMIN_PASSWORD: ${checked.error.issues[0]?.message ?? `must be at least ${PASSWORD_MIN_LENGTH} characters`}`);
    else if (PLACEHOLDERS.includes(password.toLowerCase())) problems.push('BOOTSTRAP_ADMIN_PASSWORD is a well-known placeholder — choose a real password');
  }
  if (problems.length) {
    console.error(`bootstrap:admin refused:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }

  const counts = await seedRolesAndPermissions(prisma);
  console.log(`✓ reference data: ${counts.permissions} permissions, ${counts.roles} roles`);

  const existing = await prisma.user.findUnique({ where: { email: email! }, select: { id: true } });
  if (existing) {
    console.error(`A user with that address already exists (id ${existing.id}). Refusing to modify it; reset the password from inside the app instead.`);
    process.exit(1);
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { code: ROLES.SYSTEM_ADMIN } });
  const user = await prisma.user.create({
    data: { email: email!, passwordHash: await hashPassword(password!), isActive: true, userRoles: { create: { roleId: role.id } } },
    select: { id: true, email: true },
  });
  console.log(`✓ system administrator created: ${user.email} (id ${user.id})`);
  console.log('  Sign in and change the password if it was shared with anyone.');
}

main()
  .catch((e) => {
    console.error('bootstrap:admin failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
