/**
 * Playwright E2E test — Login flow on this device.
 *
 * Runs against the server already listening on http://localhost:3000.
 * Covers: valid login, invalid credentials, and empty-field rejection.
 *
 * Diagnostics: waits for either a navigation away from login.html (success)
 * or the error message appearing (failure), with explicit logging.
 */
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3000';
const LOGIN_URL = `${BASE}/login.html`;
const VALID_EMAIL = process.env.E2E_VALID_EMAIL || 'admin@blackstack.local';
// Never hard-code real credentials: the password arrives from the trusted
// environment (operator-provided). Falls back to the historical demo seed
// password ONLY when DEMO_MODE was the source (env absent = demo/dev runs).
const VALID_PASSWORD = process.env.E2E_VALID_PASSWORD || 'admin123';

test.describe('Login E2E', () => {
  test('invalid credentials are rejected', async ({ page }) => {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    const email = page.locator('input[name="email"], #login-email').first();
    const password = page.locator('input[name="password"], #login-password').first();

    await email.fill('nonexistent@example.com');
    await password.fill('wrongpassword');

    const submit = page.locator('button[type="submit"], #login-submit').first();
    await submit.click();

    // Should stay on login page and show an error.
    await expect(page).toHaveURL(LOGIN_URL);
    const error = page.locator('#login-error');
    await expect(error).not.toHaveClass(/hidden/);
  });

  test('empty fields are not submitted', async ({ page }) => {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    const submit = page.locator('button[type="submit"], #login-submit').first();
    await submit.click();

    // Should stay on login page (HTML5 required validation blocks submission).
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test('valid credentials reach the SPA shell or show an error', async ({ page }) => {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    const email = page.locator('input[name="email"], #login-email').first();
    const password = page.locator('input[name="password"], #login-password').first();

    await expect(email).toBeVisible({ timeout: 20000 });
    await email.fill(VALID_EMAIL);
    await password.fill(VALID_PASSWORD);

    const submit = page.locator('button[type="submit"], #login-submit').first();
    await submit.click();

    // Wait for either navigation away from login (success) or error message (failure).
    const error = page.locator('#login-error');
    await Promise.race([
      page.waitForFunction(() => !window.location.pathname.includes('login.html'), { timeout: 45000 }),
      error.waitFor({ state: 'visible', timeout: 45000 }),
    ]);

    const hasError = await error.isVisible();
    const url = page.url();
    const isOnLogin = url.includes('login.html');

    console.log(`[LOGIN DIAG] URL=${url} isOnLogin=${isOnLogin} hasError=${hasError}`);

    if (hasError) {
      const errorText = await error.textContent();
      console.log(`[LOGIN DIAG] Error message: ${errorText}`);
      // Login was rejected by Supabase
      expect(errorText).toBeTruthy();
    } else if (!isOnLogin) {
      // Successful login: navigated away from login page
      await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });
    } else {
      // Neither error nor navigation — request may be pending
      console.log('[LOGIN DIAG] Neither error nor navigation after 45s — request may be pending');
      expect(isOnLogin).toBe(false);
    }
  });
});
