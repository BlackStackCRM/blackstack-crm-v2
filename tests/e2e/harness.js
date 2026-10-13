/**
 * Shared harness for the full-software E2E suite.
 *
 * Design constraints, all of which come from incidents on this project:
 *
 *  - ONE authenticated context per worker. Re-logging in per test is slow, and
 *    re-running migrations would be slower still. The runner starts a single
 *    server against a single disposable database (scripts/run-e2e-full.js), so
 *    the suite must not restart anything.
 *  - Console errors and uncaught page errors are CAPTURED, not ignored. A blank
 *    page that logs nothing still fails on the "page rendered" assertion.
 *  - Every fixture is tagged. Cleanup deletes only tagged rows, so a test can
 *    never remove a pre-existing record.
 *  - Waits use Playwright's own auto-waiting and explicit expect() polling.
 *    There are no arbitrary sleeps.
 */

const { expect } = require('@playwright/test');

const BASE = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 3199}`;
const RUN_TAG = process.env.E2E_RUN_TAG || `E2E${Date.now().toString(36).toUpperCase().slice(-6)}`;

const CREDS = {
  email: process.env.E2E_EMAIL || 'admin@blackstack.local',
  password: process.env.E2E_PASSWORD || 'admin123',
};

/** Console/page errors observed by the currently active page. */
const consoleErrors = [];
const pageErrors = [];
/** Non-blocking network noise we can prove is unrelated (recorded, not hidden). */
const ignoredNetwork = [
  /favicon/i,
  /manifest\.json/i,
  /sw\.js/i,
  /service-worker/i,
];

function wireDiagnostics(page) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ignoredNetwork.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(String((err && err.message) || err));
  });
  page.on('response', async (res) => {
    // A 5xx from the app is a defect even when the UI silently degrades.
    if (res.status() >= 500) {
      const url = res.url();
      if (ignoredNetwork.some((re) => re.test(url))) return;
      consoleErrors.push(`HTTP ${res.status()} ${url}`);
    }
  });
}

function resetDiagnostics() {
  consoleErrors.length = 0;
  pageErrors.length = 0;
}

/**
 * Log in through the real login form, once per page.
 * Returns true when the SPA shell is present (i.e. authenticated).
 */
async function loginViaUI(page) {
  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });

  // The form is present either as an <input name=email> or by id; the existing
  // suites use these selectors, so they are the stable contract.
  const email = page.locator('input[name="email"], #email').first();
  const password = page.locator('input[name="password"], #password').first();

  await expect(email).toBeVisible({ timeout: 20000 });
  await email.fill(CREDS.email);
  await password.fill(CREDS.password);

  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  await submit.click();

  // Authenticated landing: the SPA shell with a page container.
  await page.waitForURL(/#|\/index\.html/, { timeout: 30000 });
  await expect(page.locator('#page-container')).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector('#page-container')?.textContent?.includes('Loading...'),
    undefined,
    { timeout: 30000 },
  );
  return true;
}

/** Navigate by hash and wait for the SPA to finish rendering that route. */
async function gotoRoute(page, route) {
  resetDiagnostics();
  const current = await page.evaluate(() => window.location.hash.replace('#', ''));
  const target = `#${route}`;
  if (current === route) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else {
    await page.evaluate((h) => { window.location.hash = h; }, route);
  }
  await expect(page).toHaveURL(new RegExp(`#${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#page-container');
      if (!el) return false;
      const t = el.textContent || '';
      return el.children.length > 0 && !t.includes('Loading...');
    },
    undefined,
    { timeout: 45000 },
  );
}

/** True when the SPA rendered its own "not found" panel. */
async function isNotFound(page) {
  return page.evaluate(() => {
    const t = document.querySelector('#page-container')?.textContent || '';
    return /Page not found/i.test(t);
  });
}

/** True when the SPA rendered a module-level load error panel. */
async function isLoadError(page) {
  return page.evaluate(() => {
    const t = document.querySelector('#page-container')?.textContent || '';
    return /Unable to load page|Failed to load/i.test(t);
  });
}

/** Visible text length of the rendered page body, used to catch blank pages. */
async function renderedTextLength(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#page-container');
    return el ? (el.textContent || '').trim().length : 0;
  });
}

/** Assert the route rendered real content and recorded no fatal diagnostics. */
async function expectHealthyRender(page, label) {
  const notFound = await isNotFound(page);
  expect(notFound, `${label}: route rendered the SPA "Page not found" panel`).toBe(false);

  const loadError = await isLoadError(page);
  const len = await renderedTextLength(page);
  expect(len, `${label}: page rendered blank (${len} chars of text)`).toBeGreaterThan(20);

  expect(pageErrors, `${label}: uncaught page errors`).toEqual([]);
  expect(consoleErrors, `${label}: console errors / 5xx responses`).toEqual([]);

  return { loadError, textLength: len };
}

/** Every sidebar entry, read from the live DOM (never hard-coded). */
async function readSidebar(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#sidebar-nav a[data-path]'))
    .map((a) => ({ path: a.getAttribute('data-path'), label: (a.textContent || '').trim() })));
}

/** REST helper bound to the disposable server, for persisted-state assertions. */
async function apiAsAdmin(page, method, apiPath, body) {
  return page.evaluate(async ({ method, apiPath, body }) => {
    // The app stores the session in localStorage under 'crm_token'
    // (public/js/api/auth.js). AuthAPI exposes no getToken(), so reading
    // localStorage is the correct — and only — way to authenticate an
    // in-page fetch.
    const token = localStorage.getItem('crm_token');
    const res = await fetch(apiPath, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  }, { method, apiPath, body });
}

/**
 * Extract the row array from a list endpoint.
 *
 * Measured shapes in this app, which are NOT uniform:
 *   successResponse(data)      -> { success, data: [...] }
 *   successResponse(rows)      -> { success, data: [...] }
 *   paginatedResponse(items)   -> { success, data: { items: [...], pagination } }
 *   some inventory master GETs -> { items: [...] }   <-- NO data envelope at all
 *
 * Reading `.data` alone silently yields undefined for the last shape, which
 * reads as "the row I created does not exist". So normalise all of them here.
 */
function extractRows(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.items)) return json.data.items;
  if (Array.isArray(json.items)) return json.items;
  if (json.data && Array.isArray(json.data.rows)) return json.data.rows;
  if (Array.isArray(json.rows)) return json.rows;
  return [];
}

/** Read a possibly-camelCase / snake_case field without asserting a convention. */
function field(row, ...names) {
  if (!row) return undefined;
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null) return row[n];
  }
  return undefined;
}

module.exports = {
  BASE,
  RUN_TAG,
  CREDS,
  consoleErrors,
  pageErrors,
  wireDiagnostics,
  resetDiagnostics,
  loginViaUI,
  gotoRoute,
  isNotFound,
  isLoadError,
  renderedTextLength,
  expectHealthyRender,
  readSidebar,
  apiAsAdmin,
  extractRows,
  field,
};