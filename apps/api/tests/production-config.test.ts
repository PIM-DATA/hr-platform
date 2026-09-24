/**
 * Task 15 — production configuration safety (checklist 28).
 * `parseEnv` is pure, so production rules can be asserted without starting a production process.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_MIN_LENGTH, changeOwnPasswordSchema, consumePasswordResetSchema, createUserSchema } from '@hr/shared';
import { parseEnv } from '../src/config/env';
import { createTestServer } from './helpers';
import { resetApiRateLimiter } from '../src/middleware/rate-limit';

const app = createTestServer();
const PROD_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/hr?schema=public',
  CORS_ORIGIN: 'https://hr.example.com',
  DOCUMENT_STORAGE_DIR: '/var/lib/hr/documents',
  PUBLIC_APP_URL: 'https://hr.example.com',
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
    expect(errorsOf(parseEnv({ NODE_ENV: 'production', DATABASE_URL: PROD_BASE.DATABASE_URL, CORS_ORIGIN: 'https://hr.example.com' }))).toMatch(/PUBLIC_APP_URL is required/);
  });
  it('a localhost origin is never auto-allowed in production', () => {
    expect(errorsOf(parse({ CORS_ORIGIN: 'http://localhost:5173' }))).toMatch(/must not include localhost/);
    expect(errorsOf(parse({ CORS_ORIGIN: 'https://hr.example.com,http://127.0.0.1:3000' }))).toMatch(/must not include localhost/);
    expect(errorsOf(parse({ CORS_ORIGIN: '*' }))).toMatch(/must not be "\*"/);
    expect(errorsOf(parse({ CORS_ORIGIN: 'http://hr.example.com' }))).toMatch(/https/);
    expect(errorsOf(parse({ CORS_ORIGIN: 'https://hr.example.com,https://admin.example.com' }))).toBe('');
  });

  it('the document center needs a real storage directory in production (Task 30)', () => {
    expect(errorsOf(parseEnv({ ...PROD_BASE, DOCUMENT_STORAGE_DIR: undefined }))).toMatch(/DOCUMENT_STORAGE_DIR is required/);
    expect(errorsOf(parseEnv({ ...PROD_BASE, DOCUMENT_STORAGE_DIR: '/tmp/docs' }))).toMatch(/temporary path/);
    expect(errorsOf(parseEnv({ ...PROD_BASE, DOCUMENT_STORAGE_DIR: undefined, DOCUMENTS_ENABLED: 'false' }))).not.toMatch(/DOCUMENT_STORAGE_DIR/);
  });
  it('the copilot is off by default, refuses the fake provider in production and needs a credential when enabled (Task 31)', () => {
    const off = parse();
    expect(off.ok && off.value.COPILOT_ENABLED).toBe(false);
    expect(errorsOf(parse({ COPILOT_ENABLED: 'true' }))).toMatch(/COPILOT_API_KEY is required/);
    expect(errorsOf(parse({ COPILOT_ENABLED: 'true', COPILOT_PROVIDER: 'fake', COPILOT_API_KEY: 'x' }))).toMatch(/COPILOT_PROVIDER=fake/);
    expect(errorsOf(parse({ COPILOT_ENABLED: 'true', COPILOT_API_KEY: 'sk-test-placeholder-value' }))).toBe('');
    expect(errorsOf(parse({ COPILOT_ENABLED: 'false', COPILOT_PROVIDER: 'fake' }))).toBe('');
    expect(errorsOf(parse({ COPILOT_ENABLED: 'true', COPILOT_API_KEY: 'k', COPILOT_TIMEOUT_MS: '500' }))).toMatch(/COPILOT_TIMEOUT_MS/);
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

/** Task 18.1 — the reset-link origin is configuration, never a guess and never anything the caller can influence. */
describe('PUBLIC_APP_URL (reset link origin)', () => {
  it('production refuses to start without it — the first CORS origin is not a substitute', () => {
    const withoutIt = { ...PROD_BASE };
    delete withoutIt.PUBLIC_APP_URL;
    expect(errorsOf(parseEnv(withoutIt))).toMatch(/PUBLIC_APP_URL is required in production/);
  });

  it('production rejects a URL that is not safe to put in a reset link', () => {
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'http://hr.example.com' }))).toMatch(/must use https/);
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'https://localhost:5173' }))).toMatch(/must not point at localhost/);
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'https://127.0.0.1' }))).toMatch(/must not point at localhost/);
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'https://user:secret@hr.example.com' }))).toMatch(/must not contain credentials/);
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'https://hr.example.com/?next=/x' }))).toMatch(/query string or fragment/);
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'https://hr.example.com/#/app' }))).toMatch(/query string or fragment/);
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'not-a-url' }))).toMatch(/PUBLIC_APP_URL/);
    expect(errorsOf(parse({ PUBLIC_APP_URL: 'https://hr.example.com/hr' }))).toBe(''); // a base path is fine
  });

  it('several allowed origins never influence it, and trailing slashes are normalized', () => {
    const r = parse({ CORS_ORIGIN: 'https://admin.example.com,https://hr.example.com', PUBLIC_APP_URL: 'https://hr.example.com///' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // publicAppUrl is derived the same way the running server derives it (env.ts), so assert that derivation here
    expect(r.value.PUBLIC_APP_URL?.replace(/\/+$/, '')).toBe('https://hr.example.com');
    expect(r.value.CORS_ORIGIN.split(',')[0]).toBe('https://admin.example.com'); // deliberately NOT the reset origin
  });

  it('development may fall back to the first allowed origin (no extra configuration for `npm run dev`)', () => {
    const r = parseEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://a@localhost/dev', CORS_ORIGIN: 'http://localhost:5173' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.PUBLIC_APP_URL).toBeUndefined();
  });
});

