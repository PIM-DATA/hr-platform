import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load apps/api/.env (same file the Prisma CLI reads). ENV_FILE points elsewhere — a production install keeping its
// configuration outside the repo, or a smoke run that must not inherit developer values. Real process environment
// variables always win: dotenv never overwrites what the platform already set.
dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(__dirname, '../../.env') });

/**
 * An env file that carries a key with no value (`SEED_ADMIN_PASSWORD=`) means "not set", not "set to the empty
 * string" — treating it literally makes an optional variable fail validation for a reason nobody can act on.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  /** Dedicated PostgreSQL test database. Required when NODE_ENV=test; must differ from DATABASE_URL. */
  TEST_DATABASE_URL: optional(z.string().min(1)),
  /** Browser origin(s) allowed to call the API, comma-separated. Production requires explicit https origins. */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * Reverse-proxy hops to trust for req.ip / req.protocol (Express `trust proxy`).
   * 0 = trust nothing (direct exposure), 1 = one proxy in front (the usual platform setup).
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  /** Modest global API limit per IP per minute; the login limiter is much stricter. 0 disables it. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(600),
  /** JSON body cap. There are no uploads in this phase, so requests stay small. */
  JSON_BODY_LIMIT: z.string().default('1mb'),
  /** Document center: where the local storage adapter keeps file bytes. Required in production when documents are enabled. */
  /** `z.coerce.boolean()` would read the string "false" as true; parse the words explicitly. */
  DOCUMENTS_ENABLED: z.preprocess((v) => (v === undefined || v === '' ? true : v === true || v === 'true' || v === '1' ? true : v === false || v === 'false' || v === '0' ? false : v), z.boolean()),
  DOCUMENT_STORAGE_DIR: optional(z.string().min(1)),
  DOCUMENT_MAX_FILE_MB: z.coerce.number().int().min(1).max(500).default(20),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /** Optional build marker (commit SHA or release tag) surfaced on /health. Never required. */
  APP_VERSION: optional(z.string()),
  /**
   * Public URL of the web application, used to build password-reset links. Never derived from the Host header:
   * a forged Host would otherwise send a working reset link to an attacker's domain. REQUIRED in production —
   * falling back to the first CORS origin there guesses which of several allowed origins a person should be sent to,
   * and a guess in a password-reset link is not acceptable. Development may fall back (see `publicAppUrl`).
   */
  PUBLIC_APP_URL: optional(z.string().url()),
  /** How long an admin-issued password reset link stays valid. */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /**
   * Development seed credentials. These are the ONE explicit exception to the shared password policy
   * (`PASSWORD_MIN_LENGTH`, 12): they only ever create accounts through `npm run db:seed`, which refuses to run in
   * production, and production rejects them outright below. Nothing a person sets through the application is covered
   * by this exception.
   */
  SEED_ADMIN_EMAIL: optional(z.string().email()),
  SEED_ADMIN_PASSWORD: optional(z.string().min(8)),
  SEED_DEMO_PASSWORD: optional(z.string().min(8)),
});

/** Values that are fine locally but must never be accepted by a production process. */
const DEV_PLACEHOLDER_SECRETS = ['change-me-locally', 'changeme', 'password', 'secret', 'demo', 'test1234'];
const isLocalOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(origin.trim());
const safeUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};
/** Trailing slashes are stripped so `${publicAppUrl}/reset-password` never produces a double slash. */
const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '');

