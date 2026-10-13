window.PageModules = window.PageModules || {};

// Cost Centres, Cost Categories, Budgets, Bank Accounts — all master data pages
window.PageModules.costCentres = {
  table: null,
  pagination: null,
  state: { page: 1, pageSize: 20, search: '' },
  searchTimer: null,

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div><h1 class="font-display text-h1 text-on-surface tracking-tight">Cost Centres</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage organizational cost centres.</p></div>
          <button id="cc-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
            <span class="material-symbols-outlined text-[18px]">add</span> New Cost Centre
          </button>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="p-container-padding border-b border-outline-variant/30">
            <div class="relative flex-1 min-w-[200px]">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
              <input id="cc-search" placeholder="Search cost centres..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
          </div>
          <div id="cc-table" class="p-0"></div>
          <div id="cc-pagination" class="p-container-padding border-t border-outline-variant/30"></div>
        </div>
      </div>
    `;
    this.bindEvents();
    await this.load();
    return () => {};
  },

  bindEvents() {
    document.getElementById('cc-new').addEventListener('click', () => this.openForm());
    document.getElementById('cc-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.load(); }, 300);
    });
  },

  async load() {
    const container = document.getElementById('cc-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/accounting/cost-centres', { page: this.state.page, limit: this.state.pageSize, q: this.state.search });
      const items = res?.data?.items || res?.items || [];
      this.renderTable(container, items, res?.data?.total || items.length);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  renderTable(container, items, total) {
    container.innerHTML = '';
    this.table = new DataTable(container, {
      columns: [
        { key: 'code', label: 'Code', render: (v) => `<span class="font-code">${v || ''}</span>` },
        { key: 'name', label: 'Name' },
        { key: 'description', label: 'Description' },
        { key: 'is_active', label: 'Status', render: (v) => StatusBadge.render(v ? 'active' : 'inactive') },
      ],
      data: items,
      emptyState: 'No cost centres found',
      rowActions: (row) => this.openRowMenu(row),
    });
    this.updatePagination(total);
  },

  updatePagination(total) {
    if (!this.pagination) {
      this.pagination = new Pagination(document.getElementById('cc-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
        onPageChange: (p) => { this.state.page = p; this.load(); },
      });
    } else {
      this.pagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
    }
  },

  openRowMenu(row) {
    const modal = new Modal({
      title: row.name, size: 'sm',
      content: '<div class="flex flex-col gap-1">' +
        '<button data-act="edit" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>' +
        '<button data-act="delete" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-error text-left"><span class="material-symbols-outlined text-[18px]">delete</span> Delete</button></div>'
    });
    modal.open();
    modal.element.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      modal.close();
      if (act === 'edit') return this.openForm(row);
      if (act === 'delete') return this.delete(row);
    });
  },

  openForm(row = null) {
    const isEdit = !!row;
    const modal = new Modal({
      title: isEdit ? 'Edit Cost Centre' : 'New Cost Centre', size: 'md',
      content: `
        <form id="cc-form" class="space-y-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Code</label>
              <input name="code" value="${row?.code || ''}" ${isEdit ? '' : 'readonly'} placeholder="${isEdit ? '' : 'Loading…'}" class="font-code ${isEdit ? 'w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md' : 'w-full bg-surface-container border border-outline-variant/40 rounded-lg px-3 py-2 text-body-md opacity-80 cursor-not-allowed'}"/>
              ${isEdit ? '' : '<div class="font-body-xs text-on-surface-variant mt-1">Auto-generated</div>'}</div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Name *</label>
              <input name="name" value="${row?.name || ''}" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label>
            <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">${row?.description || ''}</textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      `
    });
    modal.open();
    if (!isEdit) {
      API.get('/accounting/codes/preview?entity=COST_CENTRE').then((r) => {
        const codeInput = modal.element.querySelector('#cc-form input[name="code"]');
        if (codeInput && r?.code) codeInput.value = r.code;
      }).catch(() => {});
    }
    modal.element.querySelector('#cc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        if (isEdit) await API.put('/accounting/cost-centres/' + row.id, { code: fd.get('code'), name: fd.get('name'), description: fd.get('description') });
        else await API.post('/accounting/cost-centres', { code: fd.get('code'), name: fd.get('name'), description: fd.get('description') });
        Toast.success(isEdit ? 'Updated' : 'Created'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  async delete(row) {
    const modal = new Modal({
      title: 'Delete Cost Centre?', size: 'sm',
      content: `<p class="font-body-md text-on-surface mb-stack-md">Delete <strong>${row.code} - ${row.name}</strong>?</p>
        <div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
        <button id="confirm-cc-delete" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Delete</button></div>`
    });
    modal.open();
    modal.element.querySelector('#confirm-cc-delete').addEventListener('click', async () => {
      try { await API.del('/accounting/cost-centres/' + row.id); Toast.success('Deleted'); modal.close(); this.load(); }
      catch (err) { Toast.error(err.message || 'Failed'); }
    });
  }
};

window.PageModules.costCategories = {
  table: null,
  state: { page: 1, pageSize: 20, search: '' },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div><h1 class="font-display text-h1 text-on-surface tracking-tight">Cost Categories</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage cost classification categories.</p></div>
          <button id="cat-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
            <span class="material-symbols-outlined text-[18px]">add</span> New Category
          </button>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="p-container-padding border-b border-outline-variant/30">
            <input id="cat-search" placeholder="Search categories..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div id="cat-table" class="overflow-x-auto"></div>
        </div>
      </div>
    `;
    this.bindEvents();
    await this.load();
    return () => {};
  },

  bindEvents() {
    document.getElementById('cat-new').addEventListener('click', () => this.openForm());
    document.getElementById('cat-search').addEventListener('input', (e) => {
      setTimeout(() => { this.state.search = e.target.value; this.load(); }, 300);
    });
  },

  async load() {
    const container = document.getElementById('cat-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/accounting/cost-categories', { limit: this.state.pageSize, q: this.state.search });
      const items = res?.data?.items || res?.items || [];
      container.innerHTML = `
        <table class="w-full">
          <thead class="bg-surface-container-low"><tr>
            <th class="text-left py-2 font-label-md">Code</th><th class="text-left py-2 font-label-md">Name</th>
            <th class="text-left py-2 font-label-md">Description</th><th class="text-center py-2 font-label-md">Status</th><th class="w-[80px]"></th>
          </tr></thead>
          <tbody>${items.map(c => `
            <tr class="border-b border-outline-variant/20">
              <td class="py-2 font-code">${c.code}</td><td class="py-2">${c.name}</td><td class="py-2 text-body-sm text-on-surface-variant">${c.description || ''}</td>
              <td class="py-2 text-center">${StatusBadge.render(c.is_active ? 'active' : 'inactive')}</td>
              <td class="py-2"><button onclick="window.PageModules.costCategories.openForm(${JSON.stringify(c).replace(/"/g, '&quot;')})" class="text-secondary p-1">
                <span class="material-symbols-outlined text-[16px]">edit</span></button></td>
            </tr>
          `).join('')}
          ${items.length === 0 ? '<tr><td colspan="5" class="py-8 text-center text-on-surface-variant">No categories found</td></tr>' : ''}
        </tbody></table>
      `;
    } catch { ErrorState.render(container, () => this.load()); }
  },

  openForm(row = null) {
    const isEdit = !!row;
    const modal = new Modal({
      title: isEdit ? 'Edit Category' : 'New Cost Category', size: 'md',
      content: `
        <form id="cat-form" class="space-y-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Code</label>
              <input name="code" value="${row?.code || ''}" ${isEdit ? '' : 'readonly'} placeholder="${isEdit ? '' : 'Loading…'}" class="font-code ${isEdit ? 'w-file bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md' : 'w-file bg-surface-container border border-outline-variant/40 rounded-lg px-3 py-2 text-body-md opacity-80 cursor-not-allowed'}"/>
              ${isEdit ? '' : '<div class="font-body-xs text-on-surface-variant mt-1">Auto-generated</div>'}</div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Name *</label>
              <input name="name" value="${row?.name || ''}" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label>
            <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">${row?.description || ''}</textarea></div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      `
    });
    modal.open();
    if (!isEdit) {
      API.get('/accounting/codes/preview?entity=COST_CATEGORY').then((r) => {
        const codeInput = modal.element.querySelector('#cat-form input[name="code"]');
        if (codeInput && r?.code) codeInput.value = r.code;
      }).catch(() => {});
    }
    modal.element.querySelector('#cat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        if (isEdit) await API.put('/accounting/cost-categories/' + row.id, { code: fd.get('code'), name: fd.get('name'), description: fd.get('description') });
        else await API.post('/accounting/cost-categories', { code: fd.get('code'), name: fd.get('name'), description: fd.get('description') });
        Toast.success(isEdit ? 'Updated' : 'Created'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  }
};

