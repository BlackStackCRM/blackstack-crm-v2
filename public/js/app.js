(function () {
  'use strict';

  let sidebar = null;
  let topbar = null;
  let currentCleanup = null;

  const routes = {
    'dashboard': { module: 'dashboard' },
    // Mother Company control dashboard. Navigation is hidden from users without a
    // mother_company.* permission, but the API guards are what actually protect
    // it — reaching this route directly yields an empty shell and 403s.
    'mother-company': { module: 'motherCompany' },
    'wallet': { module: 'wallet' },
    'subscriptions': { module: 'subscriptions' },
    'storage': { module: 'storage' },
    'agency-control': { module: 'agencyControl' },
    'customer-tenants': { module: 'agencyControl', mode: 'customers-only' },
    // Role-scoped hierarchy management (agency / sub_agency only).
    'hierarchy': { module: 'hierarchy' },
    // Forced password change (must_change_password accounts only — the guard
    // below blocks every other route until the flag clears).
    'change-password': { module: 'changePassword' },
    'leads': { module: 'leads' },
    'leads/:id': { module: 'leadDetail', param: 'id' },
    'contacts': { module: 'contacts' },
    'contacts/:id': { module: 'contactDetail', param: 'id' },
    'organizations': { module: 'organizations' },
    'activities': { module: 'activities' },
    'deals': { module: 'deals' },
    'deals/:id': { module: 'dealDetail', param: 'id' },
    'tasks': { module: 'tasks' },
    'appointments': { module: 'appointments' },
    'action-center': { module: 'actionCenter' },
    'invoices': { module: 'accounting' },
    'invoices/:id': { module: 'accounting' },
    'products': { module: 'products' },
    'products/:id': { module: 'products' },
    'inventory': { module: 'inventory' },
    'inventory/:key': { module: 'inventorySub', param: 'key' },
    'payments': { module: 'accounting' },
    'notes': { module: 'notes' },
    'workflows': { module: 'workflows' },
    'reports': { module: 'accounting-reports' },
    // Accounting & Finance routes
    'accounting': { module: 'accounting' },
    'accounting/:subsection': { module: 'accountingSub' },
    'accounting/chart-of-accounts': { module: 'chartOfAccounts' },
    'accounting/journal': { module: 'journal' },
    'accounting/journal/:id': { module: 'journal', param: 'id', sub: true },
    'accounting/bills': { module: 'bills' },
    'accounting/bills/:id': { module: 'bills', param: 'id', sub: true },
    'customer-bills': { module: 'customer-bills' },
    'customer-bills/:id': { module: 'customer-bills', param: 'id', sub: true },
    'customer-bills/new': { module: 'customer-bills' },
    'accounting/receivables': { module: 'receivables' },
    'accounting/payables': { module: 'payables' },
    'accounting/outstanding': { module: 'outstanding' },
    'accounting/ledger/:id': { module: 'ledger', param: 'accountId' },
    'accounting/ledger-detail': { module: 'ledgerDetail' },
    'accounting/cost-centres': { module: 'costCentres' },
    'accounting/cost-categories': { module: 'costCategories' },
    'accounting/budgets': { module: 'budgets' },
    'accounting/bank-accounts': { module: 'bankAccounts' },
    'users': { module: 'users' },
    'settings': { module: 'settings' },
    'profile': { module: 'profile' },
    'search': { module: 'search' },
    '404': { module: '404' },
    '403': { module: '403' },
    '500': { module: '500' },
    '401': { module: '401' },
  };

  function resolveRoute(hash) {
    const [path, query] = hash.split('?');
    const params = {};
    if (query) {
      query.split('&').forEach(kv => {
        const [k, v] = kv.split('=');
        params[k] = decodeURIComponent(v || '');
      });
    }
    if (routes[path]) return { ...routes[path], params };
    for (const pattern in routes) {
      if (pattern.includes(':')) {
        const re = new RegExp('^' + pattern.replace(/:\w+/, '([^/]+)') + '$');
        const m = path.match(re);
        if (m) {
          const paramName = pattern.split(':')[1];
          return { ...routes[pattern], params: { ...params, [paramName]: m[1] } };
        }
      }
    }
    return null;
  }

  async function init() {
    const pathname = window.location.pathname;
    if (pathname.endsWith('login.html') || pathname === '/login') return;
    // The sidebar refreshes the authoritative profile before rendering. Wait
    // for that refresh so a stale cached hierarchyRole cannot briefly open an
    // Agency Control page with controls from the previous role.
    if (sidebar && sidebar.ready) await sidebar.ready;
    if (!AuthAPI.isAuthenticated()) {
      window.location.href = '/login.html';
      return;
    }
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    loadPage(hash);
  }

  async function loadPage(hash) {
    const main = document.getElementById('page-container');
    if (!main) return;

    // FIX (sub-agency login loop): an account created by its parent signs in
    // with a ONE-TIME password and must_change_password = true. Until that
    // flag is cleared, every other route is blocked and the operator is held
    // on the Change Password screen. Without this guard the app loads the
    // dashboard, whose API calls can fail for the half-provisioned identity,
    // and the 401/403 interceptor bounces the user back to login — the loop.
    let cpUser = null;
    try { cpUser = JSON.parse(localStorage.getItem('crm_user') || 'null'); } catch {}
    if (cpUser && cpUser.mustChangePassword && hash !== 'change-password') {
      window.location.hash = '#change-password';
      loadPage('change-password');
      return;
    }
    if (cpUser && cpUser.mustChangePassword && hash === 'change-password') {
      // allowed — fall through to normal rendering
    }

    if (currentCleanup) {
      try { currentCleanup(); } catch (e) {}
      currentCleanup = null;
    }

    main.innerHTML = `
      <div class="flex items-center justify-center py-20">
        <div class="flex flex-col items-center gap-3">
          <span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Loading...</p>
        </div>
      </div>
    `;

    const resolved = resolveRoute(hash);

    if (!resolved || !window.PageModules || !window.PageModules[resolved.module]) {
      main.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-center">
          <span class="material-symbols-outlined text-[48px] text-on-surface-variant/40 mb-2">search_off</span>
          <p class="font-display text-h1 text-on-surface mb-2">Page not found</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">The page "${hash}" does not exist.</p>
          <a href="#dashboard" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Back to Dashboard</a>
        </div>
      `;
      if (sidebar) sidebar.setActive('dashboard');
      return;
    }

    const rolePermissions = window.RolePermissions;
    if (rolePermissions) {
      const path = hash.split('?')[0];
      const roleProtectedPaths = new Set([
        'mother-company', 'agency-control', 'customer-tenants', 'hierarchy', 'users', 'settings', 'storage',
      ]);
      // Refresh the server role before opening a protected page. The local
      // profile can outlive an agency reassignment or a role repair.
      if (roleProtectedPaths.has(path) && window.AuthAPI?.getProfile) {
        try {
          const profile = await window.AuthAPI.getProfile();
          if (profile) {
            localStorage.setItem('crm_user', JSON.stringify(profile));
            if (sidebar) sidebar.render();
          }
        } catch {
          main.innerHTML = '<div class="max-w-lg mx-auto mt-12 text-center"><h1 class="font-display text-h2">Could not verify your current role. Please try again.</h1><a class="inline-block mt-4 underline" href="#dashboard">Return to Dashboard</a></div>';
          if (sidebar) sidebar.setActive('dashboard');
          return;
        }
      }
      const role = rolePermissions.role();
      // Agency Control is the single network-management interface for
      // platform/distribution roles. Sub-agencies use its customer-only view.
      // Keep the old hash links working by redirecting them to the canonical
      // menu/page for the signed-in role.
      if (path === 'hierarchy' || (path === 'agency-control' && role === 'sub_agency')) {
        const destination = role === 'platform' || role === 'agency'
          ? 'agency-control'
          : role === 'sub_agency' ? 'customer-tenants' : 'dashboard';
        window.location.hash = `#${destination}`;
        loadPage(destination);
        return;
      }
      const restricted = {
        'mother-company': rolePermissions.canViewMotherCompany(),
        subscriptions: rolePermissions.hasRole('platform'),
        storage: rolePermissions.hasRole('platform'),
        'agency-control': rolePermissions.canViewAgencyControl(),
        users: rolePermissions.canViewUsers(),
        settings: rolePermissions.canViewSettings(),
        'customer-tenants': rolePermissions.canViewCustomerTenants(),
      };
      if (Object.prototype.hasOwnProperty.call(restricted, path) && !restricted[path]) {
        main.innerHTML = '<div class="max-w-lg mx-auto mt-12 text-center"><h1 class="font-display text-h2">This page is not available for your role.</h1><a class="inline-block mt-4 underline" href="#dashboard">Return to Dashboard</a></div>';
        if (sidebar) sidebar.setActive('dashboard');
        return;
      }
    }

    try {
      const moduleFn = window.PageModules[resolved.module].init.bind(window.PageModules[resolved.module]);
      let arg = resolved.mode || null;
      if (resolved.module === 'contactDetail' || resolved.module === 'dealDetail' || resolved.module === 'journal' || resolved.module === 'bills') {
        arg = resolved.params && resolved.params.id;
      } else if (resolved.module === 'search') {
        arg = resolved.params;
      } else if (resolved.module === 'customer-bills') {
        arg = resolved.params && (resolved.params.id || null);
      } else if (resolved.module === 'inventorySub') {
        arg = hash;
      } else if (resolved.module === 'products') {
        arg = resolved.params && resolved.params.id ? resolved.params.id : null;
      }
      const cleanup = await moduleFn(arg);
      currentCleanup = typeof cleanup === 'function' ? cleanup : null;
      if (sidebar) {
        let base;
        if (resolved.module === 'accountingSub') {
          base = hash.split('/')[0] + '/' + (hash.split('/')[1] || '');
        } else {
          base = hash.split('/')[0].split('?')[0];
        }
        sidebar.setActive(base);
      }
    } catch (err) {
      main.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-center">
          <span class="material-symbols-outlined text-[48px] text-on-surface-variant/40 mb-2">error</span>
          <p class="font-body-md text-body-md text-on-surface mb-2">Unable to load page</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant">${err.message || 'Unknown error'}</p>
        </div>
      `;
    }
  }

  function initRouter() {
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '') || 'dashboard';
      loadPage(hash);
    });
    window.addEventListener('page:navigate', (e) => {
      if (e.detail && e.detail.path) loadPage(e.detail.path);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    sidebar = new Sidebar('sidebar');
    topbar = new Topbar();
    initRouter();
    init();
  });
})();
