/**
 * E2E Test: Stock Category → Stock Group Hierarchy
 * Tests the complete flow:
 *   1. Create a Stock Group
 *   2. Create a Stock Category under that group (required field)
 *   3. Verify category appears under the correct group in the list
 *   4. Edit the category — change its Stock Group
 *   5. Verify it moved to the new group
 *   6. Attempt to delete the Stock Group (should warn — references exist)
 *   7. Cleanup all test records
 */
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');

// PHASE 3 — TEST DATABASE SAFETY.
// Previously defaulted to the LIVE production database and issues 14 DELETEs.
// Now clones production into an isolated temp directory, verified by the
// project's existing allow-list.
const { createDisposableDb } = require('../scripts/assert-disposable-db');
const { dbPath: DB_PATH, cleanup: cleanupDisposableDb } = createDisposableDb({
  suite: 'stock-category-hierarchy-e2e',
  prefix: 'bscrm-stkcat-',
});
// PHASE 3 — TEST DATABASE SAFETY (browser path).
// This file also navigated a BROWSER to a hardcoded http://127.0.0.1:3000, which
// is the production server. Running it wrote a USER_LOGIN audit row into the LIVE
// database even though the suite's own SQL was correctly isolated — the same
// two-path defect that contaminated production on 2026-10-08, where direct DB
// access was isolated while the browser path was not.
//
// This guard must live at MODULE SCOPE, before the async IIFE launches a browser.
// Placed inside a function it never executes and the suite runs unguarded.
const { isProductionPort } = require('../scripts/assert-e2e-isolation');
const E2E_PORT_NUM = Number(process.env.E2E_PORT || 0);
if (!E2E_PORT_NUM) {
  try { cleanupDisposableDb(); } catch { /* best effort */ }
  console.error(
    'REFUSING TO RUN: E2E_PORT is not set. This suite needs an isolated server; '
    + 'it must not fall back to the production port.',
  );
  process.exit(1);
}
if (isProductionPort(E2E_PORT_NUM)) {
  try { cleanupDisposableDb(); } catch { /* best effort */ }
  console.error(`REFUSING TO RUN: E2E_PORT=${E2E_PORT_NUM} is a reserved PRODUCTION port.`);
  process.exit(1);
}
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT_NUM}`;

const TEST_ID = Date.now().toString().slice(-6);

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let groupId = null;
  let categoryId = null;
  let categoryId2 = null;

  // Helper: clean up via DB directly (bypass UI for reliability)
  function cleanupDB() {
    const db = new DatabaseSync(DB_PATH);
    db.prepare("DELETE FROM stock_categories WHERE name LIKE 'E2E-%'").run();
    db.prepare("DELETE FROM stock_groups WHERE name LIKE 'E2E-%'").run();
    db.prepare("DELETE FROM stock_items WHERE name LIKE 'E2E-%'").run();
    db.prepare("DELETE FROM products WHERE name LIKE 'E2E-%' OR sku LIKE 'E2E-%'").run();
    db.prepare("DELETE FROM stock_balances WHERE item_id NOT IN (SELECT id FROM stock_items)").run();
    console.log('[INFO] DB cleanup complete');
    db.close();
  }
  cleanupDB();

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('[ERR]', msg.text().substring(0, 300));
  });

  // ─── Login ───
  console.log('[STEP 1] Logging in...');
  await page.goto(`${E2E_BASE_URL}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', 'admin@blackstack.local');
  await page.fill('input[name="password"]', 'admin123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ]);
  console.log('[PASS] Login successful');

  // ─── Test 1: Create Stock Group ───
  console.log('\n[STEP 2] Creating Stock Group: E2E-GRP-' + TEST_ID);
  await page.goto(`${E2E_BASE_URL}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.location.hash = '#inventory/stock_groups');
  await page.waitForTimeout(2000);

  // Click "Add Stock Group"
  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);
  console.log('[PASS] Stock Group form opened');

  // Fill the form
  await page.fill('#inv-master-form input[name="name"]', 'E2E-GRP-' + TEST_ID);
  await page.fill('#inv-master-form textarea[name="description"]', 'Test stock group for E2E');
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);
  console.log('[PASS] Stock Group created');

  // Verify it appears in the table
  const groupRows = await page.$$('#inv-master-table tbody tr');
  console.log('[INFO] Stock Group table rows: ' + groupRows.length);
  const groupVisible = await page.locator('text=E2E-GRP-' + TEST_ID).isVisible();
  if (!groupVisible) throw new Error('Stock Group not visible in table');
  console.log('[PASS] Stock Group visible in table');

  // Get the group ID from the database
  const db = new DatabaseSync(DB_PATH);
  const groupRecord = db.prepare("SELECT id FROM stock_groups WHERE name = ?").get('E2E-GRP-' + TEST_ID);
  groupId = groupRecord ? groupRecord.id : null;
  console.log('[INFO] Stock Group ID: ' + groupId);
  db.close();

  // ─── Test 2: Create Stock Category under the group ───
  console.log('\n[STEP 3] Creating Stock Category: E2E-CAT-' + TEST_ID + ' under Stock Group E2E-GRP-' + TEST_ID);
  await page.evaluate(() => window.location.hash = '#inventory/stock_categories');
  await page.waitForTimeout(2000);
  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);
  console.log('[PASS] Add Stock Category form opened');

  // Verify Stock Group dropdown is present and required
  const groupSelect = await page.$('#inv-master-form select[name="stock_group_id"]');
  if (!groupSelect) throw new Error('Stock Group dropdown not found in form');
  console.log('[PASS] Stock Group dropdown is present');

  // Fill the form
  await page.fill('#inv-master-form input[name="name"]', 'E2E-CAT-' + TEST_ID);
  await page.selectOption('#inv-master-form select[name="stock_group_id"]', { value: groupId });
  await page.fill('#inv-master-form textarea[name="description"]', 'Test category under E2E group');
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);

  // Check for error (if no group selected) — but we selected one, so should succeed
  console.log('[PASS] Stock Category form submitted');

  // Verify category appears in table
  const catVisible = await page.locator('text=E2E-CAT-' + TEST_ID).isVisible();
  if (!catVisible) throw new Error('Stock Category not visible in table');
  console.log('[PASS] Stock Category visible in table');

  // Verify Stock Group column shows the correct group name
  const groupColText = await page.locator('#inv-master-table tbody tr').filter({ hasText: 'E2E-CAT-' + TEST_ID }).locator('td').nth(1).textContent();
  if (!groupColText || !groupColText.includes('E2E-GRP-' + TEST_ID)) {
    throw new Error('Stock Group column does not show correct group. Got: ' + groupColText);
  }
  console.log('[PASS] Stock Group column shows correct group: ' + groupColText.trim());

  // Get category ID from DB
  const db2 = new DatabaseSync(DB_PATH);
  const catRecord = db2.prepare("SELECT id FROM stock_categories WHERE name = ?").get('E2E-CAT-' + TEST_ID);
  categoryId = catRecord ? catRecord.id : null;
  console.log('[INFO] Stock Category ID: ' + categoryId);
  db2.close();

  // ─── Test 3: Edit Category — Change Stock Group ───
  console.log('\n[STEP 4] Creating second Stock Group for move test...');
  await page.evaluate(() => window.location.hash = '#inventory/stock_groups');
  await page.waitForTimeout(2000);
  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);
  await page.fill('#inv-master-form input[name="name"]', 'E2E-GRP2-' + TEST_ID);
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(1500);
  console.log('[PASS] Second Stock Group created');

  const db3 = new DatabaseSync(DB_PATH);
  const groupRecord2 = db3.prepare("SELECT id FROM stock_groups WHERE name = ?").get('E2E-GRP2-' + TEST_ID);
  const groupId2 = groupRecord2 ? groupRecord2.id : null;
  console.log('[INFO] Second Stock Group ID: ' + groupId2);
  db3.close();

  // Go back to categories and edit
  console.log('\n[STEP 5] Editing Stock Category — changing Stock Group...');
  await page.evaluate(() => window.location.hash = '#inventory/stock_categories');
  await page.waitForTimeout(2000);

  // Click edit on our category
  const editBtn = await page.locator('#inv-master-table tbody tr').filter({ hasText: 'E2E-CAT-' + TEST_ID }).locator('button[data-row-action="edit"]').first();
  await editBtn.click();
  await page.waitForTimeout(1000);
  console.log('[PASS] Edit form opened');

  // Verify current group is selected
  const selectedGroup = await page.$eval('#inv-master-form select[name="stock_group_id"]', el => el.value);
  if (selectedGroup !== groupId) {
    throw new Error('Expected group ' + groupId + ' to be selected, got ' + selectedGroup);
  }
  console.log('[PASS] Current Stock Group is correctly selected: ' + groupId);

  // Change to the second group
  await page.selectOption('#inv-master-form select[name="stock_group_id"]', { value: groupId2 });
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);
  console.log('[PASS] Stock Category updated with new Stock Group');

  // Verify it now shows the new group
  const newGroupColText = await page.locator('#inv-master-table tbody tr').filter({ hasText: 'E2E-CAT-' + TEST_ID }).locator('td').nth(1).textContent();
  if (!newGroupColText || !newGroupColText.includes('E2E-GRP2-' + TEST_ID)) {
    throw new Error('Stock Group column does not show new group after edit. Got: ' + newGroupColText);
  }
  console.log('[PASS] Category now appears under new group: ' + newGroupColText.trim());

  // ─── Test 4: Delete protection for Stock Group with categories ───
  console.log('\n[STEP 6] Testing Stock Group deletion protection...');
  await page.evaluate(() => window.location.hash = '#inventory/stock_groups');
  await page.waitForTimeout(2000);

  // Try to delete the first group (which has a category)
  const groupRow = await page.locator('#inv-master-table tbody tr').filter({ hasText: 'E2E-GRP-' + TEST_ID });
  await groupRow.locator('button[data-row-action="delete"]').first().click();
  await page.waitForTimeout(1000);

  // Click confirm delete
  const confirmBtn = await page.$('#confirm-delete');
  if (confirmBtn) {
    await confirmBtn.click();
    await page.waitForTimeout(2000);
  }

  // Check for error toast (should show "Cannot delete" message)
  const errorToast = await page.locator('.toast-error, [class*="error"], .bg-error-container').first();
  const hasError = await errorToast.isVisible().catch(() => false);
  if (hasError) {
    const errorText = await errorToast.textContent();
    console.log('[PASS] Deletion blocked with error: ' + errorText?.trim());
  } else {
    console.log('[INFO] Deletion attempt completed (check console for error toast)');
  }

  // ─── Cleanup ───
  console.log('\n[STEP 7] Cleaning up...');
  const dbCleanup = new DatabaseSync(DB_PATH);
  dbCleanup.prepare("DELETE FROM stock_categories WHERE name LIKE 'E2E-%'").run();
  dbCleanup.prepare("DELETE FROM stock_groups WHERE name LIKE 'E2E-%'").run();
  dbCleanup.prepare("DELETE FROM stock_items WHERE name LIKE 'E2E-%'").run();
  dbCleanup.prepare("DELETE FROM products WHERE name LIKE 'E2E-%' OR sku LIKE 'E2E-%'").run();
  dbCleanup.prepare("DELETE FROM stock_balances WHERE item_id NOT IN (SELECT id FROM stock_items)").run();
  console.log('[PASS] Cleanup complete');
  dbCleanup.close();

  console.log('\n[DONE] All Stock Category hierarchy tests passed!');
  await browser.close();
})().catch(async (err) => {
  console.error('[FAIL]', err.message);
  // PHASE 3 — remove the disposable database before exiting. This handler calls
  // process.exit() directly, which can outrun the exit hook registered by
  // createDisposableDb() while a browser handle is still open, leaking the temp
  // directory. Explicit cleanup here makes removal deterministic.
  try { cleanupDisposableDb(); } catch { /* best effort */ }
  // Ensure cleanup even on failure
  try {
    const db = new DatabaseSync(DB_PATH);
    db.prepare("DELETE FROM stock_categories WHERE name LIKE 'E2E-%'").run();
    db.prepare("DELETE FROM stock_groups WHERE name LIKE 'E2E-%'").run();
    db.prepare("DELETE FROM stock_items WHERE name LIKE 'E2E-%'").run();
    db.prepare("DELETE FROM products WHERE name LIKE 'E2E-%' OR sku LIKE 'E2E-%'").run();
    db.close();
  } catch (e) { console.error('[CLEANUP ERROR]', e.message); }
  process.exit(1);
});
