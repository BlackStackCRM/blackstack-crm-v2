const { test, expect } = require('@playwright/test');

test.describe('Mother Company — agency activation', () => {
  test('activates a pending agency and updates the UI', async ({ page }) => {
    // ── a. Go to login ─────────────────────────────────────────────────
    await page.goto('/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);

    // ── b. Log in through the UI ───────────────────────────────────────
    await page.fill('#login-email', 'admin@blackstack.local');
    await page.fill('#login-password', 'admin123');
    await page.click('#login-submit');

    // Wait for the app to navigate away from login.
    await page.waitForURL('**/index.html*', { timeout: 15000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log('[LOGIN] current URL after wait:', currentUrl);
    const crmUserBefore = await page.evaluate(() => localStorage.getItem('crm_user'));
    console.log('[LOGIN] crm_user before mc nav:', crmUserBefore);

    // Decode the JWT in a browser-safe way.
    const token = await page.evaluate(() => localStorage.getItem('crm_token'));
    console.log('[LOGIN] token prefix:', String(token || '').slice(0, 24));
    const jwtPayload = await page.evaluate((t) => {
      try {
        const payload = (t || '').split('.')[1] || '';
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');

        // Browser-safe base64 decode without Buffer.
        const json = decodeURIComponent(
          Array.from(atob(padded), (c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
        );
        return JSON.parse(json);
      } catch (e) {
        console.log('[LOGIN] jwt decode failed:', e.message);
        return null;
      }
    }, token);
    console.log('[LOGIN] jwt payload permissions:', jwtPayload?.permissions);
    console.log('[LOGIN] jwt payload role:', jwtPayload?.role);
    console.log('[LOGIN] jwt payload roleIds:', jwtPayload?.roleIds);

    // ── c. Click the exact sidebar menu item ───────────────────────────
    const motherCompanyMenu = page.locator('text="Mother Company Control"').first();
    await expect(motherCompanyMenu).toBeVisible({ timeout: 10000 });
    await motherCompanyMenu.click();

    await page.waitForTimeout(4000);

    const finalUrl = page.url();
    console.log('[MC] URL after click:', finalUrl);

    const table = page.locator('#mc-agencies');
    if ((await table.count()) === 0) {
      await page.screenshot({ path: 'test-results-e2e/mother-company-empty.png', fullPage: true });
      
      // Get the page content for debugging
      const pageContent = await page.content();
      console.log('[MC] page content snippet:', pageContent.slice(0, 500));
      
      // Check for error messages
      const errorText = await page.locator('#mc-error').textContent();
      console.log('[MC] error text:', errorText);
      
      // Check what's in the page container
      const pageContainer = await page.locator('#page-container').innerHTML();
      console.log('[MC] page container snippet:', pageContainer.slice(0, 500));
      
      throw new Error('Mother Company agencies table is missing after login');
    }

    // Take a screenshot of the agencies table for debugging
    await page.screenshot({ path: 'test-results-e2e/mother-company-table.png', fullPage: true });

    const allRows = page.locator('#mc-agencies tbody tr');
    const rowCount = await allRows.count();
    console.log('[MC] total agency rows:', rowCount);

    if (rowCount === 0) {
      throw new Error('No agency rows found in Mother Company table');
    }

    // Find a PENDING agency or use the first one
    let pendingRow = null;
    for (let i = 0; i < rowCount; i++) {
      const row = allRows.nth(i);
      const statusText = await row.locator('td').nth(4).textContent();
      console.log(`[MC] row ${i} status:`, statusText);
      if (statusText && statusText.includes('PENDING')) {
        pendingRow = row;
        break;
      }
    }

    if (!pendingRow) {
      console.log('[MC] no PENDING agency found, using first row');
      pendingRow = allRows.first();
    }

    const agencyCode = await pendingRow.locator('td').nth(1).textContent();
    console.log('[ACTIVATE] agency code:', agencyCode);

    // Click the first visible Activate button
    await pendingRow.locator('[data-mc-actions]').click();
    const activateBtn = pendingRow.locator('[data-action="activate"]').first();
    console.log('[ACTIVATE] button found:', await activateBtn.count() > 0);
    await expect(activateBtn).toBeVisible({ timeout: 10000 });

    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/agencies/') && resp.url().includes('/status') && resp.status() === 200),
      activateBtn.click()
    ]);
    await page.waitForTimeout(1000);

    const respBody = await response.json();
    console.log('[ACTIVATE] response status:', respBody?.agency?.status, 'agency id:', respBody?.agency?.id);

    // ── e. Verify status changed to ACTIVE ────────────────────────────
    const refreshedRow = page.locator('#mc-agencies tbody tr').first();
    const updatedRow = page.locator('#mc-agencies tbody tr').filter({ hasText: agencyCode }).first();
    const statusBadge = updatedRow.locator('td').nth(4);
    await expect(statusBadge).toContainText('ACTIVE', { timeout: 15000 });

    console.log('[ACTIVATE] success, agency:', agencyCode);
  });
});
