import type { Server } from 'node:http';
import type { Response } from 'supertest';
import { afterAll } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';
import { hashPassword } from '../src/lib/password';
import { seedRolesAndPermissions } from '../prisma/seeders/roles';

export const SESSION_COOKIE = 'hr_session';

/**
 * One HTTP server per test file, bound explicitly to 127.0.0.1 and closed in afterAll.
 *
 * Why not `request(app)`: supertest then calls `app.listen(0)` for EVERY request, which binds the IPv6
 * wildcard `[::]:P` while the client connects to `127.0.0.1:P`. macOS lets that bind succeed even when
 * another process already owns `127.0.0.1:P` (IPv4-only listeners such as VS Code helpers or chat apps
 * in the ephemeral range), so the client occasionally reaches a foreign process → garbage responses
 * ("Parse Error: Expected HTTP/", wrong status, no cookie). Binding to 127.0.0.1 makes client and
 * server agree on the address family, so the kernel only hands out ports that are free for exactly
 * that address.
 */
export function createTestServer(): Server {
  const server = createApp().listen(0, '127.0.0.1');
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return server;
}

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

/** Destructive helpers may only run under NODE_ENV=test against TEST_DATABASE_URL (never the dev database). */
export function assertTestDatabase() {
  if (process.env.NODE_ENV !== 'test' || !env.isTest) throw new Error('Destructive test helper called outside NODE_ENV=test');
  if (!env.TEST_DATABASE_URL || env.databaseUrl !== env.TEST_DATABASE_URL) throw new Error('Destructive test helper requires the TEST_DATABASE_URL connection');
  if (env.TEST_DATABASE_URL === env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL');
}

export async function cleanUsers() {
  assertTestDatabase();
  await prisma.passwordResetToken.deleteMany();
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
  assertTestDatabase();
  await prisma.onboardingImportRun.deleteMany();
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.leaveLedger.deleteMany();
  await prisma.leaveEntitlement.deleteMany();
  await prisma.leavePolicy.deleteMany();
  await prisma.leaveType.deleteMany();
  await prisma.organization.updateMany({ data: { defaultCalendarId: null } });
  await prisma.holiday.deleteMany();
  await prisma.workCalendar.deleteMany();
  await prisma.workflowAction.deleteMany();
  await prisma.workflowInstanceStep.deleteMany();
  await prisma.workflowInstance.deleteMany();
  await prisma.workflowDefinitionStep.deleteMany();
  await prisma.workflowDefinition.deleteMany();
  await prisma.employeeManager.deleteMany();
  await prisma.employeePosition.deleteMany();
  await prisma.performancePlanItem.deleteMany();
  await prisma.performancePlan.deleteMany();
  await prisma.performanceRatingBand.deleteMany();
  await prisma.performanceCycle.deleteMany();
  await prisma.performanceKpi.deleteMany();
  await prisma.payrollResultItem.deleteMany();
  await prisma.payrollResult.deleteMany();
  await prisma.payrollRun.deleteMany();
  await prisma.payrollPeriod.deleteMany();
  await prisma.payrollPolicy.deleteMany();
  await prisma.employeePayItem.deleteMany();
  await prisma.payComponent.deleteMany();
  await prisma.employeeCompensation.deleteMany();
  await prisma.overtimeRequest.deleteMany();
  await prisma.overtimePolicy.deleteMany();
  await prisma.attendanceCorrection.deleteMany();
  await prisma.attendanceRecord.deleteMany();
  await prisma.attendanceClockEvent.deleteMany();
  await prisma.attendanceSchedule.deleteMany();
  await prisma.attendanceShift.deleteMany();
  await prisma.privacyRequest.deleteMany();
  await prisma.passwordResetToken.deleteMany();
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

/**
 * Deterministic diagnostic for an unexpected auth failure: which path produced it and the account/session state
 * at that moment. Never includes passwords, hashes, tokens or cookies.
 */
export async function explainAuthFailure(email: string, res: { status: number; body: unknown }, cookie?: string) {
  const user = await prisma.user.findUnique({ where: { email }, include: { _count: { select: { sessions: true } }, userRoles: { include: { role: true } } } });
  const failed = await prisma.auditLog.findMany({ where: { action: 'LOGIN_FAILED' }, orderBy: { createdAt: 'desc' }, take: 3, select: { userId: true, newValue: true, createdAt: true } });
  const cookieSession = cookie ? await prisma.session.findUnique({ where: { tokenHash: (await import('../src/modules/auth/session.service')).hashToken(cookie.split('=')[1] ?? '') }, select: { id: true, userId: true, expiresAt: true } }) : undefined;
  return JSON.stringify({
    email, status: res.status, body: res.body,
    user: user ? { id: user.id, isActive: user.isActive, passwordHashLength: user.passwordHash.length, sessions: user._count.sessions, roles: user.userRoles.map((r) => r.role.code), lastLoginAt: user.lastLoginAt } : null,
    cookiePresent: !!cookie, cookieSession, recentLoginFailedAudits: failed, now: new Date().toISOString(),
  });
}

/** Logs in and returns { cookie, csrf, user } ready for authenticated requests. Fails loudly with full diagnostics. */
export async function loginAs(app: Server, email: string, password: string) {
  const request = (await import('supertest')).default;
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${await explainAuthFailure(email, res)}`);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error(`login 200 but no session cookie: ${await explainAuthFailure(email, res)} set-cookie=${JSON.stringify(res.headers['set-cookie'])}`);
  return { cookie, csrf: res.body.data.csrfToken as string, user: res.body.data };
}

/**
 * Concurrency tests: resolves once at least `n` OTHER sessions of this database are waiting on a lock — a
 * database-level proof that a competing transaction is really blocked on a row lock (never a timing guess).
 */
export async function waitForBlockedSession(n = 1, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    const rows = await prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (Number(rows[0].c) >= n) return;
    if (Date.now() - started > timeoutMs) throw new Error(`no session blocked on a lock within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
