window.PageModules = window.PageModules || {};

window.PageModules.receivables = {
  table: null,
  pagination: null,
  state: { page: 1, pageSize: 20, search: '', status: '', from: '', to: '', customer: '' },
  searchTimer: null,

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Accounts Receivable</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Customer receivables, outstanding tracking, and aging.</p>
          </div>
        </div>

        <div id="acc-recent-summary" class="grid grid-cols-2 sm:grid-cols-4 gap-stack-md mb-stack-lg"></div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
            <div class="relative flex-1 min-w-[200px]">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
              <input id="rec-search" placeholder="Search receivables..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <select id="rec-status" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="">All status</option>
              <option value="CURRENT">Current</option>
              <option value="DUE_SOON">Due Soon</option>
              <option value="OVERDUE">Overdue</option>
              <option value="PARTIALLY_PAID">Partially Paid</option>
              <option value="PAID">Paid</option>
            </select>
            <input id="rec-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="rec-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div id="rec-table"></div>
          <div id="rec-pagination" class="p-container-padding border-t border-outline-variant/30"></div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    await this.loadSummary();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('rec-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.load(); }, 300);
    });
    document.getElementById('rec-status').addEventListener('change', (e) => {
      this.state.status = e.target.value; this.state.page = 1; this.load();
    });
    document.getElementById('rec-from').addEventListener('change', (e) => { this.state.from = e.target.value; this.load(); });
    document.getElementById('rec-to').addEventListener('change', (e) => { this.state.to = e.target.value; this.load(); });
  },

  async load() {
    const container = document.getElementById('rec-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = {
        page: this.state.page, limit: this.state.pageSize,
        q: this.state.search, status: this.state.status,
        start_date: this.state.from, end_date: this.state.to
      };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/accounting/receivables', params);
      const data = res?.data || res || {};
      const items = data.items || [];
      const total = data.total || items.length;
      this.renderTable(container, items, total);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  async loadSummary() {
    try {
      const res = await API.get('/accounting/receivables/summary');
      const s = res?.data || res || {};
      const aging = s.aging?.[0] || {};
      const container = document.getElementById('acc-recent-summary');
      container.innerHTML = [
        this.summaryCard('Total Receivables', this.fmt(s.total_outstanding), 'account_balance', 'bg-blue-100 text-blue-700'),
        this.summaryCard('Overdue', this.fmt(aging?.total_overdue), 'warning', 'bg-red-100 text-red-700'),
        this.summaryCard('Current', this.fmt(aging?.current), 'schedule', 'bg-green-100 text-green-700'),
        this.summaryCard('31-60 days', this.fmt(aging?.aging_31_60 || aging?.d31_60), 'calendar_month', 'bg-yellow-100 text-yellow-700'),
      ].join('');
    } catch {}
  },

  summaryCard(label, value, icon, colorClass) {
    return `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
        <div class="flex items-center gap-stack-sm">
          <span class="material-symbols-outlined text-[20px] ${colorClass}">${icon}</span>
          <div>
            <p class="font-body-sm text-body-sm text-on-surface-variant">${label}</p>
            <p class="font-display text-h2 text-on-surface">${value}</p>
          </div>
        </div>
      </div>
    `;
  },

  renderTable(container, items, total) {
    this.table = new DataTable(container, {
      columns: [
        { key: 'bill_number', label: 'Bill #', render: (v, r) => `<a href="#accounting/bills/${r.bill_id}" class="font-code text-secondary font-medium">${v || r.bill_number || ''}</a>` },
        { key: 'customerName', label: 'Customer', render: (v, r) => r.first_name ? `${r.first_name} ${r.last_name || ''}` : (r.organization_name || '—') },
        { key: 'due_date', label: 'Due Date' },
        { key: 'original_amount', label: 'Original', render: (v, r) => `<span class="font-code">${this.fmt(v, r.currency)}</span>`, align: 'right' },
        { key: 'paid_amount', label: 'Paid', render: (v, r) => `<span class="font-code">${this.fmt(v, r.currency)}</span>`, align: 'right' },
        { key: 'outstanding_amount', label: 'Outstanding', render: (v, r) => `<span class="font-medium font-code text-secondary">${this.fmt(v, r.currency)}</span>`, align: 'right' },
        { key: 'days_overdue', label: 'Days Overdue', render: (v, r) => `<span class="${v > 0 ? 'text-error font-medium' : ''}">${v || 0}</span>` },
        { key: 'status', label: 'Status', render: (v) => AccountingState.getReceivableStatusLabel(v) ?
          `<span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] gap-1 ${AccountingState.getReceivableStatusLabel(v).bg}">
            <span class="w-1.5 h-1.5 rounded-full ${AccountingState.getReceivableStatusLabel(v).dot}"></span>
            ${AccountingState.getReceivableStatusLabel(v).label}
          </span>` : '' },
      ],
      data: items,
      emptyState: 'No receivables found',
      rowActions: (row) => {
        const modal = new Modal({
          title: row.bill_number || row.id, size: 'sm',
          content: '<div class="flex flex-col gap-1">' +
            '<button data-act="view" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">visibility</span> View Bill</button>' +
            '<button data-act="pay" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">payment</span> Record Payment</button>' +
            '</div>'
        });
        modal.open();
        modal.element.addEventListener('click', async (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (!act) return;
          modal.close();
          if (act === 'view') window.location.hash = `#accounting/bills/${row.bill_id}`;
          if (act === 'pay') window.PageModules.bills.recordPayment(row);
        });
      },
    });
    if (!this.pagination) {
      this.pagination = new Pagination(document.getElementById('rec-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
        onPageChange: (p) => { this.state.page = p; this.load(); },
      });
    } else {
      this.pagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
    }
  },

  fmt(n, currency) { return AccountingState.fmt(n, currency || AccountingState.currentCurrency); }
};
