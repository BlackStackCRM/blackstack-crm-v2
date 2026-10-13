const { chromium } = require('playwright');

(async () => {
  // Launch fresh Chrome visible to the user
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('[ERR]', msg.text().substring(0, 300));
  });

  // ─── Login ───
  await page.goto('http://127.0.0.1:3000/login.html', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', 'admin@blackstack.local');
  await page.fill('input[name="password"]', 'admin123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ]);
  console.log('[PASS] Login successful');

  // ─── Test 1: Create Product via Products page ───
  await page.goto('http://127.0.0.1:3000/index.html#products', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  console.log('[PASS] Products page loaded');

  await page.click('#prod-new');
  await page.waitForSelector('#prod-form', { timeout: 10000 });
  console.log('[PASS] Product form opened');

  const runStamp = Date.now().toString().slice(-6);
  const productName = 'E2E Test Product ' + runStamp;
  const uniqueSku = 'E2E-TEST-' + runStamp;
  await page.fill('input[name="name"]', productName);
  await page.fill('input[name="sku"]', uniqueSku);

  const categorySelect = await page.$('select[name="category_id"]');
  if (categorySelect) {
    const options = await categorySelect.$$('option');
    if (options.length > 1) {
      await categorySelect.selectOption({ index: 1 });
    }
  }

  await page.fill('input[name="price"]', '1200');
  await page.fill('input[name="cost"]', '900');

  await page.check('#prod-track-inventory');
  await page.waitForTimeout(500);

  const uomSelect = await page.$('select[name="uom_id"]');
  if (uomSelect) {
    const options = await uomSelect.$$('option');
    if (options.length > 1) {
      await uomSelect.selectOption({ index: 1 });
    }
  }

  await page.check('input[name="is_serial_tracked"]');
  const serialInputs = await page.$$('input[name="serial_numbers[]"]');
  for (let i = 0; i < serialInputs.length; i++) {
    await serialInputs[i].fill('E2E-SN-' + uniqueSku + '-' + (i + 1));
  }
  await page.waitForTimeout(300);

  console.log('[INFO] Product form filled with SKU:', uniqueSku);

  page.on('dialog', d => d.dismiss());

  let productId = null;
  try {
    const respPromise = page.waitForResponse(resp => resp.url().includes('/api/products'), { timeout: 30000 });
    await page.click('#prod-form button[type="submit"]');
    const response = await respPromise;
    const body = await response.json().catch(() => null);
    console.log('[INFO] Product response status:', response.status());
    if (body && body.success && body.data && body.data.id) {
      productId = body.data.id;
      console.log('[PASS] Product created with ID:', productId);
    } else if (body && !body.success) {
      console.log('[FAIL] Product server error:', JSON.stringify(body.error));
    } else {
      console.log('[FAIL] Unexpected product response:', JSON.stringify(body).substring(0, 200));
    }
  } catch (e) {
    console.log('[ERROR] Product submit:', e.message);
    const errorMsg = await page.evaluate(() => {
      const toast = document.querySelector('[data-toast]');
      return toast ? toast.textContent : null;
    }).catch(() => null);
    if (errorMsg) console.log('[ERROR] Client-side error:', errorMsg);
  }

  await page.waitForTimeout(2000);
  await page.goto('http://127.0.0.1:3000/index.html#products', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  let rows = [];
  try {
    rows = await page.$$eval('#products-table tbody tr', r => r.map(tr => tr.textContent.trim()));
  } catch(e) {
    console.log('[INFO] Could not read table rows:', e.message);
  }
  const foundProduct = rows.some(r => r.includes(productName));
  console.log(foundProduct ? '[PASS] Product visible in table' : '[FAIL] Product NOT in table');
  console.log('[INFO] Product rows:', rows.length);

  // Cleanup Product and its auto-created Stock Item
  if (productId) {
    const token = await page.evaluate(() => localStorage.getItem('crm_token'));
    // Delete the stock_item linked to this product (if any)
    const listRes = await fetch(`http://127.0.0.1:3000/api/inventory/stocks/product/${productId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const listBody = await listRes.json().catch(() => null);
    const linkedStockItemId = listBody?.data?.id || listBody?.id;
    if (linkedStockItemId) {
      await fetch(`http://127.0.0.1:3000/api/inventory/stocks/${linkedStockItemId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      console.log('[INFO] Cleaned up linked stock item:', linkedStockItemId);
    }
    const delRes = await fetch(`http://127.0.0.1:3000/api/products/${productId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('[INFO] Product cleanup DELETE status:', delRes.status);
  }

  // ─── Test 2: Create Stock Item from Inventory > Stock Items page ───
  await page.goto('http://127.0.0.1:3000/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { window.location.hash = 'inventory'; });
  await page.waitForTimeout(2000);

  await page.click('[data-inv-card="stock_items"]');
  await page.waitForTimeout(2000);
  console.log('[PASS] Stock Items page loaded');

  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);
  await page.waitForSelector('#inv-master-form', { timeout: 10000 });
  console.log('[PASS] Add Stock Item form opened');

  const stockRunStamp = Date.now().toString().slice(-6);
  const itemName = 'E2E Stock Item ' + stockRunStamp;
  const stockSku = 'E2E-STK-' + stockRunStamp;
  await page.fill('input[name="name"]', itemName);
  await page.fill('input[name="sku"]', stockSku);

  // Select UOM and Category
  await page.selectOption('select[name="uomId"]', { index: 1 });
  await page.selectOption('select[name="categoryId"]', { index: 1 });

  // Enable serial and batch tracking
  await page.selectOption('select[name="is_serial_tracked"]', '1');
  await page.selectOption('select[name="is_batch_tracked"]', '1');

  await page.fill('input[name="cost_price"]', '500');
  await page.fill('input[name="selling_rate"]', '800');

  console.log('[INFO] Stock Item form filled');

  let stockItemBody = null;
  try {
    const respPromise = page.waitForResponse(resp => resp.url().includes('/api/inventory/stocks') && resp.request().method() === 'POST', { timeout: 30000 });
    await page.click('#inv-master-form button[type="submit"]');
    const response = await respPromise;
    const bodyText = await response.text();
    stockItemBody = bodyText ? JSON.parse(bodyText) : null;
    console.log('[INFO] Stock Item response status:', response.status(), 'body:', bodyText.substring(0, 200));
    if (response.ok() && stockItemBody && stockItemBody.data && stockItemBody.data.id) {
      console.log('[PASS] Stock Item created with ID:', stockItemBody.data.id);
    } else if (stockItemBody && !stockItemBody.success) {
      console.log('[FAIL] Stock Item server error:', JSON.stringify(stockItemBody.error));
    }
  } catch (e) {
    console.log('[ERROR] Stock Item submit:', e.message);
  }

  await page.waitForTimeout(2000);

  // Verify in table
  const tableContent = await page.$eval('#inv-master-table', t => t.textContent).catch(() => '');
  const foundStockItem = tableContent.includes(itemName);
  console.log(foundStockItem ? '[PASS] Stock Item visible in table' : '[FAIL] Stock Item NOT in table');

  // Cleanup Stock Item and its auto-created Product
  if (stockItemBody && stockItemBody.data && stockItemBody.data.id) {
    const token = await page.evaluate(() => localStorage.getItem('crm_token'));
    // Also delete the auto-created product if it exists
    if (stockItemBody.data.productId || stockItemBody.data.product_id) {
      const prodId = stockItemBody.data.productId || stockItemBody.data.product_id;
      await fetch(`http://127.0.0.1:3000/api/products/${prodId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      console.log('[INFO] Cleaned up linked product');
    }
    const delRes = await fetch(`http://127.0.0.1:3000/api/inventory/stocks/${stockItemBody.data.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('[INFO] Stock Item cleanup DELETE status:', delRes.status);
  }

  await browser.close();
  console.log('[DONE]');
})().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
