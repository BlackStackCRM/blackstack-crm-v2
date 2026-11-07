import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['license-server/**', 'node_modules/**', 'tests/e2e/**', 'tests/playwright/**',
      // Browser suites require the isolated Playwright harness and its
      // E2E_PORT/DB_PATH contract; they are run by npm run test:e2e.
      'tests/**/*.e2e.test.js',
      // These files use Node's built-in test runner and are invoked by
      // `npm run test:native`, not collected by Vitest.
      'tests/audit-opening-balance.test.js',
      'tests/create-ledger-account.regression.test.js',
      'tests/update-account-is-group.test.js',
      'tests/first-user-setup.test.js',
      'tests/accounting-complete.test.js',
      'tests/accounting-e2e.test.js',
      'tests/tax-gst.test.js'
    ],
    pool: 'forks',
    testTimeout: 300000,
    hookTimeout: 300000,
    environment: 'node',
    globals: true,
  },
});
