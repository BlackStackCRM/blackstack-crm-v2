/**
 * MOTHER COMPANY CONTROL DASHBOARD — Phase 1 frontend
 *
 * Registered as PageModules.motherCompany and routed at #/mother-company.
 *
 * ACCESS CONTROL IS SERVER-SIDE
 *   This module hides itself from users without a `mother_company.*` permission
 *   so they never see a dead link, but that is only a usability measure. Every
 *   API call it makes is independently refused with 403 by
 *   middleware/motherCompany.js, which does NOT honour the '*' wildcard that
 *   customer-company administrators carry. Reaching this page by typing the URL
 *   gets an empty shell and a 403; it cannot reveal agency data.
 *
 * NO DEMO DATA
 *   Every figure on this page comes from the API. When a database has no
 *   agencies, this renders an explicit empty state — never a placeholder count,
 *   a sample agency, or a fabricated statistic.
 *
 * LICENSING IS MARKED PENDING
 *   The license panel is rendered from `licenses.implemented === false` and says
 *   so plainly. It does not display zeros that would imply licenses are being
 *   tracked and happen to be none.
 */
window.PageModules = window.PageModules || {};

window.PageModules.motherCompany = {
  agencies: [],
  selectedId: null,
  selectedIds: [],
  filters: { search: '', status: '' },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    // Always refresh permissions from the server before rendering.
    // This fixes the stale-session problem: even if the JWT was issued before
    // the MOTHER_COMPANY role/permissions were added to the database, the
    // profile endpoint returns the authoritative current permissions.
    try {
      const profileRes = await fetch('/api/auth/profile', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('crm_token')}` }
      });
      const profile = await profileRes.json();
      if (profile.success) {
        localStorage.setItem('crm_user', JSON.stringify(profile.data));
      }
    } catch {
      // Token expired or invalid — clear session and redirect to login.
      localStorage.removeItem('crm_token');
      localStorage.removeItem('crm_user');
      window.location.href = '/login.html';
      return;
    }

    // A customer-company admin must not even render the shell.
    const perms = this.currentPermissions();
    if (!perms.length) {
      main.innerHTML = `
        <div class="max-w-lg mx-auto mt-12 text-center">
          <span class="material-symbols-outlined text-[40px] text-on-surface-variant/60">shield_lock</span>
          <h1 class="font-display text-h2 text-on-surface mt-4">Mother Company access required</h1>
          <p class="font-body text-body-sm text-on-surface-variant mt-2">
            This area is restricted to accounts explicitly granted Mother Company permissions.
          </p>
        </div>`;
      return () => {};
    }

    main.innerHTML = this.shell();
    this.bind();
    await this.loadDashboard();
    return () => { /* no listeners to detach: all handlers are on inner nodes */ };
  },

  currentPermissions() {
    try {
      const raw = localStorage.getItem('crm_user');
      const user = raw ? JSON.parse(raw) : null;
      const list = (user && user.permissions) || [];
      const perms = Array.isArray(list) ? list.map(String) : [];
      // Mother Company access must come from a named grant. The CRM-wide '*'
      // administrator wildcard must not grant control-plane access.
      if (perms.some((p) => String(p).startsWith('mother_company.'))) {
        return perms;
      }
      return [];
    } catch {
      return [];
    }
  },

  can(code) {
    const perms = this.currentPermissions();
    return perms.includes(code);
  },

  shell() {
    return `
      <div class="flex items-start justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">BlackStack — Mother Company Control</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
            Distribution agency oversight for BlackStack.
          </p>
        </div>
        <button id="mc-refresh" class="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors" aria-label="Refresh">
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">refresh</span>
        </button>
      </div>

      <div id="mc-error" class="hidden mb-stack-md rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-body-sm text-error"></div>

      <div id="mc-bulk-bar" class="hidden mb-stack-md rounded-xl border border-outline-variant/60 bg-surface-container p-stack-sm">
        <div class="flex flex-wrap items-center gap-stack-sm">
          <span class="font-body-sm text-body-sm text-on-surface-variant">Selected <span id="mc-bulk-count">0</span></span>
          <div class="flex gap-stack-sm">
            ${this.can('mother_company.agencies.status') ? `<button id="mc-bulk-activate" class="rounded-lg bg-primary text-on-primary px-3 py-1.5 text-body-sm font-medium">Bulk Activate</button>
            <button id="mc-bulk-suspend" class="rounded-lg border border-outline-variant px-3 py-1.5 text-body-sm">Bulk Suspend</button>` : ''}
            ${this.can('mother_company.agencies.edit') ? `<button id="mc-bulk-remove" class="rounded-lg border border-error/40 text-error px-3 py-1.5 text-body-sm">Bulk Remove</button>` : ''}
          </div>
          <button id="mc-bulk-clear" class="text-body-sm text-on-surface-variant underline ml-auto">Clear selection</button>
        </div>
      </div>

      <div id="mc-stats" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-stack-md mb-stack-lg"></div>

      <div id="mc-licenses" class="mb-stack-lg"></div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-stack-lg">
        <div class="lg:col-span-2">
          <div class="flex flex-wrap items-center gap-stack-sm mb-stack-md">
            <input id="mc-search" type="search" placeholder="Search name, code, contact…"
              class="flex-1 min-w-[200px] bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40" />
            <select id="mc-status" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="TERMINATED">Terminated</option>
            </select>
            ${this.can('mother_company.agencies.create') ? `
              <button id="mc-new" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium hover:opacity-90 transition-opacity">
                New agency
              </button>` : ''}
          </div>
          <div id="mc-agencies"></div>
        </div>

        <div>
          <div id="mc-audit"></div>
        </div>
      </div>

      <div id="mc-modal"></div>
    `;
  },

  bind() {
    const refresh = document.getElementById('mc-refresh');
    if (refresh) refresh.addEventListener('click', () => this.loadDashboard());

    const search = document.getElementById('mc-search');
    if (search) {
      let t;
      search.addEventListener('input', (e) => {
        clearTimeout(t);
        const v = e.target.value;
        t = setTimeout(() => { this.filters.search = v; this.loadAgencies(); }, 250);
      });
    }

    const status = document.getElementById('mc-status');
    if (status) {
      status.addEventListener('change', (e) => {
        this.filters.status = e.target.value;
        this.loadAgencies();
      });
    }

    const create = document.getElementById('mc-new');
    if (create) create.addEventListener('click', () => this.openCreateModal());

    // Bulk actions (parity with agency-control page).
    document.getElementById('mc-bulk-activate')?.addEventListener('click', () => this.bulkStatus('ACTIVE'));
    document.getElementById('mc-bulk-suspend')?.addEventListener('click', () => this.bulkStatus('SUSPENDED'));
    document.getElementById('mc-bulk-remove')?.addEventListener('click', () => this.bulkRemove());
    document.getElementById('mc-bulk-clear')?.addEventListener('click', () => { this.selectedIds = []; this.renderAgencies(); });
  },

  // ── data ───────────────────────────────────────────────────────────────────

  async loadDashboard() {
    try {
      const d = await window.API.get('/mother-company/dashboard');
      this.renderStats(d.stats);
      this.renderLicenses(d.licenses);
    } catch (e) {
      this.showError(this.describe(e));
    }
    await this.loadAgencies();
    await this.loadAudit();
  },

  async loadAgencies() {
    const host = document.getElementById('mc-agencies');
    if (!host) return;
    try {
      const params = new URLSearchParams();
      if (this.filters.search) params.set('search', this.filters.search);
      if (this.filters.status) params.set('status', this.filters.status);
      const q = params.toString();
      const res = await window.API.get(`/mother-company/agencies${q ? `?${q}` : ''}`);
      this.agencies = res.agencies || [];
      this.renderAgencies();
    } catch (e) {
      host.innerHTML = this.errorPanel(this.describe(e));
    }
  },

  async loadAudit() {
    const host = document.getElementById('mc-audit');
    if (!host) return;
    if (!this.can('mother_company.audit.view')) { host.innerHTML = ''; return; }
    try {
      const res = await window.API.get('/mother-company/audit');
      this.renderAudit(res.entries || []);
    } catch (e) {
      host.innerHTML = this.errorPanel(this.describe(e));
    }
  },

  // ── rendering ──────────────────────────────────────────────────────────────

  describe(e) {
    if (!e) return 'Request failed.';
    if (e.status === 403) return 'Mother Company access is required for this action.';
    if (e.status === 401) return 'Your session has expired. Please sign in again.';
    // Surface the server's per-field validation detail (error.body.error.fields)
    // instead of the generic banner — mirrors agency-control.js apiErrorText().
    const payload = e.body && e.body.error;
    if (payload) {
      const fields = payload.fields && typeof payload.fields === 'object'
        ? Object.entries(payload.fields).map(([k, v]) => `${k}: ${v}`).join(' — ')
        : '';
      if (fields) return `${payload.message} — ${fields}`;
      if (payload.message) return payload.message;
    }
    return e.message || 'Request failed.';
  },

  showError(msg) {
    const el = document.getElementById('mc-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  clearError() {
    const el = document.getElementById('mc-error');
    if (el) el.classList.add('hidden');
  },

  errorPanel(msg) {
    return `<div class="rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-body-sm text-error">${this.esc(msg)}</div>`;
  },

  statCard(label, value, icon) {
    return `
      <div class="rounded-xl bg-surface-container-low border border-outline-variant/40 px-4 py-4">
        <div class="flex items-center gap-2 text-on-surface-variant">
          <span class="material-symbols-outlined text-[18px]">${icon}</span>
          <span class="text-body-sm">${this.esc(label)}</span>
        </div>
        <p class="font-display text-h2 text-on-surface mt-2">${value}</p>
      </div>`;
  },

  renderStats(s) {
    const host = document.getElementById('mc-stats');
    if (!host || !s) return;
    host.innerHTML = [
      this.statCard('Distribution agencies', s.totalAgencies, 'corporate_fare'),
      this.statCard('Active', s.activeAgencies, 'verified'),
      this.statCard('Pending activation', s.pendingAgencies, 'pending'),
      this.statCard('Agency administrators', s.activeAdministrators, 'group'),
    ].join('');
  },

  renderLicenses(l) {
    const host = document.getElementById('mc-licenses');
    if (!host || !l) return;

    if (l.implemented === false) {
      // Honest empty state. Zeros here would imply the system tracks licenses
      // and currently has none, which is a different and false claim.
      host.innerHTML = `
        <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low px-4 py-4">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px] text-on-surface-variant">key_off</span>
            <h2 class="font-display text-h3 text-on-surface">License allocation</h2>
            <span class="ml-2 px-2 py-0.5 rounded-full text-[11px] font-medium bg-warning/15 text-warning border border-warning/30">
              Pending
            </span>
          </div>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-2">
            ${this.esc(l.reason || 'Not yet available.')}
          </p>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
            No license, entitlement or device figures are shown because none are tracked yet.
          </p>
        </div>`;
      return;
    }

    host.innerHTML = `
      <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low px-4 py-4">
        <h2 class="font-display text-h3 text-on-surface">License allocation</h2>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-2">
          ${this.esc(l.reason || 'Managed centrally.')}
        </p>
      </div>`;
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

  renderAgencies() {
    const host = document.getElementById('mc-agencies');
    if (!host) return;

    if (!this.agencies.length) {
      // Empty state, not sample rows.
      host.innerHTML = `
        <div class="rounded-xl border border-dashed border-outline-variant/50 px-6 py-10 text-center">
          <span class="material-symbols-outlined text-[32px] text-on-surface-variant/50">domain_disabled</span>
          <p class="font-body text-body-sm text-on-surface-variant mt-3">No distribution agencies yet.</p>
          ${this.can('mother_company.agencies.create')
            ? '<p class="font-body-sm text-body-sm text-on-surface-variant/80 mt-1">Use “New agency” to create the first one.</p>'
            : ''}
        </div>`;
      return;
    }

    const canStatus = this.can('mother_company.agencies.status');
    const canAdmins = this.can('mother_company.agencies.admins.manage');
    const canEdit = this.can('mother_company.agencies.edit');
    const allSelected = this.agencies.length > 0 && this.agencies.every((a) => this.selectedIds.includes(a.id));

    host.innerHTML = `
      <div class="rounded-xl border border-outline-variant/40">
        <table class="w-full text-left">
          <thead class="bg-surface-container-low text-on-surface-variant text-body-sm rounded-t-xl">
            <tr>
              <th class="px-4 py-3 rounded-tl-xl"><input type="checkbox" id="mc-select-all" ${allSelected ? 'checked' : ''} /></th>
              <th class="px-4 py-3 font-medium">Code</th>
              <th class="px-4 py-3 font-medium">Company</th>
              <th class="px-4 py-3 font-medium">Contact</th>
              <th class="px-4 py-3 font-medium">Status</th>
              <th class="px-4 py-3 font-medium text-right rounded-tr-xl">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${this.agencies.map((a) => `
              <tr class="border-t border-outline-variant/30 text-body-sm">
                <td class="px-4 py-3"><input type="checkbox" data-mc-select="${this.esc(a.id)}" ${this.selectedIds.includes(a.id) ? 'checked' : ''} /></td>
                <td class="px-4 py-3 font-mono text-on-surface">${this.esc(a.agencyCode)}</td>
                <td class="px-4 py-3 text-on-surface">${this.esc(a.name)}</td>
                <td class="px-4 py-3 text-on-surface-variant">
                  ${a.contactName ? this.esc(a.contactName) : '<span class="opacity-60">—</span>'}
                  ${a.contactEmail ? `<br><span class="text-[12px] opacity-80">${this.esc(a.contactEmail)}</span>` : ''}
                </td>
                <td class="px-4 py-3">${this.badge(a.status)}</td>
                <td class="px-4 py-3 text-right">
                  <div class="relative inline-block text-left">
                    <button data-mc-actions="${this.esc(a.id)}" class="rounded border border-outline-variant px-2 py-1 text-body-sm">Actions</button>
                    <div data-mc-menu="${this.esc(a.id)}" class="hidden absolute right-0 mt-2 w-48 rounded-lg border border-outline-variant/40 bg-surface-container shadow-lg z-50">
                      <button data-action="view" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-surface-container-high">View Details</button>
                      ${canEdit ? `<button data-action="edit" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-surface-container-high">Edit</button>` : ''}
                      ${canAdmins ? `<button data-action="add-admin" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-surface-container-high">Add Admin</button>` : ''}
                      ${canAdmins ? `<button data-action="reset-password" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm hover:bg-surface-container-high">Reset Admin Password</button>` : ''}
                      ${canStatus && a.status !== 'ACTIVE' && a.status !== 'TERMINATED' ? `<button data-action="activate" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm text-success hover:bg-surface-container-high">Activate</button>` : ''}
                      ${canStatus && a.status === 'ACTIVE' ? `<button data-action="suspend" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm text-error hover:bg-surface-container-high">Suspend</button>` : ''}
                      ${canEdit ? `<button data-action="remove" data-id="${this.esc(a.id)}" class="block w-full text-left px-3 py-2 text-body-sm text-error hover:bg-surface-container-high">Remove</button>` : ''}
                    </div>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    this.updateBulkBar();
    this.attachAgencyActions();
  },

  updateBulkBar() {
    const bar = document.getElementById('mc-bulk-bar');
    const countEl = document.getElementById('mc-bulk-count');
    if (!bar || !countEl) return;
    const count = this.selectedIds.length;
    countEl.textContent = String(count);
    bar.classList.toggle('hidden', count === 0);
  },

  attachAgencyActions() {
    const host = document.getElementById('mc-agencies');
    if (!host) return;
    host.querySelectorAll('[data-mc-actions]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-mc-actions');
        const menu = host.querySelector(`[data-mc-menu="${id}"]`);
        if (!menu) return;
        const isOpen = !menu.classList.contains('hidden');
        host.querySelectorAll('[data-mc-menu]').forEach((m) => m.classList.add('hidden'));
        if (!isOpen) {
          // Viewport-aware: if the menu would open below the fold (last table
          // row near the page bottom), flip it upward so it is fully visible.
          const rect = btn.getBoundingClientRect();
          const menuH = 220; // approx height of the 7-item menu
          if (rect.bottom + menuH > window.innerHeight - 8) {
            menu.classList.remove('mt-2');
            menu.classList.add('bottom-full', 'mb-2');
          } else {
            menu.classList.add('mt-2');
            menu.classList.remove('bottom-full', 'mb-2');
          }
          menu.classList.remove('hidden');
        }
      });
    });
    host.querySelectorAll('[data-action]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        const id = item.getAttribute('data-id');
        host.querySelectorAll('[data-mc-menu]').forEach((m) => m.classList.add('hidden'));
        if (action === 'view') this.openDetail(id);
        else if (action === 'edit') this.openEditModal(id);
        else if (action === 'add-admin') this.openAdminModal(id);
        else if (action === 'reset-password') this.openResetPasswordModal(id);
        else if (action === 'activate') this.changeStatus(id, 'ACTIVE');
        else if (action === 'suspend') this.changeStatus(id, 'SUSPENDED');
        else if (action === 'remove') this.removeAgency(id);
      });
    });
    host.querySelectorAll('[data-mc-select]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.getAttribute('data-mc-select');
        if (!id) return;
        if (box.checked) {
          if (!this.selectedIds.includes(id)) this.selectedIds.push(id);
        } else {
          this.selectedIds = this.selectedIds.filter((x) => x !== id);
        }
        this.updateBulkBar();
      });
    });
    document.getElementById('mc-select-all')?.addEventListener('change', (e) => {
      this.selectedIds = e.target.checked ? this.agencies.map((a) => a.id) : [];
      this.renderAgencies();
    });
    document.addEventListener('click', () => {
      host.querySelectorAll('[data-mc-menu]').forEach((m) => m.classList.add('hidden'));
    });
  },

  async bulkStatus(status) {
    const ids = this.selectedIds.slice();
    if (!ids.length) return;
    let reason;
    if (status === 'SUSPENDED') {
      // eslint-disable-next-line no-alert
      reason = window.prompt('Reason for suspension (applies to all selected, required):');
      if (!reason || !reason.trim()) return;
    }
    let ok = 0;
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await window.API.post(`/mother-company/agencies/${id}/status`, { status, reason: reason || 'Bulk action by Mother Company operator' });
        ok += 1;
      } catch (e) { /* keep going; report the count */ }
    }
    this.selectedIds = [];
    this.showToast(`${ok} of ${ids.length} agencies set to ${status}.`);
    await this.loadDashboard();
  },

  async bulkRemove() {
    const ids = this.selectedIds.slice();
    if (!ids.length) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`WARNING: This will permanently delete ${ids.length} selected agencies and ALL related data (admins, customers, history). This cannot be undone. Continue?`)) return;
    let ok = 0;
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await window.API.del(`/mother-company/agencies/${id}`);
        ok += 1;
      } catch (e) { /* keep going */ }
    }
    this.selectedIds = [];
    this.showToast(`${ok} of ${ids.length} agencies permanently deleted.`);
    await this.loadDashboard();
  },

  showToast(message) {
    const el = document.createElement('div');
    el.className = 'fixed bottom-4 right-4 z-50 rounded-lg border border-outline-variant/60 bg-surface-container px-4 py-2 text-body-sm shadow';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  },

  async removeAgency(id) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('WARNING: This will permanently delete the agency and ALL related data (admins, customers, history). This cannot be undone. Are you sure?')) return;
    try {
      await window.API.del(`/mother-company/agencies/${id}`);
      this.selectedIds = this.selectedIds.filter((x) => x !== id);
      this.showToast('Agency permanently deleted.');
      await this.loadDashboard();
    } catch (e) {
      const msg = this.describe(e);
      const fkMsg = /foreign key|constraint|RESTRICT|Cannot delete/i.test(msg)
        ? 'Cannot delete because related records exist. Remove assigned customers or parent/child links first.'
        : msg;
      this.showError(fkMsg);
    }
  },

  // ── edit / reset-password modals (parity with agency-control page) ────────

  openEditModal(agencyId) {
    const agency = this.agencies.find((a) => a.id === agencyId) || null;
    const host = document.getElementById('mc-modal');
    if (!host) return;
    host.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="w-full max-w-2xl rounded-xl bg-surface-container p-6 border border-outline-variant/40">
          <h2 class="font-display text-h3 text-on-surface">Edit agency</h2>
          <div id="mc-edit-error" class="hidden mt-3 text-body-sm text-error"></div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            ${this.field('mc-e-name', 'Company name', agency ? agency.name : '', true)}
            ${this.field('mc-e-legalname', 'Legal name', agency ? (agency.legalName || '') : '')}
            ${this.field('mc-e-cname', 'Contact name', agency ? (agency.contactName || '') : '')}
            ${this.field('mc-e-cemail', 'Contact email', agency ? (agency.contactEmail || '') : '')}
            ${this.field('mc-e-phone', 'Contact phone', agency ? (agency.contactPhone || '') : '')}
            ${this.field('mc-e-address', 'Address', agency ? (agency.address || '') : '')}
            ${this.field('mc-e-city', 'City', agency ? (agency.city || '') : '')}
            ${this.field('mc-e-state', 'State', agency ? (agency.state || '') : '')}
            ${this.field('mc-e-pincode', 'Pincode', agency ? (agency.pincode || '') : '')}
          </div>
          <div class="mt-3">
            ${this.textarea('mc-e-notes', 'Notes', agency ? (agency.notes || '') : '')}
          </div>
          <div class="flex justify-end gap-2 mt-6">
            <button id="mc-e-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
            <button id="mc-e-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Save</button>
          </div>
        </div>
      </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('mc-e-cancel').addEventListener('click', close);
    document.getElementById('mc-e-save').addEventListener('click', async () => {
      const errEl = document.getElementById('mc-edit-error');
      const val = (id) => (document.getElementById(id) || {}).value || '';
      const payload = {
        name: val('mc-e-name').trim(),
        legal_name: val('mc-e-legalname').trim(),
        contact_name: val('mc-e-cname').trim(),
        contact_email: val('mc-e-cemail').trim(),
        contact_phone: val('mc-e-phone').trim(),
        address: val('mc-e-address').trim(),
        city: val('mc-e-city').trim(),
        state: val('mc-e-state').trim(),
        pincode: val('mc-e-pincode').trim(),
        notes: val('mc-e-notes').trim(),
      };
      try {
        await window.API.patch(`/mother-company/agencies/${encodeURIComponent(agencyId)}`, payload);
        close();
        this.showToast('Agency updated successfully.');
        await this.loadDashboard();
      } catch (e) {
        if (errEl) { errEl.textContent = this.describe(e); errEl.classList.remove('hidden'); }
      }
    });
  },

  openResetPasswordModal(agencyId) {
    const host = document.getElementById('mc-modal');
    if (!host) return;
    host.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
          <h2 class="font-display text-h3 text-on-surface">Reset administrator password</h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Set a new temporary password for the agency administrator.</p>
          <div id="mc-reset-error" class="hidden mt-3 text-body-sm text-error"></div>
          <div class="grid grid-cols-1 gap-3 mt-4">
            ${this.field('mc-r-pass', 'New temporary password', 'Min 10 characters', true)}
          </div>
          <div class="flex justify-end gap-2 mt-6">
            <button id="mc-r-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
            <button id="mc-r-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Reset</button>
          </div>
        </div>
      </div>`;
    const close = () => { host.innerHTML = ''; };
    document.getElementById('mc-r-cancel').addEventListener('click', close);
    document.getElementById('mc-r-save').addEventListener('click', async () => {
      const errEl = document.getElementById('mc-reset-error');
      const password = (document.getElementById('mc-r-pass') || {}).value || '';
      try {
        // The agency_administrators row stores the password hash against the
        // linked user; the mother-company service exposes admin updates via
        // the administrators PATCH endpoint. Find the ACTIVE admin first.
        const adminsRes = await window.API.get(`/mother-company/agencies/${encodeURIComponent(agencyId)}/administrators`);
        const admins = (adminsRes && adminsRes.administrators) || [];
        const active = admins.find((x) => x.status === 'ACTIVE') || admins[0];
        if (!active) throw new Error('No agency administrator to reset. Assign one first.');
        await window.API.post(`/agency-control/sub-agencies/${encodeURIComponent(agencyId)}/reset-password`, { password });
        close();
        this.showToast('Administrator password has been reset.');
      } catch (e) {
        if (errEl) { errEl.textContent = this.describe(e); errEl.classList.remove('hidden'); }
      }
    });
  },

  renderAudit(entries) {
    const host = document.getElementById('mc-audit');
    if (!host) return;
    if (!entries.length) {
      host.innerHTML = `
        <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low px-4 py-4">
          <h2 class="font-display text-h3 text-on-surface">Action history</h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-2">No privileged actions recorded yet.</p>
        </div>`;
      return;
    }
    host.innerHTML = `
      <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low px-4 py-4">
        <h2 class="font-display text-h3 text-on-surface mb-3">Action history</h2>
        <ul class="space-y-2">
          ${entries.slice(0, 25).map((e) => `
            <li class="text-[12px] text-on-surface-variant border-b border-outline-variant/20 pb-2 last:border-0">
              <span class="font-medium text-on-surface">${this.esc(e.action)}</span>
              <span class="opacity-70">${this.esc(String(e.createdAt || '').slice(0, 19))}</span>
            </li>`).join('')}
        </ul>
      </div>`;
  },

  // ── modals ─────────────────────────────────────────────────────────────────

  openCreateModal() {
    const host = document.getElementById('mc-modal');
    if (!host) return;
    host.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
          <h2 class="font-display text-h3 text-on-surface">New distribution agency</h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
            The agency gets its own company record and starts in PENDING status.
          </p>
          <div id="mc-form-error" class="hidden mt-3 text-body-sm text-error"></div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            ${this.field('mc-f-code', 'Agency code', '', false, 'Auto-generated if left blank')}
            ${this.field('mc-f-name', 'Company name', '', true, 'Required')}
            ${this.field('mc-f-legalname', 'Legal name', '', false, 'Optional')}
            ${this.field('mc-f-cname', 'Contact name', '', false, 'Optional')}
            ${this.field('mc-f-cemail', 'Contact email', '', false, 'name@agency.com')}
            ${this.field('mc-f-phone', 'Contact phone', '', false, '+91 …')}
            ${this.field('mc-f-city', 'City', '', false, 'Optional')}
            ${this.field('mc-f-pincode', 'Pincode', '', false, 'Optional')}
          </div>
          <div class="mt-3">
            ${this.textarea('mc-f-notes', 'Notes', 'Optional')}
          </div>
          <div class="flex justify-end gap-2 mt-6">
            <button id="mc-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
            <button id="mc-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Create agency</button>
          </div>
        </div>
      </div>`;

    const close = () => { host.innerHTML = ''; };
    document.getElementById('mc-cancel').addEventListener('click', close);
    document.getElementById('mc-save').addEventListener('click', () => this.submitCreate(close));
  },

  /** Input field. The 3rd argument is the CURRENT VALUE (rendered into
   *  value=), not a placeholder — the edit modal previously passed the
   *  agency's existing values here and they rendered as grey placeholder
   *  text, so the inputs were actually empty and Save always failed
   *  validation with "Company name is required.". `placeholder` is now the
   *  4th argument and stays a hint. */
  field(id, label, value, required, placeholder = '') {
    return `
      <label class="block">
        <span class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(label)}${required ? ' *' : ''}</span>
        <input id="${id}" type="text" value="${this.esc(value ?? '')}" placeholder="${this.esc(placeholder)}"
          class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40" />
      </label>`;
  },

  textarea(id, label, value, required, placeholder = '') {
    return `
      <label class="block">
        <span class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(label)}${required ? ' *' : ''}</span>
        <textarea id="${id}" placeholder="${this.esc(placeholder)}" rows="3"
          class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">${this.esc(value ?? '')}</textarea>
      </label>`;
  },

  async submitCreate(close) {
    const errEl = document.getElementById('mc-form-error');
    const val = (id) => (document.getElementById(id) || {}).value || '';
    const payload = {
      agency_code: val('mc-f-code').trim() || ('AGY-' + Date.now().toString(36).toUpperCase()),
      name: val('mc-f-name').trim(),
      legal_name: val('mc-f-legalname').trim(),
      contact_name: val('mc-f-cname').trim(),
      contact_email: val('mc-f-cemail').trim(),
      contact_phone: val('mc-f-phone').trim(),
      city: val('mc-f-city').trim(),
      pincode: val('mc-f-pincode').trim(),
      notes: val('mc-f-notes').trim(),
    };

    try {
      await window.API.post('/mother-company/agencies', payload);
      close();
      this.clearError();
      await this.loadDashboard();
    } catch (e) {
      // Prefer the server's per-field message; it knows which field failed.
      const fields = (e && e.body && e.body.error && e.body.error.fields) || (e && e.fields) || null;
      const msg = fields
        ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(' · ')
        : this.describe(e);
      if (errEl) {
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
      }
    }
  },

  async changeStatus(id, status) {
    let reason;
    if (status === 'SUSPENDED') {
      // eslint-disable-next-line no-alert
      reason = window.prompt('Reason for suspension (required):');
      if (!reason || !reason.trim()) return;
    }
    try {
      await window.API.post(`/mother-company/agencies/${id}/status`, { status, reason });
      this.clearError();
      await this.loadDashboard();
    } catch (e) {
      this.showError(this.describe(e));
    }
  },

  async openDetail(id) {
    const host = document.getElementById('mc-modal');
    if (!host) return;
    try {
      const d = await window.API.get(`/mother-company/agencies/${id}`);
      const a = d.agency;
      host.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div class="w-full max-w-2xl rounded-xl bg-surface-container p-6 border border-outline-variant/40 max-h-[85vh] overflow-y-auto">
            <div class="flex items-start justify-between">
              <div>
                <h2 class="font-display text-h3 text-on-surface">${this.esc(a.name)}</h2>
                <p class="font-mono text-body-sm text-on-surface-variant mt-1">${this.esc(a.agencyCode)} ${this.badge(a.status)}</p>
              </div>
              <button id="mc-d-close" class="material-symbols-outlined text-on-surface-variant hover:text-on-surface">close</button>
            </div>

            <dl class="grid grid-cols-2 gap-3 mt-5 text-body-sm">
              ${this.row('Contact', a.contactName)}${this.row('Email', a.contactEmail)}
              ${this.row('Phone', a.contactPhone)}${this.row('City', a.city)}
              ${this.row('Created', String(a.createdAt || '').slice(0, 19))}${this.row('Activated', String(a.activatedAt || '').slice(0, 19))}
            </dl>

            <h3 class="font-display text-h3 text-on-surface mt-6">Administrators</h3>
            ${(d.administrators || []).length
              ? `<ul class="mt-2 space-y-1 text-body-sm text-on-surface-variant">
                   ${d.administrators.map((x) => `<li>${this.esc(x.fullName || '')} — ${this.esc(x.email || '')} ${this.badge(x.status)}</li>`).join('')}
                 </ul>`
              : '<p class="mt-2 text-body-sm text-on-surface-variant">No administrators assigned yet.</p>'}

            <h3 class="font-display text-h3 text-on-surface mt-6">Status history</h3>
            <ul class="mt-2 space-y-1 text-body-sm text-on-surface-variant">
              ${(d.statusHistory || []).map((h) => `
                <li>${this.esc(h.fromStatus || 'CREATED')} → ${this.esc(h.toStatus)} <span class="opacity-70">${this.esc(String(h.changedAt || '').slice(0, 19))}</span></li>`).join('')
                || '<li class="opacity-70">No transitions recorded.</li>'}
            </ul>

            <div class="flex justify-end mt-6">
              <button id="mc-d-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Close</button>
            </div>
          </div>
        </div>`;
      const close = () => { host.innerHTML = ''; };
      document.getElementById('mc-d-close').addEventListener('click', close);
      document.getElementById('mc-d-cancel').addEventListener('click', close);
    } catch (e) {
      this.showError(this.describe(e));
    }
  },

  row(label, value) {
    return `
      <div>
        <dt class="text-on-surface-variant">${this.esc(label)}</dt>
        <dd class="text-on-surface">${value ? this.esc(String(value)) : '<span class="opacity-50">—</span>'}</dd>
      </div>`;
  },

  openAdminModal(agencyId) {
    const host = document.getElementById('mc-modal');
    if (!host) return;
    host.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="w-full max-w-lg rounded-xl bg-surface-container p-6 border border-outline-variant/40">
          <h2 class="font-display text-h3 text-on-surface">Assign agency administrator</h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
            Creates a login in the agency's own company. The password is never displayed after saving.
          </p>
          <div id="mc-admin-error" class="hidden mt-3 text-body-sm text-error"></div>
          <div class="grid grid-cols-1 gap-3 mt-4">
            ${this.field('mc-a-name', 'Full name', '', true, 'Required')}
            ${this.field('mc-a-email', 'Email', '', true, 'admin@agency.com')}
            ${this.field('mc-a-pass', 'Temporary password', '', true, 'Min 10 characters')}
          </div>
          <div class="flex justify-end gap-2 mt-6">
            <button id="mc-a-cancel" class="px-4 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container">Cancel</button>
            <button id="mc-a-save" class="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-medium">Assign</button>
          </div>
        </div>
      </div>`;

    const close = () => { host.innerHTML = ''; };
    document.getElementById('mc-a-cancel').addEventListener('click', close);
    document.getElementById('mc-a-save').addEventListener('click', async () => {
      const errEl = document.getElementById('mc-admin-error');
      const val = (id) => (document.getElementById(id) || {}).value || '';
      try {
        await window.API.post(`/mother-company/agencies/${agencyId}/administrators`, {
          full_name: val('mc-a-name').trim(),
          email: val('mc-a-email').trim(),
          password: val('mc-a-pass'),
        });
        close();
        await this.loadDashboard();
      } catch (e) {
        // FIX (MC-assign UX): map backend conflict states to actionable,
        // user-friendly messages instead of the raw Supabase error text
        // ("A user with that email address already exists.").
        const raw = (e && e.body && e.body.error && e.body.error.message) || (e && e.message) || '';
        let friendly;
        if (e && e.status === 409) {
          friendly = 'This email is already registered to another agency. Please use a different email or contact support.';
        } else if (/already an administrator/i.test(raw)) {
          friendly = 'This user is already an administrator for this agency.';
        } else if (/already exists/i.test(raw) && /email/i.test(raw)) {
          friendly = 'This email is already registered to another agency. Please use a different email or contact support.';
        } else {
          friendly = this.describe(e);
        }
        if (errEl) {
          errEl.textContent = friendly;
          errEl.classList.remove('hidden');
        }
      }
    });
  },

  esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
};
