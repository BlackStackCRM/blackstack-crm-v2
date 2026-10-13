window.PageModules = window.PageModules || {};

window.PageModules.products = {
  table: null,
  pagination: null,
  currentCurrency: 'INR',
  state: { page: 1, pageSize: 20, search: '', category: '', status: '', brand: '' },
  searchTimer: null,
  categories: [],
  uoms: [],
  brands: [],
  models: [],

  async init(arg) {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    // Load settings + inventory masters in parallel
    try {
      const [settings, cats, uoms, brands, models] = await Promise.allSettled([
        API.get('/settings'),
        API.get('/inventory/masters/stock_categories', { limit: 200 }),
        API.get('/inventory/masters/units_of_measure', { limit: 200 }),
        API.get('/inventory/masters/brands', { limit: 200 }),
        API.get('/inventory/masters/models', { limit: 200 }),
      ]);
      this.currentCurrency = settings.status === 'fulfilled' ? (settings.value?.defaultCurrency || 'INR') : 'INR';
      if (cats.status === 'fulfilled') this.categories = cats.value.items || [];
      if (uoms.status === 'fulfilled') this.uoms = uoms.value.items || [];
      if (brands.status === 'fulfilled') this.brands = brands.value.items || [];
      if (models.status === 'fulfilled') this.models = models.value.items || [];
    } catch { /* use defaults */ }

    const productId = arg ? arg.split('/').pop() : null;

    if (productId) {
      return this.renderDetail(productId);
    }

    this.renderList(main);
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  // ─── LIST VIEW ──────────────────────────────────────────────────────────

  renderList(container) {
    container.innerHTML = [
      // Header
      '<div class="flex items-center justify-between mb-8">',
        '<div>',
          '<h1 class="text-2xl font-semibold text-on-surface tracking-tight">Products</h1>',
          '<p class="text-sm text-on-surface-variant mt-1">Manage products, pricing, inventory tracking, and product information.</p>',
        '</div>',
        '<button id="prod-new" class="flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 transition-colors">',
          '<span class="material-symbols-outlined text-[18px]">add</span> New Product',
        '</button>',
      '</div>',

      // Top actions
      '<div class="flex flex-wrap items-center gap-3 mb-6">',
        '<div class="relative flex-1 min-w-[240px]">',
          '<span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-[18px]">search</span>',
          '<input id="prod-search" placeholder="Search products..." class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl py-2.5 pl-10 pr-4 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary/50 transition-all"/>',
        '</div>',
        '<select id="prod-category" class="bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">',
          '<option value="">All Categories</option>',
        '</select>',
        '<select id="prod-status" class="bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">',
          '<option value="">All Status</option><option value="active">Active</option><option value="inactive">Inactive</option>',
        '</select>',
        '<select id="prod-brand" class="bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">',
          '<option value="">All Brands</option>',
        '</select>',
        '<button id="prod-import" class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-container-high text-on-surface-variant hover:text-on-surface text-body-sm transition-colors">',
          '<span class="material-symbols-outlined text-[16px]">file_upload</span> Import',
        '</button>',
        '<button id="prod-export" class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-container-high text-on-surface-variant hover:text-on-surface text-body-sm transition-colors">',
          '<span class="material-symbols-outlined text-[16px]">file_download</span> Export',
        '</button>',
      '</div>',

      // Table container
      '<div id="products-table" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 overflow-hidden"></div>',
      '<div id="products-pagination" class="mt-4"></div>',
    ].join('');

    this.bindEvents();
  },

  bindEvents() {
    const newBtn = document.getElementById('prod-new');
    if (newBtn) newBtn.addEventListener('click', () => this.openForm());

    const searchInput = document.getElementById('prod-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
          this.state.search = e.target.value;
          this.state.page = 1;
          this.load();
        }, 300);
      });
    }

    const catSelect = document.getElementById('prod-category');
    if (catSelect) {
      this.populateCategoryFilter(catSelect);
      catSelect.addEventListener('change', (e) => {
        this.state.category = e.target.value;
        this.state.page = 1;
        this.load();
      });
    }

    const statusSelect = document.getElementById('prod-status');
    if (statusSelect) {
      statusSelect.addEventListener('change', (e) => {
        this.state.status = e.target.value;
        this.state.page = 1;
        this.load();
      });
    }

    const brandSelect = document.getElementById('prod-brand');
    if (brandSelect) {
      this.populateBrandFilter(brandSelect);
      brandSelect.addEventListener('change', (e) => {
        this.state.brand = e.target.value;
        this.state.page = 1;
        this.load();
      });
    }
  },

  populateCategoryFilter(select) {
    if (!select) return;
    let html = '<option value="">All Categories</option>';
    html += '<option value="">All</option>';
    this.categories.forEach(cat => {
      html += `<option value="${cat.id}">${cat.name}</option>`;
    });
    select.innerHTML = html;
  },

  populateBrandFilter(select) {
    if (!select) return;
    let html = '<option value="">All Brands</option>';
    this.brands.forEach(brand => {
      html += `<option value="${brand.id}">${brand.name}</option>`;
    });
    select.innerHTML = html;
  },

  async load() {
    const container = document.getElementById('products-table');
    if (!container) return;
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant/60">progress_activity</span></div>';
    try {
      const params = {
        page: this.state.page, pageSize: this.state.pageSize,
        search: this.state.search, category: this.state.category, status: this.state.status,
        brand: this.state.brand
      };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/products', params);

      // Handle response shapes: { items, pagination: { total } } or { data: [...], total }
      let items, total;
      if (res?.items) {
        items = res.items;
        total = res.pagination?.total || res.total || items.length;
      } else if (res?.data && Array.isArray(res.data)) {
        items = res.data;
        total = res.total || res.pagination?.total || items.length;
      } else if (Array.isArray(res)) {
        items = res;
        total = items.length;
      } else {
        items = [];
        total = 0;
      }

      this.renderTable(container, items, total);
    } catch (err) {
      container.innerHTML = `<div class="p-12 text-center"><p class="text-error">Failed to load products</p></div>`;
    }
  },

  renderTable(container, items, total) {
    const fmt = (n) => Currency.format(n, this.currentCurrency);
    const marginPct = (price, cost) => {
      if (!price || !cost || price === 0) return '—';
      return Math.round(((price - cost) / price) * 100) + '%';
    };

    if (!items.length) {
      container.innerHTML = `
        <div class="p-12 text-center flex flex-col items-center gap-3">
          <span class="material-symbols-outlined text-[48px] text-on-surface-variant/30">inventory_2</span>
          <p class="text-lg font-medium text-on-surface">No products found</p>
          <p class="text-sm text-on-surface-variant">Create your first product to start managing your catalog.</p>
          <button id="prod-empty-new" class="mt-2 flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 transition-colors">
            <span class="material-symbols-outlined text-[18px]">add</span> Create Product
          </button>
        </div>
      `;
      const btn = container.querySelector('#prod-empty-new');
      if (btn) btn.addEventListener('click', () => this.openForm());
      return;
    }

    const columns = [
      {
        key: 'name', label: 'Product', className: 'w-[260px]',
        render: (v, r) => `
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-surface-container-high flex-shrink-0 flex items-center justify-center">
              <span class="material-symbols-outlined text-[18px] text-on-surface-variant/60">inventory_2</span>
            </div>
            <div class="min-w-0 flex-1">
              <a href="#products/${r.id}" class="font-medium text-on-surface hover:text-secondary transition-colors">${this.escapeHtml(v || '')}</a>
              ${r.sku ? `<div class="text-xs text-on-surface-variant/70">${this.escapeHtml(r.sku)}</div>` : ''}
            </div>
          </div>
        `
      },
      { key: 'sku', label: 'SKU', className: 'w-[120px]', render: (v) => `<span class="font-mono text-sm text-on-surface-variant/70">${v || '—'}</span>` },
      {
        key: 'category', label: 'Category', className: 'w-[140px]',
        render: (v) => `<span class="text-sm text-on-surface-variant">${this.escapeHtml(v || '—')}</span>`
      },
      {
        key: 'modelName', label: 'Model', className: 'w-[140px]',
        render: (v) => `<span class="text-sm text-on-surface-variant">${this.escapeHtml(v || '—')}</span>`
      },
      {
        key: 'brandName', label: 'Brand', className: 'w-[130px]',
        render: (v) => `<span class="text-sm text-on-surface-variant">${this.escapeHtml(v || '—')}</span>`
      },
      { key: 'price', label: 'Price', align: 'right', className: 'w-[100px]', render: (v) => `<span class="font-mono text-sm">${fmt(v)}</span>` },
      { key: 'cost', label: 'Cost', align: 'right', className: 'w-[100px]', render: (v) => `<span class="font-mono text-sm text-on-surface-variant/70">${fmt(v)}</span>` },
      {
        key: 'margin', label: 'Margin', align: 'right', className: 'w-[80px]',
        render: (_, r) => {
          const m = marginPct(r.price, r.cost);
          if (m === '—') return '<span class="text-sm text-on-surface-variant">—</span>';
          const num = parseInt(m);
          const colorClass = num > 30 ? 'text-green-600' : num > 10 ? 'text-amber-600' : 'text-red-600';
          return `<span class="text-sm ${colorClass}">${m}</span>`;
        }
      },
      {
        key: 'inventory', label: 'Inventory', className: 'w-[140px]',
        render: (_, r) => {
          const hasStockItem = !!r.stockItemId || !!r.stock_item_id;
          if (hasStockItem) {
            return '<span class="inline-flex items-center gap-1 text-sm"><span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>Tracked</span>';
          }
          return '<span class="text-sm text-on-surface-variant/60">Not Tracked</span>';
        }
      },
      {
        key: 'isActive', label: 'Status', className: 'w-[90px]',
        render: (v) => StatusBadge.render(v ? 'active' : 'inactive')
      },
    ];

    this.table = new DataTable(container, {
      columns,
      data: items,
      sortable: true,
      emptyState: 'No products found',
      rowActions: (row) => this.openRowMenu(row),
    });

    const totalPages = Math.max(1, Math.ceil(total / this.state.pageSize));
    if (!this.pagination) {
      this.pagination = new Pagination(document.getElementById('products-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: totalPages,
        onPageChange: (p) => { this.state.page = p; this.load(); },
      });
    } else {
      this.pagination.update({ page: this.state.page, totalItems: total, totalPages: totalPages });
    }
  },

  openRowMenu(row) {
    const items = [
      { label: 'View', icon: 'visibility', action: () => window.location.hash = `#products/${row.id}` },
      { label: 'Edit', icon: 'edit', action: () => this.openForm(row) },
      { label: 'Inventory', icon: 'warehouse', action: () => window.location.hash = `#inventory/stock_items` },
      { label: row.isActive ? 'Deactivate' : 'Activate', icon: 'toggle_on', action: () => this.toggleStatus(row) },
      { label: 'Delete', icon: 'delete', action: () => this.confirmDelete(row) },
    ];

    const itemsHtml = items.map(item => `
      <button data-act="${item.label}" class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-container text-left w-full">
        <span class="material-symbols-outlined text-[18px] text-on-surface-variant/60">${item.icon}</span>
        <span>${item.label}</span>
      </button>
    `).join('');

    const modal = new Modal({
      title: row.name,
      size: 'sm',
      content: `<div class="flex flex-col gap-1">${itemsHtml}</div>`
    });
    modal.open();
    modal.element.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const action = btn.dataset.act;
      modal.close();
      const item = items.find(i => i.label === action);
      if (item) await item.action();
    });
  },

  async toggleStatus(row) {
    try {
      await API.put('/products/' + row.id, { is_active: row.isActive ? 0 : 1 });
      Toast.success('Product ' + (row.isActive ? 'deactivated' : 'activated'));
      this.load();
    } catch (err) {
      this.showFriendlyError(err);
    }
  },

  // ─── CREATE / EDIT FORM ───────────────────────────────────────────────

  /**
   * Open the product creation/edit form.
   * Implements the spec: simple form with progressive disclosure of inventory fields.
   */
  openForm(row = null) {
    const isEdit = !!row;
    const p = row || {};
    const si = p.stockItem || {};

    // Build model options from existing master data
    // Display hierarchy: Stock Group → Stock Category → Brand → Model
    // Models are filtered by selected Brand
    const currentModelId = p.model_id || p.modelId || si.model_id || si.modelId || '';
    const currentBrandId = p.brand_id || p.brandId || si.brand_id || si.brandId || '';

    const filterModels = (brandId) => {
      if (!brandId) return this.models.filter(m => m.id);
      return this.models.filter(m => m.id && (m.brand_id === brandId || m.brandId === brandId));
    };

    const buildModelOptions = (modelList, selectedId) => {
      let opts = '<option value="">Select Model</option>';
      modelList.sort((a, b) => {
        const aGroup = a.stockGroupName || '';
        const bGroup = b.stockGroupName || '';
        const aCat = a.stockCategoryName || '';
        const bCat = b.stockCategoryName || '';
        const aBrand = a.brandName || '';
        const bBrand = b.brandName || '';
        if (aGroup !== bGroup) return aGroup.localeCompare(bGroup);
        if (aCat !== bCat) return aCat.localeCompare(bCat);
        if (aBrand !== bBrand) return aBrand.localeCompare(bBrand);
        return (a.name || '').localeCompare(b.name || '');
      });
      modelList.forEach(model => {
        if (!model.id) return;
        const group = model.stockGroupName;
        const cat = model.stockCategoryName;
        const brand = model.brandName;
        const modelName = model.name;
        let display = '';
        if (group && cat && brand) {
          display = `${group} › ${cat} › ${brand} › ${modelName}`;
        } else if (brand) {
          display = `${brand} › ${modelName}`;
        } else {
          display = `${modelName}`;
        }
        const selected = model.id === selectedId ? 'selected' : '';
        opts += `<option value="${model.id}" ${selected}>${this.escapeHtml(display)}</option>`;
      });
      return opts;
    };

    let modelOptions = buildModelOptions(filterModels(currentBrandId), currentModelId);

    // Build UOM options from existing master data — do NOT hardcode
    let uomOptions = '<option value="">Auto-select (first active)</option>';
    this.uoms.forEach(uom => {
      uomOptions += `<option value="${uom.id}" ${uom.id === (si.uomId || si.uom_id || p.uomId || p.uom_id) ? 'selected' : ''}>${this.escapeHtml(uom.name)} (${uom.symbol})</option>`;
    });

    // Determine if inventory tracking is on (for edit mode)
    const trackInventory = isEdit ? (!!p.stockItemId || !!p.stockItem) : false;
    const serialTracked = !!(si.isSerialTracked || p.isSerialTracked);
    const batchTracked = !!(si.isBatchTracked || p.isBatchTracked);

    // Load hierarchy data for edit mode — will be populated async
    const currentLocationId = si.locationId || si.location_id || p.locationId || p.location_id || '';
    const currentGodownId = si.godownId || si.godown_id || p.godownId || p.godown_id || '';

    const hierarchyHtml = `
      <div id="prod-inventory-hierarchy" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-on-surface mb-1.5">Location</label>
            <select name="location_id" id="prod-location"
              class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">
              <option value="">Select Location</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-on-surface mb-1.5">Godown</label>
            <select name="godown_id" id="prod-godown"
              class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">
              <option value="">Select Godown</option>
            </select>
          </div>
        </div>
      </div>
    `;

    // Resolve current UOM display
    let currentUom = '—';
    const resolvedUomId = si.uomId || si.uom_id || p.uomId || p.uom_id;
    if (resolvedUomId) {
      const uom = this.uoms.find(u => u.id === resolvedUomId);
      if (uom) currentUom = `${uom.name} (${uom.symbol})`;
    }

    // Opening quantity — default 1 for new products
    const openingQty = isEdit ? (p.openingStock || p.opening_stock || si.onHandQty || si.on_hand_qty || 1) : 1;

    // Build hierarchy path display for edit mode
    const currentHierarchyPath = this._buildHierarchyPath(p, si);
    const editModelId = p.model_id || p.modelId || si.model_id || si.modelId || '';

    const modal = new Modal({
      title: isEdit ? 'Edit Product' : 'New Product',
      size: '2xl',
      content: this.renderFormContent(p, isEdit, modelOptions, uomOptions, currentUom, trackInventory, serialTracked, batchTracked, openingQty, undefined, hierarchyHtml, currentHierarchyPath),
    });
    modal.open();

    // Brand change → filter Model dropdown
    const brandSelect = modal.element.querySelector('#prod-brand-select');
    const modelSelect = modal.element.querySelector('#prod-model');
    if (brandSelect && modelSelect) {
      brandSelect.addEventListener('change', () => {
        const selectedBrand = brandSelect.value;
        const filtered = this.models.filter(m => !selectedBrand || m.brand_id === selectedBrand || m.brandId === selectedBrand);
        let html = '<option value="">Select Model</option>';
        filtered.sort((a, b) => {
          const aBrand = a.brandName || '';
          const bBrand = b.brandName || '';
          if (aBrand !== bBrand) return aBrand.localeCompare(bBrand);
          return (a.name || '').localeCompare(b.name || '');
        }).forEach(model => {
          const modelName = model.name;
          const brandName = model.brandName || '';
          const display = brandName ? `${brandName} › ${modelName}` : modelName;
          html += `<option value="${model.id}">${this.escapeHtml(display)}</option>`;
        });
        modelSelect.innerHTML = html;
        // Clear hierarchy display when brand/model changes
        this._clearHierarchyDisplay(modal);
      });
    }

    // For edit mode, pre-fetch hierarchy if model is selected
    if (editModelId) {
      this._preloadHierarchy(modal, editModelId).then(data => {
        if (data && data.id) {
          const pathModel = modal.element.querySelector('#prod-path-model');
          const pathGroup = modal.element.querySelector('#prod-path-group');
          const pathCategory = modal.element.querySelector('#prod-path-category');
          const pathBrand = modal.element.querySelector('#prod-path-brand');
          const pathText = modal.element.querySelector('#prod-path-text');
          const hierarchyPathDiv = modal.element.querySelector('#prod-model-hierarchy-path');
          const modelError = modal.element.querySelector('#prod-model-error');
          if (data.stockGroupName && pathGroup) pathGroup.textContent = data.stockGroupName;
          if (data.stockCategoryName && pathCategory) pathCategory.textContent = data.stockCategoryName;
          if (data.brandName && pathBrand) pathBrand.textContent = data.brandName;
          if (data.modelName && pathModel) pathModel.textContent = data.modelName;
          if (pathText) pathText.textContent = [data.stockGroupName, data.stockCategoryName, data.brandName, data.modelName].filter(Boolean).join(' → ') || '';
          if (hierarchyPathDiv) hierarchyPathDiv.classList.remove('hidden');
          if (modelError) modelError.classList.toggle('hidden', data.hasCompleteHierarchy);
          // Store the hierarchy data for the submit handler
          const modelSelect = modal.element.querySelector('select[name="model_id"]');
          modelSelect._hierarchyData = data;
        }
      }).catch(() => {});
    }

    // If editing with serial tracking, load existing serial numbers
    if (isEdit && p.stockItemId && serialTracked) {
      this._loadExistingSerials(modal, p.stockItemId, p.id, openingQty);
    }

    // Load hierarchy dropdowns — populate dependent selects
    this._loadHierarchyDropdowns(modal, currentLocationId, currentGodownId);

    this.bindFormEvents(modal, p, isEdit, trackInventory, serialTracked, batchTracked, openingQty, isEdit && serialTracked);
  },

  /**
   * Render the form HTML per the spec:
   * 1. Basic Information: Product Name, Opening Quantity, SKU, Brand → Model + path, Status
   * 2. Pricing: Cost Price, Selling Price (with live margin display)
   * 3. Inventory: Track Inventory toggle → reveals Location → Godown hierarchy,
   *    Serial Number Tracking toggle, dynamic serial inputs, and collapsible Batch Tracking
   */
  renderFormContent(p, isEdit, modelOptions, uomOptions, currentUom, trackInventory, serialTracked, batchTracked, openingQty, existingSerials, hierarchyHtml = '', currentHierarchyPath = '') {
    const serialListHtml = this._renderSerialInputs(
      serialTracked ? Math.max(1, openingQty) : 0,
      existingSerials || []
    );

    return `
      <form id="prod-form" class="space-y-6">
        <!-- Section 1: Basic Information -->
        <div class="space-y-4">
          <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Basic Information</h3>
          <div class="grid grid-cols-2 gap-4">
            <div class="col-span-2">
              <label class="block text-sm font-medium text-on-surface mb-1.5">Product Name <span class="text-error">*</span></label>
              <input name="name" required value="${this.escapeHtml(p.name || '')}"
                class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary/50 transition-all"/>
            </div>
            <div>
              <label class="block text-sm font-medium text-on-surface mb-1.5">Opening Quantity</label>
              <input name="opening_qty" type="number" min="0" step="1" value="${openingQty}" id="prod-opening-qty"
                class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 transition-all"/>
              <p class="text-xs text-on-surface-variant/60 mt-1">Initial quantity for inventory tracking</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-on-surface mb-1.5">SKU</label>
              <input name="sku" value="${this.escapeHtml(p.sku || '')}"
                class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary/50 transition-all"/>
            </div>
            <div class="col-span-2">
              <label class="block text-sm font-medium text-on-surface mb-1.5">Brand <span class="text-error">*</span></label>
              <select name="brand_id" id="prod-brand-select"
                class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">
                <option value="">Select Brand</option>
                ${this.brands.map(b => `<option value="${b.id}" ${((p.brand_id || p.brandId) === b.id) ? 'selected' : ''}>${this.escapeHtml(b.name)}</option>`).join('')}
              </select>
              <p class="text-xs text-on-surface-variant/60 mt-1">Select a Brand to filter models</p>
            </div>
            <div class="col-span-2">
              <label class="block text-sm font-medium text-on-surface mb-1.5">Model <span class="text-error">*</span></label>
              <div class="flex gap-2">
                <select name="model_id" id="prod-model"
                  class="flex-1 bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">${modelOptions}</select>
              </div>
              <div id="prod-model-hierarchy-path" class="mt-3 p-3 rounded-xl bg-surface-container-low/50 border border-outline-variant/30 ${currentHierarchyPath ? '' : 'hidden'}">
                <div class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">Product Path</div>
                <div class="text-sm text-on-surface">
                  <span id="prod-path-text">${currentHierarchyPath || ''}</span>
                </div>
                <div id="prod-path-detail" class="mt-2 hidden">
                  <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div><span class="text-on-surface-variant/60">Stock Group:</span> <span id="prod-path-group" class="text-on-surface"></span></div>
                    <div><span class="text-on-surface-variant/60">Stock Category:</span> <span id="prod-path-category" class="text-on-surface"></span></div>
                    <div><span class="text-on-surface-variant/60">Brand:</span> <span id="prod-path-brand" class="text-on-surface"></span></div>
                    <div><span class="text-on-surface-variant/60">Model:</span> <span id="prod-path-model" class="text-on-surface"></span></div>
                  </div>
                </div>
              </div>
              <div id="prod-model-error" class="mt-2 text-xs text-error hidden">
                This Model does not have a complete Stock Group → Stock Category → Brand hierarchy.
                Please configure the Model first.
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium text-on-surface mb-1.5">Status</label>
              <select name="is_active"
                class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30">
                <option value="1" ${p.isActive !== 0 ? 'selected' : ''}>Active</option>
                <option value="0" ${p.isActive === 0 ? 'selected' : ''}>Inactive</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Section 2: Pricing -->
        <div class="space-y-4">
          <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Pricing</h3>
          <div class="grid grid-cols-3 gap-4">
            <div>
              <label class="block text-sm font-medium text-on-surface mb-1.5">Cost Price</label>
              <div class="relative">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm">₹</span>
                <input name="cost" type="number" step="0.01" value="${p.cost || 0}"
                  class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 pl-8 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 transition-all"/>
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium text-on-surface mb-1.5">Selling Price</label>
              <div class="relative">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm">₹</span>
                <input name="price" type="number" step="0.01" value="${p.price || 0}"
                  class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 pl-8 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 transition-all"/>
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium text-on-surface mb-1.5">Margin</label>
              <div id="margin-display" class="h-10 px-3 rounded-xl bg-surface-container-low flex items-center text-body-md font-medium text-on-surface">
                ${p.price && p.cost && p.price > 0 ? Math.round(((p.price - p.cost) / p.price) * 100) + '%' : '—'}
              </div>
            </div>
          </div>
        </div>

        <!-- Section 3: Inventory -->
        <div class="space-y-4">
          <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Inventory</h3>

          <!-- Track Inventory Toggle -->
          <div class="flex items-start gap-3 p-3 rounded-xl bg-surface-container-low/50 border border-outline-variant/30">
            <input type="checkbox" id="prod-track-inventory" name="track_inventory"
              ${trackInventory ? 'checked' : ''}
              class="mt-0.5 w-4 h-4 rounded border-outline-variant text-secondary focus:ring-secondary"/>
            <label for="prod-track-inventory" class="flex-1 cursor-pointer">
              <div class="font-medium text-sm text-on-surface">Track Inventory</div>
              <p class="text-xs text-on-surface-variant/70 mt-0.5">Track stock levels, locations, batches, and serial numbers for this product.</p>
            </label>
          </div>

          <!-- Conditional Inventory Fields (hidden when Track OFF) -->
          <div id="prod-inventory-fields" class="space-y-4 ${trackInventory ? '' : 'hidden'}">

            <!-- Inventory Hierarchy (Location → Godown) -->
            ${hierarchyHtml}

            <!-- Serial Number Tracking Toggle + Dynamic Serial Inputs -->
            <div class="space-y-2">
              <div class="flex items-center justify-between p-3 rounded-xl bg-surface-container-low/50 border border-outline-variant/30">
                <div class="flex-1">
                  <div class="font-medium text-sm text-on-surface">Serial Number Tracking</div>
                  <p class="text-xs text-on-surface-variant/70 mt-0.5">Track each individual unit using a unique serial number.</p>
                </div>
                <input type="checkbox" id="prod-serial-tracked" name="is_serial_tracked"
                  ${serialTracked ? 'checked' : ''}
                  class="w-4 h-4 rounded border-outline-variant text-secondary focus:ring-secondary"/>
              </div>

              <!-- Dynamic Serial Number Inputs (shown when serial tracked) -->
              <div id="prod-serial-fields" class="space-y-3 ${serialTracked ? '' : 'hidden'}">
                <div id="prod-serial-list" class="space-y-2">
                  ${serialListHtml}
                </div>
              </div>
            </div>

            <!-- Batch Tracking (Advanced, collapsible) -->
            <div>
              <button type="button" id="prod-advanced-toggle"
                class="flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors">
                <span class="material-symbols-outlined text-[18px]">${batchTracked ? 'expand_more' : 'add'}</span>
                <span>Advanced Inventory Settings</span>
              </button>
              <div id="prod-advanced-panel" class="mt-3 space-y-3 ${batchTracked ? '' : 'hidden'}">
                <div class="flex items-center justify-between p-3 rounded-xl bg-surface-container-low/50 border border-outline-variant/30">
                  <div class="flex-1">
                    <div class="font-medium text-sm text-on-surface">Batch Tracking</div>
                    <p class="text-xs text-on-surface-variant/70 mt-0.5">Track groups of products by batch numbers.</p>
                  </div>
                  <input type="checkbox" name="is_batch_tracked"
                    ${batchTracked ? 'checked' : ''}
                    class="w-4 h-4 rounded border-outline-variant text-secondary focus:ring-secondary"/>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Form actions (sticky footer) -->
        <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
          <button type="button" data-modal-close
            class="px-4 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors">
            Cancel
          </button>
          <button type="submit" id="prod-submit"
            class="flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
            <span class="material-symbols-outlined text-[16px]">${isEdit ? 'save' : 'add'}</span>
            ${isEdit ? 'Save Changes' : 'Create Product'}
          </button>
        </div>
      </form>
    `;
  },

  /**
   * Load existing serial numbers for an edit product and populate the form.
   * @param {object} modal - The open Modal instance
   * @param {string} stockItemId - The stock_item.id of the product being edited
   * @param {string} productId - The product.id
   * @param {number} qty - Number of serial input fields to show
   */
  async _loadExistingSerials(modal, stockItemId, productId, qty) {
   try {
     // Use the serial numbers report endpoint — takes item_id (text UUID)
     const res = await API.get('/inventory/reports/serials', { item_id: stockItemId });
     const serials = res?.items || res?.data || [];
     if (serials.length > 0) {
       const serialListDiv = modal.element.querySelector('#prod-serial-list');
       if (serialListDiv) {
         serialListDiv.innerHTML = this._renderSerialInputs(qty, serials.map(s => s.serialNumber || s.serial_number));
       }
       // Re-attach listeners
       this._attachSerialListeners(modal);
     }
   } catch (e) {
     console.debug('Could not load existing serial numbers:', e);
   }
  },

  /**
   * Populate the dependent hierarchy dropdowns (Location → Godown).
   * Pre-selects current values for edit mode.
   */
  async _loadHierarchyDropdowns(modal, currentLocationId, currentGodownId) {
    const locationSelect = modal.element.querySelector('#prod-location');
    const godownSelect = modal.element.querySelector('#prod-godown');
    if (!locationSelect) return;

    // Clear dependent selects
    const clearSelect = (sel) => { if (sel) { sel.innerHTML = '<option value="">Select...</option>'; } };
    clearSelect(godownSelect);

    try {
      // Load locations
      const locations = await API.get('/inventory/locations');
      const locList = locations?.items || locations?.data || [];
      locList.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id;
        opt.textContent = loc.name;
        if (loc.id === currentLocationId) opt.selected = true;
        locationSelect.appendChild(opt);
      });

      // If a location is already selected (edit mode), load godowns
      const selLoc = currentLocationId || locationSelect.value;
      if (selLoc) {
        await this._loadGodowns(modal, selLoc, currentGodownId);
      }
    } catch (e) {
      console.debug('Could not load hierarchy locations:', e);
    }

    // Bind dependent change handlers
    locationSelect?.addEventListener('change', async () => {
      clearSelect(godownSelect);
      if (locationSelect.value) {
        await this._loadGodowns(modal, locationSelect.value);
      }
    });
  },

  /** Load godowns for a given location into the godown select */
  async _loadGodowns(modal, locationId, selectedGodownId) {
    const godownSelect = modal.element.querySelector('#prod-godown');
    if (!godownSelect) return;
    godownSelect.innerHTML = '<option value="">Select Godown</option>';
    try {
      const res = await API.get(`/inventory/locations/${locationId}/godowns`);
      const godowns = res?.items || res?.data || [];
      godowns.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        if (g.id === selectedGodownId) opt.selected = true;
        godownSelect.appendChild(opt);
      });
    } catch (e) {
      console.debug('Could not load godowns:', e);
    }
  },

  /** Load product images */
  async _loadProductImages(modal, productId) {
    const imageList = modal.element.querySelector('#prod-image-list');
    if (!imageList) return;
    imageList.innerHTML = '';
    try {
      const res = await API.get(`/products/${productId}/images`);
      const images = res?.items || res?.data || [];
      images.forEach(img => {
        const div = document.createElement('div');
        div.className = 'inline-block relative';
        div.innerHTML = `<img src="${img.url}" class="w-16 h-16 object-cover rounded border">`;
        imageList.appendChild(div);
      });
    } catch (e) {
      console.debug('Could not load product images:', e);
    }
  },

  _attachSerialListeners(modal) {
    const serialListDiv = modal.element.querySelector('#prod-serial-list');
    if (!serialListDiv) return;
    const inputs = serialListDiv.querySelectorAll('input[name="serial_numbers[]"]');
    inputs.forEach(input => {
      input.removeEventListener('input', this._validateSerials);
      input.addEventListener('input', this._validateSerials.bind(this, modal));
    });
  },

  // ─── Helper: Render Serial Number Inputs ──────────────────────────────

  /**
   * Generate HTML for N serial number input fields.
   * Preserves existing values when quantity changes (only adds/removes extras).
   * @param {number} count - Number of serial inputs to generate
   * @param {string[]} existingSerials - Existing serial values to preserve
   * @returns {string} HTML string for the serial inputs
   */
  _renderSerialInputs(count, existingSerials) {
    if (count <= 0) return '';
    let html = '<h4 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">Serial Numbers</h4>';
    for (let i = 0; i < count; i++) {
      const val = existingSerials && existingSerials[i] ? existingSerials[i] : '';
      html += `
        <div class="flex items-center gap-2">
          <span class="text-sm text-on-surface-variant w-6">${i + 1}.</span>
          <input type="text" name="serial_numbers[]"
            value="${this.escapeHtml(val)}"
            data-serial-index="${i}"
            class="flex-1 bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 transition-all"/>
          <span class="text-error text-xs hidden" data-serial-error="${i}">This serial number is already entered.</span>
        </div>
      `;
    }
    return html;
  },

  // ─── BIND FORM EVENTS ─────────────────────────────────────────────────

  bindFormEvents(modal, p, isEdit, trackInventory, serialTracked, batchTracked, openingQty, isEditSerialTracked) {
    const form = modal.element.querySelector('#prod-form');
    const submitBtn = modal.element.querySelector('#prod-submit');
    const openingQtyInput = modal.element.querySelector('#prod-opening-qty');

    // Real-time margin calculation
    const costInput = form.querySelector('input[name="cost"]');
    const priceInput = form.querySelector('input[name="price"]');
    const marginDisplay = modal.element.querySelector('#margin-display');
    const updateMargin = () => {
      const cost = parseFloat(costInput?.value) || 0;
      const price = parseFloat(priceInput?.value) || 0;
      if (price > 0 && cost > 0) {
        const pct = Math.round(((price - cost) / price) * 100);
        marginDisplay.textContent = pct + '%';
      } else {
        marginDisplay.textContent = '—';
      }
    };
    costInput?.addEventListener('input', updateMargin);
    priceInput?.addEventListener('input', updateMargin);

    // Model dropdown → auto-resolve hierarchy
    const modelSelect = form.querySelector('select[name="model_id"]') || form.querySelector('#prod-model');
    const pathBreadcrumb = modal.element.querySelector('#prod-path-breadcrumb');
    const pathText = modal.element.querySelector('#prod-path-text');
    const pathDetail = modal.element.querySelector('#prod-path-detail');
    const pathGroup = modal.element.querySelector('#prod-path-group');
    const pathCategory = modal.element.querySelector('#prod-path-category');
    const pathBrand = modal.element.querySelector('#prod-path-brand');
    const pathModel = modal.element.querySelector('#prod-path-model');
    const modelError = modal.element.querySelector('#prod-model-error');
    const hierarchyPathDiv = modal.element.querySelector('#prod-model-hierarchy-path');

    let currentHierarchy = null; // stores resolved hierarchy data

    const updateHierarchyDisplay = (data) => {
      if (!data) {
        currentHierarchy = null;
        if (hierarchyPathDiv) hierarchyPathDiv.classList.add('hidden');
        if (modelError) modelError.classList.add('hidden');
        return;
      }
      currentHierarchy = data;
      const parts = [data.stockGroupName, data.stockCategoryName, data.brandName, data.modelName || data.name].filter(Boolean);
      if (pathText) pathText.textContent = parts.join(' → ') || '';
      if (pathGroup) pathGroup.textContent = data.stockGroupName || '—';
      if (pathCategory) pathCategory.textContent = data.stockCategoryName || '—';
      if (pathBrand) pathBrand.textContent = data.brandName || '—';
      if (pathModel) pathModel.textContent = data.modelName || data.name || '—';
      if (hierarchyPathDiv) hierarchyPathDiv.classList.remove('hidden');
      if (modelError) modelError.classList.add('hidden');
    };

    const showHierarchyError = () => {
      currentHierarchy = null;
      if (modelError) modelError.classList.remove('hidden');
      if (pathText) pathText.textContent = '';
      if (pathGroup) pathGroup.textContent = '—';
      if (pathCategory) pathCategory.textContent = '—';
      if (pathBrand) pathBrand.textContent = '—';
      if (pathModel) pathModel.textContent = '—';
      if (hierarchyPathDiv) hierarchyPathDiv.classList.remove('hidden');
    };

    const fetchModelHierarchy = async (modelId) => {
      if (!modelId) {
        updateHierarchyDisplay(null);
        return;
      }
      try {
        const data = await API.get(`/inventory/models/${modelId}/hierarchy`);
        if (data && data.id) {
          updateHierarchyDisplay(data);
        } else {
          showHierarchyError();
        }
      } catch (e) {
        showHierarchyError();
      }
    };

    modelSelect?.addEventListener('change', async () => {
      const modelId = modelSelect.value;
      if (modelId) {
        // Verify the model belongs to the selected brand
        const brandSelect = form.querySelector('#prod-brand-select');
        const selectedBrand = brandSelect ? brandSelect.value : '';
        if (selectedBrand) {
          const model = this.models.find(m => m.id === modelId);
          if (model && model.brand_id !== selectedBrand && model.brandId !== selectedBrand) {
            Toast.warning('The selected Model does not belong to the selected Brand');
          }
        }
        await fetchModelHierarchy(modelId);
      } else {
        updateHierarchyDisplay(null);
      }
    });

    // Track Inventory toggle → show/hide inventory fields
    const trackCheckbox = modal.element.querySelector('#prod-track-inventory');
    const invFields = modal.element.querySelector('#prod-inventory-fields');
    trackCheckbox?.addEventListener('change', () => {
      if (invFields) {
        invFields.classList.toggle('hidden', !trackCheckbox.checked);
      }
    });

    // Serial Number Tracking toggle → generate S/N inputs
    const serialCheckbox = modal.element.querySelector('#prod-serial-tracked');
    const serialFieldsDiv = modal.element.querySelector('#prod-serial-fields');
    const serialListDiv = modal.element.querySelector('#prod-serial-list');

    // Generate serial inputs based on opening quantity
    const generateSerialInputs = (count, preserveValues = true) => {
      if (!serialListDiv) return;
      let preservedSerials = [];
      if (preserveValues) {
        const existingInputs = serialListDiv.querySelectorAll('input[name="serial_numbers[]"]');
        existingInputs.forEach(input => {
          const val = input.value.trim();
          if (val) preservedSerials.push(val);
        });
      }
      const wasCount = preservedSerials.length;
      if (wasCount > count) {
        if (!confirm('You have ' + wasCount + ' serial numbers entered. Reducing to ' + count + ' will remove ' + (wasCount - count) + ' entries. Continue?')) {
          serialCheckbox.checked = true;
          return;
        }
      }
      serialListDiv.innerHTML = this._renderSerialInputs(count, preservedSerials);
      this._attachSerialListeners(modal);
    };

    // Validate serial numbers for uniqueness and completeness
    const validateSerials = () => {
      if (!serialListDiv) return true;
      const inputs = serialListDiv.querySelectorAll('input[name="serial_numbers[]"]');

      inputs.forEach(input => {
        input.classList.remove('border-error', 'border-red-500');
        const errorSpan = input.parentElement.querySelector('[data-serial-error]');
        if (errorSpan) errorSpan.classList.add('hidden');
      });

      let valid = true;
      const seen = {};

      inputs.forEach((input, idx) => {
        const val = input.value.trim();
        if (!val) {
          input.classList.add('border-red-500');
          valid = false;
        }
        if (seen[val] !== undefined && val) {
          const firstIdx = seen[val];
          const firstInput = inputs[firstIdx];
          firstInput.classList.add('border-red-500');
          input.classList.add('border-red-500');
          // Show error on the duplicate field
          const firstErr = firstInput.parentElement.querySelector('[data-serial-error]');
          const dupErr = input.parentElement.querySelector('[data-serial-error]');
          if (firstErr) firstErr.classList.remove('hidden');
          if (dupErr) dupErr.classList.remove('hidden');
          valid = false;
        }
        if (val) seen[val] = idx;
      });

      return valid;
    };

    // Re-bind validateSerials as bound version
    this._validateSerials = validateSerials;

    // When serial tracking is toggled ON, generate initial S/N inputs based on Opening Quantity
    serialCheckbox?.addEventListener('change', () => {
      if (!serialFieldsDiv) return;
      if (serialCheckbox.checked) {
        const qty = Math.max(1, parseInt(openingQtyInput?.value) || 1);
        serialListDiv.innerHTML = this._renderSerialInputs(qty, []);
        this._attachSerialListeners(modal);
        serialFieldsDiv.classList.remove('hidden');
      } else {
        serialFieldsDiv.classList.add('hidden');
        validateSerials();
      }
    });

    // When opening quantity changes AND serial tracking is on, regenerate S/N inputs
    openingQtyInput?.addEventListener('input', () => {
      if (serialCheckbox?.checked && serialListDiv) {
        const qty = Math.max(1, parseInt(openingQtyInput.value) || 1);
        generateSerialInputs(qty, true);
      }
    });

    // Validate serials on each input change
    this._attachSerialListeners(modal);

    // Advanced inventory toggle (Batch Tracking)
    const advToggle = modal.element.querySelector('#prod-advanced-toggle');
    const advPanel = modal.element.querySelector('#prod-advanced-panel');
    let advExpanded = !!batchTracked;
    advToggle?.addEventListener('click', (e) => {
      e.preventDefault();
      advExpanded = !advExpanded;
      if (advPanel) {
        advPanel.classList.toggle('hidden', !advExpanded);
      }
      const icon = advToggle.querySelector('span');
      if (icon) {
        icon.textContent = advExpanded ? 'expand_more' : 'add';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = {};

      // Validate serial numbers before submission
      if (serialCheckbox?.checked) {
        if (!validateSerials()) return;
      }

      // Resolve model and hierarchy
      const selectedModelId = fd.get('model_id');
      const selectedBrandId = fd.get('brand_id');

      // Validate that a brand is selected
      if (!selectedBrandId) {
        Toast.error('Please select a Brand');
        return;
      }

      // Validate that a model is selected
      if (!selectedModelId) {
        Toast.error('Please select a Model');
        return;
      }

      // Validate that hierarchy was resolved
      if (!currentHierarchy || !currentHierarchy.hasCompleteHierarchy) {
        // Check if we have pre-fetched hierarchy data from edit mode
        const modelSelect = form.querySelector('select[name="model_id"]');
        const preloadedData = modelSelect?._hierarchyData;
        if (preloadedData && preloadedData.hasCompleteHierarchy) {
          currentHierarchy = preloadedData;
        } else {
          Toast.error('This Model does not have a complete hierarchy. Please configure the Model first.');
          return;
        }
      }

      // Resolve category name from model's hierarchy
      const resolvedCat = this.categories.find(c => c.id === currentHierarchy.stockCategoryId);
      const resolvedCatName = resolvedCat ? resolvedCat.name : (currentHierarchy.stockCategoryName || '');

      // Basic fields per spec
      payload.name = fd.get('name') || '';
      payload.sku = fd.get('sku') || '';
      payload.category = resolvedCatName;
      payload.price = parseFloat(fd.get('price')) || 0;
      payload.cost = parseFloat(fd.get('cost')) || 0;
      payload.is_active = fd.get('is_active') ? 1 : 0;
      
      // Product hierarchy — Stock Group and Stock Category auto-resolved from model;
      // Brand is user-selected; Model is user-selected
      payload.stock_group_id = currentHierarchy.stockGroupId;
      payload.stock_category_id = currentHierarchy.stockCategoryId;
      payload.brand_id = selectedBrandId;
      payload.model_id = selectedModelId;

      // Inventory fields (conditional)
      const trackInv = fd.get('track_inventory') === 'on';
      // Hierarchy fields imply inventory tracking
      const locId = fd.get('location_id');
      const gdnId = fd.get('godown_id');
      const hierarchyProvided = locId && gdnId;
      const effectiveTrackInv = trackInv || hierarchyProvided;
      payload.track_inventory = effectiveTrackInv ? 1 : undefined;
      if (effectiveTrackInv) {
        if (resolvedCat) payload.category_id = resolvedCat.id;
        // UOM — auto-select first active UOM since Unit dropdown was removed from form
        const uomId = fd.get('uom_id') || (this.uoms.length > 0 ? this.uoms.find(u => u.is_active === 1 || u.is_active === true)?.id : null);
        if (uomId) payload.uom_id = uomId;
        payload.is_serial_tracked = fd.get('is_serial_tracked') === 'on' ? 1 : 0;
        payload.is_batch_tracked = fd.get('is_batch_tracked') === 'on' ? 1 : 0;
        payload.opening_quantity = parseInt(fd.get('opening_qty')) || 0;
        payload.serial_numbers = fd.getAll('serial_numbers[]').filter(s => s && s.trim());
        // Inventory hierarchy fields (Location → Godown only)
        if (hierarchyProvided) {
          payload.location_id = locId;
          payload.godown_id = gdnId;
        }
      }

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
        }
        let successMsg = '';

        if (isEdit) {
          await API.put('/products/' + p.id, payload);
          successMsg = 'Product updated successfully';
        } else {
          const result = await API.post('/products', payload);
          const productId = result?.id || result?.data?.id;
          const openingQtyVal = parseInt(fd.get('opening_qty')) || 0;
          const serials = payload.serial_numbers || [];

          if (trackInv && openingQtyVal > 0) {
            try {
              const stockRes = await API.get(`/inventory/stocks/product/${productId}`);
              const stockItemId = stockRes?.stockItemId || stockRes?.stock_item_id || stockRes?.id;
              const uomId = fd.get('uom_id') || stockRes?.uomId || stockRes?.uom_id || stockRes?.stockItem?.uomId;

              if (stockItemId && serials.length > 0) {
                // Serial-tracked: create voucher with one line per serial
                const godownId = payload.godown_id || stockRes?.godownId || null;
                const locationId = payload.location_id || stockRes?.locationId || null;
                const voucherLines = serials.map(function(sn) {
                  return {
                    item_id: stockItemId,
                    uom_id: uomId,
                    quantity: 1,
                    unit_rate: payload.cost || 0,
                    serial_number: sn,
                    is_source: 0,
                    dest_godown_id: godownId,
                    dest_location_id: locationId,
                  };
                });
                const voucherPayload = {
                  voucher_type: 'opening_stock',
                  voucher_date: new Date().toISOString().split('T')[0],
                  narration: 'Opening stock for ' + payload.name,
                  source_type: 'opening',
                  lines: voucherLines,
                };
                const draft = await API.post('/inventory/vouchers', voucherPayload);
                const vnum = draft?.voucher_number || draft?.voucherNumber;
                if (vnum) {
                  await API.post(`/inventory/vouchers/${encodeURIComponent(vnum)}/post`);
                }
                successMsg = 'Product created successfully with ' + serials.length + ' serial numbers.';
              } else if (stockItemId) {
                // Non-serial tracked: single line with opening quantity
                const godownId = payload.godown_id || stockRes?.godownId || null;
                const locationId = payload.location_id || stockRes?.locationId || null;
                const voucherPayload = {
                  voucher_type: 'opening_stock',
                  voucher_date: new Date().toISOString().split('T')[0],
                  narration: 'Opening stock for ' + payload.name,
                  source_type: 'opening',
                  lines: [{
                    item_id: stockItemId,
                    uom_id: uomId,
                    quantity: openingQtyVal,
                    unit_rate: payload.cost || 0,
                    serial_number: null,
                    is_source: 0,
                    dest_godown_id: godownId,
                    dest_location_id: locationId,
                  }],
                };
                const draft = await API.post('/inventory/vouchers', voucherPayload);
                const vnum = draft?.voucher_number || draft?.voucherNumber;
                if (vnum) {
                  await API.post(`/inventory/vouchers/${encodeURIComponent(vnum)}/post`);
                }
                successMsg = 'Product created successfully. Inventory tracking is enabled.';
              } else {
                successMsg = 'Product created successfully. Inventory tracking is enabled.';
              }
            } catch (invErr) {
              console.error('Inventory voucher error:', invErr);
              successMsg = 'Product created successfully. Inventory tracking is enabled.';
            }
          } else if (trackInv) {
            successMsg = 'Product created successfully. Inventory tracking is enabled.';
          } else {
            successMsg = 'Product created successfully.';
          }
        }

        Toast.success(successMsg);
        modal.close();
        this.load();
      } catch (err) {
        this.showFriendlyError(err);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
        }
      }
    });
  },

  _clearHierarchyDisplay(modal) {
    const pathText = modal.element.querySelector('#prod-path-text');
    const hierarchyPathDiv = modal.element.querySelector('#prod-model-hierarchy-path');
    const modelError = modal.element.querySelector('#prod-model-error');
    if (pathText) pathText.textContent = '';
    if (hierarchyPathDiv) hierarchyPathDiv.classList.add('hidden');
    if (modelError) modelError.classList.add('hidden');
    // Clear stored hierarchy data
    const modelSelect = modal.element.querySelector('select[name="model_id"]');
    if (modelSelect) modelSelect._hierarchyData = null;
  },

  openCategoryCreateModal(callback) {
    const modal = new Modal({
      title: 'Create Category',
      size: 'sm',
      content: `
        <form id="cat-form" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-on-surface mb-1.5">Name <span class="text-error">*</span></label>
            <input name="name" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-on-surface mb-1.5">Description</label>
            <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-xl px-3 py-2.5 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30"></textarea>
          </div>
          <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors">Cancel</button>
            <button type="submit" class="flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
              <span class="material-symbols-outlined text-[16px]">add</span> Create
            </button>
          </div>
        </form>
      `
    });
    modal.open();

    modal.element.querySelector('#cat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const result = await API.post('/inventory/masters/stock_categories', {
          name: fd.get('name'),
          description: fd.get('description') || null
        });
        const newCat = this.categories.find(c => c.name === fd.get('name'));
        if (!newCat) {
          const cat = result; // API response
          this.categories.push({ id: cat.id, name: cat.name, description: cat.description });
        }
        if (callback) callback(result.id || result.data?.id);
        modal.close();
        this.load();
      } catch (err) {
        this.showFriendlyError(err);
      }
    });
  },

  // ─── DELETE ───────────────────────────────────────────────────────────

  confirmDelete(row) {
    const modal = new Modal({
      title: 'Delete Product?',
      size: 'sm',
      content: `
        <div class="space-y-4">
          <p class="text-body-md text-on-surface">Are you sure you want to delete <strong>${this.escapeHtml(row.name)}</strong>?</p>
          <p class="text-sm text-on-surface-variant">This action cannot be undone.</p>
          <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors">Cancel</button>
            <button id="confirm-prod-delete" class="px-4 py-2 rounded-xl bg-error text-on-error hover:bg-error/90 transition-colors">Delete</button>
          </div>
        </div>
      `
    });
    modal.open();
    modal.element.querySelector('#confirm-prod-delete').addEventListener('click', async () => {
      try {
        await API.del('/products/' + row.id);
        Toast.success('Product deleted');
        modal.close();
        this.load();
      } catch (err) {
        this.showFriendlyError(err);
      }
    });
  },

  // ─── DETAIL VIEW INVENTORY RELOAD ──────────────────────────────────────

  async reloadInventoryPanel() {
    const panel = document.querySelector('[data-tab-panel="inventory"]');
    if (!panel || !this._lastProduct) return;
    const fmt = (n) => Currency.format(n, this.currentCurrency);
    panel.innerHTML = '<div class="p-6 text-center"><span class="material-symbols-outlined text-[28px] animate-spin text-on-surface-variant/60">progress_activity</span></div>';
    try {
      const p = this._lastProduct;
      const hasStockItem = !!p.stockItemId || !!p.stockItem;

      // Fetch stock item details by product ID
      let stockData = null;
      if (hasStockItem) {
        try {
          stockData = await API.get(`/inventory/stocks/product/${p.id}`);
        } catch { /* no stock item */ }
      }

      const si = p.stockItem || stockData || {};
      const onHand = stockData?.onHandQty || si?.onHandQty || p.stockItem?.onHandQty || 0;
      const reserved = 0;
      const available = onHand - reserved;
      const stockValue = stockData?.avgRate ? onHand * stockData.avgRate : (p.stockItem?.stockValue || 0);

      if (!hasStockItem) {
        panel.innerHTML = `
          <div class="text-center py-12">
            <span class="material-symbols-outlined text-[48px] text-on-surface-variant/30 mb-3">warehouse</span>
            <p class="text-lg font-medium text-on-surface">Inventory Not Tracked</p>
            <p class="text-sm text-on-surface-variant mt-1">Enable inventory tracking in the product form to manage stock.</p>
            <button id="prod-enable-inventory" class="mt-4 flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
              <span class="material-symbols-outlined text-[18px]">edit</span> Enable Inventory Tracking
            </button>
          </div>
        `;
      } else {
        let locationsHtml = '';
        if (stockData && stockData.locations && stockData.locations.length > 0) {
          locationsHtml = stockData.locations.map(loc => `
            <tr class="border-b border-outline-variant/20">
              <td class="py-3 text-sm text-on-surface">${loc.locationName || loc.location || '—'}</td>
              <td class="py-3 text-sm text-on-surface text-right">${loc.quantityOnHand || 0}</td>
              <td class="py-3 text-sm text-on-surface-variant text-right">${loc.quantityAvailable || 0}</td>
              <td class="py-3 text-sm text-on-surface-variant text-right">${loc.reserved || 0}</td>
            </tr>
          `).join('');
        } else {
          locationsHtml = `<tr><td colspan="4" class="py-8 text-center text-sm text-on-surface-variant">No location data available</td></tr>`;
        }

        panel.innerHTML = `
          <div class="space-y-6">
            <div>
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Stock Summary</h3>
              <div class="grid grid-cols-4 gap-4 mb-4">
                <div class="p-4 bg-surface-container rounded-lg">
                  <span class="text-xs text-on-surface-variant/70 uppercase">Available</span>
                  <p class="text-[20px] font-semibold text-on-surface mt-1">${available}</p>
                </div>
                <div class="p-4 bg-surface-container rounded-lg">
                  <span class="text-xs text-on-surface-variant/70 uppercase">On Hand</span>
                  <p class="text-[20px] font-semibold text-on-surface mt-1">${onHand}</p>
                </div>
                <div class="p-4 bg-surface-container rounded-lg">
                  <span class="text-xs text-on-surface-variant/70 uppercase">Reserved</span>
                  <p class="text-[20px] font-semibold text-on-surface mt-1">${reserved}</p>
                </div>
                <div class="p-4 bg-surface-container rounded-lg">
                  <span class="text-xs text-on-surface-variant/70 uppercase">Stock Value</span>
                  <p class="text-[20px] font-semibold text-on-surface mt-1">${fmt(stockValue)}</p>
                </div>
              </div>
            </div>
            <div>
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">By Location</h3>
              <div class="overflow-x-auto">
                <table class="w-full text-left text-sm">
                  <thead>
                    <tr class="border-b border-outline-variant/20">
                      <th class="pb-2 text-xs font-medium text-on-surface-variant uppercase">Location</th>
                      <th class="pb-2 text-right text-xs font-medium text-on-surface-variant uppercase">On Hand</th>
                      <th class="pb-2 text-right text-xs font-medium text-on-surface-variant uppercase">Available</th>
                      <th class="pb-2 text-right text-xs font-medium text-on-surface-variant uppercase">Reserved</th>
                    </tr>
                  </thead>
                  <tbody>${locationsHtml}</tbody>
                </table>
              </div>
            </div>
            ${si?.isSerialTracked ? `
            <div>
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Serial Numbers (${onHand})</h3>
              <div id="prod-serial-list" class="space-y-2">
                <div class="text-center py-4">
                  <span class="material-symbols-outlined text-[20px] animate-spin text-on-surface-variant/60">progress_activity</span>
                </div>
              </div>
            </div>
            ` : ''}
          </div>
        `;

        // Re-bind the enable inventory button if present
        const enableBtn = panel.querySelector('#prod-enable-inventory');
        if (enableBtn) enableBtn.addEventListener('click', () => this.openForm(p));

        // Load serial numbers if serial tracking is enabled
        if (si?.isSerialTracked && si?.id) {
          setTimeout(() => this._loadDetailSerials(si.id), 0);
        }
      }
    } catch (err) {
      panel.innerHTML = '<div class="p-6 text-center text-sm text-on-surface-variant">Failed to load inventory data</div>';
    }
  },

  async _loadDetailSerials(itemId) {
    const listDiv = document.getElementById('prod-serial-list');
    if (!listDiv) return;
    try {
      const res = await API.get('/inventory/reports/serials', { item_id: itemId });
      const serials = res?.items || [];
      if (serials.length === 0) {
        listDiv.innerHTML = '<p class="text-sm text-on-surface-variant">No serial numbers found for this product.</p>';
        return;
      }
      const html = serials.map(s => `
        <div class="flex justify-between items-center px-3 py-2 bg-surface-container-low rounded-lg">
          <div class="flex flex-col">
            <span class="font-mono text-sm text-on-surface">${this.escapeHtml(s.serialNumber || s.serial_number || '—')}</span>
            <span class="text-xs text-on-surface-variant/60">Status: ${this.escapeHtml(s.status || 'available')}</span>
          </div>
          ${s.purchaseDate ? `<span class="text-xs text-on-surface-variant/60">${s.purchaseDate}</span>` : ''}
        </div>
      `).join('');
      listDiv.innerHTML = html;
    } catch (err) {
      listDiv.innerHTML = '<p class="text-sm text-error">Failed to load serial numbers.</p>';
    }
  },

  // ─── DETAIL VIEW ──────────────────────────────────────────────────────

  async renderDetail(productId) {
    const main = document.getElementById('page-container');
    if (!main) return;
    main.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant/60">progress_activity</span></div>';

    try {
      const product = await API.get('/products/' + productId);
      // API client unwraps result.data, so product is the object directly
      const p = product || {};
      this.renderDetailView(p);
    } catch (err) {
      main.innerHTML = `<div class="p-12 text-center"><p class="text-error">Failed to load product</p></div>`;
    }
  },

  async renderDetailView(p) {
    const main = document.getElementById('page-container');
    if (!main) return;
    this._lastProduct = p;

    const fmt = (n) => Currency.format(n, this.currentCurrency);
    const marginPct = p.price && p.cost && p.price > 0 ? Math.round(((p.price - p.cost) / p.price) * 100) : 0;

    const hasStockItem = !!p.stockItemId || !!p.stock_item_id || !!p.stockItem;

    main.innerHTML = `
      <div class="animate-fade-in">
        <!-- Header -->
        <div class="flex items-center justify-between mb-8">
          <div class="flex items-center gap-4">
            <a href="#products" class="text-on-surface-variant/60 hover:text-on-surface transition-colors">
              <span class="material-symbols-outlined">arrow_back</span>
            </a>
            <div class="w-14 h-14 rounded-xl bg-surface-container-high flex items-center justify-center">
              <span class="material-symbols-outlined text-[28px] text-on-surface-variant/60">inventory_2</span>
            </div>
            <div>
              <div class="flex items-center gap-2 mb-1">
                <h1 class="text-2xl font-semibold text-on-surface">${this.escapeHtml(p.name || '')}</h1>
                ${StatusBadge.render(p.isActive ? 'active' : 'inactive')}
              </div>
              <div class="flex items-center gap-4 text-sm text-on-surface-variant/60">
                <span class="font-mono">${this.escapeHtml(p.sku || '')}</span>
                <span class="material-symbols-outlined text-[14px]">location_on</span>
                <span>${this.escapeHtml(p.category || '—')}</span>
                ${p.modelName ? `<span class="material-symbols-outlined text-[14px]">arrow_right_alt</span>
                <span class="font-medium text-on-surface">${this.escapeHtml(p.modelName || '')}</span>` : ''}
              </div>
              ${this._renderHierarchyBreadcrumb(p)}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button id="prod-detail-edit" class="flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors">
              <span class="material-symbols-outlined text-[18px]">edit</span> Edit
            </button>
            <button id="prod-detail-inventory" class="flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors">
              <span class="material-symbols-outlined text-[18px]">warehouse</span> Inventory
            </button>
            <div class="relative">
              <button id="prod-detail-menu" class="flex items-center justify-center w-9 h-9 rounded-xl bg-surface-container-high text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors">
                <span class="material-symbols-outlined">more_vert</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Tabs -->
        <div class="border-b border-outline-variant/30 mb-6">
          <nav class="flex gap-6">
            <button data-tab="overview" class="tab-btn active border-b-2 pb-3 px-1 text-sm font-medium text-secondary transition-colors">
              Overview
            </button>
            <button data-tab="inventory" class="tab-btn border-b-2 border-transparent pb-3 px-1 text-sm font-medium text-on-surface-variant/60 hover:text-on-surface transition-colors">
              Inventory
            </button>
            <button data-tab="activity" class="tab-btn border-b-2 border-transparent pb-3 px-1 text-sm font-medium text-on-surface-variant/60 hover:text-on-surface transition-colors">
              Activity
            </button>
          </nav>
        </div>

        <!-- Tab Content -->
        <div id="prod-detail-tabs">
          ${this.renderDetailOverview(p, fmt, marginPct, hasStockItem)}
          ${this.renderDetailInventory(p, fmt, hasStockItem)}
          ${this.renderDetailActivity(p)}
        </div>
      </div>
    `;

    this.bindDetailEvents(p, hasStockItem);
  },

  renderDetailOverview(p, fmt, marginPct, hasStockItem) {
    return `
      <div data-tab-panel="overview" class="tab-panel">
        <div class="grid grid-cols-2 gap-8">
          <div class="space-y-6">
            <div>
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Product Information</h3>
              <dl class="space-y-3">
                <div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Product Name</dt>
                  <dd class="text-sm text-on-surface font-medium">${this.escapeHtml(p.name || '')}</dd>
                </div>
                <div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">SKU</dt>
                  <dd class="font-mono text-sm text-on-surface">${this.escapeHtml(p.sku || '—')}</dd>
                </div>
                <div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Category</dt>
                  <dd class="text-sm text-on-surface">${this.escapeHtml(p.category || '—')}</dd>
                </div>
                <div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Description</dt>
                  <dd class="text-sm text-on-surface">${this.escapeHtml(p.description || '—')}</dd>
                </div>
                ${p.stockGroupName ? `<div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Stock Group</dt>
                  <dd class="text-sm text-on-surface">${this.escapeHtml(p.stockGroupName || '—')}</dd>
                </div>` : ''}
                ${p.stockCategoryName ? `<div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Stock Category</dt>
                  <dd class="text-sm text-on-surface">${this.escapeHtml(p.stockCategoryName || '—')}</dd>
                </div>` : ''}
                ${p.brandName ? `<div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Brand</dt>
                  <dd class="text-sm text-on-surface">${this.escapeHtml(p.brandName || '—')}</dd>
                </div>` : ''}
                ${p.modelName ? `<div class="flex justify-between py-2">
                  <dt class="text-sm text-on-surface-variant">Model</dt>
                  <dd class="text-sm text-on-surface">${this.escapeHtml(p.modelName || '—')}</dd>
                </div>` : ''}
              </dl>
            </div>

            <div>
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Pricing</h3>
              <dl class="space-y-3">
                <div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Cost Price</dt>
                  <dd class="font-mono text-sm text-on-surface">${fmt(p.cost)}</dd>
                </div>
                <div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Selling Price</dt>
                  <dd class="font-mono text-sm text-on-surface">${fmt(p.price)}</dd>
                </div>
                <div class="flex justify-between py-2 border-b border-outline-variant/20">
                  <dt class="text-sm text-on-surface-variant">Margin</dt>
                  <dd class="font-mono text-sm text-on-surface font-medium">${marginPct}%</dd>
                </div>
              </dl>
            </div>
          </div>

          <div class="space-y-6">
            <div>
              <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Inventory Status</h3>
              <dl class="space-y-3">
                <div class="flex justify-between py-2">
                  <dt class="text-sm text-on-surface-variant">Tracking</dt>
                  <dd class="text-sm text-on-surface">${hasStockItem ? '<span class="inline-flex items-center gap-1.5 text-green-600"><span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>Enabled</span>' : '<span class="text-on-surface-variant/60">Not Tracked</span>'}</dd>
                </div>
                ${hasStockItem ? `
                  <div class="flex justify-between py-2 border-b border-outline-variant/20">
                    <dt class="text-sm text-on-surface-variant">Stock Item ID</dt>
                    <dd class="font-mono text-sm text-on-surface-variant/70">${this.escapeHtml(p.stockItemId || '—')}</dd>
                  </div>
                  <div class="flex justify-between py-2 border-b border-outline-variant/20">
                    <dt class="text-sm text-on-surface-variant">Current Stock</dt>
                    <dd class="text-sm text-on-surface font-medium">${p.stockItem?.onHandQty || 0} units</dd>
                  </div>
                  <div class="flex justify-between py-2 border-b border-outline-variant/20">
                    <dt class="text-sm text-on-surface-variant">Stock Value</dt>
                    <dd class="font-mono text-sm text-on-surface">${fmt(p.stockItem?.stockValue)}</dd>
                  </div>
                ` : ''}
                <div class="flex justify-between py-2">
                  <dt class="text-sm text-on-surface-variant">Status</dt>
                  <dd>${StatusBadge.render(p.isActive ? 'active' : 'inactive')}</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  renderDetailInventory(p, fmt, hasStockItem) {
    if (!hasStockItem) {
      return `
        <div data-tab-panel="inventory" class="tab-panel hidden">
          <div class="text-center py-12">
            <span class="material-symbols-outlined text-[48px] text-on-surface-variant/30 mb-3">warehouse</span>
            <p class="text-lg font-medium text-on-surface">Inventory Not Tracked</p>
            <p class="text-sm text-on-surface-variant mt-1">Enable inventory tracking in the product form to manage stock.</p>
            <button id="prod-enable-inventory" class="mt-4 flex items-center gap-2 bg-secondary text-on-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-colors">
              <span class="material-symbols-outlined text-[18px]">edit</span> Enable Inventory Tracking
            </button>
          </div>
        </div>
      `;
    }

    const si = p.stockItem || {};
    const onHand = si?.onHandQty || 0;
    const available = onHand - 0;
    const stockValue = si?.stockValue || 0;

    return `
      <div data-tab-panel="inventory" class="tab-panel hidden">
        <div class="space-y-6">
          <!-- Stock Summary -->
          <div>
            <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Stock Summary</h3>
            <div class="grid grid-cols-4 gap-4">
              <div class="bg-surface-container-low rounded-xl p-4 border border-outline-variant/30">
                <p class="text-xs text-on-surface-variant/70 uppercase">Available</p>
                <p class="text-2xl font-semibold text-on-surface mt-1">${available}</p>
              </div>
              <div class="bg-surface-container-low rounded-xl p-4 border border-outline-variant/30">
                <p class="text-xs text-on-surface-variant/70 uppercase">On Hand</p>
                <p class="text-2xl font-semibold text-on-surface mt-1">${onHand}</p>
              </div>
              <div class="bg-surface-container-low rounded-xl p-4 border border-outline-variant/30">
                <p class="text-xs text-on-surface-variant/70 uppercase">Reserved</p>
                <p class="text-2xl font-semibold text-on-surface mt-1">0</p>
              </div>
              <div class="bg-surface-container-low rounded-xl p-4 border border-outline-variant/30">
                <p class="text-xs text-on-surface-variant/70 uppercase">Stock Value</p>
                <p class="text-2xl font-semibold text-on-surface mt-1">${fmt(stockValue)}</p>
              </div>
            </div>
          </div>

          <!-- Tracking Details -->
          <div>
            <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Tracking Details</h3>
            <dl class="space-y-3">
              <div class="flex justify-between py-2 border-b border-outline-variant/20">
                <dt class="text-sm text-on-surface-variant">Unit of Measure</dt>
                <dd class="text-sm text-on-surface">${this.uoms.find(u => u.id === (si?.uomId || si?.uom_id))?.name || si?.uomId || '—'}</dd>
              </div>
              <div class="flex justify-between py-2 border-b border-outline-variant/20">
                <dt class="text-sm text-on-surface-variant">Serial Tracking</dt>
                <dd class="text-sm text-on-surface">${si?.isSerialTracked ? 'Enabled' : 'Disabled'}</dd>
              </div>
              <div class="flex justify-between py-2 border-b border-outline-variant/20">
                <dt class="text-sm text-on-surface-variant">Batch Tracking</dt>
                <dd class="text-sm text-on-surface">${si?.isBatchTracked ? 'Enabled' : 'Disabled'}</dd>
              </div>
              <div class="flex justify-between py-2">
                <dt class="text-sm text-on-surface-variant">Min Stock Level</dt>
                <dd class="text-sm text-on-surface">${si?.minStockLevel || 0}</dd>
              </div>
            </dl>
          </div>

          <!-- Serial Numbers Section -->
          ${si?.isSerialTracked ? `
          <div class="mt-6" id="prod-serial-numbers-section">
            <h3 class="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">Serial Numbers (${onHand})</h3>
            <div class="space-y-2" id="prod-serial-list">
              <div class="text-center py-6">
                <span class="material-symbols-outlined text-[28px] animate-spin text-on-surface-variant/60">progress_activity</span>
              </div>
            </div>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  },

  renderDetailActivity(p) {
    // Build the panel placeholder and load activity data asynchronously
    const panelHtml = `
      <div data-tab-panel="activity" class="tab-panel hidden">
        <div class="p-6 text-center">
          <span class="material-symbols-outlined text-[28px] animate-spin text-on-surface-variant/60">progress_activity</span>
        </div>
      </div>
    `;
    // Kick off async activity fetch (deferred to allow DOM to be updated first)
    const productId = p?.id;
    if (productId) {
      setTimeout(() => { this._loadActivity(productId); }, 0);
    }
    return panelHtml;
  },

  async _loadActivity(productId) {
    const panel = document.querySelector('[data-tab-panel="activity"]');
    if (!panel) return;
    try {
      const res = await API.get('/audit/PRODUCT/' + productId);
      const items = res?.data || res || [];
      if (items.length === 0) {
        panel.innerHTML = this._emptyActivityHtml();
      } else {
        panel.innerHTML = this._activityListHtml(items);
      }
    } catch (err) {
      panel.innerHTML = this._emptyActivityHtml();
    }
  },

  _emptyActivityHtml() {
    return `<div class="text-center py-12">
      <span class="material-symbols-outlined text-[48px] text-on-surface-variant/30 mb-3">history</span>
      <p class="text-lg font-medium text-on-surface">No Activity Recorded</p>
      <p class="text-sm text-on-surface-variant mt-1">Product activity and audit log will appear here as actions are performed.</p>
    </div>`;
  },

  _activityListHtml(items) {
    let html = '<div class="space-y-3">';
    html += '<div class="border-b border-outline-variant/20 pb-2 mb-3 flex items-center justify-between">';
    html += '<span class="text-xs font-semibold text-on-surface-variant uppercase">Activity Log</span>';
    html += '<span class="text-xs text-on-surface-variant/60">' + items.length + ' entries</span>';
    html += '</div>';
    for (const item of items) {
      const ts = item.createdAt || item.created_at || '';
      const date = ts ? new Date(ts).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
      }) : '—';
      const type = item.actionType || item.action || item.action_type || 'Event';
      const title = item.title || item.description || (item.newValuesJson ? 'Product Updated' : (item.oldValuesJson ? 'Product Created' : 'Activity'));
      const desc = item.description || '';
      html += '<div class="flex gap-3 pb-3 border-b border-outline-variant/10">';
      html += '<span class="material-symbols-outlined text-[18px] text-on-surface-variant/60 mt-0.5 flex-shrink-0">circle</span>';
      html += '<div class="flex-1">';
      html += '<div class="flex items-center gap-2">';
      html += '<span class="text-xs font-medium text-on-surface-variant/60 uppercase">' + type + '</span>';
      html += '<span class="text-xs text-on-surface-variant/40">·</span>';
      html += '<span class="text-xs text-on-surface-variant/60">' + date + '</span>';
      html += '</div>';
      html += '<p class="text-sm text-on-surface font-medium mt-0.5">' + title + '</p>';
      if (desc) html += '<p class="text-sm text-on-surface-variant mt-0.5">' + desc + '</p>';
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  },

  bindDetailEvents(p, hasStockItem) {
    // Tab switching
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        // Update tab button active states
        document.querySelectorAll('[data-tab]').forEach(b => {
          if (b === btn) {
            b.classList.add('active');
            b.classList.remove('border-transparent');
            b.classList.add('border-secondary');
          } else {
            b.classList.remove('active');
            b.classList.remove('border-secondary');
            b.classList.add('border-transparent');
          }
        });
        // Update panel visibility
        document.querySelectorAll('[data-tab-panel]').forEach(panel => {
          panel.classList.toggle('hidden', panel.getAttribute('data-tab-panel') !== btn.getAttribute('data-tab'));
        });

        // If switching to inventory, reload stock data
        if (btn.dataset.tab === 'inventory') {
          this.reloadInventoryPanel();
        }
        // If switching to activity, reload activity data
        if (btn.dataset.tab === 'activity') {
          const pid = p?.id || this._lastProduct?.id;
          if (pid) this._loadActivity(pid);
        }
      });
    });

    // Edit button
    const editBtn = document.getElementById('prod-detail-edit');
    if (editBtn) editBtn.addEventListener('click', () => this.openForm(p));

    // Inventory button
    const invBtn = document.getElementById('prod-detail-inventory');
    if (invBtn) invBtn.addEventListener('click', () => { window.location.hash = '#inventory/stock_items'; });

    // Enable inventory button (if not tracked)
    const enableBtn = document.getElementById('prod-enable-inventory');
    if (enableBtn) enableBtn.addEventListener('click', () => this.openForm(p));

    // Load serial numbers if serial tracking is enabled
    const si = p.stockItem || {};
    if (si && si.isSerialTracked && si.id) {
      this._loadDetailSerials(si.id);
    }

    // Three-dot menu (dropdown, not Modal)
    const menuBtn = document.getElementById('prod-detail-menu');
    if (menuBtn) {
      const isActive = p.isActive;
      const menuItems = [
        { label: 'Duplicate', icon: 'content_copy' },
        { label: 'Export', icon: 'file_download' },
        { label: isActive ? 'Deactivate' : 'Activate', icon: isActive ? 'toggle_off' : 'toggle_on' },
        { label: 'Delete', icon: 'delete' },
      ];

      const menuContent = menuItems.map(m => `
        <button data-action="${m.label}" class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-secondary/30 text-left w-full">
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant/60">${m.icon}</span>
          <span>${m.label}</span>
        </button>
      `).join('');

      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = menuBtn.getBoundingClientRect();
        const menu = document.createElement('div');
        menu.className = 'fixed z-[100] bg-surface-container-lowest rounded-xl shadow-xl border border-outline-variant/50 min-w-[200px] animate-scale-in';
        menu.style.top = (rect.bottom + 8) + 'px';
        menu.style.right = (window.innerWidth - rect.right + 8) + 'px';
        menu.innerHTML = `<div class="p-2">${menuContent}</div>`;
        document.body.appendChild(menu);

        menu.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const action = btn.dataset.action;
          menu.remove();
          if (action === 'Delete') this.confirmDelete(p);
          else if (action === 'Deactivate' || action === 'Activate') await this.toggleStatus(p);
          else if (action === 'Duplicate') window.location.hash = '#products';
          else if (action === 'Export') Toast.success('Export feature coming soon');
        });

        document.addEventListener('click', () => menu.remove(), { once: true });
      });
    }
  },

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Build a human-readable hierarchy path from a product or stock item.
   * For edit mode: uses cached model names from the models list if available.
   */
  _buildHierarchyPath(p, si) {
    const modelId = p.model_id || p.modelId || si.model_id || si.modelId;
    if (!modelId) return '';
    
    // Try to find the model in our cached list
    const model = this.models.find(m => m.id === modelId);
    if (!model) return '';

    // Build from available model data
    const parts = [];
    if (model.stockGroupName) parts.push(model.stockGroupName);
    if (model.stockCategoryName) parts.push(model.stockCategoryName);
    if (model.brandName) parts.push(model.brandName);
    if (model.name) parts.push(model.name);
    return parts.join(' → ') || '';
  },

  /**
   * Render a compact breadcrumb showing the full hierarchy.
   */
  _renderHierarchyBreadcrumb(p) {
    const group = p.stockGroupName;
    const category = p.stockCategoryName;
    const brand = p.brandName;
    const model = p.modelName;
    // If the model name already starts with the brand name, skip the separate
    // brand level to avoid a redundant breadcrumb entry (e.g. "HP > HP Victus").
    const brandIsRedundant = brand && model && model.startsWith(brand);
    const parts = [group, category, brandIsRedundant ? null : brand, model].filter(Boolean);
    if (!parts.length) return '';
    
    return `
      <div class="mt-2 flex items-center gap-2 text-sm text-on-surface-variant/80">
        <span class="material-symbols-outlined text-[14px]">labels</span>
        <span class="font-medium text-on-surface-variant">Hierarchy:</span>
        ${parts.map((part, i) => `
          <span>${this.escapeHtml(part)}</span>
          ${i < parts.length - 1 ? '<span class="material-symbols-outlined text-[14px]">chevron_right</span>' : ''}
        `).join('')}
      </div>
    `;
  },

  /**
   * Pre-fetch hierarchy for the product's model (used in edit mode).
   * Ensures the hierarchy display is populated when the form opens.
   */
  async _preloadHierarchy(modal, modelId) {
    if (!modelId) return null;
    try {
      return await API.get(`/inventory/models/${modelId}/hierarchy`);
    } catch {
      return null;
    }
  },

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  showFriendlyError(err) {
    const status = err.status || err.code;
    if (status === 409 || status === 'CONSTRAINT_VIOLATION' || status === 'FOREIGN_KEY_VIOLATION') {
      // Show the server's actual message when available — a static "category or unit"
      // message misleads users when the real cause is something else (e.g. godown).
      Toast.error(err.message || 'We couldn\'t save this product because the selected category or unit is no longer available. Please refresh and try again.');
    } else if (status === 400) {
      Toast.error(err.message || 'Please check your input and try again.');
    } else {
      Toast.error(err.message || 'Something went wrong. Please try again.');
    }
  },
};
