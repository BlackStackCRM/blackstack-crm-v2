window.PageModules = window.PageModules || {};

window.PageModules.tasks = {
  state: { status: '', priority: '', assignedTo: '', from: '', to: '', search: '' },
  searchTimer: null,
  data: [],
  columns: [
    { key: 'todo', label: 'To Do', statuses: ['todo', 'open'] },
    { key: 'in_progress', label: 'In Progress', statuses: ['in_progress', 'in-progress'] },
    { key: 'review', label: 'Review', statuses: ['review'] },
    { key: 'done', label: 'Done', statuses: ['done', 'completed'] },
  ],
  priorityConfig: {
    low: { label: 'Low', color: 'bg-gray-100 text-gray-700' },
    medium: { label: 'Medium', color: 'bg-blue-100 text-blue-700' },
    high: { label: 'High', color: 'bg-orange-100 text-orange-700' },
    urgent: { label: 'Urgent', color: 'bg-red-100 text-red-700' },
  },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Tasks</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Organize and track your team's work.</p>
        </div>
        <button id="task-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
          <span class="material-symbols-outlined text-[18px]">add</span> New Task
        </button>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 mb-stack-md">
        <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
          <div class="relative flex-1 min-w-[200px]">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="task-search" placeholder="Search tasks..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <select id="task-priority" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All priorities</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <input id="task-assignee" placeholder="Assigned to" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          <input id="task-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          <input id="task-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          <div id="task-bulk" class="hidden flex items-center gap-stack-sm">
            <span id="task-bulk-count" class="font-body-sm text-body-sm text-on-surface-variant">0</span>
            <button id="task-bulk-complete" class="text-green-700 hover:bg-green-50 px-3 py-1.5 rounded-lg text-body-sm">Complete</button>
            <button id="task-bulk-delete" class="text-error hover:bg-error-container/20 px-3 py-1.5 rounded-lg text-body-sm">Delete</button>
          </div>
        </div>
      </div>

      <div id="task-board" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-stack-md"></div>
    `;

    this.bindEvents();
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('task-new').addEventListener('click', () => this.openForm());
    document.getElementById('task-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.load(); }, 300);
    });
    document.getElementById('task-priority').addEventListener('change', (e) => { this.state.priority = e.target.value; this.load(); });
    document.getElementById('task-assignee').addEventListener('input', (e) => { this.state.assignedTo = e.target.value; this.load(); });
    document.getElementById('task-from').addEventListener('change', (e) => { this.state.from = e.target.value; this.load(); });
    document.getElementById('task-to').addEventListener('change', (e) => { this.state.to = e.target.value; this.load(); });
    document.getElementById('task-bulk-complete').addEventListener('click', () => this.bulkComplete());
    document.getElementById('task-bulk-delete').addEventListener('click', () => this.bulkDelete());
  },

  async load() {
    const board = document.getElementById('task-board');
    board.innerHTML = '<div class="col-span-4 p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { ...this.state };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/tasks', params);
      this.data = res?.data?.items || res?.items || res?.data || res || [];
      this.renderBoard();
    } catch { ErrorState.render(container, () => this.load()); }
  },
renderBoard() {
    const board = document.getElementById('task-board');
    const filtered = this.applyFilters(this.data);
    board.innerHTML = this.columns.map(col => {
      const items = filtered.filter(t => col.statuses.includes((t.status || '').toLowerCase()));
      return `
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 flex flex-col">
          <div class="p-container-padding border-b border-outline-variant/30 flex items-center justify-between">
            <h3 class="font-h3 text-h3 text-on-surface">${col.label}</h3>
            <span class="font-label-md text-label-md text-on-surface-variant">${items.length}</span>
          </div>
          <div class="flex-1 p-stack-sm space-y-stack-sm min-h-[200px] overflow-y-auto" data-col="${col.key}">
            ${items.length ? items.map(t => this.renderCard(t)).join('') : '<p class="text-center font-body-sm text-body-sm text-on-surface-variant py-8">No tasks</p>'}
          </div>
        </div>
      `;
    }).join('');

    board.querySelectorAll('[data-card]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        const id = card.dataset.card;
        const item = this.data.find(t => t.id === id);
        if (item) this.openForm(item);
      });
      const cb = card.querySelector('[data-checkbox]');
      if (cb) cb.addEventListener('change', () => this.updateBulkUI());
      const completeBtn = card.querySelector('[data-act="complete"]');
      if (completeBtn) completeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.markComplete(card.dataset.card); });
    });
  },

  applyFilters(items) {
    return items.filter(t => {
      if (this.state.search && !(t.title || '').toLowerCase().includes(this.state.search.toLowerCase())) return false;
      if (this.state.priority && t.priority !== this.state.priority) return false;
      if (this.state.assignedTo && !(t.assignedTo || '').toLowerCase().includes(this.state.assignedTo.toLowerCase())) return false;
      if (this.state.from && t.dueDate && t.dueDate < this.state.from) return false;
      if (this.state.to && t.dueDate && t.dueDate > this.state.to) return false;
      return true;
    });
  },

  renderCard(t) {
    const prio = this.priorityConfig[t.priority] || this.priorityConfig.medium;
    const overdue = t.dueDate && new Date(t.dueDate) < new Date() && !['done','completed'].includes(t.status);
    return `
      <div data-card="${t.id}" class="bg-surface-container-low rounded-lg p-stack-sm border border-outline-variant/30 hover:border-secondary/40 cursor-pointer transition-colors group">
        <div class="flex items-start gap-stack-sm">
          <input type="checkbox" data-checkbox data-id="${t.id}" class="mt-1 rounded border-outline-variant text-primary focus:ring-primary w-4 h-4 cursor-pointer" aria-label="Select task"/>
          <div class="flex-1 min-w-0">
            <p class="font-body-md text-body-md text-on-surface font-medium line-clamp-2">${t.title || ''}</p>
            <div class="flex items-center gap-stack-sm mt-2 flex-wrap">
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${prio.color}">${prio.label}</span>
              ${t.dueDate ? `<span class="inline-flex items-center gap-1 font-body-sm text-body-sm ${overdue ? 'text-error' : 'text-on-surface-variant'}"><span class="material-symbols-outlined text-[12px]">event</span>${t.dueDate}</span>` : ''}
            </div>
            ${t.assignedTo || t.contactName ? `
              <div class="flex items-center gap-stack-sm mt-2">
                ${t.assignedTo ? `<span class="inline-flex items-center gap-1 font-body-sm text-body-sm text-on-surface-variant"><span class="material-symbols-outlined text-[12px]">person</span>${t.assignedTo}</span>` : ''}
              </div>` : ''}
          </div>
          ${!['done','completed'].includes(t.status) ? `
            <button data-act="complete" class="opacity-0 group-hover:opacity-100 w-7 h-7 rounded hover:bg-green-100 flex items-center justify-center text-green-700" aria-label="Mark complete">
              <span class="material-symbols-outlined text-[16px]">check</span>
            </button>` : ''}
        </div>
      </div>
    `;
  },

  updateBulkUI() {
    const checked = document.querySelectorAll('[data-checkbox]:checked');
    const bulk = document.getElementById('task-bulk');
    document.getElementById('task-bulk-count').textContent = `${checked.length} selected`;
    bulk.classList.toggle('hidden', checked.length === 0);
  },

  selectedIds() {
    return Array.from(document.querySelectorAll('[data-checkbox]:checked')).map(cb => +cb.dataset.id);
  },

  async bulkComplete() {
    const ids = this.selectedIds();
    if (!ids.length) return;
    try {
      await Promise.all(ids.map(id => API.put(`/tasks/${id}`, { status: 'done' })));
      Toast.success(`${ids.length} task(s) completed`);
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },

  async bulkDelete() {
    const ids = this.selectedIds();
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} task(s)?`)) return;
    try {
      await Promise.all(ids.map(id => API.del(`/tasks/${id}`)));
      Toast.success(`${ids.length} task(s) deleted`);
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },

  async markComplete(id) {
    try {
      await API.put(`/tasks/${id}`, { status: 'done' });
      Toast.success('Task completed');
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },

  openForm(row = null) {
    const isEdit = !!row;
    const t = row || {};
    const modal = new Modal({
      title: isEdit ? 'Edit Task' : 'New Task',
      size: 'md',
      content: `<form id="task-form" class="grid grid-cols-2 gap-stack-md">
        <div class="col-span-2">
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Related To *</label>
          <div class="flex items-center gap-stack-sm mb-2">
            <label class="flex items-center gap-1 text-body-sm"><input type="radio" name="relatedType" value="contact" checked/> Contact</label>
            <label class="flex items-center gap-1 text-body-sm"><input type="radio" name="relatedType" value="organization"/> Organization</label>
          </div>
          <div id="task-contact-wrap"><div id="task-contact-selector"></div></div>
          <div id="task-org-wrap" class="hidden"><div id="task-org-selector"></div></div>
        </div>
        <div class="col-span-2">
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Title *</label>
          <input name="title" required value="${t.title || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div class="col-span-2">
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label>
          <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">${t.description || ''}</textarea>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Status</label>
          <select name="status" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>To Do</option>
            <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
            <option value="review" ${t.status === 'review' ? 'selected' : ''}>Review</option>
            <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
          </select>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Priority</label>
          <select name="priority" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="low" ${t.priority === 'low' ? 'selected' : ''}>Low</option>
            <option value="medium" ${t.priority === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="high" ${t.priority === 'high' ? 'selected' : ''}>High</option>
            <option value="urgent" ${t.priority === 'urgent' ? 'selected' : ''}>Urgent</option>
          </select>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Due date</label>
          <input name="dueDate" type="date" value="${t.dueDate || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Assigned to</label>
          <input name="assignedTo" value="${t.assignedTo || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div class="col-span-2 flex justify-between gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
          ${isEdit ? '<button type="button" id="task-delete" class="text-error hover:bg-error-container/20 px-3 py-2 rounded-lg">Delete</button>' : '<div></div>'}
          <div class="flex gap-stack-sm">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </div>
      </form>`,
    });
    modal.open();

    let related = null;
    const contactWrap = modal.element.querySelector('#task-contact-wrap');
    const orgWrap = modal.element.querySelector('#task-org-wrap');
    const contactSelector = new EntitySelector(modal.element.querySelector('#task-contact-selector'), {
      type: 'contact', placeholder: 'Select contact...', allowCreate: true,
      onCreate: () => window.PageModules.contacts.openFormAndWait(),
      onChange: (c) => { related = c ? { contactId: c.id, organizationId: c.organizationId || c.organization_id || null } : null; },
    });
    const orgSelector = new EntitySelector(modal.element.querySelector('#task-org-selector'), {
      type: 'organization', placeholder: 'Select organization...',
      onChange: (o) => { related = o ? { organizationId: o.id, contactId: null } : null; },
    });
    modal.element.querySelectorAll('input[name="relatedType"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isOrg = radio.value === 'organization' && radio.checked;
        orgWrap.classList.toggle('hidden', !isOrg);
        contactWrap.classList.toggle('hidden', isOrg);
        related = null;
      });
    });
    if (isEdit) {
      if (t.organizationId && !t.contactId) {
        modal.element.querySelector('input[name="relatedType"][value="organization"]').checked = true;
        orgWrap.classList.remove('hidden'); contactWrap.classList.add('hidden');
        API.get('/organizations/' + t.organizationId).then(o => { const od = o?.data || o; if (od) orgSelector.setValue(od); }).catch(() => {});
      } else if (t.contactId) {
        API.get('/contacts/' + t.contactId).then(c => { const cd = c?.data || c; if (cd) contactSelector.setValue(cd); }).catch(() => {});
      }
    }

    modal.element.querySelector('#task-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!related) { Toast.error('Select a contact or organization'); return; }
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd.entries());
      delete payload.relatedType;
      payload.contactId = related.contactId || null;
      payload.organizationId = related.organizationId || null;
      try {
        if (isEdit) await API.put(`/tasks/${t.id}`, payload);
        else await API.post('/tasks', payload);
        Toast.success(isEdit ? 'Task updated' : 'Task created');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
    if (isEdit) {
      modal.element.querySelector('#task-delete').addEventListener('click', async () => {
        if (!confirm('Delete this task?')) return;
        try { await API.del(`/tasks/${t.id}`); Toast.success('Deleted'); modal.close(); this.load(); }
        catch (err) { Toast.error(err.message || 'Failed'); }
      });
    }
  },
};
