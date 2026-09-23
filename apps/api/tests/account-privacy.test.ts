/**
 * Task 18 — account recovery, session administration and privacy operations (checklist items 50–56).
 *
 * The recurring theme of these tests is that a secret must exist in exactly one place: the raw reset token is in the
 * HTTP response and nowhere else — not in the database, not in the audit trail, not in the logs.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_MIN_LENGTH, PRIVACY_REQUEST_TYPES } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';
import { logger } from '../src/lib/logger';
import { hashToken } from '../src/modules/auth/session.service';
import { resetApiRateLimiter } from '../src/middleware/rate-limit';
import { loginRateLimiter } from '../src/middleware/login-rate-limit';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
const NEW_PW = 'Brand-New-Pass-9';

type Session = { cookie: string; csrf: string; user: { id: string } };
let adminS: Session, hrS: Session, noPermS: Session;
let subjectEmployeeId: string, otherEmployeeId: string, subjectUserId: string, otherUserId: string;

const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) =>
  request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const login = (email: string, password: string) => request(app).post('/api/v1/auth/login').send({ email, password });
const issueReset = (s: Session, userId: string) => as(s, 'post', `/api/v1/admin/users/${userId}/password-reset`);
const consumeReset = (token: string, newPassword: string) => request(app).post('/api/v1/account/reset-password').send({ token, newPassword });

/** Puts the subject account back on the known password through the link flow, so each test starts from a clean state. */
async function restoreSubjectPassword() {
  const issued = await issueReset(hrS, subjectUserId);
  expect(issued.status, 'restore: issue reset link').toBe(201);
  expect((await consumeReset(issued.body.data.token, PW)).status, 'restore: consume reset link').toBe(204);
}

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'AP', name: 'Account Privacy Co' } });
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'D1', name: 'Dept One' } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'P1', title: 'Officer' } });
  const makeEmployee = async (code: string) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@ap.local`,
        hireDate: new Date('2020-01-01'), organizationId: org.id, departmentId: dept.id, positionId: pos.id,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
        positionHistory: { create: { positionId: pos.id, departmentId: dept.id, startDate: new Date('2020-01-01') } },
      },
    })).id;
  subjectEmployeeId = await makeEmployee('AP1');
  otherEmployeeId = await makeEmployee('AP2');

  await createUser({ email: 'admin@ap.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@ap.local', password: PW, role: 'HR_ADMIN' });
  subjectUserId = (await createUser({ email: 'subject@ap.local', password: PW, role: 'EMPLOYEE', employeeId: subjectEmployeeId })).id;
  otherUserId = (await createUser({ email: 'colleague@ap.local', password: PW, role: 'EMPLOYEE', employeeId: otherEmployeeId })).id;

  adminS = await loginAs(app, 'admin@ap.local', PW);
  hrS = await loginAs(app, 'hradmin@ap.local', PW);
  noPermS = await loginAs(app, 'colleague@ap.local', PW); // an ordinary account; its sessions are never revoked by a test
}, 60000);

beforeEach(() => {
  resetApiRateLimiter();
  loginRateLimiter.clearAll(); // these tests deliberately fail logins with old passwords
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('change own password (50)', () => {
  it('1/2. unauthenticated is rejected, and a wrong current password never changes anything', async () => {
    expect((await request(app).post('/api/v1/account/change-password').send({ currentPassword: PW, newPassword: NEW_PW })).status).toBe(401);

    const session = await loginAs(app, 'subject@ap.local', PW);
    expect(err(await as(session, 'post', '/api/v1/account/change-password').send({ currentPassword: 'not-the-password', newPassword: NEW_PW })))
      .toBe('400 CURRENT_PASSWORD_INCORRECT');
    expect((await login('subject@ap.local', PW)).status).toBe(200); // unchanged
    // the new password has to differ from the current one
    expect((await as(session, 'post', '/api/v1/account/change-password').send({ currentPassword: PW, newPassword: PW })).status).toBe(400);
    // and it must satisfy the shared password policy — the same minimum the bootstrap command applies (Task 18.1)
    const oneShort = `Policy-Short${'x'.repeat(PASSWORD_MIN_LENGTH)}`.slice(0, PASSWORD_MIN_LENGTH - 1);
    expect((await as(session, 'post', '/api/v1/account/change-password').send({ currentPassword: PW, newPassword: oneShort })).status).toBe(400);
    expect((await login('subject@ap.local', oneShort)).status).toBe(401);
  }, 60000);

  it('3–8. a valid change switches the password, revokes every session and audits without the secret', async () => {
    const session = await loginAs(app, 'subject@ap.local', PW);
    const otherDevice = await loginAs(app, 'subject@ap.local', PW);
    expect(await prisma.session.count({ where: { userId: subjectUserId } })).toBeGreaterThanOrEqual(2);

    expect((await as(session, 'post', '/api/v1/account/change-password').send({ currentPassword: PW, newPassword: NEW_PW })).status).toBe(204);

    // 6. every session is gone — including the browser that made the change
    expect(await prisma.session.count({ where: { userId: subjectUserId } })).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', session.cookie)).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', otherDevice.cookie)).status).toBe(401);
    // 5/4. the old password stops working, the new one starts
    expect((await login('subject@ap.local', PW)).status).toBe(401);
    expect((await login('subject@ap.local', NEW_PW)).status).toBe(200);

    // 7/8. audited; neither password nor any hash appears in the entry
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CHANGE_OWN_PASSWORD', recordId: subjectUserId }, orderBy: { createdAt: 'desc' } });
    expect(`${audit.oldValue ?? ''}${audit.newValue ?? ''}`).not.toMatch(/Correct-Horse|Brand-New|\$2[aby]\$/);
    expect(JSON.parse(audit.newValue!)).toMatchObject({ sessionsRevoked: expect.any(Number), resetLinksRevoked: expect.any(Number) });

    await restoreSubjectPassword();
  }, 60000);
});

describe('administrator-issued reset links (51)', () => {
  it('9/10/11/12. permission-gated, one-time, stored only as a hash, audited without the token', async () => {
    expect((await issueReset(noPermS, subjectUserId)).status).toBe(403);

    const res = await issueReset(hrS, subjectUserId);
    expect(res.status).toBe(201);
    const { token, resetUrl, expiresAt, user } = res.body.data;
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/); // 256 bits, URL-safe
    expect(user).toMatchObject({ id: subjectUserId, email: 'subject@ap.local' });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(resetUrl).toContain('/reset-password?token=');

    // 11. the database holds the SHA-256 hash, never the raw token
    const stored = await prisma.passwordResetToken.findMany({ where: { userId: subjectUserId, usedAt: null, revokedAt: null } });
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored[0])).not.toMatch(token);

    // 12. the audit says a link was issued and when it expires — nothing more
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ISSUE_PASSWORD_RESET', recordId: subjectUserId }, orderBy: { createdAt: 'desc' } });
    expect(audit.newValue).not.toMatch(token);
    expect(JSON.parse(audit.newValue!)).toMatchObject({ expiresAt: expect.any(String), ttlMinutes: expect.any(Number) });
  });

  it('15/16. the link is built from the configured application URL, never from the request Host header', async () => {
    const res = await issueReset(hrS, subjectUserId);
    expect(res.body.data.resetUrl).toBe(`${env.publicAppUrl}/reset-password?token=${encodeURIComponent(res.body.data.token)}`);

    const spoofed = await as(hrS, 'post', `/api/v1/admin/users/${subjectUserId}/password-reset`)
      .set('X-Forwarded-Host', 'evil.example.com')
      .set('X-Forwarded-Proto', 'http');
    expect(spoofed.status).toBe(201);
    expect(spoofed.body.data.resetUrl).not.toMatch(/evil\.example\.com/);
    expect(spoofed.body.data.resetUrl.startsWith(`${env.publicAppUrl}/`)).toBe(true);
  });

  it('13. issuing a new link revokes the previous one; an administrator cannot issue one to themselves', async () => {
    const first = await issueReset(hrS, subjectUserId);
    const second = await issueReset(hrS, subjectUserId);
    expect(second.status).toBe(201);
    expect(await prisma.passwordResetToken.count({ where: { userId: subjectUserId, usedAt: null, revokedAt: null } })).toBe(1);
    expect(err(await consumeReset(first.body.data.token, 'Superseded-Pass-1'))).toBe('400 PASSWORD_RESET_TOKEN_INVALID');
    expect((await login('subject@ap.local', 'Superseded-Pass-1')).status).toBe(401);

    expect(err(await issueReset(hrS, hrS.user.id))).toBe('400 USE_CHANGE_PASSWORD');
  }, 60000);

  it('14. an inactive or unknown account gets no link', async () => {
    const inactive = await createUser({ email: 'inactive@ap.local', password: PW, role: 'EMPLOYEE', isActive: false });
    expect(err(await issueReset(hrS, inactive.id))).toBe('409 USER_INACTIVE');
    expect(err(await issueReset(hrS, 'no-such-user-id'))).toBe('404 USER_NOT_FOUND');
    expect(await prisma.passwordResetToken.count({ where: { userId: inactive.id } })).toBe(0);
  });
});

describe('consuming a reset token (52)', () => {
  it('17/22/23/24. sets the password, signs the account out everywhere and burns every outstanding token', async () => {
    await loginAs(app, 'subject@ap.local', PW); // an open session that must not survive the reset
    const issued = await issueReset(hrS, subjectUserId);
    const stray = await prisma.passwordResetToken.create({
      data: { userId: subjectUserId, tokenHash: hashToken('a-second-outstanding-token-value'), expiresAt: new Date(Date.now() + 60_000) },
    });

    expect((await consumeReset(issued.body.data.token, NEW_PW)).status).toBe(204);
    expect(await prisma.session.count({ where: { userId: subjectUserId } })).toBe(0); // 23
    expect((await login('subject@ap.local', NEW_PW)).status).toBe(200);
    expect((await login('subject@ap.local', PW)).status).toBe(401);

    const used = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(issued.body.data.token) } });
    expect(used.usedAt).not.toBeNull(); // 22
    expect((await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: stray.id } })).revokedAt).not.toBeNull(); // 24

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'RESET_USER_PASSWORD', recordId: subjectUserId }, orderBy: { createdAt: 'desc' } });
    expect(audit.newValue).not.toMatch(issued.body.data.token);
    expect(JSON.parse(audit.newValue!)).toMatchObject({ viaResetLink: true });

    await restoreSubjectPassword();
  }, 60000);

  it('18/19/20/21. unknown, expired, already used and deactivated give one identical error', async () => {
    const generic = '400 PASSWORD_RESET_TOKEN_INVALID';
    expect(err(await consumeReset('u'.repeat(43), 'Unknown-Token-1'))).toBe(generic); // 18. never issued

    const expiredRaw = 'expired-token-value-abcdefghijklmnop';
    await prisma.passwordResetToken.create({ data: { userId: subjectUserId, tokenHash: hashToken(expiredRaw), expiresAt: new Date(Date.now() - 1000) } });
    expect(err(await consumeReset(expiredRaw, 'Expired-Token-1'))).toBe(generic); // 19

    const spent = await issueReset(hrS, subjectUserId);
    expect((await consumeReset(spent.body.data.token, 'Used-Once-Pass-1')).status).toBe(204);
    expect(err(await consumeReset(spent.body.data.token, 'Used-Twice-Pass-2'))).toBe(generic); // 20. one-time only
    expect((await login('subject@ap.local', 'Used-Twice-Pass-2')).status).toBe(401);

    // 21. deactivating the account invalidates an outstanding link, and consuming one never reactivates anybody
    const pending = await issueReset(hrS, subjectUserId);
    await prisma.user.update({ where: { id: subjectUserId }, data: { isActive: false } });
    expect(err(await consumeReset(pending.body.data.token, 'Inactive-Pass-3'))).toBe(generic);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: subjectUserId } })).isActive).toBe(false);
    await prisma.user.update({ where: { id: subjectUserId }, data: { isActive: true } });

    await restoreSubjectPassword();
  }, 60000);

  it('the same password policy applies to a reset: one character short is refused, the minimum is accepted', async () => {
    const short = `Reset-Short-${'y'.repeat(PASSWORD_MIN_LENGTH)}`.slice(0, PASSWORD_MIN_LENGTH - 1);
    const exact = `Reset-Exact-${'z'.repeat(PASSWORD_MIN_LENGTH)}`.slice(0, PASSWORD_MIN_LENGTH);
    const issued = await issueReset(hrS, subjectUserId);
    expect((await consumeReset(issued.body.data.token, short)).status).toBe(400);
    expect((await login('subject@ap.local', short)).status).toBe(401);
    // the token survives a rejected attempt: the policy failure is not a consumed link
    expect((await consumeReset(issued.body.data.token, exact)).status).toBe(204);
    expect((await login('subject@ap.local', exact)).status).toBe(200);
    await restoreSubjectPassword();
  }, 60000);

  it('25. two concurrent attempts on the same token → exactly one succeeds (row lock)', async () => {
    for (let round = 0; round < 3; round++) {
      const token = (await issueReset(hrS, subjectUserId)).body.data.token;
      const results = await Promise.all([consumeReset(token, `Race-Pass-a${round}`), consumeReset(token, `Race-Pass-b${round}`)]);
      const outcomes = results.map((r) => (r.status === 204 ? 'OK' : r.body.error.code)).sort();
      expect(outcomes, `round ${round}`).toEqual(['OK', 'PASSWORD_RESET_TOKEN_INVALID']);
      expect(await prisma.passwordResetToken.count({ where: { tokenHash: hashToken(token), usedAt: { not: null } } })).toBe(1);
      // exactly one of the two candidate passwords is now valid
      const logins = await Promise.all([login('subject@ap.local', `Race-Pass-a${round}`), login('subject@ap.local', `Race-Pass-b${round}`)]);
      expect(logins.filter((r) => r.status === 200)).toHaveLength(1);
    }
    await restoreSubjectPassword();
  }, 120000);
});

describe('session administration (53)', () => {
  it('26/29. a user sees only their own sessions, and never a token hash', async () => {
    const session = await loginAs(app, 'subject@ap.local', PW);
    const res = await as(session, 'get', '/api/v1/account/sessions');
    expect(res.status).toBe(200);
    const mine = await prisma.session.findMany({ where: { userId: subjectUserId }, select: { id: true } });
    expect(res.body.data.map((s: { id: string }) => s.id).sort()).toEqual(mine.map((m) => m.id).sort());
    expect(res.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|csrfToken|[0-9a-f]{64}/);
  });

  it('27/28/30. revoke-others keeps this browser; an administrator can sign a user out everywhere', async () => {
    const keep = await loginAs(app, 'subject@ap.local', PW);
    await loginAs(app, 'subject@ap.local', PW);
    await loginAs(app, 'subject@ap.local', PW);

    const res = await as(keep, 'post', '/api/v1/account/sessions/revoke-others');
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBeGreaterThanOrEqual(2);
    expect(await prisma.session.count({ where: { userId: subjectUserId } })).toBe(1);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', keep.cookie)).status).toBe(200);

    expect((await as(noPermS, 'post', `/api/v1/admin/users/${subjectUserId}/revoke-sessions`)).status).toBe(403);
    const adminRes = await as(hrS, 'post', `/api/v1/admin/users/${subjectUserId}/revoke-sessions`);
    expect(adminRes.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: subjectUserId } })).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', keep.cookie)).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'ADMIN_REVOKE_USER_SESSIONS', recordId: subjectUserId } })).toBeGreaterThan(0);
  }, 60000);

  it('the administrator "set this password" endpoint no longer exists (Task 18 §18)', async () => {
    // Requirement change: an administrator may not choose anybody's password; recovery goes through a one-time link.
    expect((await as(adminS, 'post', `/api/v1/users/${subjectUserId}/reset-password`).send({ password: 'Direct-Set-Pass-1' })).status).toBe(404);
    expect((await login('subject@ap.local', 'Direct-Set-Pass-1')).status).toBe(401);
  });
});

describe('privacy requests (54)', () => {
  it('31/32/35. permission-gated, and a request must identify a subject', async () => {
    expect((await as(noPermS, 'get', '/api/v1/privacy/requests')).status).toBe(403);
    expect((await as(noPermS, 'post', '/api/v1/privacy/requests').send({ requestType: 'ACCESS', employeeId: subjectEmployeeId })).status).toBe(403);
    expect((await as(hrS, 'post', '/api/v1/privacy/requests').send({ requestType: 'ACCESS' })).status).toBe(400); // neither employee nor user
    expect(err(await as(hrS, 'post', '/api/v1/privacy/requests').send({ requestType: 'ACCESS', employeeId: 'no-such-employee' }))).toBe('404 EMPLOYEE_NOT_FOUND');

    const res = await as(hrS, 'post', '/api/v1/privacy/requests')
      .send({ requestType: 'ACCESS', employeeId: subjectEmployeeId, notes: 'Subject asked in person on 2026-09-01' });
    expect(res.status).toBe(201);
    expect(PRIVACY_REQUEST_TYPES).toContain(res.body.data.requestType);
    expect(res.body.data).toMatchObject({
      status: 'OPEN', completedAt: null,
      subject: { employee: { id: subjectEmployeeId, employeeCode: 'AP1' } },
      createdBy: { id: hrS.user.id },
    });
  });

  it('33/34/36. status moves forward and closes, a closed request cannot be reopened or deleted', async () => {
    const created = (await as(hrS, 'post', '/api/v1/privacy/requests').send({ requestType: 'DELETION', employeeId: subjectEmployeeId })).body.data;

    const inProgress = await as(hrS, 'patch', `/api/v1/privacy/requests/${created.id}`).send({ status: 'IN_PROGRESS', assignedToUserId: hrS.user.id });
    expect(inProgress.status).toBe(200);
    expect(inProgress.body.data).toMatchObject({ status: 'IN_PROGRESS', assignedTo: { id: hrS.user.id } });

    const closed = await as(hrS, 'patch', `/api/v1/privacy/requests/${created.id}`).send({ status: 'COMPLETED', notes: 'Reviewed with legal; retention applies' });
    expect(closed.body.data).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(String) });
    expect(err(await as(hrS, 'patch', `/api/v1/privacy/requests/${created.id}`).send({ status: 'OPEN' }))).toBe('409 PRIVACY_REQUEST_CLOSED');

    // 34. there is no hard delete: the operational record stays
    expect((await as(hrS, 'delete', `/api/v1/privacy/requests/${created.id}`)).status).toBe(404);
    expect(await prisma.privacyRequest.count({ where: { id: created.id } })).toBe(1);

    const audits = await prisma.auditLog.findMany({ where: { recordType: 'PrivacyRequest', recordId: created.id } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['CREATE_PRIVACY_REQUEST', 'UPDATE_PRIVACY_REQUEST']));
    expect(JSON.stringify(audits)).not.toMatch(/Reviewed with legal/); // 36. the free-text note never reaches the audit
  });

  it('37/38. notes stay out of the list, filters and pagination work, the detail returns the note', async () => {
    const note = 'PRIVATE-NOTE-do-not-leak-7788';
    const created = (await as(hrS, 'post', '/api/v1/privacy/requests').send({ requestType: 'CORRECTION', employeeId: subjectEmployeeId, notes: note })).body.data;

    const list = await as(hrS, 'get', '/api/v1/privacy/requests?page=1&pageSize=2');
    expect(list.status).toBe(200);
    expect(list.body.meta).toMatchObject({ page: 1, pageSize: 2, total: expect.any(Number) });
    expect(list.body.data.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(list.body)).not.toMatch(note);

    const filtered = await as(hrS, 'get', '/api/v1/privacy/requests?status=OPEN&requestType=CORRECTION');
    expect(filtered.body.data.every((r: { status: string; requestType: string }) => r.status === 'OPEN' && r.requestType === 'CORRECTION')).toBe(true);
    expect(filtered.body.data.some((r: { id: string }) => r.id === created.id)).toBe(true);

    const detail = await as(hrS, 'get', `/api/v1/privacy/requests/${created.id}`);
    expect(detail.body.data.notes).toBe(note);
    expect(err(await as(hrS, 'get', '/api/v1/privacy/requests/no-such-request'))).toBe('404 PRIVACY_REQUEST_NOT_FOUND');
  });

  it('employee options include former employees and need only the export permission', async () => {
    expect((await as(noPermS, 'get', '/api/v1/privacy/employee-options')).status).toBe(403);
    await prisma.employee.update({ where: { id: otherEmployeeId }, data: { employmentStatus: 'TERMINATED' } });
    try {
      const res = await as(hrS, 'get', '/api/v1/privacy/employee-options?search=AP2');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([expect.objectContaining({ employeeCode: 'AP2', employmentStatus: 'TERMINATED' })]);
    } finally {
      await prisma.employee.update({ where: { id: otherEmployeeId }, data: { employmentStatus: 'ACTIVE' } });
    }
  });
});

describe('personal data export (55)', () => {
  const exportFor = (s: Session, employeeId: string) => as(s, 'post', `/api/v1/privacy/employees/${employeeId}/export`);

  it('39/40/42/43. permission-gated, returned as a no-store JSON attachment with a versioned envelope', async () => {
    expect((await exportFor(noPermS, subjectEmployeeId)).status).toBe(403);
    expect(err(await exportFor(hrS, 'no-such-employee'))).toBe('404 EMPLOYEE_NOT_FOUND');

    const res = await exportFor(hrS, subjectEmployeeId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="personal-data-AP1-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.body).toMatchObject({
      formatVersion: 1,
      generatedAt: expect.any(String),
      subject: { employeeId: subjectEmployeeId, employeeCode: 'AP1', userId: subjectUserId },
    });
    expect(res.body.notIncluded.map((n: { category: string }) => n.category)).toContain('credentials');
  });

  it('41. a former employee can still be exported', async () => {
    await prisma.employee.update({ where: { id: otherEmployeeId }, data: { employmentStatus: 'TERMINATED' } });
    try {
      const res = await exportFor(hrS, otherEmployeeId);
      expect(res.status).toBe(200);
      expect(res.body.subject.employeeCode).toBe('AP2');
      expect(res.body.data.profile.employmentStatus).toBe('TERMINATED');
    } finally {
      await prisma.employee.update({ where: { id: otherEmployeeId }, data: { employmentStatus: 'ACTIVE' } });
    }
  });

  it('the export carries the subject profile, account, history and privacy requests', async () => {
    const res = await exportFor(hrS, subjectEmployeeId);
    const data = res.body.data;
    for (const key of ['profile', 'account', 'positionHistory', 'managerHistory', 'leaveRequests', 'entitlements', 'ledger', 'workflows', 'notifications', 'privacyRequests', 'auditEvents']) {
      expect(data, `missing ${key}`).toHaveProperty(key);
    }
    expect(data.profile).toMatchObject({ employeeCode: 'AP1', email: 'ap1@ap.local', department: { code: 'D1' } });
    expect(data.account).toMatchObject({ email: 'subject@ap.local', isActive: true });
    expect(data.positionHistory.length).toBeGreaterThan(0);
    expect(data.privacyRequests.length).toBeGreaterThan(0); // recorded earlier in this file
  });

  it('46/47/48/49. another person data is not included, and no credential ever is', async () => {
    const stamp = Date.now();
    // A notification for the colleague ABOUT this employee's request: still the colleague's personal data.
    await prisma.notification.create({
      data: {
        userId: otherUserId, type: 'APPROVAL_REQUIRED', title: 'Approval required', body: 'OTHER-INBOX-SECRET',
        dedupeKey: `other-${stamp}`, sourceModule: 'leave', sourceEntityType: 'LEAVE_REQUEST', sourceEntityId: 'shared-entity',
      },
    });
    await prisma.notification.create({
      data: { userId: subjectUserId, type: 'LEAVE_SUBMITTED', title: 'Leave request submitted', body: 'MY-OWN-INBOX', dedupeKey: `subject-${stamp}` },
    });

    const raw = JSON.stringify((await exportFor(hrS, subjectEmployeeId)).body);
    expect(raw).toMatch('MY-OWN-INBOX'); // the subject's own inbox is included
    expect(raw).not.toMatch('OTHER-INBOX-SECRET'); // 47/49. an approver's inbox is theirs, not the subject's
    expect(raw).not.toMatch('ap2@ap.local'); // 48. no third-party contact details
    expect(raw).not.toMatch('colleague@ap.local');
    expect(raw).not.toMatch(/passwordHash|tokenHash|csrfToken|\$2[aby]\$/); // 63. no credentials
    for (const s of await prisma.session.findMany({ select: { tokenHash: true } })) expect(raw).not.toMatch(s.tokenHash);
    for (const t of await prisma.passwordResetToken.findMany({ select: { tokenHash: true } })) expect(raw).not.toMatch(t.tokenHash);
  }, 60000);

  it('44/45. the export is audited as an event with counts, never as a payload', async () => {
    await exportFor(hrS, subjectEmployeeId);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'EXPORT_EMPLOYEE_PERSONAL_DATA', recordId: subjectEmployeeId }, orderBy: { createdAt: 'desc' } });
    expect(audit.userId).toBe(hrS.user.id);
    expect(JSON.parse(audit.newValue!)).toMatchObject({ employeeCode: 'AP1', counts: { notifications: expect.any(Number), leaveRequests: expect.any(Number) } });
    expect(audit.newValue).not.toMatch(/MY-OWN-INBOX|ap1@ap\.local|subject@ap\.local/);
    expect(audit.newValue!.length).toBeLessThan(1000); // a summary, not a dump
  });
});

describe('logging and token privacy (56)', () => {
  it('50/51/52/53. tokens, query strings, passwords and export payloads never reach the logs', async () => {
    // Every log line in a request goes through this logger instance (the request logger and the error handler both
    // use it directly), so capturing its methods captures what a log file would contain.
    const captured: string[] = [];
    const record = ((obj: unknown, msg?: string) => { captured.push(JSON.stringify({ obj, msg })); }) as never;
    const spies = (['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const).map((level) => vi.spyOn(logger, level).mockImplementation(record));

    try {
      const token = (await issueReset(hrS, subjectUserId)).body.data.token;
      await consumeReset(token, 'Logged-Check-Pass-1');
      await request(app).post('/api/v1/account/reset-password').send({ token: 'wrong-token-value-abcdefghijklmnop', newPassword: 'Logged-Check-Pass-2' });
      await request(app).get(`/api/v1/privacy/requests?status=OPEN&token=${token}`).set('Cookie', hrS.cookie);
      await request(app).post('/api/v1/auth/login').send({ email: 'subject@ap.local', password: 'Logged-Check-Pass-1' });
      await as(hrS, 'post', `/api/v1/privacy/employees/${subjectEmployeeId}/export`);

      const logged = captured.join('\n');
      expect(captured.length).toBeGreaterThan(0); // the requests really were logged
      expect(logged).not.toMatch(token); // 50/51. no raw reset token, in any form
      expect(logged).not.toMatch(/Logged-Check-Pass|Correct-Horse/); // 52. no password
      expect(logged).not.toMatch(/MY-OWN-INBOX|ap1@ap\.local/); // 53. no export payload
      expect(logged).not.toMatch(/status=OPEN|\?token=/); // query strings are stripped before logging
    } finally {
      spies.forEach((s) => s.mockRestore());
      await restoreSubjectPassword();
    }
  }, 60000);
});
