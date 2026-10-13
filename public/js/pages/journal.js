window.PageModules = window.PageModules || {};

window.PageModules.journal = {
  table: null,
  pagination: null,
  state: { page: 1, pageSize: 20, search: '', status: 'POSTED', from: '', to: '' },

  async init(id = null) {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    await AccountingState.init();

    // If a journal entry ID is passed (route: #accounting/journal/:id), show detail view
    if (id) {
      await this.viewDetailById(id);
      return () => {};
    }

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Journal</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Double-entry journal entries with debit/credit balance.</p>
          </div>
          <button id="jnl-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
            <span class="material-symbols-outlined text-[18px]">add</span> New Journal Entry
          </button>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
            <div class="relative flex-1 min-w-[200px]">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
              <input id="jnl-search" placeholder="Search journal entries..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <select id="jnl-status" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="POSTED">Posted</option>
              <option value="DRAFT">Draft</option>
              <option value="">All</option>
            </select>
            <input id="jnl-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="jnl-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div id="jnl-table"></div>
          <div id="jnl-pagination" class="p-container-padding border-t border-outline-variant/30"></div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => {};
  },

  bindEvents() {
    document.getElementById('jnl-new').addEventListener('click', () => this.openForm());
    document.getElementById('jnl-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.load(); }, 300);
    });
    document.getElementById('jnl-status').addEventListener('change', (e) => {
      this.state.status = e.target.value; this.state.page = 1; this.load();
    });
    document.getElementById('jnl-from').addEventListener('change', (e) => {
      this.state.from = e.target.value; this.load();
    });
    document.getElementById('jnl-to').addEventListener('change', (e) => {
      this.state.to = e.target.value; this.load();
    });
  },

  async load() {
    const container = document.getElementById('jnl-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = {
        page: this.state.page, limit: this.state.pageSize,
        q: this.state.search, status: this.state.status,
        start_date: this.state.from, end_date: this.state.to
      };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/accounting/journal', params);
      const data = res?.data || res || {};
      const items = data.items || data.entries || [];
      const total = data.total || items.length;
      this.renderTable(container, items, total);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  renderTable(container, items, total) {
    this.table = new DataTable(container, {
      columns: [
        { key: 'entryNumber', label: 'Entry #', render: (v, r) => `<a href="#accounting/journal/${r.id}" class="font-code text-secondary font-medium">${v || r.id}</a>` },
        { key: 'entryDate', label: 'Date' },
        { key: 'description', label: 'Description' },
        { key: 'totalDebit', label: 'Debit', render: (v, r) => `<span class="font-code font-medium text-right">${AccountingState.fmt(v || 0)}</span>`, align: 'right' },
        { key: 'totalCredit', label: 'Credit', render: (v, r) => `<span class="font-code font-medium text-right">${AccountingState.fmt(v || 0)}</span>`, align: 'right' },
        { key: 'status', label: 'Status', render: (v) => AccountingState.statusBadge(v) },
      ],
      data: items,
      emptyState: 'No journal entries found',
      rowActions: (row) => this.openRowMenu(row),
    });
    if (!this.pagination) {
      this.pagination = new Pagination(document.getElementById('jnl-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
        onPageChange: (p) => { this.state.page = p; this.load(); },
      });
    } else {
      this.pagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
    }
  },

  async openRowMenu(row) {
    const modal = new Modal({
      title: row.entryNumber || row.entry_number || row.id, size: 'sm',
      content: `<div class="flex flex-col gap-1">` +
        '<button data-act="view" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">visibility</span> View</button>' +
        (row.status === 'POSTED' ? '<button data-act="cancel" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-error text-left"><span class="material-symbols-outlined text-[18px]">cancel</span> Cancel</button>' : '') +
        (row.status === 'POSTED' ? '<button data-act="reverse" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-error text-left"><span class="material-symbols-outlined text-[18px]">undo</span> Reverse</button>' : '') +
        '</div>'
    });
    modal.open();
    modal.element.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      modal.close();
      if (act === 'view') return this.viewDetail(row);
      if (act === 'cancel') return this.cancelVoucher(row);
      if (act === 'reverse') return this.reverseVoucher(row);
    });
  },

  async viewDetail(row) {
    const container = document.getElementById('page-container');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/accounting/journal/' + row.id);
      const entry = res?.data || res || {};
      const lines = entry.lines || [];

      // Use entry-level totals from DB header (authoritative), fall back to line aggregation
      let dr = 0, cr = 0;
      for (const l of lines) {
        dr += parseFloat(l.debitAmount) || 0;
        cr += parseFloat(l.creditAmount) || 0;
      }
      // Prefer DB header totals for display consistency
      if (entry.totalDebit !== undefined) dr = parseFloat(entry.totalDebit) || dr;
      if (entry.totalCredit !== undefined) cr = parseFloat(entry.totalCredit) || cr;

      const rowsHtml = lines.map(l => {
        const d = parseFloat(l.debitAmount) || 0;
        const c = parseFloat(l.creditAmount) || 0;
        const account = l.accountCode || '';
        return `<tr class="border-b border-outline-variant/20">
          <td class="py-2 font-code">${account}</td>
          <td class="py-2">${l.accountName || ''}</td>
          <td class="py-2">${l.description || ''}</td>
          <td class="py-2 text-right font-code">${AccountingState.fmt(d)}</td>
          <td class="py-2 text-right font-code">${AccountingState.fmt(c)}</td>
        </tr>`;
      }).join('');

      container.innerHTML = `
        <div class="space-y-stack-lg">
          <div class="flex items-center justify-between">
            <h1 class="font-display text-h1 text-on-surface">Journal Entry ${entry.entryNumber || entry.entry_number || ''}</h1>
            <button id="jnl-back" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high">
              <span class="material-symbols-outlined text-[18px]">arrow_back</span> Back
            </button>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <div class="grid grid-cols-3 gap-stack-md mb-stack-md">
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Date</span><p class="font-body-md text-body-md text-on-surface">${entry.entryDate || entry.entry_date || ''}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Reference</span><p class="font-body-md text-body-md text-on-surface">${entry.entryNumber || entry.entry_number || ''}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Status</span><div class="mt-1">${AccountingState.statusBadge(entry.status)}</div></div>
            </div>
            <div class="grid grid-cols-3 gap-stack-md mb-stack-md">
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Currency</span><p class="font-body-md text-body-md text-on-surface">${entry.currency || 'INR'}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Source</span><p class="font-body-md text-body-md text-on-surface">${entry.voucherId ? 'Voucher ' + entry.voucherId : 'Direct Entry'}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Entry ID</span><p class="font-body-md text-body-md text-on-surface font-code">${entry.id}</p></div>
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">${entry.description || ''}</p>
            <table class="w-full">
              <thead><tr class="border-b border-outline-variant/30">
                <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Account</th>
                <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Name</th>
                <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Description</th>
                <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Debit</th>
                <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Credit</th>
              </tr></thead>
              <tbody>${rowsHtml}</tbody>
              <tfoot><tr class="border-t border-outline-variant/30">
                <td colspan="3" class="py-2 font-medium font-label-md">Totals</td>
                <td class="py-2 text-right font-code font-medium">${AccountingState.fmt(dr)}</td>
                <td class="py-2 text-right font-code font-medium">${AccountingState.fmt(cr)}</td>
              </tr></tfoot>
            </table>
            <div class="flex justify-between items-center mt-stack-md">
              <div>
                <span class="font-label-md text-label-md text-on-surface-variant">Difference:</span>
                <span class="font-code font-medium ${Math.abs(dr - cr) < 0.01 ? 'text-green-700' : 'text-error'}">${AccountingState.fmt(Math.abs(dr - cr))}</span>
              </div>
              <span class="font-label-md ${dr === cr ? 'text-green-700' : 'text-error'}">
                ${dr === cr ? '✓ Balanced' : '✗ Unbalanced'}
              </span>
            </div>
          </div>
        </div>
      `;
      document.getElementById('jnl-back').addEventListener('click', () => this.load());
    } catch (err) {
      const container = document.getElementById('page-container');
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-error">error</span><p class="text-on-surface-variant mt-2">' + (err.message || 'Failed') + '</p></div>';
    }
  },

  async viewDetailById(id) {
    const container = document.getElementById('page-container');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/accounting/journal/' + id);
      const entry = res?.data || res || {};
      const lines = entry.lines || [];

      let dr = 0, cr = 0;
      for (const l of lines) {
        dr += parseFloat(l.debitAmount) || 0;
        cr += parseFloat(l.creditAmount) || 0;
      }
      if (entry.totalDebit !== undefined) dr = parseFloat(entry.totalDebit) || dr;
      if (entry.totalCredit !== undefined) cr = parseFloat(entry.totalCredit) || cr;

      const rowsHtml = lines.map(l => {
        const d = parseFloat(l.debitAmount) || 0;
        const c = parseFloat(l.creditAmount) || 0;
        const account = l.accountCode || '';
        return `<tr class="border-b border-outline-variant/20">
          <td class="py-2 font-code">${account}</td>
          <td class="py-2">${l.accountName || ''}</td>
          <td class="py-2">${l.description || ''}</td>
          <td class="py-2 text-right font-code">${AccountingState.fmt(d)}</td>
          <td class="py-2 text-right font-code">${AccountingState.fmt(c)}</td>
        </tr>`;
      }).join('');

      container.innerHTML = `
        <div class="space-y-stack-lg">
          <div class="flex items-center justify-between">
            <h1 class="font-display text-h1 text-on-surface">Journal Entry ${entry.entryNumber || entry.entry_number || ''}</h1>
            <button id="jnl-back" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high">
              <span class="material-symbols-outlined text-[18px]">arrow_back</span> Back to Journal
            </button>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <div class="grid grid-cols-3 gap-stack-md mb-stack-md">
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Date</span><p class="font-body-md text-body-md text-on-surface">${entry.entryDate || entry.entry_date || ''}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Reference</span><p class="font-body-md text-body-md text-on-surface">${entry.entryNumber || entry.entry_number || ''}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Status</span><div class="mt-1">${AccountingState.statusBadge(entry.status)}</div></div>
            </div>
            <div class="grid grid-cols-3 gap-stack-md mb-stack-md">
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Currency</span><p class="font-body-md text-body-md text-on-surface">${entry.currency || 'INR'}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Total Debit</span><p class="font-body-md text-body-md text-on-surface font-code">${AccountingState.fmt(entry.totalDebit || dr)}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Total Credit</span><p class="font-body-md text-body-md text-on-surface font-code">${AccountingState.fmt(entry.totalCredit || cr)}</p></div>
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">${entry.description || ''}</p>
            <table class="w-full">
              <thead><tr class="border-b border-outline-variant/30">
                <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Account</th>
                <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Name</th>
                <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Description</th>
                <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Debit</th>
                <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Credit</th>
              </tr></thead>
              <tbody>${rowsHtml}</tbody>
              <tfoot><tr class="border-t border-outline-variant/30">
                <td colspan="3" class="py-2 font-medium font-label-md">Totals</td>
                <td class="py-2 text-right font-code font-medium">${AccountingState.fmt(dr)}</td>
                <td class="py-2 text-right font-code font-medium">${AccountingState.fmt(cr)}</td>
              </tr></tfoot>
            </table>
            <div class="flex justify-between items-center mt-stack-md">
              <div></div>
              <span class="font-label-md ${dr === cr ? 'text-green-700' : 'text-error'}">
                ${dr === cr ? '✓ Balanced' : '✗ Unbalanced'}
              </span>
            </div>
          </div>
        </div>
      `;
      document.getElementById('jnl-back').addEventListener('click', () => { window.location.hash = '#accounting/journal'; });
    } catch (err) {
      const container = document.getElementById('page-container');
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-error">error</span><p class="text-on-surface-variant mt-2">' + (err.message || 'Failed') + '</p></div>';
    }
  },

  cancelVoucher(row) {
    const modal = new Modal({
      title: 'Cancel Voucher?', size: 'sm',
      content: `<p class="font-body-md text-on-surface mb-stack-md">Cancel voucher ${row.entryNumber || row.entry_number}? This will mark it as cancelled and cannot be undone.</p>` +
        `<div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
        <button id="confirm-cancel" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Confirm Cancel</button></div>`
    });
    modal.open();
    modal.element.querySelector('#confirm-cancel').addEventListener('click', async () => {
      try {
        // Need voucher_id — fetch from entry
        const res = await API.get('/accounting/journal/' + row.id);
        const entry = res?.data || res || {};
        if (entry.voucher_id) {
          await API.post('/accounting/vouchers/' + entry.voucher_id + '/cancel');
        }
        Toast.success('Voucher cancelled'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  reverseVoucher(row) {
    const modal = new Modal({
      title: 'Reverse Voucher?', size: 'sm',
      content: `<p class="font-body-md text-on-surface mb-stack-md">Reverse voucher ${row.entryNumber || row.entry_number}? This creates a reversing entry.</p>` +
        `<div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
        <button id="confirm-reverse" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Confirm Reverse</button></div>`
    });
    modal.open();
    modal.element.querySelector('#confirm-reverse').addEventListener('click', async () => {
      try {
        const res = await API.get('/accounting/journal/' + row.id);
        const entry = res?.data || res || {};
        if (entry.voucher_id) {
          await API.post('/accounting/vouchers/' + entry.voucher_id + '/reverse');
        }
        Toast.success('Voucher reversed'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  openForm(row = null) {
    const isEdit = !!row;
    const modal = new Modal({
      title: 'New Journal Entry', size: '4xl',
      content: `
        <form id="jnl-form" class="space-y-stack-md">
          <div class="grid grid-cols-3 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Financial Year *</label><select name="financial_year_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"><option value="">Loading…</option></select></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date *</label><input name="entry_date" type="date" required value="${new Date().toISOString().split('T')[0]}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label><input name="description" placeholder="Transaction description" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reference</label><input name="reference_number" placeholder="Reference #" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Journal Lines</label>
            <div class="border border-outline-variant/30 rounded-lg overflow-hidden">
              <table class="w-full">
                <thead class="bg-surface-container-low"><tr>
                  <th class="font-label-md text-label-md text-on-surface-variant p-2 text-left">Account</th>
                  <th class="font-label-md text-label-md text-on-surface-variant p-2 text-left">Description</th>
                  <th class="font-label-md text-label-md text-on-surface-variant p-2 text-right">Debit</th>
                  <th class="font-label-md text-label-md text-on-surface-variant p-2 text-right">Credit</th>
                  <th class="p-2"></th>
                </tr></thead>
                <tbody id="jnl-lines-body"></tbody>
              </table>
            </div>
            <button type="button" id="jnl-add-line" class="mt-2 text-secondary font-body-sm hover:underline">+ Add Line</button>
          </div>
          <div class="flex justify-between items-center pt-stack-sm border-t border-outline-variant/30">
            <div>
              <span class="font-label-md text-label-md text-on-surface-variant">Total Debit: <span id="jnl-total-dr" class="font-code font-medium text-on-surface">0.00</span></span>
              <span class="font-label-md text-label-md text-on-surface-variant">Total Credit: <span id="jnl-total-cr" class="font-code font-medium text-on-surface">0.00</span></span>
              <span id="jnl-balance-indicator" class="font-label-md font-medium"></span>
            </div>
            <div class="flex gap-stack-sm">
              <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
              <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Post Entry'}</button>
            </div>
          </div>
        </form>
      `
    });
    modal.open();
    this.journalLines = [{ account_id: '', description: '', debit_amount: '', credit_amount: '' }];

    // Load financial years into the dropdown
    this._loadFinancialYears(modal.element, row?.financial_year_id);

    this.renderJournalLines();

    modal.element.querySelector('#jnl-add-line').addEventListener('click', () => {
      this.journalLines.push({ account_id: '', description: '', debit_amount: '', credit_amount: '' });
      this.renderJournalLines();
    });

    modal.element.querySelector('#jnl-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('financial_year_id')) {
        Toast.error('Financial year is required');
        return;
      }
      const lines = this.journalLines.map(l => ({
        account_id: l.account_id,
        description: l.description,
        debit_amount: parseFloat(l.debit_amount) || 0,
        credit_amount: parseFloat(l.credit_amount) || 0,
        cost_centre_id: l.cost_centre_id || null
      }));
      let dr = 0, cr = 0;
      lines.forEach(l => { dr += l.debit_amount; cr += l.credit_amount; });
      if (Math.abs(dr - cr) > 0.001) {
        Toast.error(`Unbalanced: Debit ${AccountingState.fmt(dr)} != Credit ${AccountingState.fmt(cr)}`);
        return;
      }
      try {
        await API.post('/accounting/journal', {
          entry_date: fd.get('entry_date'),
          financial_year_id: fd.get('financial_year_id'),
          description: fd.get('description'),
          reference_number: fd.get('reference_number'),
          lines
        });
        Toast.success('Journal entry posted'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  renderJournalLines() {
    const tbody = document.getElementById('jnl-lines-body');
    if (!tbody) return;
    tbody.innerHTML = this.journalLines.map((l, idx) => `
      <tr class="border-b border-outline-variant/20">
        <td class="p-2">
          <select data-idx="${idx}" data-k="account_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm">
            <option value="">Select account</option>
          </select>
        </td>
        <td class="p-2"><input data-idx="${idx}" data-k="description" value="${l.description || ''}" placeholder="Narrative" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/></td>
        <td class="p-2"><input data-idx="${idx}" data-k="debit_amount" type="number" step="0.01" value="${l.debit_amount || ''}" placeholder="0.00" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm text-right"/></td>
        <td class="p-2"><input data-idx="${idx}" data-k="credit_amount" type="number" step="0.01" value="${l.credit_amount || ''}" placeholder="0.00" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm text-right"/></td>
        <td class="p-2"><button type="button" data-rm="${idx}" class="text-error"><span class="material-symbols-outlined text-[16px]">close</span></button></td>
      </tr>
    `).join('');

    // Load accounts into select
    this._loadAccounts().then(accounts => {
      tbody.querySelectorAll('select[data-k="account_id"]').forEach(sel => {
        const idx = parseInt(sel.dataset.idx);
        const current = this.journalLines[idx].account_id;
        sel.innerHTML = '<option value="">Select account</option>' + accounts.map(a =>
          `<option value="${a.id}" ${a.id === current ? 'selected' : ''}>${a.code} - ${a.name}</option>`
        ).join('');
      });
    });

    // Bind input events
    tbody.querySelectorAll('input[data-idx]').forEach(inp => {
      inp.addEventListener('input', (e) => {
        this.journalLines[+inp.dataset.idx][inp.dataset.k] = inp.type === 'number' ? parseFloat(inp.value) || '' : inp.value;
        this.updateTotals();
      });
    });
    tbody.querySelectorAll('select[data-idx]').forEach(sel => {
      sel.addEventListener('change', (e) => {
        this.journalLines[+sel.dataset.idx][sel.dataset.k] = sel.value;
      });
    });
    tbody.querySelectorAll('[data-rm]').forEach(b => {
      b.addEventListener('click', () => { this.journalLines.splice(+b.dataset.rm, 1); this.renderJournalLines(); });
    });
    this.updateTotals();
  },

  async _loadFinancialYears(modalEl, selectedId = '') {
    try {
      const res = await API.get('/accounting/financial-years');
      const fys = res?.items || res?.data?.items || res?.financialYears || res?.data?.financialYears || [];
      const sel = modalEl.querySelector('select[name="financial_year_id"]');
      if (!sel) return;
      sel.innerHTML = '<option value="">Select financial year</option>' + fys.map(fy =>
        '<option value="' + fy.id + '" ' + (fy.id === selectedId ? 'selected' : '') + '>' + fy.name + '</option>'
      ).join('');
    } catch {
      const sel = modalEl.querySelector('select[name="financial_year_id"]');
      if (sel) sel.innerHTML = '<option value="">No financial years available</option>';
    }
  },

  async _loadAccounts() {
    try {
      const res = await API.get('/accounting/accounts', { limit: 1000 });
      return res?.data?.items || res?.items || [];
    } catch { return []; }
  },

  updateTotals() {
    let dr = 0, cr = 0;
    this.journalLines.forEach(l => { dr += parseFloat(l.debit_amount) || 0; cr += parseFloat(l.credit_amount) || 0; });
    document.getElementById('jnl-total-dr').textContent = AccountingState.fmt(dr);
    document.getElementById('jnl-total-cr').textContent = AccountingState.fmt(cr);
    const indicator = document.getElementById('jnl-balance-indicator');
    if (Math.abs(dr - cr) > 0.001) {
      indicator.textContent = '⚠ Unbalanced';
      indicator.className = 'font-label-md font-medium text-error';
    } else {
      indicator.textContent = '✓ Balanced';
      indicator.className = 'font-label-md font-medium text-green-700';
    }
  }
};
