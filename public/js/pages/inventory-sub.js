/**
 * Inventory Management Sub-Pages Module
 *
 * Handles all inventory: sub-routes dispatched by inventory.js handleCardClick.
 * Supports three modes: 'master', 'transaction', 'report'.
 *
 * Master pages: list → add → edit → view → delete
 * Transaction pages: list existing vouchers → new voucher form
 * Report pages: fetch and display report data
 */
(function () {
  'use strict';

  const CURRENCY = '₹';
  const THIRTY = 30; // debounce ms for search

  // ─── Field definitions for each master type ───────────────────
  const MASTER_FIELDS = {
    stock_groups: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'description', label: 'Description', type: 'textarea', required: false }],
    stock_categories: [{ key: 'name', label: 'Category Name', type: 'text', required: true }, { key: 'stock_group_id', label: 'Stock Group', type: 'select', required: true, source: 'stock_groups' }, { key: 'description', label: 'Description', type: 'textarea', required: false }],
    brands: [{ key: 'name', label: 'Brand Name', type: 'text', required: true }, { key: 'description', label: 'Description', type: 'textarea', required: false }],
    models: [{ key: 'name', label: 'Model Name', type: 'text', required: true }, { key: 'brand_id', label: 'Brand', type: 'select', required: true, source: 'brands' }, { key: 'stock_category_id', label: 'Stock Category', type: 'select', required: false, source: 'stock_categories' }, { key: 'description', label: 'Description', type: 'textarea', required: false }],
    colours: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'hexCode', label: 'Hex Code', type: 'text', required: false }],
    sizes: [{ key: 'name', label: 'Name', type: 'text', required: true }],
    styles: [{ key: 'name', label: 'Name', type: 'text', required: true }],
    rate: [{ key: 'itemId', label: 'Stock Item', type: 'select', required: true, source: 'stocks' }, { key: 'rateType', label: 'Rate Type', type: 'text', required: true }, { key: 'rate', label: 'Rate', type: 'number', required: true }, { key: 'effectiveFrom', label: 'Effective From', type: 'date', required: true }],
    price_levels: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'description', label: 'Description', type: 'textarea', required: false }],
    units_of_measure: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'symbol', label: 'Symbol', type: 'text', required: true }, { key: 'description', label: 'Description', type: 'textarea', required: false }],
    godowns: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'code', label: 'Code', type: 'text', required: true }, { key: 'location_id', label: 'Location', type: 'select', required: true, source: 'locations' }, { key: 'address', label: 'Address', type: 'textarea', required: false }],
    locations: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'code', label: 'Code', type: 'text', required: true }, { key: 'address', label: 'Address', type: 'textarea', required: false }],
    batches: [{ key: 'batchNumber', label: 'Batch Number', type: 'text', required: true }, { key: 'itemId', label: 'Stock Item', type: 'select', required: true, source: 'stock_items' }, { key: 'manufacturingDate', label: 'MFG Date', type: 'date', required: false }, { key: 'expiryDate', label: 'Expiry Date', type: 'date', required: false }, { key: 'purchaseRate', label: 'Purchase Rate', type: 'number', required: false }, { key: 'mrp', label: 'MRP', type: 'number', required: false }, { key: 'sellingRate', label: 'Selling Rate', type: 'number', required: false }],
    alternate_units: [{ key: 'baseUnitId', label: 'Base / Stock Unit', type: 'select', required: true, source: 'units_of_measure' }, { key: 'name', label: 'Alternate Unit', type: 'text', required: true }, { key: 'conversionFactor', label: 'Conversion Factor', type: 'number', required: true }, { key: 'rate', label: 'Rate', type: 'number', required: false }, { key: 'description', label: 'Use Case', type: 'textarea', required: false }],
  };

  // ─── Label mappings for display ─────────────────────────────
  const CARD_LABELS = {
    stock_groups: 'Stock Groups', stock_categories: 'Stock Categories', stock_items: 'Stock Items',
    godowns: 'Godowns', locations: 'Locations', batches: 'Batches', batch_wise_stock: 'Batch-wise Stock',
    brands: 'Brand', models: 'Model', alternate_units: 'Alternate Units', units_of_measure: 'Units of Measure',
    colours: 'Colour', sizes: 'Size', styles: 'Style', rate: 'Rate',
    price_levels: 'Price Levels', opening_stock: 'Opening Stock', stock_inward: 'Stock Inward',
    stock_outward: 'Stock Outward', stock_transfer: 'Stock Transfer', stock_adjustment: 'Stock Adjustment',
    physical_stock: 'Physical Stock', stock_journal: 'Stock Journal', stock_valuation: 'Stock Valuation',
    batch_management: 'Batch Management', expiry_management: 'Expiry Management',
    manufacturing_date: 'Manufacturing Date', expiry_date: 'Expiry Date',
    serial_number_tracking: 'Serial Number Tracking', godown_wise_stock: 'Godown-wise Stock',
    location_wise_stock: 'Location-wise Stock', batch_wise_stock_mgmt: 'Batch-wise Stock',
  };

  // ─── Master table name mapping (frontend key -> DB table name) ──
  const MASTER_TABLE_MAP = {
    stock_groups: 'stock_groups', stock_categories: 'stock_categories', stock_items: 'stock_items',
    godowns: 'godowns', locations: 'locations', batches: 'batches',
    brands: 'brands', models: 'models', colours: 'colours', sizes: 'sizes', styles: 'styles',
    rate: 'rate', price_levels: 'price_levels',
    alternate_units: 'alternate_units', units_of_measure: 'units_of_measure',
  };

  // ─── API endpoint mapping (paths relative to /api prefix; API.get() adds it) ──────────────────────────────
  const API_MAP = {
    stock_groups: '/inventory/masters/stock_groups',
    stock_categories: '/inventory/masters/stock_categories',
    stock_items: '/inventory/stocks',
    godowns: '/inventory/masters/godowns',
    locations: '/inventory/masters/locations',
    batches: '/inventory/masters/batches',
    brands: '/inventory/masters/brands',
    models: '/inventory/masters/models',
    colours: '/inventory/masters/colours',
    sizes: '/inventory/masters/sizes',
    styles: '/inventory/masters/styles',
    rate: '/inventory/masters/rate',
    price_levels: '/inventory/masters/price_levels',
    alternate_units: '/inventory/masters/alternate_units',
    units_of_measure: '/inventory/masters/units_of_measure',
  };

  // ─── Report API endpoints ──────────────────────────────
  const REPORT_API_MAP = {
    stock_valuation: '/inventory/reports/valuation',
    batch_management: '/inventory/reports/batch-stock',
    batch_wise_stock: '/inventory/reports/batch-stock',
    batch_wise_stock_mgmt: '/inventory/reports/batch-stock',
    expiry_management: '/inventory/reports/expiry',
    expiry_date: '/inventory/reports/expiry',
    serial_number_tracking: '/inventory/reports/serials',
    manufacturing_date: '/inventory/reports/serials',
    godown_wise_stock: '/inventory/reports/godown-stock',
    location_wise_stock: '/inventory/reports/location-stock',
  };

  // ─── Transaction types ────────────────────────────────
  const TX_VOUCHER_TYPES = {
    opening_stock: 'opening_stock',
    stock_inward: 'stock_inward',
    stock_outward: 'stock_outward',
    stock_transfer: 'stock_transfer',
    stock_adjustment: 'stock_adjustment',
    stock_journal: 'stock_journal',
  };

  /** Generic Master Management Page */
  class MasterPage {
    constructor(key) {
      this.key = key;
      this.apiBase = API_MAP[key] || `/inventory/masters/${key}`;
      this.label = CARD_LABELS[key] || key;
      this.fields = MASTER_FIELDS[key] || [{ key: 'name', label: 'Name', type: 'text', required: true }];
      this.data = [];
      this.currentPage = 1;
      this.pageSize = 20;
      this.searchTimer = null;
    }

    async render(container) {
      container.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'flex items-center justify-between mb-stack-lg';
      header.innerHTML = `
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">${this.label}</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage ${this.label.toLowerCase()}</p>
        </div>
        <button id="inv-master-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
          <span class="material-symbols-outlined text-[18px]">add</span> Add ${this.label}
        </button>
      `;
      container.appendChild(header);

      // Search + table container
      const content = document.createElement('div');
      content.className = 'space-y-4';
      content.innerHTML = `
        <div class="relative"><span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
          <input id="inv-master-search" placeholder="Search..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div id="inv-master-table" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30"></div>
        <div id="inv-master-pagination" class="flex justify-end"></div>
      `;
      container.appendChild(content);

      this.bindEvents(container);
      await this.load();
    }

    bindEvents(container) {
      container.querySelector('#inv-master-new').addEventListener('click', () => this.openForm());
      const searchInput = container.querySelector('#inv-master-search');
      searchInput.addEventListener('input', (e) => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => { this.search = e.target.value; this.currentPage = 1; this.load(); }, THIRTY);
      });
    }

    async load() {
      this.data = [];
      const tableEl = document.getElementById('inv-master-table');
      if (!tableEl) return;
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      try {
        const params = { query: this.search, limit: this.pageSize, offset: (this.currentPage - 1) * this.pageSize };
        Object.keys(params).forEach(k => { if (!params[k] && params[k] !== 0) delete params[k]; });
        const data = await API.get(this.apiBase, params);
        this.data = (data.items || []).map(item => ({
          ...item,
          // Batches API has no `name` — expose the batch number as the row name
          name: item.name || item.batchNumber || item.batch_number || item.name,
        }));
        this.renderTable(tableEl);
      } catch (err) {
        tableEl.innerHTML = `<div class="p-6 text-center text-error"><p>Failed to load: ${err.message}</p></div>`;
      }
    }

    renderTable(container) {
      let columns = [{ key: 'name', label: 'Name' }];
      if (this.key === 'rate') columns = [{ key: 'rateType', label: 'Rate Type' }, { key: 'rate', label: 'Rate' }, { key: 'effectiveFrom', label: 'Effective From' }];
      if (this.key === 'godowns') {
        columns.push({ key: 'code', label: 'Code' });
        columns.push({ key: 'locationName', label: 'Location' });
      }
      if (this.key === 'locations') {
        columns.push({ key: 'code', label: 'Code' });
        columns.push({ key: 'address', label: 'Address' });
      }
      columns.push({ key: 'isActive', label: 'Status', render: (v) => v ? '<span class="text-green-600">Active</span>' : '<span class="text-red-600">Inactive</span>' });
      columns.push({ key: '_actions', label: '', sortable: false, render: (v, row) => `
        <button data-row-action="edit" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant">
          <span class="material-symbols-outlined text-[16px]">edit</span>
        </button>
        <button data-row-action="delete" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-error-container/20 flex items-center justify-center text-error">
          <span class="material-symbols-outlined text-[16px]">delete</span>
        </button>
      ` });

      this.table = new DataTable(container, {
        columns,
        data: this.data,
        rowActions: null,
        emptyState: 'No records found',
      });

      // Wire up row action buttons
      const tbody = container.querySelector('tbody');
      if (tbody) {
        tbody.addEventListener('click', (e) => {
          const editBtn = e.target.closest('[data-row-action="edit"]');
          const delBtn = e.target.closest('[data-row-action="delete"]');
          if (editBtn) { const id = editBtn.dataset.id; const row = this.data.find(r => r.id === id); this.openForm(row); }
          if (delBtn) { const id = delBtn.dataset.id; const row = this.data.find(r => r.id === id); this.confirmDelete(row); }
        });
      }
    }

    async openForm(row = null) {
      const isEdit = !!row;
      const p = row || {};
      const fieldsHtml = this.fields.map(f => {
        const val = p[f.key] !== undefined ? p[f.key] : (f.default !== undefined ? f.default : '');
        let input;
        if (f.type === 'select') {
          input = `<select name="${f.key}" ${f.required ? 'required' : ''}
            class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">Select ${f.label}</option>
          </select>`;
        } else if (f.type === 'textarea') {
          input = `<textarea name="${f.key}" ${f.required ? 'required' : ''}
            class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">${val || ''}</textarea>`;
        } else {
          input = `<input name="${f.key}" type="${f.type}" ${f.required ? 'required' : ''} value="${val || ''}"
            class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">`;
        }
        return `
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">${f.label}${f.required ? ' *' : ''}</label>
            ${input}
          </div>
        `;
      }).join('');

      const modal = new Modal({
        title: isEdit ? `Edit ${this.label}` : `Add ${this.label}`,
        size: 'lg',
        content: `<form id="inv-master-form" class="grid grid-cols-2 gap-stack-md">${fieldsHtml}</form>`,
      });
      modal.open();
      // Inject action buttons after the form content (Modal renders content as-is)
      const formEl = modal.element.querySelector('#inv-master-form');
      if (formEl) {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'col-span-2 flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30';
        actionsDiv.innerHTML = `
          <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
          <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save</button>
        `;
        formEl.appendChild(actionsDiv);
      }

      // Load options for select fields
      for (const f of this.fields) {
        if (f.type === 'select' && f.source) {
          const select = modal.element.querySelector(`select[name="${f.key}"]`);
          if (select) {
            try {
              const opts = await API.get(API_MAP[f.source] || `/inventory/masters/${f.source}`, { limit: 200 });
              const items = opts.items || [];
              select.innerHTML = `<option value="">Select ${f.label}</option>`;
              items.forEach(opt => {
                const optId = opt.id || opt.value;
                const optName = opt.name || opt.label || JSON.stringify(opt);
                select.innerHTML += `<option value="${optId}" ${optId === (p[f.key] || '') ? 'selected' : ''}>${optName}</option>`;
              });
            } catch { /* skip */ }
          }
        }
      }

      const form = modal.element.querySelector('#inv-master-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = Object.fromEntries(fd.entries());
        // Convert numeric fields
        for (const f of this.fields) {
          if (f.type === 'number' && payload[f.key]) payload[f.key] = parseFloat(payload[f.key]) || 0;
          if (f.type === 'number' && !payload[f.key]) payload[f.key] = 0;
        }
        try {
          if (isEdit) {
            await API.put(`${this.apiBase}/${p.id}`, payload);
          } else {
            await API.post(this.apiBase, payload);
          }
          Toast.success(isEdit ? 'Updated' : 'Created');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Failed to save');
        }
      });
    }

    confirmDelete(row) {
      const modal = new Modal({
        title: `Delete ${this.label}?`,
        size: 'sm',
        content: `<p class="font-body-md text-on-surface mb-stack-md">Delete <strong>${row.name || row.rateType || row.id}</strong>?</p>
          <div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
          <button id="confirm-delete" class="bg-error text-on-error px-4 py-2 rounded-lg">Delete</button></div>`,
      });
      modal.open();
      modal.element.querySelector('#confirm-delete').addEventListener('click', async () => {
        try {
          await API.del(`${this.apiBase}/${row.id}`);
          Toast.success('Deleted');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Cannot delete: record may be referenced');
          modal.close();
        }
      });
    }
  }

  /** Stock Categories page — requires Stock Group parent selection */
  class StockCategoryPage extends MasterPage {
    constructor() {
      super('stock_categories');
      this.inputCls = 'w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary/50 transition-all';
      this.labelCls = 'block text-sm font-medium text-on-surface mb-1.5';
    }

    // Override load to map the stock_group_name from the JOIN
    async load() {
      this.data = [];
      const tableEl = document.getElementById('inv-master-table');
      if (!tableEl) return;
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      try {
        const params = { query: this.search, limit: this.pageSize, offset: (this.currentPage - 1) * this.pageSize };
        Object.keys(params).forEach(k => { if (!params[k] && params[k] !== 0) delete params[k]; });
        const data = await API.get(this.apiBase, params);
        const rawItems = data.items || [];
          this.data = rawItems.map(item => ({
            ...item,
            stockGroupName: item.stock_group_name || item.stockGroupName || '',
          }));
        this.renderTable(tableEl);
      } catch (err) {
        tableEl.innerHTML = `<div class="p-6 text-center text-error"><p>Failed to load: ${err.message}</p></div>`;
      }
    }

    // Override renderTable to show Stock Group column instead of Description
    renderTable(container) {
      let columns = [{ key: 'name', label: 'Category Name' }];
      columns.push({ key: 'stockGroupName', label: 'Stock Group', render: (v) => (v || '—') });
      columns.push({ key: 'description', label: 'Description', render: (v) => (v || '—'), hidden: true });
      columns.push({ key: 'isActive', label: 'Status', render: (v) => v ? '<span class="text-green-600">Active</span>' : '<span class="text-red-600">Inactive</span>' });
      columns.push({ key: '_actions', label: '', sortable: false, render: (v, row) => `
        <div class="flex gap-1">
          <button data-row-action="edit" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant">
            <span class="material-symbols-outlined text-[16px]">edit</span>
          </button>
          <button data-row-action="delete" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-error-container/20 flex items-center justify-center text-error">
            <span class="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      ` });

      this.table = new DataTable(container, {
        columns,
        data: this.data,
        rowActions: null,
        emptyState: 'No records found',
      });

      // Wire up row action buttons
      const tbody = container.querySelector('tbody');
      if (tbody) {
        tbody.addEventListener('click', (e) => {
          const editBtn = e.target.closest('[data-row-action="edit"]');
          const delBtn = e.target.closest('[data-row-action="delete"]');
          if (editBtn) { const id = editBtn.dataset.id; const row = this.data.find(r => r.id === id); this.openForm(row); }
          if (delBtn) { const id = delBtn.dataset.id; const row = this.data.find(r => r.id === id); this.confirmDelete(row); }
        });
      }
    }

    // Override openForm with premium form matching products New Product form
    async openForm(row = null) {
      const isEdit = !!row;
      const p = row || {};

      // Load stock_groups dropdown options
      let groupOptions = '<option value="">Select Stock Group</option>';
      try {
        const opts = await API.get('/inventory/masters/stock_groups', { limit: 200 });
        const items = opts?.items || [];
        items.forEach(opt => {
          groupOptions += `<option value="${opt.id}" ${opt.id === (p.stock_group_id || p.stockGroupId || '') ? 'selected' : ''}>${opt.name || opt.label}</option>`;
        });
      } catch { /* skip */ }

      // Resolve current group name for edit mode
      let currentGroup = '';
      if (p.stock_group_id || p.stockGroupId || p.stock_group_name || p.stockGroupName) {
        currentGroup = p.stock_group_name || p.stockGroupName || '';
      }

      const modal = new Modal({
        title: isEdit ? 'Edit Stock Category' : 'Add Stock Category',
        size: '2xl',
        content: `
          <form id="inv-master-form" class="space-y-6">
            <!-- Basic Information -->
            <div class="space-y-4">
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Basic Information</h3>
              <div class="grid grid-cols-2 gap-4">
                <div class="col-span-2">
                  <label class="${this.labelCls}">Category Name <span class="text-error">*</span></label>
                  <input name="name" required value="${p.name || ''}"
                    class="${this.inputCls}"/>
                </div>
                <div class="col-span-2">
                  <label class="${this.labelCls}">Stock Group <span class="text-error">*</span></label>
                  <select name="stock_group_id" required
                    class="${this.inputCls}">
                    ${groupOptions}
                  </select>
                  ${currentGroup ? `<p class="text-xs text-on-surface-variant/60 mt-1">Current: ${currentGroup}</p>` : ''}
                </div>
                <div class="col-span-2">
                  <label class="${this.labelCls}">Description</label>
                  <textarea name="description" rows="2"
                    class="${this.inputCls}">${p.description || ''}</textarea>
                </div>
              </div>
            </div>

            <!-- Form actions -->
            <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
              <button type="button" data-modal-close
                class="px-4 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors">
                Cancel
              </button>
              <button type="submit"
                class="flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
                <span class="material-symbols-outlined text-[16px]">${isEdit ? 'save' : 'add'}</span>
                ${isEdit ? 'Save Changes' : 'Create Category'}
              </button>
            </div>
          </form>
        `,
      });
      modal.open();

      const form = modal.element.querySelector('#inv-master-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = Object.fromEntries(fd.entries());
        // stock_group_id is required
        if (!payload.stock_group_id) {
          Toast.error('Please select a Stock Group');
          return;
        }
        try {
          if (isEdit) {
            await API.put(`${this.apiBase}/${p.id}`, payload);
          } else {
            await API.post(this.apiBase, payload);
          }
          Toast.success(isEdit ? 'Updated' : 'Created');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Failed to save');
        }
      });
    }
  }

  /** Models page — requires Stock Category parent selection
   *  Hierarchy: Stock Group → Stock Category → Model */
  class ModelPage extends MasterPage {
    constructor() {
      super('models');
      this.inputCls = 'w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary/50 transition-all';
      this.labelCls = 'block text-sm font-medium text-on-surface mb-1.5';
    }

    // Override load to map the joined stock_category_name + stock_group_name
    async load() {
      this.data = [];
      const tableEl = document.getElementById('inv-master-table');
      if (!tableEl) return;
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      try {
        const params = { query: this.search, limit: this.pageSize, offset: (this.currentPage - 1) * this.pageSize };
        Object.keys(params).forEach(k => { if (!params[k] && params[k] !== 0) delete params[k]; });
        const data = await API.get(this.apiBase, params);
        const rawItems = data.items || [];
        this.data = rawItems.map(item => ({
          ...item,
          stockCategoryName: item.stock_category_name || item.stockCategoryName || '',
          stockGroupId: item.stock_group_id || item.stockGroupId || '',
          stockGroupName: item.stock_group_name || item.stockGroupName || '',
          brandId: item.brand_id || item.brandId || '',
          brandName: item.brand_name || item.brandName || '',
        }));
        this.renderTable(tableEl);
      } catch (err) {
        tableEl.innerHTML = `<div class="p-6 text-center text-error"><p>Failed to load: ${err.message}</p></div>`;
      }
    }

    // Override renderTable to show Brand and Stock Category columns
    renderTable(container) {
      let columns = [{ key: 'name', label: 'Model Name' }];
      columns.push({ key: 'brandName', label: 'Brand', render: (v) => (v || '—') });
      columns.push({ key: 'stockCategoryName', label: 'Stock Category', render: (v) => (v || '—') });
      columns.push({ key: 'stockGroupName', label: 'Stock Group', render: (v) => (v || '—'), hidden: true });
      columns.push({ key: 'description', label: 'Description', render: (v) => (v || '—'), hidden: true });
      columns.push({ key: 'isActive', label: 'Status', render: (v) => v ? '<span class="text-green-600">Active</span>' : '<span class="text-red-600">Inactive</span>' });
      columns.push({ key: '_actions', label: '', sortable: false, render: (v, row) => `
        <div class="flex gap-1">
          <button data-row-action="edit" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant">
            <span class="material-symbols-outlined text-[16px]">edit</span>
          </button>
          <button data-row-action="delete" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-error-container/20 flex items-center justify-center text-error">
            <span class="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      ` });

      this.table = new DataTable(container, {
        columns,
        data: this.data,
        rowActions: null,
        emptyState: 'No records found',
      });

      const tbody = container.querySelector('tbody');
      if (tbody) {
        tbody.addEventListener('click', (e) => {
          const editBtn = e.target.closest('[data-row-action="edit"]');
          const delBtn = e.target.closest('[data-row-action="delete"]');
          if (editBtn) { const id = editBtn.dataset.id; const row = this.data.find(r => r.id === id); this.openForm(row); }
          if (delBtn) { const id = delBtn.dataset.id; const row = this.data.find(r => r.id === id); this.confirmDelete(row); }
        });
      }
    }

    // Override openForm with premium form featuring Stock Category as required
    async openForm(row = null) {
      const isEdit = !!row;
      const p = row || {};

      // Load Stock Categories dropdown (only already-created ones)
      let categoryOptions = '<option value="">No Stock Categories available</option>';
      let hasCategories = false;
      try {
        const opts = await API.get('/inventory/masters/stock_categories', { limit: 200 });
        const items = opts?.items || [];
        hasCategories = items.length > 0;
        if (hasCategories) {
          categoryOptions = '<option value="">Select Stock Category *</option>';
          items.forEach(opt => {
            categoryOptions += `<option value="${opt.id}" ${opt.id === (p.stock_category_id || p.stockCategoryId || '') ? 'selected' : ''}>${opt.name || opt.label}</option>`;
          });
        }
      } catch { /* skip */ }

      // Load Brands dropdown (optional)
      let brandOptions = '<option value="">Select Brand</option>';
      try {
        const opts = await API.get('/inventory/masters/brands', { limit: 200 });
        const items = opts?.items || [];
        items.forEach(opt => {
          brandOptions += `<option value="${opt.id}" ${opt.id === (p.brand_id || p.brandId || '') ? 'selected' : ''}>${opt.name || opt.label}</option>`;
        });
      } catch { /* skip */ }

      // Resolve current display names for edit mode
      const resolvedCategory = await this._resolveName(p.stock_category_id || p.stockCategoryId, '/inventory/masters/stock_categories');
      const resolvedBrand = await this._resolveName(p.brand_id || p.brandId, '/inventory/masters/brands');

      const modal = new Modal({
        title: isEdit ? 'Edit Model' : 'Add Model',
        size: '2xl',
        content: `
          <form id="inv-master-form" class="space-y-6">
            <!-- Basic Information -->
            <div class="space-y-4">
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Basic Information</h3>
              <div class="grid grid-cols-2 gap-4">
                <div class="col-span-2">
                  <label class="${this.labelCls}">Model Name <span class="text-error">*</span></label>
                  <input name="name" required value="${p.name || ''}"
                    class="${this.inputCls}"/>
                </div>
                <div>
                  <label class="${this.labelCls}">Brand</label>
                  <select name="brand_id"
                    class="${this.inputCls}">
                    ${brandOptions}
                  </select>
                  ${resolvedBrand ? `<p class="text-xs text-on-surface-variant/60 mt-1">Current: ${resolvedBrand}</p>` : ''}
                </div>
                <div>
                  <label class="${this.labelCls}">Stock Category <span class="text-error">*</span></label>
                  <select name="stock_category_id" required
                    class="${this.inputCls}">
                    ${categoryOptions}
                  </select>
                  ${resolvedCategory ? `<p class="text-xs text-on-surface-variant/60 mt-1">Current: ${resolvedCategory}</p>` : ''}
                  ${!hasCategories ? `<p class="text-xs text-on-surface-variant/60 mt-1\">No Stock Categories found. Create one under a Stock Group first.</p>` : ''}
                </div>
                <div class="col-span-2">
                  <label class="${this.labelCls}">Description</label>
                  <textarea name="description" rows="2"
                    class="${this.inputCls}">${p.description || ''}</textarea>
                </div>
              </div>
            </div>
            <!-- Form actions -->
            <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
              <button type="button" data-modal-close
                class="px-4 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors">
                Cancel
              </button>
              <button type="submit"
                class="flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
                <span class="material-symbols-outlined text-[16px]">${isEdit ? 'save' : 'add'}</span>
                ${isEdit ? 'Save Changes' : 'Create Model'}
              </button>
            </div>
          </form>
        `,
      });
      modal.open();

      const form = modal.element.querySelector('#inv-master-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = {};
        for (const [k, v] of fd.entries()) {
          const snakeKey = k.replace(/([A-Z])/g, m => '_' + m.toLowerCase());
          const numVal = parseFloat(v);
          if (v !== '' && !isNaN(numVal)) payload[snakeKey] = numVal;
          else payload[snakeKey] = (v === '' ? null : v);
        }
        // stock_category_id is required
        if (!payload.stock_category_id) {
          Toast.error('Please select a Stock Category');
          return;
        }
        try {
          if (isEdit) {
            await API.put(`${this.apiBase}/${p.id}`, payload);
          } else {
            await API.post(this.apiBase, payload);
          }
          Toast.success(isEdit ? 'Updated' : 'Created');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Failed to save');
        }
      });
    }

    async _resolveName(id, source) {
      if (!id) return null;
      try {
        const opts = await API.get(source, { limit: 200 });
        const items = opts?.items || [];
        const match = items.find(opt => opt.id === id);
        if (match) return match.name || match.label;
      } catch { /* skip */ }
      return null;
    }
  }

  /** Alternate Units page — custom form with intuitive conversion display */
  class AlternateUnitPage extends MasterPage {
    constructor() {
      super('alternate_units');
      this.inputCls = 'w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary/50 transition-all';
      this.labelCls = 'block text-sm font-medium text-on-surface mb-1.5';
    }

    // Override load to resolve base unit name from units_of_measure
    async load() {
      this.data = [];
      const tableEl = document.getElementById('inv-master-table');
      if (!tableEl) return;
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      try {
        // Load UOM options for name resolution
        let uomMap = {};
        try {
          const uomRes = await API.get('/inventory/masters/units_of_measure', { limit: 200 });
          const uomItems = uomRes?.items || [];
          uomMap = {};
          uomItems.forEach(u => { uomMap[u.id] = u.name; });
        } catch { /* skip */ }

        const params = { query: this.search, limit: this.pageSize, offset: (this.currentPage - 1) * this.pageSize };
        Object.keys(params).forEach(k => { if (!params[k] && params[k] !== 0) delete params[k]; });
        const data = await API.get(this.apiBase, params);
        const rawItems = data.items || [];
        this.data = rawItems.map(item => ({
          ...item,
          baseUnitId: item.base_unit_id || item.baseUnitId,
          conversionFactor: item.conversion_factor || item.conversionFactor,
          baseUnitName: uomMap[item.base_unit_id || item.baseUnitId] || item.base_unit_name || item.baseUnitName || '',
          rate: item.rate || 0,
          isActive: item.is_active !== undefined ? !!item.is_active : !!item.isActive,
        }));
        this.renderTable(tableEl);
      } catch (err) {
        tableEl.innerHTML = `<div class="p-6 text-center text-error"><p>Failed to load: ${err.message}</p></div>`;
      }
    }

    // Override renderTable with Alternate Unit columns
    renderTable(container) {
      let columns = [{ key: 'name', label: 'Alternate Unit' }];
      columns.push({ key: 'baseUnitName', label: 'Base / Stock Unit', render: (v) => (v || '—') });
      columns.push({
        key: 'conversionFactor', label: 'Conversion',
        render: (v, row) => {
          if (!v || v <= 0) return '—';
          const baseName = row.baseUnitName || 'unit';
          const altName = row.name || 'unit';
          return `1 ${altName} = ${v} ${baseName}`;
        }
      });
      columns.push({ key: 'rate', label: 'Rate', render: (v) => v ? `₹${parseFloat(v).toFixed(2)}` : '—' });
      columns.push({ key: 'description', label: 'Use Case', render: (v) => (v || '—') });
      columns.push({ key: 'isActive', label: 'Status', render: (v) => v ? '<span class="text-green-600">Active</span>' : '<span class="text-red-600">Inactive</span>' });
      columns.push({ key: '_actions', label: '', sortable: false, render: (v, row) => `
        <div class="flex gap-1">
          <button data-row-action="edit" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant">
            <span class="material-symbols-outlined text-[16px]">edit</span>
          </button>
          <button data-row-action="delete" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-error-container/20 flex items-center justify-center text-error">
            <span class="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      ` });

      this.table = new DataTable(container, {
        columns,
        data: this.data,
        rowActions: null,
        emptyState: 'No alternate units found',
      });

      // Wire up row action buttons
      const tbody = container.querySelector('tbody');
      if (tbody) {
        tbody.addEventListener('click', (e) => {
          const editBtn = e.target.closest('[data-row-action="edit"]');
          const delBtn = e.target.closest('[data-row-action="delete"]');
          if (editBtn) { const id = editBtn.dataset.id; const row = this.data.find(r => r.id === id); this.openForm(row); }
          if (delBtn) { const id = delBtn.dataset.id; const row = this.data.find(r => r.id === id); this.confirmDelete(row); }
        });
      }
    }

    // Override openForm with intuitive layout: Base Unit → Alternate Unit → Conversion Factor → Use Case
    async openForm(row = null) {
      const isEdit = !!row;
      const p = row || {};

      // Load UOM dropdown options
      let uomOptions = '<option value="">Select Base / Stock Unit *</option>';
      let uomMap = {};
      try {
        const opts = await API.get('/inventory/masters/units_of_measure', { limit: 200 });
        const items = opts?.items || [];
        items.forEach(opt => {
          const optId = opt.id;
          const optLabel = `${opt.name}${opt.symbol ? ' (' + opt.symbol + ')' : ''}`;
          uomOptions += `<option value="${optId}" ${optId === (p.baseUnitId || p.base_unit_id || '') ? 'selected' : ''}>${optLabel}</option>`;
          uomMap[optId] = opt.name;
        });
      } catch { /* skip */ }

      // Resolve current base unit name for edit mode
      const currentBaseUnit = (p.baseUnitId || p.base_unit_id) ?
        (uomMap[p.baseUnitId || p.base_unit_id] || p.baseUnitName || p.base_unit_name || '') : '';

      // Build initial conversion formula text
      // User's convention: "1 BOX = 10 PCS" means conversion_factor=10
      const altName = p.name || '';
      const convFactor = p.conversionFactor || p.conversion_factor || '';
      let formulaText = '—';
      if (altName && convFactor && convFactor > 0) {
        const baseForFormula = currentBaseUnit || 'unit';
        formulaText = `1 ${altName} = ${convFactor} ${baseForFormula}`;
      } else if (altName && convFactor) {
        formulaText = `1 ${altName} = ${convFactor} base unit`;
      }

      const modal = new Modal({
        title: isEdit ? 'Edit Alternate Unit' : 'Add Alternate Unit',
        size: '2xl',
        content: `
          <form id="inv-master-form" class="space-y-6">
            <!-- Section 1: Unit Mapping -->
            <div class="space-y-4">
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Unit Mapping</h3>
              <div class="grid grid-cols-2 gap-4">
                <!-- Base / Stock Unit -->
                <div>
                  <label class="${this.labelCls}">Base / Stock Unit <span class="text-error">*</span></label>
                  <select name="baseUnitId" id="au-base-unit" required
                    class="${this.inputCls}">
                    ${uomOptions}
                  </select>
                  ${currentBaseUnit ? `<p class="text-xs text-on-surface-variant/60 mt-1">Current: ${currentBaseUnit}</p>` : ''}
                </div>
                <!-- Alternate Unit -->
                <div>
                  <label class="${this.labelCls}">Alternate Unit <span class="text-error">*</span></label>
                  <input name="name" id="au-alt-unit" type="text" required
                    value="${altName || ''}"
                    placeholder="e.g. BOX, SET, PKT, CTN"
                    class="${this.inputCls}"/>
                </div>
                <!-- Conversion Factor -->
                <div class="col-span-2">
                  <label class="${this.labelCls}">Conversion Factor <span class="text-error">*</span></label>
                  <input name="conversionFactor" id="au-conv-factor" type="number" required min="0" step="0.001"
                    value="${convFactor || ''}"
                    placeholder="e.g. 10 (1 BOX = 10 PCS)"
                    class="${this.inputCls}"/>
                  <p class="text-xs text-on-surface-variant/60 mt-1">
                    How many alternate units equal one base unit.
                  </p>
                </div>
                <!-- Conversion Formula Display -->
                <div class="col-span-2">
                  <div class="p-4 bg-surface-container-low border border-outline-variant/30 rounded-xl">
                    <div class="flex items-center gap-2 text-sm font-medium text-on-surface-variant">
                      <span class="material-symbols-outlined text-[18px]">calculate</span>
                      <span>Conversion Summary</span>
                    </div>
                    <p id="au-formula-display" class="mt-2 text-lg font-medium text-on-surface">${formulaText}</p>
                    <p class="text-xs text-on-surface-variant/60 mt-1">
                      Conversion: 1 alternate unit = conversion_factor base units
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <!-- Section 2: Additional Details -->
            <div class="space-y-4">
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Additional Details</h3>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="${this.labelCls}">Rate</label>
                  <input name="rate" type="number" step="0.01"
                    value="${p.rate || ''}"
                    class="${this.inputCls}"/>
                </div>
                <div class="col-span-2">
                  <label class="${this.labelCls}">Use Case</label>
                  <textarea name="description" rows="2"
                    placeholder="e.g. Ink cartridge boxes, pendrive packs"
                    class="${this.inputCls}">${p.description || ''}</textarea>
                </div>
              </div>
            </div>

            <!-- Form actions -->
            <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
              <button type="button" data-modal-close
                class="px-4 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors">
                Cancel
              </button>
              <button type="submit"
                class="flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
                <span class="material-symbols-outlined text-[16px]">${isEdit ? 'save' : 'add'}"></span>
                ${isEdit ? 'Save Changes' : 'Create Alternate Unit'}
              </button>
            </div>
          </form>
        `,
      });
      modal.open();

      // Live conversion formula update on input/change
      const formulaEl = modal.element.querySelector('#au-formula-display');
      const altInput = modal.element.querySelector('#au-alt-unit');
      const baseSelect = modal.element.querySelector('#au-base-unit');
      const convInput = modal.element.querySelector('#au-conv-factor');

      const updateFormula = () => {
        const alt = altInput.value || 'ALT';
        const baseOpt = baseSelect.options[baseSelect.selectedIndex];
        const baseName = baseOpt ? baseOpt.text : 'base unit';
        const factor = convInput.value || '?';
        if (alt && factor && factor > 0) {
          formulaEl.textContent = `1 ${alt} = ${factor} ${baseName}`;
        } else {
          formulaEl.textContent = '—';
        }
      };

      altInput.addEventListener('input', updateFormula);
      convInput.addEventListener('input', updateFormula);
      baseSelect.addEventListener('change', updateFormula);

      const form = modal.element.querySelector('#inv-master-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = {};
        for (const [k, v] of fd.entries()) {
          const snakeKey = k.replace(/([A-Z])/g, m => '_' + m.toLowerCase());
          const numVal = parseFloat(v);
          if (v !== '' && !isNaN(numVal)) payload[snakeKey] = numVal;
          else payload[snakeKey] = (v === '' ? null : v);
        }
        // baseUnitId → base_unit_id is handled by camelCase converter
        if (!payload.base_unit_id) {
          Toast.error('Please select a Base / Stock Unit');
          return;
        }
        if (!payload.name) {
          Toast.error('Please enter an Alternate Unit name');
          return;
        }
        if (!payload.conversion_factor || payload.conversion_factor <= 0) {
          Toast.error('Please enter a valid Conversion Factor (> 0)');
          return;
        }
        try {
          if (isEdit) {
            await API.put(`${this.apiBase}/${p.id}`, payload);
          } else {
            await API.post(this.apiBase, payload);
          }
          Toast.success(isEdit ? 'Updated' : 'Created');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Failed to save');
        }
      });
    }
  }

  /** Stock Items page (special — uses /api/inventory/stocks) */
  class StockItemPage extends MasterPage {
    constructor() {
      super('stock_items');
      this.fields = [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'sku', label: 'SKU', type: 'text', required: true },
        { key: 'uomId', label: 'Unit of Measure', type: 'select', required: true, source: 'units_of_measure' },
        { key: 'categoryId', label: 'Category', type: 'select', required: false, source: 'stock_categories' },
        { key: 'groupId', label: 'Stock Group', type: 'select', required: false, source: 'stock_groups' },
        { key: 'brandId', label: 'Brand', type: 'select', required: false, source: 'brands' },
        { key: 'modelId', label: 'Model', type: 'select', required: false, source: 'models' },
        { key: 'colourId', label: 'Colour', type: 'select', required: false, source: 'colours' },
        { key: 'sizeId', label: 'Size', type: 'select', required: false, source: 'sizes' },
        { key: 'styleId', label: 'Style', type: 'select', required: false, source: 'styles' },
      ];
      // Override to use /api/inventory/stocks
        this.apiBase = '/inventory/stocks';
        this.inputCls = 'w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary/50 transition-all';
        this.labelCls = 'block text-sm font-medium text-on-surface mb-1.5';
      }

      async openForm(row = null) {
        const isEdit = !!row;
        const p = row || {};
        const si = p;
        const currencySymbol = '₹';

        // Build dropdown options from master tables
        const dropdownSources = {
          uomId: '/inventory/masters/units_of_measure',
          categoryId: '/inventory/masters/stock_categories',
          groupId: '/inventory/masters/stock_groups',
          brandId: '/inventory/masters/brands',
          modelId: '/inventory/masters/models',
          colourId: '/inventory/masters/colours',
          sizeId: '/inventory/masters/sizes',
          styleId: '/inventory/masters/styles',
        };
        const dropdownOptions = {};
        for (const [key, source] of Object.entries(dropdownSources)) {
          try {
            const opts = await API.get(source, { limit: 200 });
            const items = opts?.items || [];
            dropdownOptions[key] = items.map(opt =>
              `<option value="${opt.id}" ${opt.id === (p[key] || '') ? 'selected' : ''}>${opt.name || opt.label}</option>`
            ).join('');
          } catch {
            dropdownOptions[key] = '';
          }
        }

        // Resolve display names for UOM and Category
        const resolvedUom = await this._resolveDropdownName('uomId', p.uomId || p.uom_id, '/inventory/masters/units_of_measure');
        const resolvedCategory = await this._resolveDropdownName('categoryId', p.categoryId || p.category_id, '/inventory/masters/stock_categories');

        const modal = new Modal({
          title: isEdit ? 'Edit Stock Item' : 'Add Stock Item',
          size: '2xl',
          content: this._renderFormContent(p, isEdit, dropdownOptions, currencySymbol, resolvedUom, resolvedCategory),
        });
        modal.open();
        this._bindFormEvents(modal, p, isEdit);
      }

      _renderFormContent(p, isEdit, dropdownOptions, currencySymbol, resolvedUom, resolvedCategory) {
        return `
          <form id="inv-master-form" class="space-y-6">
            <!-- Section 1: Basic Information -->
            <div class="space-y-4">
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Basic Information</h3>
              <div class="grid grid-cols-2 gap-4">
                <div class="col-span-2">
                  <label class="${this.labelCls}">Name <span class="text-error">*</span></label>
                  <input name="name" required value="${p.name || p.name || ''}"
                    class="${this.inputCls}"/>
                </div>
                <div>
                  <label class="${this.labelCls}">SKU</label>
                  <input name="sku" value="${p.sku || ''}"
                    class="${this.inputCls}"/>
                </div>
                <div>
                  <label class="${this.labelCls}">Unit <span class="text-error">*</span></label>
                  <select name="uom_id" required
                    class="${this.inputCls}">
                    <option value="">Select Unit of Measure</option>
                    ${dropdownOptions.uomId}
                  </select>
                  ${resolvedUom ? `<p class="text-xs text-on-surface-variant/60 mt-1">Current: ${resolvedUom}</p>` : ''}
                </div>
                <div>
                  <label class="${this.labelCls}">Category</label>
                  <select name="category_id"
                    class="${this.inputCls}">
                    <option value="">Select Category</option>
                    ${dropdownOptions.categoryId}
                  </select>
                  ${resolvedCategory ? `<p class="text-xs text-on-surface-variant/60 mt-1">Current: ${resolvedCategory}</p>` : ''}
                </div>
                <div>
                  <label class="${this.labelCls}">Stock Group</label>
                  <select name="group_id"
                    class="${this.inputCls}">
                    <option value="">Select Stock Group</option>
                    ${dropdownOptions.groupId}
                  </select>
                </div>
                <div>
                  <label class="${this.labelCls}">Brand</label>
                  <select name="brand_id"
                    class="${this.inputCls}">
                    <option value="">Select Brand</option>
                    ${dropdownOptions.brandId}
                  </select>
                </div>
                <div>
                  <label class="${this.labelCls}">Model</label>
                  <select name="model_id"
                    class="${this.inputCls}">
                    <option value="">Select Model</option>
                    ${dropdownOptions.modelId}
                  </select>
                </div>
                <div>
                  <label class="${this.labelCls}">Colour</label>
                  <select name="colour_id"
                    class="${this.inputCls}">
                    <option value="">Select Colour</option>
                    ${dropdownOptions.colourId}
                  </select>
                </div>
                <div>
                  <label class="${this.labelCls}">Size</label>
                  <select name="size_id"
                    class="${this.inputCls}">
                    <option value="">Select Size</option>
                    ${dropdownOptions.sizeId}
                  </select>
                </div>
                <div>
                  <label class="${this.labelCls}">Style</label>
                  <select name="style_id"
                    class="${this.inputCls}">
                    <option value="">Select Style</option>
                    ${dropdownOptions.styleId}
                  </select>
                </div>
                <div class="col-span-2">
                  <label class="${this.labelCls}">Description</label>
                  <textarea name="description" rows="2"
                    class="${this.inputCls}">${p.description || ''}</textarea>
                </div>
              </div>
            </div>

            <!-- Section 2: Pricing -->
            <div class="space-y-4">
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Pricing</h3>
              <div class="grid grid-cols-3 gap-4">
                <div>
                  <label class="${this.labelCls}">Cost Price</label>
                  <div class="relative">
                    <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm">${currencySymbol}</span>
                    <input name="cost_price" type="number" step="0.01" value="${p.costPrice || 0}"
                      class="${this.inputCls} pl-8"/>
                  </div>
                </div>
                <div>
                  <label class="${this.labelCls}">Selling Rate</label>
                  <div class="relative">
                    <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm">${currencySymbol}</span>
                    <input name="selling_rate" type="number" step="0.01" value="${p.sellingRate || 0}"
                      class="${this.inputCls} pl-8"/>
                  </div>
                </div>
                <div>
                  <label class="${this.labelCls}">MRP</label>
                  <div class="relative">
                    <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm">${currencySymbol}</span>
                    <input name="mrp" type="number" step="0.01" value="${p.mrp || 0}"
                      class="${this.inputCls} pl-8"/>
                  </div>
                </div>
              </div>
            </div>

            <!-- Section 3: Stock Settings -->
            <div class="space-y-4">
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Stock Settings</h3>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="${this.labelCls}">Min Stock Level</label>
                  <input name="min_stock_level" type="number" step="0.01" value="${p.minStockLevel || ''}"
                    class="${this.inputCls}"/>
                </div>
                <div>
                  <label class="${this.labelCls}">Max Stock Level</label>
                  <input name="max_stock_level" type="number" step="0.01" value="${p.maxStockLevel || ''}"
                    class="${this.inputCls}"/>
                </div>
                <div class="flex items-center gap-3 p-3 rounded-xl bg-surface-container-low/50 border border-outline-variant/30">
                  <select name="is_batch_tracked"
                    class="bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">
                    <option value="1" ${p.isBatchTracked ? 'selected' : ''}>Yes</option>
                    <option value="0" ${!p.isBatchTracked ? 'selected' : ''}>No</option>
                  </select>
                  <label class="text-sm font-medium text-on-surface mb-0">Batch Tracked</label>
                </div>
                <div class="flex items-center gap-3 p-3 rounded-xl bg-surface-container-low/50 border border-outline-variant/30">
                  <select name="is_serial_tracked"
                    class="bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">
                    <option value="1" ${p.isSerialTracked ? 'selected' : ''}>Yes</option>
                    <option value="0" ${!p.isSerialTracked ? 'selected' : ''}>No</option>
                  </select>
                  <label class="text-sm font-medium text-on-surface mb-0">Serial Tracked</label>
                </div>
              </div>
            </div>

            <!-- Form actions (sticky footer) -->
            <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
              <button type="button" data-modal-close
                class="px-4 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors">
                Cancel
              </button>
              <button type="submit" id="inv-submit"
                class="flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
                <span class="material-symbols-outlined text-[16px]">${isEdit ? 'save' : 'add'}</span>
                ${isEdit ? 'Save Changes' : 'Create Stock Item'}
              </button>
            </div>
          </form>
        `;
      }

      async _resolveDropdownName(key, id, source) {
        if (!id) return null;
        try {
          const opts = await API.get(source, { limit: 200 });
          const items = opts?.items || [];
          const match = items.find(opt => opt.id === id);
          if (match) return match.name || match.label;
        } catch { /* skip */ }
        return null;
      }

    _bindFormEvents(modal, p, isEdit) {
      const form = modal.element.querySelector('#inv-master-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = {};
        for (const [k, v] of fd.entries()) {
          const snakeKey = k.replace(/([A-Z])/g, m => '_' + m.toLowerCase());
          const numVal = parseFloat(v);
          if (v !== '' && !isNaN(numVal)) payload[snakeKey] = numVal;
          else payload[snakeKey] = (v === '' ? null : v);
        }
        // Ensure required accounting fields
        payload.stock_asset_account_id = payload.stock_asset_account_id || 'acc_cash';
        payload.cogs_account_id = payload.cogs_account_id || 'acc_cogs';
        payload.inventory_variance_account_id = payload.inventory_variance_account_id || 'acc_purchases';
        payload.opening_stock_account_id = payload.opening_stock_account_id || 'acc_capital';
        payload.purchase_account_id = payload.purchase_account_id || 'acc_purchases';
        payload.sales_account_id = payload.sales_account_id || 'acc_sales';
        try {
          if (isEdit) {
            await API.put(`${this.apiBase}/${p.id}`, payload);
          } else {
            await API.post(this.apiBase, payload);
          }
          Toast.success(isEdit ? 'Updated' : 'Created');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Failed to save');
        }
      });
    }

    // Override renderTable to add View Product, tracking, and stock columns
    renderTable(container) {
      let columns = [{ key: 'name', label: 'Name' }];
      columns.push({ key: 'sku', label: 'SKU' });
      columns.push({ key: 'productName', label: 'Product', render: (v, r) => {
        if (!r.product || !r.product.id) return '<span class="font-body-xs text-on-surface-variant">—</span>';
        return '<a href="#products/' + r.product.id + '" class="font-medium hover:text-secondary">' + (v || r.product.name || '') + '</a>';
      } });
      columns.push({ key: 'uomId', label: 'UOM', render: (v) => (v || '—') });
      columns.push({ key: 'categoryId', label: 'Category', render: (v) => (v || '—') });
      columns.push({ key: 'brandId', label: 'Brand', render: (v) => (v || '—') });
      columns.push({ key: 'costPrice', label: 'Cost', render: (v) => v ? '₹' + parseFloat(v).toFixed(2) : '—' });
      columns.push({ key: 'sellingRate', label: 'Selling', render: (v) => v ? '₹' + parseFloat(v).toFixed(2) : '—' });
      columns.push({ key: 'onHandQty', label: 'On Hand', render: (v) => v ? parseFloat(v).toFixed(0) : '0' });
      columns.push({ key: 'stockValue', label: 'Value', render: (v) => v ? '₹' + parseFloat(v).toFixed(2) : '—' });
      columns.push({ key: 'isSerialTracked', label: 'Serial', render: (v) => v ? '<span class="text-blue-600">Yes</span>' : '<span class="text-on-surface-variant/40">No</span>' });
      columns.push({ key: 'isBatchTracked', label: 'Batch', render: (v) => v ? '<span class="text-purple-600">Yes</span>' : '<span class="text-on-surface-variant/40">No</span>' });
      columns.push({ key: 'isActive', label: 'Status', render: (v) => v ? '<span class="text-green-600">Active</span>' : '<span class="text-red-600">Inactive</span>' });
      columns.push({ key: '_actions', label: '', sortable: false, render: (v, row) => `
        <div class="flex gap-1">
          ${row.productId ? '<a href="#products/' + row.productId + '" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant" title="View Product"><span class="material-symbols-outlined text-[14px]">visibility</span></a>' : ''}
          <button data-row-action="edit" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant">
            <span class="material-symbols-outlined text-[16px]">edit</span>
          </button>
          <button data-row-action="delete" data-id="${row.id}" class="w-8 h-8 rounded-full hover:bg-error-container/20 flex items-center justify-center text-error">
            <span class="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      ` });

      this.table = new DataTable(container, {
        columns,
        data: this.data,
        rowActions: null,
        emptyState: 'No records found',
      });

      // Wire up row action buttons
      const tbody = container.querySelector('tbody');
      if (tbody) {
        tbody.addEventListener('click', (e) => {
          const editBtn = e.target.closest('[data-row-action="edit"]');
          const delBtn = e.target.closest('[data-row-action="delete"]');
          if (editBtn) { const id = editBtn.dataset.id; const row = this.data.find(r => r.id === id); this.openForm(row); }
          if (delBtn) { const id = delBtn.dataset.id; const row = this.data.find(r => r.id === id); this.confirmDelete(row); }
        });
      }
    }

    // Override load to map camelCase keys for display
    async load() {
      this.data = [];
      const tableEl = document.getElementById('inv-master-table');
      if (!tableEl) return;
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      try {
        const params = { query: this.search, limit: this.pageSize, offset: (this.currentPage - 1) * this.pageSize };
        Object.keys(params).forEach(k => { if (!params[k] && params[k] !== 0) delete params[k]; });
        const data = await API.get(this.apiBase, params);
        // Map snake_case to camelCase for display
        const rawItems = data.items || [];
        this.data = rawItems.map(item => ({
          ...item,
          uomId: item.uom_id || item.uomId,
          categoryId: item.category_id || item.categoryId,
          groupId: item.group_id || item.groupId,
          brandId: item.brand_id || item.brandId,
          modelId: item.model_id || item.modelId,
          colourId: item.colour_id || item.colourId,
          sizeId: item.size_id || item.sizeId,
          styleId: item.style_id || item.styleId,
          costPrice: item.cost_price || item.costPrice,
          sellingRate: item.selling_rate || item.sellingRate,
          minStockLevel: item.min_stock_level || item.minStockLevel,
          maxStockLevel: item.max_stock_level || item.maxStockLevel,
          isBatchTracked: item.is_batch_tracked !== undefined ? !!item.is_batch_tracked : !!item.isBatchTracked,
          isSerialTracked: item.is_serial_tracked !== undefined ? !!item.is_serial_tracked : !!item.isSerialTracked,
          isActive: item.is_active !== undefined ? !!item.is_active : !!item.isActive,
          productName: item.product?.name || '',
          productId: item.product?.id || item.product_id,
        }));
        this.renderTable(tableEl);
      } catch (err) {
        tableEl.innerHTML = `<div class="p-6 text-center text-error"><p>Failed to load: ${err.message}</p></div>`;
      }
    }

    // Need to convert camelCase keys to snake_case for API
    async openForm(row = null) {
      const isEdit = !!row;
      const p = row || {};
      const inputCls = 'w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40';

      const fieldsHtml = this.fields.map(f => {
        const val = p[f.key] !== undefined ? p[f.key] : '';
        const required = f.required ? 'required' : '';
        const labelCls = 'block font-label-md text-label-md text-on-surface-variant uppercase mb-1';
        if (f.type === 'select') {
          return `<div><label class="${labelCls}">${f.label}</label><select name="${f.key}" ${required} class="${inputCls}"><option value="">Select ${f.label}</option></select></div>`;
        }
        return `<div><label class="${labelCls}">${f.label}</label><input name="${f.key}" type="${f.type}" ${required} value="${val || ''}" class="${inputCls}"></div>`;
      }).join('');

      const extraFields = `
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label>
          <textarea name="description" type="text" class="${inputCls}" rows="2">${p.description || p.desc || ''}</textarea></div>
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Cost Price</label>
          <input name="cost_price" type="number" step="0.01" value="${p.costPrice || ''}" class="${inputCls}"></div>
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Selling Rate</label>
          <input name="selling_rate" type="number" step="0.01" value="${p.sellingRate || ''}" class="${inputCls}"></div>
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">MRP</label>
          <input name="mrp" type="number" step="0.01" value="${p.mrp || ''}" class="${inputCls}"></div>
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Min Stock Level</label>
          <input name="min_stock_level" type="number" step="0.01" value="${p.minStockLevel || ''}" class="${inputCls}"></div>
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Max Stock Level</label>
          <input name="max_stock_level" type="number" step="0.01" value="${p.maxStockLevel || ''}" class="${inputCls}"></div>
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Batch Tracked</label>
          <select name="is_batch_tracked" class="${inputCls}">
            <option value="1" ${p.isBatchTracked ? 'selected' : ''}>Yes</option><option value="0" ${!p.isBatchTracked ? 'selected' : ''}>No</option>
          </select></div>
        <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Serial Tracked</label>
          <select name="is_serial_tracked" class="${inputCls}">
            <option value="1" ${p.isSerialTracked ? 'selected' : ''}>Yes</option><option value="0" ${!p.isSerialTracked ? 'selected' : ''}>No</option>
          </select></div>
      `;

      const modal = new Modal({
        title: isEdit ? 'Edit Stock Item' : 'Add Stock Item',
        size: 'xl',
        content: `<form id="inv-master-form" class="grid grid-cols-2 gap-stack-md">${fieldsHtml}${extraFields}
          <div class="col-span-2 flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save</button>
          </div>
        </form>`,
      });
      modal.open();

      // Load dropdown options
      const selectFields = [
        { key: 'uomId', label: 'Unit of Measure', source: '/inventory/masters/units_of_measure' },
        { key: 'categoryId', label: 'Category', source: '/inventory/masters/stock_categories' },
        { key: 'groupId', label: 'Stock Group', source: '/inventory/masters/stock_groups' },
        { key: 'brandId', label: 'Brand', source: '/inventory/masters/brands' },
        { key: 'modelId', label: 'Model', source: '/inventory/masters/models' },
        { key: 'colourId', label: 'Colour', source: '/inventory/masters/colours' },
        { key: 'sizeId', label: 'Size', source: '/inventory/masters/sizes' },
        { key: 'styleId', label: 'Style', source: '/inventory/masters/styles' },
      ];
      for (const sf of selectFields) {
        const select = modal.element.querySelector(`select[name="${sf.key}"]`);
        if (select) {
          try {
            const opts = await API.get(sf.source, { limit: 200 });
            const items = opts.items || [];
            let html = `<option value="">Select ${sf.label}</option>`;
            items.forEach(opt => {
              const optId = opt.id;
              const optName = opt.name || opt.label;
              html += `<option value="${optId}" ${optId === (p[sf.key] || '') ? 'selected' : ''}>${optName}</option>`;
            });
            select.innerHTML = html;
          } catch { /* skip */ }
        }
      }

      const form = modal.element.querySelector('#inv-master-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        // Convert to snake_case for API
        const payload = {};
        for (const [k, v] of fd.entries()) {
          const snakeKey = k.replace(/([A-Z])/g, m => '_' + m.toLowerCase());
          const numVal = parseFloat(v);
          if (v !== '' && !isNaN(numVal)) payload[snakeKey] = numVal;
          else payload[snakeKey] = (v === '' ? null : v);  // empty select → null (avoids FK failure)
        }
        // Ensure required accounting fields
        if (!isEdit) {
          payload.stock_asset_account_id = payload.stock_asset_account_id || 'acc_cash';
          payload.cogs_account_id = payload.cogs_account_id || 'acc_cogs';
          payload.inventory_variance_account_id = payload.inventory_variance_account_id || 'acc_purchases';
          payload.opening_stock_account_id = payload.opening_stock_account_id || 'acc_capital';
          payload.purchase_account_id = payload.purchase_account_id || 'acc_purchases';
          payload.sales_account_id = payload.sales_account_id || 'acc_sales';
          payload.is_active = 1;
        }
        try {
          if (isEdit) {
            await API.put(`${this.apiBase}/${row.id}`, payload);
          } else {
            await API.post(this.apiBase, payload);
          }
          Toast.success(isEdit ? 'Updated' : 'Created');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Failed to save');
        }
      });
    }
  }

  /** Transaction page */
  class TransactionPage {
    constructor(key) {
      this.key = key;
      this.label = CARD_LABELS[key] || key;
      this.voucherType = TX_VOUCHER_TYPES[key] || key;
      this.isPhysicalStock = key === 'physical_stock';
    }

    async render(container) {
      container.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'flex items-center justify-between mb-stack-lg';
      header.innerHTML = `
        <div><h1 class="font-display text-h1 text-on-surface tracking-tight">${this.label}</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Create and manage ${this.label.toLowerCase()} vouchers</p></div>
        <button id="inv-tx-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
          <span class="material-symbols-outlined text-[18px]">add</span> New Voucher
        </button>
      `;
      container.appendChild(header);

      const content = document.createElement('div');
      content.className = 'space-y-4';
      content.innerHTML = `
        <div id="inv-tx-table" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30"></div>
        <div id="inv-tx-pagination" class="flex justify-end"></div>
      `;
      container.appendChild(content);

      container.querySelector('#inv-tx-new').addEventListener('click', () => this.openForm());
      await this.load();
    }

    async load() {
      const tableEl = document.getElementById('inv-tx-table');
      if (!tableEl) return;
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      try {
        const data = await API.get('/inventory/vouchers', { voucher_type: this.voucherType, limit: 100 });
        const items = data.items || [];
        this.renderTable(tableEl, items);
        this.vouchers = items;
      } catch (err) {
        tableEl.innerHTML = `<div class="p-6 text-center text-error"><p>Failed: ${err.message}</p></div>`;
      }
    }

    renderTable(container, items) {
      const columns = [
        { key: 'voucherNumber', label: 'Voucher #' },
        { key: 'voucherDate', label: 'Date' },
        { key: 'narration', label: 'Narration' },
        { key: 'status', label: 'Status', render: (v) => `<span class="material-symbols-outlined">${v === 'posted' ? 'check_circle' : v === 'draft' ? 'draft' : 'cancel'}</span> ${v}` },
      ];
      if (!this.isPhysicalStock) {
        columns.push({ key: '_actions', label: '', sortable: false, render: (v, row) => `
          <div class="flex gap-1">
            ${row.status === 'draft' ? `<button data-tx-action="post" data-vn="${row.voucherNumber}" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[14px]">publish</span></button>` : ''}
            ${row.status === 'posted' ? `<button data-tx-action="cancel" data-vn="${row.voucherNumber}" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[14px]">cancel</span></button>` : ''}
          </div>
        ` });
      }
      this.table = new DataTable(container, { columns, data: items, emptyState: 'No vouchers' });
      const tbody = container.querySelector('tbody');
      if (tbody) {
        tbody.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-tx-action]');
          if (!btn) return;
          const vn = btn.dataset.vn;
          const action = btn.dataset.txAction;
          if (action === 'post') {
            try { await API.post(`/inventory/vouchers/${encodeURIComponent(vn)}/post`); Toast.success('Posted'); this.load(); }
            catch (err) { Toast.error(err.message || 'Post failed'); }
          }
          if (action === 'cancel') {
            try { await API.post(`/inventory/vouchers/${encodeURIComponent(vn)}/cancel`); Toast.success('Cancelled'); this.load(); }
            catch (err) { Toast.error(err.message || 'Cancel failed'); }
          }
        });
      }
    }

    async openForm(row = null) {
      let items = [];
      try {
        const res = await API.get('/inventory/stocks', { limit: 200 });
        items = res.items || [];
      } catch { /* skip */ }

      let godowns = [];
      try {
        const res = await API.get('/inventory/masters/godowns', { limit: 200 });
        godowns = res.items || [];
      } catch { /* skip */ }

      // Add "View Product" link in item dropdown options
      const itemOptions = items.map(i => {
        const productInfo = i.product ? ` — <a href="#products/${i.product.id}" class="text-secondary hover:underline">${i.product.name}</a>` : '';
        return `<option value="${i.id}">${i.name} (${i.sku})${productInfo}</option>`;
      }).join('');
      const godownOptions = godowns.map(g => `<option value="${g.id}">${g.name}</option>`).join('');

      const modal = new Modal({
        title: `New ${this.label} Voucher`,
        size: 'xl',
        content: `<form id="inv-tx-form" class="grid grid-cols-2 gap-stack-md">
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date</label>
            <input name="voucher_date" type="date" required value="${new Date().toISOString().split('T')[0]}"
              class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none"></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Narration</label>
            <input name="narration" type="text" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none"></div>
          <div class="col-span-2"><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Item</label>
            <select name="item_id" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none">
              <option value="">Select Item</option>${itemOptions}
            </select></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Quantity</label>
            <input name="quantity" type="number" step="0.001" required value="1"
              class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none"></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Rate</label>
            <input name="unit_rate" type="number" step="0.01" required value="0"
              class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none"></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Source Godown</label>
            <select name="source_godown_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none">${godownOptions}</select></div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Dest Godown</label>
            <select name="dest_godown_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none">${godownOptions}</select></div>
          <div class="col-span-2 flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save Draft</button>
          </div>
        </form>`,
      });
      modal.open();

      const form = modal.element.querySelector('#inv-tx-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const item = items.find(i => i.id === fd.get('item_id'));
        const qty = parseFloat(fd.get('quantity')) || 0;
        const rate = parseFloat(fd.get('unit_rate')) || 0;
        const payload = {
          voucher_type: this.voucherType,
          voucher_date: fd.get('voucher_date'),
          narration: fd.get('narration'),
          source_type: this.voucherType === 'stock_inward' ? 'inward' : this.voucherType === 'stock_outward' ? 'outward' : 'other',
          lines: [{
            item_id: fd.get('item_id'),
            uom_id: item ? (item.uomId || item.uom_id) : null,
            quantity: qty,
            unit_rate: rate,
            amount: qty * rate,
            source_godown_id: fd.get('source_godown_id') || null,
            dest_godown_id: fd.get('dest_godown_id') || null,
            is_source: this.voucherType === 'stock_outward' ? 1 : 0,
          }]
        };
        try {
          const res = await API.post('/inventory/vouchers', payload);
          Toast.success('Draft saved');
          modal.close();
          this.load();
        } catch (err) {
          Toast.error(err.message || 'Failed to save');
        }
      });
    }
  }

  /** Report viewer page */
  class ReportPage {
    constructor(key) {
      this.key = key;
      this.label = CARD_LABELS[key] || key;
      this.apiPath = REPORT_API_MAP[key];
    }

    async render(container) {
      container.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'mb-stack-lg';
      header.innerHTML = `<h1 class="font-display text-h1 text-on-surface tracking-tight">${this.label}</h1>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Report view</p>`;
      container.appendChild(header);

      const tableEl = document.createElement('div');
      tableEl.id = 'inv-report-table';
      tableEl.className = 'bg-surface-container-lowest rounded-xl border border-outline-variant/30';
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      container.appendChild(tableEl);

      await this.load();
    }

    async load() {
      const tableEl = document.getElementById('inv-report-table');
      if (!tableEl) return;
      tableEl.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span></div>';
      try {
        const data = await API.get(this.apiPath);
        const items = data.items || [];
        // Friendly column labels: split camelCase, drop internal ids
        const HIDDEN_KEYS = ['id', 'itemId', 'item_id', 'batchId', 'batch_id', 'godownId', 'locationId', 'companyId'];
        const CURRENCY_KEYS = ['purchaseRate', 'mrp', 'sellingRate', 'avgRate', 'totalValue'];
        const humanize = (k) => k
          .replace(/_/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/^./, c => c.toUpperCase());
        const first = items[0] || {};
        const columns = Object.keys(first)
          .filter(k => !HIDDEN_KEYS.includes(k))
          .map(k => ({
            key: k,
            label: humanize(k),
            render: CURRENCY_KEYS.includes(k)
              ? (v) => (v === null || v === undefined ? '—' : '₹' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
              : undefined,
          }));
        if (!columns.length) columns.push({ key: 'info', label: 'Info' });
        new DataTable(tableEl, { columns, data: items, emptyState: 'No data' });
      } catch (err) {
        tableEl.innerHTML = `<div class="p-6 text-center text-error"><p>Failed: ${err.message}</p></div>`;
      }
    }
  }

  /** Module init — called by app.js router when route matches */
  function init(arg) {
    return new Promise((resolve) => {
      // arg is the hash path: e.g., 'inventory/stock_groups'
      const parts = arg ? arg.split('/') : [];
      // parts[0] is 'inventory', parts[1] is the card key
      const key = parts[1];
      if (!key) {
        // No specific key — fall back to inventory dashboard
        if (window.PageModules.inventory && window.PageModules.inventory.init) {
          resolve(window.PageModules.inventory.init());
        } else {
          resolve(() => {});
        }
        return;
      }

      const masterKeys = ['stock_groups', 'stock_categories',
        'brands', 'models', 'alternate_units', 'units_of_measure',
        'colours', 'sizes', 'styles', 'rate', 'price_levels'];
      const txKeys = ['opening_stock', 'stock_inward', 'stock_outward', 'stock_transfer',
        'stock_adjustment', 'physical_stock', 'stock_journal'];
      const reportKeys = ['stock_valuation', 'batch_management', 'expiry_management',
        'manufacturing_date', 'expiry_date', 'serial_number_tracking',
        'godown_wise_stock', 'location_wise_stock', 'batch_wise_stock_mgmt',
        'batch_wise_stock'];

      let page;
      if (masterKeys.includes(key) || key === 'stock_items') {
        if (key === 'stock_categories') page = new StockCategoryPage();
        else if (key === 'models') page = new ModelPage();
        else if (key === 'alternate_units') page = new AlternateUnitPage();
        // Stock items need their own page: the generic MasterPage renders only
        // a name field and posts to /inventory/masters/stock_items, so uom_id,
        // group_id, brand_id, pricing and tracking flags were all unreachable.
        // StockItemPage (defined below) renders the real form and posts to
        // /inventory/stocks. It was written but never registered here, which is
        // why the dashboard card rendered a name-only form.
        else if (key === 'stock_items') page = new StockItemPage();
        else page = new MasterPage(key);
      } else if (txKeys.includes(key)) {
        page = new TransactionPage(key);
      } else if (reportKeys.includes(key)) {
        page = new ReportPage(key);
      } else {
        // Fallback to master page for unknown keys
        page = new MasterPage(key);
      }

      const container = document.createElement('div');
      const main = document.getElementById('page-container');
      if (!main) {
        resolve(() => {});
        return;
      }
      main.innerHTML = '';
      main.appendChild(container);

      page.render(container).then(() => {
        resolve(() => {
          if (container.parentNode) container.parentNode.removeChild(container);
        });
      }).catch((err) => {
        console.error('[inventory-sub]', err);
        main.innerHTML = `<div class="p-6"><p class="text-error">Failed to load: ${err.message}</p></div>`;
        resolve(() => {});
      });
    });
  }

  // Register
  window.PageModules = window.PageModules || {};
  window.PageModules.inventorySub = { init };
})();