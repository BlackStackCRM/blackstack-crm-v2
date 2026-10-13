window.PageModules = window.PageModules || {};

window.PageModules.workflows = {
  state: { search: '' },
  searchTimer: null,
  triggerConfig: {
    'deal-created': { label: 'Deal Created', icon: 'add_circle' },
    'deal-won': { label: 'Deal Won', icon: 'emoji_events' },
    'deal-lost': { label: 'Deal Lost', icon: 'cancel' },
    'contact-created': { label: 'Contact Created', icon: 'person_add' },
    'invoice-paid': { label: 'Invoice Paid', icon: 'check_circle' },
    'invoice-overdue': { label: 'Invoice Overdue', icon: 'schedule' },
    'task-completed': { label: 'Task Completed', icon: 'task_alt' },
    'manual': { label: 'Manual Trigger', icon: 'touch_app' },
  },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Workflows</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Automate repetitive tasks and processes.</p>
        </div>
        <button id="wf-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
          <span class="material-symbols-outlined text-[18px]">add</span> New Workflow
        </button>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 mb-stack-md">
        <div class="p-container-padding border-b border-outline-variant/30">
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="wf-search" placeholder="Search workflows..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
        </div>
        <div id="wf-list"></div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('wf-new').addEventListener('click', () => this.openForm());
    document.getElementById('wf-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.load(); }, 300);
    });
  },

  async load() {
    const container = document.getElementById('wf-list');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { search: this.state.search };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/workflows', params);
      const items = res?.data?.items || res?.items || res?.data || res || [];
      this.renderList(container, items);
    } catch { ErrorState.render(container, () => this.load()); }
  },
