/**
 * REAL UI VERIFICATION — dashboard, sidebar permissions, logout, fresh login.
 * Runs against the LIVE installed application server (localhost:3000) using
 * the real Mother Company credentials from the trusted environment.
 * The password is never printed or logged.
 *
 * Single worker, single page — each test runs in order on the SAME page so the
 * session persists between the logout/relogin steps.
 */
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3000';
const EMAIL = process.env.E2E_VALID_EMAIL || 'admin@blackstack.local';
const PASSWORD = process.env.E2E_VALID_PASSWORD;
if (!PASSWORD) throw new Error('E2E_VALID_PASSWORD not set in trusted environment.');

test.describe.configure({ mode: 'serial' });
test.describe(() => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="email"], #login-email').first().fill(EMAIL);
    await page.locator('input[name="password"], #login-password').first().fill(PASSWORD);
    await page.locator('button[type="submit"], #login-submit').first().click();
    await page.waitForFunction(() => !window.location.href.includes('login.html'), { timeout: 45000 });
  });

  test.afterAll(async () => {
    if (page) await page.close();
  });

  test('dashboard renders with sidebar + topbar (non-blank)', async () => {
    await expect(page).toHaveURL(/index\.html/);
    await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });

    // Sidebar: Mother Company platform user sees the full CRM nav.
    await page.waitForSelector('#sidebar-nav a', { timeout: 15000 }).catch(() => {});
    const sidebarItems = await page.locator('#sidebar-nav a').count();
    console.log(`[UI VERIFY] sidebar items visible: ${sidebarItems}`);
    expect(sidebarItems).toBeGreaterThan(5);

    // Mother Company Control menu item present (platform-only surface).
    const mcItem = await page.locator('#sidebar-nav a:has-text("Mother Company")').count();
    console.log(`[UI VERIFY] Mother Company Control item: ${mcItem}`);
    expect(mcItem).toBeGreaterThan(0);

    // Topbar renders user identity.
    const topbarText = await page.locator('.topbar, header').first().textContent().catch(() => '');
    expect(topbarText.trim().length).toBeGreaterThan(0);

    // Dashboard content is not blank.
    const mainContent = await page.locator('#page-container').textContent();
    expect(mainContent.trim().length).toBeGreaterThan(20);
    console.log(`[UI VERIFY] dashboard main content length: ${mainContent.trim().length}`);
  });

  test('Mother Company permissions resolve (ADMIN / platform / wildcard)', async () => {
    const perms = await page.evaluate(async () => {
      const token = localStorage.getItem('crm_token');
      const r = await fetch('/api/auth/profile', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return { httpStatus: r.status };
      const j = await r.json();
      const p = (j.user && j.user.permissions) || j.permissions || [];
      return {
        httpStatus: 200,
        role: j.user && j.user.role,
        hierarchyRole: j.user && (j.user.hierarchyRole || j.user.hierarchy_role),
        permissionCount: p.length,
        hasWildcard: p.includes('*'),
        email: j.user && j.user.email,
      };
    });
    console.log(`[UI VERIFY] profile: role=${perms.role} hierarchy=${perms.hierarchyRole} perms=${perms.permissionCount} wildcard=${perms.hasWildcard}`);
    expect(perms.httpStatus).toBe(200);
    expect(perms.role).toBe('ADMIN');
    expect(perms.hierarchyRole).toBe('platform');
    expect(perms.permissionCount).toBeGreaterThan(0);
    expect(perms.hasWildcard).toBe(true);
  });

  test('logout clears session and redirects to login', async () => {
    const logoutBtn = page.locator('#logout-btn, [data-action="logout"], button:has-text("Logout"), a:has-text("Logout")').first();
    await logoutBtn.click({ timeout: 10000 }).catch(async () => {
      // Fallback: POST /api/auth/logout directly then clear the session locally.
      await page.evaluate(async () => {
        const token = localStorage.getItem('crm_token');
        await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
        localStorage.removeItem('crm_token');
        localStorage.removeItem('crm_user');
      });
    });
    await page.waitForFunction(() => window.location.href.includes('login.html'), { timeout: 30000 });
    const tokenAfter = await page.evaluate(() => localStorage.getItem('crm_token'));
    expect(tokenAfter).toBeFalsy();
    console.log('[UI VERIFY] logout OK — token cleared, redirected to login');
  });

  test('fresh login after logout works', async () => {
    await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="email"], #login-email').first().fill(EMAIL);
    await page.locator('input[name="password"], #login-password').first().fill(PASSWORD);
    await page.locator('button[type="submit"], #login-submit').first().click();
    await page.waitForFunction(() => !window.location.href.includes('login.html'), { timeout: 45000 });
    await expect(page).toHaveURL(/index\.html/);
    console.log('[UI VERIFY] fresh login after logout OK — dashboard restored');
  });
});
