/**
 * MOTHER COMPANY — FRONTEND GATING TESTS
 *
 * These assert the UI contract only. They are NOT the security boundary: the
 * backend guards in tests/mother-company-auth.test.js are. What is pinned here is
 * that the client never shows Mother Company navigation or data to a user who
 * lacks the permission, and never invents figures when the API returns none.
 *
 * The page module is plain browser JS with no build step, so it is loaded into a
 * minimal DOM stub and driven directly.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'mother-company.js'), 'utf8');
const SIDEBAR_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'components', 'Sidebar.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/**
 * Load the page module with a controllable session + API.
 *
 * `hosts` is a mutable id -> element map. The module closes over the `document`
 * object supplied here, so tests must register elements in this SAME object
 * rather than replacing a global afterwards.
 */
function loadPage({ permissions = [], api = {}, hosts = {} } = {}) {
  const store = { crm_user: JSON.stringify({ permissions }) };
  const hostMap = hosts;
  const fakeDocument = {
    getElementById: (id) => (id in hostMap ? hostMap[id] : null),
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }),
  };
  const sandbox = {
    window: {
      PageModules: {},
      API: {
        get: api.get || (() => Promise.resolve({})),
        post: api.post || (() => Promise.resolve({})),
      },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
    document: fakeDocument,
    console,
    setTimeout,
    clearTimeout,
    prompt: () => 'test reason',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PAGE_SRC, sandbox);
  return {
    page: sandbox.window.PageModules.motherCompany,
    sandbox,
    hosts: hostMap,
    /** Register a capturing host element for the given id. */
    mount(id) {
      let captured = '';
      hostMap[id] = {
        set innerHTML(v) { captured = v; },
        get innerHTML() { return captured; },
        querySelectorAll: () => [],
        addEventListener() {},
        classList: { add() {}, remove() {} },
      };
      return () => captured;
    },
  };
}

describe('Mother Company page — access gating', () => {
  test('a user with no permissions sees a refusal, not a dashboard', async () => {
    const { page, mount } = loadPage({ permissions: ['contacts.view', 'deals.edit'] });
    const read = mount('page-container');
    await page.init();
    const html = read();
    expect(html).toMatch(/access required/i);
    // It must not have rendered the agency UI.
    expect(html).not.toMatch(/New agency/);
    expect(html).not.toMatch(/id="mc-stats"/);
  });

  test('a user with a Mother Company permission is not blocked', async () => {
    const { page, mount } = loadPage({ permissions: ['mother_company.view'] });
    const read = mount('page-container');
    await page.init();
    const html = read();
    expect(html).toMatch(/BlackStack — Mother Company Control/);
  });

  test('permissions are read defensively; malformed storage is treated as none', () => {
    const { page } = loadPage({ permissions: 'not-an-array' });
    // A non-array permissions value must not throw and must not grant access.
    expect(() => page.currentPermissions()).not.toThrow();
    expect(page.currentPermissions()).toEqual([]);
    expect(page.can('mother_company.agencies.create')).toBe(false);
  });

  test('the wildcard ["*"] does not unlock Mother Company UI controls', () => {
    // Mirrors the server guard: a customer admin's session carries '*', and that
    // must not be treated as a Mother Company grant.
    const { page } = loadPage({ permissions: ['*'] });
    expect(page.currentPermissions()).toEqual([]);
    expect(page.can('mother_company.agencies.create')).toBe(false);
  });

  test('creation and status controls appear only with the matching permission', () => {
    const viewer = loadPage({ permissions: ['mother_company.agencies.view'] }).page;
    expect(viewer.can('mother_company.agencies.create')).toBe(false);

    const creator = loadPage({
      permissions: ['mother_company.agencies.view', 'mother_company.agencies.create'],
    }).page;
    expect(creator.can('mother_company.agencies.create')).toBe(true);
  });
});

describe('Mother Company page — honesty about data', () => {
  test('zero agencies renders an explicit empty state, never sample rows', () => {
    const { page, mount } = loadPage({ permissions: ['mother_company.view'] });
    const read = mount('mc-agencies');
    page.agencies = [];
    page.renderAgencies();
    const html = read();
    expect(html).toMatch(/No distribution agencies yet/i);
    // No fabricated agency codes, names or sample rows of any kind.
    expect(html).not.toMatch(/AGY-[A-Z0-9]/);
    expect(html).not.toMatch(/Demo|Sample|Example Ltd/i);
  });

  test('real agencies render with their code, name and status', () => {
    const { page, mount } = loadPage({
      permissions: ['mother_company.view', 'mother_company.agencies.status'],
    });
    const read = mount('mc-agencies');
    page.agencies = [{
      id: 'a1', agencyCode: 'AGY-REAL', name: 'Real Agency',
      contactName: 'X', contactEmail: 'x@y.z', status: 'ACTIVE',
    }];
    page.renderAgencies();
    const html = read();
    expect(html).toMatch(/AGY-REAL/);
    expect(html).toMatch(/Real Agency/);
    expect(html).toMatch(/ACTIVE/);
    expect(html).toMatch(/Suspend/); // status control present with the permission
  });

  test('license panel marks pending state and never renders zeros', () => {
    const { page, mount } = loadPage({ permissions: ['mother_company.view'] });
    const read = mount('mc-licenses');
    page.renderLicenses({
      implemented: false,
      reason: 'Central License Server is scheduled for a later phase.',
    });
    const html = read();
    expect(html).toMatch(/Pending/);
    expect(html).toMatch(/later phase/i);
    // Zeros would read as "licenses are tracked and there are none".
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  test('stats render the exact figures the API returned', () => {
    const { page, mount } = loadPage({ permissions: ['mother_company.view'] });
    const read = mount('mc-stats');
    page.renderStats({
      totalAgencies: 3, activeAgencies: 1, pendingAgencies: 2, activeAdministrators: 4,
    });
    const html = read();
    expect(html).toMatch(/>3</);
    expect(html).toMatch(/>1</);
    expect(html).toMatch(/>2</);
    expect(html).toMatch(/>4</);
  });

  test('output is escaped so an agency name cannot inject markup', () => {
    const { page } = loadPage({ permissions: ['mother_company.view'] });
    const esc = page.esc.bind(page);
    expect(esc('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(esc('a"b\'c')).toBe('a&quot;b&#39;c');
  });
});

describe('Mother Company wiring', () => {
  test('the route is registered in the frontend router', () => {
    expect(APP_SRC).toMatch(/'mother-company':\s*\{\s*module:\s*'motherCompany'/);
  });

  test('the page module is actually loaded by index.html', () => {
    // Page modules are read from window.PageModules, which only exists if the
    // script tag is present. Without it the route silently resolves to nothing.
    expect(INDEX_SRC).toMatch(/\/js\/pages\/mother-company\.js/);
  });

  test('the sidebar entry is permission-gated, not unconditional', () => {
    expect(SIDEBAR_SRC).toMatch(/requiresAnyPermission:\s*'mother_company\.'/);
    expect(SIDEBAR_SRC).toMatch(/visibleItems\(\)/);
  });

  test('the page does not contain any hard-coded email or password', () => {
    expect(PAGE_SRC).not.toMatch(/admin@blackstack\.lockal/i);
    expect(PAGE_SRC.toLowerCase()).not.toMatch(/password\s*[:=]\s*['"][^'"]+['"]/i);
  });
});

// helper: clear the module's cached permission read
function sandboxReset(page) {
  // currentPermissions() reads localStorage each call, so nothing is cached.
  return page;
}