window.PageModules = window.PageModules || {};

window.PageModules.activities = {
  state: { search: '', type: '', contact: '', deal: '', from: '', to: '' },
  searchTimer: null,
  typeConfig: {
    call: { icon: 'call', color: 'bg-blue-100 text-blue-700', label: 'Call' },
    email: { icon: 'mail', color: 'bg-purple-100 text-purple-700', label: 'Email' },
    meeting: { icon: 'event', color: 'bg-green-100 text-green-700', label: 'Meeting' },
    note: { icon: 'sticky_note_2', color: 'bg-yellow-100 text-yellow-700', label: 'Note' },
    demo: { icon: 'videocam', color: 'bg-pink-100 text-pink-700', label: 'Demo' },
    'follow-up': { icon: 'schedule', color: 'bg-orange-100 text-orange-700', label: 'Follow-up' },
  },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Activities</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Timeline of all interactions and events.</p>
        </div>
        <button id="act-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">
          <span class="material-symbols-outlined text-[18px]">add</span> New Activity
        </button>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 mb-stack-md">
        <div class="p-container-padding border-b border-outline-variant/30 flex flex-wrap items-center gap-stack-md">
          <div class="relative flex-1 min-w-[200px]">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="act-search" placeholder="Search activities..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <select id="act-type" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="">All types</option>
            ${Object.entries(this.typeConfig).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
          <input id="act-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          <input id="act-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
      </div>

      <div id="act-timeline" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30"></div>
    `;

    this.bindEvents();
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('act-new').addEventListener('click', () => this.openForm());
    document.getElementById('act-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.load(); }, 300);
    });
    document.getElementById('act-type').addEventListener('change', (e) => { this.state.type = e.target.value; this.load(); });
    document.getElementById('act-from').addEventListener('change', (e) => { this.state.from = e.target.value; this.load(); });
    document.getElementById('act-to').addEventListener('change', (e) => { this.state.to = e.target.value; this.load(); });
  },

  async load() {
    const container = document.getElementById('act-timeline');
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { ...this.state };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/activities', params);
      const items = res?.data?.items || res?.items || res?.data || res || [];
      this.renderTimeline(container, items);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  renderTimeline(container, items) {
    if (!items.length) {
      container.innerHTML = `<div class="p-12 text-center"><span class="material-symbols-outlined text-[48px] text-on-surface-variant/40">event_busy</span><p class="font-body-sm text-body-sm text-on-surface-variant mt-2">No activities found</p></div>`;
      return;
    }
    const groups = this.groupByDate(items);
    container.innerHTML = Object.entries(groups).map(([date, acts]) => `
      <div class="border-b border-outline-variant/30 last:border-0">
        <div class="px-container-padding py-2 bg-surface-container-low sticky top-16 z-10">
          <h3 class="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">${this.formatDateHeader(date)}</h3>
        </div>
        <div class="divide-y divide-outline-variant/30">
          ${acts.map(a => this.renderActivityItem(a)).join('')}
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = +btn.dataset.act;
        const item = items.find(i => i.id === id);
        if (item) this.openForm(item);
      });
    });
  },

  renderActivityItem(a) {
    const cfg = this.typeConfig[a.type] || this.typeConfig.note;
    return `
      <div class="p-container-padding hover:bg-surface-container-low transition-colors flex items-start gap-stack-md group">
        <div class="w-10 h-10 rounded-full ${cfg.color} flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[18px]">${cfg.icon}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-stack-sm">
            <div class="flex-1 min-w-0">
              <p class="font-body-md text-body-md text-on-surface font-medium">${a.title || a.description || ''}</p>
              ${a.description && a.title ? `<p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${a.description}</p>` : ''}
              <div class="flex items-center gap-stack-md mt-2 font-body-sm text-body-sm text-on-surface-variant">
                <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">${cfg.icon}</span>${cfg.label}</span>
                ${a.contactName ? `<span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">person</span>${a.contactName}</span>` : ''}
                ${a.dealTitle ? `<span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">handshake</span>${a.dealTitle}</span>` : ''}
                <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">schedule</span>${this.timeAgo(a.createdAt || a.date)}</span>
              </div>
            </div>
            <button data-act="${a.id}" class="opacity-0 group-hover:opacity-100 w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant">
              <span class="material-symbols-outlined text-[18px]">edit</span>
            </button>
          </div>
        </div>
      </div>
    `;
  },

  groupByDate(items) {
    const groups = {};
    items.forEach(a => {
      const d = a.createdAt || a.date;
      const key = d ? new Date(d).toISOString().slice(0, 10) : 'Unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(a);
    });
    return groups;
  },

  formatDateHeader(dateStr) {
    if (dateStr === 'Unknown') return 'Unknown';
    const d = new Date(dateStr);
    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const target = new Date(d); target.setHours(0,0,0,0);
    if (target.getTime() === today.getTime()) return 'Today';
    if (target.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  },

  timeAgo(date) {
    if (!date) return '';
    const diff = Date.now() - new Date(date).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  },
openForm(row = null) {
    const isEdit = !!row;
    const a = row || {};
    const modal = new Modal({
      title: isEdit ? 'Edit Activity' : 'New Activity',
      size: 'md',
      content: `<form id="act-form" class="grid grid-cols-2 gap-stack-md">
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Type *</label>
          <select name="type" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
            ${Object.entries(this.typeConfig).map(([k, v]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Date *</label>
          <input name="createdAt" type="datetime-local" required value="${a.createdAt ? a.createdAt.slice(0,16) : new Date().toISOString().slice(0,16)}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div class="col-span-2">
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Title *</label>
          <input name="title" required value="${a.title || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Contact</label>
          <input name="contactName" value="${a.contactName || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div>
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Deal</label>
          <input name="dealTitle" value="${a.dealTitle || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
        </div>
        <div class="col-span-2">
          <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Description</label>
          <textarea name="description" rows="3" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">${a.description || ''}</textarea>
        </div>
        <div class="col-span-2 flex justify-between gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
          ${isEdit ? '<button type="button" id="act-delete" class="text-error hover:bg-error-container/20 px-3 py-2 rounded-lg">Delete</button>' : '<div></div>'}
          <div class="flex gap-stack-sm">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </div>
      </form>`,
    });
    modal.open();
    modal.element.querySelector('#act-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd.entries());
      try {
        if (isEdit) await API.put(`/activities/${a.id}`, payload);
        else await API.post('/activities', payload);
        Toast.success(isEdit ? 'Activity updated' : 'Activity created');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
    if (isEdit) {
      modal.element.querySelector('#act-delete').addEventListener('click', async () => {
        if (!confirm('Delete this activity?')) return;
        try { await API.del(`/activities/${a.id}`); Toast.success('Deleted'); modal.close(); this.load(); }
        catch (err) { Toast.error(err.message || 'Failed'); }
      });
    }
  },
};
