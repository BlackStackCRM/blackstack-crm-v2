const { test, expect } = require('../fixtures');

test('Storage factory reset blocks unavailable cloud purge and clears the disposable local database', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
  await page.fill('#login-email', 'admin@blackstack.local');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-submit');
  await page.waitForURL('**/index.html*', { timeout: 20000 });

  await page.goto('/index.html#storage', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#storage-purge-all')).toBeVisible({ timeout: 20000 });
  const metrics = () => page.evaluate(() => window.API.get('/storage/sqlite'));
  const before = await metrics();
  expect(before.rowCounts.users).toBeGreaterThan(0);
  expect(before.rowCounts.companies).toBeGreaterThan(1);

  // The runner starts the app with Supabase disabled. Requesting a cloud purge
  // must fail before any local transaction is opened.
  await page.click('#storage-purge-all');
  await expect(page.locator('#storage-cloud-purge')).toBeVisible();
  await page.locator('#storage-cloud-purge').check();
  await page.locator('#storage-purge-word').fill('DELETE ALL DATA');
  const cloudResponsePromise = page.waitForResponse(response => response.url().includes('/api/storage/purge-all-data'));
  await page.locator('#storage-purge-confirm').click();
  const cloudResponse = await cloudResponsePromise;
  expect(cloudResponse.status()).toBeGreaterThanOrEqual(400);
  const afterBlockedCloudPurge = await metrics();
  expect(afterBlockedCloudPurge.rowCounts.companies).toBe(before.rowCounts.companies);
  expect(afterBlockedCloudPurge.rowCounts.users).toBe(before.rowCounts.users);

  // Local-only reset is then exercised on this disposable database copy.
  await page.click('#storage-purge-all');
  await expect(page.locator('#storage-cloud-purge')).toBeVisible();
  await page.locator('#storage-purge-word').fill('DELETE ALL DATA');
  const localResponsePromise = page.waitForResponse(response => response.url().includes('/api/storage/purge-all-data'));
  await page.locator('#storage-purge-confirm').click();
  const localResponse = await localResponsePromise;
  expect(localResponse.status()).toBe(200);
  const responseBody = await localResponse.json();
  expect(responseBody.data.cloudPurged).toBe(false);

  const afterLocalPurge = await metrics();
  expect(afterLocalPurge.rowCounts.users).toBe(1);
  expect(afterLocalPurge.rowCounts.companies).toBe(1);
  expect(afterLocalPurge.rowCounts.agencies).toBe(0);
  expect(afterLocalPurge.rowCounts.customerTenantAgencies).toBe(0);
  for (const table of ['contacts', 'organizations', 'leads', 'deals', 'tasks', 'appointments', 'invoices', 'payments', 'auditLogs']) {
    expect(afterLocalPurge.rowCounts[table]).toBe(0);
  }
});
