window.PageModules = window.PageModules || {};

window.PageModules.contactDetail = {
  currentId: null,
  activeTab: 'overview',
  currentCurrency: 'INR',

  async init(id) {
    if (!id) {
      const hash = window.location.hash.replace('#', '');
      id = hash.startsWith('contacts/') ? hash.split('/')[1] : null;
    }
    if (!id) { window.location.hash = 'contacts'; return () => {}; }
    // Load default currency from settings
    try {
      const settings = await API.get('/settings');
      this.currentCurrency = settings.defaultCurrency || 'INR';
    } catch { /* use default */ }
    this.currentId = id;

    const main = document.getElementById('page-container');
    if (!main) return () => {};

    main.innerHTML = `
      <div class="mb-stack-md">
        <a href="#contacts" class="inline-flex items-center gap-1 text-secondary font-body-sm hover:underline">
          <span class="material-symbols-outlined text-[16px]">arrow_back</span> Back to Contacts
        </a>
      </div>
      <div id="contact-header" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding mb-stack-md"></div>

      <div class="flex items-center gap-stack-sm mb-stack-md flex-wrap">
        <button data-tab="overview" class="tab-btn px-4 py-2 rounded-lg font-body-sm">Overview</button>
        <button data-tab="deals" class="tab-btn px-4 py-2 rounded-lg font-body-sm">Deals</button>
        <button data-tab="activities" class="tab-btn px-4 py-2 rounded-lg font-body-sm">Activities</button>
        <button data-tab="tasks" class="tab-btn px-4 py-2 rounded-lg font-body-sm">Tasks</button>
        <button data-tab="appointments" class="tab-btn px-4 py-2 rounded-lg font-body-sm">Appointments</button>
        <button data-tab="notes" class="tab-btn px-4 py-2 rounded-lg font-body-sm">Notes</button>
        <button data-tab="timeline" class="tab-btn px-4 py-2 rounded-lg font-body-sm">Timeline</button>
        <div class="ml-auto flex gap-stack-sm">
          <button id="cd-call" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-3 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[16px]">call</span> Call</button>
          <button id="cd-email" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-3 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[16px]">mail</span> Email</button>
          <button id="cd-add-activity" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-3 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[16px]">add</span> Activity</button>
          <button id="cd-add-task" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-3 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[16px]">add</span> Task</button>
          <button id="cd-add-note" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-3 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[16px]">add</span> Note</button>
        </div>
      </div>

      <div id="tab-content" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding"></div>
    `;

    this.bindEvents();
    await this.load();
    this.switchTab(this.activeTab);

    return () => {};
  },

  bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
    document.getElementById('cd-add-activity')?.addEventListener('click', () => this.quickAdd('activity'));
    document.getElementById('cd-add-task')?.addEventListener('click', () => this.quickAdd('task'));
    document.getElementById('cd-add-note')?.addEventListener('click', () => this.quickAdd('note'));
    document.getElementById('cd-call')?.addEventListener('click', () => this.logCommunication('call'));
    document.getElementById('cd-email')?.addEventListener('click', () => this.logCommunication('email'));
  },

  async load() {
    try {
      const [contactRes, leadRes] = await Promise.all([
        API.get('/contacts/' + this.currentId),
        API.get('/leads', { contact_id: this.currentId }).catch(() => ({ items: [] }))
      ]);
      const c = contactRes || {};
      const leads = leadRes?.items || leadRes?.data?.items || [];
      const lead = leads[0] || {};
      this.renderHeader(c, lead);
    } catch (err) {
      this.renderHeader({ firstName: 'Contact', lastName: '#' + this.currentId, email: '—', phone: '—', organization: null, tags: [] }, {});
    }
  },

  renderHeader(c, lead) {
    const header = document.getElementById('contact-header');
    if (!header) return;
    const initials = ((c.firstName?.[0] || '') + (c.lastName?.[0] || '')).toUpperCase() || 'C';
    header.innerHTML = `
      <div class="flex items-start justify-between gap-stack-md flex-wrap">
        <div class="flex items-center gap-stack-md">
          <div class="w-16 h-16 rounded-full bg-secondary flex items-center justify-center text-on-secondary text-h3 font-semibold">${initials}</div>
          <div>
            <h1 class="font-display text-h1 text-on-surface">${c.firstName || ''} ${c.lastName || ''}</h1>
            <p class="font-body-md text-body-md text-on-surface-variant mt-1">${c.email || '—'} · ${c.phone || '—'}</p>
            <div class="flex items-center gap-stack-sm mt-2 flex-wrap">
              ${c.organization ? `<span class="inline-flex items-center gap-1 text-body-sm text-on-surface-variant"><span class="material-symbols-outlined text-[14px]">corporate_fare</span> ${c.organization.name || ''}</span>` : ''}
              ${(c.tags || []).map(t => `<span class="inline-block bg-secondary-container/10 text-secondary px-2 py-0.5 rounded text-[11px]">${t.name || t}</span>`).join('')}
              ${c.status ? StatusBadge.render(c.status) : ''}
              ${lead.leadStatus || lead.lead_status ? StatusBadge.render(lead.leadStatus || lead.lead_status) : ''}
            </div>
          </div>
        </div>
        <div class="flex gap-stack-sm">
          <button id="cd-edit" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>
          <a href="#deals" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-4 py-2 rounded-lg hover:bg-surface-container"><span class="material-symbols-outlined text-[18px]">handshake</span> Deals</a>
        </div>
      </div>
    `;
    document.getElementById('cd-edit')?.addEventListener('click', () => {
      if (window.PageModules.contacts) window.PageModules.contacts.openForm(c);
    });
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
    const content = document.getElementById('tab-content');
    if (!content) return;
    content.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';

    const loaders = {
      overview: () => this.renderOverview(),
      deals: () => this.renderDeals(),
      activities: () => this.renderList('/activities', { contactId: this.currentId }, 'No activities'),
      tasks: () => this.renderList('/tasks', { contactId: this.currentId }, 'No tasks'),
      appointments: () => this.renderAppointments(),
      notes: () => this.renderList('/notes', { contactId: this.currentId }, 'No notes'),
      timeline: () => this.renderTimeline(),
    };

    loaders[tab]();
  },

  async renderOverview() {
    const c = document.getElementById('tab-content');
    try {
      const [dealsRes, tasksRes, appointmentsRes, leadRes] = await Promise.all([
        API.get('/deals', { contactId: this.currentId, pageSize: 5 }).catch(() => ({ items: [] })),
        API.get('/tasks', { contactId: this.currentId, pageSize: 5 }).catch(() => ({ items: [] })),
        API.get('/appointments', { contactId: this.currentId, pageSize: 5 }).catch(() => ({ items: [] })),
        API.get('/leads', { contact_id: this.currentId }).catch(() => ({ items: [] }))
      ]);
      const deals = dealsRes?.items || dealsRes?.data?.items || [];
      const tasks = tasksRes?.items || tasksRes?.data?.items || [];
      const appointments = appointmentsRes?.items || appointmentsRes?.data?.items || [];
      const leads = leadRes?.items || leadRes?.data?.items || [];
      const lead = leads[0] || {};

      c.innerHTML = [
        '<div class="grid grid-cols-2 md:grid-cols-4 gap-stack-md mb-stack-md">',
          '<div class="bg-surface-container-low rounded-lg p-stack-md"><p class="font-label-md text-label-md text-on-surface-variant uppercase">Deals</p><p class="font-display text-h3 text-on-surface mt-1">' + deals.length + '</p></div>',
          '<div class="bg-surface-container-low rounded-lg p-stack-md"><p class="font-label-md text-label-md text-on-surface-variant uppercase">Tasks</p><p class="font-display text-h3 text-on-surface mt-1">' + tasks.filter(t => t.status !== 'COMPLETED').length + '</p></div>',
          '<div class="bg-surface-container-low rounded-lg p-stack-md"><p class="font-label-md text-label-md text-on-surface-variant uppercase">Appointments</p><p class="font-display text-h3 text-on-surface mt-1">' + appointments.length + '</p></div>',
          '<div class="bg-surface-container-low rounded-lg p-stack-md"><p class="font-label-md text-label-md text-on-surface-variant uppercase">Lead Status</p><p class="font-display text-h3 text-on-surface mt-1">' + (lead.leadStatus || lead.lead_status || '—') + '</p></div>',
        '</div>',
        deals.length ? '<h3 class="font-h3 text-h3 mb-2">Recent Deals</h3>' + deals.slice(0, 3).map(d => '<a href="#deals/' + d.id + '" class="block p-stack-md bg-surface-container-low rounded-lg hover:bg-surface-container mb-2"><p class="font-body-md text-on-surface">' + (d.title || '') + '</p><p class="font-body-sm text-on-surface-variant">' + this.fmt(d.value, d.currency) + ' · ' + (d.status || '') + '</p></a>').join('') : '',
        tasks.length ? '<h3 class="font-h3 text-h3 mb-2 mt-stack-md">Pending Tasks</h3>' + tasks.filter(t => t.status !== 'COMPLETED').slice(0, 3).map(t => '<div class="p-stack-md bg-surface-container-low rounded-lg mb-2"><p class="font-body-md text-on-surface">' + (t.title || '') + '</p><p class="font-body-sm text-body-sm text-on-surface-variant">Due ' + (t.dueDate || t.due_date || '') + '</p></div>').join('') : '',
      ].join('');
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">Unable to load</p>'; }
  },

  async renderDeals() {
    const c = document.getElementById('tab-content');
    try {
      const res = await API.get('/deals', { contactId: this.currentId, pageSize: 100 });
      const items = res?.items || res?.data?.items || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No deals yet</p>'; return; }
      c.innerHTML = '<table class="w-full"><thead class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase tracking-wider"><tr><th class="text-left py-2 px-2 font-semibold">Title</th><th class="text-right py-2 px-2 font-semibold">Value</th><th class="text-left py-2 px-2 font-semibold">Stage</th><th class="text-left py-2 px-2 font-semibold">Close date</th></tr></thead><tbody class="divide-y divide-outline-variant/30 font-body-md text-body-md text-on-surface">' + items.map(d => '<tr><td class="py-2.5 px-2"><a href="#deals/' + d.id + '" class="hover:text-secondary">' + (d.title || '') + '</a></td><td class="py-2.5 px-2 text-right">' + this.fmt(d.value, d.currency) + '</td><td class="py-2.5 px-2">' + StatusBadge.render(d.stage) + '</td><td class="py-2.5 px-2 text-on-surface-variant">' + (d.expectedCloseDate || '') + '</td></tr>').join('') + '</tbody></table>';
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">Unable to load</p>'; }
  },

  async renderList(endpoint, params, emptyMsg) {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get(endpoint, params);
      const items = res?.items || res?.data?.items || res || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">' + emptyMsg + '</p>'; return; }
      if (endpoint === '/notes') {
        c.innerHTML = items.map(n => '<div class="py-stack-sm border-b border-outline-variant/30 last:border-0"><p class="font-body-md text-body-md text-on-surface whitespace-pre-wrap">' + (n.content || '') + '</p><p class="font-body-sm text-body-sm text-on-surface-variant mt-1">' + new Date(n.createdAt || n.created_at).toLocaleString() + '</p></div>').join('');
      } else {
        c.innerHTML = '<table class="w-full"><thead class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase tracking-wider"><tr><th class="text-left py-2 px-2 font-semibold">Title</th><th class="text-left py-2 px-2 font-semibold">Date</th></tr></thead><tbody class="divide-y divide-outline-variant/30 font-body-md text-body-md text-on-surface">' + items.map(i => '<tr><td class="py-2.5 px-2">' + (i.title || '') + '</td><td class="py-2.5 px-2 text-on-surface-variant">' + new Date(i.created_at || i.date).toLocaleDateString() + '</td></tr>').join('') + '</tbody></table>';
      }
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">' + emptyMsg + '</p>'; }
  },

  async renderAppointments() {
    const c = document.getElementById('tab-content');
    try {
      const res = await API.get('/appointments', { contactId: this.currentId });
      const items = res?.items || res?.data?.items || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No appointments</p>'; return; }
      c.innerHTML = items.map(a => '<div class="py-stack-sm border-b border-outline-variant/30 last:border-0"><p class="font-body-md text-on-surface">' + (a.title || '') + '</p><p class="font-body-sm text-body-sm text-on-surface-variant">' + new Date(a.startTime || a.start_time).toLocaleString() + ' · ' + (a.location || '') + '</p></div>').join('');
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No appointments</p>'; }
  },

  async renderTimeline() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const [activities, tasks, appointments, notes] = await Promise.all([
        API.get('/activities', { contactId: this.currentId }).catch(() => ({ items: [] })),
        API.get('/tasks', { contactId: this.currentId }).catch(() => ({ items: [] })),
        API.get('/appointments', { contactId: this.currentId }).catch(() => ({ items: [] })),
        API.get('/notes', { contactId: this.currentId }).catch(() => ({ items: [] }))
      ]);
      const items = [
        ...(activities.items || activities.data?.items || []).map(a => ({ ...a, _type: 'activity' })),
        ...(tasks.items || tasks.data?.items || []).map(t => ({ ...t, _type: 'task' })),
        ...(appointments.items || appointments.data?.items || []).map(a => ({ ...a, _type: 'appointment' })),
        ...(notes.items || notes.data?.items || []).map(n => ({ ...n, _type: 'note' })),
      ].sort((a, b) => new Date(b.created_at || b.createdAt) - new Date(a.created_at || a.createdAt));

      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No timeline events</p>'; return; }
      const icons = { activity: 'history', task: 'task_alt', appointment: 'event', note: 'sticky_note_2' };
      c.innerHTML = items.map(item => '<div class="flex items-start gap-stack-md py-stack-sm border-b border-outline-variant/30 last:border-0"><div class="w-8 h-8 rounded-full bg-secondary-container/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[16px] text-secondary">' + (icons[item._type] || 'history') + '</span></div><div class="flex-1"><p class="font-body-md text-on-surface">' + (item.title || item.content || item.description || '') + '</p><p class="font-body-sm text-body-sm text-on-surface-variant">' + new Date(item.created_at || item.createdAt).toLocaleString() + '</p></div></div>').join('');
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No timeline events</p>'; }
  },

  quickAdd(type) {
    if (window.PageModules[type + 's']) window.PageModules[type + 's'].openForm({ contactId: this.currentId });
  },

  async logCommunication(type) {
    const modal = new Modal({
      title: 'Log ' + type.charAt(0).toUpperCase() + type.slice(1),
      size: 'md',
      content: `
        <form id="comm-form" class="flex flex-col gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Subject / Summary *</label>
            <input name="title" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Details</label>
            <textarea name="description" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md" rows="3"></textarea>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Log</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#comm-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/activities', {
          type: type,
          title: fd.get('title'),
          description: fd.get('description'),
          contact_id: this.currentId,
        });
        Toast.success(type + ' logged');
        modal.close();
        this.switchTab(this.activeTab);
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  fmt(n, currency) { return Currency.format(n, currency || this.currentCurrency); },
};
