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
  filters: { search: '', status: '' },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

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
      return Array.isArray(list) ? list.filter((p) => String(p).startsWith('mother_company.')) : [];
    } catch {
      return [];
    }
  },

  can(code) {
    return this.currentPermissions().includes(code);
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

    host.innerHTML = `
      <div class="rounded-xl border border-outline-variant/40 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-surface-container-low text-on-surface-variant text-body-sm">
            <tr>
              <th class="px-4 py-3 font-medium">Code</th>
              <th class="px-4 py-3 font-medium">Company</th>
              <th class="px-4 py-3 font-medium">Contact</th>
              <th class="px-4 py-3 font-medium">Status</th>
              <th class="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${this.agencies.map((a) => `
              <tr class="border-t border-outline-variant/30 text-body-sm">
                <td class="px-4 py-3 font-mono text-on-surface">${this.esc(a.agencyCode)}</td>
                <td class="px-4 py-3 text-on-surface">${this.esc(a.name)}</td>
                <td class="px-4 py-3 text-on-surface-variant">
                  ${a.contactName ? this.esc(a.contactName) : '<span class="opacity-60">—</span>'}
                  ${a.contactEmail ? `<br><span class="text-[12px] opacity-80">${this.esc(a.contactEmail)}</span>` : ''}
                </td>
                <td class="px-4 py-3">${this.badge(a.status)}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap">
                  <button data-mc-view="${this.esc(a.id)}" class="text-secondary hover:underline">Details</button>
                  ${canStatus && a.status !== 'ACTIVE' && a.status !== 'TERMINATED'
                    ? `<button data-mc-activate="${this.esc(a.id)}" class="ml-3 text-success hover:underline">Activate</button>` : ''}
                  ${canStatus && a.status === 'ACTIVE'
                    ? `<button data-mc-suspend="${this.esc(a.id)}" class="ml-3 text-error hover:underline">Suspend</button>` : ''}
                  ${canAdmins ? `<button data-mc-admin="${this.esc(a.id)}" class="ml-3 text-secondary hover:underline">Admins</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    host.querySelectorAll('[data-mc-view]').forEach((b) => b.addEventListener('click', () => this.openDetail(b.dataset.mcView)));
    host.querySelectorAll('[data-mc-activate]').forEach((b) => b.addEventListener('click', () => this.changeStatus(b.dataset.mcActivate, 'ACTIVE')));
    host.querySelectorAll('[data-mc-suspend]').forEach((b) => b.addEventListener('click', () => this.changeStatus(b.dataset.mcSuspend, 'SUSPENDED')));
    host.querySelectorAll('[data-mc-admin]').forEach((b) => b.addEventListener('click', () => this.openAdminModal(b.dataset.mcAdmin)));
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
            ${this.field('mc-f-code', 'Agency code', 'e.g. AGY-001', true)}
            ${this.field('mc-f-name', 'Company name', 'Required', true)}
            ${this.field('mc-f-cname', 'Contact name', 'Optional')}
            ${this.field('mc-f-cemail', 'Contact email', 'name@agency.com')}
            ${this.field('mc-f-phone', 'Contact phone', '+91 …')}
            ${this.field('mc-f-city', 'City', 'Optional')}
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

  field(id, label, placeholder, required) {
    return `
      <label class="block">
        <span class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(label)}${required ? ' *' : ''}</span>
        <input id="${id}" type="text" placeholder="${this.esc(placeholder)}"
          class="mt-1 w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40" />
      </label>`;
  },

  async submitCreate(close) {
    const errEl = document.getElementById('mc-form-error');
    const val = (id) => (document.getElementById(id) || {}).value || '';
    const payload = {
      agency_code: val('mc-f-code').trim(),
      name: val('mc-f-name').trim(),
      contact_name: val('mc-f-cname').trim(),
      contact_email: val('mc-f-cemail').trim(),
      contact_phone: val('mc-f-phone').trim(),
      city: val('mc-f-city').trim(),
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
            ${this.field('mc-a-name', 'Full name', 'Required', true)}
            ${this.field('mc-a-email', 'Email', 'admin@agency.com', true)}
            ${this.field('mc-a-pass', 'Temporary password', 'Min 10 characters', true)}
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
        if (errEl) {
          errEl.textContent = this.describe(e);
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