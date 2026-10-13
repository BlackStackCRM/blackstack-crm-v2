/**
 * BLACKSTACK CRM V2 — Browser-Only UI E2E Test: Alternate Units Management
 *
 * ALL actions happen through the visible browser UI — no direct API calls for test data creation.
 * Tests the full chain: Browser UI → Frontend → API → Backend Service → Repository → SQLite
 *
 * Tests the Alternate Units page: list view (shows conversion rows), add form
 * (Base/Stock Unit, Alternate Unit, Conversion Factor, Use Case), and the
 * live "1 BOX = 10 PCS" conversion formula display.
 *
 * The server must be running on port 3000 with DB_PATH=data_test/model-cat-test2.db
 */
const { test, expect, chromium } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');

// PHASE 3A.1: previously hardcoded to http://localhost:3000, which bypassed
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

// Live-database guard. This suite deletes rows from alternate_units, so it must
// never be pointed at production data.
const { assertDisposableDb } = require('../scripts/assert-disposable-db');
const DB_PATH = assertDisposableDb(process.env.DB_PATH, {
  defaultTo: 'D:/Work/Projects/blackstack/CB CRM V2/blackstack-crm-v2/data_test/model-cat-test2.db',
  suite: 'alternate-units-ui.e2e.test.js',
});

