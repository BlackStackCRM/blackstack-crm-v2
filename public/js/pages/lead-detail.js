window.PageModules = window.PageModules || {};

window.PageModules.leadDetail = {
  currentId: null,
  activeTab: 'overview',
  currentCurrency: 'USD',

  async init(id) {
    if (!id) {
      const hash = window.location.hash.replace('#', '');
      id = hash.startsWith('leads/') ? hash.split('/')[1] : null;
    }
    if (!id) { window.location.hash = 'leads'; return () => {}; }
    this.currentId = id;

    const main = document.getElementById('page-container');
    if (!main) return () => {};

    main.innerHTML = [
      '<div class="mb-stack-md"><a href="#leads" class="inline-flex items-center gap-1 text-secondary font-body-sm hover:underline"><span class="material-symbols-outlined text-[16px]">arrow_back</span> Back to Leads</a></div>',
      '<div id="lead-header" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding mb-stack-md"></div>',
      '<div class="flex items-center gap-stack-sm mb-stack-md overflow-x-auto pb-1">',
        '<button data-tab="overview" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Overview</button>',
        '<button data-tab="activities" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Activities</button>',
        '<button data-tab="tasks" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Tasks</button>',
        '<button data-tab="appointments" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Appointments</button>',
        '<button data-tab="timeline" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Timeline</button>',
      '</div>',
      '<div id="tab-content" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding"></div>',
    ].join('');

    this.bindEvents();
    await this.load();
    this.switchTab(this.activeTab);
    return () => {};
  },

  bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
  },

  async load() {
    try {
      // Load default currency from settings
      try {
        const settings = await API.get('/settings', {}, { silent: true });
        this.currentCurrency = settings.defaultCurrency || 'USD';
      } catch { /* use default */ }
      const [leadRes, contactRes] = await Promise.all([
        API.get('/leads/' + this.currentId),
        API.get('/contacts/' + this.currentId).catch(() => null)
      ]);
      const lead = leadRes || {};
      const contact = contactRes || {};
      this.renderHeader(lead, contact);
    } catch {
      this.renderHeader({}, {});
    }
  },

  fmt(n, currency) { return Currency.format(n, currency || this.currentCurrency); },

  renderHeader(lead, contact) {
    const h = document.getElementById('lead-header');
    if (!h) return;
    const name = (contact.firstName || '') + ' ' + (contact.lastName || '');
    const initials = ((contact.firstName?.[0] || '') + (contact.lastName?.[0] || '')).toUpperCase() || 'L';
    h.innerHTML = [
      '<div class="flex items-start justify-between gap-stack-md flex-wrap">',
        '<div class="flex items-center gap-stack-md">',
          '<div class="w-16 h-16 rounded-full bg-secondary flex items-center justify-center text-on-secondary text-h3 font-semibold">' + initials + '</div>',
          '<div>',
            '<h1 class="font-display text-h1 text-on-surface">' + name + '</h1>',
            '<p class="font-body-md text-body-md text-on-surface-variant mt-1">' + (contact.email || '—') + ' · ' + (contact.phone || '—') + '</p>',
            '<div class="flex items-center gap-stack-sm mt-2 flex-wrap">',
              '<span class="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-secondary-container/10 text-secondary">' + (lead.leadStatus || lead.lead_status || 'NEW') + '</span>',
              '<span class="text-body-sm text-on-surface-variant">Score: ' + (lead.leadScore || lead.lead_score || 0) + '</span>',
              '<span class="text-body-sm text-on-surface-variant">Source: ' + (lead.source || 'manual') + '</span>',
            '</div>',
          '</div>',
        '</div>',
        '<div class="flex gap-stack-sm flex-wrap">',
          '<a href="#contacts/' + (lead.contactId || lead.contact_id || contact.id) + '" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-4 py-2 rounded-lg hover:bg-surface-container"><span class="material-symbols-outlined text-[18px]">contacts</span> Contact</a>',
          '<button id="lead-edit" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>',
          '<button id="lead-qualify" class="flex items-center gap-1 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"><span class="material-symbols-outlined text-[18px]">check_circle</span> Qualify</button>',
        '</div>',
      '</div>',
    ].join('');
    document.getElementById('lead-edit')?.addEventListener('click', () => this.openEditModal(lead, contact));
    document.getElementById('lead-qualify')?.addEventListener('click', () => this.qualifyLead(lead));
  },

  switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('bg-secondary', active);
      b.classList.toggle('text-on-secondary', active);
      b.classList.toggle('text-on-surface-variant', !active);
      b.classList.toggle('hover:bg-surface-container', !active);
    });
    const renderers = {
      overview: () => this.renderOverview(),
      activities: () => this.renderList('/activities', { contactId: this.currentId }, 'No activities'),
      tasks: () => this.renderList('/tasks', { contactId: this.currentId }, 'No tasks'),
      appointments: () => this.renderAppointments(),
      timeline: () => this.renderTimeline(),
    };
    renderers[tab]();
  },

  async renderOverview() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const [leadRes, dealRes] = await Promise.all([
        API.get('/leads/' + this.currentId),
        API.get('/deals', { contactId: this.currentId }).catch(() => ({ items: [] }))
      ]);
      const lead = leadRes || {};
      const deals = dealRes?.items || dealRes?.data?.items || [];
      c.innerHTML = [
        '<div class="grid grid-cols-2 md:grid-cols-3 gap-stack-md">',
          this.infoCard('Status', lead.leadStatus || lead.lead_status || 'NEW'),
          this.infoCard('Score', (lead.leadScore || lead.lead_score || 0) + ' pts'),
          this.infoCard('Budget', this.fmt(lead.budget)),
          this.infoCard('Timeline', lead.timeline || '—'),
          this.infoCard('Interest', lead.interestLevel || lead.interest_level || '—'),
          this.infoCard('Decision Maker', lead.decisionMaker || lead.decision_maker || '—'),
        '</div>',
        deals.length ? '<div class="mt-stack-md"><h3 class="font-h3 text-h3 mb-2">Related Deals</h3>' + deals.map(d => '<a href="#deals/' + d.id + '" class="block p-stack-md bg-surface-container-low rounded-lg hover:bg-surface-container mb-2"><p class="font-body-md text-on-surface">' + (d.title || '') + '</p><p class="font-body-sm text-on-surface-variant">' + this.fmt(d.value, d.currency) + ' · ' + (d.status || '') + '</p></a>').join('') + '</div>' : '',
      ].join('');
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">Unable to load</p>'; }
  },

  infoCard(label, value) {
    return '<div class="bg-surface-container-low rounded-lg p-stack-md"><p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">' + label + '</p><p class="font-body-md text-body-md text-on-surface mt-1">' + value + '</p></div>';
  },

  async renderList(endpoint, params, emptyMsg) {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get(endpoint, params);
      const items = res?.items || res?.data?.items || res || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">' + emptyMsg + '</p>'; return; }
      c.innerHTML = '<table class="w-full"><thead class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase tracking-wider"><tr><th class="text-left py-2 px-2 font-semibold">Title</th><th class="text-left py-2 px-2 font-semibold">Date</th><th class="text-left py-2 px-2 font-semibold">Status</th></tr></thead><tbody class="divide-y divide-outline-variant/30 font-body-md text-body-md text-on-surface">' + items.map(i => '<tr><td class="py-2.5 px-2">' + (i.title || '') + '</td><td class="py-2.5 px-2 text-on-surface-variant">' + new Date(i.created_at || i.date).toLocaleDateString() + '</td><td class="py-2.5 px-2">' + (StatusBadge.render(i.status) || '') + '</td></tr>').join('') + '</tbody></table>';
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">' + emptyMsg + '</p>'; }
  },

  async renderAppointments() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/appointments', { contactId: this.currentId });
      const items = res?.items || res?.data?.items || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No appointments</p>'; return; }
      c.innerHTML = items.map(a => '<div class="py-stack-sm border-b border-outline-variant/30 last:border-0"><p class="font-body-md text-on-surface">' + (a.title || '') + '</p><p class="font-body-sm text-body-sm text-on-surface-variant">' + new Date(a.start_time).toLocaleString() + ' · ' + (a.location || '') + '</p></div>').join('');
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No appointments</p>'; }
  },

  async renderTimeline() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const [activities, tasks, appointments] = await Promise.all([
        API.get('/activities', { contactId: this.currentId }).catch(() => ({ items: [] })),
        API.get('/tasks', { contactId: this.currentId }).catch(() => ({ items: [] })),
        API.get('/appointments', { contactId: this.currentId }).catch(() => ({ items: [] }))
      ]);
      const items = [
        ...(activities.items || activities.data?.items || []).map(a => ({ ...a, _type: 'activity' })),
        ...(tasks.items || tasks.data?.items || []).map(t => ({ ...t, _type: 'task' })),
        ...(appointments.items || appointments.data?.items || []).map(a => ({ ...a, _type: 'appointment' })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No timeline events</p>'; return; }
      const icons = { activity: 'history', task: 'task_alt', appointment: 'event' };
      c.innerHTML = items.map(item => '<div class="flex items-start gap-stack-md py-stack-sm border-b border-outline-variant/30 last:border-0"><div class="w-8 h-8 rounded-full bg-secondary-container/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[16px] text-secondary">' + (icons[item._type] || 'history') + '</span></div><div class="flex-1"><p class="font-body-md text-on-surface">' + (item.title || item.description || '') + '</p><p class="font-body-sm text-body-sm text-on-surface-variant">' + new Date(item.created_at).toLocaleString() + '</p></div></div>').join('');
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No timeline events</p>'; }
  },

  qualifyLead(lead) {
    const modal = new Modal({
      title: 'Qualify Lead',
      size: 'md',
      content: `
        <form id="qualify-form" class="flex flex-col gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Interest Level</label>
            <select name="interest_level" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
              <option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
            </select>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Budget</label>
            <input name="budget" type="number" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Timeline</label>
            <input name="timeline" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Decision Maker</label>
            <input name="decision_maker" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save Qualification</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#qualify-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.put('/leads/' + this.currentId, {
          lead_status: 'QUALIFIED',
          interest_level: fd.get('interest_level'),
          budget: fd.get('budget'),
          timeline: fd.get('timeline'),
          decision_maker: fd.get('decision_maker'),
        });
        Toast.success('Lead qualified');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  openEditModal(lead, contact) {
    const modal = new Modal({
      title: 'Edit Lead',
      size: 'lg',
      content: `
        <form id="edit-lead-form" class="flex flex-col gap-stack-md">
          <div class="grid grid-cols-2 gap-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">First Name</label>
              <input name="firstName" value="${contact.firstName || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Last Name</label>
              <input name="lastName" value="${contact.lastName || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
            </div>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Status</label>
            <select name="lead_status" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
              ${['NEW','CONTACTED','QUALIFIED','UNQUALIFIED','NURTURE','CONVERTED','LOST'].map(s => '<option value="' + s + '" ' + (lead.leadStatus === s ? 'selected' : '') + '>' + s + '</option>').join('')}
            </select>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Save</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#edit-lead-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.put('/contacts/' + (lead.contactId || lead.contact_id || this.currentId), { firstName: fd.get('firstName'), lastName: fd.get('lastName') });
        await API.put('/leads/' + this.currentId, { lead_status: fd.get('lead_status') });
        Toast.success('Lead updated');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },
};
