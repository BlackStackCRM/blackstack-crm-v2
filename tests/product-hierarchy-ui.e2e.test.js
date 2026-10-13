/**
 * BLACKSTACK CRM V2 — Browser-Only UI E2E Test: Product Hierarchy Creation
 *
 * ALL actions happen through the visible browser UI — no direct API calls for test data.
 * Tests the full chain: Browser UI → Frontend → API → Backend Service → Repository → SQLite
 *
 * Tests the inventory hierarchy dropdowns (Location → Godown → Inventory Group → Item Group)
 * in the product creation form, verifying dependent dropdowns work correctly.
 *
 * The server must be running on port 3111 with DB_PATH=test-inventory.db
 */
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// PHASE 3A.1: previously hardcoded to http://localhost:3133, which bypassed
// playwright's baseURL and aimed the browser at a production-port server. That is
// the mechanism that wrote E2E data into the live database on 2026-10-08. The
// target is now derived from E2E_PORT and refused if it is a production port or
// is unset. See scripts/assert-e2e-isolation.js.
const { isProductionPort } = require('../scripts/assert-e2e-isolation');
const BASE_URL = (() => {
  const port = Number(process.env.E2E_PORT || 0);
  if (!port) {
    throw new Error(
      'REFUSING TO RUN: E2E_PORT is not set. This suite must run through the '
      + 'isolated E2E harness; it will not fall back to a production port.',
    );
  }
  if (isProductionPort(port)) {
    throw new Error(`REFUSING TO RUN: E2E_PORT=${port} is a reserved PRODUCTION port.`);
  }
  return `http://localhost:${port}`;
})();
const TIMEOUT = 1000;

