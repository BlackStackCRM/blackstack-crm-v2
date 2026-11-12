window.PageModules = window.PageModules || {};

window.PageModules.deals = {
  table: null,
  pagination: null,
  stages: [],
  stageMap: {},
  currentCurrency: 'INR',
  state: { page: 1, pageSize: 10, search: '', stage: '', status: '', owner: '' },
  searchTimer: null,

  escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    // Load default currency from settings
    try {
      // Currency is optional; customer tenants do not have settings.manage.
      // Suppress the expected 403 toast and keep the INR fallback.
      const settings = await API.get('/settings', {}, { silent: true });
      this.currentCurrency = settings.defaultCurrency || 'INR';
    } catch { /* use default */ }

    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Deals</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Track your sales pipeline.</p>
        </div>
        <div class="flex gap-stack-sm">
          <a href="#pipeline" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-4 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[18px]">view_kanban</span> Pipeline</a>
          <button id="deal-new" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90"><span class="material-symbols-outlined text-[18px]">add</span> New Deal</button>
        </div>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
          <div class="relative flex-1 min-w-[200px]">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="deal-search" placeholder="Search deals..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <select id="deal-stage" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All stages</option>
          </select>
          <select id="deal-status" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All status</option>
            <option value="OPEN">Open</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
          </select>
        </div>
        <div id="deals-table"></div>
        <div id="deals-pagination"></div>
      </div>
    `;

    this.bindEvents();
    await this.loadStages();
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  // Fetch pipelines with their stages. Stages live in a separate table without a
  // pipeline_id column, so if the pipelines list is empty (or carries no stages),
  // fall back to the company-wide /pipelines/stages endpoint.
  async fetchPipelinesWithStages() {
    let pipelines = [];
    try {
      const pres = await API.get('/pipelines');
      pipelines = pres?.data || pres || [];
    } catch {}
    const hasStages = pipelines.some(p => (p.stages || []).length);
    if (!hasStages) {
      try {
        const sres = await API.get('/pipelines/stages');
        const stages = sres?.data || sres || [];
        if (stages.length) {
          if (pipelines.length) {
            pipelines.forEach(p => { p.stages = stages; });
          } else {
            // No pipelines exist but stages do — expose stages under a virtual pipeline
            pipelines = [{ id: '', name: 'Default', stages }];
          }
        }
      } catch {}
    }
    return pipelines;
  },

  async loadStages() {
    try {
      const pipelines = await this.fetchPipelinesWithStages();
      const stageSel = document.getElementById('deal-stage');
      const allStages = pipelines.flatMap(p => (p.stages || []).map(s => ({ id: s.id, name: s.name || s.stage_name || s.id, pipeline: p.name })));
      const uniqueStages = allStages.filter((s, i) => allStages.findIndex(x => x.id === s.id) === i);
      this.stages = uniqueStages;
      this.stageMap = Object.fromEntries(uniqueStages.map(s => [s.id, s.name]));
      if (stageSel) {
        stageSel.innerHTML = '<option value="">All stages</option>' +
          uniqueStages.map(s => `<option value="${this.escapeHTML(s.id)}">${this.escapeHTML(s.name)}</option>`).join('');
      }
    } catch {}
  },

  stageName(id) {
    return this.stageMap[id] || id || '—';
  },

  bindEvents() {
    document.getElementById('deal-new').addEventListener('click', () => this.openForm());
    document.getElementById('deal-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.state.page = 1; this.load(); }, 300);
    });
    document.getElementById('deal-stage').addEventListener('change', (e) => { this.state.stage = e.target.value; this.state.page = 1; this.load(); });
    document.getElementById('deal-status').addEventListener('change', (e) => { this.state.status = e.target.value; this.state.page = 1; this.load(); });
  },

  async load() {
    const container = document.getElementById('deals-table');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { page: this.state.page, pageSize: this.state.pageSize, search: this.state.search, stage_id: this.state.stage, status: this.state.status, ownerId: this.state.owner };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/deals', params);
      const data = res?.items ? res : (res?.data || res || {});
      const items = data.items || data.deals || [];
      const total = data.total || data.pagination?.total || items.length;
      this.renderTable(container, items, total);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  renderTable(container, items, total) {
    this.table = new DataTable(container, {
      columns: [
        { key: 'title', label: 'Title', render: (v, r) => '<a href="#deals/' + this.escapeHTML(r.id) + '" class="font-medium hover:text-secondary">' + this.escapeHTML(v || '') + '</a>' },
        { key: 'contactId', label: 'Contact', render: (v, r) => { const name = r.firstName && r.lastName ? r.firstName + ' ' + r.lastName : (r.firstName || r.lastName || r.contactName || v || '—'); return '<span class="font-medium">' + this.escapeHTML(name) + '</span>'; } },
        { key: 'organizationId', label: 'Organization', render: (v, r) => this.escapeHTML(r.organizationName || r.organization_name || v || '—') },
        { key: 'value', label: 'Value', render: (v, r) => '<span class="font-medium">' + Currency.format(v, r.currency || this.currentCurrency) + '</span>', align: 'right' },
        { key: 'probability', label: 'Prob.', render: (v) => (v || 0) + '%', align: 'right' },
        { key: 'stageId', label: 'Stage', render: (v, r) => '<span class="font-medium">' + this.escapeHTML(this.stageName(v || r.stage_id)) + '</span>' },
        { key: 'expectedCloseDate', label: 'Close date' },
      ],
      data: items,
      emptyState: 'No deals found',
      rowActions: (row) => this.openRowMenu(row),
    });

    if (!this.pagination) {
      this.pagination = new Pagination(document.getElementById('deals-pagination'), {
        page: this.state.page, totalItems: total, pageSize: this.state.pageSize,
        totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)),
        onPageChange: (p) => { this.state.page = p; this.load(); },
      });
    } else {
      this.pagination.update({ page: this.state.page, totalItems: total, totalPages: Math.max(1, Math.ceil(total / this.state.pageSize)) });
    }
  },
openRowMenu(row) {
    const isEditable = !['WON', 'LOST'].includes(row.status || row.status);
    const actions = [
      '<a href="#deals/' + this.escapeHTML(row.id) + '" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md"><span class="material-symbols-outlined text-[18px]">visibility</span> View</a>',
      '<button data-act="edit" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md text-left"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>',
      '<button data-act="stage" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md text-left"><span class="material-symbols-outlined text-[18px]">swap_horiz</span> Change stage</button>',
    ];
    if (row.status !== 'WON') actions.push('<button data-act="won" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md text-left text-green-700"><span class="material-symbols-outlined text-[18px]">check_circle</span> Mark won</button>');
    if (row.status !== 'LOST') actions.push('<button data-act="lost" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md text-left text-red-700"><span class="material-symbols-outlined text-[18px]">cancel</span> Mark lost</button>');
    if (['WON', 'LOST'].includes(row.status)) actions.push('<button data-act="reopen" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-body-md text-left text-blue-700"><span class="material-symbols-outlined text-[18px]">replay</span> Reopen</button>');
    actions.push('<button data-act="delete" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-body-md text-error text-left"><span class="material-symbols-outlined text-[18px]">delete</span> Delete</button>');
    const modal = new Modal({ title: row.title, size: 'sm', content: '<div class="flex flex-col gap-1">' + actions.join('') + '</div>' });
    modal.open();
    modal.element.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      modal.close();
      if (act === 'edit') return this.openForm(row);
      if (act === 'delete') return this.confirmDelete(row);
      if (act === 'won') return this.changeStatus(row, 'won');
      if (act === 'lost') return this.changeStatus(row, 'lost');
      if (act === 'stage') return this.changeStage(row);
      if (act === 'reopen') return this.changeStatus(row, 'reopen');
    });
  },

  async changeStatus(row, status) {
    try {
      if (status === 'reopen') {
        await API.post(`/deals/${row.id}/reopen`);
      } else if (status === 'won') {
        await API.post(`/deals/${row.id}/mark-won`);
      } else if (status === 'lost') {
        const reason = await this.promptLostReason();
        if (reason === null) return;
        await API.post(`/deals/${row.id}/mark-lost`, { lost_reason: reason });
      }
      Toast.success('Deal marked ' + status);
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },

  async promptLostReason() {
    return new Promise((resolve) => {
      const modal = new Modal({ title: 'Lost reason', size: 'sm', content: '<textarea name="lost_reason" placeholder="Why did the deal close as lost?" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"></textarea><div class="flex justify-end gap-stack-sm mt-stack-md"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button><button id="confirm-lost" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg">Confirm</button></div>' });
      modal.open();
      modal.element.querySelector('#confirm-lost').addEventListener('click', () => {
        const reason = modal.element.querySelector('textarea[name="lost_reason"]').value;
        modal.close();
        resolve(reason);
      });
      modal.element.addEventListener('click', (e) => {
        if (e.target.closest('[data-modal-close]')) resolve(null);
      });
    });
  },

  async changeStage(row) {
    let pipelines = await this.fetchPipelinesWithStages();
    const pipelineId = row.pipelineId || row.pipeline_id;
    const pipeline = pipelines.find(p => p.id === pipelineId);
    let stages = (pipeline && pipeline.stages) || [];
    if (!stages.length) {
      stages = pipelines.flatMap(p => (p.stages || []).map(s => ({ id: s.id, name: s.name || s.stage_name || s.id, pipeline: p.name })));
    }
    const options = stages.map(s => '<option value="' + s.id + '">' + (s.name || s.stage_name || s.id) + '</option>').join('');
    const modal = new Modal({ title: 'Change stage', size: 'sm', content: '<select id="new-stage" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md mb-stack-md">' + options + '</select><div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button><button id="apply-stage" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Apply</button></div>' });
    modal.open();
    const stageSel = modal.element.querySelector('#new-stage');
    stageSel.value = row.stageId || row.stage_id;
    if (!stageSel.value && stageSel.options[0]) stageSel.value = stageSel.options[0].value;
    modal.element.querySelector('#apply-stage').addEventListener('click', async () => {
      const stageId = stageSel.value;
      try {
        await API.post(`/deals/${row.id}/stage`, { stage_id: stageId });
        Toast.success('Stage updated');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  async openForm(row = null, onComplete = null) {
    const isEdit = !!row;
    const d = row || {};
    let pipelines = await this.fetchPipelinesWithStages();
    const modal = new Modal({
      title: isEdit ? 'Edit Deal' : 'New Deal',
      size: 'lg',
      onClose: onComplete,
      content: `
        <form id="deal-form" class="grid grid-cols-2 gap-stack-md">
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Related To *</label>
            <div class="flex items-center gap-stack-sm mb-2">
              <label class="flex items-center gap-1 text-body-sm"><input type="radio" name="relatedType" value="contact" checked/> Contact</label>
              <label class="flex items-center gap-1 text-body-sm"><input type="radio" name="relatedType" value="organization"/> Organization</label>
            </div>
            <div id="deal-contact-wrap"><div id="deal-contact-selector"></div></div>
            <div id="deal-org-wrap" class="hidden"><div id="deal-org-selector"></div></div>
            <div id="deal-org-contact-wrap" class="hidden mt-2">
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Primary contact at organization</label>
              <div id="deal-org-contact-selector"></div>
            </div>
            <div id="deal-related-info" class="hidden mt-2 p-stack-sm bg-surface-container rounded-lg font-body-sm text-body-sm text-on-surface-variant"></div>
          </div>
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Title *</label>
            <input name="title" required value="${this.escapeHTML(d.title || '')}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Value (${Currency.SYMBOLS[this.currentCurrency]})</label>
            <input name="value" type="number" step="0.01" value="${d.value || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Currency</label>
            <select name="currency" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
              ${Currency.currencyOptions(d.currency || this.currentCurrency || 'USD')}
            </select>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Probability (%)</label>
            <input name="probability" type="number" min="0" max="100" value="${d.probability || 10}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Pipeline</label>
            <select name="pipelineId" id="deal-pipeline" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="">No pipeline</option>
              ${pipelines.map(p => '<option value="' + this.escapeHTML(p.id) + '" ' + (d.pipelineId === p.id || d.pipeline_id === p.id ? 'selected' : '') + '>' + this.escapeHTML(p.name || '') + '</option>').join('')}
            </select>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Stage *</label>
            <select name="stageId" id="deal-stage-select" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"></select>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Expected close date</label>
            <input name="expectedCloseDate" type="date" value="${d.expectedCloseDate || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div class="col-span-2">
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label>
            <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">${this.escapeHTML(d.description || '')}</textarea>
          </div>
          <div class="col-span-2 flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      `,
    });
    modal.open();

    // Stage select follows selected pipeline
    const stageSel = modal.element.querySelector('#deal-stage-select');
    const pipelineSel = modal.element.querySelector('#deal-pipeline');
    const fillStages = () => {
      const p = pipelines.find(x => x.id === pipelineSel.value);
      let stages = (p && p.stages) || [];
      if (!stages.length) {
        stages = pipelines.flatMap(pp => (pp.stages || []).map(s => ({ id: s.id, name: s.name || s.stage_name || s.id })));
      }
      stageSel.innerHTML = stages.length
        ? stages.map(s => '<option value="' + s.id + '">' + (s.name || s.stage_name || s.id) + '</option>').join('')
        : '<option value="">— select pipeline —</option>';
      if (isEdit && (d.stageId || d.stage_id)) stageSel.value = d.stageId || d.stage_id;
    };
    pipelineSel.addEventListener('change', fillStages);
    fillStages();

    // Related To: contact OR organization
    const info = modal.element.querySelector('#deal-related-info');
    const showInfo = (html) => { info.innerHTML = html; info.classList.remove('hidden'); };
    let selectedOrg = null;
    const contactWrap = modal.element.querySelector('#deal-contact-wrap');
    const orgWrap = modal.element.querySelector('#deal-org-wrap');
    const orgContactWrap = modal.element.querySelector('#deal-org-contact-wrap');

    const contactSelector = new EntitySelector(modal.element.querySelector('#deal-contact-selector'), {
      type: 'contact', placeholder: 'Select contact...', allowCreate: true,
      onCreate: () => window.PageModules.contacts.openFormAndWait(),
      onChange: async (c) => {
        if (!c) { info.classList.add('hidden'); return; }
        let orgName = '';
        const orgId = c.organizationId || c.organization_id;
        if (orgId) {
          try { const o = await API.get('/organizations/' + orgId); orgName = (o?.data || o)?.name || ''; } catch {}
        }
        showInfo((c.email || 'no email') + ' · ' + (c.phone || 'no phone') + (orgName ? ' · ' + orgName : ''));
      },
    });

    let orgContactSel = null;
    const orgSelector = new EntitySelector(modal.element.querySelector('#deal-org-selector'), {
      type: 'organization', placeholder: 'Select organization...',
      onChange: async (o) => {
        selectedOrg = o;
        const cselWrap = modal.element.querySelector('#deal-org-contact-selector');
        cselWrap.innerHTML = '';
        if (!o) { orgContactWrap.classList.add('hidden'); info.classList.add('hidden'); return; }
        showInfo(o.industry ? o.name + ' · ' + o.industry : o.name);
        try {
          const cres = await API.get('/contacts?organization_id=' + o.id + '&limit=50');
          const citems = cres?.data?.items || cres?.items || [];
          if (citems.length) {
            orgContactWrap.classList.remove('hidden');
            orgContactSel = new EntitySelector(cselWrap, { type: 'contact', placeholder: 'Select primary contact...', filters: { organization_id: o.id } });
          } else {
            orgContactWrap.classList.add('hidden');
            orgContactSel = null;
          }
        } catch { orgContactWrap.classList.add('hidden'); }
      },
    });

    modal.element.querySelectorAll('input[name="relatedType"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isOrg = radio.value === 'organization' && radio.checked;
        orgWrap.classList.toggle('hidden', !isOrg);
        contactWrap.classList.toggle('hidden', isOrg);
        orgContactWrap.classList.add('hidden');
        info.classList.add('hidden');
      });
    });
    if (isEdit && (d.organizationId || d.organization_id) && !(d.contactId || d.contact_id)) {
      modal.element.querySelector('input[name="relatedType"][value="organization"]').checked = true;
      orgWrap.classList.remove('hidden'); contactWrap.classList.add('hidden');
      try { const o = await API.get('/organizations/' + (d.organizationId || d.organization_id)); const od = o?.data || o; if (od) orgSelector.setValue(od); } catch {}
    } else if (isEdit && (d.contactId || d.contact_id)) {
      try { const c = await API.get('/contacts/' + (d.contactId || d.contact_id)); const cd = c?.data || c; if (cd) contactSelector.setValue(cd); } catch {}
    }

    modal.element.querySelector('#deal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const relatedType = modal.element.querySelector('input[name="relatedType"]:checked').value;
      let contactId = null, organizationId = null;
      if (relatedType === 'contact') {
        const c = contactSelector.getValue();
        if (!c) { Toast.error('Select a contact'); return; }
        contactId = c.id;
        organizationId = c.organizationId || c.organization_id || null;
      } else {
        if (!selectedOrg) { Toast.error('Select an organization'); return; }
        organizationId = selectedOrg.id;
        contactId = (orgContactSel && orgContactSel.getValue() && orgContactSel.getValue().id) || null;
        if (!contactId) { Toast.error('Select a primary contact at the organization'); return; }
      }
      const payload = Object.fromEntries(fd.entries());
      // Server expects snake_case keys
      payload.contact_id = contactId;
      payload.organization_id = organizationId;
      payload.pipeline_id = payload.pipelineId || null;
      payload.stage_id = payload.stageId || null;
      payload.expected_close_date = payload.expectedCloseDate || null;
      delete payload.contactId; delete payload.organizationId;
      delete payload.pipelineId; delete payload.stageId; delete payload.expectedCloseDate;
      if (!payload.stage_id) { Toast.error('Select a stage'); return; }
      payload.value = parseFloat(payload.value) || 0;
      payload.probability = parseInt(payload.probability) || 0;
      try {
        if (isEdit) await API.put(`/deals/${d.id}`, payload);
        else await API.post('/deals', payload);
        Toast.success(isEdit ? 'Deal updated' : 'Deal created');
        modal.close();
        if (onComplete) onComplete();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  confirmDelete(row) {
    const modal = new Modal({ title: 'Delete deal?', size: 'sm', content: '<p class="font-body-md text-on-surface mb-stack-md">Delete <strong>' + this.escapeHTML(row.title) + '</strong>?</p><div class="flex justify-end gap-stack-sm"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button><button id="confirm-deal-delete" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Delete</button></div>' });
    modal.open();
    modal.element.querySelector('#confirm-deal-delete').addEventListener('click', async () => {
      try {
        await API.del(`/deals/${row.id}`);
        Toast.success('Deal deleted');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },
};
