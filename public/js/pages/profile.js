window.PageModules = window.PageModules || {};

window.PageModules.profile = {
  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    const user = AuthAPI.getUser() || {};
    const initials = `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase();
    main.innerHTML = `
      <div class="mb-stack-lg">
        <h1 class="font-display text-h1 text-on-surface tracking-tight">My Profile</h1>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">View and manage your account information.</p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-stack-md">
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding text-center">
          <div class="w-24 h-24 rounded-full bg-secondary mx-auto flex items-center justify-center text-on-secondary text-h1 font-semibold">${initials || 'U'}</div>
          <h2 class="font-h1 text-h1 text-on-surface mt-stack-md">${user.firstName || ''} ${user.lastName || ''}</h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">${user.email || ''}</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${user.role || 'User'}</p>
          <div class="mt-stack-md pt-stack-md border-t border-outline-variant/30">
            <p class="font-label-md text-label-md uppercase text-on-surface-variant">Last login</p>
            <p class="font-body-md text-body-md text-on-surface mt-1">${user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Just now'}</p>
          </div>
        </div>

        <div class="lg:col-span-2 space-y-stack-md">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-h3 text-h3 text-on-surface mb-stack-md">User Information</h3>
            <div class="grid grid-cols-2 gap-stack-md">
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">First name</p><p class="font-body-md text-on-surface mt-1">${user.firstName || '—'}</p></div>
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">Last name</p><p class="font-body-md text-on-surface mt-1">${user.lastName || '—'}</p></div>
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">Email</p><p class="font-body-md text-on-surface mt-1">${user.email || '—'}</p></div>
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">Role</p><p class="font-body-md text-on-surface mt-1 capitalize">${user.role || '—'}</p></div>
            </div>
          </div>

          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-h3 text-h3 text-on-surface mb-stack-md">Change Password</h3>
            <form id="pwd-form" class="space-y-stack-md">
              <div>
                <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Current password</label>
                <input name="current" type="password" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
              </div>
              <div>
                <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">New password</label>
                <input name="next" type="password" required minlength="8" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
              </div>
              <div>
                <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Confirm new password</label>
                <input name="confirm" type="password" required minlength="8" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
              </div>
              <div class="flex justify-end pt-stack-sm border-t border-outline-variant/30">
                <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Update password</button>
              </div>
            </form>
          </div>

          <div class="bg-surface-container-lowest rounded-xl border border-error/30 p-container-padding">
            <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Danger zone</h3>
            <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">Sign out of your current session.</p>
            <button id="logout-btn" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90 flex items-center gap-stack-sm">
              <span class="material-symbols-outlined text-[18px]">logout</span> Logout
            </button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('pwd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('next') !== fd.get('confirm')) { Toast.error('Passwords do not match'); return; }
      try {
        await AuthAPI.changePassword(fd.get('current'), fd.get('next'));
        Toast.success('Password updated');
        e.target.reset();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
    document.getElementById('logout-btn').addEventListener('click', async () => {
      try { await AuthAPI.logout(); } finally { window.location.href = '/login.html'; }
    });
    return () => {};
  },
};
