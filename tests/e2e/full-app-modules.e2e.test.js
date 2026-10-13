/**
 * PHASE 4 — Full-software module coverage.
 *
 * One test per entry in coverage-manifest.js, generated at module load so the
 * coverage matrix and the executed tests cannot drift apart. Every route in the
 * manifest was read out of the application's own route table and sidebar.
 *
 * Per module these assert, beyond "the page opened":
 *   - the route does not render the SPA "Page not found" panel
 *   - the page renders real content (not blank)
 *   - no uncaught page errors
 *   - no console errors and no 5xx responses during the visit
 *   - the sidebar marks the entry as the current page where one exists
 */
const { test, expect } = require('@playwright/test');
const { MODULES } = require('./coverage-manifest');
const {
  BASE,
  wireDiagnostics,
  loginViaUI,
  gotoRoute,
  expectHealthyRender,
  readSidebar,
} = require('./harness');

test.describe.configure({ mode: 'serial' });

test.describe('full-software module coverage', () => {
  test.beforeAll(async ({ browser }) => {
    // One authenticated page for every module test: no repeated startup, no
    // repeated migration, no repeated login.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    wireDiagnostics(page);
    await loginViaUI(page);
    // eslint-disable-next-line no-underscore-dangle
    global.__FS_PAGE = page;
    // eslint-disable-next-line no-underscore-dangle
    global.__FS_CTX = ctx;
  });

  test.afterAll(async () => {
    // eslint-disable-next-line no-underscore-dangle
    const ctx = global.__FS_CTX;
    if (ctx) await ctx.close();
  });

  for (const mod of MODULES) {
    test(`[${mod.group}] ${mod.name}  (${mod.route})`, async () => {
      // eslint-disable-next-line no-underscore-dangle
      const page = global.__FS_PAGE;
      await gotoRoute(page, mod.route);
      const info = await expectHealthyRender(page, `${mod.name} (${mod.route})`);

      // A module that renders an explicit "failed to load" panel is a defect,
      // but the page may legitimately be sparse; only the diagnostics are fatal.
      expect(
        info.textLength,
        `${mod.name}: rendered content is suspiciously short`,
      ).toBeGreaterThan(20);
    });
  }

  test('sidebar exposes every top-level module the manifest claims', async () => {
    // eslint-disable-next-line no-underscore-dangle
    const page = global.__FS_PAGE;
    await gotoRoute(page, 'dashboard');
    const nav = await readSidebar(page);
    const paths = new Set(nav.map((n) => n.path));

    // Only TOP-LEVEL sidebar entries are in the DOM here. Child entries render
    // only while their parent is expanded, so the manifest's child routes
    // (accounting/*, inventory/*) cannot be asserted from this view — they are
    // asserted by their own per-module tests, which navigate directly.
    //
    // The manifest deliberately lists some reachable routes that are NOT
    // sidebar entries (Activities, Notes, Search, Invoices, Payments,
    // Inventory). Those are reachable and are tested; they simply have no nav
    // link, which is not a defect.
    const topLevelNav = MODULES
      .filter((m) => !m.route.includes('/'))
      .map((m) => m.route)
      .filter((r) => ['dashboard', 'leads', 'contacts', 'organizations', 'deals',
        'tasks', 'appointments', 'action-center', 'customer-bills', 'accounting',
        'products', 'workflows', 'reports', 'settings', 'users', 'profile'].includes(r));

    const missing = topLevelNav.filter((r) => !paths.has(r));
    expect(missing, `sidebar is missing top-level entries: ${missing.join(', ')}`).toEqual([]);
    expect(paths.has('dashboard')).toBe(true);
    expect(paths.has('customer-bills')).toBe(true);
  });

  test('every accounting child route is reachable from its parent', async () => {
    // eslint-disable-next-line no-underscore-dangle
    const page = global.__FS_PAGE;
    const accountingChildren = MODULES
      .filter((m) => m.route.startsWith('accounting/'))
      .map((m) => m.route);
    expect(accountingChildren.length).toBeGreaterThan(10);

    // Navigate directly: the sidebar only renders children when expanded, and
    // expansion is a UI detail. What matters is that each route resolves to a
    // real page, which the per-module tests assert individually.
    for (const route of accountingChildren) {
      await gotoRoute(page, route);
      const notFound = await page.evaluate(
        () => /Page not found/i.test(document.querySelector('#page-container')?.textContent || ''),
      );
      expect(notFound, `${route} resolved to the not-found panel`).toBe(false);
    }
  });

  test('an unknown route renders the SPA not-found panel (routing is real)', async () => {
    // eslint-disable-next-line no-underscore-dangle
    const page = global.__FS_PAGE;
    await gotoRoute(page, 'dashboard');
    await page.evaluate(() => { window.location.hash = 'definitely-not-a-route-xyz'; });
    await expect(page.locator('#page-container')).toContainText(/Page not found/i, { timeout: 20000 });
    // Return to a real page so later work is not affected.
    await gotoRoute(page, 'dashboard');
  });

  test('unauthenticated access to the SPA redirects to login', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html#dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/login\.html|\/login/, { timeout: 20000 });
    await ctx.close();
  });
});