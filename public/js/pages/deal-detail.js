window.PageModules = window.PageModules || {};

window.PageModules.dealDetail = {
  currentId: null,
  activeTab: 'overview',

  stageMap: {},
  currentCurrency: 'INR',

  async init(id) {
    if (!id) {
      const hash = window.location.hash.replace('#', '');
      id = hash.startsWith('deals/') ? hash.split('/')[1] : null;
    }
    if (!id) { window.location.hash = 'deals'; return () => {}; }
    this.currentId = id;

    const main = document.getElementById('page-container');
    if (!main) return () => {};

    main.innerHTML = [
      '<div class="mb-stack-md"><a href="#deals" class="inline-flex items-center gap-1 text-secondary font-body-sm hover:underline"><span class="material-symbols-outlined text-[16px]">arrow_back</span> Back to Deals</a></div>',
      '<div id="deal-header" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding mb-stack-md"></div>',
      '<div class="flex items-center gap-stack-sm mb-stack-md overflow-x-auto pb-1">',
        '<button data-tab="overview" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Overview</button>',
        '<button data-tab="activities" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Activities</button>',
        '<button data-tab="tasks" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Tasks</button>',
        '<button data-tab="products" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Products</button>',
        '<button data-tab="proposals" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Proposals</button>',
        '<button data-tab="invoices" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Bills</button>',
        '<button data-tab="payments" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Payments</button>',
        '<button data-tab="timeline" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">Timeline</button>',
        '<button data-tab="ai" class="tab-btn px-4 py-2 rounded-lg font-body-sm whitespace-nowrap">AI Assistant</button>',
      '</div>',
      '<div id="tab-content" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding"></div>',
    ].join('');

    this.bindEvents();
    await this.loadStageNames();
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
      const res = await API.get('/deals/' + this.currentId);
      const d = res?.data || res || {};
      this.currentCurrency = d.currency || 'USD';
      this.dealData = d;
      this.renderHeader(d);
    } catch {
      this.dealData = { title: 'Deal #' + this.currentId, value: 0, stageId: '', status: 'OPEN', probability: 50 };
      this.renderHeader(this.dealData);
    }
  },

  fmt(n, currency) { return Currency.format(n, currency || this.currentCurrency); },

  async loadStageNames() {
    try {
      let pipelines = [];
      try {
        const pres = await API.get('/pipelines');
        pipelines = pres?.data || pres || [];
      } catch {}
      let allStages = (pipelines || []).flatMap(p => (p.stages || []).map(s => ({ id: s.id, name: s.name || s.stage_name || s.id })));
      // Fallback: if pipelines is empty or stages are missing, fetch stages directly
      if (!allStages.length) {
        try {
          const sres = await API.get('/pipelines/stages');
          const stages = sres?.data?.stages || sres?.stages || sres?.data || sres || [];
          if (Array.isArray(stages) && stages.length) {
            allStages = stages.map(s => ({ id: s.id, name: s.name || s.stage_name || s.id }));
          }
        } catch {}
      }
      this.stageMap = Object.fromEntries(allStages.map(s => [s.id, s.name]));
    } catch {}
  },

  stageName(id) {
    return this.stageMap[id] || id || '—';
  },

  renderHeader(d) {
    const h = document.getElementById('deal-header');
    if (!h) return;
    h.innerHTML = [
      '<div class="flex items-start justify-between gap-stack-md flex-wrap">',
        '<div>',
          '<h1 class="font-display text-h1 text-on-surface">' + (d.title || '') + '</h1>',
          '<p class="font-body-md text-body-md text-on-surface-variant mt-1">' + (d.organizationName || d.organization_id || '') + '</p>',
          '<div class="flex items-center gap-stack-sm mt-2 flex-wrap">',
            '<span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] gap-1 bg-surface-container text-on-surface-variant">' + this.stageName(d.stageId || d.stage_id) + '</span>',
            StatusBadge.render(d.status),
            '<span class="text-body-sm text-on-surface-variant">' + this.fmt(d.value, d.currency) + ' · ' + (d.probability || 0) + '% probability</span>',
          '</div>',
        '</div>',
        '<div class="flex gap-stack-sm flex-wrap">',
          '<button id="deal-edit" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>',
          '<button id="deal-won" class="flex items-center gap-1 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"><span class="material-symbols-outlined text-[18px]">check_circle</span> Won</button>',
          '<button id="deal-lost" class="flex items-center gap-1 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700"><span class="material-symbols-outlined text-[18px]">cancel</span> Lost</button>',
          '<button id="deal-reopen" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-4 py-2 rounded-lg hover:bg-surface-container"><span class="material-symbols-outlined text-[18px]">replay</span> Reopen</button>',
        '</div>',
      '</div>',
    ].join('');
    document.getElementById('deal-edit')?.addEventListener('click', () => {
      window.PageModules.deals.openForm(this.dealData, () => this.load());
    });
    document.getElementById('deal-won')?.addEventListener('click', () => this.changeStatus('won'));
    document.getElementById('deal-lost')?.addEventListener('click', () => this.changeStatus('lost'));
    document.getElementById('deal-reopen')?.addEventListener('click', () => this.changeStatus('open'));
  },

  async changeStatus(status) {
    try {
      if (status === 'won') await API.post('/deals/' + this.currentId + '/mark-won');
      else if (status === 'lost') await API.post('/deals/' + this.currentId + '/mark-lost');
      else if (status === 'open') await API.post('/deals/' + this.currentId + '/reopen');
      else { Toast.error('Unknown status: ' + status); return; }
      Toast.success('Deal ' + status);
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
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
      activities: () => this.renderList('/activities', { dealId: this.currentId }, 'No activities'),
      tasks: () => this.renderList('/tasks', { dealId: this.currentId }, 'No tasks'),
      products: () => this.renderProducts(),
      proposals: () => this.renderList('/proposals', { dealId: this.currentId }, 'No proposals'),
      invoices: () => this.renderList('/accounting/bills', { dealId: this.currentId }, 'No bills'),
      payments: () => this.renderList('/payments', { dealId: this.currentId }, 'No payments'),
      timeline: () => this.renderTimeline(),
      ai: () => this.renderAI(),
    };
    renderers[tab]();
  },

  async renderOverview() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/deals/' + this.currentId);
      const d = res?.data || res || {};
      c.innerHTML = [
        '<div class="grid grid-cols-2 md:grid-cols-3 gap-stack-md">',
          this.infoCard('Value', this.fmt(d.value, d.currency)),
          this.infoCard('Probability', (d.probability || 0) + '%'),
          this.infoCard('Stage', this.stageName(d.stageId || d.stage_id)),
          this.infoCard('Status', d.status || '—'),
          this.infoCard('Close date', d.expectedCloseDate || '—'),
          this.infoCard('Created', d.createdAt ? new Date(d.createdAt).toLocaleDateString() : '—'),
        '</div>',
        d.description ? '<div class="mt-stack-md"><h3 class="font-h3 text-h3 mb-2">Description</h3><p class="font-body-md text-on-surface whitespace-pre-wrap">' + d.description + '</p></div>' : '',
        '<div class="mt-stack-md flex gap-stack-sm">',
          '<button id="create-task-btn" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-3 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[16px]">add</span> Create Task</button>',
          '<button id="create-appointment-btn" class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 px-3 py-2 rounded-lg hover:bg-surface-container text-body-sm"><span class="material-symbols-outlined text-[16px]">event</span> Book Appointment</button>',
        '</div>',
      ].join('');

      document.getElementById('create-task-btn')?.addEventListener('click', () => this.quickAdd('task'));
      document.getElementById('create-appointment-btn')?.addEventListener('click', () => this.quickAddAppointment());
    } catch (err) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">Unable to load</p>'; }
  },

  infoCard(label, value) {
    return '<div class="bg-surface-container-low rounded-lg p-stack-md"><p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">' + label + '</p><p class="font-body-md text-body-md text-on-surface mt-1">' + value + '</p></div>';
  },

  async renderList(endpoint, params, emptyMsg) {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get(endpoint, params);
      const items = res?.data || res || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">' + emptyMsg + '</p>'; return; }
      c.innerHTML = '<pre class="font-code text-code text-on-surface bg-surface-container-low p-stack-md rounded overflow-auto">' + JSON.stringify(items, null, 2) + '</pre>';
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">' + emptyMsg + '</p>'; }
  },

  async renderProducts() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/deals/' + this.currentId + '/products');
      const items = res?.data || res || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No products attached</p>'; return; }
      c.innerHTML = '<table class="w-full"><thead class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase tracking-wider"><tr><th class="text-left py-2 px-2 font-semibold">Product</th><th class="text-right py-2 px-2 font-semibold">Qty</th><th class="text-right py-2 px-2 font-semibold">Price</th><th class="text-right py-2 px-2 font-semibold">Total</th></tr></thead><tbody class="divide-y divide-outline-variant/30">' + items.map(p => '<tr><td class="py-2.5 px-2">' + (p.product?.name || p.name || '') + '</td><td class="py-2.5 px-2 text-right">' + (p.quantity || 0) + '</td><td class="py-2.5 px-2 text-right">' + this.fmt(p.price, this.currentCurrency) + '</td><td class="py-2.5 px-2 text-right font-medium">' + this.fmt((p.quantity || 0) * (p.price || 0), this.currentCurrency) + '</td></tr>').join('') + '</tbody></table>';
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No products attached</p>'; }
  },

  async renderTimeline() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/deals/' + this.currentId + '/timeline');
      const items = res?.data || res || [];
      if (!items.length) { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No timeline events</p>'; return; }
      c.innerHTML = items.map(t => '<div class="flex items-start gap-stack-md py-stack-sm border-b border-outline-variant/30 last:border-0"><div class="w-2 h-2 rounded-full bg-secondary mt-2 shrink-0"></div><div class="flex-1"><p class="font-body-md text-on-surface">' + (t.description || t.event || '') + '</p><p class="font-body-sm text-body-sm text-on-surface-variant">' + new Date(t.createdAt || t.date).toLocaleString() + '</p></div></div>').join('');
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">No timeline events</p>'; }
  },

  async renderAI() {
    const c = document.getElementById('tab-content');
    c.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const res = await API.get('/ai/deals/' + this.currentId + '/recommendations');
      const data = res || {};
      const recommendations = data.recommendations || [];
      if (!recommendations.length) {
        c.innerHTML = '<div class="text-center py-12"><p class="font-body-md text-body-md text-on-surface-variant">No AI recommendations available.</p><p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Ensure Ollama is running locally.</p></div>';
        return;
      }
      c.innerHTML = '<div class="space-y-stack-md">' + recommendations.map(r => '<div class="bg-surface-container-low rounded-lg p-stack-md border border-outline-variant/30">' +
        '<div class="flex items-center gap-2 mb-2">' + StatusBadge.render(r.priority) + '</div>' +
        '<p class="font-body-md text-body-md text-on-surface font-medium">' + (r.action || '') + '</p>' +
        '<p class="font-body-sm text-body-sm text-on-surface-variant mt-1">' + (r.reason || '') + '</p>' +
        '<p class="font-body-sm text-body-sm text-secondary mt-2">Expected: ' + (r.expectedResult || '') + '</p>' +
      '</div>').join('') + '</div>';
    } catch { c.innerHTML = '<p class="text-center text-on-surface-variant py-12">AI unavailable</p>'; }
  },

  quickAdd(type) {
    if (window.PageModules[type + 's']) window.PageModules[type + 's'].openForm({ dealId: this.currentId });
  },

  quickAddAppointment() {
    const modal = new Modal({
      title: 'Book Appointment',
      size: 'md',
      content: `
        <form id="apt-form" class="flex flex-col gap-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Title *</label>
            <input name="title" required value="Meeting about ${this.currentId}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Start Time *</label>
            <input name="start_time" type="datetime-local" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md"/>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">Book</button>
          </div>
        </form>
      `,
    });
    modal.open();
    modal.element.querySelector('#apt-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/appointments', {
          title: fd.get('title'),
          start_time: fd.get('start_time'),
          deal_id: this.currentId,
        });
        Toast.success('Appointment booked');
        modal.close();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },
};
