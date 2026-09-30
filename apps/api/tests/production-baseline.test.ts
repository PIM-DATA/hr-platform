/**
 * Task 46 — production baseline: explicit runtime mode, typed proxy trust, API cache policy, and the web delivery
 * contract. Real Express behaviour is exercised for proxy trust (req.ip / req.protocol) and the login limiter.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { expressTrustProxy, parseEnv, parseTrustProxy } from '../src/config/env';
import { loginRateLimiter } from '../src/middleware/login-rate-limit';
import { resetApiRateLimiter } from '../src/middleware/rate-limit';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
const ROOT = path.resolve(__dirname, '../../..');
const PROD = {
  NODE_ENV: 'production', DATABASE_URL: 'postgresql://app:pw@db.internal:5432/hr', CORS_ORIGIN: 'https://hr.example.com',
  PUBLIC_APP_URL: 'https://hr.example.com', DOCUMENT_STORAGE_DIR: '/var/lib/hr/documents', TRUST_PROXY: '1',
} as NodeJS.ProcessEnv;
const errorsOf = (r: ReturnType<typeof parseEnv>) => (r.ok ? [] : r.errors).join(' | ');

describe('runtime mode is explicit (NODE_ENV never defaults)', () => {
  it('missing, blank and unknown values are refused — never read as development', () => {
    const base = { DATABASE_URL: 'postgresql://a@localhost/dev' } as NodeJS.ProcessEnv;
    for (const v of [undefined, '', '  ']) expect(errorsOf(parseEnv({ ...base, NODE_ENV: v }))).toMatch(/NODE_ENV is required/);
    for (const v of ['prod', 'Production', 'PRODUCTION', 'banana', 'dev', 'staging']) expect(errorsOf(parseEnv({ ...base, NODE_ENV: v }))).toMatch(/NODE_ENV must be exactly/);
    expect(errorsOf(parseEnv({ ...base, NODE_ENV: 'development' }))).toBe('');
    expect(errorsOf(parseEnv({ ...PROD }))).toBe('');
  });

  it('a process started without NODE_ENV exits before listening, naming the variable but no value', () => {
    for (const mode of [undefined, 'prod', 'banana']) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['NODE_ENV', 'TEST_DATABASE_URL'].includes(k)));
      const r = spawnSync('npx', ['tsx', '-e', "import('./src/config/env').then(() => console.log('STARTED'))"], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...env, ...(mode ? { NODE_ENV: mode } : {}), ENV_FILE: '/nonexistent', DATABASE_URL: 'postgresql://secret-user:secret-pass@db.internal:5432/hr' },
        encoding: 'utf8',
      });
      const out = `${r.stdout}${r.stderr}`;
      expect(`${mode} ${r.status}`).toBe(`${mode} 1`);
      expect(out).not.toContain('STARTED');
      expect(out).toMatch(/NODE_ENV/);
      expect(out).not.toMatch(/secret-pass|secret-user/);
    }
  }, 60000);

  it('the canonical scripts set the mode explicitly: dev → development, test → test, start → production', () => {
    const scripts = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts.dev).toMatch(/^NODE_ENV=development /);
    expect(scripts.test).toMatch(/NODE_ENV=test vitest/);
    expect(scripts.start).toBe('NODE_ENV=production node dist/server.js');
    // clean-checkout codegen is part of build, typecheck and test — never tribal knowledge
    for (const s of ['build', 'typecheck', 'test']) expect(scripts[s]).toMatch(/^npm run -s codegen && /);
    expect(scripts.codegen).toBe('prisma generate');
  });
});

describe('production configuration fails closed', () => {
  it('TRUST_PROXY must be stated in production; development and test default to off', () => {
    expect(errorsOf(parseEnv({ ...PROD, TRUST_PROXY: undefined }))).toMatch(/TRUST_PROXY is required in production/);
    expect(errorsOf(parseEnv({ ...PROD, TRUST_PROXY: 'off' }))).toBe('');
    const dev = parseEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://a@localhost/dev' });
    expect(dev.ok && dev.value.trustProxy).toEqual({ mode: 'off' });
  });
  it('documents, copilot, cookies, origins and reset URL keep failing closed; errors carry no values', () => {
    expect(errorsOf(parseEnv({ ...PROD, DOCUMENT_STORAGE_DIR: '/private/tmp/docs' }))).toMatch(/temporary path/);
    expect(errorsOf(parseEnv({ ...PROD, COPILOT_ENABLED: 'true', COPILOT_PROVIDER: 'fake', COPILOT_API_KEY: 'k' }))).toMatch(/COPILOT_PROVIDER=fake/);
    expect(errorsOf(parseEnv({ ...PROD, COPILOT_ENABLED: 'true' }))).toMatch(/COPILOT_API_KEY is required/);
    expect(errorsOf(parseEnv({ ...PROD, COPILOT_ENABLED: 'false' }))).toBe('');
    expect(errorsOf(parseEnv({ ...PROD, COOKIE_SECURE: 'false' }))).toMatch(/COOKIE_SECURE/);
    expect(errorsOf(parseEnv({ ...PROD, CORS_ORIGIN: '*' }))).toMatch(/must not be "\*"/);
    expect(errorsOf(parseEnv({ ...PROD, PUBLIC_APP_URL: 'https://u:p@hr.example.com' }))).toMatch(/credentials/);
    const withSecret = errorsOf(parseEnv({ ...PROD, PUBLIC_APP_URL: 'https://u:SuperSecret1@hr.example.com', TRUST_PROXY: 'banana' }));
    expect(withSecret).not.toMatch(/SuperSecret1|banana/);
  });
});

describe('TRUST_PROXY is typed and validated', () => {
  it('accepts off, a hop count 1–10, and proxy IPs / CIDR ranges; refuses "trust everything" and malformed values', () => {
    expect(parseTrustProxy(undefined)).toEqual({ ok: true, value: undefined });
    for (const v of ['off', 'false', '0']) expect(parseTrustProxy(v)).toEqual({ ok: true, value: { mode: 'off' } });
    expect(parseTrustProxy('1')).toEqual({ ok: true, value: { mode: 'hops', hops: 1 } });
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.10,loopback, fd00::/8')).toEqual({ ok: true, value: { mode: 'addresses', addresses: ['10.0.0.0/8', '192.168.1.10', 'loopback', 'fd00::/8'] } });
    for (const bad of ['true', '*', 'all', '-1', '11', '99', 'banana', '10.0.0.0/33', '300.1.1.1', '10.0.0.0/8/1', 'fd00::/129', '1.2.3.4,']) {
      const r = parseTrustProxy(bad);
      if (bad === '1.2.3.4,') expect(r).toEqual({ ok: true, value: { mode: 'addresses', addresses: ['1.2.3.4'] } });
      else expect(`${bad} ${r.ok}`).toBe(`${bad} false`);
    }
  });

  const probe = (setting: string) => {
    const r = parseTrustProxy(setting);
    if (!r.ok || !r.value) throw new Error('bad setting');
    const a = express();
    a.set('trust proxy', expressTrustProxy(r.value));
    a.get('/ip', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
    return a;
  };

  it('A. trust off: a spoofed X-Forwarded-For / -Proto is ignored', async () => {
    const res = await request(probe('off')).get('/ip').set('X-Forwarded-For', '203.0.113.99').set('X-Forwarded-Proto', 'https');
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(res.body.protocol).toBe('http');
  });
  it('B. one trusted hop: the address the proxy appended is the client; https from the proxy is honoured', async () => {
    const res = await request(probe('1')).get('/ip').set('X-Forwarded-For', '198.51.100.7').set('X-Forwarded-Proto', 'https');
    expect(res.body).toEqual({ ip: '198.51.100.7', protocol: 'https' });
  });
  it('C. a client cannot inject its own address in front of the trusted proxy (hop count or proxy address list)', async () => {
    for (const setting of ['1', 'loopback', '127.0.0.1/32']) {
      // "spoofed" is what the client sent; the proxy appended the real client 198.51.100.7
      const res = await request(probe(setting)).get('/ip').set('X-Forwarded-For', '10.9.9.9, spoofed-by-client, 198.51.100.7');
      expect(`${setting} ${res.body.ip}`).toBe(`${setting} 198.51.100.7`);
    }
    // an untrusted peer (the proxy list does not include the socket address) cannot set anything
    const res = await request(probe('10.0.0.0/8')).get('/ip').set('X-Forwarded-For', '198.51.100.7');
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });
});

describe('login throttling under proxy trust', () => {
  beforeAll(async () => {
    await resetDatabase();
    await createUser({ email: 'victim@t46.local', password: PW, role: 'EMPLOYEE' });
  });
  beforeEach(() => { loginRateLimiter.clearAll(); resetApiRateLimiter(); });

  const hammer = async (a: express.Express, xff: (i: number) => string) => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await request(a).post('/api/v1/auth/login').set('X-Forwarded-For', xff(i)).send({ email: 'victim@t46.local', password: 'wrong-password-1' })).status);
    return codes;
  };
  it('trust off: rotating a spoofed X-Forwarded-For does not escape the per-IP limit', async () => {
    const a = createApp();
    a.set('trust proxy', false);
    const codes = await hammer(a, (i) => `203.0.113.${i}`);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
  it('one trusted hop: a client prepending fake addresses is still counted under its real (proxy-appended) address', async () => {
    const a = createApp();
    a.set('trust proxy', 1);
    const codes = await hammer(a, (i) => `10.0.0.${i}, 198.51.100.7`);
    expect(codes.slice(10)).toEqual([429, 429]);
    // a different real client behind the same proxy is not blocked by someone else's failures
    const other = await request(a).post('/api/v1/auth/login').set('X-Forwarded-For', '198.51.100.8').send({ email: 'victim@t46.local', password: 'wrong-password-1' });
    expect(other.status).toBe(401);
  });
  it('behind a trusted https proxy the Secure session cookie is issued and the same-origin check uses https', async () => {
    const a = createApp();
    a.set('trust proxy', 1);
    const res = await request(a).post('/api/v1/auth/login').set('X-Forwarded-For', '198.51.100.9').set('X-Forwarded-Proto', 'https').set('Host', 'hr.proxy.test')
      .send({ email: 'victim@t46.local', password: PW });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    const csrf = res.body.data.csrfToken as string;
    const session = cookie.split(';')[0]!;
    const same = await request(a).post('/api/v1/account/sessions/revoke-others').set('X-Forwarded-For', '198.51.100.9').set('X-Forwarded-Proto', 'https').set('Host', 'hr.proxy.test')
      .set('Origin', 'https://hr.proxy.test').set('Cookie', session).set('x-csrf-token', csrf);
    expect(same.status).toBe(200);
    const foreign = await request(a).post('/api/v1/account/sessions/revoke-others').set('X-Forwarded-For', '198.51.100.9').set('X-Forwarded-Proto', 'https').set('Host', 'hr.proxy.test')
      .set('Origin', 'https://evil.example').set('Cookie', session).set('x-csrf-token', csrf);
    expect(foreign.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
  });
});

describe('API cache policy: every response is no-store', () => {
  let hrAdmin: { cookie: string; csrf: string; user: { id: string } };
  let employee: { cookie: string; csrf: string; user: { id: string } };
  let employeeId: string;
  let documentId: string;
  beforeAll(async () => {
    await resetDatabase();
    const org = await prisma.organization.create({ data: { code: 'T46', name: 'T46 Co', timezone: 'Asia/Bangkok' } });
    const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'D46', name: 'D46' } });
    const job = await prisma.job.create({ data: { code: 'J46', title: 'J46', level: 1 } });
    const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'P46', title: 'P46', jobId: job.id } });
    employeeId = (await prisma.employee.create({ data: { employeeCode: 'E46', firstName: 'E', lastName: 'F', email: 'e46@t46.local', hireDate: new Date('2024-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
    await createUser({ email: 'hradmin@t46.local', password: PW, role: 'HR_ADMIN' });
    await createUser({ email: 'emp@t46.local', password: PW, role: 'EMPLOYEE', employeeId });
    hrAdmin = await loginAs(app, 'hradmin@t46.local', PW);
    employee = await loginAs(app, 'emp@t46.local', PW);
    const cat = await request(app).post('/api/v1/documents/categories').set('Cookie', hrAdmin.cookie).set('x-csrf-token', hrAdmin.csrf).send({ code: 'C46', name: 'C46', defaultClassification: 'EMPLOYEE_PRIVATE' });
    const up = await request(app).post('/api/v1/documents').set('Cookie', hrAdmin.cookie).set('x-csrf-token', hrAdmin.csrf)
      .field('title', 'Contract').field('categoryId', cat.body.data.id).field('ownerEmployeeId', employeeId)
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'contract.pdf', contentType: 'application/pdf' });
    documentId = up.body.data.id;
  }, 60000);
  afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

  const as = (s: { cookie: string; csrf: string }, m: 'get' | 'post', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
  it('authenticated data, personal records, exports and downloads are never cacheable; probes and errors too', async () => {
    const cases: [string, request.Test, number][] = [
      ['auth/me', as(employee, 'get', '/api/v1/auth/me'), 200],
      ['employee detail', as(hrAdmin, 'get', `/api/v1/employees/${employeeId}`), 200],
      ['my payslips', as(employee, 'get', '/api/v1/payroll/payslips/me'), 200],
      ['payslip detail', as(employee, 'get', '/api/v1/payroll/payslips/me/nope'), 404],
      ['HR letters', as(employee, 'get', '/api/v1/employee-services/letters'), 200],
      ['my benefits', as(employee, 'get', '/api/v1/benefits/my'), 200],
      ['my expenses', as(employee, 'get', '/api/v1/expense/my'), 200],
      ['privacy export', as(hrAdmin, 'post', `/api/v1/privacy/employees/${employeeId}/export`), 200],
      ['document download', as(employee, 'get', `/api/v1/documents/${documentId}/download`), 200],
      ['health', request(app).get('/api/v1/health/live'), 200],
      ['unauthenticated', request(app).get('/api/v1/auth/me'), 401],
      ['unknown route', request(app).get('/api/v1/nope'), 404],
    ];
    for (const [label, req, status] of cases) {
      const res = await req;
      expect(`${label} ${res.status}`).toBe(`${label} ${status}`);
      expect(`${label} ${res.headers['cache-control']}`).toMatch(new RegExp(`^${label} (private, )?no-store$`));
      expect(res.headers.etag).toBeUndefined();
    }
    const download = await as(employee, 'get', `/api/v1/documents/${documentId}/download`);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="contract\.pdf"/);
    expect(download.headers['content-security-policy']).toMatch(/sandbox/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  it('no development, test, seed or debug route exists in the API', async () => {
    for (const p of ['/api/v1/test/reset', '/api/v1/dev/login', '/api/v1/seed', '/api/v1/debug', '/api/v1/__test__', '/api/v1/admin/seed']) {
      for (const m of ['get', 'post'] as const) expect(`${m} ${p} ${(await as(hrAdmin, m, p)).status}`).toBe(`${m} ${p} 404`);
    }
  });
});

describe('web delivery contract (reference proxy configurations)', () => {
  const contract = JSON.parse(readFileSync(path.join(ROOT, 'deploy/security-headers.json'), 'utf8'));
  const apache = readFileSync(path.join(ROOT, 'deploy/apache/hr-platform-site.conf'), 'utf8') + readFileSync(path.join(ROOT, 'deploy/apache/hr-platform.conf'), 'utf8');
  const nginx = readFileSync(path.join(ROOT, 'deploy/nginx/security-headers.conf'), 'utf8') + readFileSync(path.join(ROOT, 'deploy/nginx/hr-platform.conf'), 'utf8');
  it('both reference proxies set exactly the contract values, HSTS only on the TLS server, and the cache split', () => {
    for (const [name, value] of Object.entries({ ...contract.web, ...contract.tlsOnly }) as [string, string][]) {
      expect(apache).toContain(`Header always set ${name} "${value}"`);
      expect(nginx).toContain(`add_header ${name} "${value}" always;`);
    }
    for (const conf of [apache, nginx]) {
      expect(conf).toContain(contract.cache.hashedAssets);
      expect(conf).toContain(`"${contract.cache.html}"`);
      expect(conf).not.toMatch(/unsafe-eval|unsafe-inline|script-src[^;]*\*|default-src \*/);
    }
    expect(apache).toMatch(/<VirtualHost \*:443>[\s\S]*Strict-Transport-Security[\s\S]*<\/VirtualHost>/);
    // exactly one HSTS header on proxied API responses (the API sends the same value in production)
    expect(apache).toContain('Header onsuccess unset Strict-Transport-Security');
    expect(nginx).toContain('proxy_hide_header Strict-Transport-Security;');
    // hashed assets immutable, a missing asset is a 404 (never the HTML shell), client routes fall back to index.html
    expect(apache).toMatch(/RewriteCond %\{REQUEST_URI\} !\^\/assets\//);
    expect(nginx).toMatch(/location \^~ \/assets\/ \{[\s\S]*try_files \$uri =404;/);
    expect(apache.split('<VirtualHost *:80>')[1]!.split('</VirtualHost>')[0]).not.toContain('Strict-Transport-Security');
  });
  it('the web build publishes no source maps', () => {
    expect(readFileSync(path.join(ROOT, 'apps/web/vite.config.ts'), 'utf8')).toMatch(/sourcemap: false/);
  });
});
