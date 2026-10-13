/**
 * VISIBLE (headed) Playwright test — Batches section in Inventory Management.
 * Steps: login → open Inventory → open Batches → add a batch → verify in list → cleanup.
 * Run: node tests/e2e-batches-headed.js
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const EMAIL = 'admin@blackstack.local';
const PASSWORD = 'admin123';
const BATCH_NUMBER = 'BATCH-UI-TEST-' + Date.now();

const step = (n, msg) => console.log(`\n▶ STEP ${n}: ${msg}`);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.log(`  ❌ ${msg}`); };

(async () => {
  const browser = await chromium.launch({
    headless: false,          // ← VISIBLE mode
    slowMo: 400,              // slow each action so you can watch
    args: ['--start-maximized'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 160)));
  page.setDefaultTimeout(15000);

  try {
    // ── STEP 1: LOGIN ───────────────────────────────────────────────
    step(1, `Open login page at ${BASE}/login.html`);
    await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
    ok('login page loaded');
    await page.fill('#login-email', EMAIL);
    await page.fill('#login-password', PASSWORD);
    await page.click('#login-submit');
    await page.waitForURL('**/index.html#dashboard', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const loggedIn = await page.evaluate(() => !!localStorage.getItem('crm_token'));
    if (!loggedIn) { fail('login did not set token'); throw new Error('Login failed'); }
    ok('logged in, token stored, dashboard visible');

    // ── STEP 2: OPEN INVENTORY MANAGEMENT ──────────────────────────
    step(2, 'Navigate to Inventory Management');
    await page.evaluate(() => { location.hash = '#inventory'; });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-inv-card="batches"]').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'tests/shots/batch-1-inventory-grid.png', fullPage: true });
    ok('inventory grid rendered with Batches card (screenshot: batch-1-inventory-grid.png)');

    // ── STEP 3: OPEN BATCHES SECTION ───────────────────────────────
    step(3, 'Open Batches section');
    const batchesCard = page.locator('[data-inv-card="batches"]');
    await batchesCard.waitFor({ state: 'visible', timeout: 10000 });
    await batchesCard.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'tests/shots/batch-2-batches-section.png', fullPage: true });
    ok('Batches section opened (screenshot: batch-2-batches-section.png)');

    // ── STEP 4: ADD A BATCH ────────────────────────────────────────
    step(4, 'Add a new batch');
    const addBtn = page.locator('#inv-master-new, #inv-new').first();
    await addBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addBtn.click();
    await page.waitForTimeout(1200); // wait for modal + async select options
    await page.screenshot({ path: 'tests/shots/batch-3-add-form.png', fullPage: true });
    ok('Add form opened (screenshot: batch-3-add-form.png)');

    // Fill Batch Number
    const batchInput = page.locator('input[name="batchNumber"]');
    await batchInput.fill(BATCH_NUMBER);
    ok(`batch number = ${BATCH_NUMBER}`);

    // Select Stock Item (first non-empty option)
    const itemSelect = page.locator('select[name="itemId"]');
    await itemSelect.waitFor({ state: 'visible' });
    await page.waitForTimeout(1000); // options load async
    const optionCount = await itemSelect.locator('option').count();
    if (optionCount < 2) { fail('no stock items in dropdown'); throw new Error('No stock items to select'); }
    await itemSelect.selectOption({ index: 1 });
    const selectedItem = await itemSelect.locator('option:checked').textContent();
    ok(`stock item selected: ${selectedItem.trim()}`);

    // Dates
    const today = new Date().toISOString().split('T')[0];
    const nextYear = new Date(Date.now() + 365 * 864e5).toISOString().split('T')[0];
    await page.fill('input[name="manufacturingDate"]', today);
    await page.fill('input[name="expiryDate"]', nextYear);

    // Rates
    await page.fill('input[name="purchaseRate"]', '100');
    await page.fill('input[name="mrp"]', '150');
    await page.fill('input[name="sellingRate"]', '120');

    await page.screenshot({ path: 'tests/shots/batch-4-form-filled.png', fullPage: true });
    ok('form filled (screenshot: batch-4-form-filled.png)');

    // Save
    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'tests/shots/batch-5-after-save.png', fullPage: true });

    const toastVisible = await page.locator('.toast, [class*="toast"]').first().isVisible().catch(() => false);
    if (toastVisible) ok('success toast appeared');

    // ── STEP 5: VERIFY BATCH IN LIST ───────────────────────────────
    step(5, 'Verify batch appears in the table');
    await page.waitForTimeout(1000);
    const row = page.locator(`tr:has-text("${BATCH_NUMBER}")`);
    const rowCount = await row.count();
    if (rowCount > 0) {
      ok(`batch "${BATCH_NUMBER}" found in table (${rowCount} row)`);
      await page.screenshot({ path: 'tests/shots/batch-6-in-list.png', fullPage: true });
    } else {
      fail(`batch "${BATCH_NUMBER}" NOT found in table`);
      await page.screenshot({ path: 'tests/shots/batch-err-not-in-list.png', fullPage: true });
      throw new Error('Batch not visible in list');
    }

    console.log('\n=========================================');
    console.log('ALL STEPS PASSED - Batches section works end-to-end');
    console.log('Batch created: ' + BATCH_NUMBER);
    console.log('=========================================\n');

    console.log('Browser left open for inspection. Press ENTER in this terminal to run cleanup and close...');
    await new Promise((resolve) => process.stdin.once('data', resolve));

    // ── CLEANUP: delete via API ────────────────────────────────────
    const token = await page.evaluate(() => localStorage.getItem('crm_token'));
    const rowId = await page.evaluate(async (bn) => {
      const r = await fetch('/api/inventory/masters/batches?limit=200', { headers: { Authorization: 'Bearer ' + localStorage.getItem('crm_token') } });
      const j = await r.json();
      const b = (j.items || []).find(x => x.batchNumber === bn || x.batch_number === bn);
      return b ? b.id : null;
    }, BATCH_NUMBER);
    if (rowId) {
      const del = await fetch(`${BASE}/api/inventory/masters/batches/${rowId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`cleanup: deleted batch ${rowId} → HTTP ${del.status}`);
    } else {
      console.log('cleanup: batch not found (may already be deleted)');
    }
  } catch (err) {
    console.log('\nTEST FAILED:', err.message);
    await page.screenshot({ path: 'tests/shots/batch-final-failure.png', fullPage: true }).catch(() => {});
    console.log('failure screenshot saved: tests/shots/batch-final-failure.png');
    console.log('Press ENTER to close the browser...');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('browser closed.');
  }
})();
