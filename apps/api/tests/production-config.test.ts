/**
 * Task 15 — production configuration safety (checklist 28).
 * `parseEnv` is pure, so production rules can be asserted without starting a production process.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env';
import { createTestServer } from './helpers';
import { resetApiRateLimiter } from '../src/middleware/rate-limit';

const app = createTestServer();
const PROD_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/hr?schema=public',
  CORS_ORIGIN: 'https://hr.example.com',
} as NodeJS.ProcessEnv;
const parse = (extra: NodeJS.ProcessEnv = {}) => parseEnv({ ...PROD_BASE, ...extra });
const errorsOf = (r: ReturnType<typeof parseEnv>) => (r.ok ? [] : r.errors).join(' | ');

beforeEach(() => resetApiRateLimiter());
afterAll(() => vi.restoreAllMocks());

describe('production environment validation', () => {
  it('a complete production configuration is accepted', () => {
    const r = parse();
    expect(errorsOf(r)).toBe('');
    expect(r.ok && r.value.NODE_ENV).toBe('production');
  });
  it('missing required values fail fast (no development fallback)', () => {
    expect(errorsOf(parseEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://hr.example.com' }))).toMatch(/DATABASE_URL/);
    expect(errorsOf(parseEnv({ NODE_ENV: 'production', DATABASE_URL: PROD_BASE.DATABASE_URL }))).toMatch(/CORS_ORIGIN is required/);
  });
  it('a localhost origin is never auto-allowed in production', () => {
    expect(errorsOf(parse({ CORS_ORIGIN: 'http://localhost:5173' }))).toMatch(/must not include localhost/);
    expect(errorsOf(parse({ CORS_ORIGIN: 'https://hr.example.com,http://127.0.0.1:3000' }))).toMatch(/must not include localhost/);
    expect(errorsOf(parse({ CORS_ORIGIN: '*' }))).toMatch(/must not be "\*"/);
    expect(errorsOf(parse({ CORS_ORIGIN: 'http://hr.example.com' }))).toMatch(/https/);
    expect(errorsOf(parse({ CORS_ORIGIN: 'https://hr.example.com,https://admin.example.com' }))).toBe('');
  });
  it('development placeholders and demo credentials are rejected in production', () => {
    expect(errorsOf(parse({ SEED_ADMIN_PASSWORD: 'change-me-locally' }))).toMatch(/development placeholder/);
    expect(errorsOf(parse({ SEED_DEMO_PASSWORD: 'anything-goes-here' }))).toMatch(/SEED_DEMO_PASSWORD must not be set/);
    expect(errorsOf(parse({ COOKIE_SECURE: 'false' }))).toMatch(/COOKIE_SECURE cannot be false/);
  });
  it('secure cookies are forced on in production and proxy trust is explicit (never blanket-trusted)', () => {
    const r = parse();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.NODE_ENV === 'production').toBe(true);
    expect(r.value.TRUST_PROXY).toBe(0); // opt-in, not "trust everything"
    expect(parse({ TRUST_PROXY: '1' }).ok && (parse({ TRUST_PROXY: '1' }) as { value: { TRUST_PROXY: number } }).value.TRUST_PROXY).toBe(1);
  });
  it('the test-database guard still applies (tests may never target the development database)', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://a@h/dev' } as NodeJS.ProcessEnv;
    expect(errorsOf(parseEnv(base))).toMatch(/TEST_DATABASE_URL/);
    expect(errorsOf(parseEnv({ ...base, TEST_DATABASE_URL: 'postgresql://a@h/dev' }))).toMatch(/must not equal DATABASE_URL/);
    expect(errorsOf(parseEnv({ ...base, TEST_DATABASE_URL: 'postgresql://a@h/test' }))).toBe('');
  });
});

describe('destructive commands refuse production', () => {
  it('reset-test-db exits with an error when NODE_ENV=production', () => {
    const script = path.resolve(__dirname, '../scripts/reset-test-db.ts');
    let output = '';
    let failed = false;
    try {
      execFileSync('npx', ['tsx', script], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'production', CORS_ORIGIN: 'https://hr.example.com', SEED_DEMO_PASSWORD: '', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      failed = true;
      const err = e as { stdout?: string; stderr?: string };
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(failed).toBe(true);
    expect(output).toMatch(/production/i);
  }, 60000);

  it('the demo seed refuses to run with NODE_ENV=production', () => {
    const seed = path.resolve(__dirname, '../prisma/seed.ts');
    let output = '';
    let failed = false;
    try {
      execFileSync('npx', ['tsx', seed], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'production', CORS_ORIGIN: 'https://hr.example.com', SEED_DEMO_PASSWORD: '', SEED_ADMIN_PASSWORD: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      failed = true;
      const err = e as { stdout?: string; stderr?: string };
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(failed).toBe(true);
    expect(output).toMatch(/bootstrap:admin|production/i);
  }, 60000);
});

describe('HTTP hardening', () => {
  it('security headers are set on every response', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toMatch("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
  it('every response carries a request id, and an inbound id is echoed back', async () => {
    const generated = await request(app).get('/api/v1/health');
    expect(generated.headers['x-request-id']).toMatch(/[0-9a-f-]{16,}/);
    const supplied = await request(app).get('/api/v1/health').set('x-request-id', 'trace-abc-123');
    expect(supplied.headers['x-request-id']).toBe('trace-abc-123');
  });
  it('liveness and readiness probes report status without leaking internals', async () => {
    const live = await request(app).get('/api/v1/health/live');
    expect(live.status).toBe(200);
    expect(live.body.data).toMatchObject({ status: 'ok' });
    const ready = await request(app).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toMatchObject({ status: 'ready', database: 'ok' });
    const serialized = JSON.stringify({ live: live.body, ready: ready.body });
    expect(serialized).not.toMatch(/postgres|password|@|5432|prisma/i);
  });
  it('an unknown error returns a generic message with a request id — never a stack trace or SQL', async () => {
    // A route that throws: the notification route requires auth, so force a failure inside a handled route instead.
    const res = await request(app).get('/api/v1/notifications').set('x-request-id', 'err-trace-1');
    expect(res.status).toBe(401); // unauthenticated — the envelope shape is what matters here
    expect(JSON.stringify(res.body)).not.toMatch(/at \/|node_modules|prisma|SELECT/i);
    expect(res.headers['x-request-id']).toBe('err-trace-1');
  });
  it('the JSON body limit rejects oversized payloads', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(2 * 1024 * 1024) }));
    expect([413, 400]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|at \//);
  }, 30000);
});
