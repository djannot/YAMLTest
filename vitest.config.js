import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Run each test *file* sequentially to avoid port collisions between
    // integration/e2e servers and to keep CJS module isolation predictable.
    fileParallelism: false,
    pool: 'threads',
    // Generous timeouts to accommodate:
    //   - kind cluster creation + node:slim image load (~90s)
    //   - kubectl debug ephemeral container startup (~30s)
    //   - kubectl port-forward setup (~5s)
    testTimeout: 120_000,
    hookTimeout: 210_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**'],
    },
    include: ['test/**/*.test.js'],
  },
});
