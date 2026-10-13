/**
 * Playwright config for the FULL-SOFTWARE E2E suite.
 *
 * PHASE 4. Deliberately a separate config rather than a change to
 * playwright.e2e.config.js: that config has `testDir: './tests'` and is used by
 * release-gate.js for gates 7 and 8 (the inventory and reverse-order suites).
 * Narrowing or repointing it would change what the release gate executes, which
 * the task forbids. So the full-suite config points at tests/e2e and leaves the
 * gate's config untouched.
 *
 * Browser visibility: HEADED by default, because the requirement is a visible
 * browser for ordinary local runs. CI sets E2E_HEADLESS=true to run unattended.
 *
 *   node scripts/run-e2e-full.js                # full suite, headed
 *   E2E_HEADLESS=true node scripts/run-e2e-full.js   # CI / unattended
 */
const { defineConfig, devices } = require('@playwright/test');

const port = process.env.E2E_PORT || '3199';
const baseURL = `http://localhost:${port}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  // Serial: every module test shares ONE authenticated page and one disposable
  // database. Parallel workers would race on the same mutable records, which is
  // exactly the class of flakiness this project has already suffered.
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 20000 },
  reporter: [['list']],
  outputDir: 'test-results-e2e-full/',
  use: {
    baseURL,
    // Default VISIBLE. CI overrides with E2E_HEADLESS=true.
    headless: process.env.E2E_HEADLESS === 'true',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20000,
    navigationTimeout: 30000,
    ignoreHTTPSErrors: true,
    // Artefacts on failure — the task requires diagnosable failures.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    slowMo: Number(process.env.E2E_SLOWMO || 0),
  },
  projects: [
    {
      name: 'full-app',
      use: {
        ...devices['Desktop Chrome'],
        headless: process.env.E2E_HEADLESS === 'true',
        launchOptions: {
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox'],
        },
      },
    },
  ],
  retries: 0,
});