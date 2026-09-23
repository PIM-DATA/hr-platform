import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Tests run against the shared SOURCE. packages/shared/package.json points `main` at dist for the compiled
  // production server, and a stale dist would otherwise silently shadow new shared code in tests.
  resolve: { alias: { '@hr/shared': path.resolve(here, '../../packages/shared/src/index.ts') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Every file resets the same PostgreSQL test database, so files must run one at a time.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
