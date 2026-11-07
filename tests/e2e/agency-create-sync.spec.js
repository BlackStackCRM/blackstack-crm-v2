/**
 * E2E user test — "New distribution agency" form + Supabase sync proof
 *
 * Steps:
 *  a. Go to the harness-provided base URL
 *  b. Log in as admin@blackstack.local / admin123
 *  c. Navigate to #mother-company
 *  d. Click "+ New agency"
 *  e. Fill the form with unique data
 *  f. Click "Create agency"
 *  g. Wait for modal close / success
 *  h. Assert new agency appears in UI list
 *  i. Verify the agency exists in Supabase cloud
 *
 * Run: E2E_HEADLESS=false npx playwright test tests/e2e/agency-create-sync.spec.js --headed
 */

const { test, expect } = require('@playwright/test');
require('dotenv').config();

const BASE = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 3000}`;
const E2E_HEADLESS = process.env.E2E_HEADLESS === 'true';

test.describe('Mother Company — UI to Supabase sync', () => {
  let page;
  let agencyCode;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[console.error]', msg.text());
    });
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  });

  test.afterEach(async () => {
    await page.close();
  });

  test('should create agency via UI and sync to Supabase', async () => {
    // ── a. Go to the CRM ────────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // ── b. Log in ───────────────────────────────────────────────────────────
    await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="email"], #email').first().fill('admin@blackstack.local');
    await page.locator('input[name="password"], #password').first().fill('admin123');
    await page.locator('button[type="submit"], input[type="submit"]').first().click();

    await page.waitForURL('**/index.html*', { timeout: 30000 });
    await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });

    // ── c. Navigate to Mother Company ───────────────────────────────────────
    await page.evaluate(() => { window.location.hash = '#mother-company'; });
    await page.waitForURL(/#mother-company/, { timeout: 30000 });
    await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });

    // ── d. Click "+ New agency" ─────────────────────────────────────────────
    const newButton = page.locator('#mc-new');
    await expect(newButton).toBeVisible({ timeout: 15000 });
    await newButton.click();

    const saveBtn = page.locator('#mc-modal #mc-save');
    await expect(saveBtn).toBeVisible({ timeout: 15000 });

    // ── e. Fill the form ────────────────────────────────────────────────────
    agencyCode = `UI-SYNC-${Date.now()}`;
    const formData = {
      code: agencyCode,
      name: 'UI Sync Test Agency',
      legalname: 'UI Sync Test Agency Pvt Ltd',
      cname: 'UI Contact',
      email: 'ui.sync@test.com',
      phone: '+91 98765 43210',
      city: 'Bangalore',
      pincode: '560001',
      notes: 'Playwright UI sync test',
    };

    await page.locator('#mc-f-code').fill(formData.code);
    await page.locator('#mc-f-name').fill(formData.name);
    await page.locator('#mc-f-legalname').fill(formData.legalname);
    await page.locator('#mc-f-cname').fill(formData.cname);
    await page.locator('#mc-f-cemail').fill(formData.email);
    await page.locator('#mc-f-phone').fill(formData.phone);
    await page.locator('#mc-f-city').fill(formData.city);
    await page.locator('#mc-f-pincode').fill(formData.pincode);
    await page.locator('#mc-f-notes').fill(formData.notes);

    // ── f. Click "Create agency" ────────────────────────────────────────────
    await saveBtn.click();

    // ── g. Wait for modal close or error ────────────────────────────────────
    const modalClosed = page.waitForSelector('#mc-modal', { state: 'hidden', timeout: 30000 });
    const formErrorVisible = page.waitForSelector('#mc-form-error:not(.hidden)', { timeout: 30000 });

    const [result] = await Promise.race([
      modalClosed.then(() => 'SUCCESS'),
      formErrorVisible.then(() => 'VALIDATION_ERROR'),
    ]);

    console.log('[E2E result]', result);

    if (result === 'VALIDATION_ERROR') {
      const errText = await page.locator('#mc-form-error').textContent();
      console.log('[E2E validation error]', errText);
    }

    // ── h. Assert agency appears in UI list ─────────────────────────────────
    await expect(page.locator('#mc-agencies')).toContainText(agencyCode, { timeout: 30000 });

    // ── i. Verify in Supabase ───────────────────────────────────────────────
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { data: cloudAgency, error } = await supabase
      .from('agencies')
      .select('id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, city, pincode, status, is_active')
      .eq('agency_code', agencyCode)
      .single();

    console.log('[Supabase query] agency_code=', agencyCode);
    console.log('[Supabase query] error=', error);
    console.log('[Supabase query] data=', JSON.stringify(cloudAgency, null, 2));

    expect(error).toBeNull();
    expect(cloudAgency).not.toBeNull();
    expect(cloudAgency.agency_code).toBe(agencyCode);
    expect(cloudAgency.name).toBe(formData.name);
    expect(cloudAgency.legal_name).toBe(formData.legalname);
    expect(cloudAgency.contact_name).toBe(formData.cname);
    expect(cloudAgency.contact_email).toBe(formData.email);
    expect(cloudAgency.city).toBe(formData.city);
    expect(cloudAgency.pincode).toBe(formData.pincode);
  });
});
