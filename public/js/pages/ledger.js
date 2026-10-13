window.PageModules = window.PageModules || {};

window.PageModules.ledger = {
  state: { accountId: '', dateFrom: '', dateTo: '' },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    await AccountingState.init();

    // If accountId is in the hash, extract it
    const hash = window.location.hash;
    if (hash.startsWith('#accounting/ledger/')) {
      this.state.accountId = hash.split('/').pop();
    }

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">General Ledger</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">View account transactions and running balances.</p>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <div class="grid grid-cols-4 gap-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Account</label>
              <select id="ledger-account" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
                <option value="">Select account</option>
              </select>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date From</label>
              <input id="ledger-from" type="date" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date To</label>
              <input id="ledger-to" type="date" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div class="flex items-end">
              <button id="ledger-load" class="w-full bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Load Ledger</button>
            </div>
          </div>
        </div>

        <div id="ledger-content" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding min-h-[300px]">
          <p class="text-on-surface-variant font-body-sm">Select an account and click Load Ledger.</p>
        </div>
      </div>
    `;

    await this.loadAccounts();
    if (this.state.accountId) {
      document.getElementById('ledger-account').value = this.state.accountId;
      await this.load();
    }
    this.bindEvents();
    return () => {};
  },

  bindEvents() {
    document.getElementById('ledger-load').addEventListener('click', () => this.load());
    document.getElementById('ledger-account').addEventListener('change', (e) => {
      this.state.accountId = e.target.value;
      this.load();
    });
  },

  async loadAccounts() {
    try {
      const res = await API.get('/accounting/accounts', { limit: 1000 });
      const items = res?.items || res?.data?.items || [];
      const select = document.getElementById('ledger-account');
      select.innerHTML = '<option value="">Select account</option>' + items.map(a =>
        `<option value="${a.id}">${a.code} - ${a.name}</option>`
      ).join('');
    } catch {}
  },

  fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },

  async load() {
    const container = document.getElementById('ledger-content');
    this.state.dateFrom = document.getElementById('ledger-from').value;
    this.state.dateTo = document.getElementById('ledger-to').value;

    if (!this.state.accountId) {
      container.innerHTML = '<p class="text-on-surface-variant">Select an account to view its ledger.</p>';
      return;
    }

    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { start_date: this.state.dateFrom, end_date: this.state.dateTo };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get(`/accounting/ledger/${this.state.accountId}`, params);
      const data = res?.data || res || {};
      const items = data.items || data.entries || [];

      let dr = 0, cr = 0;
      const rowsHtml = items.map(e => {
        const d = parseFloat(e.debitBalance || e.debit_balance || e.debit || e.totalDebit || 0);
        const c = parseFloat(e.totalCredit || e.credit_balance || e.credit || 0);
        dr += d; cr += c;
        return `<tr class="border-b border-outline-variant/20">
          <td class="py-2 font-code text-body-sm">${this.fmtDate(e.date || e.entryDate || e.entry_date)}</td>
          <td class="py-2 font-code text-body-sm">${e.voucher_number || e.voucherNumber || e.voucherNumber || ''}</td>
          <td class="py-2 text-body-sm">${e.description || ''}</td>
          <td class="py-2 text-right font-code text-body-sm">${AccountingState.fmt(d)}</td>
          <td class="py-2 text-right font-code text-body-sm">${AccountingState.fmt(c)}</td>
          <td class="py-2 text-right font-code font-medium text-primary">${AccountingState.fmt(e.runningBalance || e.running_balance || e.balance)}</td>
        </tr>`;
      }).join('');

      const closingBalance = data.closing_balance || data.closingBalance || data.balance || 0;
      container.innerHTML = `
        <div class="flex items-center justify-between mb-stack-md">
          <div>
            <h2 class="font-display text-h2 text-on-surface">${data.account ? ((data.account.code ? data.account.code + ' - ' : '') + (data.account.name || data.account.code || this.state.accountId)) : this.state.accountId}</h2>
            <p class="font-body-sm text-body-sm text-on-surface-variant">${data.account?.description || ''}</p>
          </div>
          <div class="text-right">
            <p class="font-label-md text-on-surface-variant">Closing Balance</p>
            <p class="font-display text-h1 text-on-surface font-bold">${AccountingState.fmt(closingBalance)}</p>
          </div>
        </div>
        <div class="border border-outline-variant/30 rounded-lg overflow-hidden">
          <table class="w-full">
            <thead class="bg-surface-container-low"><tr>
              <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Date</th>
              <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Voucher</th>
              <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Description</th>
              <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Debit</th>
              <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Credit</th>
              <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Balance</th>
            </tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="6" class="py-8 text-center text-on-surface-variant">No transactions found</td></tr>'}</tbody>
            <tfoot class="bg-surface-container-low"><tr>
              <td colspan="3" class="py-2 font-medium font-label-md text-on-surface-variant">Totals</td>
              <td class="py-2 text-right font-code font-medium">${AccountingState.fmt(dr)}</td>
              <td class="py-2 text-right font-code font-medium">${AccountingState.fmt(cr)}</td>
              <td class="py-2 text-right font-code font-bold">${AccountingState.fmt(closingBalance)}</td>
            </tr></tfoot>
          </table>
        </div>
      `;
    } catch (err) {
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-error">error</span><p class="text-on-surface-variant mt-2">' + (err.message || 'Failed') + '</p></div>';
    }
  }
};
