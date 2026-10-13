/**
 * Ledger Account Detail Page
 * Shows account details, current balance, opening balance, hierarchy,
 * and transaction history for a specific ledger account.
 */
window.PageModules = window.PageModules || {};

window.PageModules.ledgerDetail = {
  state: { accountId: '' },

  async init() {
    const main = document.getElementById('page-container');
    // Read id from hash query string (e.g. #accounting/ledger-detail?id=xxx)
    const hashQuery = window.location.hash.split('?')[1] || '';
    const params = new URLSearchParams(hashQuery);
    this.state.accountId = params.get('id') || '';
    if (!this.state.accountId) {
      main.innerHTML = '<div class="p-6"><p class="text-on-surface-variant">No account ID provided.</p></div>';
      return () => {};
    }
    await AccountingState.init();
    await this.load();
    return () => {};
  },

  async load() {
    const main = document.getElementById('page-container');
    try {
      const res = await API.get(`/accounting/accounts/${this.state.accountId}`);
      if (!res.success) {
        main.innerHTML = `<div class="p-6"><p class="text-error">Account not found.</p></div>`;
        return;
      }
      main.innerHTML = this.renderPage(res.data);
      this.bindEvents();
    } catch (err) {
      main.innerHTML = `<div class="p-6"><p class="text-error">Error loading account: ${err.message}</p></div>`;
    }
  },

  renderPage(account) {
    const isOpen = account.is_active === true || account.is_active === 1 || account.isActive === true;
    const natureBadge = (account.debit_credit_nature || account.debitCreditNature || 'DEBIT').toUpperCase();
    const natureColor = natureBadge === 'DEBIT' ? 'text-blue-400' : 'text-green-400';
    const balance = (account.current_balance || account.currentBalance || 0);
    const balanceColor = balance >= 0 ? 'text-green-400' : 'text-red-400';
    const groupName = (account.account_group && (account.account_group.name || account.account_group)) || (account.group && account.group.name) || '—';
    const parentGroup = account.group_name || groupName || '—';
    const obEntry = account.opening_balance_entry || account.openingBalanceEntry;

    return `
      <div class="space-y-stack-lg max-w-6xl mx-auto p-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">${account.name || account.code}</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Code: ${account.code} · ${account.type || ''} · ${natureBadge} ${natureColor}</p>
          </div>
          <div class="flex items-center gap-2">
            <button id="ld-edit" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 text-sm font-medium">
              <span class="material-symbols-outlined text-[18px]">edit</span> Edit
            </button>
            <button id="ld-deactivate" class="flex items-center gap-1 bg-surface-container hover:bg-surface-container-high px-4 py-2 rounded-lg text-sm font-medium">
              <span class="material-symbols-outlined text-[18px]">${isOpen ? 'visibility_off' : 'visibility'}</span> ${isOpen ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </div>

        <!-- Key Info Cards -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-4">
            <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Current Balance</label>
            <div class="text-2xl font-display font-semibold ${balanceColor}">${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(balance)}</div>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-4">
            <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Opening Balance</label>
            <div class="text-2xl font-display font-semibold text-on-surface">${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(account.opening_balance || account.openingBalance || 0)}</div>
            <div class="text-xs text-on-surface-variant mt-1">${account.opening_balance_type || account.openingBalanceType || 'DEBIT'} since ${account.opening_balance_date || account.openingBalanceDate || '—'}</div>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-4">
            <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Transactions</label>
            <div class="text-2xl font-display font-semibold text-on-surface">${account.transaction_count || account.transactionCount || 0}</div>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-4">
            <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Status</label>
            <div class="text-sm font-medium ${isOpen ? 'text-green-400' : 'text-red-400'}">${isOpen ? 'Active' : 'Inactive'}</div>
          </div>
        </div>

        <!-- Tabs -->
        <div class="border-b border-outline-variant/30">
          <div class="flex gap-6">
            <button data-tab="details" class="tab-btn py-2 px-1 text-sm font-medium text-on-surface border-b-2 border-secondary">Details</button>
            <button data-tab="hierarchy" class="tab-btn py-2 px-1 text-sm font-medium text-on-surface-variant border-b-2 border-transparent">Hierarchy</button>
            <button data-tab="transactions" class="tab-btn py-2 px-1 text-sm font-medium text-on-surface-variant border-b-2 border-transparent">Transaction History</button>
          </div>
        </div>

        <!-- Details Tab -->
        <div id="tab-details" class="tab-content">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-6">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Account Name</label>
                <div class="text-body-md text-on-surface">${account.name || account.code}</div>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Account Code</label>
                <div class="text-body-md text-on-surface">${account.code}</div>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Account Type</label>
                <div class="text-body-md text-on-surface">${account.type || (account.typeCode ? account.typeCode : '—')}</div>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Account Group</label>
                <div class="text-body-md text-on-surface">${parentGroup}</div>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Debit/Credit Nature</label>
                <div class="text-body-md ${natureColor}">${natureBadge}</div>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Allow Direct Posting</label>
                <div class="text-body-md text-on-surface">${account.allow_direct_posting || account.allowDirectPosting ? 'Yes' : 'No'}</div>
              </div>
              <div class="md:col-span-2">
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Description</label>
                <div class="text-body-md text-on-surface">${account.description || '—'}</div>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">Reconciliation Required</label>
                <div class="text-body-md text-on-surface">${account.reconciliation_required || account.reconciliationRequired ? 'Yes' : 'No'}</div>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant uppercase mb-1">System Account</label>
                <div class="text-body-md text-on-surface">${account.is_system || account.isSystem ? 'Yes (protected)' : 'No'}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Hierarchy Tab -->
        <div id="tab-hierarchy" class="tab-content hidden">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-6">
            <div class="text-body-md text-on-surface font-medium mb-3">Account Hierarchy</div>
            <div class="text-body-sm text-on-surface-variant">${this.renderHierarchy(account, parentGroup)}</div>
          </div>
        </div>

        <!-- Transactions Tab -->
        <div id="tab-transactions" class="tab-content hidden">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-6">
            <div id="ld-transactions-list" class="text-center py-8 text-on-surface-variant">
              <span class="material-symbols-outlined text-[48px]">receipt_long</span>
              <p class="mt-2">No transactions found.</p>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  renderHierarchy(account, groupName) {
    const type = (account.type || account.typeCode || 'ACCOUNT');
    const group = groupName || '—';
    return `
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-sm text-on-surface-variant">account_circle</span>
          <span class="text-on-surface font-medium">${account.name || account.code}</span>
          <span class="text-on-surface-variant">→ ${type}</span>
        </div>
        <div class="ml-6 border-l-2 border-outline-variant/30 pl-4">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-sm text-on-surface-variant">folder</span>
            <span class="text-on-surface">${group}</span>
          </div>
        </div>
      </div>
    `;
  },

  bindEvents() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => {
          b.classList.remove('border-secondary', 'text-on-surface');
          b.classList.add('text-on-surface-variant', 'border-transparent');
        });
        btn.classList.add('border-secondary', 'text-on-surface');
        btn.classList.remove('text-on-surface-variant', 'border-transparent');
        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hidden'));
        document.getElementById('tab-' + tab)?.classList.remove('hidden');
      });
    });

    // Edit button
    document.getElementById('ld-edit')?.addEventListener('click', () => {
      window.location.hash = '#accounting/chart-of-accounts';
      setTimeout(() => {
        if (window.PageModules?.chartOfAccounts?.openForm) {
          window.PageModules.chartOfAccounts.openForm({ id: this.state.accountId });
        }
      }, 200);
    });

    // Deactivate/Activate button
    document.getElementById('ld-deactivate')?.addEventListener('click', async () => {
      const account = await this.fetchAccount();
      const newActive = !(account.is_active === true || account.is_active === 1 || account.isActive === true);
      try {
        await API.put(`/accounting/accounts/${this.state.accountId}`, { is_active: newActive ? 1 : 0 });
        Toast.success('Account ' + (newActive ? 'activated' : 'deactivated'));
        this.load();
      } catch (err) {
        Toast.error(err.message);
      }
    });
  },

  async fetchAccount() {
    const res = await API.get(`/accounting/accounts/${this.state.accountId}`);
    return res.data || {};
  }
};
