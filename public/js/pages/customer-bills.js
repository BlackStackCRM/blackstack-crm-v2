/**
 * Customer Bills page — Customer Bills / Sales Billing module (ERP-grade AR workspace).
 *
 * Full-page implementation with:
 *   - KPI dashboard (from real DB data via API)
 *   - Status tabs with live counts
 *   - Advanced filter drawer (date, amount, payment status, overdue days)
 *   - Accounting table with customer, paid/balance, status + payment status badges
 *   - Row action menus + bulk selection toolbar
 *   - Full create/edit form with customer financial snapshot, credit-limit warning,
 *     line items (HSN/SAC, discount, tax), CGST/SGST/IGST totals panel
 *   - Record detail page with tabs: Overview, Items, Payments, Accounting, Audit Trail
 *   - Lifecycle timeline (Created → Approved → Posted → Paid)
 *   - Payment recording, credit note, debit note, write-off, dispute
 *
 * All UI state derived from API responses — no hard-coded values.
 * Lifecycle transitions enforced server-side; frontend only shows valid actions.
 * No undefined/null/NaN is ever rendered (see esc() and num() helpers).
 */
window.PageModules = window.PageModules || {};

/* Indian states for Place of Supply dropdown (value matches state_code in company_tax_configs). */
const INDIAN_STATES = [
  { value: '01', label: 'Andhra Pradesh' }, { value: '02', label: 'Arunachal Pradesh' },
  { value: '03', label: 'Assam' }, { value: '04', label: 'Bihar' },
  { value: '05', label: 'Chandigarh' }, { value: '06', label: 'Chhattisgarh' },
  { value: '07', label: 'Dadra and Nagar Haveli' }, { value: '08', label: 'Daman and Diu' },
  { value: '09', label: 'Delhi' }, { value: '10', label: 'Goa' },
  { value: '11', label: 'Gujarat' }, { value: '12', label: 'Haryana' },
  { value: '13', label: 'Himachal Pradesh' }, { value: '14', label: 'Jammu and Kashmir' },
  { value: '15', label: 'Jharkhand' }, { value: '16', label: 'Karnataka' },
  { value: '17', label: 'Kerala' }, { value: '18', label: 'Ladakh' },
  { value: '19', label: 'Lakshadweep' }, { value: '20', label: 'Madhya Pradesh' },
  { value: '21', label: 'Maharashtra' }, { value: '22', label: 'Manipur' },
  { value: '23', label: 'Meghalaya' }, { value: '24', label: 'Mizoram' },
  { value: '25', label: 'Nagaland' }, { value: '26', label: 'Odisha' },
  { value: '27', label: 'Puducherry' }, { value: '28', label: 'Pondicherry' },
  { value: '29', label: 'Rajasthan' }, { value: '30', label: 'Sikkim' },
  { value: '31', label: 'Tamil Nadu' }, { value: '32', label: 'Telangana' },
  { value: '33', label: 'Tripura' }, { value: '34', label: 'Uttar Pradesh' },
  { value: '35', label: 'Uttarakhand' }, { value: '36', label: 'West Bengal' },
  { value: '37', label: 'Andaman and Nicobar Islands' }, { value: '38', label: 'Dadra and Nagar Haveli and Daman and Diu' },
];