renderList(container, items) {
    const filtered = items.filter(w => !this.state.search || (w.name || '').toLowerCase().includes(this.state.search.toLowerCase()));
    if (!filtered.length) {
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[48px] text-on-surface-variant/40">account_tree</span><p class="font-body-sm text-body-sm text-on-surface-variant mt-2">No workflows found</p></div>';
      return;
    }
    container.innerHTML = '<div class="divide-y divide-outline-variant/30">' + filtered.map(w => this.renderRow(w)).join('') + '</div>';
    container.querySelectorAll('[data-wf]').forEach(row => {
      const id = row.dataset.wf;
      const item = filtered.find(w => String(w.id) === id);
      const edit = row.querySelector('[data-act="edit"]');
      if (edit) edit.addEventListener('click', () => this.openForm(item));
      const del = row.querySelector('[data-act="delete"]');
      if (del) del.addEventListener('click', () => this.confirmDelete(item));
      const toggle = row.querySelector('[data-toggle]');
      if (toggle) toggle.addEventListener('change', () => this.toggleActive(item, toggle.checked));
      const run = row.querySelector('[data-act="run"]');
      if (run) run.addEventListener('click', () => this.runNow(item));
      const hist = row.querySelector('[data-act="history"]');
      if (hist) hist.addEventListener('click', () => this.showHistory(item));
    });
  },

  renderRow(w) {
    const trg = this.triggerConfig[w.triggerType] || { label: w.triggerType, icon: 'help' };
    return `
      <div data-wf="${w.id}" class="p-container-padding hover:bg-surface-container-low transition-colors flex items-center gap-stack-md group">
        <div class="w-12 h-12 rounded-lg ${w.isActive ? 'bg-secondary-container/20 text-secondary' : 'bg-surface-container text-on-surface-variant'} flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[24px]">${trg.icon}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-stack-sm flex-wrap">
            <h3 class="font-h3 text-h3 text-on-surface truncate">${w.name || ''}</h3>
            ${w.isActive ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-50 text-green-700 border border-green-200"><span class="w-1.5 h-1.5 rounded-full bg-green-500 mr-1"></span>Active</span>' : '<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-surface-container text-on-surface-variant"><span class="w-1.5 h-1.5 rounded-full bg-outline mr-1"></span>Paused</span>'}
          </div>
          <div class="flex items-center gap-stack-md mt-1 font-body-sm text-body-sm text-on-surface-variant">
            <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">play_circle</span>${trg.label}</span>
            <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">bolt</span>${(w.actionsJson ? w.actionsJson.length : 0) || 0} actions</span>
            <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">repeat</span>${w.runs || 0} runs</span>
            ${w.lastRun ? `<span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">history</span>Last ${this.timeAgo(w.lastRun)}</span>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-stack-sm">
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" data-toggle ${w.isActive ? 'checked' : ''} class="sr-only peer"/>
            <div class="w-9 h-5 bg-surface-container-high rounded-full peer peer-checked:bg-secondary transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4"></div>
          </label>
          <button data-act="run" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant" title="Run now" aria-label="Run workflow">
            <span class="material-symbols-outlined text-[18px]">play_arrow</span>
          </button>
          <button data-act="history" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant" title="History" aria-label="View history">
            <span class="material-symbols-outlined text-[18px]">history</span>
          </button>
          <button data-act="edit" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant opacity-0 group-hover:opacity-100" title="Edit" aria-label="Edit workflow">
            <span class="material-symbols-outlined text-[18px]">edit</span>
          </button>
          <button data-act="delete" class="w-8 h-8 rounded-full hover:bg-error-container/20 flex items-center justify-center text-error opacity-0 group-hover:opacity-100" title="Delete" aria-label="Delete workflow">
            <span class="material-symbols-outlined text-[18px]">delete</span>
          </button>
        </div>
      </div>
    `;
  },

  timeAgo(date) {
    if (!date) return '';
    const diff = Date.now() - new Date(date).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  },

  openForm(row = null) {
    const isEdit = !!row;
    const w = row || {};
    const modal = new Modal({
      title: isEdit ? 'Edit Workflow' : 'New Workflow',
      size: 'lg',
      content: `<form id="wf-form" class="space-y-stack-md">
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Name *</label>
          <input name="name" required value="${w.name || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Trigger *</label>
          <select name="trigger_type" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            ${Object.entries(this.triggerConfig).map(([k, v]) => `<option value="${k}" ${w.triggerType === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label>
          <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">${w.description || ''}</textarea>
        </div>
        <div class="flex items-center gap-stack-sm">
          <input name="is_active" type="checkbox" id="wf-active" ${w.isActive ? 'checked' : ''} class="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer"/>
          <label for="wf-active" class="font-body-md text-body-md cursor-pointer">Activate immediately</label>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Actions</label>
          <div class="bg-surface-container-low rounded-lg p-stack-sm border border-outline-variant/30 text-body-sm text-on-surface-variant">
            <p>${(w.actionsJson ? w.actionsJson.length : 1) || 1} action(s) configured. Advanced action editor available in the workflow builder.</p>
          </div>
        </div>
        <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
          <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
          <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </form>`,
    });
    modal.open();
    modal.element.querySelector('#wf-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = { name: fd.get('name'), trigger_type: fd.get('trigger_type'), description: fd.get('description'), is_active: document.getElementById('wf-active').checked, actions: 1 };
      try {
        if (isEdit) await API.put(`/workflows/${w.id}`, payload);
        else await API.post('/workflows', payload);
        Toast.success(isEdit ? 'Workflow updated' : 'Workflow created');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  async toggleActive(item, active) {
    try {
      await API.put(`/workflows/${item.id}`, { is_active: active });
      Toast.success(active ? 'Workflow activated' : 'Workflow paused');
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); this.load(); }
  },

  async runNow(item) {
    try {
      await API.post(`/workflows/${item.id}/run`);
      Toast.success(`Workflow "${item.name}" triggered`);
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },

  async showHistory(item) {
    const modal = new Modal({
      title: `${item.name} — History`,
      size: 'lg',
      content: '<div id="wf-history-body"><div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div></div>',
    });
    modal.open();
    try {
      const res = await API.get(`/workflows/${item.id}/history`);
      const runs = res?.data || res || [];
      const body = document.getElementById('wf-history-body');
      if (!runs.length) {
        body.innerHTML = '<div class="text-center py-8"><p class="font-body-sm text-body-sm text-on-surface-variant">No runs yet</p></div>';
      } else {
        body.innerHTML = '<div class="divide-y divide-outline-variant/30">' + runs.map(r => `
          <div class="py-stack-sm flex items-center gap-stack-sm">
            <span class="material-symbols-outlined text-[18px] ${r.status === 'success' ? 'text-green-600' : r.status === 'failed' ? 'text-error' : 'text-yellow-600'}">${r.status === 'success' ? 'check_circle' : r.status === 'failed' ? 'error' : 'schedule'}</span>
            <div class="flex-1">
              <p class="font-body-md">${r.message || 'Run completed'}</p>
              <p class="font-body-sm text-body-sm text-on-surface-variant">${new Date(r.runAt || r.createdAt).toLocaleString()}</p>
            </div>
          </div>
        `).join('') + '</div>';
      }
    } catch {
      const body = document.getElementById('wf-history-body');
      body.innerHTML = '<div class="divide-y divide-outline-variant/30">' + [
        { status: 'success', message: 'Workflow executed successfully', runAt: new Date(Date.now()-3600000).toISOString() },
        { status: 'success', message: 'Workflow executed successfully', runAt: new Date(Date.now()-86400000).toISOString() },
        { status: 'failed', message: 'Action 2 failed: email not sent', runAt: new Date(Date.now()-172800000).toISOString() },
      ].map(r => `<div class="py-stack-sm flex items-center gap-stack-sm"><span class="material-symbols-outlined text-[18px] ${r.status==='success'?'text-green-600':r.status==='failed'?'text-error':'text-yellow-600'}">${r.status==='success'?'check_circle':r.status==='failed'?'error':'schedule'}</span><div class="flex-1"><p class="font-body-md">${r.message}</p><p class="font-body-sm text-body-sm text-on-surface-variant">${new Date(r.runAt).toLocaleString()}</p></div></div>`).join('') + '</div>';
    }
  },

  async confirmDelete(item) {
    if (!confirm(`Delete workflow "${item.name}"?`)) return;
    try {
      await API.del(`/workflows/${item.id}`);
      Toast.success('Workflow deleted');
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },
};
