/**
 * Test: Edit product with serial numbers via UI form
 * Creates a product through the form (which creates serials), then edits it
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

const PRODUCT_NAME = 'Form Create Edit Product ' + Date.now();

(async () => {
  let browser;
  try {
    // Login
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
    });
    page.on('pageerror', (err) => console.log(`[PAGE ERROR]: ${err.message}`));

    // Setup auth
    await page.goto('http://127.0.0.1:3000/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.evaluate((data) => {
      localStorage.setItem('crm_token', data.token);
      localStorage.setItem('crm_user', data.userJson);
    }, { token, userJson: JSON.stringify(user) });

    // Navigate to Products
    await page.goto('http://127.0.0.1:3000/index.html#products', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Click New Product
    console.log('[2] Clicking New Product...');
    await page.click('#prod-new');
    await page.waitForTimeout(3000);

    // Fill form
    console.log('[3] Filling form...');
    await page.fill('input[name="name"]', PRODUCT_NAME);
    await page.fill('input[name="opening_qty"]', '2');
    await page.fill('input[name="sku"]', 'FORM-EDIT-' + Date.now());
    await page.selectOption('#prod-brand-select', 'bran_01M3JKNX9755SSA7EXN0RMJAXF');
    await page.waitForTimeout(3000);
    await page.selectOption('#prod-model', 'mode_01M3JKP5HSF8G9Z6SG9WQNE23K');
    await page.waitForTimeout(5000);

    // Inventory
    await page.click('#prod-track-inventory');
    await page.waitForTimeout(2000);
    await page.selectOption('#prod-location', 'loca_01M3QATHF80KBZ4V9JCXHKF2FF');
    await page.waitForTimeout(3000);
    await page.selectOption('#prod-godown', 'god_001');
    await page.waitForTimeout(2000);

    // Serial tracking
    await page.click('#prod-serial-tracked');
    await page.waitForTimeout(2000);

    // Fill serial numbers
    const serialInputs = await page.$$('input[name="serial_numbers[]"]');
    console.log('   Serial inputs:', serialInputs.length);
    if (serialInputs.length >= 2) {
      await serialInputs[0].fill('SN-FORM-001');
      await serialInputs[1].fill('SN-FORM-002');
      console.log('   Serials: SN-FORM-001, SN-FORM-002');
    }

    // Fill pricing
    await page.fill('input[name="cost"]', '100');
    await page.fill('input[name="price"]', '250');

    // Submit
    console.log('[4] Submitting...');
    await page.click('#prod-submit');
    await page.waitForTimeout(8000);

    // Find product ID
    console.log('[5] Finding product...');
    const productResp = await apiRequest(`/api/products?search=${encodeURIComponent(PRODUCT_NAME)}&limit=10`, 'GET', null, token);
    const productData = JSON.parse(productResp.body);
    const items = productData?.data?.items || productData?.items || [];
    if (items.length === 0) {
      console.log('   ❌ Product not found after creation');
      process.exit(1);
    }
    const product = items[0];
    console.log('   Product ID:', product.id);

    // Verify serials exist
    const stockResp = await apiRequest(`/api/inventory/stocks/product/${product.id}`, 'GET', null, token);
    const stockData = JSON.parse(stockResp.body);
    const stockItemId = stockData?.id;
    console.log('   Stock Item ID:', stockItemId);

    const serialResp = await apiRequest(`/api/inventory/reports/serials?item_id=${stockItemId}`, 'GET', null, token);
    const serialData = JSON.parse(serialResp.body);
    console.log('   Serials before edit:', serialData?.items?.length || 0);

    // Navigate to product detail
    console.log('[6] Navigating to product detail...');
    await page.goto(`http://127.0.0.1:3000/index.html#products/${product.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Click Edit
    console.log('[7] Clicking Edit...');
    await page.click('#prod-detail-edit');
    await page.waitForTimeout(5000);

    // Check serial inputs
    const editSerialInputs = await page.$$('input[name="serial_numbers[]"]');
    console.log('   Serial inputs on edit form:', editSerialInputs.length);
    if (editSerialInputs.length > 0) {
      const serialValues = await Promise.all(editSerialInputs.map(input => input.inputValue()));
      console.log('   Serial values:', serialValues);
    }

    // Change product name
    console.log('[8] Editing product name...');
    await page.fill('input[name="name"]', PRODUCT_NAME + ' EDITED');

    // Save
    console.log('[9] Clicking Save...');
    await page.click('#prod-submit');
    await page.waitForTimeout(8000);

    // Check for error toasts or success
    const errors = await page.$$eval('.ToastError, .toast-error', els => els.map(e => e.textContent.trim()));
    const successes = await page.$$eval('.ToastSuccess, .toast-success', els => els.map(e => e.textContent.trim()));
    console.log('   Errors:', errors);
    console.log('   Successes:', successes);

    // Check serial input borders for validation errors
    const serialBorders = await page.$$eval('input[name="serial_numbers[]"]', els => 
      els.map(e => e.style.borderColor || e.className.match(/border-(red-500|error)/) ? 'red' : 'ok')
    );
    console.log('   Serial input borders:', serialBorders);

    // Verify via API
    console.log('[10] Verifying via API...');
    const verifyResp = await apiRequest(`/api/products/${product.id}`, 'GET', null, token);
    const verifyData = JSON.parse(verifyResp.body);
    const updatedName = verifyData?.data?.name || verifyData?.name;
    console.log('   Product name:', updatedName);
    console.log('   Updated:', updatedName === (PRODUCT_NAME + ' EDITED') ? '✅ YES' : '❌ NO');

    await page.screenshot({ path: 'public/screenshots/edit-product-after-save.png', fullPage: true });
    console.log('[11] Screenshot saved');

  } catch (error) {
    console.error('[ERROR]', error.message);
    console.error(error.stack);
  } finally {
    if (browser) await browser.close();
  }
  process.exit(0);
})().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