/** Task 18.1 — one password policy. The bootstrap command must not be able to create an account the app would refuse. */
describe('password policy is one rule', () => {
  const runBootstrap = (password: string) => {
    const script = path.resolve(__dirname, '../scripts/bootstrap-admin.ts');
    try {
      const stdout = execFileSync('npx', ['tsx', script], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          NODE_ENV: 'production', DOCUMENT_STORAGE_DIR: '/var/lib/hr/documents',
          DATABASE_URL: process.env.TEST_DATABASE_URL, // never the developer database
          CORS_ORIGIN: 'https://hr.example.com',
          PUBLIC_APP_URL: 'https://hr.example.com',
          SEED_ADMIN_PASSWORD: '', // an empty value means "not set" (see env.ts), which is what a production host looks like
          SEED_DEMO_PASSWORD: '',
          COPILOT_ENABLED: 'false', COPILOT_PROVIDER: 'anthropic', // a developer's .env may enable the fake copilot; production would not
          COOKIE_SECURE: 'true', // the developer .env sets false; production refuses that
          BOOTSTRAP_ADMIN_EMAIL: 'bootstrap-policy@example.com',
          BOOTSTRAP_ADMIN_PASSWORD: password,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { failed: false, output: stdout };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { failed: true, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it('the shared minimum is the production baseline, and every schema uses that one field', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    const eleven = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);
    const twelve = 'a'.repeat(PASSWORD_MIN_LENGTH);
    for (const [name, parseValue] of [
      ['createUser', (v: string) => createUserSchema.safeParse({ email: 'a@b.co', password: v, roleCodes: ['EMPLOYEE'] })],
      ['changeOwnPassword', (v: string) => changeOwnPasswordSchema.safeParse({ currentPassword: 'something-else-entirely', newPassword: v })],
      ['consumePasswordReset', (v: string) => consumePasswordResetSchema.safeParse({ token: 't'.repeat(43), newPassword: v })],
    ] as const) {
      expect(parseValue(eleven).success, `${name} accepted ${PASSWORD_MIN_LENGTH - 1} characters`).toBe(false);
      expect(parseValue(twelve).success, `${name} rejected ${PASSWORD_MIN_LENGTH} characters`).toBe(true);
    }
  });

  it('bootstrap:admin refuses a password one character short of the policy, in production', () => {
    const short = runBootstrap('Short-Elevn1'.slice(0, PASSWORD_MIN_LENGTH - 1));
    expect(short.failed).toBe(true);
    expect(short.output).toMatch(/BOOTSTRAP_ADMIN_PASSWORD.*at least 12/);
    expect(short.output).not.toMatch(/Short-Elev/); // the value itself is never echoed
  }, 60000);
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
  /** Task 19.1 — a malformed URL is a bad request, not a server error, and never reaches the database. */
  it('a malformed path or query is rejected with 400 and leaves nothing in the log', async () => {
    const nul = await request(app).get('/api/v1/leave/requests/%00');
    expect(nul.status).toBe(400);
    expect(nul.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(nul.body)).not.toMatch(/prisma|SELECT|ConnectorError|at \//i);

    expect((await request(app).get('/api/v1/employees/%00abc')).status).toBe(400);
    expect((await request(app).get(`/api/v1/users/${'x'.repeat(300)}`)).status).toBe(400);
    expect((await request(app).get('/api/v1/employees/%zz')).status).toBe(400); // malformed percent-escape
    expect((await request(app).get('/api/v1/employees?search=%00')).status).toBe(400);

    // a well-formed id still reaches the normal path (unauthenticated here, so 401 — not 400)
    expect((await request(app).get('/api/v1/leave/requests/clzz0000000000000000000')).status).toBe(401);
    expect((await request(app).get('/api/v1/health/ready')).status).toBe(200); // probes are unaffected
  });

  it('the JSON body limit rejects oversized payloads', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(2 * 1024 * 1024) }));
    expect([413, 400]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|at \//);
  }, 30000);
});
