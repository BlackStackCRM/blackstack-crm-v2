// Distribution agency scoped controls. Server-side agency_control permissions
// and the caller's live company tenant define the actual security boundary.
window.PageModules = window.PageModules || {};
window.PageModules.agencyControl = {
  permissions() {
    try {
      const user = JSON.parse(localStorage.getItem('crm_user') || '{}');
      return Array.isArray(user.permissions) ? user.permissions : [];
    } catch { return []; }
  },
  role() {
    if (window.RolePermissions) return window.RolePermissions.role();
    try {
      const user = JSON.parse(localStorage.getItem('crm_user') || '{}');
      return String(user.hierarchyRole || user.role || '').toLowerCase();
    } catch { return ''; }
  },
  can(code) {
    const role = this.role();
    const roleCapabilities = {
      'agency_control.subagencies.view': 'canManageSubAgencies',
      'agency_control.subagencies.create': 'canCreateSubAgency',
      'agency_control.agencies.manage': 'canManageSubAgencies',
      'agency_control.customers.manage': 'canManageCustomers',
    };
    if (roleCapabilities[code] && window.RolePermissions) {
      return window.RolePermissions[roleCapabilities[code]]();
    }
    if (roleCapabilities[code]) return ['platform', 'agency'].includes(role) || (code === 'agency_control.customers.manage' && role === 'sub_agency');
    const perms = this.permissions();
    if (perms.includes('*')) return true;
    if (perms.includes(code)) return true;
    if (code && role === 'platform') return true;
    return false;
  },
  esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  async init(mode) {
    const host = document.getElementById('page-container');
    const customersOnly = mode === 'customers-only';
    const role = this.role();
    const allowed = customersOnly
      ? role === 'sub_agency' && this.can('agency_control.customers.manage')
      : ['platform', 'agency'].includes(role) && this.can('agency_control.subagencies.view');
    if (!allowed) {
      host.innerHTML = '<div class="max-w-lg mx-auto mt-12 text-center"><h1 class="font-display text-h2">Agency control access required</h1></div>';
      return () => {};
    }
    this.selectedAgencies = [];
    this.selectedCustomers = [];
    const isSubAgency = role === 'sub_agency';
    host.innerHTML = `<div class="mb-stack-lg"><h1 class="font-display text-h1">${customersOnly ? 'Customer Tenants' : 'Distribution Agency Control'}</h1><p class="text-body-sm text-on-surface-variant">${customersOnly ? 'Manage customer tenants within your sub-agency.' : 'Manage sub-agencies and customers within your agency scope.'}</p></div>
      <div id="ac-error" class="hidden mb-stack-md rounded-lg border border-error/40 px-4 py-3 text-error"></div>
      ${this.can('agency_control.subagencies.view') ? `<div id="ac-bulk-bar" class="hidden mb-stack-md rounded-xl border border-outline-variant/60 bg-surface-container p-stack-sm">
        <div class="flex flex-wrap items-center gap-stack-sm">
          <span class="font-body-sm text-body-sm text-on-surface-variant">Selected <span id="ac-bulk-count">0</span></span>
          <div class="flex gap-stack-sm">
            <button id="ac-bulk-activate" class="rounded-lg bg-primary text-on-primary px-3 py-1.5 text-body-sm font-medium">Bulk Activate</button>
            <button id="ac-bulk-suspend" class="rounded-lg border border-outline-variant px-3 py-1.5 text-body-sm">Bulk Suspend</button>
            <button id="ac-bulk-remove" class="rounded-lg border border-error/40 text-error px-3 py-1.5 text-body-sm">Bulk Remove</button>
          </div>
          <button id="ac-bulk-clear" class="text-body-sm text-on-surface-variant underline ml-auto">Clear selection</button>
        </div>
      </div>` : ''}
      <div id="ac-cust-bulk-bar" class="hidden mb-stack-md rounded-xl border border-outline-variant/60 bg-surface-container p-stack-sm">
        <div class="flex flex-wrap items-center gap-stack-sm">
          <span class="font-body-sm text-body-sm text-on-surface-variant">Customers selected <span id="ac-cust-bulk-count">0</span></span>
          <div class="flex gap-stack-sm">
            <button id="ac-cust-bulk-activate" class="rounded-lg bg-primary text-on-primary px-3 py-1.5 text-body-sm font-medium">Bulk Activate</button>
            <button id="ac-cust-bulk-suspend" class="rounded-lg border border-outline-variant px-3 py-1.5 text-body-sm">Bulk Suspend</button>
            <button id="ac-cust-bulk-remove" class="rounded-lg border border-error/40 text-error px-3 py-1.5 text-body-sm">Bulk Remove</button>
          </div>
          <button id="ac-cust-bulk-clear" class="text-body-sm text-on-surface-variant underline ml-auto">Clear selection</button>
        </div>
      </div>
      ${this.can('agency_control.subagencies.view') ? `<section class="mb-stack-lg rounded-xl border border-outline-variant/40 p-stack-md"><h2 class="font-display text-h3 mb-stack-sm">Sub-agencies</h2>
        ${this.can('agency_control.subagencies.create') ? '<div class="flex flex-wrap items-center gap-stack-sm mb-stack-md"><input id="ac-agency-name" placeholder="Sub-agency name" class="border rounded-lg px-3 py-2 flex-1 min-w-40" /><select id="ac-parent-agency" class="border rounded-lg px-3 py-2 min-w-48"><option value="">Select parent agency…</option></select><button id="ac-create-agency" class="rounded-lg bg-primary text-on-primary px-4 py-2 whitespace-nowrap">Create</button></div>' : ''}
        <div id="ac-agencies"></div></section>` : ''}
      ${this.can('agency_control.customers.manage') ? `<section class="rounded-xl border border-outline-variant/40 p-stack-md"><h2 class="font-display text-h3 mb-stack-sm">Customer tenants</h2>
        <div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-stack-sm items-center mb-stack-md"><input id="ac-customer-name" placeholder="Customer organisation name" class="border rounded-lg px-3 py-2 w-full" /><select id="ac-customer-agency" class="border rounded-lg px-3 py-2 min-w-40"></select><button id="ac-create-customer" class="rounded-lg bg-primary text-on-primary px-4 py-2 whitespace-nowrap">Create customer tenant</button></div><div id="ac-customers"></div></section>` : ''}
      <div id="ac-modal"></div>`;
    document.getElementById('ac-create-agency')?.addEventListener('click', () => this.createAgency());
    document.getElementById('ac-create-customer')?.addEventListener('click', () => this.createCustomer());
    // FIX: the "Enter a customer name and choose an agency" banner persisted
    // after the user started typing — clear it as soon as either field changes.
    document.getElementById('ac-customer-name')?.addEventListener('input', () => {
      const el = document.getElementById('ac-error');
      if (el) el.classList.add('hidden');
    });
    document.getElementById('ac-customer-agency')?.addEventListener('change', () => {
      const el = document.getElementById('ac-error');
      if (el) el.classList.add('hidden');
    });
    document.getElementById('ac-bulk-activate')?.addEventListener('click', () => this.bulkStatus('ACTIVE'));
    document.getElementById('ac-bulk-suspend')?.addEventListener('click', () => this.bulkStatus('SUSPENDED'));
    document.getElementById('ac-bulk-remove')?.addEventListener('click', () => this.bulkRemove());
    document.getElementById('ac-bulk-clear')?.addEventListener('click', () => { this.selectedAgencies = []; this.renderAgencies(); });
    // Customer tenants bulk actions (UI parity with sub-agencies).
    document.getElementById('ac-cust-bulk-activate')?.addEventListener('click', () => this.bulkCustomerAccess('ACTIVE'));
    document.getElementById('ac-cust-bulk-suspend')?.addEventListener('click', () => this.bulkCustomerAccess('SUSPENDED'));
    document.getElementById('ac-cust-bulk-remove')?.addEventListener('click', () => this.bulkRemoveCustomers());
    document.getElementById('ac-cust-bulk-clear')?.addEventListener('click', () => { this.selectedCustomers = []; this.renderCustomers(); });
    await this.refresh();
    return () => {};
  },
  showError(message) {
    const el = document.getElementById('ac-error');
    if (!el) return;
    if (message && typeof message === 'object' && message.error && message.error.fields) {
      const fieldMessages = Object.entries(message.error.fields)
        .map(([field, msg]) => `${field}: ${msg}`)
        .join('\n');
      el.textContent = message.error.message + ' — ' + fieldMessages;
    } else {
      el.textContent = typeof message === 'string' ? message : (message && message.message) || 'Could not complete the action.';
    }
    el.classList.remove('hidden');
  },
  /** Extract the most useful message from an API error thrown by client.js.
   * client.js attaches `error.body` (the full response payload), so per-field
   * validation detail (error.error.fields, e.g. "name: An agency named ...") is
   * available but was previously dropped — the user only ever saw the generic
   * banner text like "Sub-agency validation failed." with no reason. */
  apiErrorText(error, fallback) {
    if (!error) return fallback;
    const payload = error.body && error.body.error;
    if (payload) {
      const fields = payload.fields && typeof payload.fields === 'object'
        ? Object.entries(payload.fields).map(([f, m]) => `${f}: ${m}`).join(' — ')
        : '';
      if (fields) return `${payload.message} — ${fields}`;
      if (payload.message) return payload.message;
    }
    return error.message || fallback;
  },
  showToast(message) {
    const el = document.createElement('div');
    el.className = 'fixed bottom-4 right-4 z-50 rounded-lg border border-outline-variant/60 bg-surface-container px-4 py-2 text-body-sm shadow';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  },
  async refresh() {
    try {
      console.log('[agency-control] REFRESH STARTED');
      const [agencyData, customerData] = await Promise.all([
        this.can('agency_control.subagencies.view') ? window.API.get('/agency-control/sub-agencies') : Promise.resolve({ agencies: [] }),
        this.can('agency_control.customers.manage') ? window.API.get('/agency-control/customers') : Promise.resolve({ customers: [] }),
      ]);
      console.log('[agency-control] REFRESH DATA:', agencyData);
      this.agencies = agencyData.agencies || [];
      this.parentAgency = agencyData.parentAgency || null;
      const user = window.AuthAPI && window.AuthAPI.getUser ? window.AuthAPI.getUser() : {};
      const ownAgency = this.role() === 'sub_agency' && user && user.agencyId
        ? [{ id: user.agencyId, name: user.agencyName || 'My Sub-agency', status: 'ACTIVE' }]
        : [];
      this.customerAgencies = ownAgency.length ? ownAgency
        : (this.parentAgency ? [this.parentAgency, ...this.agencies] : this.agencies);
      this.customers = customerData.customers || [];
      this.renderAgencies();
      await this.renderParentOptions();
      this.renderCustomers();
      console.log('[agency-control] REFRESH COMPLETE, agencies:', this.agencies.length);
    } catch (error) {
      console.log('[agency-control] REFRESH ERROR:', error);
      this.showError(this.apiErrorText(error, 'Could not load agency data.'));
    }
  },
  renderAgencies() {
    const host = document.getElementById('ac-agencies');
    if (!host) return;
    const allSelected = this.agencies.length > 0 && this.agencies.every((a) => this.selectedAgencies.includes(a.id));
    const rows = this.agencies.map((a) => `<tr class="border-t">
      <td class="py-2"><input type="checkbox" data-agency-select="${this.esc(a.id)}" ${this.selectedAgencies.includes(a.id) ? 'checked' : ''} /></td>
      <td class="py-2">${this.esc(a.name)}</td>
      <td class="py-2">${this.esc(a.agencyCode)}</td>
      <td class="py-2">${this.esc(a.status)}</td>
      <td class="py-2 text-right">
        <div class="relative inline-block text-left">
          <button data-agency-actions="${this.esc(a.id)}" class="rounded border px-2 py-1 text-body-sm">Actions</button>
          <div data-agency-menu="${this.esc(a.id)}" class="hidden absolute right-0 mt-2 w-48 rounded border bg-white shadow z-10">
            <button data-action="view" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">View Details</button>
            <button data-action="edit" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Edit</button>
            <button data-action="add-admin" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Add Admin</button>
            <button data-action="reset-password" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Reset Admin Password</button>
            <button data-action="activate" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Activate</button>
            <button data-action="suspend" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Suspend</button>
            <button data-action="remove" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm text-error hover:bg-gray-100">Remove</button>
          </div>
        </div>
      </td>
    </tr>`).join('');
    host.innerHTML = rows ? `<table class="w-full text-left text-body-sm"><thead><tr><th class="text-left"><input type="checkbox" id="ac-select-all" ${allSelected ? 'checked' : ''} /></th><th>Name</th><th>Code</th><th>Status</th><th class="text-right">Actions</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="text-on-surface-variant">No sub-agencies yet.</p>';
    this.updateBulkBar();
    this.attachAgencyActions();
    document.getElementById('ac-select-all')?.addEventListener('change', (e) => {
      this.selectedAgencies = e.target.checked ? this.agencies.map((a) => a.id) : [];
      this.renderAgencies();
    });
  },
  updateBulkBar() {
    const bar = document.getElementById('ac-bulk-bar');
    const countEl = document.getElementById('ac-bulk-count');
    if (!bar || !countEl) return;
    const count = this.selectedAgencies.length;
    countEl.textContent = String(count);
    bar.classList.toggle('hidden', count === 0);
  },
  attachAgencyActions() {
    const host = document.getElementById('ac-agencies');
    if (!host) return;
    host.querySelectorAll('[data-agency-actions]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-agency-actions');
        const menu = host.querySelector(`[data-agency-menu="${id}"]`);
        if (!menu) return;
        const isOpen = !menu.classList.contains('hidden');
        host.querySelectorAll('[data-agency-menu]').forEach((m) => m.classList.add('hidden'));
        if (!isOpen) menu.classList.remove('hidden');
      });
    });
    host.querySelectorAll('[data-action]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        const id = item.getAttribute('data-id');
        console.log('[agency-control] action:', action, 'agency:', id);
        if (action === 'view') this.openViewModal(id);
        else if (action === 'edit') this.openEditModal(id);
        else if (action === 'add-admin') this.openAddAdminModal(id);
        else if (action === 'reset-password') this.openResetPasswordModal(id);
        else if (action === 'activate') this.changeStatus(id, 'ACTIVE');
        else if (action === 'suspend') this.changeStatus(id, 'SUSPENDED');
        else if (action === 'remove') this.removeAgency(id);
        host.querySelectorAll('[data-agency-menu]').forEach((m) => m.classList.add('hidden'));
      });
    });
    host.querySelectorAll('[data-agency-select]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.getAttribute('data-agency-select');
        if (!id) return;
        if (box.checked) {
          if (!this.selectedAgencies.includes(id)) this.selectedAgencies.push(id);
        } else {
          this.selectedAgencies = this.selectedAgencies.filter((x) => x !== id);
        }
        this.updateBulkBar();
      });
    });
    document.addEventListener('click', () => {
      host.querySelectorAll('[data-agency-menu]').forEach((m) => m.classList.add('hidden'));
    });
  },
  openViewModal(agencyId) {
    const agency = this.agencies.find((a) => a.id === agencyId) || null;
    const host = document.getElementById('ac-modal');
    if (!host) return;
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-2xl rounded-xl bg-surface-container p-6 border border-outline-variant/40">
        <div class="flex items-start justify-between">
          <div>
            <h2 class="font-display text-h3 text-on-surface">${this.esc(agency ? agency.name : 'Agency')}</h2>
            <p class="font-mono text-body-sm text-on-surface-variant mt-1">${this.esc(agency ? agency.agencyCode : '')} ${agency ? this.badge(agency.status) : ''}</p>
          </div>
          <button id="ac-v-close" class="material-symbols-outlined text-on-surface-variant hover:text-on-surface">close</button>
        </div>
        <dl class="grid grid-cols-2 gap-4 mt-6 text-body-sm">
          ${this.row('Name', agency ? agency.name : '')}
          ${this.row('Code', agency ? (agency.agencyCode || agency.agency_code) : '')}
          ${this.row('Status', agency ? agency.status : '')}
          ${this.row('Contact email', agency ? (agency.contactEmail || agency.contact_email || '') : '')}
          ${this.row('Contact phone', agency ? (agency.contactPhone || agency.contact_phone || '') : '')}
          ${this.row('Address', agency ? (agency.address || '') : '')}
          ${this.row('City', agency ? (agency.city || '') : '')}
          ${this.row('State', agency ? (agency.state || '') : '')}
          ${this.row('Country', agency ? (agency.country || '') : '')}
          ${this.row('Pincode', agency ? (agency.pincode || '') : '')}
          ${this.row('Parent agency', agency ? (agency.parentAgencyName ? `${agency.parentAgencyName} (${agency.parentAgencyCode || ''})` : '') : '')}
          ${this.row('Created date', agency ? (agency.createdAt || agency.created_at || '') : '')}
        </dl>
        <div class="mt-6">
          <h3 class="font-display text-h4 text-on-surface">Administrators</h3>
          <div id="ac-view-admins" class="text-body-sm text-on-surface-variant">Loading...</div>
        </div>
        <div class="flex justify-end mt-6"><button id="ac-v-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Close</button></div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-v-close').addEventListener('click', close);
    document.getElementById('ac-v-cancel').addEventListener('click', close);

    if (agencyId) {
      (async () => {
        const adminHost = document.getElementById('ac-view-admins');
        if (!adminHost) return;
        try {
          const data = await window.API.get(`/agency-control/sub-agencies/${encodeURIComponent(agencyId)}/administrators`);
          console.log('FRONTEND ADMINS DATA:', data);
          // The backend route returns { success: true, data: { administrators } };
          // window.API.get unwraps one level (returns result.data), so `data` is
          // either { administrators } — the normal shape — or, defensively, the
          // raw array / nested data.data variant. Handle all three.
          const admins = Array.isArray(data)
            ? data
            : (data && data.administrators) || (data && data.data && data.data.administrators) || [];
          if (!admins.length) {
            adminHost.innerHTML = '<span class="opacity-50">No administrators assigned.</span>';
            return;
          }
          const canPermanentlyDelete = this.can('agency_control.agencies.manage');
          adminHost.innerHTML = `<table class="w-full text-left text-body-sm mt-2"><thead><tr><th>Name</th><th>Email</th><th>Username</th><th>Status</th>${canPermanentlyDelete ? '<th>Actions</th>' : ''}</tr></thead><tbody>${admins.map((a) => `<tr class="border-t"><td class="py-1">${this.esc(a.fullName || a.full_name || '')}</td><td class="py-1">${this.esc(a.email || '')}</td><td class="py-1">${this.esc(a.username || '')}</td><td class="py-1">${this.esc(a.status || '')}</td>${canPermanentlyDelete ? `<td class="py-1"><button data-admin-permanent="${this.esc(a.id)}" class="text-error underline">Permanently delete</button></td>` : ''}</tr>`).join('')}</tbody></table>`;
          adminHost.querySelectorAll('[data-admin-permanent]').forEach((button) => {
            button.addEventListener('click', async () => {
              if (!confirm('Permanently delete this agency administrator? This removes their Supabase Auth and SQLite accounts and cannot be undone.')) return;
              try {
                await window.API.del(`/agency-control/administrators/${encodeURIComponent(button.dataset.adminPermanent)}/permanent`);
                this.showToast('Agency administrator permanently deleted.');
                this.openViewModal(agencyId);
              } catch (error) {
                adminHost.textContent = this.apiErrorText(error, 'Could not permanently delete this administrator.');
              }
            });
          });
        } catch (e) {
          console.error('Failed to load admins', e);
          adminHost.innerHTML = '<span class="text-error">Could not load administrators.</span>';
        }
      })();
    }
  },

  openEditModal(agencyId) {
    const agency = this.agencies.find((a) => a.id === agencyId) || null;
    const host = document.getElementById('ac-modal');
    if (!host) return;

    let html = '<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">';
    html += '<div class="w-full max-w-2xl rounded-xl bg-surface-container p-6 border border-outline-variant/40">';
    html += '<h2 class="font-display text-h3 text-on-surface">Edit sub-agency</h2>';
    html += '<div id="ac-edit-error" class="hidden mt-3 text-body-sm text-error"></div>';
    html += '<div class="grid grid-cols-2 gap-3 mt-4">';
    html += this.field('ac-edit-name', 'Name', agency ? agency.name : '', true);
    html += this.field('ac-edit-code', 'Code', agency ? agency.agencyCode : '', true);
    html += this.field('ac-edit-email', 'Contact email', agency ? (agency.contactEmail || '') : '');
    html += this.field('ac-edit-phone', 'Contact phone', agency ? (agency.contactPhone || '') : '');
    html += this.field('ac-edit-address', 'Address', agency ? (agency.address || '') : '');
    html += this.field('ac-edit-city', 'City', agency ? (agency.city || '') : '');
    html += this.field('ac-edit-state', 'State', agency ? (agency.state || '') : '');
    html += this.field('ac-edit-pincode', 'Pincode', agency ? (agency.pincode || '') : '');
    html += '</div>';
    html += '<div class="flex justify-end gap-2 mt-6">';
    html += '<button id="ac-edit-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>';
    html += '<button id="ac-edit-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm">Save</button>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    host.innerHTML = html;

    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-edit-cancel').addEventListener('click', close);
    document.getElementById('ac-edit-save').addEventListener('click', async () => {
      const errEl = document.getElementById('ac-edit-error');
      const val = (id) => (document.getElementById(id) || {}).value || '';
      const payload = {
        name: val('ac-edit-name'), agencyCode: val('ac-edit-code'),
        contactEmail: val('ac-edit-email'), contactPhone: val('ac-edit-phone'),
        address: val('ac-edit-address'), city: val('ac-edit-city'),
        state: val('ac-edit-state'), pincode: val('ac-edit-pincode')
      };
      try {
        await window.API.put('/agency-control/sub-agencies/' + encodeURIComponent(agencyId), payload);
        close();
        this.showToast('Agency updated successfully.');
        this.refresh();
      } catch (e) {
        if (errEl) { errEl.textContent = this.apiErrorText(e, 'Could not update agency.'); errEl.classList.remove('hidden'); }
      }
    });
  },

    openAddAdminModal(agencyId) {
    const host = document.getElementById('ac-modal');
    if (!host) return;
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
        <h2 class="font-display text-h3 text-on-surface">Add agency administrator</h2>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Creates a login in the agency's own company. The password is never displayed after saving.</p>
        <div id="ac-admin-error" class="hidden mt-3 text-body-sm text-error"></div>
        <div class="grid grid-cols-1 gap-3 mt-4">
          ${this.field('ac-a-name', 'Full name', '', true)}
          ${this.field('ac-a-email', 'Email', 'admin@agency.com', true)}
          ${this.field('ac-a-user', 'Username', '', true)}
          ${this.field('ac-a-pass', 'Temporary password', 'Min 10 characters', true)}
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button id="ac-a-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
          <button id="ac-a-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Assign</button>
        </div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-a-cancel').addEventListener('click', close);
    document.getElementById('ac-a-save').addEventListener('click', async () => {
      const errEl = document.getElementById('ac-admin-error');
      const val = (id) => (document.getElementById(id) || {}).value || '';
      const payload = { fullName: val('ac-a-name'), email: val('ac-a-email'), username: val('ac-a-user'), password: val('ac-a-pass') };
      try {
        await window.API.post(`/agency-control/sub-agencies/${encodeURIComponent(agencyId)}/administrators`, payload);
        close();
        this.showToast('Agency administrator assigned successfully.');
      } catch (e) {
        if (errEl) {
          const detail = this.apiErrorText(e, 'Could not assign admin.');
          if (/already assigned to another agency|already linked to another agency/i.test(detail)
            && this.role() === 'platform') {
            errEl.innerHTML = `${this.esc(detail)}<div class="flex flex-wrap items-center gap-3 mt-3"><button id="ac-a-reassign" type="button" class="rounded-lg bg-primary text-on-primary px-3 py-2">Reassign existing account here</button><button id="ac-a-permanent-delete" type="button" class="rounded-lg border border-error/50 text-error px-3 py-2">Permanently remove account</button><span class="text-on-surface-variant">Reassignment preserves the existing CRM data. Permanent removal is blocked when dependent records exist.</span></div>`;
            errEl.classList.remove('hidden');
            document.getElementById('ac-a-reassign')?.addEventListener('click', async () => {
              const email = val('ac-a-email').trim();
              if (!confirm(`Reassign ${email} to this agency? Their existing CRM data will be preserved.`)) return;
              const button = document.getElementById('ac-a-reassign');
              if (button) { button.disabled = true; button.textContent = 'Reassigning…'; }
              try {
                await window.API.post(`/agency-control/sub-agencies/${encodeURIComponent(agencyId)}/administrators/reassign-existing`, { email });
                close();
                this.showToast('Existing account reassigned. Its CRM data was preserved.');
                this.refresh();
              } catch (reassignError) {
                if (errEl) {
                  errEl.textContent = this.apiErrorText(reassignError, 'Could not reassign this account.');
                  errEl.classList.remove('hidden');
                }
              }
            });
            document.getElementById('ac-a-permanent-delete')?.addEventListener('click', async () => {
              const email = val('ac-a-email').trim();
              if (!confirm(`Permanently remove ${email} from Supabase Auth and BlackStack? This cannot be undone. Dependent records will block deletion.`)) return;
              try {
                await window.API.post('/agency-control/administrators/permanent-delete-by-email', { email });
                errEl.textContent = 'Account permanently removed. Click Assign to create and assign a fresh account using the entered details.';
                errEl.classList.remove('hidden');
              } catch (deleteError) {
                errEl.textContent = this.apiErrorText(deleteError, 'Could not permanently remove this account.');
                errEl.classList.remove('hidden');
              }
            });
          } else {
            errEl.textContent = /already exists|already registered|already an administrator/i.test(detail)
              ? `${detail} To permanently remove an existing agency administrator, open Agency Control → View Details → Administrators and use Permanently delete. Deletion is blocked while dependent records exist.`
              : detail;
            errEl.classList.remove('hidden');
          }
        }
      }
    });
  },
  openResetPasswordModal(agencyId) {
    const host = document.getElementById('ac-modal');
    if (!host) return;
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
        <h2 class="font-display text-h3 text-on-surface">Reset administrator password</h2>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Set a new temporary password for the agency administrator.</p>
        <div id="ac-reset-error" class="hidden mt-3 text-body-sm text-error"></div>
        <div class="grid grid-cols-1 gap-3 mt-4">
          ${this.field('ac-r-pass', 'New temporary password', 'Min 10 characters', true)}
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button id="ac-r-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
          <button id="ac-r-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Reset</button>
        </div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-r-cancel').addEventListener('click', close);
    document.getElementById('ac-r-save').addEventListener('click', async () => {
      const errEl = document.getElementById('ac-reset-error');
      const val = (id) => (document.getElementById(id) || {}).value || '';
      const payload = { password: val('ac-r-pass') };
      try {
        await window.API.post(`/agency-control/sub-agencies/${encodeURIComponent(agencyId)}/reset-password`, payload);
        close();
        this.showToast('Administrator password has been reset.');
      } catch (e) {
        if (errEl) { errEl.textContent = this.apiErrorText(e, 'Could not reset password.'); errEl.classList.remove('hidden'); }
      }
    });
  },
  async changeStatus(id, status) {
    try {
      const result = await window.API.post(`/agency-control/sub-agencies/${id}/status`, { status, reason: 'Changed by agency manager' });
      const agency = result && result.agency ? result.agency : null;
      if (agency && agency.id) this.agencies = this.agencies.map((a) => a.id === agency.id ? { ...a, ...agency } : a);
      this.renderAgencies();
      await this.refresh();
    } catch (error) { this.showError(error.message || 'Could not update agency.'); }
  },
  async bulkStatus(status) {
    const ids = this.selectedAgencies.slice();
    if (!ids.length) return;
    try {
      await window.API.post(`/agency-control/sub-agencies/bulk/status`, { ids, status, reason: 'Changed by agency manager' });
      this.selectedAgencies = [];
      await this.refresh();
    } catch (error) { this.showError(error.message || 'Could not update agencies.'); }
  },
  async bulkRemove() {
    const ids = this.selectedAgencies.slice();
    if (!ids.length) return;
    if (!confirm('WARNING: This will permanently delete the selected sub-agencies and ALL related data (admins, customers, history). This cannot be undone. Are you sure?')) return;
    try {
      await window.API.post(`/agency-control/sub-agencies/bulk/remove`, { ids });
      this.selectedAgencies = [];
      await this.refresh();
      this.showToast('Selected sub-agencies permanently deleted.');
    } catch (error) {
      const msg = (error && error.message) ? error.message : 'Could not remove agencies.';
      const fkMsg = /foreign key|constraint|RESTRICT|Cannot delete/i.test(msg) ? 'Cannot delete because related records exist. Remove assigned customers or parent/child links first.' : msg;
      this.showError(fkMsg);
    }
  },
  async removeAgency(id) {
    console.log('REMOVE CLICKED:', id);
    if (!confirm('WARNING: This will permanently delete the sub-agency and ALL related data (admins, customers, history). This cannot be undone. Are you sure?')) {
      console.log('CONFIRM RESULT: false');
      return;
    }
    console.log('CONFIRM RESULT: true');
    try {
      console.log('CALLING API.del for:', `/agency-control/sub-agencies/${encodeURIComponent(id)}`);
      const response = await window.API.del(`/agency-control/sub-agencies/${encodeURIComponent(id)}`);
      console.log('API RESPONSE:', response);
      await this.refresh();
      this.showToast('Sub-agency permanently deleted.');
    } catch (error) {
      console.log('REMOVE ERROR:', error);
      const msg = (error && error.message) ? error.message : 'Could not remove agency.';
      const fkMsg = /foreign key|constraint|RESTRICT|Cannot delete/i.test(msg) ? 'Cannot delete because related records exist. Remove assigned customers or parent/child links first.' : msg;
      this.showError(fkMsg);
    }
  },
  badge(status) {
    const map = {
      ACTIVE: 'bg-success/15 text-success border-success/30',
      PENDING: 'bg-warning/15 text-warning border-warning/30',
      SUSPENDED: 'bg-error/15 text-error border-error/30',
      TERMINATED: 'bg-on-surface-variant/15 text-on-surface-variant border-on-surface-variant/30',
    };
    return `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium border ${map[status] || map.TERMINATED}">${this.esc(status)}</span>`;
  },
  row(label, value) {
    return `<div><dt class="text-on-surface-variant">${this.esc(label)}</dt><dd class="text-on-surface">${value ? this.esc(String(value)) : '<span class="opacity-50">—</span>'}</dd></div>`;
  },
  field(id, label, placeholder, required) {
    return `<label class="block"><span class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(label)}${required ? ' *' : ''}</span><input id="${id}" type="text" placeholder="${this.esc(placeholder)}" class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40" /></label>`;
  },
  renderCustomers() {
    const host = document.getElementById('ac-customers');
    const select = document.getElementById('ac-customer-agency');
    if (!host || !select) return;
    // The caller's sub-agencies may be status PENDING (newly created, awaiting
    // the parent's activation) — filtering for ACTIVE only left the creation
    // dropdown empty, so both statuses are offered now.
    const choices = (this.customerAgencies || this.agencies).filter((a) => a.status === 'ACTIVE' || a.status === 'PENDING')
      .map((a) => `<option value="${this.esc(a.id)}">${this.esc(a.name)}${a.status === 'PENDING' ? ' (PENDING)' : ''}</option>`).join('');
    select.innerHTML = choices || '<option value="">No agencies in scope</option>';
    // Default to the caller's agency scope; fall back to the first ACTIVE or
    // PENDING agency in scope — never an empty/hidden default.
    select.value = (this.customers[0] && this.customers[0].agencyId) || (this.customerAgencies || this.agencies).find((a) => a.status === 'ACTIVE' || a.status === 'PENDING')?.id || '';
    // FIX (UI parity with sub-agencies): checkbox column + per-row Actions
    // dropdown + bulk bar state. Inline reassign/select controls moved into
    // the Reassign modal.
    const allSelected = this.customers.length > 0 && this.customers.every((c) => (this.selectedCustomers || []).includes(c.id));
    const rows = this.customers.map((c) => `<tr class="border-t">
      <td class="py-2"><input type="checkbox" data-customer-select="${this.esc(c.id)}" ${this.selectedCustomers.includes(c.id) ? 'checked' : ''} /></td>
      <td class="py-2">${this.esc(c.name)}</td>
      <td>${this.esc(c.agencyName)}</td>
      <td>${this.esc(c.status)}</td>
      <td class="text-right">
        <div class="relative inline-block text-left">
          <button data-customer-actions="${this.esc(c.id)}" class="rounded border px-2 py-1 text-body-sm">Actions</button>
          <div data-customer-menu="${this.esc(c.id)}" class="hidden absolute right-0 mt-2 w-44 rounded border bg-white shadow z-10">
            <button data-cust-action="view-details" data-id="${this.esc(c.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">View Details</button>
            <button data-cust-action="edit" data-id="${this.esc(c.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Edit Name</button>
            ${this.role() !== 'sub_agency' ? `<button data-cust-action="reassign" data-id="${this.esc(c.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Reassign Agency</button>` : ''}
            <button data-cust-action="add-customer-admin" data-id="${this.esc(c.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">Add Admin</button>
            <button data-cust-action="access" data-id="${this.esc(c.id)}" data-status="${c.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-gray-100">${c.status === 'ACTIVE' ? 'Suspend' : 'Activate'}</button>
            <button data-cust-action="remove" data-id="${this.esc(c.id)}" class="block w-full text-left px-3 py-2 text-body-sm text-error hover:bg-gray-100">Remove</button>
          </div>
        </div>
      </td>
    </tr>`).join('');
    host.innerHTML = rows
      ? `<table class="w-full text-left text-body-sm"><thead><tr><th><input type="checkbox" id="ac-cust-select-all" ${allSelected ? 'checked' : ''} /></th><th>Customer</th><th>Agency</th><th>Access</th><th class="text-right">Actions</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="text-on-surface-variant">No customer tenants yet.</p>';
    this.updateCustomerBulkBar();
    this.attachCustomerActions();
  },
  updateCustomerBulkBar() {
    const bar = document.getElementById('ac-cust-bulk-bar');
    const countEl = document.getElementById('ac-cust-bulk-count');
    if (!bar || !countEl) return;
    const count = (this.selectedCustomers || []).length;
    countEl.textContent = String(count);
    bar.classList.toggle('hidden', count === 0);
  },
  attachCustomerActions() {
    const host = document.getElementById('ac-customers');
    if (!host) return;
    host.querySelectorAll('[data-customer-actions]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-customer-actions');
        const menu = host.querySelector(`[data-customer-menu="${id}"]`);
        if (!menu) return;
        const isOpen = !menu.classList.contains('hidden');
        host.querySelectorAll('[data-customer-menu]').forEach((m) => m.classList.add('hidden'));
        if (!isOpen) menu.classList.remove('hidden');
      });
    });
    host.querySelectorAll('[data-cust-action]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.getAttribute('data-cust-action');
        const id = item.getAttribute('data-id');
        host.querySelectorAll('[data-customer-menu]').forEach((m) => m.classList.add('hidden'));
        if (action === 'view-details') this.openCustomerDetailsModal(id);
        else if (action === 'edit') this.openCustomerEditModal(id);
        else if (action === 'reassign') this.openCustomerReassignModal(id);
        else if (action === 'add-customer-admin') this.openAddCustomerAdminModal(id);
        else if (action === 'access') this.toggleCustomerAccess(id, item.getAttribute('data-status'));
        else if (action === 'remove') this.removeCustomer(id);
      });
    });
    host.querySelectorAll('[data-customer-select]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.getAttribute('data-customer-select');
        if (!id) return;
        if (box.checked) {
          if (!this.selectedCustomers.includes(id)) this.selectedCustomers.push(id);
        } else {
          this.selectedCustomers = this.selectedCustomers.filter((x) => x !== id);
        }
        this.updateCustomerBulkBar();
      });
    });
    document.getElementById('ac-cust-select-all')?.addEventListener('change', (e) => {
      this.selectedCustomers = e.target.checked ? this.customers.map((c) => c.id) : [];
      this.renderCustomers();
    });
    document.addEventListener('click', () => {
      host.querySelectorAll('[data-customer-menu]').forEach((m) => m.classList.add('hidden'));
    });
  },
  async openCustomerDetailsModal(customerId) {
    const host = document.getElementById('ac-modal');
    if (!host) return;
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section id="ac-customer-details-modal" role="dialog" aria-modal="true" aria-labelledby="ac-customer-details-title" class="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-surface-container p-6 border border-outline-variant/40 shadow-xl">
        <div class="flex items-start justify-between gap-4">
          <div><h2 id="ac-customer-details-title" class="font-display text-h3 text-on-surface">Customer details</h2><p class="mt-1 text-body-sm text-on-surface-variant">Read-only customer tenant information.</p></div>
          <button id="ac-customer-details-close-top" type="button" aria-label="Close" class="rounded px-3 py-1 text-on-surface-variant hover:bg-surface-container-high">×</button>
        </div>
        <div id="ac-customer-details-content" class="mt-5 flex items-center justify-center gap-3 py-10 text-body-sm text-on-surface-variant"><span class="inline-block h-5 w-5 animate-spin rounded-full border-2 border-outline-variant border-t-primary" aria-hidden="true"></span><span>Loading customer details…</span></div>
        <div class="mt-6 flex justify-end"><button id="ac-customer-details-close" type="button" class="rounded-lg bg-primary px-4 py-2 text-body-sm text-on-primary">Close</button></div>
      </section>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-customer-details-close')?.addEventListener('click', close);
    document.getElementById('ac-customer-details-close-top')?.addEventListener('click', close);

    try {
      const result = await window.API.get(`/agency-control/customers/${encodeURIComponent(customerId)}`);
      const customer = result && (result.customer || result);
      if (!customer) throw new Error('Customer details were not returned.');
      const content = document.getElementById('ac-customer-details-content');
      if (!content || !document.getElementById('ac-customer-details-modal')) return;
      const created = customer.createdAt ? new Date(customer.createdAt) : null;
      const createdLabel = created && !Number.isNaN(created.getTime()) ? created.toLocaleString() : customer.createdAt || '—';
      const administrators = Array.isArray(customer.administrators) ? customer.administrators : [];
      const adminRows = administrators.map((admin) => `<tr class="border-t border-outline-variant/40"><td class="py-2 pr-3">${this.esc(admin.fullName || '—')}</td><td class="py-2 pr-3">${this.esc(admin.email || '—')}</td><td class="py-2 pr-3">${this.esc(admin.username || '—')}</td><td class="py-2">${this.esc(admin.status || '—')}</td></tr>`).join('');
      content.className = 'mt-5 space-y-5';
      content.innerHTML = `<dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div><dt class="text-body-sm text-on-surface-variant">Customer name</dt><dd class="mt-1 text-on-surface">${this.esc(customer.customerName || customer.companyName || '—')}</dd></div>
        <div><dt class="text-body-sm text-on-surface-variant">Full name</dt><dd class="mt-1 text-on-surface">${this.esc(customer.fullName || '—')}</dd></div>
        <div><dt class="text-body-sm text-on-surface-variant">Email address</dt><dd class="mt-1 text-on-surface">${this.esc(customer.email || '—')}</dd></div>
        <div><dt class="text-body-sm text-on-surface-variant">Status</dt><dd class="mt-1">${this.badge(String(customer.status || 'UNKNOWN').toUpperCase())}</dd></div>
        <div><dt class="text-body-sm text-on-surface-variant">Company / tenant</dt><dd class="mt-1 text-on-surface">${this.esc(customer.companyName || '—')}</dd></div>
        <div><dt class="text-body-sm text-on-surface-variant">Parent sub-agency / agency</dt><dd class="mt-1 text-on-surface">${this.esc(customer.parentAgencyName || '—')}${customer.parentAgencyCode ? ` (${this.esc(customer.parentAgencyCode)})` : ''}</dd></div>
        <div><dt class="text-body-sm text-on-surface-variant">Date created</dt><dd class="mt-1 text-on-surface">${this.esc(createdLabel)}</dd></div>
      </dl>
      <div><h3 class="font-medium text-on-surface">Administrators</h3>${adminRows ? `<div class="mt-2 overflow-x-auto"><table class="w-full text-left text-body-sm"><thead><tr><th class="pb-2 pr-3">Name</th><th class="pb-2 pr-3">Email</th><th class="pb-2 pr-3">Username</th><th class="pb-2">Status</th></tr></thead><tbody>${adminRows}</tbody></table></div>` : '<p class="mt-2 text-body-sm text-on-surface-variant">No customer administrator assigned.</p>'}</div>`;
    } catch (error) {
      close();
      this.showToast(this.apiErrorText(error, 'Could not load customer details.'));
    }
  },
  openCustomerEditModal(customerId) {
    const customer = this.customers.find((c) => c.id === customerId) || null;
    const host = document.getElementById('ac-modal');
    if (!host) return;
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-md rounded-xl bg-surface-container p-6 border border-outline-variant/40">
        <h2 class="font-display text-h3 text-on-surface">Edit customer name</h2>
        <div id="ac-c-edit-error" class="hidden mt-3 text-body-sm text-error"></div>
        <div class="mt-4">${this.field('ac-c-edit-name', 'Customer organisation name', customer ? customer.name : '', true)}</div>
        <div class="flex justify-end gap-2 mt-6">
          <button id="ac-c-edit-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
          <button id="ac-c-edit-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm">Save</button>
        </div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-c-edit-cancel').addEventListener('click', close);
    document.getElementById('ac-c-edit-save').addEventListener('click', async () => {
      const errEl = document.getElementById('ac-c-edit-error');
      const name = (document.getElementById('ac-c-edit-name') || {}).value || '';
      try {
        await window.API.put(`/agency-control/customers/${encodeURIComponent(customerId)}`, { name: name.trim() });
        close();
        this.showToast('Customer name updated.');
        await this.refresh();
      } catch (e) {
        if (errEl) { errEl.textContent = this.apiErrorText(e, 'Could not update customer.'); errEl.classList.remove('hidden'); }
      }
    });
  },
  /** Add Admin for a CUSTOMER TENANT — mirrors the sub-agency Add Admin
   *  modal but POSTs to /agency-control/customers/:id/administrators. The
   *  created user belongs to the customer's own company tenant with role
   *  CUSTOMER_ADMIN. */
  openAddCustomerAdminModal(customerId) {
    const customer = this.customers.find((c) => c.id === customerId) || null;
    const host = document.getElementById('ac-modal');
    if (!host) return;
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
        <h2 class="font-display text-h3 text-on-surface">Add customer administrator</h2>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Creates a login for ${this.esc(customer ? customer.name : 'this customer tenant')}. The password is never displayed after saving.</p>
        <div id="ac-ca-error" class="hidden mt-3 text-body-sm text-error"></div>
        <div class="grid grid-cols-1 gap-3 mt-4">
          ${this.field('ac-ca-name', 'Full name', '', true)}
          ${this.field('ac-ca-email', 'Email', 'admin@customer.com', true)}
          ${this.field('ac-ca-user', 'Username', '', true)}
          ${this.field('ac-ca-pass', 'Temporary password', 'Min 10 characters', true)}
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button id="ac-ca-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
          <button id="ac-ca-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Assign</button>
        </div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-ca-cancel').addEventListener('click', close);
    document.getElementById('ac-ca-save').addEventListener('click', async () => {
      const errEl = document.getElementById('ac-ca-error');
      const val = (id) => (document.getElementById(id) || {}).value || '';
      const payload = { fullName: val('ac-ca-name').trim(), email: val('ac-ca-email').trim(), username: val('ac-ca-user').trim(), password: val('ac-ca-pass') };
      try {
        await window.API.post(`/agency-control/customers/${encodeURIComponent(customerId)}/administrators`, payload);
        close();
        this.showToast('Customer administrator assigned successfully.');
        await this.refresh();
      } catch (e) {
        if (!errEl) return;
        const detail = this.apiErrorText(e, 'Could not assign customer admin.');
        if (/already exists|already registered|already belongs to an account/i.test(detail)) {
          if (this.role() === 'platform') {
            errEl.innerHTML = `${this.esc(detail)}
              <p class="mt-2 text-on-surface-variant">You can move this existing login to the selected customer, keeping its password. Its CRM records remain with the current company. Permanent removal deletes only the login and is blocked if the account owns dependent records.</p>
              <div class="flex flex-wrap gap-2 mt-3">
                <button id="ac-ca-reassign" type="button" class="rounded-lg bg-primary text-on-primary px-3 py-2">Assign existing account here</button>
                <button id="ac-ca-permanent-delete" type="button" class="rounded-lg border border-error/50 text-error px-3 py-2">Permanently remove account</button>
              </div>`;
            document.getElementById('ac-ca-reassign')?.addEventListener('click', async () => {
              if (!confirm(`Move ${payload.email} to ${customer?.name || 'this customer'}? The existing password is kept; CRM records remain with their current company.`)) return;
              const button = document.getElementById('ac-ca-reassign');
              if (button) { button.disabled = true; button.textContent = 'Assigning…'; }
              try {
                await window.API.post(`/agency-control/customers/${encodeURIComponent(customerId)}/administrators/reassign-existing`, { email: payload.email });
                close();
                this.showToast('Existing customer login assigned.');
                await this.refresh();
              } catch (reassignError) {
                errEl.textContent = this.apiErrorText(reassignError, 'Could not assign the existing account.');
                errEl.classList.remove('hidden');
              }
            });
            document.getElementById('ac-ca-permanent-delete')?.addEventListener('click', async () => {
              if (!confirm(`Permanently remove ${payload.email} from BlackStack and Supabase Auth? This removes only the login, never the customer’s CRM records. Dependent user records block deletion.`)) return;
              const button = document.getElementById('ac-ca-permanent-delete');
              if (button) { button.disabled = true; button.textContent = 'Removing…'; }
              try {
                await window.API.post(`/agency-control/customers/${encodeURIComponent(customerId)}/administrators/permanent-delete-by-email`, { email: payload.email });
                errEl.textContent = 'The existing login was permanently removed. Press Assign again to create a new customer administrator with these details.';
                errEl.classList.remove('hidden');
                if (button) button.remove();
                document.getElementById('ac-ca-reassign')?.remove();
              } catch (deleteError) {
                errEl.textContent = this.apiErrorText(deleteError, 'Could not permanently remove this account.');
                errEl.classList.remove('hidden');
              }
            });
          } else {
            errEl.textContent = `${detail} Ask a platform administrator to assign the existing customer login or permanently remove it.`;
          }
        } else {
          errEl.textContent = detail;
        }
        errEl.classList.remove('hidden');
      }
    });
  },
  openCustomerReassignModal(customerId) {
    const customer = this.customers.find((c) => c.id === customerId) || null;
    const host = document.getElementById('ac-modal');
    if (!host) return;
    const choices = (this.customerAgencies || this.agencies).filter((a) => a.status === 'ACTIVE' || a.status === 'PENDING')
      .map((a) => `<option value="${this.esc(a.id)}" ${customer && a.id === customer.agencyId ? 'selected' : ''}>${this.esc(a.name)}${a.status === 'PENDING' ? ' (PENDING)' : ''}</option>`).join('');
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-md rounded-xl bg-surface-container p-6 border border-outline-variant/40">
        <h2 class="font-display text-h3 text-on-surface">Reassign customer</h2>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Move ${this.esc(customer ? customer.name : 'this customer')} to a different agency.</p>
        <div id="ac-c-reassign-error" class="hidden mt-3 text-body-sm text-error"></div>
        <div class="mt-4">
          <label class="block"><span class="font-body-sm text-body-sm text-on-surface-variant">Target agency *</span>
          <select id="ac-c-reassign-agency" class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">${choices}</select></label>
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button id="ac-c-reassign-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
          <button id="ac-c-reassign-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm">Reassign</button>
        </div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('ac-c-reassign-cancel').addEventListener('click', close);
    document.getElementById('ac-c-reassign-save').addEventListener('click', async () => {
      const errEl = document.getElementById('ac-c-reassign-error');
      const agencyId = (document.getElementById('ac-c-reassign-agency') || {}).value || '';
      try {
        await window.API.patch(`/agency-control/customers/${encodeURIComponent(customerId)}/assignment`, { agencyId });
        close();
        this.showToast('Customer reassigned.');
        await this.refresh();
      } catch (e) {
        if (errEl) { errEl.textContent = this.apiErrorText(e, 'Could not reassign customer.'); errEl.classList.remove('hidden'); }
      }
    });
  },
  async toggleCustomerAccess(customerId, status) {
    try {
      await window.API.post(`/agency-control/customers/${encodeURIComponent(customerId)}/access`, { status });
      this.showToast(`Customer ${status === 'ACTIVE' ? 'activated' : 'suspended'}.`);
      await this.refresh();
    } catch (error) { this.showError(this.apiErrorText(error, 'Could not change customer access.')); }
  },
  async removeCustomer(customerId) {
    if (!confirm('WARNING: This will remove the customer tenant assignment and its reassignment history. The customer organisation record itself is kept. Continue?')) return;
    try {
      await window.API.del(`/agency-control/customers/${encodeURIComponent(customerId)}`);
      this.selectedCustomers = (this.selectedCustomers || []).filter((x) => x !== customerId);
      this.showToast('Customer tenant removed.');
      await this.refresh();
    } catch (error) { this.showError(this.apiErrorText(error, 'Could not remove customer.')); }
  },
  async bulkCustomerAccess(status) {
    const ids = (this.selectedCustomers || []).slice();
    if (!ids.length) return;
    try {
      const result = await window.API.post('/agency-control/customers/bulk/access', { ids, status });
      this.selectedCustomers = [];
      const updated = (result && result.updated) || 0;
      this.showToast(`${updated} of ${ids.length} customers set to ${status}.`);
      await this.refresh();
    } catch (error) { this.showError(this.apiErrorText(error, 'Could not update customers.')); }
  },
  async bulkRemoveCustomers() {
    const ids = (this.selectedCustomers || []).slice();
    if (!ids.length) return;
    if (!confirm(`WARNING: This will remove ${ids.length} customer tenant assignments (and their reassignment history). The customer organisation records are kept. Continue?`)) return;
    try {
      const result = await window.API.post('/agency-control/customers/bulk/remove', { ids });
      this.selectedCustomers = [];
      const removed = (result && result.removed) || 0;
      this.showToast(`${removed} of ${ids.length} customer tenants removed.`);
      await this.refresh();
    } catch (error) { this.showError(this.apiErrorText(error, 'Could not remove customers.')); }
  },
  /** Populate the Sub-agency creation form's Parent Agency dropdown with ROOT
   *  distribution agencies (agency_code NOT LIKE 'SUB-%') fetched from the
   *  Mother Company list endpoint — strict separation (architecture task):
   *  sub-agencies can only be parented under a root agency, never under
   *  another sub-agency. Falls back to the caller's own agency header row
   *  when the MC list is unavailable (local admin without MC permission). */
  async renderParentOptions() {
    const select = document.getElementById('ac-parent-agency');
    if (!select) return;
    const previous = select.value;
    let roots = [];
    try {
      const res = await window.API.get('/mother-company/agencies');
      roots = (res && res.agencies) || [];
    } catch {
      // No MC permission or endpoint failure: fall back to the caller's own
      // agency (it is a root agency by definition — an admin's own tenant).
      roots = this.parentAgency ? [this.parentAgency] : [];
    }
    const seen = new Set();
    const options = ['<option value="">Select parent agency…</option>'];
    for (const r of roots) {
      if (!r || !r.id || seen.has(r.id)) continue;
      if (r.status !== 'ACTIVE' && r.status !== 'PENDING') continue;
      seen.add(r.id);
      options.push(`<option value="${this.esc(r.id)}">${this.esc(r.name)}${r.status === 'PENDING' ? ' (PENDING)' : ''}</option>`);
    }
    select.innerHTML = options.join('');
    // Keep the user's current choice if it still exists; otherwise default to
    // the first root agency so the form is always ready to submit.
    if (previous && seen.has(previous)) {
      select.value = previous;
    } else if (roots.length) {
      select.value = roots[0].id;
    }
  },
  async createAgency() {
    const name = document.getElementById('ac-agency-name')?.value?.trim();
    if (!name) return this.showError('Enter a sub-agency name.');
    const parentAgencyId = document.getElementById('ac-parent-agency')?.value || null;
    if (!parentAgencyId) return this.showError('Select the parent agency this sub-agency belongs to.');
    try { await window.API.post('/agency-control/sub-agencies', { name, parentAgencyId }); document.getElementById('ac-agency-name').value = ''; await this.refresh(); }
    catch (error) { this.showError(this.apiErrorText(error, 'Could not create sub-agency.')); }
  },
  async createCustomer() {
    const name = document.getElementById('ac-customer-name')?.value?.trim();
    const agencyId = document.getElementById('ac-customer-agency')?.value;
    if (!name || !agencyId) return this.showError('Enter a customer name and choose an agency.');
    try { await window.API.post('/agency-control/customers', { name, agencyId }); document.getElementById('ac-customer-name').value = ''; await this.refresh(); }
    catch (error) { this.showError(this.apiErrorText(error, 'Could not create customer tenant.')); }
  },
};
