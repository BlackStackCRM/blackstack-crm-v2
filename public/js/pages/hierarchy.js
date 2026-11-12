// HIERARCHY MANAGEMENT — role-based network page for Agency / Sub-agency users.
//
// Rendered at #/hierarchy and registered as PageModules.hierarchy.
//
// ACCESS
//   Visible only for users whose hierarchy_role is 'agency' or 'sub_agency'
//   (never customer_tenant). role + agencyId come from the server session
//   (/api/auth/profile) — never from client input.
//
// CAPABILITIES BY ROLE
//   agency        → sees Sub-agencies + Customer Tenants tables; may create both.
//   sub_agency    → sees ONLY the Customer Tenants table; may create customer
//                   tenants under ITSELF (no sub-agency creation).
//
// CREATION uses POST /api/accounts/create (the RBAC endpoint): the server
// re-derives the caller's role/agency from its own session lookup and enforces
// the creation matrix — the client never claims a role.
window.PageModules = window.PageModules || {};

window.PageModules.hierarchy = {
  // state
  subs: [],
  customers: [],
  selectedSubs: [],
  selectedCustomers: [],
  role: null,
  agencyId: null,
  identity: null,

  async init() {
    const host = document.getElementById('page-container');
    if (!host) return () => {};

    // 1. Role + agencyId from the server session (authoritative).
    try {
      const profile = await this.fetchCurrentUser();
      const user = (profile && profile.user) || profile || {};
      this.role = window.RolePermissions
        ? window.RolePermissions.normalizeRole(user)
        : (user.hierarchyRole || this.roleFromLegacy(user));
      // agencyId: resolve from the administrators link via the profile's
      // agencyId, else fall back to the scoped list header (parentAgency = the
      // caller's own agency row), else the first root from the MC list for
      // the platform operator.
      this.agencyId = user.agencyId || null;
      this.identity = user;
      localStorage.setItem('crm_user', JSON.stringify(user));
    } catch (e) {
      host.innerHTML = this.errorPanel('Could not load your session. ' + ((e && e.message) || ''));
      return () => {};
    }

    // FIX (create-modal 400): resolve agencyId when the profile didn't expose
    // it (server restart before migration 091 rolled, or a legacy mapper).
    // The scoped list's parentAgency header is the caller's own agency row —
    // the correct parent for its own sub-agency/customer creations.
    if (!this.agencyId) {
      try {
        const probe = await window.API.get('/agency-control/sub-agencies');
        this.agencyId = ((probe && probe.parentAgency) || {}).id || null;
      } catch { /* leave null — the create modal shows a clear error */ }
    }
    if (!this.agencyId && this.role === 'platform') {
      try {
        const mc = await window.API.get('/mother-company/agencies');
        this.agencyId = (((mc || {}).agencies) || [])[0]?.id || null;
      } catch { /* leave null; the create modal requires a parent */ }
    }

    // 2. Role gate: hierarchy management is for agency + sub_agency (+ the
    //    platform operator, who owns the whole tree).
    if (!['agency', 'platform'].includes(this.role)) {
      if (this.role === 'customer_tenant') {
        window.location.hash = '#dashboard';
        return () => {};
      }
      host.innerHTML = `<div class="max-w-lg mx-auto mt-12 text-center">
        <span class="material-symbols-outlined text-[40px] text-on-surface-variant/60">lock</span>
        <h1 class="font-display text-h2 text-on-surface mt-4">Network management unavailable</h1>
        <p class="font-body text-body-sm text-on-surface-variant mt-2">
          Your account role (${this.esc(this.role || 'unknown')}) does not include network management.
        </p>
      </div>`;
      return () => {};
    }

    this.selectedSubs = [];
    this.selectedCustomers = [];

    const canCreateSubAgencies = this.canCreateRole('sub_agency');
    const canCreateCustomers = this.canCreateRole('customer_tenant');
    const isAgency = canCreateSubAgencies;
    host.innerHTML = `
      <div class="mb-stack-lg">
        <h1 class="font-display text-h1 text-on-surface">My Hierarchy</h1>
        <p class="text-body-sm text-on-surface-variant">
          ${isAgency
            ? 'Manage your sub-agencies and the customer tenants under them.'
            : 'Manage the customer tenants under your sub-agency.'}
        </p>
      </div>

      <div id="h-error" class="hidden mb-stack-md rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-body-sm text-error"></div>

      ${isAgency ? this.bulkBar('h-sub-bulk', 'Sub-agencies selected', 'h-sub-bulk-count', [
        { id: 'h-sub-bulk-remove', label: 'Bulk Remove', cls: 'border border-error/40 text-error' },
      ]) : ''}

      <section class="mb-stack-lg rounded-xl border border-outline-variant/40 p-stack-md">
        ${isAgency ? `<div class="flex items-center justify-between mb-stack-sm">
          <h2 class="font-display text-h3 text-on-surface">Sub-agencies</h2>
          ${canCreateSubAgencies ? '<button id="h-create-sub" class="rounded-lg bg-primary text-on-primary px-4 py-2 text-body-sm font-medium">Create Sub-agency</button>' : ''}
        </div>
        <div id="h-subs"></div>` : ''}
      </section>

      ${isAgency ? this.bulkBar('h-cust-bulk', 'Customers selected', 'h-cust-bulk-count', [
        { id: 'h-cust-bulk-suspend', label: 'Bulk Suspend', cls: 'border border-outline-variant' },
        { id: 'h-cust-bulk-remove', label: 'Bulk Remove', cls: 'border border-error/40 text-error' },
      ]) : ''}

      <section class="rounded-xl border border-outline-variant/40 p-stack-md">
        <div class="flex items-center justify-between mb-stack-sm">
          <h2 class="font-display text-h3 text-on-surface">Customer Tenants</h2>
          ${canCreateCustomers ? '<button id="h-create-cust" class="rounded-lg bg-primary text-on-primary px-4 py-2 text-body-sm font-medium">Create Customer Tenant</button>' : ''}
        </div>
        <div id="h-customers"></div>
      </section>

      <div id="h-modal"></div>`;

    // wire actions
    document.getElementById('h-create-sub')?.addEventListener('click', () => this.openCreateModal('sub_agency'));
    document.getElementById('h-create-cust')?.addEventListener('click', () => this.openCreateModal('customer_tenant'));
    document.getElementById('h-sub-bulk-remove')?.addEventListener('click', () => this.bulkRemoveSubs());
    document.getElementById('h-sub-bulk-clear')?.addEventListener('click', () => { this.selectedSubs = []; this.renderSubs(); });
    document.getElementById('h-cust-bulk-suspend')?.addEventListener('click', () => this.bulkCustomerAccess('SUSPENDED'));
    document.getElementById('h-cust-bulk-remove')?.addEventListener('click', () => this.bulkRemoveCustomers());
    document.getElementById('h-cust-bulk-clear')?.addEventListener('click', () => { this.selectedCustomers = []; this.renderCustomers(); });

    await this.refresh();
    // The platform operator has no single agencyId — its parent for creations
    // is the first root agency in scope (from the MC list).
    if (this.role === 'platform' && !this.agencyId) {
      try {
        const mc = await window.API.get('/mother-company/agencies');
        this.agencyId = (((mc || {}).agencies) || [])[0]?.id || null;
      } catch { /* leave null; the create modal requires a parent */ }
    }
    return () => {};
  },

  bulkBar(id, label, countId, buttons) {
    return `<div id="${id}" class="hidden mb-stack-md rounded-xl border border-outline-variant/60 bg-surface-container p-stack-sm">
      <div class="flex flex-wrap items-center gap-stack-sm">
        <span class="font-body-sm text-body-sm text-on-surface-variant">${label} <span id="${countId}">0</span></span>
        <div class="flex gap-stack-sm">
          ${buttons.map((b) => `<button id="${b.id}" class="rounded-lg ${b.cls} px-3 py-1.5 text-body-sm">${b.label}</button>`).join('')}
        </div>
        <button id="${id}-clear" class="text-body-sm text-on-surface-variant underline ml-auto">Clear selection</button>
      </div>
    </div>`;
  },

  /** hierarchy role from the profile; falls back to legacy role strings. */
  roleFromLegacy(user) {
    if (user.hierarchyRole) return user.hierarchyRole;
    if (user.role === 'ADMIN') return 'platform';
    if (user.role === 'AGENCY' || user.role === 'agency') return 'agency';
    if (user.role === 'AGENCY_ADMIN' || user.role === 'sub_agency') return 'sub_agency';
    if (user.role === 'CUSTOMER_ADMIN' || user.role === 'customer_tenant') return 'customer_tenant';
    return null;
  },

  canCreateRole(targetRole) {
    if (targetRole === 'agency') return window.RolePermissions
      ? window.RolePermissions.canCreateAgency()
      : this.role === 'platform';
    if (targetRole === 'sub_agency') return window.RolePermissions
      ? window.RolePermissions.canCreateSubAgency()
      : this.role === 'platform' || this.role === 'agency';
    if (targetRole === 'customer_tenant') return window.RolePermissions
      ? window.RolePermissions.canCreateCustomer()
      : ['platform', 'agency', 'sub_agency'].includes(this.role);
    return false;
  },

  async fetchCurrentUser() {
    let user = null;
    if (window.AuthAPI && typeof window.AuthAPI.getProfile === 'function') {
      user = await window.AuthAPI.getProfile();
    } else {
      try { user = await window.API.get('/auth/me'); }
      catch { user = await window.API.get('/auth/profile'); }
    }
    user = (user && user.user) || user || {};
    if (!user.agencyId && user.agency_id) user.agencyId = user.agency_id;
    if (user && user.id) localStorage.setItem('crm_user', JSON.stringify(user));
    return user;
  },

  async refresh() {
    try {
      // FIX (partial-failure list): the previous Promise.all discarded BOTH
      // results when either call failed (e.g. a 403 on /sub-agencies or a
      // transient /customers error), so one broken endpoint blanked the whole
      // page — "No customer tenants yet" even when the customers call
      // succeeded. Fetch each independently; render whatever came back.
      const [subs, custs] = await Promise.all([
        window.API.get('/agency-control/sub-agencies').catch(() => null),
        window.API.get('/agency-control/customers').catch(() => null),
      ]);
      if (!subs && !custs) throw new Error('Both network endpoints failed.');
      this.subs = (subs && subs.agencies) || [];
      this.customers = (custs && custs.customers) || [];
      this.renderSubs();
      this.renderCustomers();
    } catch (e) {
      this.showError(this.apiErrorText(e, 'Could not load your network.'));
    }
  },

  renderSubs() {
    const host = document.getElementById('h-subs');
    if (!host) return;
    const allSelected = this.subs.length > 0 && this.subs.every((s) => this.selectedSubs.includes(s.id));
    const rows = this.subs.map((s) => `<tr class="border-t">
      <td class="py-2"><input type="checkbox" data-h-sub="${this.esc(s.id)}" ${this.selectedSubs.includes(s.id) ? 'checked' : ''} /></td>
      <td class="py-2">${this.esc(s.name)}</td>
      <td class="py-2 font-mono">${this.esc(s.agencyCode)}</td>
      <td class="py-2">${this.esc(s.status)}</td>
      <td class="py-2 text-right"><span class="material-symbols-outlined text-[18px] text-on-surface-variant">person</span> ${(s.adminCount !== undefined) ? s.adminCount : '—'}</td>
      <td class="py-2 text-right">${this.actionMenu('sub_agency', s)}</td>
    </tr>`).join('');
    host.innerHTML = rows
      ? `<table class="w-full text-left text-body-sm"><thead><tr>
          <th class="w-8"><input type="checkbox" id="h-sub-all" ${allSelected ? 'checked' : ''} /></th>
          <th>Name</th><th>Code</th><th>Status</th><th class="text-right">Admins</th><th class="text-right">Actions</th>
        </tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="text-on-surface-variant">No sub-agencies yet. Use “Create Sub-agency” to add the first one.</p>';
    document.getElementById('h-sub-all')?.addEventListener('change', (e) => {
      this.selectedSubs = e.target.checked ? this.subs.map((s) => s.id) : [];
      this.renderSubs();
    });
    host.querySelectorAll('[data-h-sub]').forEach((box) => box.addEventListener('change', () => {
      const id = box.getAttribute('data-h-sub');
      if (box.checked) { if (!this.selectedSubs.includes(id)) this.selectedSubs.push(id); }
      else this.selectedSubs = this.selectedSubs.filter((x) => x !== id);
      this.updateBulkCount('h-sub-bulk-count', this.selectedSubs.length, 'h-sub-bulk');
    }));
    this.bindEntityActions(host);
    this.updateBulkCount('h-sub-bulk-count', this.selectedSubs.length, 'h-sub-bulk');
  },

  renderCustomers() {
    const host = document.getElementById('h-customers');
    if (!host) return;
    const allSelected = this.customers.length > 0 && this.customers.every((c) => this.selectedCustomers.includes(c.id));
    const rows = this.customers.map((c) => `<tr class="border-t">
      <td class="py-2"><input type="checkbox" data-h-cust="${this.esc(c.id)}" ${this.selectedCustomers.includes(c.id) ? 'checked' : ''} /></td>
      <td class="py-2">${this.esc(c.name)}</td>
      <td class="py-2">${this.esc(c.agencyName || '')}</td>
      <td class="py-2">${this.esc(c.status)}</td>
      <td class="py-2 text-right">${this.actionMenu('customer_tenant', c)}</td>
    </tr>`).join('');
    host.innerHTML = rows
      ? `<table class="w-full text-left text-body-sm"><thead><tr>
          <th class="w-8"><input type="checkbox" id="h-cust-all" ${allSelected ? 'checked' : ''} /></th>
          <th>Customer</th><th>Agency</th><th>Access</th><th class="text-right">Actions</th>
        </tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="text-on-surface-variant">No customer tenants yet. Use “Create Customer Tenant” to add the first one.</p>';
    document.getElementById('h-cust-all')?.addEventListener('change', (e) => {
      this.selectedCustomers = e.target.checked ? this.customers.map((c) => c.id) : [];
      this.renderCustomers();
    });
    host.querySelectorAll('[data-h-cust]').forEach((box) => box.addEventListener('change', () => {
      const id = box.getAttribute('data-h-cust');
      if (box.checked) { if (!this.selectedCustomers.includes(id)) this.selectedCustomers.push(id); }
      else this.selectedCustomers = this.selectedCustomers.filter((x) => x !== id);
      this.updateBulkCount('h-cust-bulk-count', this.selectedCustomers.length, 'h-cust-bulk');
    }));
    this.bindEntityActions(host);
    this.updateBulkCount('h-cust-bulk-count', this.selectedCustomers.length, 'h-cust-bulk');
  },

  actionMenu(type, row) {
    const isAgency = this.role === 'agency' || this.role === 'platform';
    const canManage = type === 'sub_agency' ? isAgency
      : isAgency || this.role === 'sub_agency';
    if (!canManage) return '';
    const status = String(row.status || '').toUpperCase();
    const statusAction = status === 'ACTIVE' ? 'suspend' : 'activate';
    const statusLabel = statusAction === 'suspend' ? 'Suspend' : 'Activate';
    const id = this.esc(row.id);
    return `<details class="relative inline-block text-left">
      <summary class="list-none cursor-pointer rounded-md px-2 py-1 hover:bg-surface-container-high" aria-label="Actions">⋮</summary>
      <div class="absolute right-0 z-20 mt-1 min-w-48 rounded-lg border border-outline-variant bg-surface-container p-1 shadow-lg">
        ${[['view', 'View Details'], ['edit', 'Edit'], ['add-admin', 'Add Admin'], ['reset-password', 'Reset Admin Password'], [statusAction, statusLabel], ['remove', 'Remove']]
          .map(([action, label]) => `<button type="button" data-h-action="${action}" data-h-type="${type}" data-h-id="${id}" class="block w-full rounded px-3 py-2 text-left text-body-sm hover:bg-surface-container-high ${action === 'remove' ? 'text-error' : ''}">${label}</button>`).join('')}
      </div>
    </details>`;
  },

  bindEntityActions(host) {
    if (!host || host.dataset.hierarchyActionsBound) return;
    host.dataset.hierarchyActionsBound = 'true';
    host.addEventListener('click', (event) => {
      const button = event.target.closest('[data-h-action]');
      if (!button) return;
      const { hAction: action, hType: type, hId: id } = button.dataset;
      button.closest('details')?.removeAttribute('open');
      this.handleEntityAction(action, type, id).catch((error) => {
        this.showError(this.apiErrorText(error, 'Could not complete this action.'));
      });
    });
  },

  async handleEntityAction(action, type, id) {
    const rows = type === 'sub_agency' ? this.subs : this.customers;
    const row = rows.find((item) => String(item.id) === String(id));
    if (!row) throw new Error('This hierarchy item is no longer available. Refresh the page and try again.');
    if (action === 'view') return this.openEntityDetails(type, row);
    if (action === 'edit') return this.openEntityEdit(type, row);
    if (action === 'add-admin') return this.openAddAdmin(type, row);
    if (action === 'reset-password') return this.resetEntityAdminPassword(type, row);
    if (action === 'activate' || action === 'suspend') {
      const status = action === 'activate' ? 'ACTIVE' : 'SUSPENDED';
      const endpoint = type === 'sub_agency'
        ? `/agency-control/sub-agencies/${encodeURIComponent(id)}/status`
        : `/agency-control/customers/${encodeURIComponent(id)}/access`;
      await window.API.post(endpoint, { status, reason: action === 'suspend' ? 'Suspended from My Hierarchy' : undefined });
      this.showToast(`${row.name} set to ${status}.`);
      return this.refresh();
    }
    if (action === 'remove') {
      const message = type === 'sub_agency'
        ? `Permanently remove “${row.name}” and its administrator accounts? Child entities or dependent administrator records will block removal.`
        : `Remove “${row.name}” from this hierarchy? Its company and CRM records will be retained.`;
      if (!window.confirm(message)) return;
      await window.API.del(`/agency-control/entities/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`);
      this.showToast(`${row.name} was removed.`);
      return this.refresh();
    }
  },

  async listEntityAdmins(type, id) {
    const endpoint = type === 'sub_agency'
      ? `/agency-control/sub-agencies/${encodeURIComponent(id)}/administrators`
      : `/agency-control/customers/${encodeURIComponent(id)}/administrators`;
    const result = await window.API.get(endpoint);
    return result.administrators || [];
  },

  openModal(title, content, saveLabel, onSave) {
    const host = document.getElementById('h-modal');
    if (!host) return;
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-lg rounded-xl border border-outline-variant/40 bg-surface-container p-6">
        <h2 class="font-display text-h3 text-on-surface">${this.esc(title)}</h2>
        <div class="mt-4">${content}</div>
        <div class="mt-6 flex justify-end gap-2">
          <button type="button" id="h-action-cancel" class="rounded-lg px-4 py-2 text-body-sm text-on-surface-variant">Cancel</button>
          ${saveLabel ? `<button type="button" id="h-action-save" class="rounded-lg bg-primary px-4 py-2 text-body-sm font-medium text-on-primary">${this.esc(saveLabel)}</button>` : ''}
        </div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('h-action-cancel').addEventListener('click', close);
    if (saveLabel && onSave) {
      document.getElementById('h-action-save').addEventListener('click', async () => {
        const button = document.getElementById('h-action-save');
        button.disabled = true;
        try { await onSave(close); }
        catch (error) {
          const errorEl = document.getElementById('h-action-error');
          if (errorEl) { errorEl.textContent = this.apiErrorText(error, 'Could not save changes.'); errorEl.classList.remove('hidden'); }
          else this.showError(this.apiErrorText(error, 'Could not save changes.'));
        } finally {
          const current = document.getElementById('h-action-save');
          if (current) current.disabled = false;
        }
      });
    }
    return { host, close };
  },

  async openEntityDetails(type, row) {
    let details = row;
    if (type === 'sub_agency') {
      const result = await window.API.get(`/agency-control/sub-agencies/${encodeURIComponent(row.id)}`);
      details = result.agency || row;
    }
    const admins = await this.listEntityAdmins(type, row.id).catch(() => []);
    const rows = [
      ['Name', details.name], ['Email', type === 'sub_agency' ? details.contactEmail : row.adminEmail],
      ['Code', details.agencyCode], ['Status', details.status], ['Agency', details.parentAgencyName || row.agencyName],
    ].filter(([, value]) => value != null && value !== '');
    const content = `<dl class="grid grid-cols-2 gap-3 text-body-sm">${rows.map(([k, v]) => `<div><dt class="text-on-surface-variant">${this.esc(k)}</dt><dd class="text-on-surface">${this.esc(v)}</dd></div>`).join('')}</dl>
      <h3 class="mt-5 font-label-md text-on-surface">Administrators</h3>
      <ul class="mt-2 space-y-1 text-body-sm">${admins.length ? admins.map((a) => `<li>${this.esc(a.fullName || a.full_name || a.email)} — ${this.esc(a.email)} (${this.esc(a.status)})</li>`).join('') : '<li class="text-on-surface-variant">No administrators assigned.</li>'}</ul>`;
    this.openModal('View Details', content, null, null);
  },

  async openEntityEdit(type, row) {
    const sub = type === 'sub_agency';
    const email = sub ? (row.contactEmail || '') : (row.adminEmail || '');
    const content = `<div id="h-action-error" class="hidden mb-3 text-body-sm text-error"></div>
      <label class="mb-3 block text-body-sm">Name<input id="h-action-name" class="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2" value="${this.esc(row.name)}"></label>
      <label class="block text-body-sm">${sub ? 'Contact email' : 'Primary admin email'}<input id="h-action-email" type="email" class="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2" value="${this.esc(email)}"></label>`;
    this.openModal('Edit ' + (sub ? 'Sub-agency' : 'Customer Tenant'), content, 'Save', async (close) => {
      const name = document.getElementById('h-action-name').value.trim();
      const newEmail = document.getElementById('h-action-email').value.trim();
      const endpoint = sub ? `/agency-control/sub-agencies/${encodeURIComponent(row.id)}` : `/agency-control/customers/${encodeURIComponent(row.id)}`;
      await window.API.put(endpoint, sub ? { name, contactEmail: newEmail } : { name, email: newEmail });
      close(); this.showToast('Changes saved.'); await this.refresh();
    });
  },

  generateTempPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const bytes = new Uint8Array(18);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  },

  async openAddAdmin(type, row) {
    const temp = this.generateTempPassword();
    const content = `<div id="h-action-error" class="hidden mb-3 text-body-sm text-error"></div>
      <label class="mb-3 block text-body-sm">Full name<input id="h-admin-name" class="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2"></label>
      <label class="mb-3 block text-body-sm">Email<input id="h-admin-email" type="email" class="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2"></label>
      <label class="block text-body-sm">Temporary password<input id="h-admin-password" class="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 font-mono" value="${this.esc(temp)}"></label>
      <p class="mt-2 text-xs text-on-surface-variant">The administrator must change this password at first sign-in.</p>`;
    this.openModal('Add Administrator — ' + row.name, content, 'Create Admin', async (close) => {
      const fullName = document.getElementById('h-admin-name').value.trim();
      const email = document.getElementById('h-admin-email').value.trim();
      const password = document.getElementById('h-admin-password').value;
      if (!fullName || !email || password.length < 10) throw new Error('Enter a name, valid email, and password of at least 10 characters.');
      const endpoint = type === 'sub_agency'
        ? `/agency-control/sub-agencies/${encodeURIComponent(row.id)}/administrators`
        : `/agency-control/customers/${encodeURIComponent(row.id)}/administrators`;
      await window.API.post(endpoint, { fullName, email, username: email, password });
      close();
      this.showCredentials(email, password, 'Administrator created');
      await this.refresh();
    });
  },

  async resetEntityAdminPassword(type, row) {
    const admins = await this.listEntityAdmins(type, row.id);
    const admin = admins.find((item) => String(item.status || '').toUpperCase() === 'ACTIVE') || admins[0];
    if (!admin) throw new Error('No administrator is assigned to this entity yet. Use Add Admin first.');
    const password = this.generateTempPassword();
    const content = `<p class="text-body-sm text-on-surface-variant">Reset password for ${this.esc(admin.email || admin.fullName || admin.full_name)}?</p>
      <label class="mt-3 block text-body-sm">Temporary password<input id="h-reset-password" class="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 font-mono" value="${this.esc(password)}"></label>
      <p class="mt-2 text-xs text-on-surface-variant">Share the new password securely with the administrator.</p>`;
    this.openModal('Reset Admin Password', content, 'Reset Password', async (close) => {
      const value = document.getElementById('h-reset-password').value;
      if (value.length < 10) throw new Error('Password must be at least 10 characters.');
      const endpoint = type === 'sub_agency'
        ? `/agency-control/sub-agencies/${encodeURIComponent(row.id)}/reset-password`
        : `/agency-control/customers/${encodeURIComponent(row.id)}/reset-password`;
      await window.API.post(endpoint, { password: value });
      close(); this.showCredentials(admin.email || admin.fullName || admin.full_name, value, 'Password reset');
    });
  },

  showCredentials(username, password, title) {
    const content = `<p class="text-body-sm text-on-surface-variant">Copy and share these credentials securely.</p>
      <div class="mt-3 rounded-lg bg-surface-container-low p-3 font-mono text-body-sm">${this.esc(username)}<br>${this.esc(password)}</div>`;
    const modal = this.openModal(title, content, 'Copy', () => navigator.clipboard?.writeText(`${username}\n${password}`).then(() => this.showToast('Credentials copied.')));
    document.getElementById('h-action-cancel').textContent = 'Done';
  },

  updateBulkCount(countId, count, barId) {
    const el = document.getElementById(countId);
    if (el) el.textContent = String(count);
    const bar = document.getElementById(barId);
    if (bar) bar.classList.toggle('hidden', count === 0);
  },

  /** Creation modal — role decides which role is requested; the server
   *  re-validates everything (parent agency, creation matrix). */
  openCreateModal(targetRole) {
    const host = document.getElementById('h-modal');
    if (!host) return;
    if (!this.canCreateRole(targetRole)) {
      this.showError(this.role === 'sub_agency' && targetRole === 'sub_agency'
        ? 'Sub-agencies do not have permission to create other sub-agencies.'
        : 'Your role does not have permission to create this account type.');
      return;
    }
    const isSub = targetRole === 'sub_agency';
    host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
        <h2 class="font-display text-h3 text-on-surface">${isSub ? 'Create Sub-agency' : 'Create Customer Tenant'}</h2>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
          A login will be created for ${isSub ? 'the sub-agency operator' : 'the customer organisation'}. Share the generated credentials securely — they change the password at first sign-in.
        </p>
        <div id="h-create-error" class="hidden mt-3 text-body-sm text-error"></div>
        <div class="grid grid-cols-1 gap-3 mt-4">
          <label class="block"><span class="font-body-sm text-body-sm text-on-surface-variant">Full name *</span>
            <input id="h-c-name" class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm" /></label>
          <label class="block"><span class="font-body-sm text-body-sm text-on-surface-variant">Email *</span>
            <input id="h-c-username" type="email" placeholder="e.g. nova.branch@example.com" autocomplete="off"
              class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm" />
            <span id="h-c-username-hint" class="hidden mt-1 block text-[12px] text-error">Enter a valid email address.</span>
            <span id="h-c-username-notice" class="hidden mt-1 block text-[12px] text-on-surface-variant"></span></label>
          <label class="block"><span class="font-body-sm text-body-sm text-on-surface-variant">Temporary password * <span class="opacity-60">(min 10 characters)</span></span>
            <input id="h-c-pass" type="text" class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm font-mono" /></label>
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button id="h-c-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
          <button id="h-c-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Create</button>
        </div>
      </div>
    </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('h-c-cancel').addEventListener('click', close);
    const emailInput = document.getElementById('h-c-username');
    const hintEl = document.getElementById('h-c-username-hint');
    const noticeEl = document.getElementById('h-c-username-notice');
    // Live validation: refresh the hint as the user types.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    emailInput.addEventListener('input', () => {
      const v = emailInput.value.trim();
      const bad = v.length > 0 && !EMAIL_RE.test(v);
      if (hintEl) hintEl.classList.toggle('hidden', !bad);
      emailInput.classList.toggle('border-error', bad);
    });
    // FIX: sanitize pasted prefixes ("Email: …" / "Username: …") on blur +
    // paste, mirroring the login page. Requires /js/utils/email-sanitizer.js.
    if (window.EmailSanitizer) {
      window.EmailSanitizer.attachEmailSanitizer(emailInput, { noticeEl });
    }
    document.getElementById('h-c-save').addEventListener('click', async () => {
      const errEl = document.getElementById('h-create-error');
      // Sanitize pasted prefixes BEFORE validating.
      if (window.EmailSanitizer) {
        emailInput.value = window.EmailSanitizer.sanitizeEmailValue(emailInput.value).value;
      }
      const val = (id) => (document.getElementById(id) || {}).value || '';
      const email = val('h-c-username').trim();
      // Hard gate: Create is blocked unless a valid email format is entered.
      if (!EMAIL_RE.test(email)) {
        if (hintEl) hintEl.classList.remove('hidden');
        emailInput.classList.add('border-error');
        emailInput.focus();
        if (errEl) { errEl.textContent = 'Enter a valid email address for the new account.'; errEl.classList.remove('hidden'); }
        return;
      }
      // FIX (parentAgencyId 400): the backend /accounts/create REQUIRES a
      // parentAgencyId. The creator's own agency is the parent — re-resolve it
      // silently if init() could not (profile without agencyId, failed probe,
      // or a page left open across a server restart). No UI dropdown by design.
      if (!this.agencyId) {
        try {
          const prof = await this.fetchCurrentUser();
          this.agencyId = prof.agencyId || prof.agency_id || this.agencyId;
        } catch { /* keep trying below */ }
      }
      if (!this.agencyId) {
        try {
          const prof = await window.API.get('/auth/me');
          const user = (prof && prof.user) || prof || {};
          this.agencyId = user.agencyId || user.agency_id || this.agencyId;
          if (user.id) localStorage.setItem('crm_user', JSON.stringify(user));
        } catch { /* continue to the scoped agency endpoint */ }
      }
      if (!this.agencyId) {
        try {
          const probe = await window.API.get('/agency-control/sub-agencies');
          this.agencyId = ((probe && probe.parentAgency) || {}).id || null;
        } catch { /* fall through to the guard below */ }
      }
      let currentUser = {};
      try {
        currentUser = window.AuthAPI?.getUser?.() || JSON.parse(localStorage.getItem('crm_user') || '{}');
      } catch { /* a malformed legacy cache is replaced when the profile refreshes */ }
      console.debug('[My Hierarchy] account context', {
        userId: currentUser.id || null,
        hierarchyRole: currentUser.hierarchyRole || currentUser.hierarchy_role || null,
        cachedAgencyId: currentUser.agencyId || currentUser.agency_id || null,
        resolvedAgencyId: this.agencyId || null,
      });
      if (currentUser.id && this.agencyId && currentUser.agencyId !== this.agencyId) {
        currentUser = { ...currentUser, agencyId: this.agencyId };
        localStorage.setItem('crm_user', JSON.stringify(currentUser));
      }
      if (!this.agencyId) {
        if (errEl) {
          errEl.textContent = 'Could not determine your agency — the parent agency for the new account is unknown. Reload the page and try again.';
          errEl.classList.remove('hidden');
        }
        return;
      }
      const payload = {
        username: email,
        email,
        role: targetRole,
        parentAgencyId: this.agencyId,
        password: val('h-c-pass'),
        displayName: val('h-c-name').trim(),
      };
      try {
        const res = await window.API.post('/accounts/create', payload);
        close();
        // Credentials panel — the parent hands these to the child operator.
        const acct = (res && res.account) || {};
        const otp = (res && res.oneTimePassword) || payload.password;
        host.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-success text-[24px]">check_circle</span>
              <h2 class="font-display text-h3 text-on-surface">${isSub ? 'Sub-agency' : 'Customer tenant'} created</h2>
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Share these credentials with the operator. They must change the password at first sign-in.</p>
            <div class="mt-4 rounded-lg border border-outline-variant/50 bg-surface-container-low p-4 font-mono text-body-sm space-y-1">
              <div><span class="text-on-surface-variant">Email:</span> <span id="h-cred-user" class="text-on-surface">${this.esc(acct.username || payload.username)}</span></div>
              <div><span class="text-on-surface-variant">Temp password:</span> <span id="h-cred-pass" class="text-on-surface">${this.esc(otp)}</span></div>
            </div>
            <div class="flex justify-end gap-2 mt-6">
              <button id="h-cred-copy" class="px-4 py-2 rounded-lg border border-outline-variant text-body-sm">Copy credentials</button>
              <button id="h-cred-done" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Done</button>
            </div>
          </div>
        </div>`;
        document.getElementById('h-cred-done').addEventListener('click', () => { host.innerHTML = ''; this.refresh(); });
        document.getElementById('h-cred-copy').addEventListener('click', () => {
          const text = `Username: ${acct.username || payload.username}\nTemporary password: ${otp}`;
          navigator.clipboard?.writeText(text).then(() => this.showToast('Credentials copied to clipboard.'));
        });
      } catch (e) {
        if (errEl) {
          errEl.textContent = e.code === 'ACCOUNT_ALREADY_EXISTS'
            ? 'This email is already in use. Choose a different email address.'
            : this.apiErrorText(e, 'Could not create the account.');
          errEl.classList.remove('hidden');
        }
      }
    });
  },

  async bulkRemoveSubs() {
    const ids = this.selectedSubs.slice();
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} sub-agency account(s) from the network? This cannot be undone.`)) return;
    let ok = 0;
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await window.API.del(`/agency-control/sub-agencies/${encodeURIComponent(id)}`);
        ok += 1;
      } catch (e) { /* keep going */ }
    }
    this.selectedSubs = [];
    this.showToast(`${ok} of ${ids.length} sub-agencies removed.`);
    await this.refresh();
  },

  async bulkCustomerAccess(status) {
    const ids = this.selectedCustomers.slice();
    if (!ids.length) return;
    try {
      const r = await window.API.post('/agency-control/customers/bulk/access', { ids, status });
      this.selectedCustomers = [];
      this.showToast(`${(r && r.updated) || 0} of ${ids.length} customers set to ${status}.`);
      await this.refresh();
    } catch (e) { this.showError(this.apiErrorText(e, 'Could not update customers.')); }
  },

  async bulkRemoveCustomers() {
    const ids = this.selectedCustomers.slice();
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} customer tenant assignment(s)? The organisation records are kept.`)) return;
    try {
      const r = await window.API.post('/agency-control/customers/bulk/remove', { ids });
      this.selectedCustomers = [];
      this.showToast(`${(r && r.removed) || 0} of ${ids.length} customers removed.`);
      await this.refresh();
    } catch (e) { this.showError(this.apiErrorText(e, 'Could not remove customers.')); }
  },

  esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
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
  showError(msg) {
    const el = document.getElementById('h-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  },
  showToast(message) {
    const el = document.createElement('div');
    el.className = 'fixed bottom-4 right-4 z-50 rounded-lg border border-outline-variant/60 bg-surface-container px-4 py-2 text-body-sm shadow';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  },
  errorPanel(msg) {
    return `<div class="rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-body-sm text-error">${this.esc(msg)}</div>`;
  },
};
