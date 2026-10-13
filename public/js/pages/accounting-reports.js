window.PageModules = window.PageModules || {};

window.PageModules['accounting-reports'] = {
  table: null,
  state: { activeTab: 'trial-balance', dateFrom: '', dateTo: '' },

  fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Financial Reports</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Generate trial balance, P&amp;L, balance sheet, cash flow, and ratio analysis.</p>
          </div>
          <div class="flex items-center gap-stack-sm">
            <input id="rep-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="rep-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <button id="rep-refresh" class="flex items-center gap-1 bg-secondary/10 text-secondary px-3 py-2 rounded-lg hover:bg-secondary/20">
              <span class="material-symbols-outlined text-[18px]">refresh</span>
            </button>
          </div>
        </div>

        <div class="border-b border-outline-variant/30">
          <nav class="flex gap-4 overflow-x-auto" id="rep-tabs">
            ${this.renderTabs()}
          </nav>
        </div>

        <div id="rep-content" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding min-h-[400px]">
          <div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => {};
  },

  renderTabs() {
    const tabs = [
      { id: 'trial-balance', label: 'Trial Balance' },
      { id: 'profit-loss', label: 'Profit & Loss' },
      { id: 'balance-sheet', label: 'Balance Sheet' },
      { id: 'day-book', label: 'Day Book' },
      { id: 'cash-flow', label: 'Cash Flow' },
      { id: 'ratios', label: 'Ratio Analysis' },
    ];
    return tabs.map(t => `
      <button data-tab="${t.id}" class="py-3 px-4 font-body-sm text-body-sm border-b-2 transition-colors ${
        this.state.activeTab === t.id
          ? 'border-secondary text-secondary font-medium'
          : 'border-transparent text-on-surface-variant hover:text-on-surface hover:border-outline'
      }">${t.label}</button>
    `).join('');
  },

  bindEvents() {
    document.getElementById('rep-refresh').addEventListener('click', () => this.load());
    document.getElementById('rep-from').addEventListener('change', (e) => { this.state.dateFrom = e.target.value; this.load(); });
    document.getElementById('rep-to').addEventListener('change', (e) => { this.state.dateTo = e.target.value; this.load(); });

    document.querySelectorAll('#rep-tabs button[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.state.activeTab = btn.dataset.tab;
        this.renderTabState();
        this.load();
      });
    });
  },

  renderTabState() {
    document.querySelectorAll('#rep-tabs button[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === this.state.activeTab;
      btn.className = `py-3 px-4 font-body-sm text-body-sm border-b-2 transition-colors ${
        active ? 'border-secondary text-secondary font-medium' : 'border-transparent text-on-surface-variant hover:text-on-surface hover:border-outline'
      }`;
    });
  },

  async load() {
    const container = document.getElementById('rep-content');
    this.state.dateFrom = document.getElementById('rep-from').value;
    this.state.dateTo = document.getElementById('rep-to').value;

    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';

    try {
      const params = {};
      if (this.state.dateFrom) params.start_date = this.state.dateFrom;
      if (this.state.dateTo) params.end_date = this.state.dateTo;

      if (this.state.activeTab === 'trial-balance') {
        const res = await API.get('/accounting/reports/trial-balance', params);
        this.renderTrialBalance(res?.data || res || {});
      } else if (this.state.activeTab === 'profit-loss') {
        const res = await API.get('/accounting/reports/profit-loss', params);
        this.renderProfitLoss(res?.data || res || {});
      } else if (this.state.activeTab === 'balance-sheet') {
        const res = await API.get('/accounting/reports/balance-sheet', params);
        this.renderBalanceSheet(res?.data || res || {});
      } else if (this.state.activeTab === 'day-book') {
        const res = await API.get('/accounting/reports/day-book', params);
        this.renderDayBook(res?.data || res || {});
      } else if (this.state.activeTab === 'cash-flow') {
        const res = await API.get('/accounting/reports/cash-flow', params);
        this.renderCashFlow(res?.data || res || {});
      } else if (this.state.activeTab === 'ratios') {
        const res = await API.get('/accounting/reports/ratios', params);
        this.renderRatios(res?.data || res || {});
      }
    } catch (err) {
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-error">error</span><p class="text-on-surface-variant mt-2">' + (err.message || 'Failed to load report') + '</p></div>';
    }
  },

  renderTrialBalance(data) {
    const container = document.getElementById('rep-content');
    const accounts = data.accounts || [];
    const rowsHtml = accounts.map(a => `
      <tr class="border-b border-outline-variant/20">
        <td class="py-2 font-code">${a.code || ''}</td>
        <td class="py-2">${a.name || ''}</td>
        <td class="py-2 text-right font-code">${AccountingState.fmt(a.debit || 0)}</td>
        <td class="py-2 text-right font-code">${AccountingState.fmt(a.credit || 0)}</td>
        <td class="py-2 text-right font-code font-medium ${a.balance >= 0 ? 'text-primary' : 'text-error'}">${AccountingState.fmt(a.balance || 0)}</td>
      </tr>
    `).join('');

    const balanced = data.balanced;
    container.innerHTML = `
      <div class="flex items-center justify-between mb-stack-md">
        <h2 class="font-display text-h2 text-on-surface">Trial Balance</h2>
        <span class="${balanced ? 'bg-green-100 text-green-700' : 'bg-error-container/20 text-error'} px-3 py-1 rounded-full font-label-md text-[11px]">
          ${balanced ? '✓ Balanced' : '✗ Unbalanced'}
        </span>
      </div>
      <div class="border border-outline-variant/30 rounded-lg overflow-hidden">
        <table class="w-full">
          <thead class="bg-surface-container-low"><tr>
            <th class="text-left py-2 font-label-md">Account Code</th>
            <th class="text-left py-2 font-label-md">Account Name</th>
            <th class="text-right py-2 font-label-md">Debit</th>
            <th class="text-right py-2 font-label-md">Credit</th>
            <th class="text-right py-2 font-label-md">Balance</th>
          </tr></thead>
          <tbody>${rowsHtml || '<tr><td colspan="5" class="py-8 text-center text-on-surface-variant">No data</td></tr>'}</tbody>
          <tfoot class="bg-surface-container-low"><tr>
            <td colspan="2" class="py-2 font-medium">Totals</td>
            <td class="py-2 text-right font-code font-bold">${AccountingState.fmt(data.total_debit || 0)}</td>
            <td class="py-2 text-right font-code font-bold">${AccountingState.fmt(data.total_credit || 0)}</td>
            <td class="py-2 text-right font-code font-bold">${AccountingState.fmt(Math.abs(data.total_debit - data.total_credit) || 0)}</td>
          </tr></tfoot>
        </table>
      </div>
    `;
  },

  renderProfitLoss(data) {
    const container = document.getElementById('rep-content');
    container.innerHTML = `
      <div class="space-y-stack-md">
        <h2 class="font-display text-h2 text-on-surface">Profit &amp; Loss Statement</h2>

        <div class="grid grid-cols-2 gap-stack-md">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Revenue</h3>
            <table class="w-full">
              <thead><tr><th class="text-left py-1">Account</th><th class="text-right py-1">Amount</th></tr></thead>
              <tbody>
                ${(data.revenue?.items || []).map(r => `
                  <tr class="border-b border-outline-variant/20">
                    <td class="py-1">${r.name || ''}</td>
                    <td class="py-1 text-right font-code">${AccountingState.fmt(r.net)}</td>
                  </tr>
                `).join('')}
              </tbody>
              <tfoot><tr class="border-t border-outline-variant/30">
                <td class="py-2 font-medium">Total Revenue</td>
                <td class="py-2 text-right font-display font-bold">${AccountingState.fmt(data.revenue?.total || 0)}</td>
              </tr></tfoot>
            </table>
          </div>

          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Expenses</h3>
            <table class="w-full">
              <thead><tr><th class="text-left py-1">Account</th><th class="text-right py-1">Amount</th></tr></thead>
              <tbody>
                ${(data.expenses?.items || []).map(r => `
                  <tr class="border-b border-outline-variant/20">
                    <td class="py-1">${r.name || ''}</td>
                    <td class="py-1 text-right font-code">${AccountingState.fmt(r.net)}</td>
                  </tr>
                `).join('')}
              </tbody>
              <tfoot><tr class="border-t border-outline-variant/30">
                <td class="py-2 font-medium">Total Expenses</td>
                <td class="py-2 text-right font-display font-bold">${AccountingState.fmt(data.expenses?.total || 0)}</td>
              </tr></tfoot>
            </table>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <table class="w-full">
            <tbody>
              <tr class="border-b border-outline-variant/20">
                <td class="py-2 font-label-md text-on-surface-variant">Gross Profit</td>
                <td class="py-2 text-right font-display text-h1">${AccountingState.fmt(data.gross_profit)}</td>
              </tr>
              <tr class="border-b border-outline-variant/20">
                <td class="py-2 font-label-md text-on-surface-variant">Operating Profit</td>
                <td class="py-2 text-right font-display text-h1">${AccountingState.fmt(data.operating_profit)}</td>
              </tr>
              <tr class="border-t border-outline-variant/30">
                <td class="py-2 font-display text-h1 text-on-surface">Net Profit</td>
                <td class="py-2 text-right font-display text-h1 text-secondary">${AccountingState.fmt(data.net_profit)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  renderBalanceSheet(data) {
    const container = document.getElementById('rep-content');
    const section = (title, items, totalKey) => `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
        <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">${title}</h3>
        <table class="w-full">
          <tbody>
            ${items.map(a => `
              <tr class="border-b border-outline-variant/20">
                <td class="py-1 font-code">${a.code || ''}</td>
                <td class="py-1">${a.name || ''}</td>
                <td class="py-1 text-right font-code">${AccountingState.fmt(a.net_balance)}</td>
              </tr>
            `).join('')}
            <tr class="border-t border-outline-variant/30"><td colspan="2" class="py-2 font-medium">Total ${title}</td>
              <td class="py-2 text-right font-display font-bold">${AccountingState.fmt(data.totals?.[totalKey] || 0)}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    container.innerHTML = `
      <div class="space-y-stack-lg">
        <h2 class="font-display text-h2 text-on-surface">Balance Sheet</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-stack-md">
          ${section('Assets', data.assets?.items || [], 'assets')}
          <div class="space-y-stack-md">
            ${section('Liabilities', data.liabilities?.items || [], 'liabilities')}
            ${section('Equity', data.equity?.items || [], 'equity')}
          </div>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <table class="w-full">
            <tbody>
              <tr class="border-b"><td class="py-2 font-label-md text-on-surface-variant">Assets = Liabilities + Equity</td>
                <td class="py-2 text-right font-code">${AccountingState.fmt(data.totals?.assets || 0)}</td>
                <td class="py-2 text-right font-display font-bold ${data.totals?.balanced ? 'text-green-700' : 'text-error'}">= ${AccountingState.fmt(data.totals?.liabilities || 0) + ' + ' + AccountingState.fmt(data.totals?.equity || 0)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  renderDayBook(data) {
    const container = document.getElementById('rep-content');
    const items = data?.items || [];
    let dr = 0, cr = 0;
    const rowsHtml = items.map(r => {
      const d = parseFloat(r.total_debit || r.totalDebit || 0);
      const c = parseFloat(r.total_credit || r.totalCredit || 0);
      dr += d; cr += c;
      return `<tr class="border-b border-outline-variant/20">
        <td class="py-2 font-code text-body-sm">${r.entry_date || r.entryDate || ''}</td>
        <td class="py-2 font-code text-body-sm">${r.voucher_number || r.voucherNumber || ''}</td>
        <td class="py-2 font-code text-body-sm">${r.voucher_type || r.voucherType || ''}</td>
        <td class="py-2 font-code text-body-sm">${r.entry_number || r.entryNumber || ''}</td>
        <td class="py-2 text-body-sm">${r.description || ''}</td>
        <td class="py-2 text-right font-code text-body-sm">${AccountingState.fmt(d)}</td>
        <td class="py-2 text-right font-code text-body-sm">${AccountingState.fmt(c)}</td>
        <td class="py-2 font-code text-body-sm">${r.user_name || r.userName || ''}</td>
        <td class="py-2 text-center">${AccountingState.statusBadge(r.status)}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="space-y-stack-md">
        <h2 class="font-display text-h2 text-on-surface">Day Book</h2>
        <div class="border border-outline-variant/30 rounded-lg overflow-hidden">
          <table class="w-full">
            <thead class="bg-surface-container-low"><tr>
              <th class="text-left py-2 font-label-md">Date</th>
              <th class="text-left py-2 font-label-md">Voucher #</th>
              <th class="text-left py-2 font-label-md">Type</th>
              <th class="text-left py-2 font-label-md">Entry #</th>
              <th class="text-left py-2 font-label-md">Description</th>
              <th class="text-left py-2 font-label-md">Account</th>
              <th class="text-right py-2 font-label-md">Debit</th>
              <th class="text-right py-2 font-label-md">Credit</th>
              <th class="text-left py-2 font-label-md">User</th>
              <th class="text-center py-2 font-label-md">Status</th>
            </tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="10" class="py-8 text-center text-on-surface-variant">No transactions found</td></tr>'}</tbody>
            <tfoot class="bg-surface-container-low"><tr>
              <td colspan="6" class="py-2 font-medium">Totals</td>
              <td class="py-2 text-right font-code font-bold">${AccountingState.fmt(dr)}</td>
              <td class="py-2 text-right font-code font-bold">${AccountingState.fmt(cr)}</td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    `;
  },

  renderCashFlow(data) {
    const container = document.getElementById('rep-content');
    container.innerHTML = `
      <div class="space-y-stack-lg">
        <h2 class="font-display text-h2 text-on-surface">Cash Flow</h2>

        <div class="grid grid-cols-3 gap-stack-md">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Operating Activities</h3>
            <p class="font-display text-h1 ${(data.operating?.net || 0) >= 0 ? 'text-green-700' : 'text-error'}">${AccountingState.fmt(data.operating?.net || 0)}</p>
            <table class="w-full mt-stack-sm">
              <thead><tr><th class="text-left py-1 font-label-md">Date</th><th class="text-left py-1 font-label-md">Description</th><th class="text-right py-1">Amount</th></tr></thead>
              <tbody>
                ${(data.operating?.items || []).slice(0, 10).map(i => `
                  <tr class="border-b border-outline-variant/20"><td class="py-1 font-code">${i.entry_date}</td><td class="py-1">${i.description || i.account_name || ''}</td><td class="py-1 text-right font-code">${AccountingState.fmt(i.debit_amount || 0)}</td></tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Investing Activities</h3>
            <p class="font-display text-h1 ${(data.investing?.net || 0) >= 0 ? 'text-green-700' : 'text-error'}">${AccountingState.fmt(data.investing?.net || 0)}</p>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Financing Activities</h3>
            <p class="font-display text-h1 ${(data.financing?.net || 0) >= 0 ? 'text-green-700' : 'text-error'}">${AccountingState.fmt(data.financing?.net || 0)}</p>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <table class="w-full">
            <tbody>
              <tr class="border-b"><td class="py-2 font-label-md text-on-surface-variant">Operating</td><td class="py-2 text-right font-code">${AccountingState.fmt(data.operating?.net || 0)}</td></tr>
              <tr class="border-b"><td class="py-2 font-label-md text-on-surface-variant">Investing</td><td class="py-2 text-right font-code">${AccountingState.fmt(data.investing?.net || 0)}</td></tr>
              <tr class="border-b"><td class="py-2 font-label-md text-on-surface-variant">Financing</td><td class="py-2 text-right font-code">${AccountingState.fmt(data.financing?.net || 0)}</td></tr>
              <tr class="border-t border-outline-variant/30"><td class="py-2 font-display text-h1 text-on-surface">Net Cash Flow</td><td class="py-2 text-right font-display font-bold text-secondary">${AccountingState.fmt(data.net_cash_flow || 0)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  renderRatios(data) {
    const container = document.getElementById('rep-content');
    container.innerHTML = `
      <div class="space-y-stack-lg">
        <h2 class="font-display text-h2 text-on-surface">Ratio Analysis</h2>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-stack-md">
          ${this.ratioCard('Current Ratio', data.current_ratio, 'ratio')}
          ${this.ratioCard('Quick Ratio', data.quick_ratio, 'ratio')}
          ${this.ratioCard('Debt-to-Equity', data.debt_to_equity, 'ratio')}
          ${this.ratioCard('Gross Profit Margin', data.gross_profit_margin, '%')}
          ${this.ratioCard('Net Profit Margin', data.net_profit_margin, '%')}
          ${this.ratioCard('Operating Margin', data.operating_margin, '%')}
          ${this.ratioCard('Receivables Turnover', data.receivables_turnover, 'x')}
          ${this.ratioCard('Payables Turnover', data.payables_turnover, 'x')}
          ${this.ratioCard('Return on Assets', data.return_on_assets, '%')}
          ${this.ratioCard('Return on Equity', data.return_on_equity, '%')}
          ${this.ratioCard('Receivables Days', data.receivables_days, 'days')}
          ${this.ratioCard('Payables Days', data.payables_days, 'days')}
        </div>
      </div>
    `;
  },

  ratioCard(label, value, unit) {
    const display = (value === undefined || value === null || Number.isNaN(value)) ? 'N/A' : value;
    const suffix = (unit === '%') ? '%' : (unit === 'x') ? 'x' : (unit === 'days') ? '' : '';
    return `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding text-center">
        <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">${label}</p>
        <p class="font-display text-h1 text-on-surface">${display}${suffix}</p>
      </div>
    `;
  }
};
