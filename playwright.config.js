const { defineConfig, devices } = require('@playwright/test');
const { isProductionPort } = require('./scripts/assert-e2e-isolation');

// PHASE 3A.1 — this config used to pin baseURL to http://localhost:3000. On
// 2026-10-08 that pointed the browser at a long-running process backed onto the
// LIVE production database, and the inventory E2E suite wrote 20 vouchers, 3
// journal entries, 3 stock-ledger rows and 27 login audit rows into production.
//
// The target is now derived from E2E_PORT and the config REFUSES TO LOAD on a
// production port, so a stale `npx playwright test` can no longer silently aim at
// the real server. Unattended runs should use playwright.e2e.config.js, which
// already defaults to an isolated port.
const E2E_PORT = Number(process.env.E2E_PORT || 3199);
if (isProductionPort(E2E_PORT)) {
  throw new Error(
    `REFUSING TO RUN: E2E_PORT=${E2E_PORT} is a reserved PRODUCTION port. `
    + 'This config will not aim a browser at the live server. Set E2E_PORT to a '
    + 'free test port (e.g. 3199), or use playwright.e2e.config.js.',
  );
}

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 300000, // 5 minutes per test
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    headless: false, // Visible browser — user wants to watch
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15000,
    navigationTimeout: 15000,
    slowMo: 500, // 500ms delay after every action — visible to the human eye
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu-sandbox',
            '--disable-setuid-sandbox',
          ],
        },
      },
    },
  ],
  // Ensure tests run sequentially within the single worker
  fullyParallel: false,
  // Retry once on failure to handle transient Chrome issues
  retries: 0,
  // Output directories — use fresh dir to avoid locked files from crashed runs
  outputDir: 'test-results-new/',
  // snapshotDir: undefined,
});
