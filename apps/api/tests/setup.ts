// Runs before every test file. NODE_ENV=test makes src/config/env.ts require TEST_DATABASE_URL (a dedicated
// PostgreSQL database, never DATABASE_URL); the `test` npm script resets that database first (scripts/reset-test-db.ts).
process.env.NODE_ENV = 'test';

// Login rate-limiter state is in-memory per process; reset it before every test so no test
// (or file, when the worker is reused) can inherit failed-login counts from another.
import { beforeEach } from 'vitest';
import { loginRateLimiter } from '../src/middleware/login-rate-limit';
beforeEach(() => loginRateLimiter.clearAll());
