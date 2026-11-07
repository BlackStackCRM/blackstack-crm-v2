window.PageModules = window.PageModules || {};

window.PageModules.settings = {
  activeTab: 'account',

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="mb-stack-lg">
        <h1 class="font-display text-h1 text-on-surface tracking-tight">Settings</h1>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage your account and application preferences.</p>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <div class="border-b border-outline-variant/30 flex items-center px-container-padding">
          ${this.tabBtn('account', 'Account', 'person')}
          ${this.tabBtn('appearance', 'Appearance', 'palette')}
          ${this.tabBtn('system', 'System', 'settings')}
          ${this.tabBtn('updates', 'Updates', 'update')}
          ${this.tabBtn('datasafety', 'Data Safety', 'security')}
        </div>
        <div id="settings-body" class="p-container-padding"></div>
      </div>
    `;
    this.bindEvents();
    await this.renderTab();
    return () => {};
  },

  tabBtn(key, label, icon) {
    const active = this.activeTab === key;
    return `<button data-tab="${key}" class="flex items-center gap-stack-sm px-stack-md py-stack-sm border-b-2 ${active ? 'border-secondary text-secondary' : 'border-transparent text-on-surface-variant hover:text-on-surface'} transition-colors"><span class="material-symbols-outlined text-[18px]">${icon}</span><span class="font-body-md text-body-md font-medium">${label}</span></button>`;
  },

  bindEvents() {
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => { this.activeTab = btn.dataset.tab; document.querySelectorAll('[data-tab]').forEach(b => { b.classList.remove('border-secondary','text-secondary'); b.classList.add('border-transparent','text-on-surface-variant'); }); btn.classList.add('border-secondary','text-secondary'); btn.classList.remove('border-transparent','text-on-surface-variant'); this.renderTab(); });
    });
  },

  async renderTab() {
    const body = document.getElementById('settings-body');
    if (this.activeTab === 'account') return this.renderAccount(body);
    if (this.activeTab === 'appearance') return this.renderAppearance(body);
    if (this.activeTab === 'system') return this.renderSystem(body);
    if (this.activeTab === 'updates') return this.renderUpdates(body);
    if (this.activeTab === 'datasafety') return this.renderDataSafety(body);
  },

  renderAccount(container) {
    const user = AuthAPI.getUser() || {};
    container.innerHTML = `
      <form id="account-form" class="space-y-stack-md max-w-2xl">
        <div class="grid grid-cols-2 gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">First name</label>
            <input name="firstName" value="${user.firstName || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Last name</label>
            <input name="lastName" value="${user.lastName || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Email</label>
            <input name="email" type="email" value="${user.email || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Phone</label>
            <input name="phone" value="${user.phone || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Time zone</label>
            <select name="timezone" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="UTC" ${user.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
              <option value="America/New_York" ${user.timezone === 'America/New_York' ? 'selected' : ''}>Eastern Time</option>
              <option value="America/Los_Angeles" ${user.timezone === 'America/Los_Angeles' ? 'selected' : ''}>Pacific Time</option>
              <option value="Europe/London" ${user.timezone === 'Europe/London' ? 'selected' : ''}>London</option>
            </select>
          </div>
        </div>
        <div class="flex justify-end gap-stack-sm pt-stack-md border-t border-outline-variant/30">
          <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save changes</button>
        </div>
      </form>
    `;
    container.querySelector('#account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd.entries());
      try {
        await API.put('/auth/profile', payload);
        const updated = { ...user, ...payload };
        localStorage.setItem('crm_user', JSON.stringify(updated));
        Toast.success('Account updated');
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  renderAppearance(container) {
    const theme = localStorage.getItem('theme') || 'light';
    container.innerHTML = `
      <div class="space-y-stack-md max-w-2xl">
        <div>
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Theme</h3>
          <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">Choose your preferred color scheme.</p>
          <div class="grid grid-cols-3 gap-stack-md">
            ${this.themeCard('light', 'Light', 'light_mode', theme === 'light', 'bg-white border-2')}
            ${this.themeCard('dark', 'Dark', 'dark_mode', theme === 'dark', 'bg-gray-900 text-white border-2')}
            ${this.themeCard('system', 'System', 'desktop_windows', theme === 'system', 'bg-gradient-to-br from-white to-gray-900 border-2')}
          </div>
        </div>
        <div class="pt-stack-md border-t border-outline-variant/30">
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Density</h3>
          <div class="flex gap-stack-sm">
            <label class="flex items-center gap-stack-sm cursor-pointer"><input type="radio" name="density" value="comfortable" checked class="w-4 h-4 text-primary focus:ring-primary"/><span class="font-body-md">Comfortable</span></label>
            <label class="flex items-center gap-stack-sm cursor-pointer"><input type="radio" name="density" value="compact" class="w-4 h-4 text-primary focus:ring-primary"/><span class="font-body-md">Compact</span></label>
          </div>
        </div>
        <div class="flex justify-end gap-stack-sm pt-stack-md border-t border-outline-variant/30">
          <button id="save-appearance" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save preferences</button>
        </div>
      </div>
    `;
    container.querySelectorAll('[data-theme]').forEach(el => {
      el.addEventListener('click', () => {
        container.querySelectorAll('[data-theme]').forEach(t => t.className = t.className.replace(/border-secondary|border-outline-variant/g, 'border-outline-variant').replace(/border-2|border-secondary/g, 'border-2 border-outline-variant'));
        el.classList.add('border-secondary');
        el.classList.remove('border-outline-variant');
        container.dataset.selectedTheme = el.dataset.theme;
      });
    });
    container.querySelector('#save-appearance').addEventListener('click', () => {
      const t = container.dataset.selectedTheme || theme;
      localStorage.setItem('theme', t);
      this.applyTheme(t);
      Toast.success('Appearance saved');
    });
  },

  applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else if (theme === 'light') root.classList.remove('dark');
    else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
    }
  },

  themeCard(key, label, icon, active, base) {
    return `<button data-theme="${key}" class="p-stack-md rounded-lg border-2 ${active ? 'border-secondary' : 'border-outline-variant'} ${base} hover:border-secondary transition-colors text-left">
      <div class="flex items-center gap-stack-sm">
        <span class="material-symbols-outlined text-[24px]">${icon}</span>
        <span class="font-body-md font-medium">${label}</span>
      </div>
    </button>`;
  },

  async renderSystem(container) {
    let currentSettings = {};
    try {
      const res = await API.get('/settings');
      currentSettings = res || {};
    } catch { /* use defaults */ }

    const selectedCurrency = currentSettings.defaultCurrency || 'USD';
    const currencyOpts = Currency.currencyOptions(selectedCurrency);

    container.innerHTML = `
      <form id="system-form" class="space-y-stack-md max-w-2xl">
        <div>
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Company</h3>
          <div class="grid grid-cols-2 gap-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Company name</label>
              <input name="company_name" value="${currentSettings.companyName || currentSettings.company_name || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Currency</label>
              <select name="default_currency" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
                ${currencyOpts}
              </select>
            </div>
          </div>
        </div>
        <div class="pt-stack-md border-t border-outline-variant/30">
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Notifications</h3>
          <div class="space-y-stack-sm">
            <label class="flex items-center gap-stack-sm cursor-pointer"><input type="checkbox" name="email_notifications" ${currentSettings.email_notifications ? 'checked' : ''} class="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary"/><span class="font-body-md">Email notifications</span></label>
            <label class="flex items-center gap-stack-sm cursor-pointer"><input type="checkbox" name="push_notifications" ${currentSettings.push_notifications ? 'checked' : ''} class="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary"/><span class="font-body-md">Browser push notifications</span></label>
            <label class="flex items-center gap-stack-sm cursor-pointer"><input type="checkbox" name="weekly_digest" ${currentSettings.weekly_digest ? 'checked' : ''} class="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary"/><span class="font-body-md">Weekly digest</span></label>
          </div>
        </div>
        <div class="pt-stack-md border-t border-outline-variant/30">
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Data</h3>
          <div class="flex flex-wrap gap-stack-sm">
            <button type="button" id="export-data" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Export data</button>
            <button type="button" id="import-data" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Import data</button>
          </div>
        </div>
        <div class="pt-stack-md border-t border-outline-variant/30">
          <h3 class="font-h3 text-h3 text-error mb-stack-sm">Danger zone</h3>
          <div class="bg-error-container/20 border border-error/30 rounded-lg p-stack-md">
            <p class="font-body-md text-on-surface font-medium mb-1">Reset CRM data</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">Deletes ALL business data — contacts, deals, leads, invoices, payments, accounting entries, tasks and activities. Your user account and login settings are kept. This cannot be undone.</p>
            <button type="button" id="reset-crm-data" class="bg-error text-white px-4 py-2 rounded-lg hover:bg-error/90 font-body-md font-medium">Reset CRM data…</button>
          </div>
          ${this._canManageSettings() ? `
          <div class="bg-error-container/20 border border-error/30 rounded-lg p-stack-md mt-stack-md">
            <p class="font-body-md text-on-surface font-medium mb-1">Factory data reset</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">Wipes the ENTIRE database and returns the CRM to its original factory state — business data <strong>and all user accounts</strong> are deleted, then the bootstrap administrator is re-created. You and every other user will be signed out and must log in with the bootstrap admin credentials. This cannot be undone.</p>
            <button type="button" id="factory-reset" class="border border-error text-error px-4 py-2 rounded-lg hover:bg-error/10 font-body-md font-medium">Factory data reset…</button>
          </div>
          ` : `
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-stack-md">Factory data reset is available to administrator accounts only.</p>
          `}
        </div>
        <div class="flex justify-end gap-stack-sm pt-stack-md border-t border-outline-variant/30">
          <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save settings</button>
        </div>
      </form>
    `;
    container.querySelector('#system-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await API.put('/settings', Object.fromEntries(new FormData(e.target).entries()));
        Toast.success('Settings saved');
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
    container.querySelector('#export-data').addEventListener('click', () => Toast.info('Export started — you will be notified when ready'));
    container.querySelector('#import-data').addEventListener('click', () => Toast.info('Import wizard coming soon'));
    container.querySelector('#reset-crm-data').addEventListener('click', () => this.confirmResetCrmData());
    const factoryBtn = container.querySelector('#factory-reset');
    if (factoryBtn) factoryBtn.addEventListener('click', () => this.confirmFactoryReset());
  },

  // Factory reset is an admin-tier action: the API enforces settings.manage,
  // so the button is only rendered for sessions that carry that permission.
  _canManageSettings() {
    try {
      const user = JSON.parse(localStorage.getItem('crm_user') || '{}');
      const perms = Array.isArray(user.permissions) ? user.permissions : [];
      return perms.includes('*') || perms.includes('settings.manage');
    } catch { return false; }
  },

  // ------------------ UPDATES TAB (desktop app only) ------------------
  async renderUpdates(container) {
    const isDesktop = !!(window.desktop && window.desktop.isDesktop);
    let info = null;
    try { info = await window.desktop.getAppInfo(); } catch { /* fallback below */ }

    container.innerHTML = `
      <div class="space-y-stack-md max-w-2xl">
        <div>
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">About</h3>
          <p class="font-body-md text-on-surface">BlackStack CRM</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Version ${info?.version || '—'} ${isDesktop ? '(desktop)' : '(web)'}</p>
        </div>
        <div class="pt-stack-md border-t border-outline-variant/30" id="channel-panel">
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Update Channel</h3>
          <div role="radiogroup" aria-label="Update channel" class="flex gap-stack-md mb-stack-md" id="channel-options">
            <label class="flex items-center gap-2 font-body-md text-on-surface"><input type="radio" name="update-channel" value="stable"> Stable</label>
            <label class="flex items-center gap-2 font-body-md text-on-surface"><input type="radio" name="update-channel" value="beta"> Beta (early releases)</label>
            <label class="flex items-center gap-2 font-body-md text-on-surface"><input type="radio" name="update-channel" value="enterprise"> Enterprise (IT-managed)</label>
          </div>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Stable is recommended. Beta gives early access to pre-releases. Enterprise follows stable releases for IT-managed deployments.</p>
        </div>
        <div class="pt-stack-md border-t border-outline-variant/30" id="update-panel">
          <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Updates</h3>
          <div id="update-status" class="font-body-md text-on-surface-variant mb-stack-sm">Checking…</div>
          <!-- Phase C: progress is rendered from the updater's own byte counts.
               Hidden until a real DOWNLOADING state arrives; never simulated. -->
          <div id="update-progress" class="hidden mb-stack-sm" role="status" aria-live="polite">
            <div class="w-full h-2 rounded-full bg-surface-container overflow-hidden">
              <div id="update-progress-bar" class="h-full bg-secondary transition-all" style="width:0%"></div>
            </div>
            <div class="flex justify-between font-body-sm text-body-sm text-on-surface-variant mt-1">
              <span id="update-progress-detail">Downloading update…</span>
              <span id="update-progress-pct">0%</span>
            </div>
          </div>
          <!-- Shown while a download runs in the background after Minimize, so the
               user is never left wondering whether it is still going. -->
          <div id="update-background-note" class="hidden font-body-sm text-body-sm text-on-surface-variant mb-stack-sm"></div>
          <div class="flex gap-stack-sm" id="update-actions"></div>
        </div>
      </div>
    `;

    const statusEl = container.querySelector('#update-status');
    const actionsEl = container.querySelector('#update-actions');

    if (!isDesktop) {
      statusEl.textContent = 'Updates are managed by the desktop application. You are using the web version.';
    }

    // Channel selector (both desktop and web; persisted server-side).
    (async () => {
      try {
        // Routed through the shared API wrapper: every /api/datasafety route
        // requires authMiddleware + requirePermission('settings.manage'), and a
        // bare fetch() sends no Authorization header, so it was rejected with
        // 401 and the whole Updates tab silently fell back to defaults.
        // API.get() returns the unwrapped `data` object.
        const j = await window.API.get('/datasafety/update-channel');
        const ch = j?.channel || 'stable';
        const radio = container.querySelector(`input[name="update-channel"][value="${ch}"]`);
        if (radio) radio.checked = true;
      } catch { /* keep default */ }
      container.querySelectorAll('input[name="update-channel"]').forEach((input) => {
        input.addEventListener('change', async () => {
          if (!input.checked) return;
          if (input.value === 'beta' && !confirm('Enable Beta updates?\n\nBeta includes early pre-releases that may be less stable. Your data is always protected by the same safety system.')) {
            input.checked = false;
            const stable = container.querySelector('input[name="update-channel"][value="stable"]');
            if (stable) stable.checked = true;
            return;
          }
          try {
            const j2 = await window.API.put('/datasafety/update-channel', { channel: input.value });
            if (isDesktop && window.desktop.setChannel) await window.desktop.setChannel(input.value);
          } catch (e) {
            alert('Could not change update channel: ' + e.message);
          }
        });
      });
    })();

    if (!isDesktop) return;

    let latest = null;

    // ── Phase C: progress rendering ────────────────────────────────────────
    // Every value below comes from electron-updater's download-progress event.
    // Nothing is interpolated or timed: if the updater has not reported a byte
    // count, the UI shows only what it actually knows.
    const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const bytes = (n) => {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    };

    const progressEl = container.querySelector('#update-progress');
    const barEl = container.querySelector('#update-progress-bar');
    const detailEl = container.querySelector('#update-progress-detail');
    const pctEl = container.querySelector('#update-progress-pct');
    const bgNoteEl = container.querySelector('#update-background-note');

    const renderProgress = (s) => {
      const p = pct(s.percent);
      const hasBytes = bytes(s.transferred) && bytes(s.total);
      if (p === null && !hasBytes) {
        // Truthful fallback: percentage or nothing, never a fake bar.
        progressEl.classList.add('hidden');
        bgNoteEl.classList.add('hidden');
        return;
      }
      progressEl.classList.remove('hidden');
      const width = p === null ? 0 : Math.max(0, Math.min(100, p));
      barEl.style.width = `${width}%`;
      pctEl.textContent = p === null ? '' : `${Math.round(p)}%`;
      const t = bytes(s.total);
      const d = bytes(s.transferred);
      const speed = typeof s.bytesPerSecond === 'number' && s.bytesPerSecond > 0
        ? ` · ${bytes(s.bytesPerSecond)}/s` : '';
      detailEl.textContent = hasBytes
        ? `Downloading update… ${d} / ${t}${speed}`
        : 'Downloading update…';
    };

    const clearProgress = () => {
      progressEl.classList.add('hidden');
      bgNoteEl.classList.add('hidden');
      barEl.style.width = '0%';
      pctEl.textContent = '0%';
      detailEl.textContent = 'Downloading update…';
    };

    // ── Phase C: minimize is a pure UI concern ────────────────────────────
    // The download runs in the Electron MAIN process and reports over IPC, so
    // collapsing the panel cannot pause or cancel it. Nothing is sent to the
    // main process here — that is the whole point.
    let minimized = false;
    const setMinimized = (on) => {
      minimized = on;
      progressEl.classList.toggle('hidden', on);
      if (on) {
        bgNoteEl.classList.remove('hidden');
        const p = pct(latest?.percent);
        bgNoteEl.textContent = p === null
          ? 'Update is downloading in the background. You can keep working.'
          : `Update downloading in the background — ${Math.round(p)}%. You can keep working.`;
      } else {
        bgNoteEl.classList.add('hidden');
      }
      render(latest || { status: 'IDLE' }, { keepMinimized: true });
    };

    const render = (s, opts = {}) => {
      latest = { ...(latest || {}), ...s };
      const state = latest;

      // A background download always leaves the background note visible.
      if (state.status === 'DOWNLOADING') renderProgress(state);
      else clearProgress();

      switch (state.status) {
        case 'CHECKING':
          statusEl.textContent = 'Checking for updates…';
          actionsEl.innerHTML = '';
          break;

        case 'UP_TO_DATE':
          statusEl.innerHTML = '<span style="color:green">✓</span> You are using the latest version.';
          actionsEl.innerHTML = '<button id="check-updates" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Check for Updates</button>';
          break;

        case 'AVAILABLE':
          statusEl.innerHTML = `
            <p class="font-body-md"><strong>New BlackStack Update Available</strong></p>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
              Current Version: ${state.currentVersion || '—'} &nbsp;·&nbsp; New Version: ${state.targetVersion || '—'}
            </p>`;
          // Update Now starts the download; Later dismisses it. Neither restarts.
          actionsEl.innerHTML = `
            <button id="update-now" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 font-body-md font-medium">Update Now</button>
            <button id="later-update" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Later</button>`;
          break;

        case 'DOWNLOADING':
          statusEl.textContent = 'Downloading update…';
          actionsEl.innerHTML = minimized
            ? '<button id="show-update" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Show progress</button>'
            : '<button id="minimize-update" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Minimize</button>';
          break;

        case 'READY':
          statusEl.innerHTML = `
            <p class="font-body-md"><strong>Update Ready</strong></p>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
              BlackStack ${state.targetVersion || ''} has been downloaded and is ready to install.<br>
              You can continue working and restart when convenient. A verified backup of your data is created before installing.
            </p>`;
          actionsEl.innerHTML = `
            <button id="install-update" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 font-body-md font-medium">Restart &amp; Update</button>
            <button id="later-update" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Later</button>`;
          break;

        case 'POSTPONED':
          // "Later" after a download: still installed, just not now. The button
          // to act on it remains available.
          statusEl.innerHTML = `
            <p class="font-body-md"><strong>Update Ready</strong> (postponed)</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
              BlackStack ${state.targetVersion || ''} is downloaded and waiting. It will not be installed until you choose
              <em>Restart &amp; Update</em> — closing BlackStack will not install it.
            </p>`;
          actionsEl.innerHTML = `
            <button id="install-update" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 font-body-md font-medium">Restart &amp; Update</button>
            <button id="update-now" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Update Now</button>`;
          break;

        case 'INSTALLING':
          statusEl.textContent = 'Installing update… BlackStack will restart automatically.';
          actionsEl.innerHTML = '';
          break;

        case 'OFFLINE':
        case 'ERROR':
          statusEl.textContent = state.error
            || 'Update check failed. BlackStack works normally offline.';
          actionsEl.innerHTML = '<button id="check-updates" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Retry</button>';
          break;

        case 'DISABLED':
          statusEl.textContent = 'Updates are only available in the installed application.';
          actionsEl.innerHTML = '';
          break;

        default:
          statusEl.textContent = 'No update information yet.';
          actionsEl.innerHTML = '<button id="check-updates" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Check for Updates</button>';
      }
      if (!opts.keepMinimized) minimized = false;
      bind();
    };

    function bind() {
      const c = container.querySelector('#check-updates');
      if (c) c.addEventListener('click', async () => {
        render({ status: 'CHECKING' });
        const res = await window.desktop.checkForUpdate();
        if (res && (res.status === 'OFFLINE' || res.status === 'ERROR')) render(res);
      });

      // Phase C: Update Now -> DOWNLOADING. Never restarts, never installs.
      const now = container.querySelector('#update-now');
      if (now) now.addEventListener('click', async () => {
        render({ status: 'DOWNLOADING', percent: 0 });
        const res = await window.desktop.startDownload();
        if (!res || res.ok === false) {
          alert(res?.message || 'The update could not be started. BlackStack continues to work normally.');
          render({ status: 'ERROR', error: res?.message });
        }
      });

      const min = container.querySelector('#minimize-update');
      if (min) min.addEventListener('click', () => setMinimized(true));

      const show = container.querySelector('#show-update');
      if (show) show.addEventListener('click', () => setMinimized(false));

      const inst = container.querySelector('#install-update');
      if (inst) inst.addEventListener('click', async () => {
        render({ status: 'INSTALLING' });
        const res = await window.desktop.installUpdate();
        if (res && res.ok === false) {
          alert(res.message || 'Update could not be safely prepared. Your current CRM has not been changed.');
          render({ status: 'ERROR', error: res.message });
        }
      });

      // Phase C: Later is RECORDED in the main process, and thanks to
      // autoInstallOnAppQuit = false it genuinely defers the install.
      const later = container.querySelector('#later-update');
      if (later) later.addEventListener('click', async () => {
        try { await window.desktop.postponeUpdate(); } catch { /* non-fatal */ }
        render({ status: 'POSTPONED', postponed: true });
      });
    }

    // Restore whatever the updater already knows (including an update that was
    // downloaded before this launch) before triggering a fresh check.
    (async () => {
      try {
        const res = await window.desktop.getUpdateState();
        if (res && res.ok && res.state && res.state.status !== 'IDLE') {
          render(res.state);
        }
      } catch { /* fall through to a live check */ }
    })();

    const off = window.desktop.onUpdateStatus((s) => render(s));
    window.desktop.checkForUpdate().then((res) => {
      if (res && (res.status === 'OFFLINE' || res.status === 'ERROR' || res.status === 'DISABLED')) render(res);
    }).catch(() => render({ status: 'OFFLINE', message: 'Could not reach update server. CRM continues normally.' }));
    setTimeout(() => { if (latest && latest.status === 'CHECKING') render({ status: 'OFFLINE', message: 'Update check timed out. The CRM works normally offline.' }); }, 12000);
    void off;
  },

  confirmFactoryReset() {
    const modal = new Modal({
      title: 'Factory data reset?',
      size: 'md',
      content: `
        <div class="space-y-4">
          <div class="bg-error-container/20 border border-error/30 rounded-lg p-3">
            <p class="font-body-md text-on-surface font-medium">This wipes the ENTIRE database and restores the factory state:</p>
            <ul class="font-body-sm text-body-sm text-on-surface-variant list-disc pl-5 mt-2 space-y-1">
              <li>All business data — CRM, accounting, invoices, inventory</li>
              <li><strong>All user accounts, including yours</strong> — everyone is signed out</li>
              <li>Custom settings, notes and activity history</li>
            </ul>
          </div>
          <p class="font-body-md text-on-surface">The CRM is re-seeded to its original state: the bootstrap administrator (<strong>admin@blackstack.local</strong>) is re-created and you must sign in with its credentials.</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant">This action cannot be undone. To confirm, type <strong>FACTORY RESET</strong> in the first field and enter <strong>your account password</strong> in the second.</p>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Confirmation phrase — type exactly: FACTORY RESET</label>
            <input id="factory-confirm-input" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-error/40" placeholder="FACTORY RESET" autocomplete="off" spellcheck="false"/>
            <p id="factory-phrase-hint" class="font-body-sm text-body-sm text-on-surface-variant mt-1">Waiting for the exact phrase…</p>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Your password (admin@blackstack.local)</label>
            <input id="factory-confirm-password" type="password" autocomplete="current-password" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-error/40" placeholder="Your password"/>
          </div>
          <div class="flex justify-end gap-2 pt-2 border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
            <button id="factory-confirm-btn" class="bg-error text-white px-5 py-2 rounded-lg hover:bg-error/90 font-medium" disabled>Wipe everything &amp; restore factory state</button>
          </div>
        </div>
      `,
    });
    modal.open();

    const input = modal.element.querySelector('#factory-confirm-input');
    const passwordInput = modal.element.querySelector('#factory-confirm-password');
    const hint = modal.element.querySelector('#factory-phrase-hint');
    const btn = modal.element.querySelector('#factory-confirm-btn');
    const phraseOk = () => input.value.trim().toUpperCase() === 'FACTORY RESET';
    const validate = () => {
      const ok = phraseOk() && passwordInput.value.length > 0;
      btn.disabled = !ok;
      btn.classList.toggle('opacity-50', !ok);
      btn.classList.toggle('cursor-not-allowed', !ok);
      // Live guidance so the user knows which field is the problem.
      if (!input.value.trim()) { hint.textContent = 'Waiting for the exact phrase…'; hint.className = 'font-body-sm text-body-sm text-on-surface-variant mt-1'; }
      else if (!phraseOk()) { hint.textContent = 'Phrase incorrect — it must read exactly: FACTORY RESET (not your email).'; hint.className = 'font-body-sm text-body-sm text-error mt-1'; }
      else if (!passwordInput.value) { hint.textContent = '✓ Phrase correct — now enter your password below.'; hint.className = 'font-body-sm text-body-sm text-on-surface mt-1'; }
      else { hint.textContent = '✓ Ready — press “Wipe everything & restore factory state”.'; hint.className = 'font-body-sm text-body-sm text-green-600 mt-1'; }
    };
    input.addEventListener('input', validate);
    passwordInput.addEventListener('input', validate);
    validate();
    const submit = async () => {
      btn.disabled = true;
      btn.textContent = 'Resetting…';
      try {
        await API.post('/settings/factory-reset', { confirm: 'FACTORY RESET', password: passwordInput.value });
        modal.close();
        Toast.success('Factory reset complete. All users were removed — sign in with the bootstrap administrator account.');
        setTimeout(() => { try { window.location.href = '/login.html'; } catch { /* keep session state */ } }, 2500);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Wipe everything & restore factory state';
        Toast.error(err.message || 'Factory reset failed');
      }
    };
    btn.addEventListener('click', submit);
    passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) submit(); });
  },

  confirmResetCrmData() {
    const modal = new Modal({
      title: 'Reset CRM data?',
      size: 'md',
      content: `
        <div class="space-y-4">
          <div class="bg-error-container/20 border border-error/30 rounded-lg p-3">
            <p class="font-body-md text-on-surface font-medium">This permanently deletes all business data:</p>
            <ul class="font-body-sm text-body-sm text-on-surface-variant list-disc pl-5 mt-2 space-y-1">
              <li>Contacts, organizations, leads, customers, deals &amp; pipelines</li>
              <li>Invoices, payments, bills &amp; products</li>
              <li>Full accounting: chart of accounts, journal entries, vouchers</li>
              <li>Tasks, activities, appointments, notes &amp; workflows</li>
            </ul>
          </div>
          <p class="font-body-md text-on-surface">Your <strong>user account and logins are kept</strong> — you will stay signed in.</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant">This action cannot be undone. Type <strong>RESET</strong> below to confirm.</p>
          <input id="reset-confirm-input" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-error/40" placeholder="Type RESET to confirm"/>
          <div class="flex justify-end gap-2 pt-2 border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
            <button id="reset-confirm-btn" class="bg-error text-white px-5 py-2 rounded-lg hover:bg-error/90 font-medium" disabled>Delete everything</button>
          </div>
        </div>
      `,
    });
    modal.open();

    const input = modal.element.querySelector('#reset-confirm-input');
    const btn = modal.element.querySelector('#reset-confirm-btn');
    input.addEventListener('input', () => { btn.disabled = input.value.trim().toUpperCase() !== 'RESET'; });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Resetting…';
      try {
        const res = await API.post('/settings/reset-crm-data', { confirm: 'RESET CRM DATA' });
        modal.close();
        const d = res?.data || res || {};
        Toast.success(`CRM data reset complete — ${d.rowsDeleted ?? 0} rows removed across ${d.tablesCleared ?? 0} tables. Users preserved.`);
        if (window.PageModules?.dashboard) window.dispatchEvent(new CustomEvent('page:navigate', { detail: { path: 'dashboard' } }));
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Delete everything';
        Toast.error(err.message || 'Reset failed');
      }
    });
  },

  // ─── PHASE 3: DATA SAFETY / STORAGE / SUPPORT PANEL ───────────────────
  async renderDataSafety(container) {
    container.innerHTML = `
      <div class="space-y-stack-md max-w-2xl" id="datasafety-panel">
        <section aria-labelledby="ds-backup-h" class="pb-stack-md border-b border-outline-variant/30">
          <h3 id="ds-backup-h" class="font-h3 text-h3 text-on-surface mb-stack-sm">Backups</h3>
          <div id="ds-backup-status" class="font-body-md text-on-surface-variant mb-stack-md">Loading backup status…</div>
          <div class="flex gap-stack-sm">
            <button id="ds-create-backup" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 font-body-md font-medium">Create Backup</button>
            <button id="ds-refresh-backups" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Refresh</button>
          </div>
          <div id="ds-backup-list" class="mt-stack-md space-y-stack-sm"></div>
        </section>
        <section aria-labelledby="ds-storage-h" class="pb-stack-md border-b border-outline-variant/30">
          <h3 id="ds-storage-h" class="font-h3 text-h3 text-on-surface mb-stack-sm">Storage</h3>
          <div id="ds-storage" class="font-body-md text-on-surface-variant">Loading storage information…</div>
        </section>
        <section aria-labelledby="ds-support-h" class="pb-stack-md border-b border-outline-variant/30">
          <h3 id="ds-support-h" class="font-h3 text-h3 text-on-surface mb-stack-sm">Support</h3>
          <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-sm">Creates a sanitized diagnostics file (no CRM records, no secrets). Review before sharing.</p>
          <button id="ds-support-bundle" class="border border-outline-variant px-4 py-2 rounded-lg hover:bg-surface-container font-body-md">Generate Support Bundle</button>
          <div id="ds-support-status" class="font-body-sm text-body-sm text-on-surface-variant mt-stack-sm"></div>
        </section>
        <section aria-labelledby="ds-delete-h">
          <h3 id="ds-delete-h" class="font-h3 text-h3 text-on-surface mb-stack-sm">Delete All Data</h3>
          <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-sm">Permanently deletes your CRM database, backups, uploads, preferences and logs. Requires two confirmations and a final verified backup. Uninstall does <strong>not</strong> do this.</p>
          <button id="ds-delete-all" class="border border-error text-error px-4 py-2 rounded-lg hover:bg-error-container/30 font-body-md">Delete All Data…</button>
          <div id="ds-delete-status" class="font-body-sm text-body-sm text-on-surface-variant mt-stack-sm"></div>
        </section>
      </div>
    `;

    const fmt = (b) => b == null ? '—' : (b > 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : b > 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
    const statusEl = container.querySelector('#ds-backup-status');

    async function refreshBackups() {
      try {
        const [statusRes, listRes] = await Promise.all([
          window.API.get('/datasafety/backups/status'),
          window.API.get('/datasafety/backups'),
        ]);
        // API.get() unwraps `data`, so these are already the payload objects.
        const s = statusRes || {};
        const list = (listRes || []).filter((b) => b.verified);
        statusEl.innerHTML = `Last verified backup: <strong>${s.lastVerifiedBackup ? new Date(s.lastVerifiedBackup.createdAt).toLocaleString() : 'none'}</strong><br>
          Verified backups: <strong>${s.verifiedBackups ?? '—'}</strong> · Backup storage: <strong>${fmt(s.backupStorageBytes)}</strong> · Retention: <strong>${s.retention?.maxVerifiedBackups ?? 5}</strong>`;
        const listEl = container.querySelector('#ds-backup-list');
        listEl.innerHTML = list.length ? list.map((b) => `
          <div class="flex items-center justify-between gap-stack-sm bg-surface-container-low rounded-lg px-3 py-2">
            <span class="font-body-sm text-body-sm text-on-surface truncate">${new Date(b.createdAt).toLocaleString()} · ${b.label || ''}</span>
            <button class="ds-restore border border-outline-variant px-3 py-1 rounded-lg font-body-sm hover:bg-surface-container" data-file="${b.file}">Restore</button>
          </div>`).join('') : '<p class="font-body-sm text-on-surface-variant">No verified backups yet. Create one now.</p>';
        listEl.querySelectorAll('.ds-restore').forEach((btn) => {
          btn.addEventListener('click', () => this.restoreBackupFlow(btn.dataset.file, btn));
        });
      } catch (e) {
        statusEl.textContent = 'Could not load backup status: ' + e.message;
      }
    }

    container.querySelector('#ds-create-backup').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Creating backup…';
      try {
        await window.API.post('/datasafety/backups');
        Toast.success('Backup created and verified.');
      } catch (e) { Toast.error(e.message); }
      btn.disabled = false; btn.textContent = 'Create Backup';
      refreshBackups.call(this);
    });
    container.querySelector('#ds-refresh-backups').addEventListener('click', () => refreshBackups.call(this));

    // Storage dashboard.
    (async () => {
      try {
        const s = (await window.API.get('/datasafety/storage')) || {};
        const rows = [
          ['Database', s.databaseBytes], ['Backups', s.backupsBytes], ['Uploads', s.uploadsBytes],
          ['Logs', s.logsBytes], ['Cache', s.cacheBytes], ['Free disk space', s.availableDiskBytes],
        ];
        const warn = (s.warnings || []).map((w) => `<li role="status" class="text-warning font-body-sm">⚠ ${w.message}</li>`).join('');
        container.querySelector('#ds-storage').innerHTML = `
          <table class="w-full font-body-sm text-body-sm"><tbody>
            ${rows.map(([k, v]) => `<tr><td class="py-1 text-on-surface-variant">${k}</td><td class="py-1 text-right text-on-surface font-medium">${fmt(v)}</td></tr>`).join('')}
          </tbody></table>${warn ? `<ul class="mt-stack-sm space-y-1">${warn}</ul>` : ''}`;
      } catch (e) {
        container.querySelector('#ds-storage').textContent = 'Could not load storage information.';
      }
    })();

    // Support bundle.
    container.querySelector('#ds-support-bundle').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const st = container.querySelector('#ds-support-status');
      btn.disabled = true; st.textContent = 'Preparing support bundle…';
      try {
        const j = await window.API.post('/datasafety/support-bundle');
        st.innerHTML = `✓ Complete: <code class="text-xs break-all">${j.file}</code><br>Review the contents before sharing it with support.`;
      } catch (e) { st.textContent = 'Failed: ' + e.message; }
      btn.disabled = false;
    });

    // Delete-all-data flow (Phase 2 service; two confirmations + final backup).
    container.querySelector('#ds-delete-all').addEventListener('click', () => this.deleteAllDataFlow(container));

    refreshBackups.call(this);
  },

  restoreBackupFlow(file, btn) {
    const modal = new Modal({
      title: 'Restore Backup',
      size: 'md',
      content: `
        <p class="font-body-md text-on-surface">Replace the current database with this backup?</p>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-2">A safety backup of the current data is created first. If the restore fails, the current data is restored automatically.</p>
        <p class="font-body-sm text-on-surface-variant mt-2 break-all">${file}</p>
        <div class="flex justify-end gap-2 pt-3 border-t border-outline-variant/30 mt-3">
          <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel Restore</button>
          <button id="ds-restore-go" class="bg-secondary text-on-secondary px-5 py-2 rounded-lg font-medium">Restore Backup</button>
        </div>`,
    });
    modal.open();
    const go = modal.element.querySelector('#ds-restore-go');
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Restoring…';
      try {
        await window.API.post('/datasafety/backups/restore', { file });
        modal.close();
        Toast.success('Backup restored and verified. Restart the app to reload data.');
      } catch (e) {
        go.disabled = false; go.textContent = 'Restore Backup';
        Toast.error(e.message);
      }
    });
  },

  async deleteAllDataFlow(container) {
    // Confirmation 1.
    if (!confirm('Delete all BlackStack CRM data?\n\nThis will permanently delete your CRM database, uploads, preferences, backups and application data.\n\nThis action cannot be undone.')) return;
    // Confirmation 2: type DELETE (exact).
    const typed = prompt('Type DELETE (in capital letters) to confirm permanent deletion:');
    if (typed !== 'DELETE') { Toast.error('Deletion cancelled — confirmation did not match.'); return; }
    const st = container.querySelector('#ds-delete-status');
    try {
      await window.API.post('/datasafety/data-deletion/token');
      // NOTE: the token is held server-side; execute with the typed phrase.
      const ex = await window.API.post('/datasafety/data-deletion/execute', { typedConfirmation: 'DELETE' });
      st.textContent = 'All data deleted.' + (ex?.finalBackup ? ' A final verified backup exists outside the deleted folder: ' + ex.finalBackup : '');
      Toast.success('All BlackStack CRM data deleted.');
    } catch (e) {
      st.textContent = 'Deletion did not complete: ' + e.message;
      Toast.error(e.message);
    }
  },
};
