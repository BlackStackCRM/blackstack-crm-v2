/**
 * CHANGE PASSWORD PAGE — forced screen for accounts with must_change_password.
 *
 * WHY THIS EXISTS
 *   Accounts created via /api/accounts/create are issued a ONE-TIME password
 *   by their parent. Until the operator changes it, the account must not be
 *   usable for anything else. app.js routes here and blocks all other routes
 *   while user.mustChangePassword is true.
 *
 * ENDPOINT: POST /api/auth/password/change
 *   { currentPassword, newPassword } — camelToSnake middleware handles both.
 *   On success the backend clears must_change_password; the local session
 *   mirror is updated here so the route guard releases.
 */
window.PageModules = window.PageModules || {};

window.PageModules.changePassword = {
  async init() {
    const host = document.getElementById('page-container');
    if (!host) return () => {};

    let user = null;
    try { user = JSON.parse(localStorage.getItem('crm_user') || 'null'); } catch { user = null; }

    const token = localStorage.getItem('crm_token');
    if (!token) { window.location.href = '/login.html'; return () => {}; }

    // Flag already cleared → normal navigation.
    if (!user || !user.mustChangePassword) {
      window.location.hash = '#dashboard';
      window.dispatchEvent(new CustomEvent('page:navigate', { detail: { path: 'dashboard' } }));
      return () => {};
    }

    const target = user.email || user.username || '';
    host.innerHTML = `
      <div class="max-w-md mx-auto mt-stack-xl mb-stack-xl">
        <div class="bg-surface-container rounded-xl border border-outline-variant p-stack-lg">
          <div class="text-center mb-stack-md">
            <span class="material-symbols-outlined text-[40px] text-secondary">lock_reset</span>
            <h1 class="font-display text-h2 text-on-surface mt-2">Set a new password</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">
              Your account (${this.esc(target)}) was created with a one-time password.
              Choose a new password to continue — this is required before you can
              access the rest of the application.
            </p>
          </div>
          <div id="cp-error" class="hidden rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-body-sm text-error"></div>
          <div id="cp-ok" class="hidden rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-body-sm text-success mt-2"></div>
          <form id="cp-form" novalidate>
            <label class="block mb-stack-sm">
              <span class="font-body-sm text-body-sm text-on-surface">Current (one-time) password *</span>
              <input id="cp-current" type="password" autocomplete="current-password"
                class="mt-1 w-full border border-outline-variant rounded-lg px-3 py-2 bg-surface text-on-surface" />
            </label>
            <label class="block mb-stack-sm">
              <span class="font-body-sm text-body-sm text-on-surface">New password *</span>
              <input id="cp-new" type="password" autocomplete="new-password"
                class="mt-1 w-full border border-outline-variant rounded-lg px-3 py-2 bg-surface text-on-surface" />
              <span class="block mt-1 font-body-sm text-body-sm text-on-surface-variant">Minimum 10 characters.</span>
            </label>
            <label class="block mb-stack-sm">
              <span class="font-body-sm text-body-sm text-on-surface">Confirm new password *</span>
              <input id="cp-confirm" type="password" autocomplete="new-password"
                class="mt-1 w-full border border-outline-variant rounded-lg px-3 py-2 bg-surface text-on-surface" />
            </label>
            <button id="cp-save" type="submit"
              class="mt-stack-sm w-full bg-secondary text-on-secondary rounded-lg px-4 py-2 font-body-md hover:bg-secondary/90">
              Change password
            </button>
          </form>
        </div>
      </div>`;

    const errEl = document.getElementById('cp-error');
    const okEl = document.getElementById('cp-ok');
    const saveBtn = document.getElementById('cp-save');
    const showError = (m) => { errEl.textContent = m; errEl.classList.remove('hidden'); };
    const showOk = (m) => { okEl.textContent = m; okEl.classList.remove('hidden'); };
    const hideMsgs = () => { errEl.classList.add('hidden'); okEl.classList.add('hidden'); };

    document.getElementById('cp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      hideMsgs();
      const current = document.getElementById('cp-current').value;
      const next = document.getElementById('cp-new').value;
      const confirm = document.getElementById('cp-confirm').value;

      if (!current || !next) { showError('Enter your current password and a new password.'); return; }
      if (next.length < 10) { showError('New password must be at least 10 characters.'); return; }
      if (next === current) { showError('New password must be different from the current one.'); return; }
      if (next !== confirm) { showError('New password and confirmation do not match.'); return; }

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await window.API.post('/auth/password/change', {
          currentPassword: current,
          newPassword: next,
        });
        // Refresh the profile so the flag (and permissions) are current; then
        // update the local mirror so the route guard releases everywhere.
        let fresh = null;
        try {
          const prof = await window.API.get('/auth/profile');
          fresh = prof && (prof.data || prof);
        } catch { /* profile refresh failed — flag cleared server-side anyway */ }
        const merged = Object.assign({}, user, fresh || {}, { mustChangePassword: false });
        localStorage.setItem('crm_user', JSON.stringify(merged));
        showOk('Password changed. Redirecting to the dashboard…');
        setTimeout(() => {
          window.location.hash = '#dashboard';
          window.dispatchEvent(new CustomEvent('page:navigate', { detail: { path: 'dashboard' } }));
        }, 600);
      } catch (err2) {
        const msg = (window.API && window.API.apiErrorText)
          ? window.API.apiErrorText(err2, 'Could not change the password.')
          : (err2 && err2.message) || 'Could not change the password.';
        showError(msg);
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Change password';
      }
    });

    return () => {}; // no listeners to detach
  },

  esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
};
