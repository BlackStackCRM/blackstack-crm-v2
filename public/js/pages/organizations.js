window.PageModules = window.PageModules || {};

window.PageModules.organizations = {
  table: null,
  pagination: null,
  currentCurrency: 'USD',
  state: { page: 1, pageSize: 10, search: '', industry: '' },
  searchTimer: null,

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    // Load default currency from settings
    try {
      const settings = await API.get('/settings');
      this.currentCurrency = settings.defaultCurrency || 'USD';
    } catch { /* use default */ }

    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Organizations</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage your companies and accounts.</p>
        </div>
        <button id="org-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90"><span class="material-symbols-outlined text-[18px]">add</span> New Organization</button>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
          <div class="relative flex-1 min-w-[200px]">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="org-search" placeholder="Search organizations..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <select id="org-industry" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All industries</option>
            <option value="Technology">Technology</option>
            <option value="Finance">Finance</option>
            <option value="Healthcare">Healthcare</option>
            <option value="Retail">Retail</option>
            <option value="Manufacturing">Manufacturing</option>
          </select>
        </div>
        <div id="orgs-table"></div>
        <div id="orgs-pagination"></div>
      </div>
    `;

    this.bindEvents();
    await this.load();

    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('org-new').addEventListener('click', () => this.openForm());
    const search = document.getElementById('org-search');
    search.addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.load(); }, 300);
    });
    document.getElementById('org-industry').addEventListener('change', (e) => { this.state.industry = e.target.value; this.state.page = 1; this.load(); });
  },

  async load() {
    const container = document.getElementById('orgs-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { page: this.state.page, pageSize: this.state.pageSize, search: this.state.search, industry: this.state.industry };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/organizations', params);
      const data = res?.data || res || {};
      const items = data.items || data.organizations || data || [];
      const total = data.total || items.length;
      this.renderTable(container, items, total);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  renderTable(container, items, total) {
    const fmt = (n) => Currency.format(n, this.currentCurrency);
    this.table = new DataTable(container, {
      columns: [
        { key: 'name', label: 'Name', render: (v, r) => '<div class="flex items-center gap-stack-sm"><div class="w-8 h-8 rounded-lg bg-secondary-container/20 flex items-center justify-center"><span class="material-symbols-outlined text-[18px] text-secondary">corporate_fare</span></div><a href="#contacts?org=' + r.id + '" class="font-medium hover:text-secondary">' + (v || '') + '</a></div>' },
        { key: 'industry', label: 'Industry' },
        { key: 'contactCount', label: 'Contacts', render: (v) => v || 0, align: 'right' },
        { key: 'activeDeals', label: 'Active deals', render: (v, r) => (v || 0) + ' · ' + fmt(r.activeValue), align: 'right' },
      ],
      data: items,
      selectable: true,
      emptyState: 'No organizations',
      rowActions: (row) => this.openRowMenu(row),
    });

    if (!this.pagination) {
      this.pagination = new Pagination(document.getElementById('orgs-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
        onPageChange: (p) => { this.state.page = p; this.load(); },
      });
    } else {
      this.pagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
    }
  },
openRowMenu(row) {
    const modal = new Modal({ title: row.name, size: 'sm', content: '<div class="flex flex-col gap-1"><button data-act="edit" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md text-left"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button><button data-act="delete" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-body-md text-error text-left"><span class="material-symbols-outlined text-[18px]">delete</span> Delete</button></div>' });
    modal.open();
    modal.element.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'edit') { modal.close(); this.openForm(row); }
      if (act === 'delete') { modal.close(); this.confirmDelete(row); }
    });
  },

  openForm(row = null) {
    const isEdit = !!row;
    const o = row || {};
    const modal = new Modal({
      title: isEdit ? 'Edit Organization' : 'New Organization',
      size: 'lg',
      content: `
        <form id="org-form" class="grid grid-cols-2 gap-stack-md">
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Name *</label>
            <input name="name" required value="${o.name || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Industry</label>
            <input name="industry" value="${o.industry || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Website</label>
            <input name="website" value="${o.website || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Address</label>
            <textarea name="address" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">${o.address || ''}</textarea>
          </div>
          <div class="col-span-2 flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#org-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd.entries());
      try {
        if (isEdit) await API.put(`/organizations/${o.id}`, payload);
        else await API.post('/organizations', payload);
        Toast.success(isEdit ? 'Organization updated' : 'Organization created');
        modal.close();
        this.load();
      } catch (err) {
        Toast.error(err.message || 'Failed to save');
      }
    });
  },

  confirmDelete(row) {
    const modal = new Modal({ title: 'Delete organization?', size: 'sm', content: '<p class="font-body-md text-on-surface mb-stack-md">Delete <strong>' + row.name + '</strong>?</p><div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button><button id="confirm-org-delete" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Delete</button></div>' });
    modal.open();
    modal.element.querySelector('#confirm-org-delete').addEventListener('click', async () => {
      try {
        await API.del(`/organizations/${row.id}`);
        Toast.success('Organization deleted');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },
};
