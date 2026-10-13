window.PageModules = window.PageModules || {};

window.PageModules.bills = {
  table: null,
  pagination: null,
  state: { page: 1, pageSize: 20, search: '', type: 'CUSTOMER', status: '', from: '', to: '' },
  searchTimer: null,

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Customer Bills</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Create and manage customer bills (replaces legacy invoices).</p>
          </div>
          <button id="bill-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
            <span class="material-symbols-outlined text-[18px]">add</span> New Bill
          </button>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
            <div class="relative flex-1 min-w-[200px]">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
              <input id="bill-search" placeholder="Search bills..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <select id="bill-status" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="">All status</option>
              <option value="DRAFT">Draft</option>
              <option value="SENT">Sent</option>
              <option value="PARTIAL">Partially Paid</option>
              <option value="PAID">Paid</option>
              <option value="OVERDUE">Overdue</option>
            </select>
            <input id="bill-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="bill-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div id="bill-table"></div>
          <div id="bill-pagination" class="p-container-padding border-t border-outline-variant/30"></div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('bill-new').addEventListener('click', () => this.openForm());
    document.getElementById('bill-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.load(); }, 300);
    });
    document.getElementById('bill-status').addEventListener('change', (e) => {
      this.state.status = e.target.value; this.state.page = 1; this.load();
    });
    document.getElementById('bill-from').addEventListener('change', (e) => { this.state.from = e.target.value; this.load(); });
    document.getElementById('bill-to').addEventListener('change', (e) => { this.state.to = e.target.value; this.load(); });
  },

  async load() {
    const container = document.getElementById('bill-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = {
        page: this.state.page, limit: this.state.pageSize, bill_type: this.state.type,
        q: this.state.search, status: this.state.status,
        start_date: this.state.from, end_date: this.state.to
      };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/accounting/bills', params);
      const data = res?.data || res || {};
      const items = data.items || data.bills || [];
      const total = data.total || items.length;
      this.renderTable(container, items, total);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  renderTable(container, items, total) {
    this.table = new DataTable(container, {
      columns: [
        { key: 'bill_number', label: 'Bill #', render: (v, r) => `<a href="#accounting/bills/${r.id}" class="font-code text-secondary font-medium">${v || ''}</a>` },
        { key: 'contactName', label: 'Customer', render: (v, r) => v || r.contact_name || '—' },
        { key: 'issue_date', label: 'Issue Date' },
        { key: 'due_date', label: 'Due Date', render: (v, r) => {
          const overdue = v && new Date(v) < new Date();
          return `<span class="${overdue ? 'text-error' : ''}">${v || ''}</span>`;
        }},
        { key: 'total', label: 'Amount', render: (v, r) => `<span class="font-medium font-code">${this.fmt(v, r.currency)}</span>`, align: 'right' },
        { key: 'balance', label: 'Balance', render: (v, r) => `<span class="font-medium font-code text-secondary">${this.fmt(v, r.currency)}</span>`, align: 'right' },
        { key: 'status', label: 'Status', render: (v) => AccountingState.statusBadge(v) },
      ],
      data: items,
      emptyState: 'No bills found',
      rowActions: (row) => this.openRowMenu(row),
    });
    if (!this.pagination) {
      this.pagination = new Pagination(document.getElementById('bill-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
        onPageChange: (p) => { this.state.page = p; this.load(); },
      });
    } else {
      this.pagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
    }
  },

  openRowMenu(row) {
    const menu = '<div class="flex flex-col gap-1">' +
      '<button data-act="view" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">visibility</span> View</button>' +
      '<button data-act="record-payment" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">payment</span> Record Payment</button>' +
      '<button data-act="edit" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>' +
      '<button data-act="delete" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-error text-left"><span class="material-symbols-outlined text-[18px]">delete</span> Delete</button></div>';
    const modal = new Modal({ title: row.bill_number || row.id, size: 'sm', content: menu });
    modal.open();
    modal.element.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      modal.close();
      if (act === 'view') return this.view(row);
      if (act === 'record-payment') return this.recordPayment(row);
      if (act === 'edit') return this.openForm(row);
      if (act === 'delete') return this.confirmDelete(row);
    });
  },

  async view(row) {
    const container = document.getElementById('page-container');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/accounting/bills/' + row.id);
      const bill = res?.data || res || {};
      const items = bill.items || [];

      let subtotal = 0;
      const linesHtml = items.map(i => {
        const lineTotal = parseFloat(i.quantity || 0) * parseFloat(i.unit_price || 0);
        subtotal += lineTotal;
        return `<tr class="border-b border-outline-variant/20">
          <td class="py-2">${i.description || ''}</td>
          <td class="py-2 text-center">${i.quantity || 0}</td>
          <td class="py-2 text-right font-code">${this.fmt(i.unit_price, bill.currency)}</td>
          <td class="py-2 text-right font-code">${this.fmt(lineTotal, bill.currency)}</td>
        </tr>`;
      }).join('');

      container.innerHTML = `
        <div class="space-y-stack-lg">
          <div class="flex items-center justify-between">
            <h1 class="font-display text-h1 text-on-surface">${bill.bill_number}</h1>
            <button id="bill-back" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high">
              <span class="material-symbols-outlined text-[18px]">arrow_back</span> Back to Bills
            </button>
          </div>

          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-stack-md mb-stack-lg">
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Issue Date</span><p class="font-body-md text-body-md text-on-surface">${bill.issue_date}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Due Date</span><p class="font-body-md text-body-md text-on-surface">${bill.due_date}</p></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Status</span><div class="mt-1">${AccountingState.statusBadge(bill.status)}</div></div>
              <div><span class="font-label-md text-label-md text-on-surface-variant uppercase">Currency</span><p class="font-body-md text-body-md text-on-surface">${bill.currency}</p></div>
            </div>

            <table class="w-full mb-stack-lg">
              <thead><tr class="border-b border-outline-variant/30">
                <th class="text-left py-2 font-label-md text-label-md text-on-surface-variant">Description</th>
                <th class="text-center py-2 font-label-md text-label-md text-on-surface-variant">Qty</th>
                <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Unit Price</th>
                <th class="text-right py-2 font-label-md text-label-md text-on-surface-variant">Total</th>
              </tr></thead>
              <tbody>${linesHtml}</tbody>
            </table>

            <div class="flex justify-end">
              <table class="text-right">
                <tr><td class="font-label-md text-on-surface-variant pr-4">Subtotal</td><td class="font-code w-[120px] text-right">${this.fmt(subtotal, bill.currency)}</td></tr>
                <tr><td class="font-label-md text-on-surface-variant pr-4">Tax</td><td class="font-code w-[120px] text-right">${this.fmt(bill.tax, bill.currency)}</td></tr>
                <tr><td class="font-label-md text-on-surface-variant pr-4">Discount</td><td class="font-code w-[120px] text-right">${this.fmt(bill.discount, bill.currency)}</td></tr>
                <tr class="border-t border-outline-variant/30"><td class="font-label-md text-on-surface pr-4">Total</td><td class="font-display font-bold w-[120px] text-right">${this.fmt(bill.total, bill.currency)}</td></tr>
                <tr><td class="font-label-md text-on-surface-variant pr-4">Paid</td><td class="font-code w-[120px] text-right">${this.fmt(bill.paid_amount, bill.currency)}</td></tr>
                <tr class="border-t border-outline-variant/30"><td class="font-display text-h1 text-on-surface pr-4">Balance</td><td class="font-display font-bold w-[120px] text-right text-secondary">${this.fmt(bill.balance, bill.currency)}</td></tr>
              </table>
            </div>
          </div>
        </div>
      `;
      document.getElementById('bill-back').addEventListener('click', () => this.load());
    } catch (err) {
      const container = document.getElementById('page-container');
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-error">error</span><p class="text-on-surface-variant mt-2">' + (err.message || 'Failed') + '</p></div>';
    }
  },

  recordPayment(row) {
    const modal = new Modal({
      title: 'Record Payment', size: 'md',
      content: `
        <form id="payment-form" class="space-y-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Amount *</label><input name="amount" type="number" step="0.01" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Payment Date</label><input name="payment_date" type="date" value="${new Date().toISOString().split('T')[0]}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reference</label><input name="reference_number" placeholder="Check #, Transaction ID..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Notes</label><textarea name="notes" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Record Payment</button>
          </div>
        </form>
      `
    });
    modal.open();
    modal.element.querySelector('#payment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/accounting/payments', {
          bill_id: row.id,
          amount: parseFloat(fd.get('amount')),
          payment_date: fd.get('payment_date'),
          reference_number: fd.get('reference_number'),
          notes: fd.get('notes')
        });
        Toast.success('Payment recorded'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  openForm(row = null) {
    const isEdit = !!row;
    const i = row || {};
    const modal = new Modal({
      title: isEdit ? 'Edit Bill' : 'New Customer Bill', size: '4xl',
      content: `
        <form id="bill-form" class="space-y-stack-md">
          <div class="grid grid-cols-3 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Bill #</label><input name="bill_number" value="${i.bill_number || 'BILL-' + Date.now()}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Issue Date *</label><input name="issue_date" type="date" required value="${i.issue_date || new Date().toISOString().split('T')[0]}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Due Date *</label><input name="due_date" type="date" required value="${i.due_date || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer *</label>
            <div id="bill-contact-selector"></div>
            <div id="bill-contact-info" class="hidden mt-2 p-stack-sm bg-surface-container rounded-lg font-body-sm text-body-sm text-on-surface-variant"></div>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Line Items</label>
            <div id="bill-items"></div>
            <button type="button" id="bill-add-line" class="mt-2 text-secondary font-body-sm hover:underline">+ Add line</button>
          </div>
          <div class="flex justify-between items-center pt-stack-sm border-t border-outline-variant/30">
            <div class="text-right">
              <p class="font-label-md text-on-surface-variant">Subtotal: <span id="bill-subtotal" class="font-code font-medium">${this.fmt(0)}</span></p>
              <p class="font-label-md text-on-surface-variant">Tax: <span id="bill-tax" class="font-code font-medium">${this.fmt(0)}</span></p>
              <p class="font-display text-h1 text-on-surface">Total: <span id="bill-total" class="font-code">${this.fmt(0)}</span></p>
            </div>
            <div class="flex gap-stack-sm">
              <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
              <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'} Bill</button>
            </div>
          </div>
        </form>
      `
    });
    modal.open();

    let billContact = null;
    const contactSelector = new EntitySelector(modal.element.querySelector('#bill-contact-selector'), {
      type: 'contact', placeholder: 'Select customer...', allowCreate: true,
      onCreate: () => window.PageModules.contacts.openFormAndWait(),
      onChange: async (c) => {
        if (!c) { document.getElementById('bill-contact-info').classList.add('hidden'); billContact = null; return; }
        billContact = c;
        let orgName = '';
        const orgId = c.organizationId || c.organization_id;
        if (orgId) { try { const o = await API.get('/organizations/' + orgId); orgName = (o?.data || o)?.name || ''; } catch {} }
        document.getElementById('bill-contact-info').innerHTML = (c.email || 'no email') + ' · ' + (c.phone || 'no phone') + (orgName ? ' · ' + orgName : '');
        document.getElementById('bill-contact-info').classList.remove('hidden');
      },
    });

    this.billLines = i.items && i.items.length ? i.items.map(it => ({ ...it })) : [{ description: '', quantity: 1, unit_price: 0, tax_rate: 0, gl_account_id: '' }];
    this.renderBillLines();

    modal.element.querySelector('#bill-add-line').addEventListener('click', () => {
      this.billLines.push({ description: '', quantity: 1, unit_price: 0, tax_rate: 0, gl_account_id: '' });
      this.renderBillLines();
    });

    modal.element.querySelector('#bill-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!billContact) { Toast.error('Select a customer'); return; }
      const lines = this.billLines.map(l => ({
        description: l.description || '',
        quantity: parseFloat(l.quantity) || 1,
        unit_price: parseFloat(l.unit_price) || 0,
        tax_rate: parseFloat(l.tax_rate) || 0,
        discount: parseFloat(l.discount) || 0,
        gl_account_id: l.gl_account_id || null
      }));
      try {
        const payload = {
          bill_number: fd.get('bill_number') || undefined,
          contact_id: billContact.id,
          organization_id: billContact.organizationId || billContact.organization_id || null,
          currency: this.currentCurrency,
          issue_date: fd.get('issue_date'),
          due_date: fd.get('due_date'),
          lines: lines
        };
        if (isEdit) await API.put('/accounting/bills/' + i.id, payload);
        else await API.post('/accounting/bills', payload);
        Toast.success(isEdit ? 'Bill updated' : 'Bill created'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  renderBillLines() {
    const c = document.getElementById('bill-items');
    if (!c) return;
    c.innerHTML = this.billLines.map((l, idx) => `
      <div class="grid grid-cols-12 gap-stack-sm mb-2">
        <input data-idx="${idx}" data-k="description" value="${l.description || ''}" placeholder="Description" class="col-span-4 bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/>
        <input data-idx="${idx}" data-k="quantity" type="number" step="0.01" value="${l.quantity || 1}" placeholder="Qty" class="col-span-1 bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/>
        <input data-idx="${idx}" data-k="unit_price" type="number" step="0.01" value="${l.unit_price || 0}" placeholder="Price" class="col-span-2 bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/>
        <input data-idx="${idx}" data-k="tax_rate" type="number" step="0.01" value="${l.tax_rate || 0}" placeholder="Tax %" class="col-span-1 bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/>
        <input data-idx="${idx}" data-k="discount" type="number" step="0.01" value="${l.discount || 0}" placeholder="Disc" class="col-span-1 bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/>
        <input data-idx="${idx}" data-k="gl_account_id" type="text" value="${l.gl_account_id || ''}" placeholder="GL Account" class="col-span-2 bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/>
        <button type="button" data-rm="${idx}" class="col-span-1 text-error"><span class="material-symbols-outlined text-[16px]">close</span></button>
      </div>
    `).join('');

    c.querySelectorAll('input[data-idx]').forEach(inp => {
      inp.addEventListener('input', (e) => {
        this.billLines[+inp.dataset.idx][inp.dataset.k] = inp.type === 'number' ? parseFloat(inp.value) || '' : inp.value;
        this.updateBillTotals();
      });
    });
    c.querySelectorAll('[data-rm]').forEach(b => {
      b.addEventListener('click', () => { this.billLines.splice(+b.dataset.rm, 1); this.renderBillLines(); });
    });
    this.updateBillTotals();
  },

  updateBillTotals() {
    let subtotal = 0, tax = 0;
    this.billLines.forEach(l => {
      const lineTotal = (parseFloat(l.quantity) || 1) * (parseFloat(l.unit_price) || 0);
      const lineTax = lineTotal * (parseFloat(l.tax_rate) || 0) / 100;
      subtotal += lineTotal;
      tax += lineTax;
    });
    const total = subtotal + tax - (parseFloat(this.discount || 0) || 0);
    document.getElementById('bill-subtotal').textContent = this.fmt(subtotal);
    document.getElementById('bill-tax').textContent = this.fmt(tax);
    document.getElementById('bill-total').textContent = this.fmt(total);
  },

  confirmDelete(row) {
    const modal = new Modal({
      title: 'Delete bill?', size: 'sm',
      content: `<p class="font-body-md text-on-surface mb-stack-md">Delete <strong>${row.bill_number}</strong>?</p>
        <div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
        <button id="confirm-bill-delete" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Delete</button></div>`
    });
    modal.open();
    modal.element.querySelector('#confirm-bill-delete').addEventListener('click', async () => {
      try { await API.del('/accounting/bills/' + row.id); Toast.success('Deleted'); modal.close(); this.load(); }
      catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  fmt(n, currency) { return AccountingState.fmt(n, currency || this.currentCurrency); }
};
