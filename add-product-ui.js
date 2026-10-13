const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--start-maximized']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  page.on('console', msg => { if (msg.type() === 'error') console.log(`[console error] ${msg.text()}`); });
  page.on('pageerror', err => console.log(`[page error] ${err.message}`));

  const BASE_URL = 'http://localhost:3000';

  try {
    // Step 1: Login
    console.log('Step 1: Logging in...');
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'networkidle' });
    await page.fill('#login-email', 'admin@blackstack.local');
    await page.fill('#login-password', 'admin123');
    await Promise.all([
      page.click('#login-submit'),
      page.waitForLoadState('networkidle').catch(() => {})
    ]);
    await page.waitForTimeout(2000);
    console.log('Login completed');

    // Step 2: Navigate to Inventory
    console.log('Step 2: Navigating to Inventory...');
    await page.goto(`${BASE_URL}/index.html#inventory`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    console.log('Inventory dashboard loaded with', await page.evaluate(() => document.querySelectorAll('[data-inv-card]').length), 'cards');

    // Step 3: Create UOM (Unit of Measure)
    console.log('\n=== Step 3: Creating UOM "E2E Box" ===');
    await page.locator('[data-inv-card="units_of_measure"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(500);
    await page.fill('input[name="name"]', 'E2E Box');
    await page.fill('input[name="symbol"]', 'BOX');
    await page.fill('input[name="decimalPlaces"]', '0');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(1500);
    console.log('✅ UOM "E2E Box" created');

    // Step 4: Create Stock Group
    console.log('\n=== Step 4: Creating Stock Group "E2E Group Prod" ===');
    await page.goto(`${BASE_URL}/index.html#inventory`);
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    await page.locator('[data-inv-card="stock_groups"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(500);
    await page.fill('input[name="name"]', 'E2E Group Prod');
    await page.fill('textarea[name="description"]', 'Product group for E2E testing');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(1500);
    console.log('✅ Stock Group "E2E Group Prod" created');

    // Step 5: Create Brand
    console.log('\n=== Step 5: Creating Brand "E2E Brand Prod" ===');
    await page.goto(`${BASE_URL}/index.html#inventory`);
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    await page.locator('[data-inv-card="brands"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(500);
    await page.fill('input[name="name"]', 'E2E Brand Prod');
    await page.fill('textarea[name="description"]', 'Brand for E2E testing');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(1500);
    console.log('✅ Brand "E2E Brand Prod" created');

    // Step 6: Create Colour
    console.log('\n=== Step 6: Creating Colour "E2E Blue" ===');
    await page.goto(`${BASE_URL}/index.html#inventory`);
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    await page.locator('[data-inv-card="colours"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(500);
    await page.fill('input[name="name"]', 'E2E Blue');
    await page.fill('input[name="hexCode"]', '#0000FF');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(1500);
    console.log('✅ Colour "E2E Blue" created');

    // Step 7: Create Size
    console.log('\n=== Step 7: Creating Size "E2E Large" ===');
    await page.goto(`${BASE_URL}/index.html#inventory`);
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    await page.locator('[data-inv-card="sizes"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(500);
    await page.fill('input[name="name"]', 'E2E Large');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(1500);
    console.log('✅ Size "E2E Large" created');

    // Step 8: Create Style
    console.log('\n=== Step 8: Creating Style "E2E Casual" ===');
    await page.goto(`${BASE_URL}/index.html#inventory`);
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    await page.locator('[data-inv-card="styles"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(500);
    await page.fill('input[name="name"]', 'E2E Casual');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(1500);
    console.log('✅ Style "E2E Casual" created');

    // Step 9: Create Godown
    console.log('\n=== Step 9: Creating Godown "E2E Main WH Prod" ===');
    await page.goto(`${BASE_URL}/index.html#inventory`);
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    await page.locator('[data-inv-card="godowns"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(500);
    await page.fill('input[name="name"]', 'E2E Main WH Prod');
    await page.fill('input[name="code"]', 'E2E-WH-PROD');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(1500);
    console.log('✅ Godown "E2E Main WH Prod" created');

    // Step 10: Create Stock Item
    console.log('\n=== Step 10: Creating Stock Item "E2E Test Widget Prod" ===');
    await page.goto(`${BASE_URL}/index.html#inventory`);
    await page.waitForFunction(() => document.querySelectorAll('[data-inv-card]').length >= 25, { timeout: 15000 });
    await page.locator('[data-inv-card="stock_items"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.click('#inv-master-new');
    await page.waitForTimeout(1000);
    console.log('Add form opened');

    // Fill text fields
    await page.fill('input[name="name"]', 'E2E Test Widget Prod');
    await page.fill('input[name="sku"]', 'E2E-WIDGET-PROD');

    // Fill select dropdowns
    const selectFields = ['uomId', 'groupId', 'brandId', 'colourId', 'sizeId', 'styleId'];
    for (const field of selectFields) {
      await page.waitForTimeout(800);
      const optionCount = await page.locator(`select[name="${field}"] option`).count();
      console.log(`  Field ${field}: ${optionCount} options`);
      if (optionCount > 1) {
        await page.selectOption(`select[name="${field}"]`, { index: 1 });
      }
    }

    // Fill price fields
    await page.fill('input[name="cost_price"]', '100');
    await page.fill('input[name="selling_rate"]', '150');
    await page.fill('input[name="mrp"]', '200');
    await page.fill('input[name="min_stock_level"]', '10');
    await page.fill('input[name="max_stock_level"]', '100');

    // Submit
    console.log('Submitting form...');
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(3000);
    console.log('✅ Form submitted');

    // Verify
    console.log('\n=== Step 11: Verifying stock item in table ===');
    await page.fill('#inv-master-search', 'E2E Test Widget Prod');
    await page.waitForTimeout(1000);
    const rowCount = await page.locator('#inv-master-table tbody tr').count();
    console.log(`Table rows found: ${rowCount}`);
    if (rowCount > 0) {
      const rowText = await page.locator('#inv-master-table tbody tr').first().textContent();
      console.log('Row text:', rowText.substring(0, 200));
    }
    expect(rowCount).toBeGreaterThan(0);
    console.log('\n✅ SUCCESS: Product added through UI successfully!');
  } catch (e) {
    console.error('❌ Error:', e.message);
  } finally {
    await browser.close();
  }
})();
