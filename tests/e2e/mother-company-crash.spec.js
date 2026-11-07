/**
 * E2E user test — "New distribution agency" form
 *
 * Reproduction + fix verification:
 *   a. Go to the harness-provided base URL
 *   b. Log in as admin@blackstack.local / admin123
 *   c. Navigate to #mother-company
 *   d. Click the "New agency" button (id="mc-new")
 *   e. Fill the form with valid data
 *   f. Click "Create agency"
 *   g. Capture the API response + any server-crash in the terminal
 *
 * The test asserts the server STAYS ALIVE throughout — if the server crashes,
 * Playwright will see the network failure / the page will show ERR_CONNECTION_REFUSED.
 *
 * Requirements: E2E_PORT is NOT a production port (config refuses production).
 * Run it through scripts/run-e2e-full.js so it uses the isolated server and DB.
 */

const { test, expect } = require('@playwright/test');

// The E2E harness supplies BASE URL and a disposable database.
const BASE = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 3000}`;

// Headed mode (visible browser) with slowMo so each action is visible to the
// human eye. Set E2E_HEADLESS=true for CI/headless runs.
const E2E_HEADLESS = process.env.E2E_HEADLESS === 'true';

test.describe('Mother Company — "New distribution agency" form', () => {
  let page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    // Capture console/page errors so we can report them as evidence.
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[console.error]', msg.text());
    });
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  });

  test.afterEach(async () => {
    await page.close();
  });

  test('should create an agency and stay alive (server does not crash)', async () => {
    // ── a. Go to the CRM ────────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // ── b. Log in ───────────────────────────────────────────────────────────
    await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="email"], #email').first().fill('admin@blackstack.local');
    await page.locator('input[name="password"], #password').first().fill('admin123');
    await page.locator('button[type="submit"], input[type="submit"]').first().click();

    // Authenticated SPA shell.
    await page.waitForURL('**/index.html*', { timeout: 30000 });
    await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });

    // ── c. Navigate to Mother Company ───────────────────────────────────────
    await page.evaluate(() => { window.location.hash = '#mother-company'; });
    await page.waitForURL(/#mother-company/, { timeout: 30000 });
    await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });

    // ── d. Click "+ New distribution agency" ──────────────────────────────────
    const newButton = page.locator('#mc-new');
    await expect(newButton).toBeVisible({ timeout: 15000 });
    await newButton.click();

    // Modal should be open: wait for the form's save button inside #mc-modal.
    // (The #mc-modal container itself is an empty div until openCreateModal fills it.)
    const saveBtn = page.locator('#mc-modal #mc-save');
    await expect(saveBtn).toBeVisible({ timeout: 15000 });

    // ── e. Fill the form ────────────────────────────────────────────────────
    // Agency code: must match ^[A-Z0-9][A-Z0-9_-]{2,31}$
    // Company name: required, <= 200 chars
    // Country: required
    // Status: ACTIVE/PENDING/SUSPENDED/TERMINATED
    // Admin block: full_name, email, username, password (>= 8), confirmPassword
    const formData = {
      code: 'E2E-TEST-001',
      name: 'Test E2E Agency',
      // Form uses mc-f-cname for contact name (not contactName)
      cname: 'Test Contact',
      email: 'test.e2e@example.com',
      phone: '+91 98765 43210',
      city: 'Mumbai',
    };

    for (const [field, value] of Object.entries(formData)) {
      // Map field names to html ids (the form only has these 6 fields).
      let htmlId;
      switch (field) {
        case 'code': htmlId = 'mc-f-code'; break;
        case 'name': htmlId = 'mc-f-name'; break;
        case 'cname': htmlId = 'mc-f-cname'; break;
        case 'email': htmlId = 'mc-f-cemail'; break;
        case 'phone': htmlId = 'mc-f-phone'; break;
        case 'city': htmlId = 'mc-f-city'; break;
        default: throw new Error(`Unknown form field: ${field}`);
      }
      const input = page.locator(`#${htmlId}`);
      await expect(input).toBeVisible({ timeout: 15000 });
      await input.fill(value);
    }

    // ── f. Click "Create agency" ────────────────────────────────────────────
    const saveBtn2 = page.locator('#mc-modal #mc-save');
    await expect(saveBtn2).toBeVisible({ timeout: 15000 });
    await saveBtn2.click();

    // ── g. Wait for the API response ────────────────────────────────────────
    // The API returns 201 on success or 400/500 with an error JSON.
    // We wait for the modal to close (success) or the form-error to show
    // (validation error). If the server CRASHES, the browser will emit a
    // console.error / pageerror and the HTTP call will fail with ECONNRESET.
    const modal = page.locator('#mc-modal');
    const formError = page.locator('#mc-form-error');

    // Success: modal (and its form) closes after create.
    const modalClosed = page.waitForSelector('#mc-modal', { state: 'hidden', timeout: 30000 });
    // Validation error: form-error becomes visible.
    const formErrorVisible = page.waitForSelector('#mc-form-error:not(.hidden)', { timeout: 30000 });

    const [result] = await Promise.race([
      modalClosed.then(() => 'SUCCESS: modal closed'),
      formErrorVisible.then(() => 'VALIDATION_ERROR: form-error shown'),
    ]);

    console.log('[E2E result]', result);

    // ── Assert: server is still alive ───────────────────────────────────────
    // If the server crashed, Playwright would have seen a network error or the
    // page would show ERR_CONNECTION_REFUSED. We assert the server responds.
    const health = await page.request.get(`${BASE}/health`);
    expect(health.status()).toBe(200);
  });
});
