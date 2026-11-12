const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { assertE2eIsolation } = require('../../scripts/assert-e2e-isolation');

const BASE_URL = `http://localhost:${process.env.E2E_PORT}`;
const FIXTURE_PASSWORD = 'RBAC-UI-Test-Password!2026';
const ACCOUNTS = {
  platform: { email: 'admin@blackstack.local', password: 'admin123' },
  agency: { email: 'rbac-ui-agency@example.test', password: FIXTURE_PASSWORD },
  sub_agency: { email: 'rbac-ui-subagency@example.test', password: FIXTURE_PASSWORD },
  customer_tenant: { email: 'rbac-ui-customer@example.test', password: FIXTURE_PASSWORD },
};

async function login(page, account) {
  await page.goto(`${BASE_URL}/login.html`);
  await page.locator('input[name="email"], #email').first().fill(account.email);
  await page.locator('input[name="password"], #password').first().fill(account.password);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('crm_token'))), { timeout: 30000 }).toBe(true);
}

async function navigate(page, route) {
  await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
  const routePattern = route === 'hierarchy'
    ? /#(?:agency-control|customer-tenants|dashboard)/
    : route === 'agency-control' ? /#(?:agency-control|customer-tenants)/
      : new RegExp(`#${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  await expect(page).toHaveURL(routePattern);
  const renderedRouteText = {
    'agency-control': /Distribution Agency Control|Customer Management|Customer Tenants|This page is not available|Agency control access required/i,
    'customer-tenants': /Customer Tenants|Agency control access required/i,
    hierarchy: /Distribution Agency Control|Customer Tenants|This page is not available/i,
    'mother-company': /Mother Company Control|This page is not available/i,
  }[route];
  await expect(page.locator('#page-container')).toContainText(renderedRouteText, { timeout: 30000 });
}

async function reportVisible(locator, label) {
  await expect(locator, label).toBeVisible();
  console.log(`[ASSERT PASS] ${label}`);
}

async function reportHidden(locator, label) {
  const visibleHtml = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible()) visibleHtml.push(await item.evaluate((element) => element.outerHTML));
  }
  expect(visibleHtml, `${label}\nVisible matching HTML:\n${visibleHtml.join('\n') || '(none)'}`).toEqual([]);
  console.log(`[ASSERT PASS] ${label}`);
}

test.beforeAll(async () => {
  // Refuse accidental browser access to the normal app port or non-disposable DB.
  const isolation = await assertE2eIsolation({ suite: 'rbac-ui.spec.js', requireFreePort: false });
  expect(isolation.port).toBe(Number(process.env.E2E_PORT));
  expect(path.basename(isolation.dbPath).toLowerCase()).toContain('e2e');
});

test('Platform / System Administrator sees all hierarchy controls', async ({ page }) => {
  await login(page, ACCOUNTS.platform);
  await reportVisible(page.locator('#sidebar-nav a[data-path="mother-company"]'), 'Platform: Mother Company Control sidebar item is visible');
  await reportVisible(page.locator('#sidebar-nav a[data-path="users"]'), 'Platform: Users sidebar item is visible');
  await navigate(page, 'agency-control');
  await reportVisible(page.locator('#ac-create-agency'), 'Platform: Create Sub-agency control is visible');
  await reportVisible(page.locator('#ac-create-customer'), 'Platform: Create customer tenant control is visible');
  await navigate(page, 'mother-company');
  await reportVisible(page.getByRole('heading', { name: /Mother Company Control/i }), 'Platform: Mother Company Control is accessible');
  await navigate(page, 'hierarchy');
  await reportVisible(page.locator('#ac-create-agency'), 'Platform: legacy My Hierarchy route opens the canonical Agency Control page');
  await reportHidden(page.locator('#h-create-sub, #h-create-cust'), 'Platform: duplicate My Hierarchy controls are absent');
});

test('Distribution Agency sees agency controls but not Mother Company Control', async ({ page }) => {
  await login(page, ACCOUNTS.agency);
  await reportVisible(page.locator('#sidebar-nav a[data-path="agency-control"]'), 'Agency: Agency Control sidebar item is visible');
  await reportHidden(page.locator('#sidebar-nav a[data-path="hierarchy"]'), 'Agency: duplicate My Hierarchy sidebar item is hidden');
  await reportHidden(page.locator('#sidebar-nav a[data-path="mother-company"]'), 'Agency: Mother Company Control sidebar item is hidden');
  await reportVisible(page.locator('#sidebar-nav a[data-path="users"]'), 'Agency: Users sidebar item remains available to the agency operator');
  await navigate(page, 'agency-control');
  await reportVisible(page.locator('#ac-create-agency'), 'Agency: Create Sub-agency control is visible');
  await reportVisible(page.locator('#ac-create-customer'), 'Agency: Create customer tenant control is visible');
  await navigate(page, 'mother-company');
  await reportVisible(page.getByText(/This page is not available for your role|Access denied|not authorized/i), 'Agency: Mother Company route is denied');
});

test('Sub-agency sees customer controls only', async ({ page }) => {
  await login(page, ACCOUNTS.sub_agency);
  // Simulate the exact stale profile that caused the screenshot: agency_role
  // cached as `agency` even though the server resolves the active SUB-* link.
  await page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem('crm_user') || '{}');
    user.hierarchyRole = 'agency';
    localStorage.setItem('crm_user', JSON.stringify(user));
    window.location.hash = '#agency-control';
  });
  await expect(page).toHaveURL(/#customer-tenants/);
  await reportVisible(page.getByRole('heading', { name: 'Customer Tenants', exact: true }), 'Sub-agency: stale cached agency role is refreshed before page rendering');
  await reportHidden(page.locator('#sidebar-nav a[data-path="agency-control"]'), 'Sub-agency: hierarchy controls are not shown in navigation');
  await reportHidden(page.locator('#sidebar-nav a[data-path="hierarchy"]'), 'Sub-agency: duplicate My Hierarchy sidebar item is hidden');
  await reportVisible(page.locator('#sidebar-nav a[data-path="customer-tenants"]'), 'Sub-agency: Customer Tenants sidebar item is visible');
  await reportHidden(page.locator('#sidebar-nav a[data-path="mother-company"]'), 'Sub-agency: Mother Company Control sidebar item is hidden');
  await reportHidden(page.locator('#sidebar-nav a[data-path="users"]'), 'Sub-agency: Users sidebar item is hidden');
  await navigate(page, 'agency-control');
  await reportVisible(page.getByRole('heading', { name: 'Customer Tenants', exact: true }), 'Sub-agency: direct Agency Control route redirects to customer-only management');
  await navigate(page, 'customer-tenants');
  await reportHidden(page.locator('#ac-create-agency'), 'Sub-agency: Create Sub-agency control is hidden');
  await reportHidden(page.locator('#ac-agencies, #ac-agencies table, #ac-agency-name'), 'Sub-agency: Sub-agencies list and form are hidden');
  await reportVisible(page.locator('#ac-create-customer'), 'Sub-agency: Create customer tenant control is visible');
  await reportVisible(page.getByRole('heading', { name: 'Customer Tenants', exact: true }), 'Sub-agency: page title is Customer Tenants');
  await reportHidden(page.getByRole('heading', { name: 'Distribution Agency Control' }), 'Sub-agency: Distribution Agency Control title is absent');
  const forbiddenCreate = await page.evaluate(async () => {
    const token = localStorage.getItem('crm_token');
    const response = await fetch('/api/agency-control/sub-agencies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Unauthorized child agency' }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(forbiddenCreate.status, `Sub-agency API must reject sub-agency creation: ${JSON.stringify(forbiddenCreate.body)}`).toBe(403);
  console.log('[ASSERT PASS] Sub-agency: API rejects creating another sub-agency with 403');
  await navigate(page, 'hierarchy');
  await reportVisible(page.getByRole('heading', { name: 'Customer Tenants', exact: true }), 'Sub-agency: legacy My Hierarchy route redirects to customer-only management');
  await reportHidden(page.locator('#ac-create-agency, #h-create-sub'), 'Sub-agency: no sub-agency creation control appears on the canonical page');
});

test('Customer Tenant cannot access hierarchy navigation or Agency Control', async ({ page }) => {
  await login(page, ACCOUNTS.customer_tenant);
  await reportHidden(page.locator('#sidebar-nav a[data-path="agency-control"]'), 'Customer: Agency Control sidebar item is hidden');
  await reportHidden(page.locator('#sidebar-nav a[data-path="hierarchy"]'), 'Customer: My Hierarchy sidebar item is hidden');
  await reportHidden(page.locator('#sidebar-nav a[data-path="mother-company"]'), 'Customer: Mother Company Control sidebar item is hidden');
  await reportHidden(page.locator('#sidebar-nav a[data-path="users"]'), 'Customer: Users sidebar item is hidden');
  await navigate(page, 'agency-control');
  await reportVisible(page.getByText(/This page is not available for your role|Agency control access required|Access denied|not authorized/i), 'Customer: direct Agency Control route is denied');
});

test('Platform sees existing customer-account recovery actions after duplicate email', async ({ page }) => {
  await login(page, ACCOUNTS.platform);
  await navigate(page, 'agency-control');
  const customerAction = page.locator('#ac-customers [data-customer-actions]').first();
  await expect(customerAction, 'A customer row is required for the Add Admin recovery flow').toBeVisible();
  await customerAction.click();
  await page.locator('#ac-customers [data-cust-action="add-customer-admin"]').first().click();

  await page.locator('#ac-ca-name').fill('Existing Customer Admin');
  await page.locator('#ac-ca-email').fill('already-assigned@example.test');
  await page.locator('#ac-ca-user').fill('already-assigned@example.test');
  await page.locator('#ac-ca-pass').fill('Disposable-Test-Password-123');

  await page.route('**/api/agency-control/customers/*/administrators', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Admin validation failed.',
          fields: { email: 'A user with this email/username already exists.' },
        },
      }),
    });
  });

  await page.locator('#ac-ca-save').click();
  await expect(page.locator('#ac-ca-error')).toContainText('A user with this email/username already exists.');
  await reportVisible(page.getByRole('button', { name: 'Assign existing account here' }), 'Platform: duplicate account offers reassignment to this customer');
  await reportVisible(page.getByRole('button', { name: 'Permanently remove account' }), 'Platform: duplicate account offers permanent login removal');
  await expect(page.locator('#ac-ca-error')).toContainText('CRM records remain with the current company');
});

test('Platform can create a customer administrator for a listed tenant', async ({ page }) => {
  await login(page, ACCOUNTS.platform);
  await navigate(page, 'agency-control');
  const customerAction = page.locator('#ac-customers [data-customer-actions]').first();
  await expect(customerAction, 'A customer row is required for the customer administrator flow').toBeVisible();
  await customerAction.click();
  await page.locator('#ac-customers [data-cust-action="add-customer-admin"]').first().click();

  await page.locator('#ac-ca-name').fill('Playwright Customer Admin');
  await page.locator('#ac-ca-email').fill('playwright-customer-admin@example.test');
  await page.locator('#ac-ca-user').fill('playwright-customer-admin@example.test');
  await page.locator('#ac-ca-pass').fill('Disposable-Test-Password-123');

  const creationResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && /\/api\/agency-control\/customers\/[^/]+\/administrators$/.test(new URL(response.url()).pathname));
  await page.locator('#ac-ca-save').click();
  const response = await creationResponse;
  const body = await response.json();
  expect(response.status(), `Customer administrator creation response: ${JSON.stringify(body)}`).toBe(201);
  await expect(page.locator('#ac-modal')).toBeEmpty();
  await expect(page.getByText('Customer administrator assigned successfully.')).toBeVisible();
  console.log('[ASSERT PASS] Platform: customer administrator POST returned 201 and the modal closed');
});

test('Customer View Details loads read-only tenant and agency information', async ({ page }) => {
  await login(page, ACCOUNTS.platform);
  await navigate(page, 'agency-control');
  await page.route('**/api/agency-control/customers/cmp_e2e_rbac_ui_customer', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  const action = page.locator('#ac-customers [data-customer-actions]').first();
  await action.click();
  await page.locator('#ac-customers [data-cust-action="view-details"]').first().click();
  const dialog = page.getByRole('dialog', { name: 'Customer details' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Loading customer details');
  await expect(dialog).toContainText('RBAC UI E2E Customer');
  await expect(dialog).toContainText('RBAC UI E2E Agency');
  await expect(dialog).toContainText('Date created');
  await expect(dialog.locator('#ac-customer-details-close')).toBeVisible();
  await expect(dialog.locator('input, select, textarea, button:not(#ac-customer-details-close):not(#ac-customer-details-close-top)')).toHaveCount(0);
  await dialog.locator('#ac-customer-details-close').click();
  await expect(page.locator('#ac-customer-details-modal')).toHaveCount(0);
  console.log('[ASSERT PASS] Platform: View Details shows scoped tenant data in a read-only modal');
});

test('Sub-agency receives 403 for a customer outside its hierarchy', async ({ page }) => {
  await login(page, ACCOUNTS.sub_agency);
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem('crm_token');
    const response = await fetch('/api/agency-control/customers/cmp_e2e_rbac_ui_customer', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status, `Cross-agency detail access response: ${JSON.stringify(result.body)}`).toBe(403);
  console.log('[ASSERT PASS] Sub-agency: out-of-scope customer details request returned 403');
});
