/**
 * Test: Verify serial numbers display on the product detail page
 * Creates a product with serials via UI form, navigates to detail, checks serials display
 */
const { chromium } = require('playwright');
const http = require('http');

function apiRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const options = {
      hostname: '127.0.0.1', port: 3000, path: path, method: method,
      headers: data ? { ...headers, 'Content-Length': Buffer.byteLength(data) } : headers,
    };
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const PRODUCT_NAME = 'Serial Display Test ' + Date.now();

(async () => {
  let browser;
  try {
    console.log('[1] Logging in...');
    const loginResp = await apiRequest('/api/auth/login', 'POST', {
      email: 'admin@blackstack.local', password: 'admin123'
    });
    const loginData = JSON.parse(loginResp.body);
    const token = loginData?.data?.token;
    const user = loginData?.data?.user;
    console.log('   Token:', token ? 'OK' : 'FAILED');

    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[PAGE ERR]: ${msg.text()}`);
      if (msg.type() === 'log') console.log(`[PAGE LOG]: ${msg.text()}`);
    });
    page.on('pageerror', (err) => console.log(`[PAGE JS ERROR]: ${err.message}`));

    await page.goto('http://127.0.0.1:3000/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.evaluate((data) => {
      localStorage.setItem('crm_token', data.token);
      localStorage.setItem('crm_user', data.userJson);
    }, { token, userJson: JSON.stringify(user) });

    // Navigate to products and create a new product with serial tracking
    await page.goto('http://127.0.0.1:3000/index.html#products', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    await page.click('#prod-new');
    await page.waitForTimeout(3000);

    await page.fill('input[name="name"]', PRODUCT_NAME);
    await page.fill('input[name="opening_qty"]', '3');
    await page.fill('input[name="sku"]', 'SN-DISPLAY-' + Date.now());
    await page.selectOption('#prod-brand-select', 'bran_01M3JKNX9755SSA7EXN0RMJAXF');
    await page.waitForTimeout(3000);
    await page.selectOption('#prod-model', 'mode_01M3JKP5HSF8G9Z6SG9WQNE23K');
    await page.waitForTimeout(5000);

    await page.click('#prod-track-inventory');
    await page.waitForTimeout(2000);
    await page.selectOption('#prod-location', 'loca_01M3QATHF80KBZ4V9JCXHKF2FF');
    await page.waitForTimeout(3000);
    await page.selectOption('#prod-godown', 'god_001');
    await page.waitForTimeout(2000);
    await page.click('#prod-serial-tracked');
    await page.waitForTimeout(2000);

    const serialInputs = await page.$$('input[name="serial_numbers[]"]');
    console.log('   Serial inputs:', serialInputs.length);
    if (serialInputs.length >= 3) {
      await serialInputs[0].fill('SN-DISP-001');
      await serialInputs[1].fill('SN-DISP-002');
      await serialInputs[2].fill('SN-DISP-003');
    }

    await page.fill('input[name="cost"]', '100');
    await page.fill('input[name="price"]', '250');
    await page.click('#prod-submit');
    await page.waitForTimeout(8000);

    // Find product
    const productResp = await apiRequest(`/api/products?search=${encodeURIComponent(PRODUCT_NAME)}&limit=10`, 'GET', null, token);
    const productData = JSON.parse(productResp.body);
    const items = productData?.data?.items || productData?.items || [];
    if (items.length === 0) {
      console.log('   ❌ Product not found after creation');
      process.exit(1);
    }
    const product = items[0];
    console.log('[2] Product ID:', product.id);

    // Check serials in DB via API
    const stockResp = await apiRequest(`/api/inventory/stocks/product/${product.id}`, 'GET', null, token);
    const stockData = JSON.parse(stockResp.body);
    const stockItemId = stockData?.id;
    console.log('   Stock Item ID:', stockItemId);

    const serialResp = await apiRequest(`/api/inventory/reports/serials?item_id=${stockItemId}`, 'GET', null, token);
    const serialData = JSON.parse(serialResp.body);
    console.log('   Serials in DB:', serialData?.items?.length || 0);

    // Navigate to product detail page
    console.log('[3] Navigating to product detail...');
    await page.goto(`http://127.0.0.1:3000/index.html#products/${product.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Check serial numbers display
    console.log('[4] Checking serial numbers on detail page...');
    const serialList = await page.$('#prod-serial-list');
    if (serialList) {
      const serialText = await serialList.textContent();
      console.log('   Serial list text:', serialText.trim());

      const hasSN1 = serialText.includes('SN-DISP-001');
      const hasSN2 = serialText.includes('SN-DISP-002');
      const hasSN3 = serialText.includes('SN-DISP-003');
      console.log('   SN-DISP-001:', hasSN1, '| SN-DISP-002:', hasSN2, '| SN-DISP-003:', hasSN3);

      if (hasSN1 && hasSN2 && hasSN3) {
        console.log('   ✅ All serial numbers displayed on detail page!');
      } else {
        console.log('   ❌ Some serial numbers NOT displayed');
      }
    } else {
      console.log('   ❌ Serial list element NOT found on detail page');
    }

    // Check the inventory tab is visible
    const inventoryTab = await page.$('[data-tab="inventory"]');
    if (inventoryTab) {
      console.log('   Inventory tab found');
      await inventoryTab.click();
      await page.waitForTimeout(2000);

      const serialListAfter = await page.$('#prod-serial-list');
      if (serialListAfter) {
        const serialText2 = await serialListAfter.textContent();
        console.log('   Serial list text (after tab click):', serialText2.trim());
      }
    }

    await page.screenshot({ path: 'public/screenshots/serial-display-detail.png', fullPage: true });
    console.log('[5] Screenshot saved');

  } catch (error) {
    console.error('[ERROR]', error.message);
  } finally {
    if (browser) await browser.close();
  }
  process.exit(0);
})();
