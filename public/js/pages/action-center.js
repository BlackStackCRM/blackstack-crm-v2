window.PageModules = window.PageModules || {};

window.PageModules.actionCenter = {
  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    main.innerHTML = `
      <div class="mb-stack-lg">
        <h1 class="font-display text-h1 text-on-surface tracking-tight">Action Center</h1>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Your next best actions across the CRM.</p>
      </div>
      <div id="actions-container" class="space-y-stack-md"></div>
    `;

    this.bindEvents();
    await this.load();
    return () => {};
  },

  bindEvents() {
    document.getElementById('ac-refresh')?.addEventListener('click', () => this.load());
  },

  async load() {
    const container = document.getElementById('actions-container');
    container.innerHTML = '<div class="py-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';

    try {
      const res = await API.get('/ai/action-center');
      const data = res || {};
      const actions = data.actions || [];

      if (!actions.length) {
        container.innerHTML = '<div class="text-center py-12"><span class="material-symbols-outlined text-[48px] text-on-surface-variant/40 mb-2">check_circle</span><p class="font-body-md text-body-md text-on-surface-variant">You are all caught up!</p></div>';
        return;
      }

      const grouped = { HIGH: [], MEDIUM: [], LOW: [] };
      actions.forEach(a => {
        const p = (a.priority || 'MEDIUM').toUpperCase();
        if (!grouped[p]) grouped[p] = [];
        grouped[p].push(a);
      });

      container.innerHTML = Object.entries(grouped).filter(([, items]) => items.length > 0).map(([priority, items]) => {
        const colors = { HIGH: 'border-error/30 bg-error-container/5', MEDIUM: 'border-yellow-500/30 bg-yellow-500/5', LOW: 'border-outline-variant/30 bg-surface-container-low' };
        const badgeColors = { HIGH: 'bg-error text-on-error', MEDIUM: 'bg-yellow-500 text-white', LOW: 'bg-outline-variant text-on-surface-variant' };
        return '<div class="space-y-stack-sm"><h2 class="font-h3 text-h3 text-on-surface flex items-center gap-stack-sm"><span class="px-2 py-0.5 rounded text-[11px] font-semibold ' + badgeColors[priority] + '">' + priority + '</span> ' + items.length + ' action' + (items.length > 1 ? 's' : '') + '</h2>' + items.map(a => this.actionCard(a, colors[priority])).join('') + '</div>';
      }).join('');
    } catch (err) {
      container.innerHTML = '<p class="text-center text-on-surface-variant py-12">Unable to load action center</p>';
    }
  },

  actionCard(a, colorClass) {
    const icons = { overdue_task: 'task_alt', no_next_action: 'psychology', stale_lead: 'person_off', upcoming_appointment: 'event' };
    return '<div class="bg-surface-container-lowest rounded-xl border ' + colorClass + ' p-container-padding hover:shadow-md transition-shadow">' +
      '<div class="flex items-start gap-stack-md">' +
        '<div class="w-10 h-10 rounded-lg bg-secondary-container/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[20px] text-secondary">' + (icons[a.type] || 'psychology') + '</span></div>' +
        '<div class="flex-1 min-w-0">' +
          '<p class="font-body-md text-body-md text-on-surface font-medium">' + (a.title || '') + '</p>' +
          '<p class="font-body-sm text-body-sm text-on-surface-variant mt-1">' + (a.reason || '') + '</p>' +
          (a.dueDate ? '<p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Due: ' + new Date(a.dueDate).toLocaleString() + '</p>' : '') +
          '<p class="font-body-sm text-body-sm text-secondary mt-2">Expected: ' + (a.expectedResult || 'Take action') + '</p>' +
          '<div class="flex gap-2 mt-3">' +
            (a.contactId ? '<a href="#contacts/' + a.contactId + '" class="text-body-sm text-secondary hover:underline">View Contact</a>' : '') +
            (a.dealId ? '<a href="#deals/' + a.dealId + '" class="text-body-sm text-secondary hover:underline">View Deal</a>' : '') +
            (a.entityType === 'task' ? '<button class="text-body-sm text-secondary hover:underline" onclick="API.post(\'/tasks/' + a.entityId + '/complete\').then(() => window.PageModules.actionCenter.load())">Mark Complete</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  },
};
