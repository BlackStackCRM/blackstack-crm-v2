window.PageModules = window.PageModules || {};

window.PageModules.accountingSub = {
  async init() {
    const hash = window.location.hash.replace('#', '');
    const parts = hash.split('/');
    const subsection = parts[1] || 'dashboard';

    const routes = {
      'dashboard': 'accounting',
      'chart-of-accounts': 'chartOfAccounts',
      'journal': 'journal',
      'bills': 'bills',
      'receivables': 'receivables',
      'payables': 'payables',
      'outstanding': 'outstanding',
      'ledger': 'ledger',
      'reports': 'accounting-reports',
      'cost-centres': 'costCentres',
      'cost-categories': 'costCategories',
      'budgets': 'budgets',
      'bank-accounts': 'bankAccounts',
    };

    const target = routes[subsection];
    if (!target || !window.PageModules[target]) {
      document.getElementById('page-container').innerHTML = `<p>Not found</p>`;
      return () => {};
    }

    const arg = (target === 'journal' && parts[2]) ? parts[2] : null;
    const cleanup = await window.PageModules[target].init(arg);
    return typeof cleanup === 'function' ? cleanup : (() => {});
  }
};

window.PageModules.accounting = {
  currentCurrency: 'INR',
  state: { dateFrom: '', dateTo: '' },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    await AccountingState.init();
    this.currentCurrency = AccountingState.currentCurrency;

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Accounting &amp; Finance</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Double-entry bookkeeping, ledgers, receivables, payables, and financial reports.</p>
          </div>
          <div class="flex items-center gap-stack-sm">
            <input id="acc-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="acc-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <button id="acc-refresh" class="flex items-center gap-1 bg-secondary/10 text-secondary px-3 py-2 rounded-lg hover:bg-secondary/20">
              <span class="material-symbols-outlined text-[18px]">refresh</span>
            </button>
          </div>
        </div>

        <div id="acc-dashboard-stats" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-stack-md"></div>

        <div id="acc-dashboard-charts" class="grid grid-cols-1 lg:grid-cols-2 gap-stack-md"></div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => {};
  },

  bindEvents() {
    document.getElementById('acc-refresh').addEventListener('click', () => this.load());
    document.getElementById('acc-from').addEventListener('change', (e) => { this.state.dateFrom = e.target.value; this.load(); });
    document.getElementById('acc-to').addEventListener('change', (e) => { this.state.dateTo = e.target.value; this.load(); });
  },

  async load() {
    try {
      const params = {};
      if (this.state.dateFrom) params.start_date = this.state.dateFrom;
      if (this.state.dateTo) params.end_date = this.state.dateTo;

      const [dashRes] = await Promise.all([
        API.get('/accounting/dashboard', params)
      ]);
      const d = dashRes?.data || dashRes || {};

      this.renderStats(d);
      this.renderCharts(d);
    } catch (err) {
      const container = document.getElementById('acc-dashboard-stats');
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-error">error</span><p class="text-on-surface-variant mt-2">' + (err.message || 'Failed to load dashboard') + '</p></div>';
    }
  },

  renderStats(d) {
    const container = document.getElementById('acc-dashboard-stats');
    container.innerHTML = [
      this.metricCard('Cash Balance', this.fmt(d.cash_balance), 'account_balance', 'bg-blue-100 text-blue-700'),
      this.metricCard('Total Receivables', this.fmt(d.total_receivables), 'trending_up', 'bg-green-100 text-green-700'),
      this.metricCard('Total Payables', this.fmt(d.total_payables), 'trending_down', 'bg-red-100 text-red-700'),
      this.metricCard('Net Profit', this.fmt(d.net_profit), 'analytics', 'bg-purple-100 text-purple-700'),
    ].join('');
  },

  metricCard(label, value, icon, colorClass) {
    return `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
        <div class="flex items-center gap-stack-sm">
          <span class="material-symbols-outlined text-[24px] ${colorClass}">${icon}</span>
          <div>
            <p class="font-body-sm text-body-sm text-on-surface-variant">${label}</p>
            <p class="font-display text-h1 text-on-surface">${value}</p>
          </div>
        </div>
      </div>
    `;
  },

  renderCharts(d) {
    const container = document.getElementById('acc-dashboard-charts');
    const monthlyRevenue = d.monthly_revenue_trend || [];
    const monthlyExpense = d.monthly_expense_trend || [];

    const data = monthlyRevenue.map((r, i) => ({
      period: r.period,
      revenue: parseFloat(r.revenue || 0),
      expense: parseFloat(monthlyExpense[i]?.expense || 0)
    }));

    container.innerHTML = `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
        <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Revenue vs Expenses</h3>
        <div id="acc-chart-revenue" class="h-[240px]"></div>
      </div>
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
        <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Receivable Aging</h3>
        <div id="acc-aging" class="space-y-2"></div>
      </div>
    `;

    // Render simple bar chart using canvas-free approach (CSS bars)
    const chartEl = document.getElementById('acc-chart-revenue');
    if (data.length > 0) {
      const max = Math.max(...data.map(d => Math.max(d.revenue, d.expense)), 1);
      chartEl.innerHTML = `
        <div class="flex items-end justify-between h-[200px] gap-stack-sm">
          ${data.slice().reverse().slice(0, 12).map(d => `
            <div class="flex-1 flex flex-col items-center gap-1">
              <div class="w-full flex flex-col items-center gap-1">
                <div class="w-full bg-secondary/20 rounded-t-sm" style="height: ${Math.max((d.revenue / max) * 160, 2)}px"></div>
                <div class="w-full bg-error/20 rounded-b-sm" style="height: ${Math.max((d.expense / max) * 160, 2)}px"></div>
              </div>
              <span class="font-body-xs text-body-xs text-on-surface-variant transform -rotate-45">${d.period}</span>
            </div>
          `).join('')}
        </div>
        <div class="flex justify-center gap-stack-md mt-stack-sm">
          <div class="flex items-center gap-1"><span class="w-3 h-3 bg-secondary/50 rounded"></span><span class="font-body-xs text-body-xs text-on-surface-variant">Revenue</span></div>
          <div class="flex items-center gap-1"><span class="w-3 h-3 bg-error/50 rounded"></span><span class="font-body-xs text-body-xs text-on-surface-variant">Expenses</span></div>
        </div>
      `;
    } else {
      chartEl.innerHTML = '<p class="text-on-surface-variant font-body-sm">No data for selected period.</p>';
    }

    // Aging
    const agingEl = document.getElementById('acc-aging');
    const aging = d.receivable_aging?.[0] || {};
    const buckets = [
      { label: 'Current', value: parseFloat(aging.current || 0) },
      { label: '0-30 days', value: parseFloat(aging.d0_30 || 0) },
      { label: '31-60 days', value: parseFloat(aging.d31_60 || 0) },
      { label: '61-90 days', value: parseFloat(aging.d61_90 || 0) },
      { label: '90+ days', value: parseFloat(aging.d90_plus || 0) }
    ];
    const agingMax = Math.max(...buckets.map(b => b.value), 1);
    agingEl.innerHTML = buckets.map(b => `
      <div class="flex items-center gap-stack-sm">
        <span class="font-body-xs text-body-xs text-on-surface-variant w-[80px]">${b.label}</span>
        <div class="flex-1 bg-surface-container-high rounded-lg h-6 overflow-hidden">
          <div class="h-full bg-error transition-all" style="width: ${(b.value / agingMax) * 100}%"></div>
        </div>
        <span class="font-code text-code font-medium w-[100px] text-right">${this.fmt(b.value)}</span>
      </div>
    `).join('');
  },

  fmt(n, currency) { return AccountingState.fmt(n, currency || this.currentCurrency); }
};