test.describe('Product Hierarchy UI E2E — Dependent Dropdown Creation', () => {

  let browser;
  let context;
  let page;

  // Live-database guard. This suite deletes rows from products, stock_items and
  // stock_balances, so it must never be pointed at production data. It previously
  // fell back to a path that could be redirected at the live database.
  const { assertDisposableDb } = require('../scripts/assert-disposable-db');
  const DB_PATH = assertDisposableDb(process.env.DB_PATH, {
    defaultTo: 'D:/Work/Projects/blackstack/test-inventory.db',
    suite: 'product-hierarchy-ui.e2e.test.js',
  });

  /** Clean DB before tests — remove test-specific products and their stock items */
  async function cleanTestDB() {
    const db = new DatabaseSync(DB_PATH);
    try {
      db.exec('PRAGMA busy_timeout = 30000');
      db.exec('PRAGMA foreign_keys = OFF');
      // Clean test products (names starting with HIER or SKU containing HIER)
      const rows = db.prepare("SELECT id FROM products WHERE name LIKE 'HIER%' OR sku LIKE 'HIER%'").all();
      const delBalances = db.prepare('DELETE FROM stock_balances WHERE item_id IN (SELECT id FROM stock_items WHERE product_id = ?)');
      const delStockItems = db.prepare('DELETE FROM stock_items WHERE product_id = ?');
      const delProducts = db.prepare('DELETE FROM products WHERE id = ?');
      for (const r of rows) {
        delBalances.run(r.id);
        delStockItems.run(r.id);
        delProducts.run(r.id);
      }
      db.exec('PRAGMA foreign_keys = ON');
    } finally {
      db.close();
    }
  }

  /** Helper: robustly select an option in a dropdown by visible text */
  async function fillSelect(fieldName, searchValue) {
    return page.evaluate((opts) => {
      const { fieldName, searchValue } = opts;
      const select = document.querySelector(`select[name="${fieldName}"]`);
      if (!select) return { error: 'select not found' };
      const options = Array.from(select.options);
      const match = options.find(o => o.text.includes(String(searchValue)));
      if (match) {
        select.value = match.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, text: match.text };
      }
      return { found: false, error: 'option not found', options: options.map(o => o.text) };
    }, { fieldName, searchValue });
  }

  test.beforeAll(async () => {
    await cleanTestDB().catch(e => console.log('[db-clean]', e.message));
    browser = await chromium.launch({ headless: false });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
    // Clean up test data after all tests
    await cleanTestDB().catch(e => console.log('[db-clean-after]', e.message));
  });

  test.beforeEach(async () => {
    if (!context) {
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    } else {
      await context.clearCookies();
      const pages = context.pages();
      for (const p of pages) { try { await p.close(); } catch {} }
    }
    page = await context.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`[CONSOLE ERROR] ${msg.text()}`);
    });
    page.on('pageerror', error => {
      console.log(`[PAGE ERROR] ${error.message}`);
    });
    // Clean any modal overlay
    await page.evaluate(() => {
      const modalRoot = document.getElementById('modal-root');
      if (modalRoot) { modalRoot.innerHTML = ''; }
    });
  });

  test.afterEach(async () => {
    if (page) await page.close();
  });

  /** Login through the visible browser UI */
  async function loginViaUI(email = 'admin@blackstack.local', password = 'admin123') {
    await page.goto(`${BASE_URL}/login.html`);
    await page.waitForSelector('#login-email', { timeout: 15000 });
    await page.fill('#login-email', email);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    try {
      await page.waitForURL(/index\.html/, { timeout: 20000 });
    } catch (e) {
      const token = await page.evaluate(() => localStorage.getItem('crm_token')).catch(() => null);
      if (!token) throw e;
      await page.goto(`${BASE_URL}/index.html#dashboard`);
    }
    await page.waitForTimeout(2000);
  }

  /** Navigate to Products page */
  async function navigateToProducts() {
    await page.goto(`${BASE_URL}/index.html#products`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(TIMEOUT);
  }

  /** Click "Add Product" button */
  async function openAddProductForm() {
    await page.click('#prod-new');
    await page.waitForTimeout(1500);
    await page.waitForSelector('#prod-form', { timeout: 10000 });
  }

  // ─── TEST 1: Verify hierarchy dropdowns appear when Track Inventory is ON ───
  test('Test 1: Hierarchy dropdowns appear when Track Inventory is enabled', async () => {
    await loginViaUI();
    await navigateToProducts();

    // Open the add product form
    await openAddProductForm();

    // Fill basic fields
    await page.fill('input[name="name"]', 'HIER Test Product');
    await page.fill('input[name="sku"]', 'HIER-SKU-001');
    await page.fill('input[name="price"]', '60000');
    await page.fill('input[name="cost"]', '50000');

    // Verify hierarchy section is initially hidden (Track Inventory off)
    const hierarchyInitiallyHidden = await page.evaluate(() => {
      const el = document.getElementById('prod-inventory-hierarchy');
      if (!el) return false;
      // Check if the element or any parent has 'hidden' class
      let parent = el.parentElement;
      while (parent) {
        if (parent.classList && parent.classList.contains('hidden')) return true;
        parent = parent.parentElement;
      }
      return el.classList.contains('hidden');
    });
    expect(hierarchyInitiallyHidden).toBe(true);

    // Enable Track Inventory
    await page.check('#prod-track-inventory');
    await page.waitForTimeout(500);

    // Now hierarchy section should be visible (parent inv-fields has hidden removed)
    const hierarchyVisible = await page.evaluate(() => {
      const el = document.getElementById('prod-inventory-hierarchy');
      if (!el) return false;
      // Check if the element or any parent has 'hidden' class
      let parent = el.parentElement;
      while (parent) {
        if (parent.classList && parent.classList.contains('hidden')) return false;
        parent = parent.parentElement;
      }
      return !el.classList.contains('hidden');
    });
    expect(hierarchyVisible).toBe(true);

    // All four dropdowns should exist
    await expect(page.locator('#prod-location')).toBeVisible();
    await expect(page.locator('#prod-godown')).toBeVisible();
    await expect(page.locator('#prod-inv-group')).toBeVisible();
    await expect(page.locator('#prod-item-group')).toBeVisible();

    console.log('✅ PASS: Hierarchy dropdowns appear when Track Inventory is enabled');
  });

  // ─── TEST 2: Dependent dropdowns — Location → Godown → Inventory Group → Item Group ───
  test('Test 2: Dependent dropdowns cascade correctly (Location → Godown → Inv Group → Item Group)', async () => {
    await loginViaUI();
    await navigateToProducts();

    // Open the add product form
    await openAddProductForm();

    // Fill basic fields
    await page.fill('input[name="name"]', 'HIER Cascade Product');
    await page.fill('input[name="sku"]', 'HIER-CASCADE-001');
    await page.fill('input[name="price"]', '60000');
    await page.fill('input[name="cost"]', '50000');

    // Enable Track Inventory
    await page.check('#prod-track-inventory');
    await page.waitForTimeout(500);

    // Step 1: Verify Location dropdown has options
    await page.waitForTimeout(1000);
    const locationOptions = await page.evaluate(() => {
      const sel = document.getElementById('prod-location');
      if (!sel) return [];
      return Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
    });
    console.log('Location options:', JSON.stringify(locationOptions));
    expect(locationOptions.length).toBeGreaterThan(1); // At least placeholder + 1 location

    // Step 2: Select a Location and verify Godown dropdown populates
    const locationId = locationOptions[1].value; // First actual location
    const locationName = locationOptions[1].text;
    const godownResult = await fillSelect('location_id', locationName);
    console.log('Location selected:', JSON.stringify(godownResult));
    await page.waitForTimeout(1500);

    const godownOptions = await page.evaluate(() => {
      const sel = document.getElementById('prod-godown');
      if (!sel) return [];
      return Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
    });
    console.log('Godown options:', JSON.stringify(godownOptions));
    expect(godownOptions.length).toBeGreaterThan(1); // At least placeholder + 1 godown

    // Step 3: Select a Godown and verify Inventory Group dropdown populates
    const godownId = godownOptions[1].value;
    const godownName = godownOptions[1].text;
    const igResult = await fillSelect('godown_id', godownName);
    console.log('Godown selected:', JSON.stringify(igResult));
    await page.waitForTimeout(1500);

    const invGroupOptions = await page.evaluate(() => {
      const sel = document.getElementById('prod-inv-group');
      if (!sel) return [];
      return Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
    });
    console.log('Inventory Group options:', JSON.stringify(invGroupOptions));
    expect(invGroupOptions.length).toBeGreaterThan(1); // At least placeholder + 1 group

    // Step 4: Select an Inventory Group and verify Item Group dropdown populates
    const invGroupId = invGroupOptions[1].value;
    const invGroupName = invGroupOptions[1].text;
    const itgResult = await fillSelect('inventory_group_id', invGroupName);
    console.log('Inv Group selected:', JSON.stringify(itgResult));
    await page.waitForTimeout(1500);

    const itemGroupOptions = await page.evaluate(() => {
      const sel = document.getElementById('prod-item-group');
      if (!sel) return [];
      return Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
    });
    console.log('Item Group options:', JSON.stringify(itemGroupOptions));
    expect(itemGroupOptions.length).toBeGreaterThan(1); // At least placeholder + 1 item group

    console.log('✅ PASS: Dependent dropdowns cascade correctly');
  });

  // ─── TEST 3: Create product with hierarchy through UI ───
  test('Test 3: Create product with full inventory hierarchy through UI', async () => {
    await loginViaUI();
    await navigateToProducts();

    await openAddProductForm();

    // Fill basic fields
    await page.fill('input[name="name"]', 'HIER Full Product');
    await page.fill('input[name="sku"]', 'HIER-FULL-001');
    await page.fill('input[name="price"]', '60000');
    await page.fill('input[name="cost"]', '50000');

    // Enable Track Inventory
    await page.check('#prod-track-inventory');
    await page.waitForTimeout(500);

    // Wait for location dropdown to populate
    await page.waitForFunction(() => {
      const sel = document.getElementById('prod-location');
      return sel && sel.options.length > 1;
    }, { timeout: 15000 });

    // Select Location
    const locationName = await page.evaluate(() => {
      const sel = document.getElementById('prod-location');
      const opts = Array.from(sel.options).filter(o => o.value !== '');
      return opts[0]?.textContent || '';
    });
    await fillSelect('location_id', locationName);
    await page.waitForTimeout(1500);

    // Select Godown
    const godownName = await page.evaluate(() => {
      const sel = document.getElementById('prod-godown');
      const opts = Array.from(sel.options).filter(o => o.value !== '');
      return opts[0]?.textContent || '';
    });
    await fillSelect('godown_id', godownName);
    await page.waitForTimeout(1500);

    // Select Inventory Group
    const invGroupName = await page.evaluate(() => {
      const sel = document.getElementById('prod-inv-group');
      const opts = Array.from(sel.options).filter(o => o.value !== '');
      return opts[0]?.textContent || '';
    });
    await fillSelect('inventory_group_id', invGroupName);
    await page.waitForTimeout(1500);

    // Select Item Group
    const itemGroupName = await page.evaluate(() => {
      const sel = document.getElementById('prod-item-group');
      const opts = Array.from(sel.options).filter(o => o.value !== '');
      return opts[0]?.textContent || '';
    });
    await fillSelect('item_group_id', itemGroupName);
    await page.waitForTimeout(1000);

    // Set opening quantity
    await page.fill('input[name="opening_qty"]', '5');

    // Submit
    await page.click('#prod-submit');
    await page.waitForTimeout(3000);

    // Verify product appears in the table
    await page.waitForFunction(() => {
      const tbody = document.querySelector('#products-table tbody');
      return tbody && tbody.querySelectorAll('tr').length > 0;
    }, { timeout: 10000 });

    const productInTable = await page.evaluate(() => {
      const rows = document.querySelectorAll('#products-table tbody tr');
      return Array.from(rows).some(r => r.textContent.includes('HIER Full Product'));
    });
    expect(productInTable).toBe(true);

    console.log('✅ PASS: Product with hierarchy created through UI');

    // Close any lingering modal overlay before navigating
    await page.evaluate(() => {
      const modalRoot = document.getElementById('modal-root');
      if (modalRoot) { modalRoot.innerHTML = ''; }
      // Remove overlay elements that might intercept clicks
      const overlays = document.querySelectorAll('div[class*=\"bg-black\"][class*=\"40\"]');
      overlays.forEach(el => el.remove());
    });
    await page.waitForTimeout(500);

    // Navigate to product detail to verify hierarchy fields are populated
    // Find the "HIER Full Product" row and click its detail link
    const productRows = await page.locator('#products-table tbody tr');
    let detailClicked = false;
    const rowCount = await productRows.count();
    for (let i = 0; i < rowCount; i++) {
      const rowText = await productRows.nth(i).textContent();
      if (rowText.includes('HIER Full Product')) {
        const link = productRows.nth(i).locator('a[href^="#products/"]');
        await link.click();
        detailClicked = true;
        break;
      }
    }
    expect(detailClicked).toBe(true);
    await page.waitForTimeout(2000);

    // Verify hierarchy info is displayed (via API check in page context)
    const hierarchyVerified = await page.evaluate(async () => {
      const token = localStorage.getItem('crm_token');
      // Get the product ID from URL
      const hash = window.location.hash;
      const match = hash.match(/#products\/(.+)/);
      if (!match) return { error: 'no product id in URL' };
      const productId = match[1];
      const res = await fetch(`/api/products/${productId}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      const resp = await res.json();
      const p = resp.data || resp;
      const si = p.stockItem || {};
      return {
        hasStockItem: !!p.stock_item_id,
        locationId: si.location_id || si.locationId || p.location_id || p.locationId,
        godownId: si.godown_id || si.godownId || p.godown_id || p.godownId,
        invGroupId: si.inventory_group_id || si.inventoryGroupId || p.inventory_group_id || p.inventoryGroupId,
        itemGroupId: si.item_group_id || si.itemGroupId || p.item_group_id || p.itemGroupId,
      };
    });
    console.log('Hierarchy verified via detail:', JSON.stringify(hierarchyVerified));
    // The hierarchy fields should be populated either on the product or its stock_item
    expect(hierarchyVerified.locationId).toBeTruthy();
    expect(hierarchyVerified.godownId).toBeTruthy();
    expect(hierarchyVerified.invGroupId).toBeTruthy();
    expect(hierarchyVerified.itemGroupId).toBeTruthy();

    console.log('✅ PASS: Product detail shows hierarchy fields populated');
  });
});
