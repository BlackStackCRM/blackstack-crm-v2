// Run Test 6 directly using Playwright's programmatic API
const { chromium } = require('@playwright/test');

(async () => {
  console.log('Launching Chrome...');
  const browser = await chromium.launch({
    headless: false,
    timeout: 30000,
  });
  console.log('Browser launched!');
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: undefined,
  });
  console.log('Context created!');
  const page = await context.newPage();
  console.log('Page created!');

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('[CONSOLE ERROR]', msg.text());
  });
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  const BASE_URL = 'http://localhost:3000';
  const TIMEOUT = 800;

  // Login
  console.log('Navigating to login...');
  await page.goto(`${BASE_URL}/login.html`);
  await page.waitForSelector('#login-email', { timeout: 15000 });
  await page.fill('#login-email', 'admin@blackstack.local');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-submit');
  await page.waitForURL(/index\.html/, { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('load');
  await page.waitForTimeout(TIMEOUT);
  console.log('Logged in!');

  // Navigate to inventory
  await page.goto(`${BASE_URL}/index.html#inventory`);
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 33, { timeout: 15000 });
  await page.waitForTimeout(TIMEOUT);

  // Click UOM card
  await page.locator('[data-inv-card="units_of_measure"]').click();
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  console.log('Navigated to UOM page');

  // Click Add
  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);

  // Fill form
  await page.fill('input[name="name"]', 'E2E Box');
  await page.fill('input[name="symbol"]', 'BOX');
  await page.fill('input[name="decimalPlaces"]', '0');
  await page.fill('textarea[name="description"]', 'E2E test unit');
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);
  console.log('UOM created');

  // Verify
  await page.goto(`${BASE_URL}/index.html#inventory`);
  await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 33, { timeout: 15000 });
  await page.locator('[data-inv-card="units_of_measure"]').click();
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
  await page.fill('#inv-master-search', 'E2E Box');
  await page.waitForTimeout(1000);

  const found = await page.evaluate((term) => {
    const tbody = document.querySelector('#inv-master-table tbody');
    if (!tbody) return false;
    return Array.from(tbody.querySelectorAll('tr')).some(r => r.textContent.includes(term));
  }, 'E2E Box');

  console.log('UOM found in table:', found);
  if (found) {
    console.log('✅ PASS: Test 6 succeeded');
  } else {
    console.log('❌ FAIL: Test 6 failed');
  }

  await browser.close();
  console.log('Done!');
  process.exit(found ? 0 : 1);
})().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
