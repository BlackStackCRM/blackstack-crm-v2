window.PageModules = window.PageModules || {};

window.PageModules.contacts = {
  table: null,
  pagination: null,
  state: { page: 1, pageSize: 10, search: '', status: '', tag: '', selected: new Set() },
  searchTimer: null,

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Contacts</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage your customers and leads.</p>
        </div>
        <button id="contact-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 transition-colors">
          <span class="material-symbols-outlined text-[18px]">add</span> New Contact
        </button>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 mb-stack-md">
        <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
          <div class="relative flex-1 min-w-[200px]">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="contact-search" type="text" placeholder="Search contacts..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <select id="contact-filter-status" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="lead">Lead</option>
          </select>
          <select id="contact-filter-tag" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All tags</option>
          </select>
          <div id="bulk-actions" class="hidden flex items-center gap-stack-sm">
            <span id="bulk-count" class="font-body-sm text-body-sm text-on-surface-variant">0 selected</span>
            <button id="bulk-delete" class="text-error hover:bg-error-container/20 px-3 py-1.5 rounded-lg text-body-sm">Delete</button>
          </div>
        </div>
        <div id="contacts-table"></div>
        <div id="contacts-pagination"></div>
      </div>
    `;

    this.bindEvents();
    await this.loadTags();
    await this.load();

    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('contact-new').addEventListener('click', () => this.openForm());
    const search = document.getElementById('contact-search');
    search.addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.load(); }, 300);
    });
    document.getElementById('contact-filter-status').addEventListener('change', (e) => { this.state.status = e.target.value; this.state.page = 1; this.load(); });
    document.getElementById('contact-filter-tag').addEventListener('change', (e) => { this.state.tag = e.target.value; this.state.page = 1; this.load(); });
    document.getElementById('bulk-delete').addEventListener('click', () => this.bulkDelete());
  },

  async loadTags() {
    try {
      const res = await API.get('/contacts/tags');
      const tags = res?.data || res || [];
      const sel = document.getElementById('contact-filter-tag');
      tags.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name || t;
        opt.textContent = t.name || t;
        sel.appendChild(opt);
      });
    } catch {}
  },

  async load() {
    const container = document.getElementById('contacts-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';

    try {
      const params = { page: this.state.page, pageSize: this.state.pageSize, search: this.state.search, status: this.state.status, tag: this.state.tag };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/contacts', params);
      const data = res?.data || res || {};
      const items = data.items || data.contacts || data || [];
      const total = data.total || items.length;

      this.table = new DataTable(container, {
        columns: [
          { key: 'name', label: 'Name', render: (v, r) => `
            <div class="flex items-center gap-stack-sm">
              <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-on-secondary text-[10px] font-semibold shrink-0">${this.initials(r.firstName, r.lastName, r.name)}</div>
              <a href="#contacts/${r.id}" class="font-medium text-on-surface hover:text-secondary">${v || (r.firstName + ' ' + r.lastName)}</a>
            </div>` },
          { key: 'email', label: 'Email', render: (v) => `<span class="text-on-surface-variant">${v || ''}</span>` },
          { key: 'phone', label: 'Phone', render: (v) => `<span class="text-on-surface-variant">${v || '—'}</span>` },
          { key: 'organization', label: 'Organization', render: (v, r) => v?.name || r.organizationName || '—' },
          { key: 'tags', label: 'Tags', render: (v) => (v || []).slice(0, 3).map(t => `<span class="inline-block bg-secondary-container/10 text-secondary px-2 py-0.5 rounded text-[11px] mr-1">${t.name || t}</span>`).join('') || '—' },
        ],
        data: items,
        selectable: true,
        emptyState: 'No contacts found',
        rowActions: (row) => this.openRowMenu(row),
      });

      if (!this.pagination) {
        this.pagination = new Pagination(document.getElementById('contacts-pagination'), {
          page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
          totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
          onPageChange: (p) => { this.state.page = p; this.load(); },
        });
      } else {
        this.pagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
      }
    } catch (err) {
      ErrorState.render(container, () => this.load());
    }
  },

  initials(first, last, full) {
    if (full) return full.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    return ((first?.[0] || '') + (last?.[0] || '')).toUpperCase() || 'U';
  },

  openRowMenu(row) {
    const modal = new Modal({
      title: row.firstName ? `${row.firstName} ${row.lastName}` : row.name,
      size: 'sm',
      content: `
        <div class="flex flex-col gap-1">
          <a href="#contacts/${row.id}" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md"><span class="material-symbols-outlined text-[18px]">visibility</span> View</a>
          <button data-act="edit" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md text-left"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>
          <button data-act="delete" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-body-md text-error text-left"><span class="material-symbols-outlined text-[18px]">delete</span> Delete</button>
        </div>
      `,
    });
    modal.open();
    modal.element.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'edit') { modal.close(); this.openForm(row); }
      if (act === 'delete') { modal.close(); this.confirmDelete(row); }
    });
  },

  openFormAndWait() {
    return new Promise((resolve) => {
      this.openForm(null, (contact) => resolve(contact));
    });
  },
  async openForm(row = null, onCreated = null) {
    const isEdit = !!row;
    const c = row || {};
    const modal = new Modal({
      title: isEdit ? 'Edit Contact' : 'New Contact',
      size: 'lg',
      content: `
        <form id="contact-form" class="grid grid-cols-2 gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">First name *</label>
            <input name="firstName" required value="${c.firstName || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Last name *</label>
            <input name="lastName" required value="${c.lastName || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Email *</label>
            <input name="email" type="email" required value="${c.email || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Phone</label>
            <input name="phone" value="${c.phone || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Status</label>
            <select name="status" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="active" ${c.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="inactive" ${c.status === 'inactive' ? 'selected' : ''}>Inactive</option>
              <option value="lead" ${c.status === 'lead' ? 'selected' : ''}>Lead</option>
            </select>
          </div>
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Organization</label>
            <div id="contact-org-selector"></div>
            <button type="button" id="contact-org-new" class="mt-1 text-body-sm text-secondary hover:underline flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">add</span>Create Organization</button>
            <div id="contact-org-new-form" class="hidden mt-2 p-stack-sm bg-surface-container rounded-lg">
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">New organization name *</label>
              <input id="contact-org-name" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40" placeholder="Acme Corp"/>
              <div class="flex justify-end mt-2"><button type="button" id="contact-org-cancel" class="text-body-sm text-on-surface-variant hover:text-on-surface">Cancel</button></div>
            </div>
          </div>
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Tags (comma separated)</label>
            <input name="tags" value="${(c.tags || []).map(t => t.name || t).join(', ')}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div class="col-span-2 flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      `,
    });
    modal.open();
    const orgSelector = new EntitySelector(modal.element.querySelector('#contact-org-selector'), {
      type: 'organization',
      placeholder: 'Select organization...',
      onChange: () => {},
    });
    if (c.organizationId || c.organization_id) {
      try {
        const orgRes = await API.get('/organizations/' + (c.organizationId || c.organization_id));
        const org = orgRes?.data || orgRes;
        if (org && org.id) orgSelector.setValue(org);
      } catch {}
    }
    const orgNewForm = modal.element.querySelector('#contact-org-new-form');
    modal.element.querySelector('#contact-org-new').addEventListener('click', () => {
      orgNewForm.classList.remove('hidden');
      modal.element.querySelector('#contact-org-name').focus();
    });
    modal.element.querySelector('#contact-org-cancel').addEventListener('click', () => {
      orgNewForm.classList.add('hidden');
      modal.element.querySelector('#contact-org-name').value = '';
    });
    modal.element.querySelector('#contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      let organizationId = null;
      try {
        const newOrgName = modal.element.querySelector('#contact-org-name').value.trim();
        const newOrgVisible = !orgNewForm.classList.contains('hidden');
        if (newOrgVisible && newOrgName) {
          const orgRes = await API.post('/organizations', { name: newOrgName });
          const org = orgRes?.data || orgRes;
          organizationId = org?.id || org?.organization?.id;
        } else if (orgSelector.getValue()) {
          organizationId = orgSelector.getValue().id;
        }
      } catch (err) {
        Toast.error(err.message || 'Failed to create organization');
        return;
      }
      const payload = {
        firstName: fd.get('firstName'),
        lastName: fd.get('lastName'),
        email: fd.get('email'),
        phone: fd.get('phone'),
        status: fd.get('status'),
        organizationId: organizationId,
        tags: fd.get('tags').split(',').map(s => s.trim()).filter(Boolean),
      };
      try {
        let saved;
        if (isEdit) saved = await API.put(`/contacts/${row.id}`, payload);
        else saved = await API.post('/contacts', payload);
        Toast.success(isEdit ? 'Contact updated' : 'Contact created');
        modal.close();
        this.load();
        if (!isEdit && onCreated) {
          const contact = saved?.data || saved;
          if (contact && contact.id) onCreated(contact);
        }
      } catch (err) {
        Toast.error(err.message || 'Failed to save');
      }
    });
  },

  confirmDelete(row) {
    const modal = new Modal({
      title: 'Delete contact?',
      size: 'sm',
      content: `
        <p class="font-body-md text-body-md text-on-surface mb-stack-md">Are you sure you want to delete <strong>${row.firstName || ''} ${row.lastName || ''}</strong>? This action cannot be undone.</p>
        <div class="flex justify-end gap-stack-sm">
          <button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
          <button id="confirm-delete-btn" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Delete</button>
        </div>
      `,
    });
    modal.open();
    modal.element.querySelector('#confirm-delete-btn').addEventListener('click', async () => {
      try {
        await API.del(`/contacts/${row.id}`);
        Toast.success('Contact deleted');
        modal.close();
        this.load();
      } catch (err) {
        Toast.error(err.message || 'Failed to delete');
      }
    });
  },

  async bulkDelete() {
    if (!this.table?.selectedRows?.size) return;
    const ids = Array.from(this.table.selectedRows).map(i => this.table.config.data[i].id);
    if (!confirm(`Delete ${ids.length} contact(s)?`)) return;
    try {
      await Promise.all(ids.map(id => API.del(`/contacts/${id}`)));
      Toast.success(`${ids.length} contacts deleted`);
      this.load();
    } catch (err) {
      Toast.error(err.message || 'Failed to delete');
    }
  },
};
