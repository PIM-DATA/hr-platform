import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Tests share one SQLite file, so run files sequentially to avoid write locks.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
