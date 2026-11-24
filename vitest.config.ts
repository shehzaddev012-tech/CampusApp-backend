import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests share one real PostgreSQL database, so files run one after another.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    globalSetup: ['test/globalSetup.ts'],
  },
});
