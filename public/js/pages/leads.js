window.PageModules = window.PageModules || {};

window.PageModules.leads = {
  pipelines: [],
  currentPipelineId: null,
  search: '',
  draggedLeadId: null,

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    main.innerHTML = [
      '<div class="flex items-center justify-between mb-stack-lg flex-wrap gap-stack-md">',
        '<div>',
          '<h1 class="font-display text-h1 text-on-surface tracking-tight">Leads</h1>',
          '<p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage your lead pipeline.</p>',
        '</div>',
        '<div class="flex items-center gap-stack-sm">',
          '<select id="lead-status-filter" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">',
            '<option value="">All statuses</option>',
            '<option value="NEW">New</option>',
            '<option value="CONTACTED">Contacted</option>',
            '<option value="QUALIFIED">Qualified</option>',
            '<option value="UNQUALIFIED">Unqualified</option>',
            '<option value="NURTURE">Nurture</option>',
            '<option value="CONVERTED">Converted</option>',
            '<option value="LOST">Lost</option>',
          '</select>',
          '<div class="relative">',
            '<span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>',
            '<input id="lead-search" placeholder="Search leads..." class="bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>',
          '</div>',
          '<button id="lead-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 transition-colors">',
            '<span class="material-symbols-outlined text-[18px]">add</span> New Lead',
          '</button>',
        '</div>',
      '</div>',
      '<div id="leads-board" class="flex gap-stack-md pb-4 overflow-x-auto"></div>',
    ].join('');

    this.bindEvents();
    await this.loadStages();
    return () => {};
  },

  bindEvents() {
    document.getElementById('lead-new')?.addEventListener('click', () => this.openForm());
    const statusFilter = document.getElementById('lead-status-filter');
    statusFilter?.addEventListener('change', (e) => { this.statusFilter = e.target.value; this.filterCards(); });
    let timer;
    document.getElementById('lead-search')?.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { this.search = e.target.value.toLowerCase(); this.filterCards(); }, 200);
    });
  },

  statusStages: [
    { id: 'NEW', name: 'New', color: '#64748b' },
    { id: 'CONTACTED', name: 'Contacted', color: '#0058be' },
    { id: 'QUALIFIED', name: 'Qualified', color: '#16a34a' },
    { id: 'UNQUALIFIED', name: 'Unqualified', color: '#ba1a1a' },
    { id: 'NURTURE', name: 'Nurture', color: '#f59e0b' },
    { id: 'CONVERTED', name: 'Converted', color: '#7c3aed' },
    { id: 'LOST', name: 'Lost', color: '#991b1b' },
  ],

  async loadStages() {
    const board = document.getElementById('leads-board');
    board.innerHTML = '<div class="py-12 text-center w-full"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';

    let leads = [];
    try {
      const res = await API.get('/leads', { limit: 200 });
      leads = res?.items || res?.data?.items || res || [];
    } catch { leads = []; }

    board.innerHTML = '';
    for (const stage of this.statusStages) {
      const stageLeads = leads.filter(l => (l.leadStatus || l.lead_status) === stage.id);
      const col = document.createElement('div');
      col.className = 'bg-surface-container-low rounded-xl border border-outline-variant/30 w-72 shrink-0 flex flex-col max-h-[calc(100vh-220px)]';
      col.dataset.stage = stage.id;
      col.innerHTML = [
        '<div class="p-stack-md border-b border-outline-variant/30 flex items-center justify-between">',
          '<div class="flex items-center gap-stack-sm">',
            '<span class="w-2 h-2 rounded-full" style="background:' + (stage.color || '#0058be') + '"></span>',
            '<h3 class="font-h3 text-h3 text-on-surface">' + stage.name + '</h3>',
            '<span class="text-body-sm text-on-surface-variant">' + stageLeads.length + '</span>',
          '</div>',
        '</div>',
        '<div class="flex-1 overflow-y-auto p-stack-sm space-y-2 stage-drop" data-stage="' + stage.id + '">',
          stageLeads.map(l => this.leadCard(l)).join(''),
        '</div>',
      ].join('');
      board.appendChild(col);
    }

    this.setupDragDrop();
    this.filterCards();
  },

  leadCard(l) {
    return [
      '<div class="bg-surface-container-lowest rounded-lg p-stack-sm border border-outline-variant/30 cursor-move hover:shadow-md transition-shadow deal-card" draggable="true" data-id="' + l.id + '" data-status="' + (l.leadStatus || l.lead_status || '') + '" data-search="' + ((l.firstName || l.first_name || '') + ' ' + (l.lastName || l.last_name || '') + ' ' + (l.email || '')).toLowerCase() + '">',
        '<div class="flex items-center gap-stack-sm mb-2">',
          '<div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-on-secondary text-[10px] font-semibold shrink-0">' + ((l.firstName?.[0] || l.first_name?.[0] || '') + (l.lastName?.[0] || l.last_name?.[0] || '')).toUpperCase() + '</div>',
          '<div class="flex-1 min-w-0">',
            '<p class="font-body-md text-body-md text-on-surface font-medium truncate">' + (l.firstName || l.first_name || '') + ' ' + (l.lastName || l.last_name || '') + '</p>',
            '<p class="font-body-sm text-body-sm text-on-surface-variant truncate">' + (l.email || '') + '</p>',
          '</div>',
        '</div>',
        '<div class="flex items-center justify-between mt-2">',
          '<span class="text-body-sm text-on-surface-variant">' + (l.source || 'manual') + '</span>',
          '<span class="text-body-sm font-medium text-on-surface">' + (l.leadScore || l.lead_score || 0) + ' pts</span>',
        '</div>',
        '<div class="flex gap-1 mt-2">',
          '<a href="#contacts/' + (l.contactId || l.contact_id) + '" class="text-body-sm text-secondary hover:underline">View Contact</a>',
          '<span class="text-body-sm text-on-surface-variant">·</span>',
          '<button data-act="convert" data-id="' + l.id + '" class="text-body-sm text-secondary hover:underline">Convert</button>',
        '</div>',
      '</div>',
    ].join('');
  },

  setupDragDrop() {
    document.querySelectorAll('.deal-card').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        this.draggedLeadId = card.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('opacity-50');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('opacity-50');
        this.draggedLeadId = null;
      });
    });
    document.querySelectorAll('.stage-drop').forEach(col => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('bg-secondary-container/10'); });
      col.addEventListener('dragleave', () => col.classList.remove('bg-secondary-container/10'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('bg-secondary-container/10');
        const newStatus = col.dataset.stage;
        const leadId = this.draggedLeadId;
        if (!leadId) return;
        try {
          await API.put('/leads/' + leadId, { lead_status: newStatus });
          Toast.success('Lead moved to ' + newStatus);
          this.loadStages();
        } catch (err) {
          Toast.error(err.message || 'Failed to update lead');
          this.loadStages();
        }
      });
    });

    document.querySelectorAll('[data-act="convert"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const leadId = btn.dataset.id;
        this.openConvertModal(leadId);
      });
    });
  },

  async openConvertModal(leadId) {
    const modal = new Modal({
      title: 'Convert Lead to Opportunity',
      size: 'md',
      content: `
        <form id="convert-lead-form" class="flex flex-col gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Deal Title *</label>
            <input name="title" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Deal Value</label>
            <input name="value" type="number" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Notes</label>
            <textarea name="notes" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40" rows="3"></textarea>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Convert</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#convert-lead-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/leads/' + leadId + '/convert', {
          title: fd.get('title'),
          value: fd.get('value'),
          notes: fd.get('notes')
        });
        Toast.success('Lead converted to opportunity');
        modal.close();
        this.loadStages();
        // Redirect to the Deals page so the user can see the newly created deal
        setTimeout(() => { window.location.hash = 'deals'; }, 1500);
      } catch (err) {
        Toast.error(err.message || 'Failed to convert');
      }
    });
  },

  openForm(row = null) {
    const isEdit = !!row;
    const l = row || {};
    const modal = new Modal({
      title: isEdit ? 'Edit Lead' : 'New Lead',
      size: 'md',
      content: `
        <form id="lead-form" class="flex flex-col gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Contact *</label>
            <div id="lead-contact-selector"></div>
            <div id="lead-contact-info" class="hidden mt-2 p-stack-sm bg-surface-container rounded-lg font-body-sm text-body-sm text-on-surface-variant"></div>
          </div>
          <div class="grid grid-cols-2 gap-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Lead Source</label>
              <select name="source" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                <option value="manual">Manual</option>
                <option value="website">Website</option>
                <option value="referral">Referral</option>
                <option value="campaign">Campaign</option>
                <option value="event">Event</option>
                <option value="cold_call">Cold Call</option>
              </select>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Lead Status</label>
              <select name="leadStatus" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md">
                <option value="NEW">New</option>
                <option value="CONTACTED">Contacted</option>
                <option value="QUALIFIED">Qualified</option>
                <option value="NURTURE">Nurture</option>
                <option value="UNQUALIFIED">Unqualified</option>
              </select>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Lead Score</label>
              <input name="leadScore" type="number" min="0" max="100" value="0" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
            </div>
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Budget</label>
              <input name="budget" type="number" step="0.01" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
            </div>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Qualification Notes</label>
            <textarea name="qualificationNotes" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create Lead'}</button>
          </div>
        </form>
      `,
    });
    modal.open();

    const infoBox = modal.element.querySelector('#lead-contact-info');
    const contactSelector = new EntitySelector(modal.element.querySelector('#lead-contact-selector'), {
      type: 'contact',
      placeholder: 'Select contact...',
      allowCreate: true,
      onCreate: () => window.PageModules.contacts.openFormAndWait(),
      onChange: (c) => {
        if (!c) { infoBox.classList.add('hidden'); return; }
        infoBox.innerHTML = '<span class="material-symbols-outlined text-[14px] align-middle">person</span> '
          + (c.email || 'no email') + ' · ' + (c.phone || 'no phone');
        infoBox.classList.remove('hidden');
      },
    });

    modal.element.querySelector('#lead-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const contact = contactSelector.getValue();
      if (!contact) { Toast.error('Select a contact'); return; }
      const fd = new FormData(e.target);
      const payload = {
        contactId: contact.id,
        source: fd.get('source'),
        leadStatus: fd.get('leadStatus'),
        leadScore: parseInt(fd.get('leadScore')) || 0,
        budget: parseFloat(fd.get('budget')) || null,
        qualificationNotes: fd.get('qualificationNotes') || null,
      };
      try {
        if (isEdit) await API.put('/leads/' + l.id, payload);
        else await API.post('/leads', payload);
        Toast.success(isEdit ? 'Lead updated' : 'Lead created');
        modal.close();
        this.loadStages();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  filterCards() {
    document.querySelectorAll('.deal-card').forEach(card => {
      const matchStatus = !this.statusFilter || card.dataset.status === this.statusFilter;
      const matchSearch = !this.search || (card.dataset.search || '').includes(this.search);
      card.classList.toggle('hidden', !(matchStatus && matchSearch));
    });
  },
};
