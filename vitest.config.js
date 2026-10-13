import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['license-server/**', 'node_modules/**', 'tests/e2e/**', 'tests/playwright/**'],
    pool: 'forks',
    testTimeout: 300000,
    hookTimeout: 300000,
    environment: 'node',
    globals: true,
  },
});