test.describe('Alternate Units UI E2E', () => {

  let browser;
  let context;
  let page;

  /** Clean DB before/after tests — remove test-created alternate units only */
  async function cleanTestDB() {
    const db = new DatabaseSync(DB_PATH);
    try {
      db.exec('PRAGMA busy_timeout = 30000');
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec("DELETE FROM alternate_units WHERE name LIKE 'TEST%'");
      db.exec("DELETE FROM alternate_units WHERE name IN ('BOX','SET','PKT','CTN') AND description LIKE 'Ink cartridge boxes, pendrive packs'");
      db.exec('PRAGMA foreign_keys = ON');
    } finally {
      db.close();
    }
  }

  /** Seed the 4 sample alternate units that the tests expect */
  async function seedSampleUnits() {
    const db = new DatabaseSync(DB_PATH);
    try {
      db.exec('PRAGMA busy_timeout = 30000');
      db.exec('PRAGMA foreign_keys = OFF');
      // Get the Each (PCS) UOM id — table is units_of_measure, not uoms
      const uom = db.prepare("SELECT id FROM units_of_measure WHERE symbol = 'pcs' AND name = 'Each'").get();
      if (!uom) {
        const anyUom = db.prepare('SELECT id FROM units_of_measure WHERE is_active = 1 ORDER BY id LIMIT 1').get();
        if (!anyUom) return;
        const baseId = anyUom.id;
        seedUnitInternal(db, baseId, 'BOX', 10, 'Ink cartridge boxes, pendrive packs');
        seedUnitInternal(db, baseId, 'SET', 2, 'Keyboard + Mouse combo');
        seedUnitInternal(db, baseId, 'PKT', 5, 'Cable bundles, screws');
        seedUnitInternal(db, baseId, 'CTN', 24, 'Bulk cartons');
      } else {
        const baseId = uom.id;
        seedUnitInternal(db, baseId, 'BOX', 10, 'Ink cartridge boxes, pendrive packs');
        seedUnitInternal(db, baseId, 'SET', 2, 'Keyboard + Mouse combo');
        seedUnitInternal(db, baseId, 'PKT', 5, 'Cable bundles, screws');
        seedUnitInternal(db, baseId, 'CTN', 24, 'Bulk cartons');
      }
      db.exec('PRAGMA foreign_keys = ON');
    } finally {
      db.close();
    }
  }

  function seedUnitInternal(db, baseId, name, factor, useCase) {
    const existing = db.prepare('SELECT id FROM alternate_units WHERE name = ?').get(name);
    if (!existing) {
      db.exec("INSERT INTO alternate_units (company_id, name, base_unit_id, conversion_factor, rate, is_active, description) VALUES ('default', '" + name + "', '" + baseId + "', " + factor + ", 0, 1, '" + useCase.replace(/'/g, "''") + "')");
    }
  }

  test.beforeAll(async () => {
    await cleanTestDB().catch(e => console.log('[db-clean]', e.message));
    await seedSampleUnits().catch(e => console.log('[db-seed]', e.message));
    browser = await chromium.launch({ headless: false });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
  });

  test.beforeEach(async () => {
    if (!context) {
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: undefined });
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
  });

  test.afterEach(async () => {
    if (page) await page.close();
  });

  /** Login through the visible browser UI */
  async function loginViaUI() {
    await page.goto(`${BASE_URL}/login.html`);
    await page.waitForSelector('#login-email', { timeout: 15000 });
    await page.fill('#login-email', 'admin@blackstack.local');
    await page.fill('#login-password', 'admin123');
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

  // ─── TEST 1: Alternate Units page loads and shows list ───
  test('Test 1: Alternate Units page loads with table showing records', async () => {
    await loginViaUI();
    await page.goto(`${BASE_URL}/index.html#inventory/alternate_units`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(3000);

    const header = await page.textContent('h1');
    console.log('Page header:', header);
    expect(header).toContain('Alternate Units');

    const rows = await page.evaluate(() => {
      const tbody = document.querySelector('#inv-master-table tbody');
      if (!tbody) return [];
      return Array.from(tbody.querySelectorAll('tr')).map(r => r.textContent.trim());
    });
    console.log('Table rows:', JSON.stringify(rows));

    expect(rows.some(r => r.includes('BOX'))).toBe(true);
    expect(rows.some(r => r.includes('SET'))).toBe(true);
    expect(rows.some(r => r.includes('PKT'))).toBe(true);
    expect(rows.some(r => r.includes('CTN'))).toBe(true);

    expect(rows.some(r => r.includes('1 BOX = 10'))).toBe(true);
    expect(rows.some(r => r.includes('1 SET = 2'))).toBe(true);
    expect(rows.some(r => r.includes('1 PKT = 5'))).toBe(true);
    expect(rows.some(r => r.includes('1 CTN = 24'))).toBe(true);

    expect(rows.some(r => r.includes('Ink cartridge boxes'))).toBe(true);
    expect(rows.some(r => r.includes('Keyboard + Mouse'))).toBe(true);
    expect(rows.some(r => r.includes('Cable bundles'))).toBe(true);
    expect(rows.some(r => r.includes('Bulk cartons'))).toBe(true);

    console.log('✅ PASS: Alternate Units page loads with 4 sample records');
  });

  // ─── TEST 2: Verify table columns ───
  test('Test 2: Table shows all expected columns', async () => {
    await loginViaUI();
    await page.goto(`${BASE_URL}/index.html#inventory/alternate_units`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(3000);

    const headers = await page.evaluate(() => {
      const ths = document.querySelectorAll('#inv-master-table th');
      return Array.from(ths).map(th => {
        // Remove the "arrow_downward" sort icon text and extra whitespace
        let text = th.textContent.trim();
        text = text.replace(/\s*arrow_downward\s*/g, '').trim();
        return text;
      });
    });
    console.log('Table headers:', JSON.stringify(headers));

    expect(headers).toContain('Alternate Unit');
    expect(headers).toContain('Base / Stock Unit');
    expect(headers).toContain('Conversion');
    expect(headers).toContain('Use Case');
    expect(headers).toContain('Status');

    console.log('✅ PASS: Table shows all expected columns');
  });

  // ─── TEST 3: Add alternate unit via UI form ───
  test('Test 3: Add alternate unit with conversion factor and use case', async () => {
    await loginViaUI();
    await page.goto(`${BASE_URL}/index.html#inventory/alternate_units`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(3000);

    await page.click('#inv-master-new');
    await page.waitForTimeout(2000);
    await page.waitForSelector('#inv-master-form', { timeout: 10000 });

    await expect(page.locator('select[name="baseUnitId"]')).toBeVisible();
    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="conversionFactor"]')).toBeVisible();
    await expect(page.locator('textarea[name="description"]')).toBeVisible();

    const formulaDisplay = page.locator('#au-formula-display');
    await expect(formulaDisplay).toBeVisible();
    expect(await formulaDisplay.textContent()).toBe('—');

    const uomOptions = await page.evaluate(() => {
      const sel = document.querySelector('select[name="baseUnitId"]');
      if (!sel) return [];
      return Array.from(sel.options).filter(o => o.value !== '').map(o => ({ value: o.value, text: o.text }));
    });
    expect(uomOptions.length).toBeGreaterThan(0);
    await page.selectOption('select[name="baseUnitId"]', uomOptions[0].value);

    await page.fill('input[name="name"]', 'TESTBOX');
    await page.fill('input[name="conversionFactor"]', '12');
    await page.waitForTimeout(500);

    const formulaText = await formulaDisplay.textContent();
    console.log('Formula text:', formulaText);
    expect(formulaText).toContain('1 TESTBOX');
    expect(formulaText).toContain('12');

    await page.fill('textarea[name="description"]', 'Test boxes for QA');

    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(3000);

    const rowContent = await page.evaluate(() => {
      const rows = document.querySelectorAll('#inv-master-table tbody tr');
      return Array.from(rows).map(r => r.textContent.trim());
    });
    expect(rowContent.some(r => r.includes('TESTBOX'))).toBe(true);
    expect(rowContent.some(r => r.includes('Test boxes for QA'))).toBe(true);
    expect(rowContent.some(r => r.includes('1 TESTBOX = 12'))).toBe(true);

    console.log('✅ PASS: Alternate unit created with conversion factor and use case');
  });

  // ─── TEST 4: Edit an alternate unit ───
  test('Test 4: Edit an alternate unit and verify changes persist', async () => {
    await loginViaUI();
    await page.goto(`${BASE_URL}/index.html#inventory/alternate_units`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(3000);

    await page.waitForFunction(() => {
      const tbody = document.querySelector('#inv-master-table tbody');
      if (!tbody) return false;
      return Array.from(tbody.querySelectorAll('tr')).some(r => r.textContent.includes('TESTBOX'));
    }, { timeout: 10000 });

    // Click edit button on TESTBOX row
    await page.evaluate(() => {
      const rows = document.querySelectorAll('#inv-master-table tbody tr');
      for (const row of rows) {
        if (row.textContent.includes('TESTBOX')) {
          const btn = row.querySelector('button[data-row-action="edit"]');
          if (btn) btn.click();
        }
      }
    });
    await page.waitForTimeout(1500);
    await page.waitForSelector('#inv-master-form', { timeout: 10000 });

    // Verify form is in edit mode (title in modal header)
    const modalTitle = await page.evaluate(() => {
      const h2 = document.querySelector('#modal-root h2');
      return h2 ? h2.textContent.trim() : '';
    });
    console.log('Modal title:', modalTitle);
    expect(modalTitle).toContain('Edit');

    const currentDesc = await page.inputValue('textarea[name="description"]');
    const newDesc = 'Updated: ' + currentDesc;
    await page.fill('textarea[name="description"]', newDesc);

    await page.click('#inv-master-form button[type="submit"]');
    await page.waitForTimeout(2500);

    const updated = await page.evaluate(() => {
      const rows = document.querySelectorAll('#inv-master-table tbody tr');
      return Array.from(rows).map(r => r.textContent.trim());
    });
    expect(updated.some(r => r.includes('Updated: Test boxes for QA'))).toBe(true);

    console.log('✅ PASS: Alternate unit edit persists');
  });

  // ─── TEST 5: Delete an alternate unit ───
  test('Test 5: Delete an alternate unit and verify removal', async () => {
    await loginViaUI();
    await page.goto(`${BASE_URL}/index.html#inventory/alternate_units`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(3000);

    await page.waitForFunction(() => {
      const tbody = document.querySelector('#inv-master-table tbody');
      if (!tbody) return false;
      return Array.from(tbody.querySelectorAll('tr')).some(r => r.textContent.includes('TESTBOX'));
    }, { timeout: 10000 });

    const beforeCount = await page.evaluate(() => {
      const tbody = document.querySelector('#inv-master-table tbody');
      return tbody ? tbody.querySelectorAll('tr').length : 0;
    });
    console.log('Rows before delete:', beforeCount);

    // Click delete button on TESTBOX row
    await page.evaluate(() => {
      const rows = document.querySelectorAll('#inv-master-table tbody tr');
      for (const row of rows) {
        if (row.textContent.includes('TESTBOX')) {
          const btn = row.querySelector('button[data-row-action="delete"]');
          if (btn) btn.click();
        }
      }
    });
    await page.waitForTimeout(1000);

    await page.waitForSelector('#confirm-delete', { timeout: 5000 });
    await page.click('#confirm-delete');
    await page.waitForTimeout(2500);

    const afterRows = await page.evaluate(() => {
      const tbody = document.querySelector('#inv-master-table tbody');
      if (!tbody) return [];
      return Array.from(tbody.querySelectorAll('tr')).map(r => r.textContent.trim());
    });
    const afterCount = afterRows.length;
    console.log('Rows after delete:', afterCount);
    expect(afterCount).toBe(beforeCount - 1);
    expect(afterRows.some(r => r.includes('TESTBOX'))).toBe(false);

    console.log('✅ PASS: Alternate unit deleted successfully');
  });
});
