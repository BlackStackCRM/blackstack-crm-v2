/**
 * Playwright config for running the browser E2E suites against a test server.
 *
 * The project's own playwright.config.js pins baseURL to :3000 and headless to
 * false (visible browser), which cannot run unattended. This config reuses the
 * same suites and selectors but points at a disposable server/DB and runs
 * headless, so inventory and billing E2E coverage can actually be verified.
 *
 *   node scripts/run-e2e.js [port] [dbPath] [suite...]
 */
const { defineConfig, devices } = require('@playwright/test');

const port = process.env.E2E_PORT || '3199';
const baseURL = `http://localhost:${port}`;

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  reporter: [['list']],
  use: {
    baseURL,
    // Default headless for unattended runs. Set E2E_HEADLESS=false to watch it in
    // a real browser window — the Phase 6 requirement is a VISIBLE browser, and
    // making that a flag keeps one config serving both cases.
    headless: process.env.E2E_HEADLESS !== 'false',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20000,
    navigationTimeout: 20000,
    ignoreHTTPSErrors: true,
    slowMo: Number(process.env.E2E_SLOWMO || 0),
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: process.env.E2E_HEADLESS !== 'false',
        launchOptions: {
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox'],
        },
      },
    },
  ],
  fullyParallel: false,
  retries: 0,
  outputDir: 'test-results-e2e/',
});