window.PageModules.budgets = {
  table: null,
  state: { page: 1, pageSize: 20 },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div><h1 class="font-display text-h1 text-on-surface tracking-tight">Budgets</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Plan and track budgets against actuals.</p></div>
          <button id="budget-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
            <span class="material-symbols-outlined text-[18px]">add</span> New Budget
          </button>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div id="budget-table" class="overflow-x-auto"></div>
          <div id="budget-pagination" class="p-container-padding border-t border-outline-variant/30"></div>
        </div>
      </div>
    `;
    document.getElementById('budget-new').addEventListener('click', () => this.openForm());
    await this.load();
    return () => {};
  },

  async load() {
    const container = document.getElementById('budget-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/accounting/budgets', { page: this.state.page, limit: this.state.pageSize });
      const items = res?.items || res?.data?.items || [];
      const total = res?.total || res?.data?.total || items.length;
      container.innerHTML = `
        <table class="w-full">
          <thead class="bg-surface-container-low"><tr>
            <th class="text-left py-2 font-label-md">Name</th><th class="text-left py-2 font-label-md">Type</th>
            <th class="text-right py-2 font-label-md">Budget</th><th class="text-right py-2 font-label-md">Actual</th>
            <th class="text-right py-2 font-label-md">Variance</th><th class="text-center py-2 font-label-md">Status</th><th class="w-[60px]"></th>
          </tr></thead>
          <tbody>${items.map(b => {
            const totalBudget = (b.lines || []).reduce((s, l) => s + (parseFloat(l.budget_amount) || 0), 0);
            const totalActual = (b.lines || []).reduce((s, l) => s + (parseFloat(l.actual_amount) || 0), 0);
            const totalVariance = totalBudget - totalActual;
            return `<tr class="border-b border-outline-variant/20">
              <td class="py-2 font-medium">${b.name}</td>
              <td class="py-2 text-body-sm text-on-surface-variant">${b.budget_type}</td>
              <td class="py-2 text-right font-code">${AccountingState.fmt(totalBudget)}</td>
              <td class="py-2 text-right font-code">${AccountingState.fmt(totalActual)}</td>
              <td class="py-2 text-right font-code ${totalVariance >= 0 ? 'text-green-700' : 'text-error'}">${AccountingState.fmt(totalVariance)}</td>
              <td class="py-2 text-center">${StatusBadge.render(b.is_active ? 'active' : 'inactive')}</td>
              <td class="py-2"><button onclick="window.PageModules.budgets.view(${b.id})" class="text-secondary p-1">
                <span class="material-symbols-outlined text-[16px]">visibility</span></button></td>
            </tr>`;
          }).join('')}
          ${items.length === 0 ? '<tr><td colspan="7" class="py-8 text-center text-on-surface-variant">No budgets found</td></tr>' : ''}
        </tbody></table>
      `;
    } catch { ErrorState.render(container, () => this.load()); }
  },

  view(budgetId) {
    // Show budget detail with lines
    const content = `
      <div id="budget-detail-content"><div class="text-center py-12"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div></div>
    `;
    const modal = new Modal({ title: 'Budget Details', size: '4xl', content });
    modal.open();
    API.get('/accounting/budgets/' + budgetId).then(res => {
      const budget = res?.data || res || {};
      const lines = budget.lines || [];
      const container = document.getElementById('budget-detail-content');
      container.innerHTML = `
        <h3 class="font-display text-h2 text-on-surface mb-stack-md">${budget.name}</h3>
        <table class="w-full">
          <thead class="bg-surface-container-low"><tr>
            <th class="text-left py-2 font-label-md">Account</th><th class="text-left py-2 font-label-md">Cost Centre</th>
            <th class="text-right py-2 font-label-md">Budget</th><th class="text-right py-2 font-label-md">Actual</th>
            <th class="text-right py-2 font-label-md">Variance</th><th class="text-right py-2 font-label-md">Variance %</th>
          </tr></thead>
          <tbody>${lines.map(l => `
            <tr class="border-b border-outline-variant/20">
              <td class="py-2 font-code">${l.account_code || ''} - ${l.account_name || ''}</td>
              <td class="py-2">${l.cost_centre_code || '-'} ${l.cost_centre_name || ''}</td>
              <td class="py-2 text-right font-code">${AccountingState.fmt(l.budget_amount)}</td>
              <td class="py-2 text-right font-code">${AccountingState.fmt(l.actual_amount)}</td>
              <td class="py-2 text-right font-code ${l.variance >= 0 ? 'text-green-700' : 'text-error'}">${AccountingState.fmt(l.variance)}</td>
              <td class="py-2 text-right font-code">${(l.variance_percentage || 0).toFixed(2)}%</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
    }).catch(() => {
      document.getElementById('budget-detail-content').innerHTML = '<p class="text-error">Failed to load budget details</p>';
    });
  },

  openForm(row = null) {
    const isEdit = !!row;
    // Fetch financial years for the dropdown
    API.get('/accounting/financial-years').then(fyRes => {
      const fys = fyRes?.data || fyRes?.items || [];
      const activeFy = fys.find(f => f.is_active) || fys[0];

      const modal = new Modal({
        title: isEdit ? 'Edit Budget' : 'New Budget', size: '4xl',
        content: `
          <form id="budget-form" class="space-y-stack-md">
            <div class="grid grid-cols-3 gap-stack-md">
              <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Name *</label>
                <input name="name" value="${row?.name || ''}" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
              <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Financial Year *</label>
                <select name="financial_year_id" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                  ${fys.map(f => `<option value="${f.id}" ${f.id === activeFy?.id ? 'selected' : ''}>${f.name}</option>`).join('')}
                </select></div>
              <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Budget Type</label>
                <select name="budget_type" class="w-file bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                  <option value="EXPENSE">Expense</option><option value="REVENUE">Revenue</option><option value="COST_CENTRE">Cost Centre</option>
                </select></div>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Budget Lines</label>
              <div class="border border-outline-variant/30 rounded-lg overflow-hidden">
                <table class="w-full">
                  <thead class="bg-surface-container-low"><tr>
                    <th class="text-left py-2 font-label-md">Account</th><th class="text-left py-2 font-label-md">Period</th>
                    <th class="text-right py-2 font-label-md">Amount</th><th class="w-[40px]"></th>
                  </tr></thead>
                  <tbody id="budget-lines-body"></tbody>
                </table>
              </div>
              <button type="button" id="budget-add-line" class="mt-2 text-secondary font-body-sm hover:underline">+ Add Line</button>
            </div>
            <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
              <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
              <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'} Budget</button>
            </div>
          </form>
        `
      });
      modal.open();

      this.budgetLines = row?.lines?.length ? row.lines.map(l => ({ account_id: l.account_id, period: l.period || 'FY', amount: l.budget_amount })) : [{ account_id: '', period: 'FY', amount: '' }];
      this.renderBudgetLines(modal);

      document.getElementById('budget-add-line').addEventListener('click', () => {
        this.budgetLines.push({ account_id: '', period: 'FY', amount: '' });
        this.renderBudgetLines(modal);
      });

      modal.element.querySelector('#budget-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await API.post('/accounting/budgets', {
            name: fd.get('name'),
            financial_year_id: fd.get('financial_year_id'),
            budget_type: fd.get('budget_type'),
            lines: this.budgetLines
          });
          Toast.success('Budget created'); modal.close(); this.load();
        } catch (err) { Toast.error(err.message || 'Failed'); }
      });
    });
  },

  renderBudgetLines(modal) {
    const tbody = modal.element.querySelector('#budget-lines-body');
    tbody.innerHTML = this.budgetLines.map((l, idx) => `
      <tr class="border-b border-outline-variant/20">
        <td class="p-2">
          <select data-idx="${idx}" data-k="account_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm">
            <option value="">Select account</option>
          </select>
        </td>
        <td class="p-2"><input data-idx="${idx}" data-k="period" value="${l.period || 'FY'}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm"/></td>
        <td class="p-2"><input data-idx="${idx}" data-k="amount" type="number" step="0.01" value="${l.amount || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-2 py-1 text-body-sm text-right"/></td>
        <td class="p-2"><button type="button" data-rm="${idx}" class="text-error"><span class="material-symbols-outlined text-[16px]">close</span></button></td>
      </tr>
    `).join('');

    this._loadAccountOptions(tbody).then(accounts => {
      tbody.querySelectorAll('select[data-k="account_id"]').forEach(sel => {
        const idx = parseInt(sel.dataset.idx);
        const current = this.budgetLines[idx].account_id;
        sel.innerHTML = '<option value="">Select account</option>' + accounts.map(a =>
          `<option value="${a.id}" ${a.id === current ? 'selected' : ''}>${a.code} - ${a.name}</option>`
        ).join('');
      });
    });
    tbody.querySelectorAll('input[data-idx]').forEach(inp => {
      inp.addEventListener('input', () => {
        this.budgetLines[+inp.dataset.idx][inp.dataset.k] = inp.dataset.k === 'amount' ? parseFloat(inp.value) || '' : inp.value;
      });
    });
    tbody.querySelectorAll('select[data-idx]').forEach(sel => {
      sel.addEventListener('change', () => { this.budgetLines[+sel.dataset.idx][sel.dataset.k] = sel.value; });
    });
    tbody.querySelectorAll('[data-rm]').forEach(b => {
      b.addEventListener('click', () => { this.budgetLines.splice(+b.dataset.rm, 1); this.renderBudgetLines(modal); });
    });
  },

  async _loadAccountOptions(tbody) {
    try {
      const res = await API.get('/accounting/accounts', { limit: 1000 });
      return (res?.data?.items || []).filter(a => !a.is_group && a.allow_direct_posting !== false);
    } catch { return []; }
  }
};

window.PageModules.bankAccounts = {
  table: null,
  state: { page: 1, pageSize: 20 },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div><h1 class="font-display text-h1 text-on-surface tracking-tight">Bank Accounts</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage bank accounts and cash book tracking.</p></div>
          <button id="bank-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
            <span class="material-symbols-outlined text-[18px]">add</span> New Bank Account
          </button>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div id="bank-table" class="overflow-x-auto"></div>
        </div>
      </div>
    `;
    document.getElementById('bank-new').addEventListener('click', () => this.openForm());
    await this.load();
    return () => {};
  },

  async load() {
    const container = document.getElementById('bank-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/accounting/bank-accounts');
      const items = res?.items || res?.data?.items || [];
      const bankBalance = items.reduce((sum, b) => sum + (parseFloat(b.opening_balance) || 0), 0);
      container.innerHTML = `
        <table class="w-full">
          <thead class="bg-surface-container-low"><tr>
            <th class="text-left py-2 font-label-md">Account Name</th><th class="text-left py-2 font-label-md">Bank</th>
            <th class="text-left py-2 font-label-md">Account #</th><th class="text-right py-2 font-label-md">Opening Balance</th>
            <th class="text-center py-2 font-label-md">Status</th><th class="w-[60px]"></th>
          </tr></thead>
          <tbody>${items.map(b => `
            <tr class="border-b border-outline-variant/20">
              <td class="py-2 font-medium">${b.account_name}</td>
              <td class="py-2 text-body-sm text-on-surface-variant">${b.bank_name || '—'}</td>
              <td class="py-2 font-code">${b.account_number || '—'}</td>
              <td class="py-2 text-right font-code">${AccountingState.fmt(b.opening_balance)}</td>
              <td class="py-2 text-center">${StatusBadge.render(b.is_active ? 'active' : 'inactive')}</td>
              <td class="py-2"><button onclick="window.PageModules.bankAccounts.viewBankBook('${b.id}')" class="text-secondary p-1">
                <span class="material-symbols-outlined text-[16px]">visibility</span></button></td>
            </tr>
          `).join('')}
          ${items.length === 0 ? '<tr><td colspan="6" class="py-8 text-center text-on-surface-variant">No bank accounts found</td></tr>' : ''}
          <tfoot class="bg-surface-container-low"><tr>
            <td colspan="4" class="py-2 font-medium">Total Opening Balance</td>
            <td colspan="2" class="py-2 text-right font-display font-bold">${AccountingState.fmt(bankBalance)}</td>
          </tr></tfoot>
        </tbody></table>
      `;
    } catch { ErrorState.render(container, () => this.load()); }
  },

  viewBankBook(bankAccountId) {
    // This would open the bank book for the selected account
    window.location.hash = `#accounting/ledger/${bankAccountId}`;
  },

  openForm(row = null) {
    const isEdit = !!row;
    const modal = new Modal({
      title: isEdit ? 'Edit Bank Account' : 'New Bank Account', size: 'lg',
      content: `
        <form id="bank-form" class="space-y-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Account Name *</label>
              <input name="account_name" value="${row?.account_name || ''}" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Account Type</label>
              <select name="account_type" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                <option value="CHECKING" ${row?.account_type === 'CHECKING' ? 'selected' : ''}>Checking</option>
                <option value="SAVINGS" ${row?.account_type === 'SAVINGS' ? 'selected' : ''}>Savings</option>
                <option value="CASH" ${row?.account_type === 'CASH' ? 'selected' : ''}>Cash</option>
              </select></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Account Number</label>
              <input name="account_number" value="${row?.account_number || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Bank Name</label>
              <input name="bank_name" value="${row?.bank_name || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">IFSC Code</label>
              <input name="ifsc_code" value="${row?.ifsc_code || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">GL Account *</label>
              <select name="gl_account_id" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md" id="bank-gl-select"></select></div>
            <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Opening Balance</label>
              <input name="opening_balance" type="number" step="0.01" value="${row?.opening_balance || 0}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/></div>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'} Bank Account</button>
          </div>
        </form>
      `
    });
    modal.open();
    this._loadGLAccounts('#bank-gl-select', row?.gl_account_id);
    modal.element.querySelector('#bank-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const payload = {
          account_name: fd.get('account_name'),
          account_number: fd.get('account_number'),
          bank_name: fd.get('bank_name'),
          ifsc_code: fd.get('ifsc_code'),
          account_type: fd.get('account_type'),
          gl_account_id: fd.get('gl_account_id'),
          opening_balance: parseFloat(fd.get('opening_balance')) || 0
        };
        if (isEdit) await API.put('/accounting/bank-accounts/' + row.id, payload);
        else await API.post('/accounting/bank-accounts', payload);
        Toast.success(isEdit ? 'Updated' : 'Created'); modal.close(); this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  async _loadGLAccounts(selector, selectedId) {
    try {
      const res = await API.get('/accounting/accounts/gl');
      const accounts = (res?.items || res?.data?.items || []).filter(a =>
        ['BANK', 'CASH', 'ASSET'].includes(a.type)
      );
      const el = document.querySelector(selector);
      if (el) el.innerHTML = '<option value="">Select GL account</option>' + accounts.map(a =>
        `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${a.code} - ${a.name}</option>`
      ).join('');
    } catch {}
  }
};
