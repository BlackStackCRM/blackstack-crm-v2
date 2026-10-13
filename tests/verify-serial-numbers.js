/**
 * Test: Create product with serial numbers and verify they show on detail page
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

const PRODUCT_NAME = 'Serial Verify Product ' + Date.now();

(async () => {
  let browser;
  try {
    console.log('[1] Logging in...');
    const loginResp = await apiRequest('/api/auth/login', 'POST', {
      email: 'admin@blackstack.local', password: 'admin123'
    });
    const token = JSON.parse(loginResp.body)?.data?.token;
    console.log('   Token:', token ? 'OK' : 'FAILED');

    // Create product via API with serial tracking
    console.log('[2] Creating product with serial tracking via API...');
    const createResp = await apiRequest('/api/products', 'POST', {
      name: PRODUCT_NAME,
      sku: 'SERIAL-VERIFY-' + Date.now(),
      price: 500,
      cost: 300,
      is_active: 1,
      stock_group_id: 'grp_electronics',
      stock_category_id: 'cat_electronics',
      brand_id: 'bran_01M3JKNX9755SSA7EXN0RMJAXF',
      model_id: 'mode_01M3JKP5HSF8G9Z6SG9WQNE23K',
      track_inventory: true,
      is_serial_tracked: true,
      location_id: 'loca_01M3QATHF80KBZ4V9JCXHKF2FF',
      godown_id: 'god_001',
      opening_quantity: 3,
      serial_numbers: ['SN-001', 'SN-002', 'SN-003']
    }, token);
    const createData = JSON.parse(createResp.body);
    const productId = createData?.data?.id || createData?.id;
    console.log('   Product ID:', productId, '| Status:', createResp.status);

    if (!productId) {
      console.log('   CREATE BODY:', createResp.body);
      return;
    }

    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[PAGE ERR]: ${msg.text()}`);
      if (msg.type() === 'log') console.log(`[PAGE LOG]: ${msg.text()}`);
    });
    page.on('pageerror', (err) => console.log(`[PAGE JS ERROR]: ${err.message}`));

    // Setup auth
    await page.goto('http://127.0.0.1:3000/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const loginData = JSON.parse(loginResp.body)?.data?.user;
    await page.evaluate((data) => {
      localStorage.setItem('crm_token', data.token);
      localStorage.setItem('crm_user', data.userJson);
    }, { token, userJson: JSON.stringify(loginData) });

    // Navigate to product detail
    console.log('[3] Navigating to product detail...');
    await page.goto(`http://127.0.0.1:3000/index.html#products/${productId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Check serial numbers display
    console.log('[4] Checking serial numbers display...');
    const serialList = await page.$('#prod-serial-list');
    if (serialList) {
      const serialText = await serialList.textContent();
      console.log('   Serial list text:', serialText.trim());
    } else {
      console.log('   Serial list element NOT found on page');
    }

    // Also check if serial section exists
    const serialSection = await page.$('#prod-serial-section');
    if (serialSection) {
      console.log('   Serial section found');
    } else {
      console.log('   Serial section NOT found');
    }

    // Check inventory panel serial numbers
    const inventoryPanel = await page.$('#product-inventory-tab-content');
    if (inventoryPanel) {
      const panelText = await inventoryPanel.textContent();
      console.log('   Inventory panel contains serial:', panelText.includes('SN-'));
    }

    await page.screenshot({ path: 'public/screenshots/serial-verify-result.png', fullPage: true });
    console.log('[5] Screenshot saved');

  } catch (error) {
    console.error('[ERROR]', error.message);
  } finally {
    if (browser) await browser.close();
  }
  process.exit(0);
})();