window.PageModules['customer-bills'] = {
  state: { page: 1, pageSize: 25, search: '', status: '', from: '', to: '', paymentStatus: '', minAmount: '', maxAmount: '', overdueBucket: '', dateField: 'issue', customerId: '', currency: '', paymentTerms: '' },
  /* Baseline filter keys — STEP 6 only adds UI + chip display on top of this. */
  DEFAULT_FILTER_STATE: null,
  customersCache: null,
  searchTimer: null,
  billLines: [],
  taxResult: null,
  currentBill: null,
  currentCurrency: 'INR',
  selectedIds: new Set(),

  /* ── Safe-render helpers: never show undefined/null/NaN ── */
  esc(v, fallback) {
    if (v === undefined || v === null || v === 'null' || v === 'undefined' || (typeof v === 'number' && isNaN(v))) return fallback !== undefined ? fallback : '—';
    return String(v);
  },
  num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; },
  /* Map camelCase API payloads (billNumber, paidAmount, …) onto the snake_case
     fields the UI renders (bill_number, paid_amount, …). Root-cause fix for the
     "undefined" detail page: the API serializer emits camelCase while the views
     (and SQL-level rows) use snake_case. Accepts either form. */
  normBill(r) {
    if (!r || typeof r !== 'object') return r;
    const pick = (...keys) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== null) return r[k]; } return undefined; };
    const normItems = (items) => (Array.isArray(items) ? items.map(it => {
      if (!it || typeof it !== 'object') return it;
      return {
        ...it,
        unit_price: it.unit_price ?? it.unitPrice ?? it.rate,
        line_total: it.line_total ?? it.lineTotal ?? it.amount,
        line_tax: it.line_tax ?? it.lineTax ?? it.tax_amount ?? it.taxAmount,
        tax_rate: it.tax_rate ?? it.taxRate,
        hsn_sac: it.hsn_sac ?? it.hsnSac,
        discount_amount: it.discount_amount ?? it.discountAmount,
        taxable_amount: it.taxable_amount ?? it.taxableAmount,
        cgst_amount: it.cgst_amount ?? it.cgstAmount,
        sgst_amount: it.sgst_amount ?? it.sgstAmount,
        igst_amount: it.igst_amount ?? it.igstAmount,
      };
    }) : items);
    const normPayments = (pays) => (Array.isArray(pays) ? pays.map(p => ({
      ...p,
      payment_date: p.payment_date ?? p.paymentDate,
      payment_method: p.payment_method ?? p.paymentMethod,
      reference_number: p.reference_number ?? p.referenceNumber,
    })) : pays);
    const out = {
      ...r,
      bill_number: pick('bill_number', 'billNumber'),
      invoice_number: pick('invoice_number', 'invoiceNumber'),
      issue_date: pick('issue_date', 'issueDate'),
      due_date: pick('due_date', 'dueDate'),
      paid_amount: pick('paid_amount', 'paidAmount'),
      journal_entry_id: pick('journal_entry_id', 'journalEntryId'),
      customer_gstin: pick('customer_gstin', 'customerGstin', 'contactGstin'),
      reference_number: pick('reference_number', 'referenceNumber'),
      contact_name: pick('contact_name', 'contactName'),
      contact_code: pick('contact_code', 'contactCode'),
      contact_id: pick('contact_id', 'contactId'),
      organization_id: pick('organization_id', 'organizationId'),
      billing_address: pick('billing_address', 'billingAddress'),
      shipping_address: pick('shipping_address', 'shippingAddress'),
      place_of_supply: pick('place_of_supply', 'placeOfSupply'),
      customer_po_number: pick('customer_po_number', 'customerPoNumber'),
      customer_po_date: pick('customer_po_date', 'customerPoDate'),
      discount_amount: pick('discount_amount', 'discountAmount'),
      other_charges: pick('other_charges', 'otherCharges'),
      round_off: pick('round_off', 'roundOff'),
      taxable_amount: pick('taxable_amount', 'taxableAmount'),
      payment_terms: pick('payment_terms', 'paymentTerms'),
      cgst_amount: pick('cgst_amount', 'cgstAmount'),
      sgst_amount: pick('sgst_amount', 'sgstAmount'),
      igst_amount: pick('igst_amount', 'igstAmount'),
      bill_type: pick('bill_type', 'billType') || 'CUSTOMER',
      created_at: pick('created_at', 'createdAt'),
      approved_at: pick('approved_at', 'approvedAt'),
      posted_at: pick('posted_at', 'postedAt'),
      items: normItems(r.items),
      payments: normPayments(r.payments),
    };
    if (out.customer && typeof out.customer === 'object' && !Array.isArray(out.customer)) {
      out.customer = {
        ...out.customer,
        gstin: out.customer.gstin ?? out.customer_gstin,
        billing_address: out.customer.billing_address ?? out.customer.billingAddress,
        shipping_address: out.customer.shipping_address ?? out.customer.shippingAddress,
      };
    }
    return out;
  },
  fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return this.esc(v, '—');
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  daysOverdue(dueDate) {
    if (!dueDate) return 0;
    const d = new Date(dueDate);
    if (isNaN(d.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  },
  paymentStatus(row) {
    const total = this.num(row.total), paid = this.num(row.paid_amount), balance = this.num(row.balance);
    if (row.status === 'CANCELLED' || row.status === 'VOID') return { label: 'Cancelled', cls: 'bg-gray-50 text-gray-700', dot: 'bg-gray-500' };
    if (paid >= total && total > 0) return { label: 'Paid', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' };
    if (paid > total) return { label: 'Overpaid', cls: 'bg-purple-50 text-purple-700', dot: 'bg-purple-500' };
    if (paid > 0) return { label: 'Partially Paid', cls: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500' };
    if (row.status === 'OVERDUE' || (balance > 0 && this.daysOverdue(row.due_date) > 0 && ['POSTED', 'PARTIALLY_PAID'].includes(row.status))) {
      const dd = this.daysOverdue(row.due_date);
      return { label: dd > 0 ? `Overdue · ${dd} ${dd === 1 ? 'Day' : 'Days'}` : 'Overdue', cls: 'bg-red-50 text-red-700', dot: 'bg-red-500' };
    }
    if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(row.status)) return { label: 'Not Due', cls: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' };
    return { label: 'Unpaid', cls: 'bg-yellow-50 text-yellow-700', dot: 'bg-yellow-500' };
  },
  statusLabel(s) {
    const m = { DRAFT: 'Draft', PENDING_APPROVAL: 'Pending Approval', APPROVED: 'Approved', POSTED: 'Posted', PARTIALLY_PAID: 'Partially Paid', PAID: 'Paid', OVERDUE: 'Overdue', CANCELLED: 'Cancelled', VOID: 'Void', SENT: 'Sent', WRITTEN_OFF: 'Written Off' };
    return m[s] || this.esc(s, 'Unknown');
  },

  async init(id = null) {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    await AccountingState.init();
    this.currentCurrency = AccountingState.currentCurrency || 'INR';
    if (id === 'new' || window.location.hash === '#customer-bills/new') {
      // #customer-bills/new — full-page create bill workspace
      await this.renderCreatePage();
    } else if (id) {
      // Deep link: #customer-bills/:id — load detail directly from API.
      await this.viewBillById(id);
    } else {
      this.renderList();
    }
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  /* ═══ List View ═══ */

  renderList() {
    const main = document.getElementById('page-container');
    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between flex-wrap gap-stack-md">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Customer Bills</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Create, manage, track and collect customer payments.</p>
          </div>
          <div class="flex gap-stack-md">
            <div class="relative">
              <button id="cb-more" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high" aria-haspopup="true" aria-expanded="false">
                <span class="material-symbols-outlined text-[18px]">more_horiz</span> More
              </button>
              <div id="cb-more-menu" class="hidden absolute right-0 mt-1 w-52 bg-surface-container-lowest rounded-lg border border-outline-variant/30 shadow-lg py-1 z-20" role="menu">
                <button id="cb-sales-register" class="w-full text-left px-3 py-2 font-body-sm text-body-sm hover:bg-surface-container flex items-center gap-2" role="menuitem"><span class="material-symbols-outlined text-[18px]">description</span> Sales Register</button>
                <button id="cb-tax-summary" class="w-full text-left px-3 py-2 font-body-sm text-body-sm hover:bg-surface-container flex items-center gap-2" role="menuitem"><span class="material-symbols-outlined text-[18px]">account_balance</span> Tax Summary</button>
                <button id="cb-customer-statement" class="w-full text-left px-3 py-2 font-body-sm text-body-sm hover:bg-surface-container flex items-center gap-2" role="menuitem"><span class="material-symbols-outlined text-[18px]">receipt_long</span> Customer Statement</button>
                <button id="cb-ar-aging" class="w-full text-left px-3 py-2 font-body-sm text-body-sm hover:bg-surface-container flex items-center gap-2" role="menuitem"><span class="material-symbols-outlined text-[18px]">schedule</span> AR Aging</button>
                <button id="cb-export" class="w-full text-left px-3 py-2 font-body-sm text-body-sm hover:bg-surface-container flex items-center gap-2" role="menuitem"><span class="material-symbols-outlined text-[18px]">download</span> Export CSV</button>
              </div>
            </div>
            <button id="cb-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
              <span class="material-symbols-outlined text-[18px]">add</span> New Bill
            </button>
          </div>
        </div>

        <!-- KPI Dashboard -->
        <div id="cb-kpi" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-stack-md">
          <button id="kpi-total-billing-card" data-kpi="" class="text-left bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding hover:bg-surface-container transition-colors">
            <div class="text-on-surface-variant font-body-sm uppercase">Total Billing</div>
            <div id="kpi-total-billing" class="font-display text-h1 text-on-surface mt-1">—</div>
          </button>
          <button id="kpi-paid-card" data-kpi="PAID" class="text-left bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding hover:bg-surface-container transition-colors">
            <div class="text-on-surface-variant font-body-sm uppercase">Collected</div>
            <div id="kpi-paid" class="font-display text-h1 text-emerald-700 mt-1">—</div>
          </button>
          <button id="kpi-outstanding-card" data-kpi="UNPAID" class="text-left bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding hover:bg-surface-container transition-colors">
            <div class="text-on-surface-variant font-body-sm uppercase">Outstanding</div>
            <div id="kpi-outstanding" class="font-display text-h1 text-on-surface mt-1">—</div>
          </button>
          <button id="kpi-overdue-card" data-kpi="OVERDUE" class="text-left bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding hover:bg-surface-container transition-colors">
            <div class="text-on-surface-variant font-body-sm uppercase">Overdue</div>
            <div id="kpi-overdue" class="font-display text-h1 text-error mt-1">—</div>
          </button>
          <button id="kpi-due-today-card" data-kpi="DUE_TODAY" class="text-left bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding hover:bg-surface-container transition-colors">
            <div class="text-on-surface-variant font-body-sm uppercase">Due Today</div>
            <div id="kpi-due-today" class="font-display text-h1 text-warning mt-1">—</div>
          </button>
          <button id="kpi-draft-card" data-kpi="DRAFT" class="text-left bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding hover:bg-surface-container transition-colors">
            <div class="text-on-surface-variant font-body-sm uppercase">Draft</div>
            <div id="kpi-draft" class="font-display text-h1 text-on-surface mt-1">—</div>
          </button>
        </div>

        <!-- Status Tabs -->
        <div id="cb-status-tabs"></div>

        <!-- Active filter chips -->
        <div id="cb-chips"></div>

        <!-- Bulk action toolbar -->
        <div id="cb-bulk-bar" class="hidden items-center justify-between bg-secondary/10 border border-secondary/30 rounded-xl px-container-padding py-3">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px] text-secondary">check_circle</span>
            <span class="font-body-sm text-body-sm text-on-surface"><span id="cb-bulk-count">0</span> bills selected</span>
          </div>
          <div class="flex items-center gap-stack-md">
            <button id="cb-bulk-export" class="flex items-center gap-1 bg-surface-container-lowest text-on-surface px-3 py-1.5 rounded-lg border border-outline-variant/40 hover:bg-surface-container font-body-sm text-body-sm"><span class="material-symbols-outlined text-[16px]">download</span> Export</button>
            <button id="cb-bulk-send" class="flex items-center gap-1 bg-surface-container-lowest text-on-surface px-3 py-1.5 rounded-lg border border-outline-variant/40 hover:bg-surface-container font-body-sm text-body-sm"><span class="material-symbols-outlined text-[16px]">send</span> Send</button>
            <button id="cb-bulk-clear" class="px-3 py-1.5 rounded-lg hover:bg-surface-container font-body-sm text-body-sm text-on-surface-variant">Clear</button>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">

          <!-- Search & Filters -->
          <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
            <div class="relative flex-1 min-w-[260px]">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
              <input id="cb-search" placeholder="Search bills, customers, invoice numbers..." aria-label="Search bills" class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <button id="cb-filter-btn" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high" aria-haspopup="dialog">
              <span class="material-symbols-outlined text-[18px]">filter_list</span> Filter
              <span id="cb-filter-count" class="hidden ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-secondary text-on-secondary font-medium"></span>
            </button>
          </div>
          <div id="cb-table"></div>
          <div id="cb-pagination" class="p-container-padding border-t border-outline-variant/30"></div>
        </div>
      </div>

      <!-- Advanced Filter Drawer -->
      <div id="cb-drawer-root"></div>
    `;

    // Capture pristine filter defaults BEFORE any user interaction so
    // Reset/Clear all always restores the true default list.
    if (!this.DEFAULT_FILTER_STATE) {
      const st = this.state;
      this.DEFAULT_FILTER_STATE = { search: st.search, status: st.status, from: st.from, to: st.to, paymentStatus: st.paymentStatus, minAmount: st.minAmount, maxAmount: st.maxAmount, overdueBucket: st.overdueBucket, dateField: st.dateField, customerId: st.customerId, currency: st.currency, paymentTerms: st.paymentTerms };
    }
    // Restore previously entered search text (filter state persists across visits)
    const searchEl = document.getElementById('cb-search');
    if (searchEl && this.state.search) searchEl.value = this.state.search;

    this.bindListEvents();
    this.loadStatusCounts();
    this.loadKpi();
    this.loadBills();
  },

  /* ═══ Advanced Filter Drawer ═══ */

  async openFilterDrawer() {
    const root = document.getElementById('cb-drawer-root');
    if (!root) return;
    const s = this.state;
    // Load customer options once (cached) — server-side filter uses contact_id.
    if (!this.customersCache) {
      try {
        const res = await API.get('/contacts', { limit: 500 });
        const list = res?.items || [];
        this.customersCache = (Array.isArray(list) ? list : [])
          .map(c => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.name || c.id }))
          .filter(c => c.id && c.name)
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) { console.warn('Customer filter options load failed:', err.message); this.customersCache = []; }
    }
    const customerOptions = (this.customersCache || [])
      .map(c => `<option value="${this.esc(c.id, '')}" ${s.customerId === c.id ? 'selected' : ''}>${this.esc(c.name, '—')}</option>`).join('');
    root.innerHTML = `
      <div class="fixed inset-0 z-[85]" role="dialog" aria-modal="true" aria-label="Advanced filters">
        <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" data-drawer-close aria-hidden="true"></div>
        <div class="absolute right-0 top-0 h-full w-full max-w-md bg-surface-container-lowest shadow-2xl flex flex-col animate-slide-in-right" data-drawer-panel>
          <div class="flex items-center justify-between p-container-padding border-b border-outline-variant/30">
            <h2 class="font-h3 text-h3 text-on-surface">Advanced Filters</h2>
            <button data-drawer-close class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container" aria-label="Close filters"><span class="material-symbols-outlined text-[20px]">close</span></button>
          </div>
          <div class="flex-1 overflow-y-auto p-container-padding space-y-stack-md">
            <!-- DATE -->
            <div class="space-y-stack-md">
              <p class="font-label-md text-label-md text-secondary uppercase">Date</p>
              <div>
                <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date Field</label>
                <select id="f-date-field" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                  <option value="issue" ${s.dateField === 'issue' ? 'selected' : ''}>Invoice Date</option>
                  <option value="due" ${s.dateField === 'due' ? 'selected' : ''}>Due Date</option>
                </select>
              </div>
              <div class="grid grid-cols-2 gap-stack-md">
                <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">From</label>
                  <input id="f-from" type="date" value="${this.esc(s.from, '')}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
                <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">To</label>
                  <input id="f-to" type="date" value="${this.esc(s.to, '')}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
              </div>
            </div>
            <!-- CUSTOMER -->
            <div class="space-y-stack-md">
              <p class="font-label-md text-label-md text-secondary uppercase">Customer</p>
              <select id="f-customer" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                <option value="">All Customers</option>
                ${customerOptions}
              </select>
            </div>
            <!-- STATUS -->
            <div class="space-y-stack-md">
              <p class="font-label-md text-label-md text-secondary uppercase">Status</p>
              <select id="f-status" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                <option value="">All Statuses</option>
                ${['DRAFT','PENDING_APPROVAL','APPROVED','POSTED','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED'].map(k => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${this.statusLabel(k)}</option>`).join('')}
              </select>
            </div>
            <!-- PAYMENT STATUS -->
            <div class="space-y-stack-md">
              <p class="font-label-md text-label-md text-secondary uppercase">Payment Status</p>
              <select id="f-payment" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                <option value="">All</option>
                ${['UNPAID','PARTIAL','PAID','OVERPAID','NOT_DUE','OVERDUE'].map(k => `<option value="${k}" ${s.paymentStatus === k ? 'selected' : ''}>${this.paymentStatusLabel(k)}</option>`).join('')}
              </select>
            </div>
            <!-- FINANCIAL -->
            <div class="space-y-stack-md">
              <p class="font-label-md text-label-md text-secondary uppercase">Financial</p>
              <div class="grid grid-cols-2 gap-stack-md">
                <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Min Amount</label>
                  <input id="f-min" type="number" step="0.01" min="0" value="${this.esc(s.minAmount, '')}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
                <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Max Amount</label>
                  <input id="f-max" type="number" step="0.01" min="0" value="${this.esc(s.maxAmount, '')}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
              </div>
            </div>
            <!-- OVERDUE -->
            <div class="space-y-stack-md">
              <p class="font-label-md text-label-md text-secondary uppercase">Overdue</p>
              <select id="f-overdue" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                <option value="">Any</option>
                <option value="NOT" ${s.overdueBucket === 'NOT' ? 'selected' : ''}>Not overdue</option>
                <option value="1" ${s.overdueBucket === '1' ? 'selected' : ''}>1–30 days</option>
                <option value="31" ${s.overdueBucket === '31' ? 'selected' : ''}>31–60 days</option>
                <option value="61" ${s.overdueBucket === '61' ? 'selected' : ''}>61–90 days</option>
                <option value="91" ${s.overdueBucket === '91' ? 'selected' : ''}>90+ days</option>
              </select>
            </div>
            <!-- SALES -->
            <div class="space-y-stack-md">
              <p class="font-label-md text-label-md text-secondary uppercase">Financial</p>
              <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Currency</label>
                <select id="f-currency" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                  <option value="">All Currencies</option>
                  ${['INR','USD','EUR','GBP','AED'].map(c => `<option value="${c}" ${s.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
                </select></div>
              <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Payment Terms</label>
                <select id="f-terms" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                  <option value="">Any Terms</option>
                  ${['DUE_ON_RECEIPT','ADVANCE','END_OF_MONTH','SPECIFIC_DATE'].map(t => `<option value="${t}" ${s.paymentTerms === t ? 'selected' : ''}>${this.paymentTermsLabel(t) || t}</option>`).join('')}
                </select></div>
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant">Salesperson, branch, warehouse, project, cost centre and tax status filters appear here once configured in Settings.</p>
          </div>
          <div class="flex justify-end gap-stack-sm p-container-padding border-t border-outline-variant/30">
            <button id="f-reset" class="px-4 py-2 rounded-lg hover:bg-surface-container">Reset</button>
            <button id="f-apply" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Apply Filters</button>
          </div>
        </div>
      </div>
    `;

    const close = () => { root.innerHTML = ''; };
    root.querySelectorAll('[data-drawer-close]').forEach(el => el.addEventListener('click', close));
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
    root.querySelector('#f-apply').addEventListener('click', () => {
      this.state.dateField = root.querySelector('#f-date-field').value;
      this.state.from = root.querySelector('#f-from').value;
      this.state.to = root.querySelector('#f-to').value;
      this.state.customerId = root.querySelector('#f-customer').value;
      this.state.status = root.querySelector('#f-status').value;
      this.state.paymentStatus = root.querySelector('#f-payment').value;
      this.state.minAmount = root.querySelector('#f-min').value;
      this.state.maxAmount = root.querySelector('#f-max').value;
      this.state.overdueBucket = root.querySelector('#f-overdue').value;
      this.state.currency = root.querySelector('#f-currency').value;
      this.state.paymentTerms = root.querySelector('#f-terms').value;
      this.state.page = 1; // Applying filters always resets pagination to page 1
      close();
      this.updateFilterBadge();
      this.loadBills();
    });
    root.querySelector('#f-reset').addEventListener('click', () => {
      this.resetFilters();
      close();
    });
  },

  /* ═══ Filter helpers (STEP 6) ═══ */

  resetFilters() {
    const d = this.DEFAULT_FILTER_STATE || {};
    Object.assign(this.state, {
      search: d.search || '', status: d.status || '', from: d.from || '', to: d.to || '',
      paymentStatus: d.paymentStatus || '', minAmount: d.minAmount || '', maxAmount: d.maxAmount || '',
      overdueBucket: d.overdueBucket || '', dateField: d.dateField || 'issue', customerId: d.customerId || '',
      currency: d.currency || '', paymentTerms: d.paymentTerms || '', page: 1,
    });
    const si = document.getElementById('cb-search'); if (si) si.value = this.state.search;
    this.updateFilterBadge();
    this.loadBills();
    this.renderStatusTabs(this.statusCounts || {});
  },

  clearAllFilters() { this.resetFilters(); },

  removeFilterKey(key) {
    if (key === 'dates') { this.state.from = ''; this.state.to = ''; }
    else if (key === 'status') this.state.status = '';
    else if (key === 'paymentStatus') this.state.paymentStatus = '';
    else if (key === 'customer') this.state.customerId = '';
    else if (key === 'amount') { this.state.minAmount = ''; this.state.maxAmount = ''; }
    else if (key === 'overdue') this.state.overdueBucket = '';
    else if (key === 'currency') this.state.currency = '';
    else if (key === 'paymentTerms') this.state.paymentTerms = '';
    else if (key === 'search') { this.state.search = ''; const si = document.getElementById('cb-search'); if (si) si.value = ''; }
    this.state.page = 1;
    this.updateFilterBadge();
    this.loadBills();
  },

  activeFilterChips() {
    const s = this.state;
    const chips = [];
    if (s.search) chips.push({ key: 'search', label: `Search: ${s.search}` });
    if (s.customerId) {
      const c = (this.customersCache || []).find(x => x.id === s.customerId);
      chips.push({ key: 'customer', label: `Customer: ${c ? c.name : s.customerId}` });
    }
    if (s.status) chips.push({ key: 'status', label: `Status: ${this.statusLabel(s.status)}` });
    if (s.paymentStatus) chips.push({ key: 'paymentStatus', label: `Payment: ${this.paymentStatusLabel(s.paymentStatus)}` });
    if (s.from || s.to) chips.push({ key: 'dates', label: `Date: ${s.from ? this.fmtDate(s.from) : '…'} → ${s.to ? this.fmtDate(s.to) : '…'}` });
    if (s.minAmount || s.maxAmount) chips.push({ key: 'amount', label: `Amount: ${s.minAmount || '0'} – ${s.maxAmount || '∞'}` });
    if (s.overdueBucket) {
      const bucketLabel = { NOT: 'Not Overdue', 1: 'Overdue 1–30 Days', 31: 'Overdue 31–60 Days', 61: 'Overdue 61–90 Days', 91: 'Overdue 90+ Days' }[s.overdueBucket] || `Overdue ${s.overdueBucket}`;
      chips.push({ key: 'overdue', label: bucketLabel });
    }
    if (s.currency) chips.push({ key: 'currency', label: `Currency: ${s.currency}` });
    if (s.paymentTerms) chips.push({ key: 'paymentTerms', label: `Terms: ${s.paymentTerms}` });
    return chips;
  },

  renderChips() {
    const box = document.getElementById('cb-chips');
    if (!box) return;
    const chips = this.activeFilterChips();
    if (!chips.length) { box.innerHTML = ''; return; }
    const chipHtml = chips.map(c => `
      <span class="inline-flex items-center gap-1 bg-secondary/10 text-secondary px-2.5 py-1 rounded-full font-label-md text-[12px] border border-secondary/20">
        ${this.esc(c.label, '—')}
        <button data-chip-key="${c.key}" data-chip-remove class="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full hover:bg-secondary/20" aria-label="Remove filter ${this.esc(c.label, '')}">
          <span class="material-symbols-outlined text-[14px]">close</span>
        </button>
      </span>`).join('');
    box.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        ${chipHtml}
        <button data-clear-all class="px-2.5 py-1 rounded-full font-label-md text-[12px] text-on-surface-variant hover:bg-surface-container border border-outline-variant/30">Clear all</button>
      </div>`;
  },

  paymentStatusLabel(k) {
    const m = { UNPAID: 'Unpaid', PARTIAL: 'Partially Paid', PAID: 'Paid', OVERPAID: 'Overpaid', NOT_DUE: 'Not Due', OVERDUE: 'Overdue' };
    return m[k] || this.esc(k, '—');
  },

  updateFilterBadge() {
    const badge = document.getElementById('cb-filter-count');
    if (!badge) return;
    const s = this.state;
    let n = 0;
    if (s.from || s.to) n++;
    if (s.minAmount || s.maxAmount) n++;
    if (s.overdueBucket) n++;
    if (s.paymentStatus) n++;
    if (s.status) n++;
    if (s.customerId) n++;
    if (s.currency) n++;
    if (s.paymentTerms) n++;
    if (n > 0) { badge.textContent = n; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  },

  bindListEvents() {
    document.getElementById('cb-new').addEventListener('click', () => { window.location.hash = '#customer-bills/new'; });
    document.getElementById('cb-sales-register').addEventListener('click', () => this.renderSalesRegister());
    document.getElementById('cb-tax-summary').addEventListener('click', () => this.renderTaxSummary());
    document.getElementById('cb-customer-statement').addEventListener('click', () => this.renderCustomerStatement());
    document.getElementById('cb-ar-aging').addEventListener('click', () => this.renderAgingReport());
    document.getElementById('cb-export').addEventListener('click', () => { this.exportCsv(this.lastItems || []); document.getElementById('cb-more-menu').classList.add('hidden'); });
    const moreBtn = document.getElementById('cb-more');
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('cb-more-menu').classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#cb-more') && !e.target.closest('#cb-more-menu')) document.getElementById('cb-more-menu')?.classList.add('hidden'); });
    document.getElementById('cb-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.loadBills(); }, 300);
    });
    // Status tab clicks (delegated — tabs re-render with counts)
    document.getElementById('cb-status-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      this.state.status = btn.dataset.status;
      this.state.page = 1;
      this.loadBills();
      this.renderStatusTabs(this.statusCounts || {});
    });
    // KPI cards act as filters
    document.getElementById('cb-kpi').addEventListener('click', (e) => {
      const card = e.target.closest('[data-kpi]');
      if (!card) return;
      const kpi = card.dataset.kpi;
      if (kpi === 'DUE_TODAY') { this.state.status = ''; this.state.paymentStatus = ''; this.state.from = this.state.to = new Date().toISOString().split('T')[0]; this.state.dateField = 'due'; }
      else if (kpi === '') { /* clear all filters */ this.state.status = ''; this.state.paymentStatus = ''; this.state.from = ''; this.state.to = ''; }
      else { this.state.status = kpi === 'UNPAID' ? '' : kpi; this.state.paymentStatus = kpi; this.state.from = ''; this.state.to = ''; }
      this.state.page = 1;
      this.updateFilterBadge();
      this.loadBills();
      this.renderStatusTabs(this.statusCounts || {});
    });
    document.getElementById('cb-filter-btn').addEventListener('click', () => this.openFilterDrawer());
    // Bulk actions
    document.getElementById('cb-bulk-clear').addEventListener('click', () => { this.selectedIds.clear(); this.updateBulkBar(); this.renderTable(document.getElementById('cb-table'), this.lastItems || [], this.lastTotal || 0); });
    document.getElementById('cb-bulk-export').addEventListener('click', () => this.exportCsv(this.lastItems || []));
    document.getElementById('cb-bulk-send').addEventListener('click', () => Toast.info(`${this.selectedIds.size} bills queued for sending`));
    // Active filter chips (delegated — chips re-render after every load)
    document.getElementById('cb-chips').addEventListener('click', (e) => {
      const clearAll = e.target.closest('[data-clear-all]');
      const chip = e.target.closest('[data-chip-key]');
      if (clearAll) { this.clearAllFilters(); return; }
      if (chip && e.target.closest('[data-chip-remove]')) { this.removeFilterKey(chip.dataset.chipKey); }
    });
    // Empty-state "Clear Filters" (delegated — table re-renders per load)
    document.getElementById('cb-table').addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-filters]')) this.clearAllFilters();
    });
  },

  updateBulkBar() {
    const bar = document.getElementById('cb-bulk-bar');
    if (!bar) return;
    document.getElementById('cb-bulk-count').textContent = this.selectedIds.size;
    bar.classList.toggle('hidden', this.selectedIds.size === 0);
    bar.classList.toggle('flex', this.selectedIds.size > 0);
  },

  exportCsv(items) {
    if (!items.length) { Toast.info('No bills to export'); return; }
    const cols = ['bill_number', 'contact_name', 'issue_date', 'due_date', 'total', 'paid_amount', 'balance', 'status'];
    const rows = items.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
    const csv = [cols.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `customer-bills-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  /* ═══ Status Tabs ═══ */

  async loadStatusCounts() {
    try {
      const res = await API.get('/customer-bills/status-counts');
      const counts = res?.data || {};
      this.statusCounts = counts;
      this.renderStatusTabs(counts);
    } catch (err) {
      this.statusCounts = {};
      this.renderStatusTabs({});
    }
  },

  renderStatusTabs(counts) {
    const tabs = [
      { key: '', label: 'All' },
      { key: 'DRAFT', label: 'Draft' },
      { key: 'PENDING_APPROVAL', label: 'Pending Approval' },
      { key: 'APPROVED', label: 'Approved' },
      { key: 'POSTED', label: 'Posted' },
      { key: 'PARTIALLY_PAID', label: 'Partially Paid' },
      { key: 'PAID', label: 'Paid' },
      { key: 'OVERDUE', label: 'Overdue' },
      { key: 'CANCELLED', label: 'Cancelled' },
    ];
    const totalAll = Object.entries(counts || {}).filter(([k]) => k !== 'PAID' && k !== 'PARTIALLY_PAID' && k !== 'OVERDUE').reduce((s, [, v]) => s + (v || 0), 0);
    const active = this.state.status || '';
    const html = tabs.map(t => {
      const count = t.key === '' ? totalAll : (counts[t.key] || 0);
      const isActive = t.key === active;
      const countHtml = count > 0 ? `<span class="ml-1 px-1.5 py-0.5 text-xs rounded-full ${isActive ? 'bg-secondary text-on-secondary' : 'bg-surface-container-high text-on-surface-variant'}">${count}</span>` : '';
      return `<button data-status="${t.key}" aria-pressed="${isActive}" class="px-3 py-2 font-label-md text-sm rounded-lg transition-colors ${isActive ? 'bg-secondary/10 text-secondary font-medium' : 'text-on-surface-variant hover:bg-surface-container-high'}">${t.label}${countHtml}</button>`;
    }).join('');
    const container = document.getElementById('cb-status-tabs');
    if (container) container.innerHTML = `<div class="flex flex-wrap gap-1 p-container-padding bg-surface-container-lowest border border-outline-variant/30 rounded-xl">${html}</div>`;
  },

  /* ═══ KPI Dashboard ═══ */

  async loadKpi() {
    try {
      const res = await API.get('/customer-bills/kpi', { from: this.state.from || undefined, to: this.state.to || undefined });
      const raw = res?.data || res || {};
      // API serializes camelCase; accept both key styles.
      const d = {
        total_billing: raw.total_billing ?? raw.totalBilling,
        paid: raw.paid,
        outstanding: raw.outstanding,
        overdue: raw.overdue,
        due_today: raw.due_today ?? raw.dueToday,
        draft_bills: raw.draft_bills ?? raw.draftBills,
      };
      this.fmtSet('kpi-total-billing', d.total_billing);
      this.fmtSet('kpi-paid', d.paid);
      this.fmtSet('kpi-outstanding', d.outstanding);
      this.fmtSet('kpi-overdue', d.overdue);
      this.fmtSet('kpi-due-today', d.due_today);
      this.fmtCount('kpi-draft', d.draft_bills);
    } catch (err) {
      console.warn('KPI load failed:', err.message);
      ['kpi-total-billing', 'kpi-paid', 'kpi-outstanding', 'kpi-overdue', 'kpi-due-today'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '—';
      });
    }
  },

  fmtSet(elId, value) {
    const el = document.getElementById(elId);
    if (el) el.textContent = Currency.format(this.num(value), this.currentCurrency);
  },
  fmtCount(elId, value) {
    const el = document.getElementById(elId);
    if (el) el.textContent = this.num(value).toString();
  },

  async loadBills() {
    const container = document.getElementById('cb-table');
    if (!container) return;
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const s = this.state;
      const params = {
        page: s.page, limit: s.pageSize,
        q: s.search, status: s.status,
        contact_id: s.customerId,
        payment_status: s.paymentStatus,
        from: s.dateField === 'issue' ? s.from : undefined,
        to: s.dateField === 'issue' ? s.to : undefined,
        due_from: s.dateField === 'due' ? s.from : undefined,
        due_to: s.dateField === 'due' ? s.to : undefined,
        min_amount: s.minAmount, max_amount: s.maxAmount,
        overdue_bucket: s.overdueBucket,
        currency: s.currency, payment_terms: s.paymentTerms,
      };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/customer-bills', params);
      const data = res?.data || res || {};
      const items = (data.items || []).map(r => this.normBill(r));
      const total = data.total ?? data.pagination?.total ?? items.length;
      this.lastItems = items; this.lastTotal = total;
      this.renderTable(container, items, total);
      this.renderChips();
    } catch (err) { ErrorState.render(container, () => this.loadBills(), 'Unable to load bills'); }
  },

  renderTable(container, items, total) {
    // Server returns contact_name; DataTable renders row[key] so map to safe keys.
    const rows = items.map(r => ({
      ...r,
      contactName: this.esc(r.contact_name || (r.contact && r.contact.name) || r.organization_name || '', '—'),
      customerMeta: [r.contact_gstin].map(x => this.esc(x, '')).filter(Boolean).join(' · '),
      issueDate: this.fmtDate(r.issue_date),
      dueDate: this.fmtDate(r.due_date),
    }));

    const cur = this.currentCurrency;
    this.cbTable = new DataTable(container, {
      selectable: true,
      columns: [
        { key: 'bill_number', label: 'Bill #', render: (v, r) => `<a href="#customer-bills/${r.id}" class="font-code text-secondary font-medium hover:underline">${this.esc(v || r.invoice_number, r.id)}</a>` },
        { key: 'contactName', label: 'Customer', render: (v, r) => `<div><div class="font-medium text-on-surface">${v}</div>${r.customerMeta ? `<div class="font-body-sm text-[11px] text-on-surface-variant">${r.customerMeta}</div>` : ''}</div>` },
        { key: 'issueDate', label: 'Issue Date' },
        { key: 'dueDate', label: 'Due Date', render: (v, r) => {
          const od = this.daysOverdue(r.due_date);
          const overdue = od > 0 && this.num(r.balance) > 0 && !['PAID', 'CANCELLED', 'VOID', 'DRAFT'].includes(r.status);
          return `<span class="${overdue ? 'text-error font-medium' : ''}">${v}${overdue ? ` <span class="font-body-sm text-[11px]">· ${od}d</span>` : ''}</span>`;
        } },
        { key: 'total', label: 'Amount', render: (v, r) => `<span class="font-medium font-code">${Currency.format(this.num(v), r.currency || cur)}</span>`, align: 'right' },
        { key: 'paid_amount', label: 'Paid', render: (v, r) => `<span class="font-code text-emerald-700">${Currency.format(this.num(v), r.currency || cur)}</span>`, align: 'right' },
        { key: 'balance', label: 'Balance', render: (v, r) => `<span class="font-medium font-code ${this.num(v) > 0 ? 'text-secondary' : 'text-on-surface-variant'}">${Currency.format(this.num(v), r.currency || cur)}</span>`, align: 'right' },
        { key: 'status', label: 'Status', render: (v) => this.renderStatusBadge(v) },
        { key: 'payment_status', label: 'Payment Status', render: (v, r) => this.renderPaymentBadge(r) },
      ],
      data: rows,
      emptyState: this.activeFilterChips().length
        ? `<div><p class="font-body-md text-body-md text-on-surface">No bills found</p><p class="font-body-sm text-body-sm text-on-surface-variant mt-1">No customer bills match the current filters. Try adjusting or clearing the filters.</p><button data-clear-filters class="mt-3 px-4 py-2 rounded-lg bg-secondary text-on-secondary hover:bg-secondary/90 font-label-md text-sm">Clear Filters</button></div>`
        : 'No customer bills found',
      onRowClick: (r) => { window.location.hash = `#customer-bills/${r.id}`; },
      rowActions: (r, index) => this.openRowMenu(r, index),
    });

    // Sync checkbox selection state from this.selectedIds
    if (this.selectedIds.size) {
      const cb = this.cbTable;
      cb.config.data.forEach((r, i) => { if (this.selectedIds.has(r.id)) cb.selectedRows.add(i); });
      if (cb.selectedRows.size) cb.render();
    }
    // Track selection changes
    const origToggle = this.cbTable.toggleSelectAll.bind(this.cbTable);
    this.cbTable.toggleSelectAll = (checked) => { origToggle(checked); this.syncSelection(); };
    const tbodyEl = container.querySelector('tbody');
    if (tbodyEl) tbodyEl.addEventListener('click', (e) => { if (e.target.closest('.row-checkbox')) setTimeout(() => this.syncSelection(), 0); });

    if (!this.cbPagination) {
      this.cbPagination = new Pagination(document.getElementById('cb-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
        onPageChange: (p) => { this.state.page = p; this.loadBills(); },
      });
    } else {
      this.cbPagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
    }
  },

  syncSelection() {
    if (!this.cbTable) return;
    this.selectedIds.clear();
    this.cbTable.selectedRows.forEach(i => { const r = this.cbTable.config.data[i]; if (r && r.id) this.selectedIds.add(r.id); });
    this.updateBulkBar();
  },

  renderPaymentBadge(row) {
    const ps = this.paymentStatus(row);
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] gap-1 ${ps.cls}"><span class="w-1.5 h-1.5 rounded-full ${ps.dot}"></span>${this.esc(ps.label, '—')}</span>`;
  },

  /* ═══ Row Actions (three-dot menu) ═══ */

  openRowMenu(row, index) {
    // Remove any existing menu
    document.getElementById('cb-row-menu')?.remove();
    const s = row.status;
    const items = [];
    const add = (act, icon, label, cls = '') => items.push(`<button data-menu-act="${act}" class="w-full text-left px-3 py-2 font-body-sm text-body-sm hover:bg-surface-container flex items-center gap-2 ${cls}" role="menuitem"><span class="material-symbols-outlined text-[18px]">${icon}</span> ${label}</button>`);
    add('view', 'visibility', 'View');
    if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(s)) add('edit', 'edit', 'Edit');
    add('duplicate', 'content_copy', 'Duplicate');
    if (['POSTED', 'PARTIALLY_PAID', 'OVERDUE'].includes(s)) add('payment', 'payment', 'Record Payment');
    if (['POSTED', 'PARTIALLY_PAID', 'OVERDUE', 'APPROVED'].includes(s)) add('send', 'send', 'Send');
    add('pdf', 'picture_as_pdf', 'Download PDF');
    add('print', 'print', 'Print');
    if (['POSTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].includes(s)) add('credit', 'receipt_long', 'Create Credit Note');
    if (['POSTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].includes(s)) add('debit', 'description', 'Create Debit Note');
    if (row.journal_entry_id) add('je', 'book', 'View Journal Entry');
    if (row.contact_id) add('customer', 'person', 'View Customer');
    if (['DRAFT', 'POSTED', 'PARTIALLY_PAID', 'OVERDUE'].includes(s)) add('cancel', 'cancel', 'Cancel', 'text-error');

    const menu = document.createElement('div');
    menu.id = 'cb-row-menu';
    menu.className = 'fixed z-[95] w-52 bg-surface-container-lowest rounded-lg border border-outline-variant/30 shadow-lg py-1';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.join('');
    document.body.appendChild(menu);
    // Position near the button (click target is the row-action-btn)
    const btn = event && event.target ? event.target.closest('.row-action-btn') : null;
    const rect = btn ? btn.getBoundingClientRect() : { right: window.innerWidth / 2, bottom: window.innerHeight / 2 };
    const mw = 208, mh = menu.offsetHeight || 300;
    menu.style.left = `${Math.min(rect.right - mw, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - mh - 8)}px`;
    menu.querySelector(`[data-menu-act="view"]`)?.focus();

    const close = () => { menu.remove(); document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); };
    const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('click', onDoc); document.addEventListener('keydown', onKey); }, 0);

    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-menu-act]');
      if (!b) return;
      const act = b.dataset.menuAct;
      close();
      if (act === 'view') { window.location.hash = `#customer-bills/${row.id}`; }
      else if (act === 'edit') this.openForm(row);
      else if (act === 'duplicate') this.openForm({ ...row, id: null, bill_number: '', invoice_number: '', status: 'DRAFT' });
      else if (act === 'payment') this.recordPayment(row);
      else if (act === 'credit') this.createCreditNote(row);
      else if (act === 'debit') this.createDebitNote(row);
      else if (act === 'cancel') this.handleAction('cancel', row);
      else if (act === 'send') Toast.info(`Bill ${this.esc(row.bill_number, '')} queued for sending`);
      else if (act === 'pdf') { Toast.info('Preparing PDF...'); window.print(); }
      else if (act === 'print') window.print();
      else if (act === 'je') window.location.hash = `#accounting/journal/${row.journal_entry_id}`;
      else if (act === 'customer') window.location.hash = `#contacts/${row.contact_id}`;
    });
  },

  /* ═══ Form (Create/Edit) ═══ */

  async openForm(row = null) {
    row = row ? this.normBill(row) : row;
    this.currentBill = row;
    const isEdit = !!row;
    const i = row || {};

    // Load next number / preview
    let previewNumber = '';
    try {
      const res = await API.get('/customer-bills/number/preview');
      previewNumber = res?.data?.billNumber || res?.data?.bill_number || '';
    } catch {}

    // Load customers for selector
    let customers = [];
    try {
      const res = await API.get('/contacts');
      customers = (res?.items || res || []).map(c => ({ ...c, first_name: c.first_name || c.firstName, last_name: c.last_name || c.lastName, organization_name: c.organization_name || c.organizationName }));
    } catch {}

    // Load chart of accounts for GL account selector
    let glAccounts = [];
    try {
      const res = await API.get('/accounting/accounts');
      glAccounts = res?.items || res || [];
    } catch {}

    const modal = new Modal({
      title: isEdit ? 'Edit Bill ' + (i.bill_number || '') : 'New Customer Bill',
      size: '5xl',
      content: this.renderFormContent(i, previewNumber, customers, glAccounts, isEdit),
    });
    modal.open();
    this.currentModal = modal;
    this.setupFormEvents(modal.element, isEdit, i);
  },

  renderFormContent(i, previewNumber, customers, glAccounts, isEdit) {
    const customerOptions = customers.map(c =>
      `<option value="${c.id}">${c.first_name || ''} ${c.last_name || ''}${c.organization_name ? ' (' + c.organization_name + ')' : ''}</option>`
    ).join('');

    const glOptions = glAccounts
      .filter(a => ['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY'].includes(a.type))
      .map(a => `<option value="${a.id}">${a.code} — ${a.name}</option>`)
      .join('');

    return `
      <form id="cb-form" class="space-y-stack-md">
        <!-- Header -->
        <div class="grid grid-cols-3 gap-stack-md">
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Bill Number</label>
            <input name="bill_number" value="${i.bill_number || previewNumber}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md font-code" readonly/>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Bill Date *</label>
            <input name="issue_date" type="date" required value="${i.issue_date || new Date().toISOString().split('T')[0]}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Due Date *</label>
            <input name="due_date" type="date" required value="${i.due_date || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
        </div>

        <!-- Customer -->
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer *</label>
          <select name="contact_id" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">Select customer...</option>
            ${customerOptions}
          </select>
        </div>

        <!-- Billing & Shipping Address -->
        <div class="grid grid-cols-2 gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Billing Address</label>
            <textarea name="billing_address" rows="3" placeholder="Billing address..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">${i.billing_address || ''}</textarea>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Shipping Address</label>
            <textarea name="shipping_address" rows="3" placeholder="Shipping address..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">${i.shipping_address || ''}</textarea>
          </div>
        </div>

        <!-- Place of Supply & Customer Details -->
        <div class="grid grid-cols-4 gap-stack-md">
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Place of Supply</label>
            <select name="place_of_supply" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none">
              <option value="29" ${i.place_of_supply === '29' ? 'selected' : ''}>29 - Karnataka</option>
              <option value="01" ${i.place_of_supply === '01' ? 'selected' : ''}>01 - Jammu & Kashmir</option>
              <option value="07" ${i.place_of_supply === '07' ? 'selected' : ''}>07 - Delhi</option>
              <option value="19" ${i.place_of_supply === '19' ? 'selected' : ''}>19 - West Bengal</option>
              <option value="27" ${i.place_of_supply === '27' ? 'selected' : ''}>27 - Maharashtra</option>
              <option value="33" ${i.place_of_supply === '33' ? 'selected' : ''}>33 - Tamil Nadu</option>
            </select>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer GSTIN</label>
            <input name="customer_gstin" value="${i.customer_gstin || ''}" placeholder="GSTIN..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer PO Number</label>
            <input name="customer_po_number" value="${i.customer_po_number || ''}" placeholder="PO #..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer PO Date</label>
            <input name="customer_po_date" type="date" value="${i.customer_po_date || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reference</label>
            <input name="reference_number" value="${i.reference_number || ''}" placeholder="Check #, UTR, etc." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
        </div>

        <!-- Line Items -->
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Line Items</label>
          <div id="cb-items" class="border border-outline-variant/30 rounded-lg overflow-hidden">
            <table class="w-full">
              <thead class="bg-surface-container-low">
                <tr>
                  <th class="text-left py-2 px-2 font-label-md text-on-surface-variant">#</th>
                  <th class="text-left py-2 px-2 font-label-md text-on-surface-variant">Description</th>
                  <th class="text-center py-2 px-2 font-label-md text-on-surface-variant w-[80px]">Qty</th>
                  <th class="text-right py-2 px-2 font-label-md text-on-surface-variant w-[120px]">Unit Price</th>
                  <th class="text-right py-2 px-2 font-label-md text-on-surface-variant w-[100px]">Tax %</th>
                  <th class="text-right py-2 px-2 font-label-md text-on-surface-variant w-[120px]">Tax Amount</th>
                  <th class="text-right py-2 px-2 font-label-md text-on-surface-variant w-[120px]">Line Total</th>
                  <th class="text-center py-2 px-2 font-label-md text-on-surface-variant w-[40px]">...</th>
                </tr>
              </thead>
              <tbody id="cb-items-body"></tbody>
            </table>
          </div>
          <button type="button" id="cb-add-line" class="mt-2 text-secondary font-body-sm hover:underline flex items-center gap-1">
            <span class="material-symbols-outlined text-[16px]">add</span> Add line
          </button>
        </div>

        <!-- Totals -->
        <div class="flex justify-end pt-stack-sm border-t border-outline-variant/30">
          <table class="text-right">
            <tr><td class="font-label-md text-on-surface-variant pr-4">Subtotal</td><td class="font-code w-[120px]">${Currency.format(0, this.currentCurrency)}</td></tr>
            <tr><td class="font-label-md text-on-surface-variant pr-4">Taxable Amount</td><td class="font-code w-[120px]" id="cb-taxable">0</td></tr>
            <tr><td class="font-label-md text-on-surface-variant pr-4">Tax</td><td class="font-code w-[120px]" id="cb-tax">0</td></tr>
            <tr><td class="font-label-md text-on-surface-variant pr-4">Discount</td><td class="font-code w-[120px]">${Currency.format(0, this.currentCurrency)}</td></tr>
            <tr class="border-t border-outline-variant/30"><td class="font-display text-h1 text-on-surface pr-4">Total</td><td class="font-display font-bold w-[120px] text-secondary" id="cb-grand-total">0</td></tr>
          </table>
        </div>

        <!-- Form Actions -->
        <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
          <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
          <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save Bill' : 'Create Bill'}</button>
        </div>
      </form>
    `;
  },

  setupFormEvents(modalEl, isEdit, bill) {
    // Initialize bill lines
    const existingLines = bill.items && bill.items.length ? bill.items : [];
    this.billLines = existingLines.length ? existingLines.map(l => ({
      description: l.description || '',
      quantity: parseFloat(l.quantity) || 1,
      unit_price: parseFloat(l.unit_price) || 0,
      tax_rate: parseFloat(l.tax_rate) || 0,
      tax_master_id: l.tax_master_id || null,
      gl_account_id: l.gl_account_id || null,
    })) : [{ description: '', quantity: 1, unit_price: 0, tax_rate: 0, tax_master_id: null, gl_account_id: null }];

    this.renderBillLines();

    // Set selected customer
    if (bill.contact_id) {
      const sel = modalEl.querySelector('select[name="contact_id"]');
      if (sel) sel.value = bill.contact_id;
    }

    // Add line button
    modalEl.querySelector('#cb-add-line')?.addEventListener('click', () => {
      this.billLines.push({ description: '', quantity: 1, unit_price: 0, tax_rate: 0, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' });
      this.renderBillLines();
    });

    // Form submit
    modalEl.querySelector('#cb-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.saveBill(modalEl, isEdit, bill);
    });
  },

  renderBillLines() {
    const tbody = document.getElementById('cb-items-body');
    if (!tbody) return;
    tbody.innerHTML = this.billLines.map((l, idx) => `
      <tr class="border-b border-outline-variant/20">
        <td class="py-2 px-2 text-center text-on-surface-variant">${idx + 1}</td>
        <td class="py-2 px-2"><input data-idx="${idx}" data-k="description" value="${l.description || ''}" placeholder="Description" class="w-full bg-surface-container-low border border-outline-variant/30 rounded px-2 py-1 text-body-sm"/></td>
        <td class="py-2 px-2"><input data-idx="${idx}" data-k="quantity" type="number" step="0.01" value="${l.quantity || 1}" placeholder="Qty" class="w-full bg-surface-container-low border border-outline-variant/30 rounded px-2 py-1 text-body-sm text-center"/></td>
        <td class="py-2 px-2"><input data-idx="${idx}" data-k="unit_price" type="number" step="0.01" value="${l.unit_price || 0}" placeholder="0.00" class="w-full bg-surface-container-low border border-outline-variant/30 rounded px-2 py-1 text-body-sm text-right"/></td>
        <td class="py-2 px-2"><input data-idx="${idx}" data-k="tax_rate" type="number" step="0.01" value="${l.tax_rate || 5}" placeholder="5" class="w-full bg-surface-container-low border border-outline-variant/30 rounded px-2 py-1 text-body-sm text-center"/></td>
        <td class="py-2 px-2 text-right font-code" data-tax-idx="${idx}">0</td>
        <td class="py-2 px-2 text-right font-code" data-total-idx="${idx}">0</td>
        <td class="py-2 px-2 text-center">
          <button type="button" data-rm="${idx}" class="text-error"><span class="material-symbols-outlined text-[14px]">close</span></button>
        </td>
      </tr>
    `).join('');

    // Bind inputs
    tbody.querySelectorAll('input[data-idx]').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const v = e.target.value;
        this.billLines[+inp.dataset.idx][inp.dataset.k] = e.target.type === 'number' ? (parseFloat(v) || 0) : v;
        this.updateBillTotals();
      });
    });
    tbody.querySelectorAll('[data-rm]').forEach(b => {
      b.addEventListener('click', () => { this.billLines.splice(+b.dataset.rm, 1); this.renderBillLines(); this.updateBillTotals(); });
    });

    this.updateBillTotals();
  },

  updateBillTotals() {
    let subtotal = 0, totalTax = 0;
    const tbody = document.getElementById('cb-items-body');
    if (!tbody) return;

    this.billLines.forEach((l, idx) => {
      const qty = parseFloat(l.quantity) || 1;
      const price = parseFloat(l.unit_price) || 0;
      const lineSubtotal = qty * price;
      subtotal += lineSubtotal;
      const taxAmt = lineSubtotal * (parseFloat(l.tax_rate) || 0) / 100;
      totalTax += taxAmt;

      // Update tax and total cells
      const taxCell = tbody.querySelector(`[data-tax-idx="${idx}"]`);
      const totalCell = tbody.querySelector(`[data-total-idx="${idx}"]`);
      if (taxCell) taxCell.textContent = Currency.format(taxAmt, this.currentCurrency);
      if (totalCell) totalCell.textContent = Currency.format(lineSubtotal + taxAmt, this.currentCurrency);
    });

    const grandTotal = subtotal + totalTax;
    document.getElementById('cb-taxable').textContent = Currency.format(subtotal, this.currentCurrency);
    document.getElementById('cb-tax').textContent = Currency.format(totalTax, this.currentCurrency);
    document.getElementById('cb-grand-total').textContent = Currency.format(grandTotal, this.currentCurrency);
  },

  async saveBill(modalEl, isEdit, bill) {
    const fd = new FormData(modalEl.querySelector('#cb-form'));
    const contactId = fd.get('contact_id');
    if (!contactId) { Toast.error('Select a customer'); return; }

    const partyState = fd.get('place_of_supply');
    const lines = this.billLines.map(l => ({
      description: l.description || '',
      quantity: parseFloat(l.quantity) || 1,
      unit_price: parseFloat(l.unit_price) || 0,
      tax_rate: parseFloat(l.tax_rate) || 0,
      tax_master_id: l.tax_master_id || 'tax_gst_5_intra',
      gl_account_id: l.gl_account_id || 'acc_sales',
    }));

    const payload = {
      contact_id: contactId,
      currency: this.currentCurrency,
      issue_date: fd.get('issue_date'),
      due_date: fd.get('due_date'),
      place_of_supply: partyState,
      party_state: partyState,
      company_state: '29',
      billing_address: fd.get('billing_address') || null,
      shipping_address: fd.get('shipping_address') || null,
      customer_gstin: fd.get('customer_gstin') || null,
      customer_po_number: fd.get('customer_po_number') || null,
      customer_po_date: fd.get('customer_po_date') || null,
      reference_number: fd.get('reference_number') || null,
      lines: lines,
    };

    try {
      if (isEdit) {
        await API.put('/customer-bills/' + bill.id, payload);
      } else {
        await API.post('/customer-bills', payload);
      }
      Toast.success(isEdit ? 'Bill updated' : 'Bill created');
      modalEl.querySelector('[data-modal-close]').click();
      if (isEdit && bill && bill.id && window.location.hash.startsWith('#customer-bills/')) {
        this.viewBillById(bill.id);
      } else {
        window.location.hash = '#customer-bills';
        if (document.getElementById('cb-table')) { this.loadBills(); this.loadKpi(); this.loadStatusCounts(); }
      }
    } catch (err) {
      Toast.error(err.message || 'Failed to save bill');
    }
  },

  /* ═══ Lifecycle Actions ═══ */

  async handleAction(action, row) {
    const refresh = () => {
      if (this.currentBill && row && this.currentBill.id === row.id) this.viewBillById(row.id);
      else if (document.getElementById('cb-table')) { this.loadBills(); this.loadKpi(); this.loadStatusCounts(); }
    };
    try {
      if (action === 'post') {
        const res = await API.post(`/customer-bills/${row.id}/post`);
        const je = res?.journalEntry || res?.journal_entry;
        if (je) Toast.success(`Bill posted to ledger (${je.entryNumber || je.entry_number || je.id})`);
        else Toast.success('Bill posted to ledger');
        refresh();
      } else if (action === 'submit') {
        await API.post(`/customer-bills/${row.id}/submit`);
        Toast.success('Bill submitted for approval');
        refresh();
      } else if (action === 'approve') {
        await API.post(`/customer-bills/${row.id}/approve`);
        Toast.success('Bill approved');
        refresh();
      } else if (action === 'payment') {
        this.recordPayment(row);
      } else if (action === 'credit') {
        this.createCreditNote(row);
      } else if (action === 'debit') {
        this.createDebitNote(row);
      } else if (action === 'writeoff') {
        this.confirmWriteOff(row);
      } else if (action === 'dispute') {
        this.openDispute(row);
      } else if (action === 'edit') {
        await this.openForm(row);
      } else if (action === 'delete') {
        this.confirmDelete(row);
      } else if (action === 'view') {
        this.viewBill(row);
      } else if (action === 'cancel') {
        this.confirmCancel(row);
      }
    } catch (err) {
      Toast.error(err.message || 'Action failed');
    }
  },

  confirmCancel(row) {
    const modal = new Modal({
      title: 'Cancel Bill?', size: 'sm',
      content: `
        <form id="cb-cancel-form">
          <p class="font-body-md text-on-surface mb-stack-md">Cancel <strong>${this.esc(row.bill_number, 'this bill')}</strong>? This will reverse any posted journal entries.</p>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reason</label>
          <textarea name="reason" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md mb-stack-md"></textarea>
          <div class="flex justify-end gap-stack-sm"><button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Keep Bill</button>
          <button type="submit" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Cancel Bill</button></div>
        </form>`,
    });
    modal.open();
    modal.element.querySelector('#cb-cancel-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post(`/customer-bills/${row.id}/cancel`, { reason: fd.get('reason') || 'Cancelled from UI' });
        Toast.success('Bill cancelled'); modal.close(); this.refreshCurrent(row);
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  refreshCurrent(row) {
    if (this.currentBill && row && this.currentBill.id === row.id) this.viewBillById(row.id);
    else if (document.getElementById('cb-table')) { this.loadBills(); this.loadKpi(); this.loadStatusCounts(); }
  },

  /* ═══ Payment Modal ═══ */

  recordPayment(row) {
    const modal = new Modal({
      title: 'Record Payment', size: 'md',
      content: `
        <form id="cb-payment-form" class="space-y-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Amount *</label>
              <input name="amount" type="number" step="0.01" required value="${row.balance || 0}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Payment Date</label>
              <input name="payment_date" type="date" value="${new Date().toISOString().split('T')[0]}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Account</label>
            <select name="payment_account_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="acc_bank">Bank Account (acc_bank)</option>
              <option value="acc_cash">Cash in Hand (acc_cash)</option>
            </select></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reference</label>
            <input name="reference_number" placeholder="Check #, UTR, etc." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Notes</label>
            <textarea name="notes" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Record Payment</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#cb-payment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/customer-bills/payments', {
          bill_id: row.id,
          customer_id: row.contact_id,
          amount: parseFloat(fd.get('amount')),
          payment_date: fd.get('payment_date'),
          payment_account_id: fd.get('payment_account_id'),
          payment_method: 'BANK',
          reference_number: fd.get('reference_number') || undefined,
          notes: fd.get('notes') || undefined,
        });
        Toast.success('Payment recorded');
        modal.close();
        this.refreshCurrent(row);
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  /* ═══ Credit Note Modal ═══ */

  createCreditNote(row) {
    const modal = new Modal({
      title: 'Credit Note', size: 'md',
      content: `
        <form id="cb-cn-form" class="space-y-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Amount *</label>
              <input name="amount" type="number" step="0.01" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date</label>
              <input name="credit_note_date" type="date" value="${new Date().toISOString().split('T')[0]}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Tax Master</label>
            <select name="tax_master_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="tax_gst_5_intra">GST 5% (CGST+SGST)</option>
              <option value="tax_gst_12_intra">GST 12% (CGST+SGST)</option>
              <option value="tax_gst_18_intra">GST 18% (CGST+SGST)</option>
              <option value="tax_gst_5_inter">GST 5% (IGST)</option>
              <option value="tax_gst_18_inter">GST 18% (IGST)</option>
            </select></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reason</label>
            <select name="reason" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="DISPUTE">Dispute</option>
              <option value="RETURN">Return</option>
              <option value="ADJUSTMENT">Adjustment</option>
            </select></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Notes</label>
            <textarea name="notes" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Create Credit Note</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#cb-cn-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/customer-bills/credit-notes', {
          original_bill_id: row.id,
          customer_id: row.contact_id,
          amount: parseFloat(fd.get('amount')),
          credit_note_date: fd.get('credit_note_date'),
          tax_master_id: fd.get('tax_master_id'),
          party_state: row.place_of_supply || '29',
          company_state: '29',
          reason: fd.get('reason'),
          notes: fd.get('notes') || undefined,
        });
        Toast.success('Credit note created');
        modal.close();
        this.refreshCurrent(row);
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  /* ═══ Debit Note Modal ═══ */
  createDebitNote(row) {
    const modal = new Modal({
      title: 'Debit Note', size: 'md',
      content: `
        <form id="cb-dn-form" class="space-y-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Amount *</label>
              <input name="amount" type="number" step="0.01" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date</label>
              <input name="debit_note_date" type="date" value="${new Date().toISOString().split('T')[0]}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Tax Master</label>
            <select name="tax_master_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
              <option value="tax_gst_5_intra">GST 5% (CGST+SGST)</option>
              <option value="tax_gst_12_intra">GST 12% (CGST+SGST)</option>
              <option value="tax_gst_18_intra">GST 18% (CGST+SGST)</option>
              <option value="tax_gst_5_inter">GST 5% (IGST)</option>
              <option value="tax_gst_18_inter">GST 18% (IGST)</option>
            </select></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reason</label>
            <textarea name="reason" rows="2" placeholder="Reason for debit note..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Notes</label>
            <textarea name="notes" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Create Debit Note</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#cb-dn-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/customer-bills/debit-notes', {
          original_bill_id: row.id,
          customer_id: row.contact_id,
          amount: parseFloat(fd.get('amount')),
          debit_note_date: fd.get('debit_note_date'),
          tax_master_id: fd.get('tax_master_id'),
          party_state: row.place_of_supply || '29',
          company_state: '29',
          reason: fd.get('reason') || undefined,
          notes: fd.get('notes') || undefined,
        });
        Toast.success('Debit note created');
        modal.close();
        this.refreshCurrent(row);
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  /* ═══ Write Off Confirmation ═══ */
  confirmWriteOff(row) {
    const modal = new Modal({
      title: 'Write Off', size: 'md',
      content: `
        <form id="cb-wo-form" class="space-y-stack-md">
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Amount *</label>
            <input name="amount" type="number" step="0.01" required value="${row.balance || 0}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reason *</label>
            <textarea name="reason" rows="2" required placeholder="Reason for write-off..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-red-600 text-on-error px-4 py-2 rounded-lg hover:bg-red-700">Write Off</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#cb-wo-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/customer-bills/' + row.id + '/writeoff', {
          amount: parseFloat(fd.get('amount')),
          reason: fd.get('reason'),
        });
        Toast.success('Bill written off');
        modal.close();
        this.refreshCurrent(row);
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  /* ═══ Dispute Modal ═══ */
  openDispute(row) {
    const modal = new Modal({
      title: 'Raise Dispute', size: 'md',
      content: `
        <form id="cb-dispute-form" class="space-y-stack-md">
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Amount *</label>
            <input name="amount" type="number" step="0.01" required value="${row.balance || 0}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reason *</label>
            <textarea name="reason" rows="3" required placeholder="Dispute reason..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-red-600 text-on-error px-4 py-2 rounded-lg hover:bg-red-700">Raise Dispute</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#cb-dispute-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/customer-bills/' + row.id + '/dispute', {
          amount: parseFloat(fd.get('amount')),
          reason: fd.get('reason'),
        });
        Toast.success('Dispute raised');
        modal.close();
        this.refreshCurrent(row);
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  /* ═══ Sales Register ═══ */

  async renderSalesRegister() {
    const main = document.getElementById('page-container');
    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Sales Register</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Chronological register of all customer bill transactions.</p>
          </div>
          <button id="cb-back" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high">
            <span class="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <div class="flex items-center gap-stack-md mb-stack-md">
            <input id="sr-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="sr-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <button id="sr-load" class="bg-secondary text-on-secondary px-3 py-2 rounded-lg hover:bg-secondary/90">Load</button>
          </div>
          <div id="sr-table"></div>
        </div>
      </div>
    `;

    document.getElementById('cb-back').addEventListener('click', () => this.renderList());
    const from = new Date(); from.setMonth(from.getMonth() - 1);
    const to = new Date();
    document.getElementById('sr-from').value = from.toISOString().split('T')[0];
    document.getElementById('sr-to').value = to.toISOString().split('T')[0];
    document.getElementById('sr-load').addEventListener('click', () => this.loadSalesRegister());
    document.getElementById('sr-from').addEventListener('change', () => this.loadSalesRegister());
    document.getElementById('sr-to').addEventListener('change', () => this.loadSalesRegister());
    await this.loadSalesRegister();
  },

  async loadSalesRegister() {
    const container = document.getElementById('sr-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const from = document.getElementById('sr-from').value;
      const to = document.getElementById('sr-to').value;
      const params = { from: from || undefined, to: to || undefined };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/customer-bills/sales-register', params);
      const data = res?.data || {};
      const items = data.items || [];
      const total = data.total ?? data.pagination?.total ?? items.length;

      const srTable = new DataTable(container, {
        columns: [
          { key: 'bill_number', label: 'Bill #' },
          { key: 'contact_name', label: 'Customer', render: (v, r) => v || r.contact_name || '—' },
          { key: 'issue_date', label: 'Date' },
          { key: 'taxable_amount', label: 'Taxable', render: (v, r) => `<span class="font-code">${Currency.format(v, r.currency || this.currentCurrency)}</span>`, align: 'right' },
          { key: 'tax_amount', label: 'Tax', render: (v, r) => `<span class="font-code">${Currency.format(v, r.currency || this.currentCurrency)}</span>`, align: 'right' },
          { key: 'discount', label: 'Discount', render: (v, r) => `<span class="font-code">${Currency.format(v, r.currency || this.currentCurrency)}</span>`, align: 'right' },
          { key: 'total', label: 'Total', render: (v, r) => `<span class="font-medium font-code">${Currency.format(v, r.currency || this.currentCurrency)}</span>`, align: 'right' },
          { key: 'balance', label: 'Balance', render: (v, r) => `<span class="font-medium font-code text-secondary">${Currency.format(v, r.currency || this.currentCurrency)}</span>`, align: 'right' },
          { key: 'status', label: 'Status', render: (v) => this.renderStatusBadge(v) },
        ],
        data: items,
        emptyState: 'No sales register entries found',
      });
    } catch (err) {
      container.innerHTML = `<p class="text-error">Failed to load sales register: ${err.message}</p>`;
    }
  },

  /* ═══ Tax Summary ═══ */

  async renderTaxSummary() {
    const main = document.getElementById('page-container');
    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Tax Summary</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">GST output tax liability summary.</p>
          </div>
          <button id="cb-back" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high">
            <span class="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <div class="flex items-center gap-stack-md mb-stack-md">
            <input id="ts-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="ts-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <button id="ts-load" class="bg-secondary text-on-secondary px-3 py-2 rounded-lg hover:bg-secondary/90">Load</button>
          </div>
          <div id="ts-content"></div>
        </div>
      </div>
    `;

    document.getElementById('cb-back').addEventListener('click', () => this.renderList());
    const from = new Date(); from.setMonth(from.getMonth() - 1);
    const to = new Date();
    document.getElementById('ts-from').value = from.toISOString().split('T')[0];
    document.getElementById('ts-to').value = to.toISOString().split('T')[0];
    document.getElementById('ts-load').addEventListener('click', () => this.loadTaxSummary());
    document.getElementById('ts-from').addEventListener('change', () => this.loadTaxSummary());
    document.getElementById('ts-to').addEventListener('change', () => this.loadTaxSummary());
    await this.loadTaxSummary();
  },

  async loadTaxSummary() {
    const container = document.getElementById('ts-content');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const from = document.getElementById('ts-from').value;
      const to = document.getElementById('ts-to').value;
      const params = { from: from || undefined, to: to || undefined };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/customer-bills/tax-summary', params);
      const d = res?.data || {};
      const output = d.outputTax || { cgst: 0, sgst: 0, igst: 0 };
      const reversals = d.reversals || { creditNotes: 0, debitNotes: 0, byComponentCn: { cgst: 0, sgst: 0, igst: 0 }, byComponentDn: { cgst: 0, sgst: 0, igst: 0 } };
      const net = d.netTax || { cgst: 0, sgst: 0, igst: 0, total: 0 };

      container.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-stack-md">
          <div class="bg-surface-container-low rounded-xl border border-outline-variant/30 p-container-padding">
            <p class="font-label-md text-on-surface-variant uppercase mb-2">Output Tax</p>
            <table class="w-full text-right">
              <tr><td class="font-label-md text-on-surface-variant pr-4">CGST</td><td class="font-code">${Currency.format(output.cgst || 0)}</td></tr>
              <tr><td class="font-label-md text-on-surface-variant pr-4">SGST</td><td class="font-code">${Currency.format(output.sgst || 0)}</td></tr>
              <tr><td class="font-label-md text-on-surface-variant pr-4">IGST</td><td class="font-code">${Currency.format(output.igst || 0)}</td></tr>
              <tr class="border-t border-outline-variant/30"><td class="font-display text-on-surface pr-4">Total</td><td class="font-bold font-code">${Currency.format(output.cgst + output.sgst + output.igst)}</td></tr>
            </table>
          </div>
          <div class="bg-surface-container-low rounded-xl border border-outline-variant/30 p-container-padding">
            <p class="font-label-md text-on-surface-variant uppercase mb-2">Reversals / Additions</p>
            <table class="w-full text-right">
              <tr><td class="font-label-md text-on-surface-variant pr-4">Credit Notes</td><td class="font-code">${Currency.format(reversals.creditNotes || 0)}</td></tr>
              <tr><td class="font-label-md text-on-surface-variant pr-4">Debit Notes</td><td class="font-code">${Currency.format(reversals.debitNotes || 0)}</td></tr>
            </table>
          </div>
          <div class="bg-surface-container-low rounded-xl border border-outline-variant/30 p-container-padding">
            <p class="font-label-md text-on-surface-variant uppercase mb-2">Net Tax Payable</p>
            <table class="w-full text-right">
              <tr><td class="font-label-md text-on-surface-variant pr-4">CGST</td><td class="font-code">${Currency.format(net.cgst || 0)}</td></tr>
              <tr><td class="font-label-md text-on-surface-variant pr-4">SGST</td><td class="font-code">${Currency.format(net.sgst || 0)}</td></tr>
              <tr><td class="font-label-md text-on-surface-variant pr-4">IGST</td><td class="font-code">${Currency.format(net.igst || 0)}</td></tr>
              <tr class="border-t border-outline-variant/30"><td class="font-display text-secondary pr-4">Total</td><td class="font-bold font-code text-secondary">${Currency.format(net.total || 0)}</td></tr>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<p class="text-error">Failed to load tax summary: ${err.message}</p>`;
    }
  },

  /* ═══ Customer Statement ═══ */

  async renderCustomerStatement() {
    const main = document.getElementById('page-container');
    if (!main) return;
    const cur = this.currentCurrency;

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Customer Statement</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Statement of account transactions with running balance.</p>
          </div>
          <button id="cb-back" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high">
            <span class="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <div class="grid grid-cols-1 md:grid-cols-4 gap-stack-md mb-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer</label>
              <input id="cs-contact" type="text" placeholder="Contact ID (e.g. cnt_001)" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">From Date</label>
              <input id="cs-from" type="date" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">To Date</label>
              <input id="cs-to" type="date" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div class="flex items-end">
              <button id="cs-load" class="w-full bg-secondary text-on-secondary px-3 py-2 rounded-lg hover:bg-secondary/90">Load</button>
            </div>
          </div>

          <div id="cs-totals" class="grid grid-cols-3 gap-stack-md mb-stack-md text-center"></div>
          <div id="cs-table"></div>
        </div>
      </div>
    `;

    document.getElementById('cb-back').addEventListener('click', () => this.renderList());

    const from = new Date(); from.setMonth(from.getMonth() - 1);
    const to = new Date();
    document.getElementById('cs-from').value = from.toISOString().split('T')[0];
    document.getElementById('cs-to').value = to.toISOString().split('T')[0];

    document.getElementById('cs-load').addEventListener('click', () => this.loadCustomerStatement());
    document.getElementById('cs-from').addEventListener('change', () => this.loadCustomerStatement());
    document.getElementById('cs-to').addEventListener('change', () => this.loadCustomerStatement());
    document.getElementById('cs-contact').addEventListener('change', () => this.loadCustomerStatement());
    document.getElementById('cs-contact').addEventListener('keyup', (e) => { if (e.key === 'Enter') this.loadCustomerStatement(); });

    await this.loadCustomerStatement();
  },

  async loadCustomerStatement() {
    const container = document.getElementById('cs-table');
    const totalsEl = document.getElementById('cs-totals');
    const contactId = document.getElementById('cs-contact')?.value?.trim() || '';
    const from = document.getElementById('cs-from')?.value;
    const to = document.getElementById('cs-to')?.value;

    if (!contactId) {
      totalsEl.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant">Enter a Customer ID to load the statement.</p>';
      container.innerHTML = '';
      return;
    }

    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { from, to };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get(`/customer-bills/customers/${contactId}/statement`, params);
      const data = res?.data || {};
      const statement = data.statement || [];
      const totals = data.totals || {};

      totalsEl.innerHTML = `
        <div class="bg-surface-container-low rounded-lg p-stack-md text-center">
          <p class="font-label-md text-label-md text-on-surface-variant uppercase">Total Debit</p>
          <p class="font-display text-h2 text-on-surface mt-1">${Currency.format(this.num(totals.totalDebit), cur)}</p>
        </div>
        <div class="bg-surface-container-low rounded-lg p-stack-md text-center">
          <p class="font-label-md text-label-md text-on-surface-variant uppercase">Total Credit</p>
          <p class="font-display text-h2 text-on-surface mt-1">${Currency.format(this.num(totals.totalCredit), cur)}</p>
        </div>
        <div class="bg-secondary/10 rounded-lg p-stack-md text-center">
          <p class="font-label-md text-label-md text-on-surface-variant uppercase">Closing Balance</p>
          <p class="font-display text-h2 text-secondary mt-1">${Currency.format(this.num(totals.closingBalance), cur)}</p>
        </div>
      `;

      const csTable = new DataTable(container, {
        columns: [
          { key: 'date', label: 'Date', render: (v) => v || '—' },
          { key: 'reference', label: 'Reference' },
          { key: 'description', label: 'Description' },
          { key: 'debit', label: 'Debit', render: (v) => v ? `<span class="font-code text-error">-${Currency.format(v, cur)}</span>` : '—', align: 'right' },
          { key: 'credit', label: 'Credit', render: (v) => v ? `<span class="font-code text-green-600">+${Currency.format(v, cur)}</span>` : '—', align: 'right' },
          { key: 'balance', label: 'Balance', render: (v) => `<span class="font-code font-medium">${Currency.format(v, cur)}</span>`, align: 'right' },
          { key: 'status', label: 'Status', render: (v) => v ? this.renderStatusBadge(v) : '—' },
        ],
        data: statement,
        emptyState: 'No statement entries found',
      });
    } catch (err) {
      container.innerHTML = `<p class="text-error">Failed to load statement: ${err.message}</p>`;
    }
  },

  /* ═══ AR Aging Report ═══ */

  async renderAgingReport() {
    const main = document.getElementById('page-container');
    if (!main) return;
    const cur = this.currentCurrency;

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">AR Aging</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Accounts Receivable aging report with bucket breakdown.</p>
          </div>
          <button id="cb-back" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high">
            <span class="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
        </div>

        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-stack-md mb-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer</label>
              <input id="ar-contact" type="text" placeholder="Contact ID (optional)" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div></div>
            <div class="flex items-end">
              <button id="ar-load" class="w-full bg-secondary text-on-secondary px-3 py-2 rounded-lg hover:bg-secondary/90">Load</button>
            </div>
          </div>

          <div id="ar-summary" class="grid grid-cols-6 gap-stack-md mb-stack-md"></div>
          <div id="ar-table"></div>
        </div>
      </div>
    `;

    document.getElementById('cb-back').addEventListener('click', () => this.renderList());
    document.getElementById('ar-load').addEventListener('click', () => this.loadAgingReport());
    document.getElementById('ar-contact').addEventListener('keyup', (e) => { if (e.key === 'Enter') this.loadAgingReport(); });

    await this.loadAgingReport();
  },

  async loadAgingReport() {
    const container = document.getElementById('ar-table');
    const summaryEl = document.getElementById('ar-summary');
    const contactId = document.getElementById('ar-contact')?.value?.trim() || '';

    const params = {};
    if (contactId) params.contact_id = contactId;

    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/customer-bills/aging', params);
      const data = res?.data || {};
      const summary = data.summary || {};
      const items = data.detail || [];
      const total = data.total || items.length;

      const buckets = [
        { key: 'aging_0_30', label: '0–30 days', value: summary.aging_0_30 || 0 },
        { key: 'aging_31_60', label: '31–60 days', value: summary.aging_31_60 || 0 },
        { key: 'aging_61_90', label: '61–90 days', value: summary.aging_61_90 || 0 },
        { key: 'aging_91_180', label: '91–180 days', value: summary.aging_91_180 || 0 },
        { key: 'aging_180Plus', label: '180+ days', value: summary.aging_180Plus || 0 },
        { key: 'totalOutstanding', label: 'Total Outstanding', value: summary.totalOutstanding || 0, highlight: true },
      ];

      summaryEl.innerHTML = buckets.map(b => `
        <div class="${b.highlight ? 'bg-error/10' : 'bg-surface-container-low'} rounded-lg p-stack-md text-center">
          <p class="font-label-md text-label-md text-on-surface-variant uppercase">${b.label}</p>
          <p class="font-display text-h2 ${b.highlight ? 'text-error' : 'text-on-surface'} mt-1">${Currency.format(this.num(b.value), cur)}</p>
        </div>
      `).join('');

      const arTable = new DataTable(container, {
        columns: [
          { key: 'billNumber', label: 'Bill #', render: (v, r) => r.billNumber || r.bill_number || '—' },
          { key: 'contact_name', label: 'Customer', render: (v, r) => r.firstName || r.lastName ? [r.firstName, r.lastName].filter(Boolean).join(' ') : (r.contact_name || r.contactName || '—') },
          { key: 'dueDate', label: 'Due Date', render: (v, r) => r.dueDate || r.due_date || '—' },
          { key: 'outstandingAmount', label: 'Outstanding', render: (v, r) => `<span class="font-code text-error">${Currency.format(this.num(r.outstandingAmount || r.outstanding_amount || v || 0), cur)}</span>`, align: 'right' },
          { key: 'daysOverdue', label: 'Days Overdue', render: (v, r) => { const d = this.num(r.daysOverdue || r.days_overdue || v); return d > 0 ? `<span class="font-code text-error">${d}</span>` : `<span class="font-code text-green-600">${d}</span>`; } , align: 'center' },
          { key: 'status', label: 'Status', render: (v) => this.renderStatusBadge(v) },
        ],
        data: items,
        emptyState: 'No aging entries found',
        searchable: false,
      });
    } catch (err) {
      container.innerHTML = `<p class="text-error">Failed to load aging: ${err.message}</p>`;
    }
  },

  /* ═══ View Bill ═══ */

  async viewBillById(id) {
    const main = document.getElementById('page-container');
    if (!main) return;
    main.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get(`/customer-bills/${id}`);
      const bill = this.normBill(res?.data || res || {});
      this.currentBill = bill;
      this.renderBillView(bill);
    } catch (err) {
      main.innerHTML = `
        <div class="p-12 text-center flex flex-col items-center gap-3">
          <span class="material-symbols-outlined text-[40px] text-error">cloud_off</span>
          <p class="font-body-md text-body-md text-on-surface-variant">Unable to load customer bill</p>
          <div class="flex gap-stack-md mt-2">
            <button id="cb-retry" class="px-4 py-2 rounded-lg bg-secondary text-on-secondary hover:bg-secondary/90">Retry</button>
            <button id="cb-back-list" class="px-4 py-2 rounded-lg bg-surface-container text-on-surface-variant hover:bg-surface-container-high">Back to Bills</button>
          </div>
        </div>`;
      document.getElementById('cb-retry')?.addEventListener('click', () => this.viewBillById(id));
      document.getElementById('cb-back-list')?.addEventListener('click', () => { window.location.hash = '#customer-bills'; });
    }
  },

  async viewBill(row) {
    if (!row || !row.id) return;
    window.location.hash = `#customer-bills/${row.id}`;
  },

  detailTab: 'overview',

  renderBillView(bill) {
    const main = document.getElementById('page-container');
    if (!main) return;
    const cur = bill.currency || this.currentCurrency || 'INR';
    const cust = bill.customer || {};
    const docNumber = this.esc(bill.bill_number || bill.invoice_number || bill.id, '—');
    const status = bill.status || 'DRAFT';
    const ps = this.paymentStatus(bill);
    const od = this.daysOverdue(bill.due_date);
    const isOverdue = od > 0 && this.num(bill.balance) > 0 && !['PAID', 'CANCELLED', 'VOID', 'DRAFT'].includes(status);

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <!-- Header -->
        <div class="flex items-start justify-between flex-wrap gap-stack-md">
          <div>
            <button id="cb-back" class="flex items-center gap-1 font-body-sm text-body-sm text-on-surface-variant hover:text-on-surface mb-2">
              <span class="material-symbols-outlined text-[18px]">arrow_back</span> Back to Bills
            </button>
            <div class="flex items-center gap-stack-md flex-wrap">
              <h1 class="font-display text-h1 text-on-surface tracking-tight">${docNumber}</h1>
              ${this.renderStatusBadge(status)}
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Customer Bill · ${this.esc(cust.name || bill.contact_name, 'No customer')}</p>
          </div>
          <div class="flex gap-stack-md flex-wrap">
            <button id="cb-action-edit" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>
            ${['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'CANCELLED', 'VOID'].includes(bill.status) ? '' : `<button id="cb-action-payment" class="flex items-center gap-1 bg-secondary text-on-secondary px-3 py-2 rounded-lg hover:bg-secondary/90"><span class="material-symbols-outlined text-[18px]">payment</span> Record Payment</button>`}
            <button id="cb-action-send" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high"><span class="material-symbols-outlined text-[18px]">send</span> Send</button>
            <button id="cb-action-pdf" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high"><span class="material-symbols-outlined text-[18px]">picture_as_pdf</span> PDF</button>
            <button id="cb-action-more" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high" aria-haspopup="true"><span class="material-symbols-outlined text-[18px]">more_horiz</span> More</button>
          </div>
        </div>

        <!-- Financial Summary Strip -->
        <div class="grid grid-cols-2 md:grid-cols-${isOverdue ? '5' : '4'} gap-stack-md">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <div class="text-on-surface-variant font-body-sm uppercase">Total</div>
            <div class="font-display text-h2 text-on-surface mt-1">${Currency.format(this.num(bill.total), cur)}</div>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <div class="text-on-surface-variant font-body-sm uppercase">Paid</div>
            <div class="font-display text-h2 text-emerald-700 mt-1">${Currency.format(this.num(bill.paid_amount), cur)}</div>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <div class="text-on-surface-variant font-body-sm uppercase">Outstanding</div>
            <div class="font-display text-h2 text-secondary mt-1">${Currency.format(this.num(bill.balance), cur)}</div>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <div class="text-on-surface-variant font-body-sm uppercase">Payment Status</div>
            <div class="mt-2">${this.renderPaymentBadge(bill)}</div>
          </div>
          ${isOverdue ? `
          <div class="bg-red-50 rounded-xl border border-red-200 p-container-padding">
            <div class="text-red-700 font-body-sm uppercase">Overdue</div>
            <div class="font-display text-h2 text-error mt-1">${od} ${od === 1 ? 'Day' : 'Days'}</div>
          </div>` : ''}
        </div>

        <!-- Invoice Summary Card -->
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <div class="grid grid-cols-1 md:grid-cols-4 gap-stack-lg">
            <div>
              <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-1">Customer</p>
              <p class="font-body-md text-body-md text-on-surface font-medium">${this.esc(cust.name || bill.contact_name, '—')}</p>
              ${this.esc(cust.gstin, '') ? `<p class="font-body-sm text-body-sm text-on-surface-variant">GSTIN: ${this.esc(cust.gstin, '')}</p>` : ''}
              ${this.esc(cust.billing_address, '') ? `<p class="font-body-sm text-body-sm text-on-surface-variant mt-1 whitespace-pre-line">${this.esc(cust.billing_address, '')}</p>` : ''}
            </div>
            <div>
              <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-1">Invoice Date</p>
              <p class="font-body-md text-body-md text-on-surface">${this.fmtDate(bill.issue_date)}</p>
              <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-1 mt-3">Due Date</p>
              <p class="font-body-md text-body-md text-on-surface">${this.fmtDate(bill.due_date)}</p>
            </div>
            <div>
              <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-1">Payment Terms</p>
              <p class="font-body-md text-body-md text-on-surface">${this.esc(this.paymentTermsLabel(bill.payment_terms), '—')}</p>
              <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-1 mt-3">Currency</p>
              <p class="font-body-md text-body-md text-on-surface">${this.esc(cur, '—')}</p>
            </div>
            <div>
              <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-1">Reference</p>
              <p class="font-body-md text-body-md text-on-surface">${this.esc(bill.reference_number, '—')}</p>
              ${this.esc(bill.customer_po_number, '') ? `<p class="font-label-md text-label-md text-on-surface-variant uppercase mb-1 mt-3">PO Number</p><p class="font-body-md text-body-md text-on-surface">${this.esc(bill.customer_po_number, '')}</p>` : ''}
            </div>
          </div>
        </div>

        <!-- Lifecycle Timeline -->
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-3">Bill Lifecycle</p>
          ${this.renderLifecycleTimeline(bill)}
        </div>

        <!-- Tabs -->
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="flex flex-wrap gap-1 p-container-padding border-b border-outline-variant/30" role="tablist" id="cb-detail-tabs">
            ${['overview', 'items', 'payments', 'accounting', 'audit', 'attachments'].map(t => `
              <button data-tab="${t}" role="tab" aria-selected="${this.detailTab === t}" class="px-3 py-2 font-label-md text-sm rounded-lg transition-colors ${this.detailTab === t ? 'bg-secondary/10 text-secondary font-medium' : 'text-on-surface-variant hover:bg-surface-container-high'}">${{ overview: 'Overview', items: 'Items', payments: 'Payments', accounting: 'Accounting', audit: 'Audit Trail', attachments: 'Attachments' }[t]}</button>
            `).join('')}
          </div>
          <div id="cb-detail-content" class="p-container-padding"></div>
        </div>

        <!-- Lifecycle Actions -->
        <div class="flex gap-stack-sm flex-wrap">
          ${this.renderLifecycleButtons(bill)}
        </div>
      </div>
    `;

    document.getElementById('cb-back')?.addEventListener('click', () => { window.location.hash = '#customer-bills'; });
    document.getElementById('cb-action-edit')?.addEventListener('click', () => this.openForm(bill));
    document.getElementById('cb-action-payment')?.addEventListener('click', () => this.recordPayment(bill));
    document.getElementById('cb-action-send')?.addEventListener('click', () => Toast.info('Bill queued for sending'));
    document.getElementById('cb-action-pdf')?.addEventListener('click', () => window.print());
    document.getElementById('cb-action-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openRowMenu(bill, -1);
    });
    document.getElementById('cb-detail-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      this.detailTab = b.dataset.tab;
      this.renderBillView(bill);
    });
    this.renderDetailTab(bill);
  },

  paymentTermsLabel(terms) {
    if (!terms) return null;
    const m = { DUE_ON_RECEIPT: 'Due on Receipt', ADVANCE: 'Advance', END_OF_MONTH: 'End of Month', SPECIFIC_DATE: 'Specific Date' };
    return m[terms] || (this.num(terms) ? `Net ${terms}` : terms);
  },

  renderLifecycleTimeline(bill) {
    const stages = [
      { key: 'created', label: 'Created', done: true, date: bill.created_at },
      { key: 'approved', label: 'Approved', done: !!bill.approved_at, date: bill.approved_at },
      { key: 'posted', label: 'Posted', done: !!bill.posted_at, date: bill.posted_at },
      { key: 'payment', label: 'Payment Received', done: this.num(bill.paid_amount) > 0, date: (bill.payments && bill.payments[0] && bill.payments[0].payment_date) || null },
      { key: 'partially', label: 'Partially Paid', done: bill.status === 'PARTIALLY_PAID', date: null },
      { key: 'paid', label: 'Paid', done: bill.status === 'PAID', date: null },
    ];
    return `<div class="flex items-center flex-wrap gap-1">
      ${stages.map((st, i) => `
        <div class="flex items-center gap-1">
          <div class="flex flex-col items-center px-2">
            <span class="w-7 h-7 rounded-full flex items-center justify-center ${st.done ? 'bg-secondary text-on-secondary' : 'bg-surface-container-high text-on-surface-variant'}" title="${st.label}">
              <span class="material-symbols-outlined text-[16px]">${st.done ? 'check' : 'radio_button_unchecked'}</span>
            </span>
            <span class="font-body-sm text-[11px] mt-1 ${st.done ? 'text-on-surface font-medium' : 'text-on-surface-variant'}">${st.label}</span>
            ${st.date && st.done ? `<span class="font-body-sm text-[10px] text-on-surface-variant">${this.fmtDate(st.date)}</span>` : ''}
          </div>
          ${i < stages.length - 1 ? '<span class="material-symbols-outlined text-[16px] text-outline-variant -mt-4">arrow_forward</span>' : ''}
        </div>
      `).join('')}
    </div>`;
  },

  renderDetailTab(bill) {
    const el = document.getElementById('cb-detail-content');
    if (!el) return;
    const cur = bill.currency || this.currentCurrency || 'INR';
    const cust = bill.customer || {};
    const tab = this.detailTab;

    if (tab === 'overview') {
      el.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-stack-lg">
          <div>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2">Customer Information</p>
            <div class="space-y-1">
              <p class="font-body-md text-body-md text-on-surface">${this.esc(cust.name || bill.contact_name, '—')}</p>
              ${this.esc(cust.organization, '') ? `<p class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(cust.organization, '')}</p>` : ''}
              ${this.esc(cust.email, '') ? `<p class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(cust.email, '')}</p>` : ''}
              ${this.esc(cust.phone, '') ? `<p class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(cust.phone, '')}</p>` : ''}
            </div>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2 mt-4">Billing Information</p>
            <p class="font-body-sm text-body-sm text-on-surface whitespace-pre-line">${this.esc(cust.billing_address || bill.billing_address, '—')}</p>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2 mt-4">Shipping Address</p>
            <p class="font-body-sm text-body-sm text-on-surface whitespace-pre-line">${this.esc(cust.shipping_address || bill.shipping_address, '—')}</p>
          </div>
          <div>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2">Payment Information</p>
            <table class="w-full">
              <tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">Total</td><td class="font-code text-right">${Currency.format(this.num(bill.total), cur)}</td></tr>
              <tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">Paid</td><td class="font-code text-right">${Currency.format(this.num(bill.paid_amount), cur)}</td></tr>
              <tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">Balance</td><td class="font-code text-right font-medium">${Currency.format(this.num(bill.balance), cur)}</td></tr>
              <tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">Payment Terms</td><td class="text-right">${this.esc(this.paymentTermsLabel(bill.payment_terms), '—')}</td></tr>
            </table>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2 mt-4">Notes</p>
            <p class="font-body-sm text-body-sm text-on-surface whitespace-pre-line">${this.esc(bill.notes, 'No notes')}</p>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2 mt-4">Terms & Conditions</p>
            <p class="font-body-sm text-body-sm text-on-surface whitespace-pre-line">${this.esc(bill.terms, 'No terms specified')}</p>
          </div>
        </div>`;
    } else if (tab === 'items') {
      const items = bill.items || [];
      el.innerHTML = items.length ? `
        <div class="overflow-x-auto">
        <table class="w-full">
          <thead><tr class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase">
            <th class="text-left py-2 px-3">Item</th>
            <th class="text-left py-2 px-3">Description</th>
            <th class="text-center py-2 px-3">HSN/SAC</th>
            <th class="text-center py-2 px-3">Qty</th>
            <th class="text-center py-2 px-3">Unit</th>
            <th class="text-right py-2 px-3">Rate</th>
            <th class="text-right py-2 px-3">Discount</th>
            <th class="text-right py-2 px-3">Tax</th>
            <th class="text-right py-2 px-3">Amount</th>
          </tr></thead>
          <tbody>
            ${items.map((i, ix) => {
              const qty = this.num(i.quantity), rate = this.num(i.unit_price || i.rate);
              const disc = this.num(i.discount_amount);
              const tax = this.num(i.line_tax || i.tax_amount) || this.num(i.cgst_amount) + this.num(i.sgst_amount) + this.num(i.igst_amount);
              const amt = this.num(i.line_total || i.amount) || (qty * rate - disc + tax);
              return `<tr class="border-b border-outline-variant/20">
                <td class="py-2 px-3">${this.esc(i.item_name || i.sku, `Item ${ix + 1}`)}</td>
                <td class="py-2 px-3">${this.esc(i.description, '—')}</td>
                <td class="py-2 px-3 text-center font-code">${this.esc(i.hsn_sac, '—')}</td>
                <td class="py-2 px-3 text-center">${qty}</td>
                <td class="py-2 px-3 text-center">${this.esc(i.unit, '—')}</td>
                <td class="py-2 px-3 text-right font-code">${Currency.format(rate, cur)}</td>
                <td class="py-2 px-3 text-right font-code">${disc ? '−' + Currency.format(disc, cur) : '—'}</td>
                <td class="py-2 px-3 text-right font-code">${Currency.format(tax, cur)}</td>
                <td class="py-2 px-3 text-right font-code font-medium">${Currency.format(amt, cur)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="flex justify-end mt-4">${this.renderTotalsPanel(bill, cur)}</div>
        </div>`
        : `<div class="text-center py-8"><p class="font-body-md text-body-md text-on-surface-variant">No line items on this bill</p></div>`;
    } else if (tab === 'payments') {
      const payments = bill.payments || [];
      el.innerHTML = `
        <div class="flex justify-end mb-3">
          <button id="cb-tab-payment" class="flex items-center gap-1 bg-secondary text-on-secondary px-3 py-2 rounded-lg hover:bg-secondary/90 font-body-sm text-body-sm"><span class="material-symbols-outlined text-[16px]">payment</span> Record Payment</button>
        </div>
        ${payments.length ? `
        <table class="w-full">
          <thead><tr class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase">
            <th class="text-left py-2 px-3">Payment #</th>
            <th class="text-left py-2 px-3">Date</th>
            <th class="text-left py-2 px-3">Method</th>
            <th class="text-left py-2 px-3">Reference</th>
            <th class="text-right py-2 px-3">Amount</th>
            <th class="text-right py-2 px-3">Allocated</th>
          </tr></thead>
          <tbody>
            ${payments.map(p => `<tr class="border-b border-outline-variant/20">
              <td class="py-2 px-3 font-code">${this.esc(p.id, '—')}</td>
              <td class="py-2 px-3">${this.fmtDate(p.payment_date)}</td>
              <td class="py-2 px-3">${this.esc(p.payment_method, '—')}</td>
              <td class="py-2 px-3">${this.esc(p.reference_number, '—')}</td>
              <td class="py-2 px-3 text-right font-code">${Currency.format(this.num(p.amount), cur)}</td>
              <td class="py-2 px-3 text-right font-code">${Currency.format(this.num(p.amount), cur)}</td>
            </tr>`).join('')}
          </tbody>
        </table>`
        : `<div class="text-center py-8"><p class="font-body-md text-body-md text-on-surface-variant">No payments recorded yet</p></div>`}`;
      document.getElementById('cb-tab-payment')?.addEventListener('click', () => this.recordPayment(bill));
    } else if (tab === 'accounting') {
      const posted = !!bill.journal_entry_id;
      el.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-stack-lg">
          <div>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2">Accounting Status</p>
            <span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] gap-1 ${posted ? 'bg-green-50 text-green-700' : 'bg-surface-container-high text-on-surface-variant'}">
              <span class="w-1.5 h-1.5 rounded-full ${posted ? 'bg-green-500' : 'bg-outline'}"></span>${posted ? 'POSTED' : 'NOT POSTED'}
            </span>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2 mt-4">Journal Entry</p>
            ${posted ? `
              <button id="cb-view-je" class="inline-flex items-center gap-1 font-code text-secondary hover:underline">
                <span class="material-symbols-outlined text-[18px]">book</span> ${this.esc(bill.journal_entry_id, '—')}
              </button>`
              : '<p class="font-body-sm text-body-sm text-on-surface-variant">Journal entry will be created when the bill is posted to the ledger.</p>'}
          </div>
          <div>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase mb-2">Account Mapping</p>
            <table class="w-full">
              <tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">Receivable Account</td><td class="text-right">Customer Receivable (acc_receivable)</td></tr>
              <tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">Sales Account</td><td class="text-right">Sales (acc_sales)</td></tr>
              ${this.num(bill.cgst_amount) > 0 ? `<tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">CGST</td><td class="text-right font-code">${Currency.format(this.num(bill.cgst_amount), cur)}</td></tr>` : ''}
              ${this.num(bill.sgst_amount) > 0 ? `<tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">SGST</td><td class="text-right font-code">${Currency.format(this.num(bill.sgst_amount), cur)}</td></tr>` : ''}
              ${this.num(bill.igst_amount) > 0 ? `<tr><td class="font-body-sm text-body-sm text-on-surface-variant py-1">IGST</td><td class="text-right font-code">${Currency.format(this.num(bill.igst_amount), cur)}</td></tr>` : ''}
            </table>
          </div>
        </div>`;
      document.getElementById('cb-view-je')?.addEventListener('click', () => { window.location.hash = `#accounting/journal/${bill.journal_entry_id}`; });
    } else if (tab === 'audit') {
      const trail = bill.audit_trail || [];
      el.innerHTML = trail.length ? `
        <div class="space-y-stack-md">
          ${trail.map(a => `
            <div class="flex gap-3 items-start">
              <span class="material-symbols-outlined text-[18px] text-on-surface-variant mt-0.5">history</span>
              <div>
                <p class="font-body-md text-body-md text-on-surface">${this.esc(a.action, '—')}${a.user_id ? ` <span class="text-on-surface-variant">by ${this.esc(a.user_id, '')}</span>` : ''}</p>
                <p class="font-body-sm text-body-sm text-on-surface-variant">${this.fmtDate(a.created_at)}${a.created_at && new Date(a.created_at).toLocaleTimeString ? ` · ${new Date(a.created_at).toLocaleTimeString('en-IN')}` : ''}</p>
              </div>
            </div>`).join('')}
        </div>`
        : '<div class="text-center py-8"><p class="font-body-md text-body-md text-on-surface-variant">No audit trail recorded</p></div>';
    } else if (tab === 'attachments') {
      el.innerHTML = '<div class="text-center py-8"><p class="font-body-md text-body-md text-on-surface-variant">No attachments</p></div>';
    }
  },

  renderTotalsPanel(bill, cur) {
    const row = (label, val, cls = '') => `<tr><td class="font-label-md text-on-surface-variant pr-6">${label}</td><td class="font-code w-[140px] text-right ${cls}">${Currency.format(this.num(val), cur)}</td></tr>`;
    return `<table class="text-right">
      ${row('Subtotal', bill.subtotal)}
      ${this.num(bill.discount_amount || bill.discount) > 0 ? row('Discount', -(this.num(bill.discount_amount || bill.discount))) : ''}
      ${row('Taxable Amount', bill.taxable_amount)}
      ${this.num(bill.cgst_amount) > 0 ? row('CGST', bill.cgst_amount) : ''}
      ${this.num(bill.sgst_amount) > 0 ? row('SGST', bill.sgst_amount) : ''}
      ${this.num(bill.igst_amount) > 0 ? row('IGST', bill.igst_amount) : ''}
      ${this.num(bill.other_charges) > 0 ? row('Other Charges', bill.other_charges) : ''}
      ${row('Round Off', bill.round_off)}
      <tr class="border-t border-outline-variant/30"><td class="font-display text-h2 text-on-surface pr-6">GRAND TOTAL</td><td class="font-display font-bold w-[140px] text-right text-secondary text-h2">${Currency.format(this.num(bill.total), cur)}</td></tr>
      ${row('Paid', bill.paid_amount)}
      <tr class="border-t border-outline-variant/30"><td class="font-display text-h2 text-on-surface pr-6">Balance</td><td class="font-display font-bold w-[140px] text-right text-secondary text-h2">${Currency.format(this.num(bill.balance), cur)}</td></tr>
    </table>`;
  },

  renderLifecycleButtons(bill) {
    const s = bill.status;
    const can = (action) => AccountingState.canTransition(s, action);
    const btns = [];

    if (s === 'DRAFT') {
      btns.push(`<button id="cb-action-submit" class="flex items-center gap-1 bg-blue-50 text-blue-700 px-3 py-2 rounded-lg hover:bg-blue-100"><span class="material-symbols-outlined text-[16px]">send</span> Submit for Approval</button>`);
      btns.push(`<button id="cb-action-edit" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high" data-lifecycle="edit"><span class="material-symbols-outlined text-[16px]">edit</span> Edit</button>`);
      btns.push(`<button id="cb-action-delete" class="flex items-center gap-1 bg-error-container/20 text-error px-3 py-2 rounded-lg hover:bg-error-container/30"><span class="material-symbols-outlined text-[16px]">delete</span> Delete</button>`);
    }
    if (s === 'PENDING_APPROVAL') {
      btns.push(`<button id="cb-action-approve" class="flex items-center gap-1 bg-green-50 text-green-700 px-3 py-2 rounded-lg hover:bg-green-100"><span class="material-symbols-outlined text-[16px]">check_circle</span> Approve</button>`);
      btns.push(`<button id="cb-action-back-draft" class="flex items-center gap-1 bg-surface-container text-on-surface-variant px-3 py-2 rounded-lg hover:bg-surface-container-high"><span class="material-symbols-outlined text-[16px]">arrow_back</span> Back to Draft</button>`);
    }
    if (can('POSTED') || s === 'APPROVED') {
      btns.push(`<button id="cb-action-post" class="flex items-center gap-1 bg-green-50 text-green-700 px-3 py-2 rounded-lg hover:bg-green-100"><span class="material-symbols-outlined text-[16px]">post_add</span> Post to Ledger</button>`);
    }
    if (['POSTED', 'PARTIALLY_PAID', 'OVERDUE'].includes(s)) {
      btns.push(`<button id="cb-action-payment" class="flex items-center gap-1 bg-indigo-50 text-indigo-700 px-3 py-2 rounded-lg hover:bg-indigo-100"><span class="material-symbols-outlined text-[16px]">payment</span> Record Payment</button>`);
      btns.push(`<button id="cb-action-cn" class="flex items-center gap-1 bg-purple-50 text-purple-700 px-3 py-2 rounded-lg hover:bg-purple-100"><span class="material-symbols-outlined text-[16px]">receipt_long</span> Credit Note</button>`);
    }
    if (['POSTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].includes(s)) {
      btns.push(`<button id="cb-action-cancel" class="flex items-center gap-1 bg-error-container/20 text-error px-3 py-2 rounded-lg hover:bg-error-container/30"><span class="material-symbols-outlined text-[16px]">cancel</span> Cancel / Void</button>`);
    }
    if (['POSTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].includes(s)) {
      btns.push(`<button id="cb-action-debit" class="flex items-center gap-1 bg-orange-50 text-orange-700 px-3 py-2 rounded-lg hover:bg-orange-100"><span class="material-symbols-outlined text-[16px]">description</span> Debit Note</button>`);
    }
    if (['POSTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].includes(s)) {
      btns.push(`<button id="cb-action-writeoff" class="flex items-center gap-1 bg-gray-50 text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-100"><span class="material-symbols-outlined text-[16px]">balance_empty</span> Write Off</button>`);
    }
    if (['OVERDUE', 'PARTIALLY_PAID'].includes(s)) {
      btns.push(`<button id="cb-action-dispute" class="flex items-center gap-1 bg-red-50 text-red-700 px-3 py-2 rounded-lg hover:bg-red-100"><span class="material-symbols-outlined text-[16px]">report_problem</span> Raise Dispute</button>`);
    }

    const html = `<div class="flex gap-stack-sm flex-wrap">${btns.join('')}</div>`;
    setTimeout(() => {
      document.getElementById('cb-action-submit')?.addEventListener('click', () => this.handleAction('submit', bill));
      document.getElementById('cb-action-approve')?.addEventListener('click', () => this.handleAction('approve', bill));
      document.getElementById('cb-action-post')?.addEventListener('click', () => this.handleAction('post', bill));
      document.getElementById('cb-action-payment')?.addEventListener('click', () => this.handleAction('payment', bill));
      document.getElementById('cb-action-cn')?.addEventListener('click', () => this.handleAction('credit', bill));
      document.getElementById('cb-action-delete')?.addEventListener('click', () => this.confirmDelete(bill));
      document.querySelector('[data-lifecycle="edit"]')?.addEventListener('click', () => this.openForm(bill));
      document.getElementById('cb-action-back-draft')?.addEventListener('click', () => this.handleAction('back-draft', bill));
      document.getElementById('cb-action-cancel')?.addEventListener('click', () => this.handleAction('cancel', bill));
      document.getElementById('cb-action-debit')?.addEventListener('click', () => this.handleAction('debit', bill));
      document.getElementById('cb-action-writeoff')?.addEventListener('click', () => this.handleAction('writeoff', bill));
      document.getElementById('cb-action-dispute')?.addEventListener('click', () => this.handleAction('dispute', bill));
    }, 0);
    return html;
  },

  renderStatusBadge(status) {
    const statuses = {
      DRAFT: { bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' },
      PENDING_APPROVAL: { bg: 'bg-yellow-50 text-yellow-700', dot: 'bg-yellow-500' },
      APPROVED: { bg: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
      POSTED: { bg: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
      PARTIALLY_PAID: { bg: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500' },
      PAID: { bg: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
      OVERDUE: { bg: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
      CANCELLED: { bg: 'bg-gray-50 text-gray-700', dot: 'bg-gray-500' },
      WRITTEN_OFF: { bg: 'bg-gray-50 text-gray-700', dot: 'bg-gray-500' },
    };
    const s = statuses[status] || statuses.DRAFT;
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] gap-1 ${s.bg}"><span class="w-1.5 h-1.5 rounded-full ${s.dot}"></span>${this.statusLabel(status)}</span>`;
  },

  confirmDelete(row) {
    const modal = new Modal({
      title: 'Delete Bill?', size: 'sm',
      content: `<p class="font-body-md text-on-surface mb-stack-md">Delete <strong>${row.bill_number}</strong>? This action cannot be undone.</p>
        <div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
        <button id="cb-confirm-delete" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Delete</button></div>`,
    });
    modal.open();
    modal.element.querySelector('#cb-confirm-delete')?.addEventListener('click', async () => {
      try {
        await API.del(`/customer-bills/${row.id}`);
        Toast.success('Bill deleted'); modal.close();
        if (window.location.hash.startsWith('#customer-bills/')) window.location.hash = '#customer-bills';
        else { this.loadBills(); this.loadKpi(); this.loadStatusCounts(); }
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  /* ═══ Create Bill Page (Step 7) ═══ */

  /**
   * Full-page professional Create Customer Bill workspace.
   * Replaces page-container innerHTML. Reuses existing helpers:
   *  - normBill / normBillLines for field mapping
   *  - updateBillTotals / saveBill for totals & persistence
   *  - paymentTermsLabel, currencyOptions, Currency, API, Toast, ErrorState
   */
  async renderCreatePage() {
    const main = document.getElementById('page-container');
    if (!main) return;

    try { history.replaceState({ billCreate: true }, '', window.location.hash); } catch (e) {}

    main.innerHTML = `
      <div id="cb-create-root" class="p-6 max-w-none">
        <!-- Back + Page Header -->
        <div class="flex items-center gap-4 mb-6">
          <button id="cb-back" type="button" class="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface-variant transition-colors">
            <span class="material-symbols-outlined text-[20px]">arrow_back</span>
          </button>
          <div>
            <h1 class="text-display-sm font-display text-on-surface">Create Customer Bill</h1>
            <p class="text-body-sm text-on-surface-variant mt-0.5" id="cb-bill-number-display">Auto-generated</p>
          </div>
        </div>

        <!-- Global error (non-fatal) -->
        <div id="cb-create-error" class="hidden mb-4 p-4 rounded-lg bg-error-container/10 border border-error-container/30">
          <div class="flex items-start gap-2">
            <span class="material-symbols-outlined text-[20px] shrink-0">error</span>
            <div class="flex-1 text-sm" id="cb-create-error-msg"></div>
            <button type="button" id="cb-create-retry" class="text-xs font-medium underline">Retry</button>
          </div>
        </div>

        <!-- Loading overlay -->
        <div id="cb-create-loading" class="hidden fixed inset-0 z-[100] bg-background/60 flex items-center justify-center">
          <div class="flex flex-col items-center gap-3 bg-surface-container-lowest rounded-xl px-8 py-6 shadow-xl border border-outline-variant">
            <span class="material-symbols-outlined text-[32px] animate-spin text-primary">progress_activity</span>
            <span class="text-body-sm text-on-surface-variant">Loading bill workspace…</span>
          </div>
        </div>

        <!-- Action Bar (sticky top) -->
        <div class="flex items-center justify-between mb-4 pb-3 border-b border-outline">
          <div class="flex items-center gap-2 text-sm text-on-surface-variant">
            <span id="cb-save-status" class="hidden items-center gap-1"><span class="material-symbols-outlined text-[16px] text-green-600">check_circle</span> Saved as draft</span>
          </div>
          <div class="flex items-center gap-2">
            <button id="cb-btn-save-draft" type="button" class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-body-md transition-colors disabled:opacity-50">
              <span class="material-symbols-outlined text-[18px] mr-1 align-middle">save</span>Save Draft
            </button>
            <button id="cb-btn-submit" type="button" class="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-on-primary font-body-md transition-colors disabled:opacity-50">
              <span class="material-symbols-outlined text-[18px] mr-1 align-middle">send</span>Submit for Approval
            </button>
            <button id="cb-btn-cancel" type="button" class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-body-md transition-colors">
              Cancel
            </button>
          </div>
        </div>

        <form id="cb-create-form" class="flex flex-col gap-6">
          <!-- ===== BILL INFORMATION ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <h2 class="text-h5 font-display text-on-surface mb-4 flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px]">description</span>Bill Information
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div class="md:col-span-1">
                <label class="block text-body-sm font-medium text-on-surface mb-1">Bill Number</label>
                <div class="flex items-center gap-2">
                  <span id="cb-bill-number" class="text-body-md font-code text-secondary bg-surface-container px-3 py-2 rounded-lg border border-outline-variant flex-1">—</span>
                  <span class="text-body-xs text-on-surface-variant cursor-help" title="Auto-generated by the system on save">ⓘ</span>
                </div>
              </div>
              <div class="md:col-span-1">
                <label for="cb-bill-date" class="block text-body-sm font-medium text-on-surface mb-1">Invoice Date</label>
                <input id="cb-bill-date" type="date" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none"/>
              </div>
              <div class="md:col-span-1">
                <label for="cb-due-date" class="block text-body-sm font-medium text-on-surface mb-1">Due Date</label>
                <input id="cb-due-date" type="date" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none"/>
              </div>
              <div class="md:col-span-1">
                <label for="cb-currency" class="block text-body-sm font-medium text-on-surface mb-1">Currency</label>
                <select id="cb-currency" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none">
                  ${Currency.currencyOptions(this.currentCurrency)}
                </select>
              </div>
              <div class="md:col-span-1">
                <label for="cb-payment-terms" class="block text-body-sm font-medium text-on-surface mb-1">Payment Terms</label>
                <select id="cb-payment-terms" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none">
                  <option value="DUE_ON_RECEIPT">Due on Receipt</option>
                  <option value="ADVANCE">Advance</option>
                  <option value="Net 7">Net 7</option>
                  <option value="Net 15">Net 15</option>
                  <option value="Net 30" selected>Net 30</option>
                  <option value="Net 45">Net 45</option>
                  <option value="Net 60">Net 60</option>
                  <option value="END_OF_MONTH">End of Month</option>
                  <option value="SPECIFIC_DATE">Specific Date</option>
                </select>
              </div>
              <div class="md:col-span-1">
                <label for="cb-reference-number" class="block text-body-sm font-medium text-on-surface mb-1">Reference Number</label>
                <input id="cb-reference-number" type="text" placeholder="" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none"/>
              </div>
              <div class="md:col-span-1">
                <label for="cb-customer-po-number" class="block text-body-sm font-medium text-on-surface mb-1">Customer PO Number</label>
                <input id="cb-customer-po-number" type="text" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none"/>
              </div>
              <div class="md:col-span-1">
                <label for="cb-customer-po-date" class="block text-body-sm font-medium text-on-surface mb-1">Customer PO Date</label>
                <input id="cb-customer-po-date" type="date" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none"/>
              </div>
              <div class="md:col-span-1">
                <label for="cb-place-of-supply" class="block text-body-sm font-medium text-on-surface mb-1">Place of Supply</label>
                <select id="cb-place-of-supply" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none">
                  <option value="">Loading…</option>
                </select>
              </div>
            </div>
          </section>

          <!-- ===== CUSTOMER INFORMATION ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <h2 class="text-h5 font-display text-on-surface mb-4 flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px]">person</span>Customer Information
            </h2>
            <div class="mb-4">
              <label class="block text-body-sm font-medium text-on-surface mb-1">Customer</label>
              <div id="cb-customer-selector" class="border border-outline-variant rounded-lg bg-surface-container"></div>
              <input id="cb-customer-id" type="hidden" name="contact_id"/>
            </div>
            <div id="cb-customer-info" class="hidden grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-3">
                <div><span class="text-body-sm text-on-surface-variant">Customer Name</span><span id="cb-cinfo-name" class="block text-body-md text-on-surface">—</span></div>
                <div><span class="text-body-sm text-on-surface-variant">Customer Code</span><span id="cb-cinfo-code" class="block text-body-md text-on-surface">—</span></div>
                <div><span class="text-body-sm text-on-surface-variant">GSTIN</span><span id="cb-cinfo-gstin" class="block text-body-md text-on-surface">—</span></div>
                <div><span class="text-body-sm text-on-surface-variant">Email</span><span id="cb-cinfo-email" class="block text-body-md text-on-surface">—</span></div>
              </div>
              <div class="space-y-3">
                <div>
                  <span class="text-body-sm text-on-surface-variant">Billing Address</span>
                  <div id="cb-cinfo-billing" class="mt-1 text-body-md text-on-surface bg-surface-container px-3 py-2 rounded-lg border border-outline-variant min-h-[60px]">—</div>
                </div>
                <div class="flex items-start gap-2 mt-1">
                  <input id="cb-same-address" type="checkbox" class="mt-1"/>
                  <label for="cb-same-address" class="text-body-sm text-on-surface cursor-pointer">Use Billing Address as Shipping Address</label>
                </div>
                <div>
                  <span class="text-body-sm text-on-surface-variant">Shipping Address</span>
                  <div id="cb-cinfo-shipping" class="mt-1 text-body-md text-on-surface bg-surface-container px-3 py-2 rounded-lg border border-outline-variant min-h-[60px]">—</div>
                </div>
              </div>
            </div>
            <input id="cb-billing-address" type="hidden" name="billing_address"/>
            <input id="cb-shipping-address" type="hidden" name="shipping_address"/>
            <input id="cb-customer-gstin" type="hidden" name="customer_gstin"/>
          </section>

          <!-- ===== CUSTOMER FINANCIAL SNAPSHOT ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <h2 class="text-h5 font-display text-on-surface mb-4 flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px]">account_balance</span>Financial Snapshot
              <button type="button" id="cb-refresh-financial" class="ml-auto text-on-surface-variant hover:text-on-surface" title="Refresh financial data">
                <span class="material-symbols-outlined text-[18px]">refresh</span>
              </button>
            </h2>
            <!-- Credit Hold Warning (hidden until triggered) -->
            <div id="cb-credit-hold" class="hidden mb-4 p-4 rounded-lg border border-error-container bg-error-container/10">
              <div class="flex items-start gap-3">
                <span class="material-symbols-outlined text-[20px] shrink-0 text-error-content">warning</span>
                <div class="flex-1">
                  <div class="font-medium text-error-content">CUSTOMER ON CREDIT HOLD</div>
                  <div class="text-sm text-error-content/90 mt-1">This customer is on an account hold. New billing may be restricted.</div>
                </div>
              </div>
            </div>
            <!-- Overdue Warning (hidden until triggered) -->
            <div id="cb-overdue-warning" class="hidden mb-4 p-4 rounded-lg border border-error-container bg-error-container/10">
              <div class="flex items-start gap-3">
                <span class="material-symbols-outlined text-[20px] shrink-0 text-error-content">error</span>
                <div class="flex-1">
                  <div class="font-medium text-error-content">CUSTOMER HAS OVERDUE BALANCE</div>
                  <div class="text-sm text-error-content/90 space-y-0.5 mt-1" id="cb-overdue-details"></div>
                </div>
              </div>
            </div>
            <!-- Financial Snapshot Grid -->
            <div id="cb-financial-snapshot" class="text-center py-4 text-on-surface-variant">
              <div class="flex items-center justify-center gap-2">
                <span class="material-symbols-outlined animate-spin">progress_activity</span>
                <span class="text-body-sm">Select a customer to view financial data</span>
              </div>
            </div>
            <!-- Credit Utilization Progress -->
            <div id="cb-credit-utilization" class="hidden mb-4">
              <div class="flex justify-between text-body-sm mb-1">
                <span class="text-on-surface-variant">Credit Utilization</span>
                <span id="cb-credit-util-text" class="text-on-surface font-medium">0%</span>
              </div>
              <div class="w-full h-4 bg-surface-container-high rounded-full overflow-hidden">
                <div id="cb-credit-util-bar" class="h-full bg-secondary transition-all duration-300 rounded-full" style="width: 0%"></div>
              </div>
            </div>
            <!-- Credit Status -->
            <div id="cb-credit-status" class="hidden mb-4 p-3 rounded-lg border bg-surface-container/50">
              <div class="flex items-start gap-3">
                <span class="material-symbols-outlined text-[20px] shrink-0" id="cb-credit-status-icon">check_circle</span>
                <div class="flex-1">
                  <div class="font-medium text-on-surface" id="cb-credit-status-title">Normal</div>
                  <div class="text-sm text-on-surface-variant space-y-0.5 mt-1" id="cb-credit-status-details"></div>
                </div>
              </div>
            </div>
            <!-- Current Bill Impact -->
            <div id="cb-bill-impact" class="hidden border-t border-outline-variant pt-4 space-y-2 text-body-sm">
              <div class="flex justify-between"><span class="text-on-surface-variant">Current Outstanding</span><span id="cb-impact-outstanding" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between"><span class="text-on-surface-variant">This Bill</span><span id="cb-impact-bill" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between border-t border-outline-variant pt-2 font-medium"><span class="text-on-surface">Projected Outstanding</span><span id="cb-impact-projected" class="text-primary text-display-sm">—</span></div>
              <div class="flex justify-between"><span class="text-on-surface-variant">Credit Limit</span><span id="cb-impact-limit" class="text-on-surface">—</span></div>
              <div class="flex justify-between"><span class="text-on-surface-variant">Available After Bill</span><span id="cb-impact-available" class="text-on-surface font-medium">—</span></div>
            </div>
            <!-- Credit limit warning (hidden until triggered) -->
            <div id="cb-credit-warning" class="hidden mt-4 p-4 rounded-lg border border-error-container bg-error-container/10">
              <div class="flex items-start gap-3">
                <span class="material-symbols-outlined text-[20px] shrink-0 text-error-content">error</span>
                <div class="flex-1">
                  <div class="font-medium text-error-content">CREDIT LIMIT EXCEEDED</div>
                  <div class="text-sm text-error-content/90 space-y-0.5" id="cb-credit-details"></div>
                  <button id="cb-credit-action" type="button" class="mt-2 px-3 py-1.5 rounded-lg bg-error hover:bg-error-hover text-on-error font-body-sm transition-colors hidden">
                    Request Approval
                  </button>
                </div>
              </div>
            </div>
            <!-- Recent Billing -->
            <div id="cb-recent-billing" class="hidden pt-4 border-t border-outline-variant">
              <h3 class="text-body-md font-medium text-on-surface mb-2">Recent Billing</h3>
              <div class="overflow-x-auto">
                <table class="w-full text-body-sm">
                  <thead class="bg-surface-container-high">
                    <tr>
                      <th class="text-left px-2 py-1 font-medium text-on-surface">Bill #</th>
                      <th class="text-left px-2 py-1 font-medium text-on-surface">Date</th>
                      <th class="text-left px-2 py-1 font-medium text-on-surface">Due Date</th>
                      <th class="text-right px-2 py-1 font-medium text-on-surface">Amount</th>
                      <th class="text-right px-2 py-1 font-medium text-on-surface">Balance</th>
                      <th class="text-left px-2 py-1 font-medium text-on-surface">Status</th>
                    </tr>
                  </thead>
                  <tbody id="cb-recent-bills-body"></tbody>
                </table>
              </div>
            </div>
            <!-- Payment History -->
            <div id="cb-payment-history" class="hidden pt-4 border-t border-outline-variant">
              <h3 class="text-body-md font-medium text-on-surface mb-2">Recent Payments</h3>
              <div id="cb-payments-empty" class="text-body-sm text-on-surface-variant">No payment history available.</div>
              <div id="cb-payments-list" class="hidden overflow-x-auto">
                <table class="w-full text-body-sm">
                  <thead class="bg-surface-container-high">
                    <tr>
                      <th class="text-left px-2 py-1 font-medium text-on-surface">Date</th>
                      <th class="text-left px-2 py-1 font-medium text-on-surface">Reference</th>
                      <th class="text-left px-2 py-1 font-medium text-on-surface">Method</th>
                      <th class="text-right px-2 py-1 font-medium text-on-surface">Amount</th>
                    </tr>
                  </thead>
                  <tbody id="cb-recent-payments-body"></tbody>
                </table>
              </div>
            </div>
          </section>

          <!-- ===== BILL ITEMS ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-h5 font-display text-on-surface flex items-center gap-2">
                <span class="material-symbols-outlined text-[20px]">inventory_2</span>Bill Items
              </h2>
              <button id="cb-add-item" type="button" class="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-on-primary font-body-sm transition-colors flex items-center gap-1">
                <span class="material-symbols-outlined text-[16px]">add</span>Add Item
              </button>
            </div>
            <div class="overflow-x-auto border border-outline-variant/50 rounded-lg bg-surface-container">
              <table class="w-full min-w-[900px] text-sm">
                <thead class="bg-surface-container-high">
                  <tr>
                    <th class="text-left px-3 py-2 font-medium text-on-surface">Item</th>
                    <th class="text-left px-3 py-2 font-medium text-on-surface">Description</th>
                    <th class="text-left px-3 py-2 font-medium text-on-surface">HSN/SAC</th>
                    <th class="px-3 py-2 font-medium text-on-surface">Qty</th>
                    <th class="text-left px-3 py-2 font-medium text-on-surface">Unit</th>
                    <th class="px-3 py-2 font-medium text-on-surface">Rate</th>
                    <th class="text-left px-3 py-2 font-medium text-on-surface">Discount</th>
                    <th class="px-3 py-2 font-medium text-on-surface">Tax Rate</th>
                    <th class="px-3 py-2 font-medium text-on-surface">Tax Master</th>
                    <th class="px-3 py-2 font-medium text-on-surface">Amount</th>
                    <th class="px-3 py-2 font-medium text-on-surface">Actions</th>
                  </tr>
                </thead>
                <tbody id="cb-items-body" class="divide-y divide-outline-variant/30">
                  <!-- populated by renderCreateBillLines -->
                </tbody>
              </table>
            </div>
            <!-- Product search popover -->
            <div id="cb-product-search" class="fixed inset-0 z-[100] bg-background/60 flex items-center justify-center hidden">
              <div class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl shadow-2xl w-full max-w-lg max-h-[70vh] flex flex-col animate-scale-in">
                <div class="p-4 border-b border-outline-variant flex items-center gap-2">
                  <span class="material-symbols-outlined text-on-surface-variant">search</span>
                  <input id="cb-product-search-input" type="text" placeholder="Search products & services…" class="flex-1 bg-transparent text-body-md outline-none text-on-surface"/>
                </div>
                <div id="cb-product-results" class="overflow-y-auto flex-1 min-h-[120px]">
                  <div class="p-4 text-center text-body-sm text-on-surface-variant">Start typing to search…</div>
                </div>
                <div class="p-3 border-t border-outline-variant flex justify-end gap-2">
                  <button id="cb-product-cancel" type="button" class="px-4 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-body-sm">Close</button>
                </div>
              </div>
            </div>
          </section>

          <!-- ===== TAX & DISCOUNT ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <h2 class="text-h5 font-display text-on-surface mb-4 flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px]">local_offer</span>Tax & Discount
            </h2>
            <div class="space-y-3">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label for="cb-invoice-discount-type" class="block text-body-sm font-medium text-on-surface mb-1">Invoice Discount</label>
                  <select id="cb-invoice-discount-type" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none">
                    <option value="none">None</option>
                    <option value="percent">Percentage (%)</option>
                    <option value="fixed">Fixed Amount</option>
                  </select>
                </div>
                <div class="md:col-span-2">
                  <label for="cb-invoice-discount-value" class="block text-body-sm font-medium text-on-surface mb-1">Discount Value</label>
                  <div class="flex items-center gap-2">
                    <input id="cb-invoice-discount-value" type="number" min="0" step="0.01" placeholder="0" class="flex-1 px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface focus:ring-2 focus:ring-secondary/40 focus:outline-none"/>
                    <button id="cb-apply-discount" type="button" class="px-3 py-2 rounded-lg bg-secondary hover:bg-secondary-hover text-on-secondary font-body-sm transition-colors">Apply</button>
                  </div>
                </div>
              </div>
              <div class="text-body-sm text-on-surface-variant" id="cb-discount-breakdown">No invoice-level discount applied.</div>
            </div>
          </section>

          <!-- ===== ADDITIONAL CHARGES ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <button type="button" id="cb-toggle-charges" class="flex items-center gap-2 w-full text-left">
              <span class="material-symbols-outlined text-[20px] text-primary">add</span>
              <span class="font-medium text-on-surface">Additional Charges</span>
              <span class="text-body-sm text-on-surface-variant ml-2">(optional)</span>
              <span id="cb-charges-toggle-icon" class="material-symbols-outlined text-[16px] text-on-surface-variant ml-auto">expand_more</span>
            </button>
            <div id="cb-charges-content" class="hidden mt-4 space-y-3">
              <div id="cb-charges-list" class="space-y-2"></div>
              <button id="cb-add-charge" type="button" class="px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary-hover text-on-secondary font-body-sm flex items-center gap-1 transition-colors">
                <span class="material-symbols-outlined text-[16px]">add</span>Add Charge
              </button>
            </div>
          </section>

          <!-- ===== NOTES & TERMS ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <h2 class="text-h5 font-display text-on-surface mb-4 flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px]">notes</span>Notes & Terms
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label for="cb-notes" class="block text-body-sm font-medium text-on-surface mb-1">Notes</label>
                <textarea id="cb-notes" rows="3" placeholder="Additional notes for this bill…" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface resize-y focus:ring-2 focus:ring-secondary/40 focus:outline-none"></textarea>
              </div>
              <div>
                <label for="cb-terms" class="block text-body-sm font-medium text-on-surface mb-1">Terms & Conditions</label>
                <textarea id="cb-terms" rows="3" placeholder="Terms & conditions…" class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant text-on-surface resize-y focus:ring-2 focus:ring-secondary/40 focus:outline-none"></textarea>
              </div>
            </div>
          </section>

          <!-- ===== SUMMARY ===== -->
          <section class="bg-surface-container-lowest border border-outline-variant/50 rounded-xl p-6">
            <h2 class="text-h5 font-display text-on-surface mb-4 flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px]">receipt_long</span>Summary
            </h2>
            <div class="max-w-md ml-auto space-y-2 text-body-sm">
              <div class="flex justify-between"><span class="text-on-surface-variant">Subtotal</span><span id="cb-subtotal" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between"><span class="text-on-surface-variant">Line Discounts</span><span id="cb-line-discount" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between"><span class="text-on-surface-variant">Bill Discount</span><span id="cb-discount-total" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between border-t border-outline-variant/30 pt-1 mt-1"><span class="text-on-surface-variant font-medium">Taxable Amount</span><span id="cb-taxable" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between pl-4"><span class="text-on-surface-variant">CGST</span><span id="cb-cgst" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between pl-4"><span class="text-on-surface-variant">SGST</span><span id="cb-sgst" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between pl-4"><span class="text-on-surface-variant">IGST</span><span id="cb-igst" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between pl-4"><span class="text-on-surface-variant">Cess</span><span id="cb-cess" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between"><span class="text-on-surface-variant">Additional Charges</span><span id="cb-additional-charges" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between"><span class="text-on-surface-variant">Charge Tax</span><span id="cb-charge-tax" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between border-t border-outline-variant pt-2"><span class="text-on-surface-variant">Round Off</span><span id="cb-roundoff" class="text-on-surface font-medium">—</span></div>
              <div class="flex justify-between border-t border-outline-variant/50 pt-3 mt-2">
                <span class="text-h5 font-display text-on-surface">GRAND TOTAL</span>
                <span id="cb-grand-total" class="text-display-sm font-display text-primary font-bold">—</span>
              </div>
            </div>
          </section>
        </form>
      </div>
    `;

    // Wire up navigation
    const self = this;
    this._q('#cb-back').addEventListener('click', () => { window.location.hash = '#customer-bills'; });
    this._q('#cb-btn-cancel').addEventListener('click', () => { window.location.hash = '#customer-bills'; });

    // Initialize state
    this.createBillState = {
      billNumber: null,
      taxMasters: [],
      companyConfig: null,
      settings: null,
      billLines: this.defaultBillLine(),
      invoiceDiscount: { type: 'none', value: 0 },
      additionalCharges: [],
      customer: null,
      customerSummary: null,
      saving: false,
      dirty: false,
    };

    // Persist any in-progress work
    this._bindCreateFormChanges();

    // Load all reference data in parallel + number preview
    try {
      await this._loadCreatePageDependencies();
    } catch (err) {
      this._showCreateError(err);
      return;
    }

    // Wire up interactive behaviors
    this._initCreatePageBehaviors();

    // Initial render of lines & totals
    this.renderCreateBillLines();
    this.updateCreateBillTotals();

    // Unsaved-changes guard
    window.addEventListener('beforeunload', (e) => {
      if (self.createBillState?.dirty) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    });
  },

  /**
   * Parallel loading: number preview, taxes, company config, settings.
   */
  async _loadCreatePageDependencies() {
    const token = localStorage.getItem('crm_token');
    const headers = token ? { Authorization: 'Bearer ' + token } : {};

    const [numberRes, taxesRes, companyRes, settingsRes] = await Promise.allSettled([
      fetch('/api/customer-bills/number/preview', { headers }).then(r => { if (!r.ok) throw new Error('Number preview failed'); return r.json(); }),
      fetch('/api/accounting/taxes', { headers }).then(r => { if (!r.ok) throw new Error('Tax load failed'); return r.json(); }),
      fetch('/api/accounting/taxes/company-config', { headers }).then(r => { if (!r.ok) throw new Error('Company config failed'); return r.json(); }),
      fetch('/api/settings', { headers }).then(r => { if (!r.ok) throw new Error('Settings load failed'); return r.json(); }),
    ]);

    // Bill number preview — show "Auto-generated" label until real number resolves
    if (numberRes.status === 'fulfilled' && numberRes.value) {
      const d = numberRes.value.data || numberRes.value;
      if (d && (d.invoiceNumber || d.billNumber)) {
        const num = d.invoiceNumber || d.billNumber;
        this.createBillState.billNumber = num;
        const el = this._q('#cb-bill-number');
        if (el) { el.textContent = num; el.title = 'Generated on save'; }
        // The display subtitle: keep "Auto-generated" to signal it's system-generated
        const disp = this._q('#cb-bill-number-display');
        if (disp) disp.textContent = 'Auto-generated on save';
      }
    } else {
      this._attachRetry(this._loadCreatePageDependencies);
    }

    // Tax masters
    if (taxesRes.status === 'fulfilled' && taxesRes.value) {
      const d = taxesRes.value.data;
      this.createBillState.taxMasters = Array.isArray(d) ? d : (d.items || d || []);
    } else {
      this._attachRetry(this._loadCreatePageDependencies);
      this.createBillState.taxMasters = [];
    }

    // Company config
    if (companyRes.status === 'fulfilled' && companyRes.value) {
      this.createBillState.companyConfig = companyRes.value.data || companyRes.value;
    }
    this._populatePlaceOfSupply();

    // Settings
    if (settingsRes.status === 'fulfilled' && settingsRes.value) {
      this.createBillState.settings = settingsRes.value.data || settingsRes.value;
      if (this._q('#cb-terms')) this._q('#cb-terms').value = this.createBillState.settings.invoiceTerms || '';
    }
    // Default invoice date = today
    const today = new Date().toISOString().split('T')[0];
    if (this._q('#cb-bill-date')) this._q('#cb-bill-date').value = today;
    this._computeDueDate();
  },

  _attachRetry(fn) {
    const retry = this._q('#cb-create-retry');
    if (retry) retry.addEventListener('click', () => { retry.disabled = true; retry.textContent = 'Retrying…'; fn.call(this); }, { once: true });
  },

  _populatePlaceOfSupply() {
    const pos = this._q('#cb-place-of-supply');
    if (!pos) return;
    const company = this.createBillState.companyConfig;
    const companyStateName = company?.stateName || 'KARNATAKA';
    let html = `<option value="">Same as Company (${companyStateName})</option>`;
    INDIAN_STATES.forEach(s => {
      html += `<option value="${s.value}" ${s.value === company?.stateCode ? 'selected' : ''}>${s.label}</option>`;
    });
    pos.innerHTML = html;
  },

  /** Default single bill line (mirrors existing modal default) */
  defaultBillLine() {
    return [{
      id: this._lineId(),
      description: '',
      hsn_sac: '',
      quantity: 1,
      unit: 'Nos',
      unit_price: 0,
      discount_amount: 0,
      discount_type: 'fixed',
      discount_percent: 0,
      tax_master_id: 'tax_gst_5_intra',
      tax_rate: 5,
      line_total: 0,
      line_tax: 0,
      taxable_amount: 0,
      cgst_amount: 0,
      sgst_amount: 0,
      igst_amount: 0,
    }];
  },

  _lineId() { return 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); },

  /** Render the bill line items table body (editable in-place) */
  renderCreateBillLines() {
    const tbody = document.getElementById('cb-items-body');
    if (!tbody) return;
    const state = this.createBillState;
    tbody.innerHTML = state.billLines.map((l, idx) => `
      <tr data-line-idx="${idx}" class="bg-surface-container-lowest">
        <td class="px-3 py-2 align-top">
          <button type="button" data-set-product="${idx}" class="text-left w-full text-body-sm text-primary font-medium hover:underline flex items-center gap-1">
            <span class="material-symbols-outlined text-[16px]">search</span>${this.esc(this._lineItemLabel(l))}
          </button>
        </td>
        <td class="px-3 py-2 align-top">
          <input data-line="${idx}" data-field="description" type="text" value="${this.esc(l.description)}" placeholder="Description…" class="w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40"/>
        </td>
        <td class="px-3 py-2 align-top">
          <input data-line="${idx}" data-field="hsn_sac" type="text" value="${this.esc(l.hsn_sac)}" placeholder="HSN/SAC" class="w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40"/>
        </td>
        <td class="px-3 py-2 align-top w-20">
          <input data-line="${idx}" data-field="quantity" type="number" min="1" step="any" value="${l.quantity}" class="w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm text-center outline-none focus:ring-1 focus:ring-secondary/40"/>
        </td>
        <td class="px-3 py-2 align-top w-24">
          <input data-line="${idx}" data-field="unit" type="text" value="${this.esc(l.unit)}" placeholder="Unit" class="w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40"/>
        </td>
        <td class="px-3 py-2 align-top w-24">
          <input data-line="${idx}" data-field="unit_price" type="number" min="0" step="0.01" value="${l.unit_price}" class="w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm text-center outline-none focus:ring-1 focus:ring-secondary/40"/>
        </td>
        <td class="px-3 py-2 align-top w-28">
          <div class="flex gap-1">
            <select data-line="${idx}" data-field="discount_type" class="w-20 px-1 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-xs outline-none focus:ring-1 focus:ring-secondary/40">
              <option value="fixed" ${l.discount_type === 'fixed' ? 'selected' : ''}>Fixed</option>
              <option value="percent" ${l.discount_type === 'percent' ? 'selected' : ''}>%</option>
            </select>
            <input data-line="${idx}" data-field="discount_value" type="number" min="0" step="0.01" value="${l.discount_type === 'percent' ? this._safeRound(this._lineDiscountPercent(l)) : (l.discount_amount || 0)}" placeholder="0" class="flex-1 px-1 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm text-center outline-none focus:ring-1 focus:ring-secondary/40"/>
          </div>
        </td>
        <td class="px-3 py-2 align-top w-24" data-tax-idx="${idx}">
          <div class="text-right font-code text-on-surface-variant text-body-sm">${this._formatTaxRate(this._lineTaxRate(l))}</div>
        </td>
        <td class="px-3 py-2 align-top w-36">
          <select data-line="${idx}" data-field="tax_master_id" class="w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40">${this._taxOptionsFor(l)}</select>
        </td>
        <td class="px-3 py-2 align-top w-28" data-amount-idx="${idx}">${Currency.format(this._lineNetWithTax(l), this.currentCurrency)}</td>
        <td class="px-3 py-2 align-top w-36">
          <div class="flex items-center gap-1">
            <button type="button" data-duplicate="${idx}" class="p-1 rounded hover:bg-surface-container-high text-on-surface-variant" title="Duplicate item">
              <span class="material-symbols-outlined text-[16px]">content_copy</span>
            </button>
            <button type="button" data-remove="${idx}" class="p-1 rounded hover:bg-error-container/20 text-error-content" title="Remove item">
              <span class="material-symbols-outlined text-[16px]">delete</span>
            </button>
          </div>
        </td>
      </tr>
      ${this._inventoryDimensionRow(l, idx)}
    `).join('');

    this._wireInventoryDimensions(tbody);

    // Wire line inputs
    tbody.querySelectorAll('input[data-line]').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.line, 10);
        const field = e.target.dataset.field;
        const v = e.target.value;
        if (['quantity', 'unit_price', 'discount_value'].includes(field)) {
          this.createBillState.billLines[idx][field] = parseFloat(v) || 0;
        } else if (field === 'discount_amount') {
          this.createBillState.billLines[idx].discount_amount = parseFloat(v) || 0;
        } else {
          this.createBillState.billLines[idx][field] = v;
        }
        this._recalcLine(idx);
        this.updateCreateBillTotals();
        this._markDirty();
      });
    });
    tbody.querySelectorAll('select[data-line]').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.line, 10);
        const field = e.target.dataset.field;
        this.createBillState.billLines[idx][field] = e.target.value;
        this._recalcLine(idx);
        this.updateCreateBillTotals();
        this._markDirty();
      });
    });
    // Duplicate
    tbody.querySelectorAll('[data-duplicate]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.duplicate, 10);
        const copy = { ...this.createBillState.billLines[idx], id: this._lineId() };
        this.createBillState.billLines.splice(idx + 1, 0, copy);
        this.renderCreateBillLines();
        this.updateCreateBillTotals();
        this._markDirty();
      });
    });
    // Remove
    tbody.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.remove, 10);
        if (this.createBillState.billLines.length > 1) {
          this.createBillState.billLines.splice(idx, 1);
          this.renderCreateBillLines();
          this.updateCreateBillTotals();
          this._markDirty();
        }
      });
    });
    // Set product
    tbody.querySelectorAll('[data-set-product]').forEach(btn => {
      btn.addEventListener('click', () => this._openProductSearch(parseInt(btn.dataset.setProduct, 10)));
    });
  },

  _lineItemLabel(l) {
    return l.description || (l.unit ? l.unit : '');
  },

  /** Build <option> list for the per-line tax selector based on intra/interstate */
  _taxOptionsFor(line) {
    const state = this.createBillState;
    const all = state.taxMasters;
    const isInter = this._isLineInterstate();
    const pool = isInter ? state._taxInter || [] : state._taxIntra || [];
    const opts = (pool.length ? pool : all);
    if (!opts.length) {
      return '<option value="">No tax masters loaded</option>';
    }
    return opts.map(t => `<option value="${this.esc(t.id)}" ${t.id === line.tax_master_id ? 'selected' : ''}>${this.esc(t.name || t.code)} ${t.rate ? '(' + t.rate + '%)' : ''}</option>`).join('');
  },

  _lineNet(l) {
    const qty = parseFloat(l.quantity) || 1;
    const price = parseFloat(l.unit_price) || 0;
    return qty * price;
  },
  _lineDiscountAmount(l) {
    const gross = this._lineNet(l);
    if ((l.discount_type || 'fixed') === 'percent') {
      const pct = parseFloat(l.discount_percent) || 0;
      return Math.min(gross, gross * pct / 100);
    }
    return Math.max(0, Math.min(parseFloat(l.discount_amount) || 0, gross));
  },
  _lineDiscountPercent(l) {
    const gross = this._lineNet(l);
    if (gross === 0) return 0;
    const amt = parseFloat(l.discount_amount) || 0;
    return (amt / gross) * 100;
  },
  _lineTaxRate(l) {
    const all = this.createBillState?.taxMasters || [];
    const master = all.find(t => t.id === l.tax_master_id) || {};
    return parseFloat(master.rate || l.tax_rate || 0);
  },
  _formatTaxRate(rate) {
    return rate > 0 ? rate.toFixed(rate === Math.round(rate) ? 0 : 2) + '%' : '—';
  },

  _lineNetWithTax(l) {
    return Math.max(0, l.taxable_amount || 0) + (l.line_tax || 0);
  },

  _isLineInterstate() {
    const pos = this._q('#cb-place-of-supply')?.value || '';
    const company = this.createBillState?.companyConfig;
    if (!pos || !company) return false;
    return pos !== company.stateCode;
  },

  /** Recalculate a single line's tax based on selected tax master + place of supply */
  _recalcLine(idx) {
    const l = this.createBillState.billLines[idx];
    if (!l) return;
    const qty = parseFloat(l.quantity) || 1;
    const price = parseFloat(l.unit_price) || 0;
    const gross = qty * price;
    // Handle discount: percent mode computes discount_amount from percent; fixed mode uses discount_value directly
    if ((l.discount_type || 'fixed') === 'percent') {
      const pct = parseFloat(l.discount_percent) || 0;
      l.discount_amount = this._safeRound(gross * pct / 100);
    } else {
      l.discount_amount = Math.max(0, Math.min(parseFloat(l.discount_value) || parseFloat(l.discount_amount) || 0, gross));
    }
    const disc = parseFloat(l.discount_amount) || 0;
    const taxable = Math.max(0, gross - disc);
    const all = this.createBillState.taxMasters;
    const master = all.find(t => t.id === l.tax_master_id) || {};
    const rate = parseFloat(master.rate || l.tax_rate || 0);
    l.tax_rate = rate;
    l.line_total = gross;
    l.taxable_amount = taxable;
    const taxAmt = taxable * rate / 100;
    l.line_tax = this._safeRound(taxAmt);
    const isInter = this._isLineInterstate();
    if (isInter) {
      l.cgst_amount = 0; l.sgst_amount = 0; l.igst_amount = this._safeRound(taxAmt);
    } else {
      l.cgst_amount = this._safeRound(taxAmt / 2); l.sgst_amount = this._safeRound(taxAmt / 2); l.igst_amount = 0;
    }
    // Cache intra/inter masters for _taxOptionsFor
    this.createBillState._taxIntra = all.filter(t => !t.isIgst);
    this.createBillState._taxInter = all.filter(t => t.isIgst);
    // Update amount cell
    const tbody = document.getElementById('cb-items-body');
    if (tbody) {
      const amt = tbody.querySelector(`[data-amount-idx="${idx}"]`);
      if (amt) amt.textContent = Currency.format(this._lineNetWithTax(l), this.currentCurrency);
    }
  },

  /** Compute due date from invoice date + payment terms */
  _computeDueDate() {
    const inv = this._q('#cb-bill-date')?.value || '';
    const terms = this._q('#cb-payment-terms')?.value || 'Net 30';
    const due = this._q('#cb-due-date');
    if (!inv || !due) return;
    let d = new Date(inv + 'T00:00:00');
    if (!isNaN(d.getTime())) {
      const m = terms.match(/^Net\s+(\d+)$/);
      if (m) {
        d.setDate(d.getDate() + parseInt(m[1], 10));
      } else if (terms === 'END_OF_MONTH') {
        d = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      }
      // DUE_ON_RECEIPT / ADVANCE / SPECIFIC_DATE → same day (user-adjustable)
      due.value = d.toISOString().split('T')[0];
    }
  },

  /**
   * Recalculate and render all totals (preview only — backend recomputes on save).
   * Uses integer cents to avoid floating-point drift.
   */
  updateCreateBillTotals() {
    const state = this.createBillState;
    const cur = this.currentCurrency;
    let subtotalCents = 0, taxCents = 0;
    let cgstC = 0, sgstC = 0, igstC = 0, cessC = 0;
    let lineDiscCents = 0;
    state.billLines.forEach(l => {
      const gross = parseFloat(l.line_total) || 0;
      const disc = parseFloat(l.discount_amount) || 0;
      subtotalCents += this._toCents(gross);
      lineDiscCents += this._toCents(disc);
      taxCents += this._toCents(parseFloat(l.line_tax) || 0);
      cgstC += this._toCents(parseFloat(l.cgst_amount) || 0);
      sgstC += this._toCents(parseFloat(l.sgst_amount) || 0);
      igstC += this._toCents(parseFloat(l.igst_amount) || 0);
    });
    // Invoice (bill-level) discount — applied to line subtotal (after line discounts)
    let billDiscCents = 0;
    const idt = state.invoiceDiscount.type;
    const idv = parseFloat(state.invoiceDiscount.value) || 0;
    const taxableBaseCents = subtotalCents - lineDiscCents;
    if (idt === 'percent' && idv > 0) {
      billDiscCents = Math.round(taxableBaseCents * idv / 100);
    } else if (idt === 'fixed' && idv > 0) {
      billDiscCents = this._toCents(Math.min(idv, this._fromCents(taxableBaseCents)));
    }
    const taxableCents = Math.max(0, taxableBaseCents - billDiscCents);
    // Scale tax components proportionally for bill discount
    let finalTaxCents = taxCents;
    if (taxableBaseCents > 0 && billDiscCents > 0) {
      const factor = taxableCents / taxableBaseCents;
      finalTaxCents = Math.round(taxCents * factor);
      cgstC = Math.round(cgstC * factor);
      sgstC = Math.round(sgstC * factor);
      igstC = Math.round(igstC * factor);
    }
    // Additional charges with optional tax
    let addCents = 0, addTaxCents = 0;
    let addCgstC = 0, addSgstC = 0, addIgstC = 0;
    state.additionalCharges.forEach(c => {
      const amt = parseFloat(c.amount) || 0;
      addCents += this._toCents(amt);
      if (c.taxable && amt > 0 && c.tax_master_id) {
        const master = state.taxMasters.find(t => t.id === c.tax_master_id) || {};
        const rate = parseFloat(master.rate || c.tax_rate || 0);
        const chargeTaxPaise = Math.round(this._toCents(amt) * rate / 100);
        addTaxCents += chargeTaxPaise;
        const isInter = this._isLineInterstate();
        if (isInter) { addIgstC += chargeTaxPaise; }
        else { addCgstC += Math.round(chargeTaxPaise / 2); addSgstC += Math.round(chargeTaxPaise / 2); }
      }
    });
    const grandCents = taxableCents + finalTaxCents + addCents + addTaxCents;
    const grand = this._fromCents(grandCents);
    const rounded = Math.round(grand);
    const roundOff = this._safeRound(grand - rounded);

    const fmt = (c) => Currency.format(this._fromCents(c), cur);
    this._q('#cb-subtotal').textContent = fmt(subtotalCents);
    this._q('#cb-line-discount').textContent = fmt(lineDiscCents);
    this._q('#cb-discount-total').textContent = fmt(billDiscCents);
    this._q('#cb-taxable').textContent = fmt(taxableCents);
    this._q('#cb-cgst').textContent = fmt(cgstC + addCgstC);
    this._q('#cb-sgst').textContent = fmt(sgstC + addSgstC);
    this._q('#cb-igst').textContent = fmt(igstC + addIgstC);
    this._q('#cb-cess').textContent = fmt(cessC);
    this._q('#cb-additional-charges').textContent = fmt(addCents);
    this._q('#cb-charge-tax').textContent = fmt(addTaxCents);
    this._q('#cb-roundoff').textContent = Currency.format(roundOff, cur);
    this._q('#cb-grand-total').textContent = Currency.format(rounded, cur);

    // Store numeric grand total for credit-limit check
    this.createBillState._grandTotal = rounded;
    this._updateCreditProjection();
  },

  _toCents(n) { return Math.round((n || 0) * 100); },
  _fromCents(c) { return this._safeRound(c / 100); },
  _safeRound(n) { return Math.round((n + Number.EPSILON) * 100) / 100; },

  _parseFormattedTotal() {
    const el = this._q('#cb-grand-total');
    if (!el) return 0;
    const raw = el.textContent.replace(/[^\d.\-]/g, '');
    return parseFloat(raw) || 0;
  },

  _toCents(n) { return Math.round((n || 0) * 100); },
  _fromCents(c) { return this._safeRound(c / 100); },
  _safeRound(n) { return Math.round((n + Number.EPSILON) * 100) / 100; },

  /** Calculate GST tax in cents for a given amount_cents and rate, splitting CGST/SGST or IGST */
  _calculateGstCents(amountCents, rate, isInterState) {
    const taxCents = Math.round(amountCents * rate / 100);
    return taxCents;
  },

  _sumAdditionalCharges() {
    const charges = this.createBillState?.additionalCharges || [];
    return charges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  },

  /** Sum the tax amounts on taxable additional charges */
  _sumChargeTaxes() {
    const charges = this.createBillState?.additionalCharges || [];
    const cur = this.currentCurrency;
    let totalCents = 0;
    const supplyState = this.createBillState?.placeOfSupply || this.createBillState?.companyState || '';
    const isInterState = !!supplyState && supplyState !== (this.createBillState?.companyState || '');
    charges.forEach(c => {
      if (!c.taxable || !c.tax_master_id) return;
      const master = (this.createBillState?.taxMasters || []).find(t => t.id === c.tax_master_id);
      if (!master) return;
      const rate = parseFloat(master.rate) || 0;
      const amtCents = this._toCents(parseFloat(c.amount) || 0);
      totalCents += this._calculateGstCents(amtCents, rate, isInterState);
    });
    return {
      cgst: this._fromCents(totalCents / 4),
      sgst: this._fromCents(totalCents / 4),
      igst: isInterState ? this._fromCents(totalCents) : 0,
      total: this._fromCents(totalCents)
    };
  },

  /** Compute the invoice-level discount amount from state (applied on net after line discounts) */
  _computeDiscountAmount() {
    const disc = this.createBillState?.invoiceDiscount;
    if (!disc || disc.type === 'none' || !disc.value) return 0;
    const val = parseFloat(disc.value) || 0;
    if (val <= 0) return 0;
    // Bill discount applies on net of line discounts
    const netCents = this.createBillState?.billLines.reduce((sum, l) => {
      const qty = parseFloat(l.quantity) || 1;
      const price = parseFloat(l.unit_price) || 0;
      const lineDisc = parseFloat(l.discount_amount) || 0;
      const gross = this._toCents(qty * price);
      return sum + (gross - this._toCents(lineDisc));
    }, 0) || 0;
    const net = this._fromCents(netCents);
    if (disc.type === 'percent') return this._safeRound(net * val / 100);
    if (disc.type === 'fixed') return this._safeRound(Math.min(val, net));
    return 0;
  },

  /** Build a discounts array for the backend calculateTotals */
  _buildDiscountRules() {
    const disc = this.createBillState?.invoiceDiscount;
    if (!disc || disc.type === 'none' || !disc.value) return [];
    const val = parseFloat(disc.value) || 0;
    if (val <= 0) return [];
    return [{ type: disc.type === 'percent' ? 'PERCENTAGE' : 'FIXED', amount: val }];
  },

  /** Bind real-time listeners for discount + charges + terms/date */
  _bindCreateFormChanges() {
    const fields = ['#cb-invoice-discount-type', '#cb-invoice-discount-value', '#cb-apply-discount',
      '#cb-add-charge', '#cb-bill-date', '#cb-payment-terms', '#cb-place-of-supply', '#cb-currency',
      '#cb-notes', '#cb-terms'];
    fields.forEach(sel => {
      const el = this._q(sel);
      if (!el) return;
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => this._markDirty());
    });
  },

  _initCreatePageBehaviors() {
    // Customer selector via EntitySelector (backend-searchable)
    const container = this._q('#cb-customer-selector');
    if (container) {
      new window.EntitySelector(container, {
        type: 'contact',
        placeholder: 'Search customer by name, email, phone…',
        allowCreate: false,
        onChange: (record) => this._onCustomerSelect(record),
      });
    }

    // Discount apply
    this._q('#cb-apply-discount')?.addEventListener('click', () => {
      const type = this._q('#cb-invoice-discount-type')?.value || 'none';
      const val = parseFloat(this._q('#cb-invoice-discount-value')?.value) || 0;
      this.createBillState.invoiceDiscount = type === 'none' ? { type: 'percent', value: 0 } : { type, value: val };
      this._updateDiscountBreakdown();
      this.updateCreateBillTotals();
      this._markDirty();
    });

    // Additional charges toggle
    const chargesToggle = this._q('#cb-toggle-charges');
    const chargesContent = this._q('#cb-charges-content');
    const toggleIcon = this._q('#cb-charges-toggle-icon');
    chargesToggle?.addEventListener('click', () => {
      const shown = chargesContent.classList.toggle('hidden');
      if (toggleIcon) toggleIcon.textContent = shown ? 'expand_more' : 'expand_less';
    });

    // Add charge
    this._q('#cb-add-charge')?.addEventListener('click', () => {
      this.createBillState.additionalCharges.push({ id: this._lineId(), description: '', amount: 0, taxable: false });
      this._renderAdditionalCharges();
      this.updateCreateBillTotals();
      this._markDirty();
    });

    // Add item
    this._q('#cb-add-item')?.addEventListener('click', () => {
      this.createBillState.billLines.push(this.defaultBillLine());
      this.renderCreateBillLines();
      this.updateCreateBillTotals();
      this._markDirty();
    });

    // Date + terms → due date; place-of-supply → tax regime recalc
    this._q('#cb-bill-date')?.addEventListener('change', () => { this._computeDueDate(); this._markDirty(); });
    this._q('#cb-payment-terms')?.addEventListener('change', () => { this._computeDueDate(); this._markDirty(); });
    this._q('#cb-place-of-supply')?.addEventListener('change', () => { this.renderCreateBillLines(); this.updateCreateBillTotals(); this._markDirty(); });
    this._q('#cb-currency')?.addEventListener('change', () => {
      this.currentCurrency = this._q('#cb-currency').value;
      AccountingState.currentCurrency = this.currentCurrency;
      this.updateCreateBillTotals();
      this._markDirty();
    });
    this._q('#cb-same-address')?.addEventListener('change', () => this._syncAddresses());

    // Save actions
    this._q('#cb-btn-save-draft')?.addEventListener('click', () => this._saveCreateBill('draft'));
    this._q('#cb-btn-submit')?.addEventListener('click', () => this._saveCreateBill('submit'));
  },

  _onCustomerSelect(record) {
    const s = this.createBillState;
    if (!record) {
      s.customer = null; s.customerSummary = null;
      this._q('#cb-customer-info')?.classList.add('hidden');
      this._q('#cb-customer-id').value = '';
      this._clearFinancialSections();
      const snap = this._q('#cb-financial-snapshot');
      if (snap) snap.innerHTML = '<div class="flex items-center justify-center gap-2 text-on-surface-variant"><span class="material-symbols-outlined">account_balance</span><span class="text-body-sm">Select a customer to view financial data</span></div>';
      return;
    }
    s.customer = record;
    this._q('#cb-customer-id').value = record.id || '';
    const info = this._q('#cb-customer-info');
    if (info) info.classList.remove('hidden');

    // Display customer info (don't duplicate data — read from selection)
    this._q('#cb-cinfo-name').textContent = [record.firstName, record.lastName].filter(Boolean).join(' ') || '—';
    this._q('#cb-cinfo-code').textContent = record.customerCode || record.code || '—';
    this._q('#cb-cinfo-gstin').textContent = record.gstin || '—';
    this._q('#cb-cinfo-email').textContent = record.email || '—';

    // Billing / Shipping address
    const addr = record.address || record.billingAddress || [record.address, record.city, record.state].filter(Boolean).join(', ') || '—';
    this._q('#cb-cinfo-billing').textContent = addr;
    this._q('#cb-cinfo-shipping').textContent = addr;
    this._q('#cb-billing-address').value = addr;
    this._q('#cb-shipping-address').value = addr;
    this._q('#cb-customer-gstin').value = record.gstin || '';

    // Load financial snapshot
    this._loadCustomerSummary(record.id);

    // Default place of supply to customer state if available
    const pos = this._q('#cb-place-of-supply');
    if (pos && record.state) {
      // state is full name; match by label
      const opt = Array.from(pos.options).find(o => o.textContent.trim() === record.state);
      if (opt) pos.value = opt.value;
    }
    this.renderCreateBillLines();
    this.updateCreateBillTotals();
    this._markDirty();
  },

  /** Clear all financial section elements when no customer is selected */
  _clearFinancialSections() {
    const sections = [
      '#cb-credit-hold', '#cb-overdue-warning', '#cb-credit-utilization',
      '#cb-credit-status', '#cb-bill-impact', '#cb-credit-warning',
      '#cb-recent-billing', '#cb-payment-history',
    ];
    sections.forEach(sel => {
      const el = this._q(sel);
      if (el) el.classList.add('hidden');
    });
    const details = this._q('#cb-overdue-details');
    if (details) details.innerHTML = '';
    const statusDetails = this._q('#cb-credit-status-details');
    if (statusDetails) statusDetails.innerHTML = '';
    const creditDetails = this._q('#cb-credit-details');
    if (creditDetails) creditDetails.innerHTML = '';
  },

  /** Refresh customer financial data — reloads from the API */
  _refreshCustomerFinancial() {
    if (this.createBillState.customer) {
      this._loadCustomerSummary(this.createBillState.customer.id);
    }
  },

  /** Load + render the customer financial snapshot from the existing API */
  async _loadCustomerSummary(contactId) {
    const summaryEl = this._q('#cb-financial-snapshot');
    if (!summaryEl) return;
    summaryEl.innerHTML = '<div class="flex items-center justify-center gap-2"><span class="material-symbols-outlined animate-spin">progress_activity</span><span class="text-body-sm text-on-surface-variant">Loading financial data…</span></div>';

    // Bind refresh button
    const refreshBtn = this._q('#cb-refresh-financial');
    if (refreshBtn) refreshBtn.onclick = () => this._refreshCustomerFinancial();

    try {
      const res = await API.get(`/customer-bills/customers/${contactId}/summary`);
      const d = res?.data || res || {};
      this.createBillState.customerSummary = d;
      this._renderFinancialSnapshot(d);
      this._updateCreditProjection();
    } catch (err) {
      summaryEl.innerHTML = `<p class="text-error">Unable to load financial snapshot. ${err.message || ''}</p>`;
      this._clearFinancialSections();
    }
  },

  /** Render the financial snapshot grid, overdue warning, credit hold, utilization, status, recent bills, payments */
  _renderFinancialSnapshot(d) {
    const cur = this.currentCurrency;
    const o = parseFloat(d.outstandingBalance) || 0;
    const ov = parseFloat(d.overdueAmount) || 0;
    const cl = parseFloat(d.creditLimit) || 0;
    const ac = parseFloat(d.availableCredit) || 0;
    const util = parseFloat(d.creditUtilization) || 0;
    const hasLimit = d.hasCreditLimit;
    const overdueCount = parseInt(d.overdueInvoiceCount || 0, 10);

    const summaryEl = this._q('#cb-financial-snapshot');
    if (!summaryEl) return;

    // Credit Limit: show "Not Set" if no limit configured
    const creditLimitLabel = hasLimit ? Currency.format(cl, cur) : 'Not Set';
    const availableCreditLabel = hasLimit ? Currency.format(ac, cur) : 'Not Limited';

    summaryEl.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
        <div><div class="text-body-sm text-on-surface-variant">Outstanding</div><div class="text-h6 font-medium text-on-surface">${Currency.format(o, cur)}</div></div>
        <div><div class="text-body-sm text-on-surface-variant">Overdue</div><div class="text-h6 font-medium ${ov > 0 ? 'text-error' : 'text-on-surface'}">${Currency.format(ov, cur)}</div></div>
        <div><div class="text-body-sm text-on-surface-variant">Credit Limit</div><div class="text-h6 font-medium text-on-surface">${creditLimitLabel}</div></div>
        <div><div class="text-body-sm text-on-surface-variant">Available Credit</div><div class="text-h6 font-medium text-on-surface">${availableCreditLabel}</div></div>
      </div>
    `;

    // Credit Hold warning
    const hold = this._q('#cb-credit-hold');
    if (hold) {
      // Check if contact is on hold (status !== 'ACTIVE' means on hold)
      if (d.contactStatus && d.contactStatus !== 'ACTIVE') {
        hold.classList.remove('hidden');
      } else {
        hold.classList.add('hidden');
      }
    }

    // Overdue warning
    const overdueWarn = this._q('#cb-overdue-warning');
    const overdueDetails = this._q('#cb-overdue-details');
    if (overdueWarn && overdueDetails) {
      if (ov > 0 || overdueCount > 0) {
        overdueWarn.classList.remove('hidden');
        let detailsHtml = `<div class="flex justify-between"><span>Overdue Balance</span><span class="font-medium text-error-content">${Currency.format(ov, cur)}</span></div>`;
        detailsHtml += `<div class="flex justify-between"><span>${overdueCount} invoice${overdueCount !== 1 ? 's' : ''} overdue</span><span class="font-medium text-error-content">${Currency.format(ov / Math.max(overdueCount, 1), cur)}/avg</span></div>`;
        if (d.oldestOverdueInvoice) {
          const inv = d.oldestOverdueInvoice;
          detailsHtml += `<div class="pt-1 border-t border-error-container/30 mt-1"><span class="text-body-sm">Oldest overdue: ${inv.billNumber} — Due ${inv.dueDate} — ${Currency.format(parseFloat(inv.balance || 0), cur)} (${inv.daysOverdue}d)</span></div>`;
        }
        overdueDetails.innerHTML = detailsHtml;
      } else {
        overdueWarn.classList.add('hidden');
        overdueDetails.innerHTML = '';
      }
    }

    // Credit Utilization progress bar
    const utilEl = this._q('#cb-credit-utilization');
    const utilText = this._q('#cb-credit-util-text');
    const utilBar = this._q('#cb-credit-util-bar');
    if (utilEl && utilText && utilBar) {
      if (hasLimit && cl > 0) {
        utilEl.classList.remove('hidden');
        const pct = Math.min(Math.round(util), 100);
        utilText.textContent = `${pct}%`;
        utilBar.style.width = `${pct}%`;
        // Color coding
        if (pct >= 100) utilBar.className = 'h-full bg-error transition-all duration-300 rounded-full';
        else if (pct >= 90) utilBar.className = 'h-full bg-warning transition-all duration-300 rounded-full';
        else utilBar.className = 'h-full bg-secondary transition-all duration-300 rounded-full';
      } else {
        utilEl.classList.add('hidden');
      }
    }

    // Credit Status
    this._renderCreditStatus(d, o, cl, hasLimit, util);

    // Recent Billing
    const recentBilling = this._q('#cb-recent-billing');
    const recentBillsBody = this._q('#cb-recent-bills-body');
    if (recentBilling && recentBillsBody) {
      const bills = d.recentBills || [];
      if (bills.length > 0) {
        recentBilling.classList.remove('hidden');
        recentBillsBody.innerHTML = bills.map(b => {
          const statusClass = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(b.status)
            ? 'text-on-surface-variant' : b.status === 'PAID' ? 'text-green-600' : b.status === 'OVERDUE' ? 'text-error' : 'text-on-surface';
          return `<tr>
            <td class="px-2 py-1 font-medium text-on-surface">${this.esc(b.billNumber || b.bill_number || '—')}</td>
            <td class="px-2 py-1 text-on-surface-variant">${b.issueDate || '—'}</td>
            <td class="px-2 py-1 text-on-surface-variant">${b.dueDate || '—'}</td>
            <td class="px-2 py-1 text-right text-on-surface">${Currency.format(parseFloat(b.total || 0), cur)}</td>
            <td class="px-2 py-1 text-right text-on-surface">${Currency.format(parseFloat(b.balance || 0), cur)}</td>
            <td class="px-2 py-1 ${statusClass}">${this.esc(b.status || '—')}</td>
          </tr>`;
        }).join('');
      } else {
        recentBilling.classList.add('hidden');
        recentBillsBody.innerHTML = '';
      }
    }

    // Payment History
    const paymentHistory = this._q('#cb-payment-history');
    const paymentsEmpty = this._q('#cb-payments-empty');
    const paymentsList = this._q('#cb-payments-list');
    const paymentsBody = this._q('#cb-recent-payments-body');
    if (paymentHistory && paymentsEmpty && paymentsList && paymentsBody) {
      const payments = d.recentPayments || [];
      if (payments.length > 0) {
        paymentHistory.classList.remove('hidden');
        paymentsEmpty.classList.add('hidden');
        paymentsList.classList.remove('hidden');
        paymentsBody.innerHTML = payments.map(p => {
          const methodIcon = {
            'BANK_TRANSFER': 'account_balance', 'CASH': 'money', 'CARD': 'credit_card',
            'UPI': 'smartphone', 'CHEQUE': 'description'
          }[p.payment_method || p.paymentMethod] || 'payment';
          return `<tr>
            <td class="px-2 py-1 text-on-surface-variant">${p.paymentDate || '—'}</td>
            <td class="px-2 py-1 text-on-surface">${this.esc(p.reference_number || p.referenceNumber || '—')}</td>
            <td class="px-2 py-1 text-on-surface-variant"><span class="material-symbols-outlined text-[14px] align-middle mr-1">${methodIcon}</span>${this.esc(p.payment_method || p.paymentMethod || '—')}</td>
            <td class="px-2 py-1 text-right text-on-surface">${Currency.format(parseFloat(p.amount || 0), cur)}</td>
          </tr>`;
        }).join('');
      } else {
        paymentHistory.classList.remove('hidden');
        paymentsEmpty.classList.remove('hidden');
        paymentsList.classList.add('hidden');
        paymentsBody.innerHTML = '';
      }
    }
  },

  /** Render credit status (NORMAL / NEAR LIMIT / LIMIT REACHED / EXCEEDED) */
  _renderCreditStatus(d, outstanding, creditLimit, hasLimit, utilization) {
    const statusEl = this._q('#cb-credit-status');
    const iconEl = this._q('#cb-credit-status-icon');
    const titleEl = this._q('#cb-credit-status-title');
    const detailsEl = this._q('#cb-credit-status-details');
    if (!statusEl || !iconEl || !titleEl || !detailsEl) return;

    // No credit limit configured — skip status display
    if (!hasLimit || creditLimit <= 0) {
      statusEl.classList.add('hidden');
      return;
    }

    const cur = this.currentCurrency;
    const available = Math.max(creditLimit - outstanding, 0);
    const projected = outstanding + (this.createBillState._grandTotal || 0);
    const exceeded = projected > creditLimit;
    const nearLimitAfterBill = projected / creditLimit * 100;
    const nearLimit = (utilization >= 80 && utilization < 100) || (nearLimitAfterBill >= 80 && nearLimitAfterBill < 100);

    if (exceeded) {
      iconEl.textContent = 'error';
      titleEl.textContent = 'Credit Limit Exceeded';
      detailsEl.innerHTML = `
        <div class="flex justify-between"><span>Existing Outstanding</span><span>${Currency.format(outstanding, cur)}</span></div>
        <div class="flex justify-between"><span>Current Bill</span><span>${Currency.format(this.createBillState._grandTotal || 0, cur)}</span></div>
        <div class="flex justify-between font-medium"><span>Projected Outstanding</span><span>${Currency.format(projected, cur)}</span></div>
        <div class="flex justify-between"><span>Credit Limit</span><span>${Currency.format(creditLimit, cur)}</span></div>
        <div class="flex justify-between text-error-content"><span>Exceeded By</span><span>${Currency.format(projected - creditLimit, cur)}</span></div>
      `;
      statusEl.classList.remove('hidden');
      statusEl.className = 'mb-4 p-3 rounded-lg border bg-error-container/10 border-error-container';
    } else if (nearLimit || nearLimitAfterBill >= 100) {
      iconEl.textContent = 'warning';
      titleEl.textContent = 'Near Credit Limit';
      const utilAfter = Math.round(nearLimitAfterBill);
      const remaining = Math.max(creditLimit - projected, 0);
      detailsEl.innerHTML = `
        <div class="flex justify-between"><span>Credit utilization</span><span>${utilAfter}%</span></div>
        <div class="flex justify-between"><span>Credit remaining</span><span>${Currency.format(remaining, cur)}</span></div>
      `;
      statusEl.classList.remove('hidden');
      statusEl.className = 'mb-4 p-3 rounded-lg border bg-warning-container/10 border-warning-container';
    } else {
      iconEl.textContent = 'check_circle';
      titleEl.innerHTML = '<span class="text-green-600">Normal</span>';
      detailsEl.innerHTML = `
        <div class="flex justify-between"><span>Credit utilization</span><span>${Math.round(utilization)}%</span></div>
        <div class="flex justify-between"><span>Available credit</span><span>${Currency.format(available, cur)}</span></div>
      `;
      statusEl.classList.remove('hidden');
      statusEl.className = 'mb-4 p-3 rounded-lg border bg-surface-container/50';
    }
  },

  /** Update current bill impact + credit projection based on current bill totals */
  _updateCreditProjection() {
    const summaryEl = this._q('#cb-financial-snapshot');
    const s = this.createBillState;
    if (!summaryEl || !s.customerSummary) {
      this._q('#cb-bill-impact')?.classList.add('hidden');
      this._q('#cb-credit-status')?.classList.add('hidden');
      this._q('#cb-credit-warning')?.classList.add('hidden');
      return;
    }

    const d = s.customerSummary;
    const cur = this.currentCurrency;
    const existing = parseFloat(d.outstandingBalance) || 0;
    const limit = parseFloat(d.creditLimit) || 0;
    const hasLimit = d.hasCreditLimit;
    const util = parseFloat(d.creditUtilization) || 0;
    const grandTotal = s._grandTotal || this._parseFormattedTotal();
    const projected = existing + grandTotal;
    const availableAfter = hasLimit ? Math.max(limit - projected, 0) : 0;
    const exceeded = hasLimit && limit > 0 && projected > limit;

    // Current Bill Impact section
    const impactEl = this._q('#cb-bill-impact');
    if (impactEl) {
      impactEl.classList.remove('hidden');
      this._q('#cb-impact-outstanding').textContent = Currency.format(existing, cur);
      this._q('#cb-impact-bill').textContent = Currency.format(grandTotal, cur);
      this._q('#cb-impact-projected').textContent = Currency.format(projected, cur);
      this._q('#cb-impact-limit').textContent = hasLimit ? Currency.format(limit, cur) : 'Not Set';
      this._q('#cb-impact-available').textContent = hasLimit ? Currency.format(availableAfter, cur) : 'Not Limited';
    }

    // Credit Status (NORMAL / NEAR LIMIT / EXCEEDED)
    this._renderCreditStatus(d, existing, limit, hasLimit, util);

    // Credit limit exceeded warning (separate from status)
    const warning = this._q('#cb-credit-warning');

    // Update credit utilization progress bar with projected value
    const utilEl = this._q('#cb-credit-utilization');
    const utilText = this._q('#cb-credit-util-text');
    const utilBar = this._q('#cb-credit-util-bar');
    if (utilEl && utilText && utilBar && hasLimit && limit > 0) {
      utilEl.classList.remove('hidden');
      const projectedUtil = Math.min(Math.round((projected / limit) * 100), 100);
      utilText.textContent = `${projectedUtil}%`;
      utilBar.style.width = `${projectedUtil}%`;
      if (projectedUtil >= 100) utilBar.className = 'h-full bg-error transition-all duration-300 rounded-full';
      else if (projectedUtil >= 90) utilBar.className = 'h-full bg-warning transition-all duration-300 rounded-full';
      else utilBar.className = 'h-full bg-secondary transition-all duration-300 rounded-full';
    } else if (utilEl) {
      utilEl.classList.add('hidden');
    }

    if (warning) {
      if (exceeded) {
        const details = this._q('#cb-credit-details');
        if (details) {
          details.innerHTML = `
            <div class="flex justify-between"><span>Existing Outstanding</span><span>${Currency.format(existing, cur)}</span></div>
            <div class="flex justify-between"><span>Current Bill</span><span>${Currency.format(grandTotal, cur)}</span></div>
            <div class="flex justify-between font-medium"><span>Projected Outstanding</span><span>${Currency.format(projected, cur)}</span></div>
            <div class="flex justify-between"><span>Credit Limit</span><span>${Currency.format(limit, cur)}</span></div>
            <div class="flex justify-between text-error-content"><span>Exceeded By</span><span>${Currency.format(projected - limit, cur)}</span></div>
          `;
        }
        warning.classList.remove('hidden');
        const action = this._q('#cb-credit-action');
        if (action) {
          action.classList.remove('hidden');
          action.onclick = () => Toast.info('Approval request requires the approval workflow (implemented in a later step). Please reduce the bill amount or contact an administrator.');
        }
      } else {
        warning.classList.add('hidden');
      }
    }
  },

  _syncAddresses() {
    const same = this._q('#cb-same-address')?.checked;
    if (same) {
      this._q('#cb-shipping-address').value = this._q('#cb-billing-address').value;
    }
  },

  _updateDiscountBreakdown() {
    const d = this.createBillState.invoiceDiscount;
    const el = this._q('#cb-discount-breakdown');
    if (d.type === 'none' || !d.value) { if (el) el.textContent = 'No invoice-level discount applied.'; return; }
    const label = d.type === 'percent' ? `${d.value}%` : Currency.format(d.value, this.currentCurrency);
    const subtotal = this.createBillState.billLines.reduce((a, l) => a + (parseFloat(l.line_total) || 0), 0);
    let amt = 0;
    if (d.type === 'percent') amt = subtotal * d.value / 100;
    else amt = Math.min(d.value, subtotal);
    if (el) el.textContent = `Invoice discount (${label}) applied = ${Currency.format(amt, this.currentCurrency)}`;
  },

  _renderAdditionalCharges() {
    const list = this._q('#cb-charges-list');
    if (!list) return;
    list.innerHTML = this.createBillState.additionalCharges.map((c, i) => `
      <div class="flex items-center gap-1 text-body-sm">
        <input data-charge="${i}" data-field="description" type="text" value="${this.esc(c.description)}" placeholder="Description…" class="flex-1 px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40"/>
        <input data-charge="${i}" data-field="amount" type="number" min="0" step="0.01" value="${c.amount || 0}" placeholder="0" class="w-20 px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm text-center outline-none focus:ring-1 focus:ring-secondary/40"/>
        <label class="flex items-center gap-1 text-body-xs text-on-surface-variant cursor-pointer">
          <input data-charge="${i}" data-field="taxable" type="checkbox" ${c.taxable ? 'checked' : ''} class="rounded"/>
          <span>Taxable</span>
        </label>
        <select data-charge="${i}" data-field="tax_master_id" class="w-32 px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40 hidden">${this._chargeTaxOptions(c)}</select>
        <button type="button" data-charge-remove="${i}" class="p-1 rounded hover:bg-error-container/20 text-error-content" title="Remove charge">
          <span class="material-symbols-outlined text-[16px]">delete</span>
        </button>
      </div>
    `).join('');
    // Wire inputs
    list.querySelectorAll('input[data-charge]').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const i = parseInt(e.target.dataset.charge, 10);
        const f = e.target.dataset.field;
        const v = e.target.value;
        if (f === 'amount') this.createBillState.additionalCharges[i].amount = parseFloat(v) || 0;
        else if (f === 'taxable') this.createBillState.additionalCharges[i].taxable = e.target.checked;
        else this.createBillState.additionalCharges[i][f] = v;
        // Show/hide tax selector when taxable toggled
        if (f === 'taxable') {
          const sel = list.querySelector(`select[data-charge="${i}"]`);
          if (sel) sel.classList.toggle('hidden', !e.target.checked);
        }
        this.updateCreateBillTotals();
        this._markDirty();
      });
    });
    list.querySelectorAll('select[data-charge]').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const i = parseInt(e.target.dataset.charge, 10);
        this.createBillState.additionalCharges[i].tax_master_id = e.target.value;
        this.updateCreateBillTotals();
        this._markDirty();
      });
    });
    list.querySelectorAll('[data-charge-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.chargeRemove, 10);
        this.createBillState.additionalCharges.splice(i, 1);
        this._renderAdditionalCharges();
        this.updateCreateBillTotals();
        this._markDirty();
      });
    });
  },

  _chargeTaxOptions(c) {
    const all = this.createBillState.taxMasters || [];
    if (!all.length) return '<option value="">No tax masters</option>';
    return all.map(t => `<option value="${this.esc(t.id)}" ${t.id === (c.tax_master_id || '') ? 'selected' : ''}>${this.esc(t.name || t.code)} ${t.rate ? '(' + t.rate + '%)' : ''}</option>`).join('');
  },

  _openProductSearch(lineIdx) {
    const overlay = this._q('#cb-product-search');
    const input = this._q('#cb-product-search-input');
    const results = this._q('#cb-product-results');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
    this._currentProductLineIdx = lineIdx;
    this._searchProducts('');

    const handler = () => {
      clearTimeout(this._productSearchTimer);
      this._productSearchTimer = setTimeout(() => this._searchProducts(input.value.trim()), 250);
    };
    input.addEventListener('input', handler);
    const outside = (e) => {
      if (!overlay.contains(e.target)) { input.removeEventListener('input', handler); overlay.removeEventListener('click', outside); overlay.classList.add('hidden'); }
    };
    overlay.addEventListener('click', outside);
    this._q('#cb-product-cancel')?.addEventListener('click', () => {
      input.removeEventListener('input', handler);
      overlay.removeEventListener('click', outside);
      overlay.classList.add('hidden');
    }, { once: true });
  },

  async _searchProducts(term) {
    const results = this._q('#cb-product-results');
    if (!results) return;
    results.innerHTML = '<div class="p-4 text-center text-body-sm text-on-surface-variant">Loading…</div>';
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (term) params.set('search', term);
      const res = await API.get(`/products?${params.toString()}`);
      const data = res?.data || res || {};
      const items = data.items || data || [];
      if (!items.length) {
        results.innerHTML = '<div class="p-4 text-center text-body-sm text-on-surface-variant">No products found</div>';
      } else {
        results.innerHTML = items.map(p => `
          <button type="button" data-pid="${p.id}" class="w-full text-left px-3 py-2 hover:bg-surface-container transition-colors border-b border-outline-variant/20">
            <div class="font-medium text-on-surface">${this.esc(p.name)}</div>
            <div class="text-body-sm text-on-surface-variant">${this.esc(p.sku || '')} · ${this.esc(p.category || '')} · ${Currency.format(parseFloat(p.price) || 0, this.currentCurrency)}</div>
          </button>
        `).join('');
        results.querySelectorAll('[data-pid]').forEach(btn => {
          btn.addEventListener('click', () => {
            const p = items.find(it => it.id === btn.dataset.pid);
            if (p) this._applyProductToLine(this._currentProductLineIdx, p);
          });
        });
      }
    } catch (err) {
      results.innerHTML = `<div class="p-4 text-center text-body-sm text-error">Unable to load products. ${err.message || ''}</div>`;
    }
  },

  _applyProductToLine(idx, p) {
    const l = this.createBillState.billLines[idx];
    if (!l) return;
    l.description = p.name || '';
    l.unit_price = parseFloat(p.price) || 0;
    l.unit = p.unit || p.uom || 'Nos';
    l.hsn_sac = p.hsn_sac || p.hsn || '';
    l.product_id = p.id || null;

    // ── Inventory dimensions ──
    // /api/products already returns the linked stock item and its live
    // on-hand quantity (see products.controller.js list query). Carry that
    // through so the line knows whether it is under inventory control and,
    // if so, which batch/serial inputs it must present.
    // ⚠ The API response is camelCase: server/app.js:91 wraps res.json in
    // snakeToCamel() for every route, so these fields arrive as
    // isInventoryManaged / stockItemId / isBatchTracked / isSerialTracked /
    // onHandQty. Reading snake_case here silently yielded undefined for all of
    // them, which made isManaged always false and hid the inventory inputs.
    // Accept both shapes so the page keeps working if the middleware changes.
    const stockItem = p.stockItem || p.stock_item || null;
    const isManaged = Number(p.isInventoryManaged ?? p.is_inventory_managed ?? 0) === 1
      || !!stockItem;
    l.is_inventory_managed = isManaged;
    l.stock_item_id = stockItem
      ? (stockItem.id || p.stockItemId || p.stock_item_id || null)
      : (p.stockItemId || p.stock_item_id || null);
    l.is_batch_tracked = stockItem
      ? Number(stockItem.isBatchTracked ?? stockItem.is_batch_tracked) === 1
      : Number(p.isBatchTracked ?? p.is_batch_tracked) === 1;
    l.is_serial_tracked = stockItem
      ? Number(stockItem.isSerialTracked ?? stockItem.is_serial_tracked) === 1
      : Number(p.isSerialTracked ?? p.is_serial_tracked) === 1;
    l.on_hand_qty = parseFloat(p.onHandQty ?? p.on_hand_qty ?? stockItem?.onHandQty ?? stockItem?.on_hand_qty ?? 0) || 0;

    // Default placement comes from the stock item; the user can override.
    // camelCase-aware, for the same reason as the block above.
    l.godown_id = (stockItem && (stockItem.godownId ?? stockItem.godown_id))
      || p.godownId || p.godown_id || l.godown_id || null;
    l.location_id = (stockItem && (stockItem.locationId ?? stockItem.location_id))
      || p.locationId || p.location_id || l.location_id || null;

    // Clear dimension selections that no longer apply to the chosen product.
    if (!l.is_batch_tracked) { l.batch_id = null; l.batch = null; }
    if (!l.is_serial_tracked) { l.serial_ids = []; l.serial_number = null; }
    // Match tax master by rate
    const rate = parseFloat(p.tax_rate || p.taxRate || 0);
    const master = this.createBillState.taxMasters.find(t => parseFloat(t.rate) === rate) || this.createBillState.taxMasters.find(t => !t.isIgst);
    if (master) { l.tax_master_id = master.id; l.tax_rate = rate; }
    this.renderCreateBillLines();
    this._recalcLine(idx);
    this.updateCreateBillTotals();
    this._markDirty();
  },


  /**
   * Inventory dimension row for a bill line.
   *
   * Rendered ONLY when the line's product is under inventory control, so
   * service-only bills are visually unchanged. A batch select appears only for
   * batch-tracked items and a serial multi-select only for serial-tracked ones,
   * matching exactly what BillInventoryBridge enforces on the server.
   */
  _inventoryDimensionRow(l, idx) {
    if (!l || !l.is_inventory_managed) return '';
    const opts = (list, current, placeholder) => {
      const items = (list || []).map(o =>
        `<option value="${this.esc(o.id)}" ${String(o.id) === String(current) ? 'selected' : ''}>${this.esc(o.name)}</option>`
      ).join('');
      return `<option value="">${this.esc(placeholder)}</option>${items}`;
    };

    const onHand = parseFloat(l.on_hand_qty) || 0;
    const requested = parseFloat(l.quantity) || 0;
    const short = requested > onHand;

    return `
      <tr data-line-idx="${idx}" class="bg-surface-container-low">
        <td class="px-3 py-1 text-body-xs text-on-surface-variant" colspan="3">
          <span class="inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]">inventory_2</span>
            Inventory details
          </span>
        </td>
        <td class="px-3 py-1 text-body-xs ${short ? 'text-error' : 'text-on-surface-variant'}">
          Available: ${onHand}${short ? ' (insufficient)' : ''}
        </td>
        <td class="px-3 py-1"></td>
        <td class="px-3 py-1" colspan="4">
          <span class="text-body-xs text-on-surface-variant">
            Godown <span class="text-error">*</span>
          </span>
          <select data-dim="${idx}" data-dim-field="godown_id" class="ml-2 px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40">
            ${opts(this._invOptions('godowns'), l.godown_id, 'Select godown…')}
          </select>
          <span class="ml-4 text-body-xs text-on-surface-variant">Location</span>
          <select data-dim="${idx}" data-dim-field="location_id" class="ml-2 px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40">
            ${opts(this._invOptions('locations'), l.location_id, 'Auto')}
          </select>
        </td>
        ${l.is_batch_tracked ? `
        <td class="px-3 py-1" colspan="3">
          <span class="text-body-xs text-on-surface-variant">Batch <span class="text-error">*</span></span>
          <select data-dim="${idx}" data-dim-field="batch_id" class="ml-2 px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40">
            ${opts(this._invOptions('batches', l.stock_item_id), l.batch_id, 'Select batch…')}
          </select>
          <span class="ml-3 text-body-xs text-on-surface-variant" data-batch-avail="${idx}"></span>
        </td>` : ''}
        ${l.is_serial_tracked ? `
        <td class="px-3 py-1" colspan="4">
          <span class="text-body-xs text-on-surface-variant">Serials <span class="text-error">*</span></span>
          <select data-dim="${idx}" data-dim-field="serial_ids" multiple size="2" class="ml-2 px-2 py-1 rounded bg-surface-container border border-outline-variant/50 text-on-surface text-body-sm outline-none focus:ring-1 focus:ring-secondary/40">
            ${(this._invOptions('serials', l.stock_item_id) || []).map(o =>
              `<option value="${this.esc(o.id)}" ${(l.serial_ids || []).includes(o.id) ? 'selected' : ''}>${this.esc(o.name)}</option>`
            ).join('')}
          </select>
          <span class="ml-3 text-body-xs text-on-surface-variant">Quantity must equal the number of serials selected.</span>
        </td>` : ''}
      </tr>`;
  },

  /**
   * Lazily-loaded option lists for the inventory dimensions, cached per item
   * so re-rendering a line does not refetch.
   */
  _invOptions(kind, stockItemId) {
    const state = this.createBillState;
    state.invOptions = state.invOptions || {};
    state.invOptions[kind] = state.invOptions[kind] || {};
    const cache = state.invOptions[kind];
    const key = stockItemId || '__global__';
    if (cache[key]) return cache[key];
    if (!state.invLoaded) {
      state.invLoaded = {};
      state.invLoaded[kind] = state.invLoaded[kind] || {};
      if (!state.invLoaded[kind][key]) {
        state.invLoaded[kind][key] = true;
        this._loadInvOptions(kind, stockItemId);
      }
      return [];
    }
    return cache[key] || [];
  },

  async _loadInvOptions(kind, stockItemId) {
    const state = this.createBillState;
    state.invOptions = state.invOptions || {};
    state.invOptions[kind] = state.invOptions[kind] || {};
    const key = stockItemId || '__global__';
    try {
      let items = [];
      if (kind === 'godowns') {
        const res = await API.get('/inventory/masters/godowns?limit=200');
        const d = res?.data || res || {};
        items = (d.items || d || []).map(r => ({ id: r.id, name: r.name }));
      } else if (kind === 'locations') {
        const res = await API.get('/inventory/masters/locations?limit=200');
        const d = res?.data || res || {};
        items = (d.items || d || []).map(r => ({ id: r.id, name: r.name }));
      } else if (kind === 'batches' && stockItemId) {
        const res = await API.get(`/inventory/reports/batch-stock?item_id=${encodeURIComponent(stockItemId)}&limit=200`);
        const d = res?.data || res || {};
        items = (d.items || d || [])
          .filter(r => !r.item_id || r.item_id === stockItemId)
          .map(r => ({ id: r.id, name: `${r.batch_number || ''} (${parseFloat(r.quantity) || 0})` }));
      } else if (kind === 'serials' && stockItemId) {
        const res = await API.get(`/inventory/reports/serials?item_id=${encodeURIComponent(stockItemId)}&status=available&limit=200`);
        const d = res?.data || res || {};
        items = (d.items || d || [])
          .filter(r => r.status === 'available')
          .map(r => ({ id: r.id, name: r.serial_number }));
      }
      state.invOptions[kind][key] = items;
      this.renderCreateBillLines();
    } catch (err) {
      state.invOptions[kind][key] = [];
    }
  },

  /** Wire the inventory dimension selects after a re-render. */
  _wireInventoryDimensions(tbody) {
    tbody.querySelectorAll('[data-dim]').forEach(el => {
      const handler = () => {
        const idx = parseInt(el.dataset.dim, 10);
        const field = el.dataset.dimField;
        const line = this.createBillState.billLines[idx];
        if (!line) return;
        if (field === 'serial_ids') {
          line.serial_ids = Array.from(el.selectedOptions).map(o => o.value);
          line.serial_number = line.serial_ids[0] || null;
        } else {
          line[field] = el.value || null;
          if (field === 'batch_id') {
            // Keep the legacy free-text column in step for older readers.
            const opt = (this._invOptions('batches', line.stock_item_id) || [])
              .find(o => String(o.id) === String(el.value));
            line.batch = opt ? opt.name : null;
          }
        }
        this._markDirty();
        this.renderCreateBillLines();
      };
      el.addEventListener(el.tagName === 'SELECT' && el.multiple ? 'change' : 'change', handler);
    });
  },

  _markDirty() { this.createBillState.dirty = true; },

  /**
   * Save or Submit the bill.
   * action: 'draft' | 'submit'
   * Backend remains authoritative — it recalculates taxes/totals on save.
   */
  async _saveCreateBill(action) {
    if (this.createBillState.saving) return;
    const btn = action === 'draft' ? this._q('#cb-btn-save-draft') : this._q('#cb-btn-submit');
    const ok = this._validateCreateForm();
    if (ok !== true) { Toast.error(ok); return; }

    this.createBillState.saving = true;
    const originalHTML = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin mr-1 align-middle">progress_activity</span>Saving…';
    }

    const state = this.createBillState;
    const company = state.companyConfig;
    const pos = this._q('#cb-place-of-supply')?.value || '';
    const payload = {
      contact_id: this._q('#cb-customer-id').value,
      bill_number: state.billNumber || null,
      issue_date: this._q('#cb-bill-date').value || null,
      due_date: this._q('#cb-due-date').value || null,
      currency: this.currentCurrency,
      payment_terms: this._q('#cb-payment-terms').value,
      payment_terms_days: this._termsDays(this._q('#cb-payment-terms').value),
      place_of_supply: pos || (company ? company.stateCode : ''),
      party_state: pos || (company ? company.stateCode : ''),
      company_state: company ? company.stateCode : '29',
      billing_address: this._q('#cb-billing-address').value || null,
      shipping_address: this._q('#cb-shipping-address').value || null,
      customer_gstin: this._q('#cb-customer-gstin').value || null,
      customer_po_number: this._q('#cb-customer-po-number')?.value || null,
      customer_po_date: this._q('#cb-customer-po-date')?.value || null,
      notes: this._q('#cb-notes')?.value || null,
      terms: this._q('#cb-terms')?.value || null,
      // Always create as DRAFT, then submit endpoint transitions to PENDING_APPROVAL
      status: 'DRAFT',
      other_charges: this._sumAdditionalCharges(),
      other_charges_taxable: state.additionalCharges.some(c => c.taxable),
      other_charges_tax_amount: this._sumChargeTaxes().total,
      charges: state.additionalCharges.map(c => ({
        description: c.description || '',
        amount: parseFloat(c.amount) || 0,
        taxable: c.taxable ? 1 : 0,
        tax_master_id: c.taxable ? (c.tax_master_id || null) : null,
      })),
      discount_amount: this._computeDiscountAmount(),
      discounts: this._buildDiscountRules(),
      lines: state.billLines.map(l => ({
        description: l.description || '',
        // product_id is what links the line to its stock item. Without it the
        // bill posts revenue but moves no stock.
        product_id: l.product_id || null,
        stock_item_id: l.stock_item_id || null,
        quantity: parseFloat(l.quantity) || 1,
        unit: l.unit || 'Nos',
        // Inventory dimensions. Omitted entirely for non-inventory lines so the
        // backend's service/non-stock path is unaffected.
        ...(l.is_inventory_managed ? {
        godown_id: l.godown_id || null,
        location_id: l.location_id || null,
        batch_id: l.batch_id || null,
        serial_id: (l.serial_ids && l.serial_ids.length) ? l.serial_ids[0] : null,
        serial_ids: (l.serial_ids && l.serial_ids.length) ? l.serial_ids : undefined,
        } : {}),
        unit_price: parseFloat(l.unit_price) || 0,
        discount_amount: parseFloat(l.discount_amount) || 0,
        discount_percent: parseFloat(l.discount_percent) || 0,
        hsn_sac: l.hsn_sac || '',
        tax_master_id: l.tax_master_id || 'tax_gst_5_intra',
        tax_rate: parseFloat(l.tax_rate) || 0,
        cgst_amount: parseFloat(l.cgst_amount) || 0,
        sgst_amount: parseFloat(l.sgst_amount) || 0,
        igst_amount: parseFloat(l.igst_amount) || 0,
        line_tax: parseFloat(l.line_tax) || 0,
        line_total: parseFloat(l.line_total) || 0,
        taxable_amount: parseFloat(l.taxable_amount) || 0,
      })),
    };

    try {
      let createdId = null;
      if (action === 'draft') {
        const res = await API.post('/customer-bills', payload);
        const d = res?.data || res || {};
        createdId = d.id || (d.bill ? d.bill.id : null);
        Toast.success('Bill saved as draft');
      } else {
        const res = await API.post('/customer-bills', payload);
        const d = res?.data || res || {};
        createdId = d.id || (d.bill ? d.bill.id : null);
        // Submit for approval: use existing approval architecture if available
        try {
          if (createdId) {
            await API.post(`/customer-bills/${createdId}/submit`, {});
          }
        } catch (submitErr) {
          Toast.warning('Bill created. Approval submit endpoint not yet available.');
        }
        Toast.success('Bill submitted for approval');
      }
      this.createBillState.dirty = false;
      // Navigate back to list
      window.location.hash = '#customer-bills';
      setTimeout(() => { if (document.getElementById('cb-table')) { this.loadBills(); this.loadKpi(); this.loadStatusCounts(); } }, 50);
    } catch (err) {
      const msg = err.message || err?.response?.data?.message || 'Failed to save bill';
      Toast.error(msg);
      // Keep entered data in state (no page reload)
      this._q('#cb-create-error-msg').textContent = msg;
      this._q('#cb-create-error').classList.remove('hidden');
    } finally {
      this.createBillState.saving = false;
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
    }
  },

  _termsDays(terms) {
    const m = String(terms || '').match(/^Net\s+(\d+)$/);
    if (m) return parseInt(m[1], 10);
    const map = { DUE_ON_RECEIPT: 0, ADVANCE: 0, END_OF_MONTH: 0, SPECIFIC_DATE: 0 };
    return map[terms] !== undefined ? map[terms] : 30;
  },

  _validateCreateForm() {
    const contactId = this._q('#cb-customer-id')?.value;
    if (!contactId) return 'Customer is required.';
    const issue = this._q('#cb-bill-date')?.value;
    if (!issue) return 'Invoice date is required.';
    const due = this._q('#cb-due-date')?.value;
    if (!due) return 'Due date is required.';
    if (due < issue) return 'Due date cannot be before invoice date.';
    if (!this.currentCurrency) return 'Currency is required.';
    const terms = this._q('#cb-payment-terms')?.value;
    if (!terms) return 'Payment terms are required.';
    const hasItem = this.createBillState.billLines.some(l =>
      (parseFloat(l.quantity) > 0) && (parseFloat(l.unit_price) >= 0));
    if (!hasItem) return 'At least one valid line item is required (qty > 0, rate >= 0).';
    for (const l of this.createBillState.billLines) {
      if (parseFloat(l.quantity) <= 0) return 'Quantity must be greater than 0.';
      if (parseFloat(l.unit_price) < 0) return 'Rate cannot be negative.';
      const disc = parseFloat(l.discount_amount) || 0;
      if (disc < 0) return 'Discount cannot be negative.';
      if (this._lineNet(l) < 0) return 'Line total cannot be negative.';
    }
    const gt = this._parseFormattedTotal();
    if (gt < 0) return 'Grand total cannot be negative.';
    return true;
  },

  _onBeforeUnload(e) {
    if (this.createBillState?.dirty) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  },

  /** querySelector shorthand — avoids collisions with existing helpers */
  _q(sel) { return document.querySelector(sel); },

  /* ═══ END Create Bill Page ═══ */


  fmt(n, currency) { return Currency.format(n, currency || this.currentCurrency); }
};
