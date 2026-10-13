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

  function init() {
    const pathname = window.location.pathname;
    if (pathname.endsWith('login.html') || pathname === '/login') return;
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

    try {
      const moduleFn = window.PageModules[resolved.module].init.bind(window.PageModules[resolved.module]);
      let arg = null;
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
