const { test, expect } = require('../fixtures');

test.describe('Agency Control — sub-agency actions', () => {
  test('edits, activates/suspends, removes, and bulk manages existing sub-agencies', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    page.on('dialog', async dialog => {
      console.log(`[DIALOG] ${dialog.message()}`);
      await dialog.accept();
    });

    page.on('response', async resp => {
      const url = resp.url();
      if (url.includes('/agency-control/sub-agencies') || url.includes('/agency-control/customers')) {
        console.log('[RESP]', resp.request().method(), url, resp.status());
      }
    });

    await page.goto('/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
    await page.fill('#login-email', 'admin@blackstack.local');
    await page.fill('#login-password', 'admin123');
    await page.click('#login-submit');
    await page.waitForURL('**/index.html*', { timeout: 15000 });
    await page.waitForTimeout(3000);

    const agencyMenu = page.locator('text="Agency Control"').first();
    if (await agencyMenu.count()) {
      await agencyMenu.click();
    } else {
      await page.goto('/index.html#agency-control', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForTimeout(3000);

    console.log('[TEST] URL:', page.url());
    const section = page.locator('section:has-text("Sub-agencies")');
    await expect(section).toBeVisible({ timeout: 15000 });

    const rows = page.locator('#ac-agencies tbody tr');
    const rowCount = await rows.count();
    console.log('[TEST] initial row count:', rowCount);
    expect(rowCount).toBeGreaterThan(0);

    let targetRow = null;
    for (let i = 0; i < rowCount; i++) {
      const r = rows.nth(i);
      const statusText = (await r.locator('td').nth(3).textContent()) || '';
      if (statusText.includes('PENDING') || statusText.includes('ACTIVE')) {
        targetRow = r;
        break;
      }
    }
    expect(targetRow).not.toBeNull();

    const originalName = await targetRow.locator('td').nth(1).textContent();
    console.log('[TEST] target row name:', originalName);

    // Edit
    await targetRow.locator('[data-agency-actions]').click();
    await expect(targetRow.locator('[data-action="edit"]')).toBeVisible();
    await targetRow.locator('[data-action="edit"]').click();
    await page.waitForTimeout(500);

    const editedName = `${String(originalName).trim()} - e2e`;
    await page.fill('#ac-edit-name', editedName);
    const [editResp] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/agency-control/sub-agencies') && resp.request().method() === 'PUT', { timeout: 20000 }),
      page.click('#ac-edit-save')
    ]);
    const editJson = await editResp.json().catch(() => ({}));
    console.log('[TEST] edit status:', editResp.status(), 'body:', JSON.stringify(editJson).slice(0, 300));
    await page.waitForTimeout(1000);

    const editedRow = page.locator('#ac-agencies tbody tr').filter({ hasText: editedName }).first();
    await expect(editedRow).toBeVisible();

    // Add Admin
    await editedRow.locator('[data-agency-actions]').click();
    await editedRow.locator('[data-action="add-admin"]').click();
    await page.waitForTimeout(500);
    await page.fill('#ac-a-name', 'QA Tester');
    await page.fill('#ac-a-email', `qa+${Date.now()}@agency.com`);
    await page.fill('#ac-a-user', `qa_user_${Date.now()}`);
    await page.fill('#ac-a-pass', 'PlaywrightTest1234');
    const [adminResp] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/agency-control/sub-agencies') && resp.url().includes('/administrators'), { timeout: 20000 }),
      page.click('#ac-a-save')
    ]);
    const adminJson = await adminResp.json().catch(() => ({}));
    console.log('[TEST] add admin status:', adminResp.status(), 'body:', JSON.stringify(adminJson).slice(0, 300));
    await page.waitForTimeout(1000);
    await expect(page.locator('text="Agency administrator assigned successfully."')).toBeVisible({ timeout: 15000 });

    // Suspend
    await editedRow.locator('[data-agency-actions]').click();
    await editedRow.locator('[data-action="suspend"]').click();
    await page.waitForResponse(resp => resp.url().includes('/agency-control/sub-agencies') && resp.url().includes('/status'), { timeout: 20000 });
    await page.waitForTimeout(1000);
    await expect(editedRow.locator('text="SUSPENDED"')).toBeVisible();

    // Activate
    await editedRow.locator('[data-agency-actions]').click();
    await editedRow.locator('[data-action="activate"]').click();
    await page.waitForResponse(resp => resp.url().includes('/agency-control/sub-agencies') && resp.url().includes('/status'), { timeout: 20000 });
    await page.waitForTimeout(1000);
    await expect(editedRow.locator('text="ACTIVE"')).toBeVisible();

    // Remove
    await editedRow.locator('[data-agency-actions]').click();
    await editedRow.locator('[data-action="remove"]').click();
    const [deleteResp] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/agency-control/sub-agencies') && resp.request().method() === 'DELETE', { timeout: 20000 }),
      page.waitForTimeout(1000),
    ]);
    const removeStatus = deleteResp.status();
    const removeBody = await deleteResp.json().then(d => JSON.stringify(d)).catch(() => '');
    console.log('[TEST] remove status:', removeStatus, 'body:', removeBody.slice(0, 300));
    expect(removeStatus).toBe(200);

    // Bulk actions on remaining rows
    const remainingCount = await page.locator('#ac-agencies tbody tr').count();
    console.log('[TEST] remaining row count for bulk:', remainingCount);
    expect(remainingCount).toBeGreaterThan(0);

    const remainingRows = page.locator('#ac-agencies tbody tr');
    await remainingRows.first().locator('[data-agency-select]').check();
    await expect(page.locator('#ac-bulk-bar')).toBeVisible();
    await expect(page.locator('#ac-bulk-count')).toHaveText(String(remainingCount));

    await page.click('#ac-bulk-suspend');
    await page.waitForResponse(resp => resp.url().includes('/agency-control/sub-agencies/bulk/status'), { timeout: 20000 });
    await page.waitForTimeout(1000);
    await expect(page.locator('#ac-bulk-bar')).toBeHidden();

    // Bulk status can remove a row from this view when the endpoint filters
    // non-active agencies. The list may therefore be empty after suspension.
    await expect(page.locator('#ac-bulk-bar')).toBeHidden();
  });
});
