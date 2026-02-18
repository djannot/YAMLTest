import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Run each test *file* sequentially to avoid port collisions between
    // integration/e2e servers and to keep CJS module isolation predictable.
    fileParallelism: false,
    pool: 'threads',
    testTimeout: 20000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**'],
    },
    include: ['test/**/*.test.js'],
  },
});