export function parseEnv(source: NodeJS.ProcessEnv): { ok: true; value: z.infer<typeof envSchema> } | { ok: false; errors: string[] } {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    return { ok: false, errors: Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => `${k}: ${v?.join(', ')}`) };
  }
  const value = parsed.data;
  const errors: string[] = [];

  if (value.NODE_ENV === 'production') {
    // Fail fast: production never falls back to development defaults.
    if (!source.DATABASE_URL) errors.push('DATABASE_URL is required in production');
    if (value.DOCUMENTS_ENABLED && !source.DOCUMENT_STORAGE_DIR) errors.push('DOCUMENT_STORAGE_DIR is required in production while the document center is enabled (set DOCUMENTS_ENABLED=false to disable it)');
    if (source.DOCUMENT_STORAGE_DIR && /^\/(tmp|var\/tmp|dev\/shm)(\/|$)/.test(source.DOCUMENT_STORAGE_DIR)) errors.push('DOCUMENT_STORAGE_DIR must not be a temporary path in production');
    if (!source.CORS_ORIGIN) errors.push('CORS_ORIGIN is required in production (the browser origin that serves the app)');
    else {
      const origins = value.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
      if (!origins.length) errors.push('CORS_ORIGIN must list at least one origin in production');
      if (origins.some(isLocalOrigin)) errors.push('CORS_ORIGIN must not include localhost in production');
      if (origins.some((o) => o === '*')) errors.push('CORS_ORIGIN must not be "*" — the API uses credentialed cookies');
      if (origins.some((o) => !o.startsWith('https://'))) errors.push('CORS_ORIGIN must use https:// in production (HTTPS is terminated by the proxy)');
    }
    // Demo/bootstrap credentials belong to development only; production bootstraps an admin with an explicit command.
    if (source.SEED_DEMO_PASSWORD) errors.push('SEED_DEMO_PASSWORD must not be set in production (demo accounts are development-only)');
    for (const [name, secret] of [['SEED_ADMIN_PASSWORD', value.SEED_ADMIN_PASSWORD]] as const) {
      if (secret && DEV_PLACEHOLDER_SECRETS.includes(secret.toLowerCase())) errors.push(`${name} is a development placeholder and cannot be used in production`);
    }
    if (source.COOKIE_SECURE === 'false') errors.push('COOKIE_SECURE cannot be false in production (session cookies must be Secure)');
    // Reset links must point somewhere the operator chose deliberately — never at "whichever CORS origin came first".
    if (!source.PUBLIC_APP_URL) errors.push('PUBLIC_APP_URL is required in production (the https URL users open; reset links are built from it)');
    else {
      const url = safeUrl(value.PUBLIC_APP_URL ?? source.PUBLIC_APP_URL);
      if (!url) errors.push('PUBLIC_APP_URL is not a valid URL');
      else {
        if (url.protocol !== 'https:') errors.push('PUBLIC_APP_URL must use https:// in production');
        if (url.username || url.password) errors.push('PUBLIC_APP_URL must not contain credentials');
        if (url.search || url.hash) errors.push('PUBLIC_APP_URL must not contain a query string or fragment (the reset token is appended to it)');
        if (isLocalOrigin(url.origin)) errors.push('PUBLIC_APP_URL must not point at localhost in production');
      }
    }
  }

  // The test suite wipes every table, so it may only ever point at TEST_DATABASE_URL — never at the dev database.
  if (value.NODE_ENV === 'test') {
    if (!value.TEST_DATABASE_URL) errors.push('NODE_ENV=test requires TEST_DATABASE_URL (a dedicated PostgreSQL database); it never falls back to DATABASE_URL');
    else if (value.TEST_DATABASE_URL === value.DATABASE_URL) errors.push('TEST_DATABASE_URL must not equal DATABASE_URL: tests reset the whole database');
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

const result = parseEnv(process.env);
if (!result.ok) {
  // Names and reasons only — never the values themselves.
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration (${process.env.NODE_ENV ?? 'development'}):\n  - ${result.errors.join('\n  - ')}`);
  process.exit(1);
}
const data = result.value;

/** True when a production process talks to a database on the same host — legitimate for a single-VM install, worth saying out loud. */
export const databaseIsLocal = /(^|@)(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(data.DATABASE_URL);

export const env = {
  ...data,
  /** The connection the process actually uses: TEST_DATABASE_URL under NODE_ENV=test, DATABASE_URL otherwise. */
  databaseUrl: data.NODE_ENV === 'test' ? (data.TEST_DATABASE_URL as string) : data.DATABASE_URL,
  isProduction: data.NODE_ENV === 'production',
  isTest: data.NODE_ENV === 'test',
  isDevelopment: data.NODE_ENV === 'development',
  /** Session cookies are always Secure in production, regardless of COOKIE_SECURE. */
  cookieSecure: data.NODE_ENV === 'production' || data.COOKIE_SECURE,
  /** Allowed browser origins (comma-separated in CORS_ORIGIN). */
  allowedOrigins: data.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
  /**
   * Base URL for links the server generates (password resets). PUBLIC_APP_URL always in production, where it is
   * required; development may fall back to the first allowed origin so `npm run dev` needs no extra configuration.
   * Never the request's Host header, whatever the environment.
   */
  publicAppUrl: normalizeBaseUrl(data.PUBLIC_APP_URL ?? data.CORS_ORIGIN.split(',')[0] ?? ''),
};
export type Env = typeof env;
