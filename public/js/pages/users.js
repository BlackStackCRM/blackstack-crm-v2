window.PageModules = window.PageModules || {};

window.PageModules.users = {
  state: { search: '', role: '', status: '' },
  searchTimer: null,
  roleConfig: {
    // Keys must match the uppercase role values stored by the API
    // (users.role column: ADMIN / MANAGER / SALES / VIEWER).
    ADMIN: { label: 'Administrator', color: 'bg-purple-100 text-purple-700' },
    MANAGER: { label: 'Manager', color: 'bg-blue-100 text-blue-700' },
    SALES: { label: 'Sales', color: 'bg-green-100 text-green-700' },
    VIEWER: { label: 'Viewer', color: 'bg-gray-100 text-gray-700' },
  },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Users</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage team members and their access.</p>
        </div>
        <button id="usr-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
          <span class="material-symbols-outlined text-[18px]">person_add</span> Add User
        </button>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
          <div class="relative flex-1 min-w-[200px]">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="usr-search" placeholder="Search users..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <select id="usr-role" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All roles</option>
            ${Object.entries(this.roleConfig).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
          <select id="usr-status" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div id="usr-table"></div>
        <div id="usr-pagination"></div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('usr-new').addEventListener('click', () => this.openForm());
    document.getElementById('usr-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.load(); }, 300);
    });
    document.getElementById('usr-role').addEventListener('change', (e) => { this.state.role = e.target.value; this.load(); });
    document.getElementById('usr-status').addEventListener('change', (e) => { this.state.status = e.target.value; this.load(); });
  },

  async load() {
    const container = document.getElementById('usr-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { ...this.state };
      // API stores roles/status uppercase — uppercase filters before sending.
      if (params.role) params.role = params.role.toUpperCase();
      if (params.status) params.status = params.status.toUpperCase();
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/users', params);
      const data = res?.data || res || {};
      const items = data.items || data.users || data || [];
      // API stores/snake_cases some fields: full_name, last_login_at. Normalize
      // for the table renderer (which reads fullName / lastLoginAt).
      const norm = items.map(u => ({
        ...u,
        fullName: u.fullName || u.full_name || '',
        lastLoginAt: u.lastLoginAt || u.last_login_at || null,
      }));
      const total = data.total || items.length;
      this.renderTable(container, norm, total);
    } catch { ErrorState.render(container, () => this.load()); }
  },
renderTable(container, items, total) {
    this.table = new DataTable(container, {
      columns: [
        { key: 'name', label: 'Name', render: (v, r) => `<div class="flex items-center gap-stack-sm"><div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-on-secondary text-[10px] font-semibold">${(r.fullName?.[0] || r.firstName?.[0] || '')}${(r.fullName && !r.firstName ? '' : (r.lastName?.[0] || ''))}</div><div><p class="font-medium">${r.fullName || r.firstName || r.lastName || 'Unknown'}</p><p class="font-body-sm text-body-sm text-on-surface-variant">${r.email}</p></div></div>` },
        { key: 'role', label: 'Role', render: (v) => { const c = this.roleConfig[v] || this.roleConfig[(v || '').toUpperCase()] || this.roleConfig.VIEWER; return `<span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] ${c.color}">${c.label}</span>`; } },
        { key: 'status', label: 'Status', render: (v) => StatusBadge.render((v || '').toLowerCase()) },
        { key: 'lastLoginAt', label: 'Last login', render: (v) => v ? new Date(v).toLocaleString() : 'Never' },
      ],
      data: items,
      emptyState: 'No users found',
      rowActions: (row) => this.openRowMenu(row),
    });
  },

  openRowMenu(row) {
    const modal = new Modal({
      title: `${row.fullName || row.firstName || row.lastName || 'User'}`,
      size: 'sm',
      content: `<div class="flex flex-col gap-1">
        <button data-act="edit" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>
        <button data-act="reset" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">lock_reset</span> Reset password</button>
        <button data-act="toggle" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">${row.status === 'ACTIVE' ? 'block' : 'check_circle'}</span> ${row.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button>
        <button data-act="delete" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-error text-left"><span class="material-symbols-outlined text-[18px]">delete</span> Delete</button>
      </div>`,
    });
    modal.open();
    modal.element.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      modal.close();
      if (act === 'edit') return this.openForm(row);
      if (act === 'reset') return this.resetPassword(row);
      if (act === 'toggle') return this.toggleStatus(row);
      if (act === 'delete') return this.confirmDelete(row);
    });
  },

  openForm(row = null) {
    const isEdit = !!row;
    const u = row || {};
    const fullName = u.fullName || '';
    const nameParts = fullName.split(' ');
    const firstName = u.firstName || nameParts[0] || '';
    const lastName = u.lastName || nameParts.slice(1).join(' ') || '';
    const modal = new Modal({
      title: isEdit ? 'Edit User' : 'New User',
      size: 'md',
      content: `<form id="usr-form" class="grid grid-cols-2 gap-stack-md">
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">First name *</label>
          <input name="firstName" required value="${firstName}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Last name *</label>
          <input name="lastName" required value="${lastName}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div class="col-span-2">
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Email *</label>
          <input name="email" type="email" required value="${u.email || ''}" ${isEdit ? 'readonly' : ''} class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40 ${isEdit ? 'opacity-60' : ''}"/>
        </div>
        ${!isEdit ? `<div class="col-span-2">
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Temporary password *</label>
          <input name="password" type="password" required minlength="8" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>` : ''}
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Role *</label>
          <select name="role" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            ${Object.entries(this.roleConfig).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Status</label>
          <select name="status" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="active" ${u.status === 'ACTIVE' || u.status === 'active' || !u.status ? 'selected' : ''}>Active</option>
            <option value="inactive" ${u.status === 'INACTIVE' || u.status === 'inactive' ? 'selected' : ''}>Inactive</option>
          </select>
        </div>
        <div class="col-span-2 flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
          <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
          <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </form>`,
    });
    modal.open();
    modal.element.querySelector('#usr-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const form = Object.fromEntries(fd.entries());
      // Server API expects a single `full_name` field and stores role/status
      // uppercase (ADMIN, ACTIVE) — see server/routes/users.js validation.
      const payload = {
        full_name: `${form.firstName || ''} ${form.lastName || ''}`.trim(),
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        role: (form.role || '').toUpperCase(),
        status: (form.status || '').toUpperCase(),
      };
      if (!isEdit) payload.password = form.password;
      try {
        if (isEdit) await API.put(`/users/${u.id}`, payload);
        else await API.post('/users', payload);
        Toast.success(isEdit ? 'User updated' : 'User created');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  async resetPassword(row) {
    const modal = new Modal({
      title: 'Reset password',
      size: 'sm',
      content: `<p class="font-body-md text-on-surface mb-stack-md">Send a password reset link to <strong>${row.email}</strong>?</p>
        <div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button><button id="confirm-reset" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Send link</button></div>`,
    });
    modal.open();
    modal.element.querySelector('#confirm-reset').addEventListener('click', async () => {
      try {
        await API.post(`/users/${row.id}/reset-password`);
        Toast.success('Reset link sent');
        modal.close();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  async toggleStatus(row) {
    const newStatus = row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await API.put(`/users/${row.id}`, { status: newStatus });
      Toast.success(`User ${newStatus === 'ACTIVE' ? 'activated' : 'deactivated'}`);
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },

  async confirmDelete(row) {
    if (!confirm(`Delete user ${row.fullName || row.firstName || row.lastName || row.email}?`)) return;
    try {
      await API.del(`/users/${row.id}`);
      Toast.success('User deleted');
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },
};
