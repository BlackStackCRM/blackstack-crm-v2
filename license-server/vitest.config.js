import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**'],
    pool: 'forks',
    testTimeout: 60000,
    hookTimeout: 60000,
    environment: 'node',
    globals: true,
  },
});
