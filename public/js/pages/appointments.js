window.PageModules = window.PageModules || {};

window.PageModules.appointments = {
  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg flex-wrap gap-stack-md">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Appointments</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Schedule and manage appointments.</p>
        </div>
        <button id="apt-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 transition-colors">
          <span class="material-symbols-outlined text-[18px]">add</span> New Appointment
        </button>
      </div>
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <div class="p-container-padding border-b border-outline-variant/30">
          <div class="flex flex-wrap items-center gap-stack-md">
            <select id="apt-filter-outcome" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm">
              <option value="">All outcomes</option>
              <option value="completed">Completed</option>
              <option value="rescheduled">Rescheduled</option>
              <option value="cancelled">Cancelled</option>
              <option value="no_show">No Show</option>
              <option value="interested">Interested</option>
              <option value="not_interested">Not Interested</option>
            </select>
          </div>
        </div>
        <div id="appointments-table"></div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => {};
  },

  bindEvents() {
    document.getElementById('apt-new')?.addEventListener('click', () => this.openForm());
    document.getElementById('apt-filter-outcome')?.addEventListener('change', (e) => { this.outcomeFilter = e.target.value; this.load(); });
  },

  async load() {
    const container = document.getElementById('appointments-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';

    try {
      const params = {};
      if (this.outcomeFilter) params.outcome = this.outcomeFilter;
      const res = await API.get('/appointments', { limit: 100, ...params });
      const items = res?.items || res?.data?.items || [];

      if (!items.length) {
        container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[48px] text-on-surface-variant/40 mb-2">event_busy</span><p class="font-body-md text-body-md text-on-surface-variant">No appointments found</p></div>';
        return;
      }

      container.innerHTML = '<table class="w-full"><thead class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase tracking-wider"><tr><th class="text-left py-2 px-2 font-semibold">Title</th><th class="text-left py-2 px-2 font-semibold">Contact</th><th class="text-left py-2 px-2 font-semibold">Start</th><th class="text-left py-2 px-2 font-semibold">End</th><th class="text-left py-2 px-2 font-semibold">Location</th><th class="text-left py-2 px-2 font-semibold">Outcome</th></tr></thead><tbody class="divide-y divide-outline-variant/30 font-body-md text-body-md text-on-surface">' + items.map(a => '<tr><td class="py-2.5 px-2">' + (a.title || '') + '</td><td class="py-2.5 px-2">' + (a.firstName || '') + ' ' + (a.lastName || '') + '</td><td class="py-2.5 px-2 text-on-surface-variant">' + new Date(a.startTime).toLocaleString() + '</td><td class="py-2.5 px-2 text-on-surface-variant">' + (a.endTime ? new Date(a.endTime).toLocaleString() : '—') + '</td><td class="py-2.5 px-2 text-on-surface-variant">' + (a.location || '—') + '</td><td class="py-2.5 px-2">' + StatusBadge.render(a.outcome || 'scheduled') + '</td></tr>').join('') + '</tbody></table>';
    } catch (err) {
      container.innerHTML = '<div class="p-12 text-center"><p class="font-body-md text-body-md text-error">Failed to load appointments</p></div>';
    }
  },

  async openForm() {
    const modal = new Modal({
      title: 'New Appointment',
      size: 'lg',
      content: `
        <form id="apt-form" class="flex flex-col gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Related To *</label>
            <div class="flex items-center gap-stack-sm mb-2">
              <label class="flex items-center gap-1 text-body-sm"><input type="radio" name="relatedType" value="contact" checked/> Contact</label>
              <label class="flex items-center gap-1 text-body-sm"><input type="radio" name="relatedType" value="organization"/> Organization</label>
            </div>
            <div id="apt-contact-wrap"><div id="apt-contact-selector"></div></div>
            <div id="apt-org-wrap" class="hidden"><div id="apt-org-selector"></div></div>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Title *</label>
            <input name="title" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div class="grid grid-cols-2 gap-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Start Time *</label>
              <input name="start_time" type="datetime-local" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">End Time</label>
              <input name="end_time" type="datetime-local" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
            </div>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Location</label>
            <input name="location" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Create</button>
          </div>
        </form>
      `,
    });
    modal.open();

    let related = null;
    const contactWrap = modal.element.querySelector('#apt-contact-wrap');
    const orgWrap = modal.element.querySelector('#apt-org-wrap');
    const contactSelector = new EntitySelector(modal.element.querySelector('#apt-contact-selector'), {
      type: 'contact', placeholder: 'Select contact...', allowCreate: true,
      onCreate: () => window.PageModules.contacts.openFormAndWait(),
      onChange: (c) => { related = c ? { contactId: c.id, organizationId: c.organizationId || c.organization_id || null } : null; },
    });
    const orgSelector = new EntitySelector(modal.element.querySelector('#apt-org-selector'), {
      type: 'organization', placeholder: 'Select organization...',
      onChange: (o) => { related = o ? { organizationId: o.id, contactId: null } : null; },
    });
    modal.element.querySelectorAll('input[name="relatedType"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isOrg = radio.value === 'organization' && radio.checked;
        orgWrap.classList.toggle('hidden', !isOrg);
        contactWrap.classList.toggle('hidden', isOrg);
        related = null;
      });
    });

    modal.element.querySelector('#apt-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!related) { Toast.error('Select a contact or organization'); return; }
      const fd = new FormData(e.target);
      try {
        await API.post('/appointments', {
          title: fd.get('title'),
          start_time: fd.get('start_time'),
          end_time: fd.get('end_time'),
          location: fd.get('location'),
          contact_id: related.contactId || null,
          organization_id: related.organizationId || null,
        });
        Toast.success('Appointment created');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },
};
