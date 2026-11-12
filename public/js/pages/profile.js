window.PageModules = window.PageModules || {};

window.PageModules.profile = {
  esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  value(value) {
    return value === null || value === undefined || String(value).trim() === '' ? '—' : this.esc(value);
  },
  agencyDetails(agency) {
    const details = [
      ['Name', agency.name], ['Code', agency.agencyCode], ['Status', agency.status],
      ['Contact email', agency.contactEmail], ['Contact phone', agency.contactPhone],
      ['Address', agency.address], ['City', agency.city], ['State', agency.state],
      ['Country', agency.country || 'India'], ['Pincode', agency.pincode],
      ['Parent agency', agency.parentAgencyName
        ? `${agency.parentAgencyName} (${agency.parentAgencyCode || ''})` : ''],
      ['Created date', agency.createdAt ? new Date(agency.createdAt).toLocaleString() : ''],
    ];
    return `<dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-stack-lg gap-y-stack-md mt-stack-md">${details.map(([label, value]) => `
      <div><dt class="font-label-md text-label-md uppercase text-on-surface-variant">${this.esc(label)}</dt><dd class="font-body-md text-on-surface mt-1 break-words">${this.value(value)}</dd></div>`).join('')}
    </dl>`;
  },
  agencyCard(agency, subtitle = '') {
    const status = this.esc(agency.status || 'UNKNOWN');
    const statusClass = String(agency.status || '').toUpperCase() === 'ACTIVE'
      ? 'bg-success/10 border-success/30 text-success'
      : String(agency.status || '').toUpperCase() === 'PENDING'
        ? 'bg-warning/10 border-warning/30 text-warning'
        : 'bg-surface-container border-outline-variant/40 text-on-surface-variant';
    return `<article class="rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-container-padding">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div><h4 class="font-h3 text-h3 text-on-surface">${this.esc(agency.name || 'Agency')}</h4>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${this.esc(agency.agencyCode || '')}${subtitle ? ` · ${this.esc(subtitle)}` : ''}</p></div>
        <span class="rounded-full border px-3 py-1 text-label-md font-medium ${statusClass}">${status}</span>
      </div>
      ${this.agencyDetails(agency)}
    </article>`;
  },
  agencySections(context, errorMessage = '') {
    if (errorMessage) {
      return `<section class="mb-stack-lg rounded-xl border border-error/40 bg-surface-container-lowest p-container-padding">
        <h2 class="font-display text-h3 text-on-surface">Agency</h2>
        <p class="mt-stack-sm text-body-sm text-error">${this.esc(errorMessage)}</p></section>`;
    }
    if (!context?.agency) return '';
    const isSubAgency = context.role === 'sub_agency';
    const distribution = context.distributionAgency || (!isSubAgency ? context.agency : null);
    const subAgencyContent = isSubAgency
      ? this.agencyCard(context.agency, 'Your assigned sub-agency')
      : (context.subAgencies || []).map((agency) => this.agencyCard(agency)).join('')
        || '<p class="text-body-sm text-on-surface-variant">No sub-agencies yet.</p>';
    const customers = (context.customers || []).map((customer) => `<tr class="border-t border-outline-variant/30">
      <td class="py-3 pr-3 text-on-surface">${this.esc(customer.name)}</td>
      <td class="py-3 pr-3 text-on-surface-variant">${this.esc(customer.agencyName || context.agency.name || '—')}</td>
      <td class="py-3 text-on-surface">${this.esc(customer.status || '—')}</td></tr>`).join('');
    const admins = (context.administrators || []).map((admin) => `<tr class="border-t border-outline-variant/30">
      <td class="py-3 pr-3 text-on-surface">${this.esc(admin.fullName || '—')}</td>
      <td class="py-3 pr-3 text-on-surface">${this.esc(admin.email || '—')}</td>
      <td class="py-3 pr-3 text-on-surface">${this.esc(admin.username || '—')}</td>
      <td class="py-3 text-on-surface">${this.esc(admin.status || '—')}</td></tr>`).join('');
    return `<section class="mb-stack-lg space-y-stack-md">
      ${distribution ? `<div><h2 class="font-display text-h3 text-on-surface mb-stack-sm">Distribution agency</h2>${this.agencyCard(distribution, isSubAgency ? 'Parent distribution agency' : 'Your agency')}</div>` : ''}
      <div><h2 class="font-display text-h3 text-on-surface mb-stack-sm">Sub-agencies</h2><div class="space-y-stack-sm">${subAgencyContent}</div></div>
      <div class="rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-container-padding">
        <h2 class="font-display text-h3 text-on-surface mb-stack-sm">Customer tenants</h2>
        ${customers ? `<div class="overflow-x-auto"><table class="w-full text-left text-body-sm"><thead><tr class="text-label-md text-on-surface-variant"><th class="pb-2 pr-3">Customer</th><th class="pb-2 pr-3">Assigned agency</th><th class="pb-2">Status</th></tr></thead><tbody>${customers}</tbody></table></div>` : '<p class="text-body-sm text-on-surface-variant">No customer tenants yet.</p>'}
      </div>
      <div class="rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-container-padding">
        <h2 class="font-display text-h3 text-on-surface mb-stack-sm">Agency administrators</h2>
        ${admins ? `<div class="overflow-x-auto"><table class="w-full text-left text-body-sm"><thead><tr class="text-label-md text-on-surface-variant"><th class="pb-2 pr-3">Name</th><th class="pb-2 pr-3">Email</th><th class="pb-2 pr-3">Username</th><th class="pb-2">Status</th></tr></thead><tbody>${admins}</tbody></table></div>` : '<p class="text-body-sm text-on-surface-variant">No administrators assigned.</p>'}
      </div>
    </section>`;
  },
  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    let user = AuthAPI.getUser() || {};
    try { user = await AuthAPI.getProfile() || user; } catch { /* use the cached profile */ }
    const role = window.RolePermissions?.role()
      || String(user.hierarchyRole || user.hierarchy_role || user.role || '').toLowerCase();
    let agencyContext = null;
    let agencyContextError = '';
    if (['agency', 'sub_agency'].includes(role)) {
      try { agencyContext = await window.API.get('/agency-control/my-context'); }
      catch (error) { agencyContextError = error.message || 'Could not load agency information.'; }
    }
    const agencyMarkup = agencyContext || agencyContextError
      ? this.agencySections(agencyContext, agencyContextError) : '';
    const firstName = user.firstName || user.first_name || '';
    const lastName = user.lastName || user.last_name || '';
    const initials = `${firstName[0] || ''}${lastName[0] || ''}`.toUpperCase();
    main.innerHTML = `
      <div class="mb-stack-lg">
        <h1 class="font-display text-h1 text-on-surface tracking-tight">My Profile</h1>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">View your account and agency information.</p>
      </div>

      ${agencyMarkup}

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-stack-md">
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding text-center">
          <div class="w-24 h-24 rounded-full bg-secondary mx-auto flex items-center justify-center text-on-secondary text-h1 font-semibold">${initials || 'U'}</div>
          <h2 class="font-h1 text-h1 text-on-surface mt-stack-md">${this.esc(`${firstName} ${lastName}`.trim())}</h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">${this.esc(user.email || '')}</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${this.esc(user.hierarchyRole || user.hierarchy_role || user.role || 'User')}</p>
          <div class="mt-stack-md pt-stack-md border-t border-outline-variant/30">
            <p class="font-label-md text-label-md uppercase text-on-surface-variant">Last login</p>
            <p class="font-body-md text-body-md text-on-surface mt-1">${user.lastLogin ? this.esc(new Date(user.lastLogin).toLocaleString()) : 'Just now'}</p>
          </div>
        </div>

        <div class="lg:col-span-2 space-y-stack-md">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-h3 text-h3 text-on-surface mb-stack-md">User Information</h3>
            <div class="grid grid-cols-2 gap-stack-md">
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">First name</p><p class="font-body-md text-on-surface mt-1">${this.value(firstName)}</p></div>
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">Last name</p><p class="font-body-md text-on-surface mt-1">${this.value(lastName)}</p></div>
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">Email</p><p class="font-body-md text-on-surface mt-1">${this.value(user.email)}</p></div>
              <div><p class="font-label-md text-label-md uppercase text-on-surface-variant">Role</p><p class="font-body-md text-on-surface mt-1 capitalize">${this.value(user.hierarchyRole || user.hierarchy_role || user.role)}</p></div>
            </div>
          </div>

          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-h3 text-h3 text-on-surface mb-stack-md">Change Password</h3>
            <form id="pwd-form" class="space-y-stack-md">
              <div><label for="profile-current-password" class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Current password</label><div class="relative"><input id="profile-current-password" name="current" type="password" required autocomplete="current-password" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 pr-12 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/><button id="toggle-current-password" type="button" class="absolute inset-y-0 right-0 flex items-center px-3 text-on-surface-variant hover:text-on-surface" aria-label="Show current password" aria-pressed="false"><span class="material-symbols-outlined" aria-hidden="true">visibility</span></button></div></div>
              <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">New password</label><input name="next" type="password" required minlength="8" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/></div>
              <div><label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Confirm new password</label><input name="confirm" type="password" required minlength="8" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/></div>
              <div class="flex justify-end pt-stack-sm border-t border-outline-variant/30"><button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Update password</button></div>
            </form>
          </div>

          <div class="bg-surface-container-lowest rounded-xl border border-error/30 p-container-padding">
            <h3 class="font-h3 text-h3 text-on-surface mb-stack-sm">Danger zone</h3>
            <p class="font-body-sm text-body-sm text-on-surface-variant mb-stack-md">Sign out of your current session.</p>
            <button id="logout-btn" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90 flex items-center gap-stack-sm"><span class="material-symbols-outlined text-[18px]">logout</span> Logout</button>
          </div>
        </div>
      </div>
    `;
    const currentPasswordInput = document.getElementById('profile-current-password');
    const toggleCurrentPassword = document.getElementById('toggle-current-password');
    toggleCurrentPassword.addEventListener('click', () => {
      const isVisible = currentPasswordInput.type === 'text';
      currentPasswordInput.type = isVisible ? 'password' : 'text';
      toggleCurrentPassword.setAttribute('aria-pressed', String(!isVisible));
      toggleCurrentPassword.setAttribute('aria-label', isVisible ? 'Show current password' : 'Hide current password');
      toggleCurrentPassword.querySelector('.material-symbols-outlined').textContent = isVisible ? 'visibility' : 'visibility_off';
    });
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
