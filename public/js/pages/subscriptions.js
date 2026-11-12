window.PageModules = window.PageModules || {};
window.PageModules.subscriptions = {
  async init() {
    const root = document.getElementById('page-container');
    if (!root) return () => {};
    root.innerHTML = '<div class="max-w-7xl mx-auto p-6"><h1 class="text-3xl font-semibold mb-2">Subscription Management</h1><p class="mb-6 text-on-surface-variant">Central Mother Company administration of plans, assignments, status and renewals.</p><div id="subscription-data">Loading…</div></div>';
    const el = document.getElementById('subscription-data');
    const esc = (v) => String(v == null ? '—' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(v || 0) / 100);
    const dt = (v) => v ? new Date(v).toLocaleString() : '—';
    const subscriptionUrl = (id) => `/subscriptions/${encodeURIComponent(id)}`;

    try {
      const [data, walletData] = await Promise.all([API.get('/subscriptions'), API.get('/wallet')]);
      const plans = data.plans || [];
      const subs = data.subscriptions || [];
      const renewals = data.renewals || [];
      const wallets = walletData.wallets || [];

      let html = '<section class="rounded-xl border border-outline-variant p-5 mb-6"><h2 class="mb-4 text-xl">Create subscription plan</h2><form id="plan-form" class="grid gap-3 md:grid-cols-4"><input name="name" required maxlength="100" placeholder="Plan name" class="rounded-lg border p-3"><select name="accountType" class="rounded-lg border p-3"><option value="agency">Distribution Agency</option><option value="sub_agency">Sub-agency</option><option value="customer_tenant">Customer</option></select><input name="price" type="number" min="0.01" step="0.01" required placeholder="Price (INR)" class="rounded-lg border p-3"><input name="durationValue" type="number" min="1" required placeholder="Duration" class="rounded-lg border p-3"><select name="durationUnit" class="rounded-lg border p-3"><option value="day">Days</option><option value="month">Months</option><option value="year">Years</option></select><input name="description" maxlength="300" placeholder="Description" class="rounded-lg border p-3 md:col-span-2"><label class="flex items-center gap-2"><input type="checkbox" name="autoRenew" checked> Auto-renew</label><button class="rounded-lg bg-primary px-4 py-2 text-white">Save plan</button></form></section>';
      html += '<section class="rounded-xl border border-outline-variant p-5 mb-6"><h2 class="mb-4 text-xl">Assign subscription</h2><form id="assign-form" class="grid gap-3 md:grid-cols-4"><select name="companyId" required class="rounded-lg border p-3">' + wallets.map((w) => `<option value="${esc(w.companyId)}">${esc(w.accountName)} · ${esc(w.type)}</option>`).join('') + '</select><select name="planId" required class="rounded-lg border p-3">' + plans.filter((p) => p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.accountType)} · ${money(p.priceMinor)}</option>`).join('') + '</select><input name="startsAt" type="datetime-local" class="rounded-lg border p-3"><input name="expiresAt" type="datetime-local" class="rounded-lg border p-3"><button class="rounded-lg bg-primary px-4 py-2 text-white md:col-span-4">Assign subscription</button></form></section>';
      html += '<section class="rounded-xl border border-outline-variant p-5 mb-6"><h2 class="mb-4 text-xl">Plans</h2><div class="overflow-auto"><table class="w-full text-left"><thead><tr><th class="p-2">Name</th><th class="p-2">Account type</th><th class="p-2">Price</th><th class="p-2">Duration</th><th class="p-2">Auto-renew</th><th class="p-2">Status</th><th class="p-2">Actions</th></tr></thead><tbody>' + plans.map((p) => `<tr class="border-t"><td class="p-2">${esc(p.name)}</td><td class="p-2">${esc(p.accountType)}</td><td class="p-2">${money(p.priceMinor)}</td><td class="p-2">${esc(p.durationValue || p.durationDays)} ${esc(p.durationUnit || 'day')}</td><td class="p-2">${p.autoRenew ? 'Yes' : 'No'}</td><td class="p-2">${p.active ? 'Active' : 'Inactive'}</td><td class="p-2"><button class="plan-toggle underline" data-id="${esc(p.id)}" data-active="${!p.active}">${p.active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('') + `<tr><td colspan="7" class="p-3">${plans.length ? '' : 'No plans configured.'}</td></tr></tbody></table></div></section>`;

      html += '<section class="rounded-xl border border-outline-variant p-5 mb-6"><h2 class="mb-4 text-xl">All subscriptions</h2><div class="overflow-auto"><table class="w-full text-left"><thead><tr><th class="p-2">Account</th><th class="p-2">Plan</th><th class="p-2">Price</th><th class="p-2">Start</th><th class="p-2">Expiry</th><th class="p-2">Status</th><th class="p-2">Payment</th><th class="p-2">Actions</th></tr></thead><tbody>' + subs.map((s) => `<tr class="border-t"><td class="p-2">${esc(s.accountName)}<small class="block text-on-surface-variant">${esc(s.accountType)}</small></td><td class="p-2">${esc(s.planName)}</td><td class="p-2">${money(s.amountMinor)}</td><td class="p-2">${dt(s.startsAt)}</td><td class="p-2">${dt(s.endDate || s.expiresAt)}</td><td class="p-2">${esc(s.status)}</td><td class="p-2">${esc(s.paymentStatus)}</td><td class="p-2"><details class="relative inline-block text-left"><summary aria-label="Actions for ${esc(s.accountName)}" title="Actions" class="list-none cursor-pointer rounded-md border px-3 py-1 text-xl leading-6 hover:bg-surface-container">⋮</summary><div class="absolute right-0 z-20 mt-1 min-w-52 rounded-lg border bg-surface p-1 shadow-lg"><button class="subscription-action block w-full rounded px-3 py-2 text-left hover:bg-surface-container" data-action="details" data-id="${esc(s.id)}">View Details</button><button class="subscription-action block w-full rounded px-3 py-2 text-left hover:bg-surface-container" data-action="renew" data-id="${esc(s.id)}">Renew Subscription</button><button class="subscription-action block w-full rounded px-3 py-2 text-left hover:bg-surface-container" data-action="status" data-id="${esc(s.id)}" data-status="${esc(s.status)}">Change Status</button><button class="subscription-action block w-full rounded px-3 py-2 text-left hover:bg-surface-container" data-action="autorenew" data-id="${esc(s.id)}" data-auto="${!s.autoRenew}">Turn auto-renew ${s.autoRenew ? 'Off' : 'On'}</button><button class="subscription-action block w-full rounded px-3 py-2 text-left text-error hover:bg-error-container/20" data-action="delete" data-id="${esc(s.id)}">Delete Subscription</button></div></details></td></tr>`).join('') + `<tr><td colspan="8" class="p-3">${subs.length ? '' : 'No subscriptions assigned.'}</td></tr></tbody></table></div></section>`;
      html += '<section class="rounded-xl border border-outline-variant p-5"><h2 class="mb-4 text-xl">Renewal history and pending payments</h2><div class="overflow-auto"><table class="w-full text-left"><thead><tr><th class="p-2">Account</th><th class="p-2">Amount</th><th class="p-2">Status</th><th class="p-2">Message</th><th class="p-2">Attempted</th></tr></thead><tbody>' + renewals.map((r) => `<tr class="border-t"><td class="p-2">${esc(r.accountName)}</td><td class="p-2">${money(r.amountMinor)}</td><td class="p-2">${esc(r.status)}</td><td class="p-2">${esc(r.message)}</td><td class="p-2">${dt(r.attemptedAt)}</td></tr>`).join('') + `<tr><td colspan="5" class="p-3">${renewals.length ? '' : 'No renewal attempts yet.'}</td></tr></tbody></table></div></section>`;
      el.innerHTML = html;

      el.querySelectorAll('.plan-toggle').forEach((button) => button.addEventListener('click', async () => {
        try { await API.patch('/subscriptions/plans/' + encodeURIComponent(button.dataset.id), { active: button.dataset.active === 'true' }); Toast.success('Plan status updated.'); await this.init(); }
        catch (err) { Toast.error(err.message || 'Could not update plan.'); }
      }));
      document.getElementById('plan-form').addEventListener('submit', async (event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        try { await API.post('/subscriptions/plans', { name: form.get('name'), accountType: form.get('accountType'), price: Number(form.get('price')), durationValue: Number(form.get('durationValue')), durationUnit: form.get('durationUnit'), description: form.get('description'), autoRenew: form.has('autoRenew') }); Toast.success('Plan created.'); await this.init(); }
        catch (err) { Toast.error(err.message || 'Could not create plan.'); }
      });
      document.getElementById('assign-form').addEventListener('submit', async (event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget); const body = { planId: form.get('planId') };
        if (form.get('startsAt')) body.startsAt = new Date(form.get('startsAt')).toISOString();
        if (form.get('expiresAt')) body.expiresAt = new Date(form.get('expiresAt')).toISOString();
        try { await API.post('/subscriptions/' + encodeURIComponent(form.get('companyId')) + '/assign', body); Toast.success('Subscription assigned.'); await this.init(); }
        catch (err) { Toast.error(err.message || 'Could not assign subscription.'); }
      });

      el.querySelectorAll('.subscription-action').forEach((button) => button.addEventListener('click', async () => {
        const id = button.dataset.id;
        const action = button.dataset.action;
        button.closest('details')?.removeAttribute('open');
        if (action === 'autorenew') {
          try { await API.patch(subscriptionUrl(id), { autoRenew: button.dataset.auto === 'true' }); Toast.success('Auto-renew setting updated.'); await this.init(); }
          catch (err) { Toast.error(err.message || 'Could not update renewal setting.'); }
          return;
        }
        if (action === 'delete') {
          if (!window.confirm('Permanently delete this subscription record? The account and company will remain unchanged.')) return;
          try { await API.del(subscriptionUrl(id)); Toast.success('Subscription deleted.'); await this.init(); }
          catch (err) { Toast.error(err.message || 'Could not delete subscription. Payment history may prevent deletion.'); }
          return;
        }
        if (action === 'details') return this.openDetails(id, { esc, dt, money, subscriptionUrl });
        if (action === 'renew') return this.openRenewModal(id, { esc, subscriptionUrl });
        if (action === 'status') return this.openStatusModal(id, button.dataset.status, { subscriptionUrl });
      }));
    } catch (err) {
      el.innerHTML = `<div class="rounded-lg border border-error p-4 text-error">${esc(err.message || 'Unable to load subscription controls.')}</div>`;
    }
    return () => {};
  },

  async openDetails(id, helpers) {
    const { esc, dt, money, subscriptionUrl } = helpers;
    try {
      const s = await API.get(subscriptionUrl(id));
      const rows = [
        ['Account', s.accountName], ['Account type', s.accountType], ['Plan', s.planName || s.currentPlanName],
        ['Amount', money(s.amountMinor)], ['Start date', dt(s.startsAt)], ['End date', dt(s.endDate || s.expiresAt)],
        ['Status', s.status], ['Payment status', s.paymentStatus], ['Provider payment ID', s.providerPaymentId], ['Created at', dt(s.createdAt)],
      ];
      const content = `<dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">${rows.map(([label, value]) => `<div class="rounded-lg bg-surface-container-low p-3"><dt class="text-sm text-on-surface-variant">${esc(label)}</dt><dd class="mt-1 break-words font-medium">${esc(value)}</dd></div>`).join('')}</dl>`;
      new Modal({ title: 'Subscription details', size: 'md', content }).open();
    } catch (err) { Toast.error(err.message || 'Could not load subscription details.'); }
  },

  openRenewModal(id, helpers) {
    const { subscriptionUrl } = helpers;
    const modal = new Modal({ title: 'Renew subscription', size: 'sm', content: `<form id="subscription-renew-form" class="flex flex-col gap-4"><p class="text-on-surface-variant">Extend the subscription end date. The current status is preserved.</p><label class="flex flex-col gap-1">Duration<input name="amount" type="number" min="1" step="1" value="30" required class="rounded-lg border p-3"></label><label class="flex flex-col gap-1">Unit<select name="unit" class="rounded-lg border p-3"><option value="day">Days</option><option value="month">Months</option></select></label><div class="flex justify-end gap-2"><button type="button" data-modal-close class="rounded-lg border px-4 py-2">Cancel</button><button class="rounded-lg bg-primary px-4 py-2 text-white">Extend</button></div></form>` });
    modal.open();
    modal.element.querySelectorAll('[data-modal-close]').forEach((button) => button.addEventListener('click', () => modal.close()));
    modal.element.querySelector('#subscription-renew-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      try { await API.patch(`${subscriptionUrl(id)}/expiry`, { amount: Number(form.get('amount')), unit: form.get('unit') }); Toast.success('Subscription end date extended.'); modal.close(); await this.init(); }
      catch (err) { Toast.error(err.message || 'Could not extend subscription.'); }
    });
  },

  openStatusModal(id, currentStatus, helpers) {
    const { subscriptionUrl } = helpers;
    const statuses = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'PENDING', 'CANCELLED'];
    const options = statuses.map((status) => `<option value="${status}" ${String(currentStatus).toUpperCase() === status ? 'selected' : ''}>${status}</option>`).join('');
    const modal = new Modal({ title: 'Change subscription status', size: 'sm', content: `<form id="subscription-status-form" class="flex flex-col gap-4"><p class="text-on-surface-variant">Setting status to ACTIVE is a manual platform override and will be recorded in the audit log.</p><label class="flex flex-col gap-1">Status<select name="status" class="rounded-lg border p-3">${options}</select></label><div class="flex justify-end gap-2"><button type="button" data-modal-close class="rounded-lg border px-4 py-2">Cancel</button><button class="rounded-lg bg-primary px-4 py-2 text-white">Save status</button></div></form>` });
    modal.open();
    modal.element.querySelectorAll('[data-modal-close]').forEach((button) => button.addEventListener('click', () => modal.close()));
    modal.element.querySelector('#subscription-status-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      try { await API.patch(`${subscriptionUrl(id)}/status`, { status: form.get('status') }); Toast.success('Subscription status updated.'); modal.close(); await this.init(); }
      catch (err) { Toast.error(err.message || 'Could not update subscription status.'); }
    });
  },
};
