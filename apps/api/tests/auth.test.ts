import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { hashToken } from '../src/modules/auth/session.service';
import { loginRateLimiter } from '../src/middleware/login-rate-limit';
import { env } from '../src/config/env';
import { cleanUsers, createTestServer, createUser, ensureRoles, rawSetCookie, resetDatabase, sessionCookie } from './helpers';

const app = createTestServer();
const PASSWORD = 'Correct-Horse-1';
const ADMIN = 'admin@test.local';
const INACTIVE = 'inactive@test.local';

async function login(email = ADMIN, password = PASSWORD) {
  return request(app).post('/api/v1/auth/login').send({ email, password });
}
/** For tests that need a working session: fails loudly with the real response instead of a TypeError. */
async function loginOk(email = ADMIN, password = PASSWORD) {
  const res = await login(email, password);
  if (res.status !== 200) throw new Error(`expected login 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: ADMIN, password: PASSWORD, role: 'SYSTEM_ADMIN' });
  await createUser({ email: INACTIVE, password: PASSWORD, role: 'EMPLOYEE', isActive: false });
});
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('POST /auth/login', () => {
  it('1. login success returns user payload + session cookie and never leaks secrets', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    // Task 50 — BEFORE: dataScope: 'ALL' (user-wide). AFTER: per permission.
    expect(res.body.data).toMatchObject({ email: ADMIN, isActive: true, employee: null, permissionScopes: expect.objectContaining({ 'users.view': 'ALL' }) });
    expect(res.body.data.roles).toEqual([{ code: 'SYSTEM_ADMIN', name: 'System Admin' }]);
    expect(res.body.data.permissions).toContain('employees.view');
    expect(typeof res.body.data.csrfToken).toBe('string');
    expect(sessionCookie(res)).toBeDefined();
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash/);
  });

  it('2. wrong password → 401 INVALID_CREDENTIALS', async () => {
    const res = await login(ADMIN, 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('3. unknown email → identical response to wrong password (no user enumeration)', async () => {
    const wrongPw = await login(ADMIN, 'wrong-password');
    const unknown = await login('nobody@test.local', 'wrong-password');
    expect(unknown.status).toBe(wrongPw.status);
    expect(unknown.body).toEqual(wrongPw.body);
  });

  it('4. inactive user cannot login', async () => {
    const res = await login(INACTIVE, PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('validates the body (400 VALIDATION_ERROR)', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rate-limits repeated failures per IP and resets after a successful login', async () => {
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i++) {
      expect((await login(ADMIN, 'wrong')).status).toBe(401);
    }
    const blocked = await login(ADMIN, PASSWORD); // even correct credentials are blocked now
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(blocked.headers['retry-after']).toBeDefined();

    loginRateLimiter.clearAll();
    expect((await login(ADMIN, 'wrong')).status).toBe(401);
    expect((await login()).status).toBe(200); // success resets the counter
    expect((await login(ADMIN, 'wrong')).status).toBe(401);
  });

  it('writes LOGIN_SUCCESS / LOGIN_FAILED audit entries without sensitive data', async () => {
    await prisma.auditLog.deleteMany();
    await login(ADMIN, 'wrong');
    await login();
    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['LOGIN_FAILED', 'LOGIN_SUCCESS']);
    for (const l of logs) {
      const text = `${l.oldValue ?? ''}${l.newValue ?? ''}`;
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toMatch(/wrong|\$2[aby]\$/); // no attempted password, no bcrypt hash
    }
  });
});

describe('GET /auth/me', () => {
  it('5. without session → 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('6. with valid session → 200 with same payload as login', async () => {
    const cookie = sessionCookie(await loginOk())!;
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(ADMIN);
    expect(res.body.data.roles[0].code).toBe('SYSTEM_ADMIN');
  });

  it('with a garbage cookie → 401 and the cookie is cleared', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', 'hr_session=not-a-real-token');
    expect(res.status).toBe(401);
    expect(rawSetCookie(res)).toMatch(/hr_session=;/);
  });
});

describe('Session lifecycle', () => {
  it('7. logout invalidates the session and clears the cookie', async () => {
    const loginRes = await loginOk();
    const cookie = sessionCookie(loginRes)!;
    const csrf = loginRes.body.data.csrfToken as string;

    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(out.status).toBe(204);
    expect(rawSetCookie(out)).toMatch(/hr_session=;/);

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
    expect(await prisma.session.count({ where: { tokenHash: hashToken(cookie.split('=')[1]) } })).toBe(0);
  });

  it('8. expired session is rejected and removed', async () => {
    const cookie = sessionCookie(await loginOk())!;
    const tokenHash = hashToken(cookie.split('=')[1]);
    await prisma.session.update({ where: { tokenHash }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(await prisma.session.count({ where: { tokenHash } })).toBe(0);
  });

  it('9. deactivating a user invalidates their existing session', async () => {
    const email = 'temp@test.local';
    await createUser({ email, password: PASSWORD, role: 'HR' });
    const cookie = sessionCookie(await loginOk(email))!;
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);

    await prisma.user.update({ where: { email }, data: { isActive: false } });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('Session security', () => {
  it('10. database stores SHA-256 hash, never the raw token', async () => {
    const cookie = sessionCookie(await loginOk())!;
    const raw = cookie.split('=')[1];
    expect(raw.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(await prisma.session.findUnique({ where: { tokenHash: raw } })).toBeNull();
    const stored = await prisma.session.findUnique({ where: { tokenHash: hashToken(raw) } });
    expect(stored).not.toBeNull();
    expect(stored!.csrfToken).not.toBe(raw);
    expect(stored!.csrfToken).not.toBe(hashToken(raw));
  });

  it('11. cookie is HttpOnly, SameSite=Lax, Path=/ with an expiry', async () => {
    const header = rawSetCookie(await loginOk());
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=\d+/i);
    expect(header).not.toMatch(/Secure/i); // COOKIE_SECURE=false outside production
  });

  it('12. login always creates a fresh session (fixation protection)', async () => {
    const first = sessionCookie(await loginOk())!;
    const second = sessionCookie(await request(app).post('/api/v1/auth/login').set('Cookie', first).send({ email: ADMIN, password: PASSWORD }))!;
    expect(second).not.toBe(first);
    expect(await prisma.session.count({ where: { tokenHash: hashToken(first.split('=')[1]) } })).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', first)).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', second)).status).toBe(200);
  });
});

describe('CSRF protection', () => {
  it('13. mutation without CSRF token → 403', async () => {
    const cookie = sessionCookie(await loginOk())!;
    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200); // session untouched
  });

  it('14. invalid CSRF token → 403', async () => {
    const cookie = sessionCookie(await loginOk())!;
    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('x-csrf-token', 'wrong');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('15. valid CSRF token → accepted', async () => {
    const loginRes = await loginOk();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', sessionCookie(loginRes)!)
      .set('x-csrf-token', loginRes.body.data.csrfToken);
    expect(res.status).toBe(204);
  });

  it('session token cannot be used as the CSRF token', async () => {
    const cookie = sessionCookie(await loginOk())!;
    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('x-csrf-token', cookie.split('=')[1]);
    expect(res.status).toBe(403);
  });

  it('cross-site Origin on a mutation → 403 (defense-in-depth)', async () => {
    const loginRes = await loginOk();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', sessionCookie(loginRes)!)
      .set('x-csrf-token', loginRes.body.data.csrfToken)
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it('GET /auth/me and POST /auth/login need no CSRF token', async () => {
    expect((await login()).status).toBe(200);
  });
});
