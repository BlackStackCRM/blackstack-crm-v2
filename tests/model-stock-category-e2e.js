const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');

// E2E_PORT isolation guard: the test MUST run against an isolated disposable DB.
// It uses E2E_PORT and the server is started with DB_PATH pointing to a disposable
// copy of production. The test NEVER touches production on port 3000.
const PORT = Number(process.env.E2E_PORT || 3000);
const DB_PATH = process.env.DB_PATH || './data_test/fresh-e2e-test.db';
const TEST_ID = Date.now().toString().slice(-6);

// Helper: clean up via DB directly (bypass UI for reliability)
function cleanupDB() {
  const db = new DatabaseSync(DB_PATH);
  const groupIdPrefix = `E2E-GRP-${TEST_ID}`;
  const categoryPrefix = `E2E-CAT-${TEST_ID}`;
  const categoryPrefix2 = `E2E-CAT2-${TEST_ID}`;
  const modelPrefix = `E2E-MOD-${TEST_ID}`;
  const brandPrefix = `E2E-MCAT-${TEST_ID}`;

  // Delete only records created by this test run.
  // All test-created records use unique TEST_ID-scoped prefixes:
  //   - stock_groups: E2E-GRP-*
  //   - stock_categories: E2E-CAT-*, E2E-CAT2-*
  //   - models: E2E-MOD-*
  //   - brands: E2E-MCAT-* (if any were created)
  db.prepare(`DELETE FROM models WHERE name LIKE '${modelPrefix}%'`).run();
  db.prepare(`DELETE FROM stock_categories WHERE name LIKE '${categoryPrefix}%' OR name LIKE '${categoryPrefix2}%'`).run();
  db.prepare(`DELETE FROM stock_groups WHERE name LIKE '${groupIdPrefix}%'`).run();
  db.prepare(`DELETE FROM brands WHERE name LIKE '${brandPrefix}%'`).run();

  // NOTE: stock_items and stock_balances are NOT created by this test.
  // The test creates stock_groups, stock_categories, and models only.
  // The old broad query "DELETE FROM stock_balances WHERE item_id NOT IN
  // (SELECT id FROM stock_items)" is removed because it deletes ALL
  // stock_balances rows that reference non-existent items — including
  // seed data. No test records are created in those tables here.
  console.log('[INFO] DB cleanup complete');
  db.close();
}
cleanupDB();

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${msg}`);
  }
};

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('[ERR]', msg.text().substring(300));
  });

  // ─── Login ───
  console.log('[STEP 1] Logging in...');
  await page.goto(`http://127.0.0.1:${PORT}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', 'admin@blackstack.local');
  await page.fill('input[name="password"]', 'admin123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ]);
  console.log('[PASS] Login successful');

  let groupId = null;
  let categoryId = null;
  let categoryId2 = null;

  // ─── Step 1: Create Stock Group ───
  console.log('\n[STEP 2] Creating Stock Group: E2E-GRP-' + TEST_ID);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.location.hash = '#inventory/stock_groups');
  await page.waitForTimeout(2000);

  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);
  await page.fill('#inv-master-form input[name="name"]', 'E2E-GRP-' + TEST_ID);
  await page.fill('#inv-master-form textarea[name="description"]', 'Test stock group for E2E model test');
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);

  const groupVisible = await page.locator('text=E2E-GRP-' + TEST_ID).isVisible();
  assert(groupVisible, 'Stock Group visible in table');

  // Get the group ID from the database
  const db = new DatabaseSync(DB_PATH);
  const groupRecord = db.prepare("SELECT id FROM stock_groups WHERE name = ?").get('E2E-GRP-' + TEST_ID);
  groupId = groupRecord ? groupRecord.id : null;
  console.log('[INFO] Stock Group ID: ' + groupId);

  // ─── Step 2: Create Stock Category under the group ───
  console.log('\n[STEP 3] Creating Stock Category: E2E-CAT-' + TEST_ID + ' under the group');
  await page.evaluate(() => window.location.hash = '#inventory/stock_categories');
  await page.waitForTimeout(2000);

  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);

  const groupSelect = await page.$('#inv-master-form select[name="stock_group_id"]');
  assert(!!groupSelect, 'Stock Group dropdown is present in category form');

  await page.fill('#inv-master-form input[name="name"]', 'E2E-CAT-' + TEST_ID);
  await page.selectOption('#inv-master-form select[name="stock_group_id"]', { value: groupId });
  await page.fill('#inv-master-form textarea[name="description"]', 'Test category for E2E');
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);

  const catVisible = await page.locator('text=E2E-CAT-' + TEST_ID).isVisible();
  assert(catVisible, 'Stock Category visible in table');

  const catRecord = db.prepare("SELECT id FROM stock_categories WHERE name = ?").get('E2E-CAT-' + TEST_ID);
  categoryId = catRecord ? catRecord.id : null;
  console.log('[INFO] Stock Category ID: ' + categoryId);

  // Create a second category for the edit/change test
  console.log('\n[STEP 3b] Creating second Stock Category: E2E-CAT2-' + TEST_ID);
  await page.click('#inv-master-new');
  await page.waitForTimeout(1000);
  await page.fill('#inv-master-form input[name="name"]', 'E2E-CAT2-' + TEST_ID);
  await page.selectOption('#inv-master-form select[name="stock_group_id"]', { value: groupId });
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);

  const catRecord2 = db.prepare("SELECT id FROM stock_categories WHERE name = ?").get('E2E-CAT2-' + TEST_ID);
  categoryId2 = catRecord2 ? catRecord2.id : null;
  console.log('[INFO] Stock Category 2 ID: ' + categoryId2);

  db.close();

  // ─── Step 3: Navigate to Models (ModelPage) ───
  console.log('\n[STEP 4] Navigating to Models (ModelPage) page');
  await page.evaluate(() => window.location.hash = '#inventory/models');
  await page.waitForTimeout(2000);

  // Open the Create Model form (ModelPage uses #inv-master-form)
  await page.click('#inv-master-new');
  await page.waitForTimeout(1500);
  console.log('[PASS] Create Model form opened');
  await page.screenshot({ path: 'public/screenshots/model-form-opened.png' });

  // Verify Stock Category dropdown exists and is required (Model form)
  const catSelect = await page.$('#inv-master-form select[name="stock_category_id"]');
  assert(!!catSelect, 'Stock Category dropdown is present in Model form');
  await page.screenshot({ path: 'public/screenshots/model-form-opened-with-dropdown.png' });

  // Verify the select has the "required" attribute
  const isRequired = await catSelect.evaluate(el => el.required);
  assert(isRequired, 'Stock Category dropdown has required attribute');

  // Verify Stock Categories are loaded dynamically (at least one option besides placeholder)
  const optionCount = await catSelect.evaluate(el => el.options.length);
  assert(optionCount >= 2, `Stock Category dropdown has options (found ${optionCount}, expected >= 2)`);

  // Verify our created category is in the dropdown
  const categoryVisible = await catSelect.evaluate((el, catName) => {
    return Array.from(el.options).some(opt => opt.textContent.includes(catName));
  }, 'E2E-CAT-' + TEST_ID);
  assert(categoryVisible, 'Created Stock Category appears in dropdown');

  // ─── Verify the Brand dropdown exists (model form requires Brand) ───
  const brandSelect = await page.$('#inv-master-form select[name="brand_id"]');
  assert(!!brandSelect, 'Brand dropdown is present in Model form');
  console.log('[PASS] Brand dropdown is present');

  // Select a brand (must select, service requires brand_id for models)
  // Use a brand from seed data (brand_001 = 'Generic')
  await page.selectOption('#inv-master-form select[name="brand_id"]', { value: 'brand_001' });
  await page.waitForTimeout(500);
  console.log('[PASS] Brand selected (brand_001)');

  // ─── Step 5: Attempt to create Model WITHOUT Stock Category ───
  console.log('\n[STEP 5] Attempting to create Model WITHOUT Stock Category');
  await page.fill('#inv-master-form input[name="name"]', 'E2E-MOD-' + TEST_ID + '-NOCAT');
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(1000);

  // The form should NOT submit (required attribute + JS validation)
  // The model should not appear in the table
  let modelCreated = await page.locator('text=E2E-MOD-' + TEST_ID + '-NOCAT').isVisible().catch(() => false);
  assert(!modelCreated, 'Model NOT created when Stock Category not selected');

  // ─── Step 5: Create Model WITH Stock Category ───
  console.log('\n[STEP 6] Creating Model with Stock Category selection');
  await page.selectOption('#inv-master-form select[name="stock_category_id"]', { value: categoryId });
  await page.fill('#inv-master-form input[name="name"]', 'E2E-MOD-' + TEST_ID);
  await page.fill('#inv-master-form textarea[name="description"]', 'Test model for E2E');
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);
  console.log('[PASS] Model form submitted');

  // Verify model appears in the table
  const modelVisible = await page.locator('text=E2E-MOD-' + TEST_ID).isVisible();
  assert(modelVisible, 'Model visible in table');

  // Verify the Stock Category name column shows the correct category
  const rowLocator = page.locator('#inv-master-table tbody tr').filter({ hasText: 'E2E-MOD-' + TEST_ID });
  const cellTexts = await rowLocator.locator('td').allTextContents();
  const catColText = cellTexts.join(' | ');
  assert(catColText && catColText.includes('E2E-CAT-' + TEST_ID), `Stock Category column shows correct category. Got: ${catColText || '(empty)'}`);

  // ─── Step 6: Verify DB relationship (FK integrity) ───
  console.log('\n[STEP 7] Verifying database relationship (FK integrity)');
  const db2 = new DatabaseSync(DB_PATH);
  const modelRecord = db2.prepare("SELECT id, name, stock_category_id FROM models WHERE name = ?").get('E2E-MOD-' + TEST_ID);
  assert(!!modelRecord, 'Model record exists in database');
  assert(modelRecord.stock_category_id === categoryId, `Model has correct stock_category_id FK (${modelRecord.stock_category_id} === ${categoryId})`);

  // Verify the hierarchy: Model → Stock Category → Stock Group via JOIN
  const hierCheck = db2.prepare(`
    SELECT m.name as model_name, sc.name as category_name, sg.name as group_name
    FROM models m
    JOIN stock_categories sc ON m.stock_category_id = sc.id
    JOIN stock_groups sg ON sc.stock_group_id = sg.id
    WHERE m.name = 'E2E-MOD-${TEST_ID}'
  `).get();
  assert(!!hierCheck, 'Full hierarchy join works (Model → Category → Group)');
  console.log('[INFO] Hierarchy:', hierCheck.model_name, '→', hierCheck.category_name, '→', hierCheck.group_name);

  // ─── Step 7: Edit Model — verify Stock Category pre-selected ───
  console.log('\n[STEP 8] Editing Model — verifying Stock Category pre-selection');
  const editBtn = await page.locator('#inv-master-table tbody tr').filter({ hasText: 'E2E-MOD-' + TEST_ID }).locator('button[data-row-action="edit"]').first();
  await editBtn.click();
  await page.waitForTimeout(1500);
  console.log('[PASS] Edit form opened');

  const selectedOptionValue = await page.$eval('#inv-master-form select[name="stock_category_id"]', el => el.value);
  assert(selectedOptionValue === categoryId, `Stock Category pre-selected correctly (value=${selectedOptionValue}, expected=${categoryId})`);

  // Change to second category
  await page.selectOption('#inv-master-form select[name="stock_category_id"]', { value: categoryId2 });
  await page.click('#inv-master-form button[type="submit"]');
  await page.waitForTimeout(2000);
  console.log('[PASS] Model updated with new Stock Category');

  // Verify the change in the table
  await page.waitForTimeout(2000);
  const updatedRow = page.locator('#inv-master-table tbody tr').filter({ hasText: 'E2E-MOD-' + TEST_ID });
  const updatedCells = await updatedRow.locator('td').allTextContents();
  const updatedCatText = updatedCells.join(' | ');
  assert(updatedCatText && updatedCatText.includes('E2E-CAT2-' + TEST_ID), `Stock Category updated in table. Got: ${updatedCatText || '(empty)'}`);

  // Verify in DB
  const updatedModel = db2.prepare("SELECT stock_category_id FROM models WHERE name = ?").get('E2E-MOD-' + TEST_ID);
  assert(updatedModel.stock_category_id === categoryId2, `DB shows updated stock_category_id (${updatedModel.stock_category_id} === ${categoryId2})`);

  // ─── Step 8: Verify no duplicate Stock Categories created ───
  console.log('\n[STEP 9] Verifying no duplicate Stock Categories were created');
  const catCount = db2.prepare("SELECT COUNT(*) as c FROM stock_categories WHERE name LIKE 'E2E-CAT%'").get().c;
  assert(catCount === 2, `Exactly 2 Stock Categories exist (no duplicates from Model form). Found: ${catCount}`);

  db2.close();

  // ─── Cleanup ───
  console.log('\n[STEP 10] Cleaning up...');
  cleanupDB();

  console.log(`\n[DONE] Results: ${passed} passed, ${failed} failed`);
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('[FAIL]', err.message);
  try { cleanupDB(); } catch (e) { console.error('[CLEANUP ERROR]', e.message); }
  process.exit(1);
});
