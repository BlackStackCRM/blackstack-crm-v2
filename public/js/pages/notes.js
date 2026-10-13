window.PageModules = window.PageModules || {};

window.PageModules.notes = {
  state: { search: '' },
  searchTimer: null,

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Notes</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Capture ideas, context, and important information.</p>
        </div>
        <button id="note-new" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 transition-colors">
          <span class="material-symbols-outlined text-[18px]">add</span> New Note
        </button>
      </div>
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 mb-stack-md">
        <div class="p-container-padding border-b border-outline-variant/30">
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
            <input id="note-search" placeholder="Search notes..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
        </div>
      </div>
      <div id="notes-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-stack-md"></div>
    `;
    this.bindEvents();
    await this.load();
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    document.getElementById('note-new').addEventListener('click', () => this.openForm());
    document.getElementById('note-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.state.search = e.target.value; this.load(); }, 300);
    });
  },

  async load() {
    const container = document.getElementById('notes-list');
    container.innerHTML = '<div class="col-span-3 p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const params = { search: this.state.search };
      Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
      const res = await API.get('/notes', params);
      const items = res?.data?.items || res?.items || res?.data || res || [];
      this.renderList(container, items);
    } catch { ErrorState.render(container, () => this.load()); }
  },

  renderList(container, items) {
    if (!items.length) {
      container.innerHTML = '<div class="col-span-3 p-12 text-center"><span class="material-symbols-outlined text-[48px] text-on-surface-variant/40">sticky_note_2</span><p class="font-body-sm text-body-sm text-on-surface-variant mt-2">No notes yet</p></div>';
      return;
    }
    container.innerHTML = items.map(n => this.renderCard(n)).join('');
    container.querySelectorAll('[data-card]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        const id = card.dataset.card;
        const item = items.find(i => i.id === id);
        if (item) this.openForm(item);
      });
      const del = card.querySelector('[data-act="delete"]');
      if (del) del.addEventListener('click', async (e) => { e.stopPropagation(); await this.confirmDelete(card.dataset.card); });
    });
  },

  renderCard(n) {
    const relatedColors = { contact: 'bg-blue-100 text-blue-700', organization: 'bg-purple-100 text-purple-700', deal: 'bg-green-100 text-green-700', none: '' };
    const relatedLabels = { contact: 'Contact', organization: 'Organization', deal: 'Deal' };
    let relatedBadge = '<span></span>';
    if (n.contact_id) {
      relatedBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${relatedColors.contact}"><span class="material-symbols-outlined text-[12px]">link</span>Contact: ${n.related_contact_name || ''}</span>`;
    } else if (n.organization_id) {
      relatedBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${relatedColors.organization}"><span class="material-symbols-outlined text-[12px]">link</span>Organization: ${n.related_organization_name || ''}</span>`;
    } else if (n.deal_id) {
      relatedBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${relatedColors.deal}"><span class="material-symbols-outlined text-[12px]">link</span>Deal: ${n.related_deal_name || ''}</span>`;
    }
    return `
      <div data-card="${n.id}" class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding hover:shadow-md transition-all cursor-pointer group">
        <div class="flex items-start justify-between mb-stack-sm">
          <h3 class="font-h3 text-h3 text-on-surface line-clamp-2 flex-1">${n.title || 'Untitled'}</h3>
          <button data-act="delete" class="opacity-0 group-hover:opacity-100 w-7 h-7 rounded hover:bg-error-container/20 flex items-center justify-center text-error" aria-label="Delete">
            <span class="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant line-clamp-4 mb-stack-md whitespace-pre-wrap">${n.content || ''}</p>
        <div class="flex items-center justify-between text-body-sm text-body-md">
          ${relatedBadge}
          <span class="text-on-surface-variant">${this.formatDate(n.createdAt)}</span>
        </div>
      </div>
    `;
  },

  formatDate(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },

  openForm(row = null) {
    const isEdit = !!row;
    const n = row || {};
    const relatedType = n.contact_id ? 'contact' : n.organization_id ? 'organization' : n.deal_id ? 'deal' : 'none';

    const modal = new Modal({
      title: isEdit ? 'Edit Note' : 'New Note',
      size: 'lg',
      content: `
        <form id="note-form" class="space-y-stack-md">
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Title</label>
            <input name="title" value="${n.title || ''}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
          </div>
          <div>
            <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Content *</label>
            <textarea name="content" required rows="6" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">${n.content || ''}</textarea>
          </div>
          <div class="grid grid-cols-2 gap-stack-md">
            <div>
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Related To</label>
              <select name="relatedType" id="note-related-type" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40">
                <option value="none">None</option>
                <option value="contact" ${n.contact_id ? 'selected' : ''}>Contact</option>
                <option value="organization" ${n.organization_id ? 'selected' : ''}>Organization</option>
                <option value="deal" ${n.deal_id ? 'selected' : ''}>Deal</option>
              </select>
            </div>
            <div id="note-selector-wrap" class="hidden">
              <label class="block font-label-md text-label-md text-on-surface-variant uppercase mb-1">Entity</label>
              <div id="note-entity-selector"></div>
            </div>
          </div>
          <div class="flex justify-end gap-stack-sm pt-stack-sm border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container">Cancel</button>
            <button type="submit" class="bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      `,
    });
    modal.open();

    // Track selected related entity IDs
    let relatedIds = { contact_id: n.contact_id || null, organization_id: null, deal_id: null };
    const typeSelect = modal.element.querySelector('#note-related-type');
    const selectorWrap = modal.element.querySelector('#note-selector-wrap');

    // Initialize EntitySelector based on selected type
    const initSelector = (type) => {
      if (!type || type === 'none') {
        selectorWrap.classList.add('hidden');
        relatedIds = { contact_id: null, organization_id: null, deal_id: null };
        return;
      }
      selectorWrap.classList.remove('hidden');

      try {
        const entitySelector = new EntitySelector(modal.element.querySelector('#note-entity-selector'), {
          type: type,
          placeholder: `Select ${type}...`,
          allowCreate: false,
          onChange: (entity) => {
            relatedIds = { contact_id: null, organization_id: null, deal_id: null };
            if (entity) {
              if (type === 'contact') relatedIds.contact_id = entity.id;
              if (type === 'organization') relatedIds.organization_id = entity.id;
              if (type === 'deal') relatedIds.deal_id = entity.id;
            }
          },
        });

        // If editing and the entity ID matches the selected type, load it
        if (isEdit) {
          let preloadId = null;
          if (type === 'contact') preloadId = n.contact_id;
          if (type === 'organization') preloadId = n.organization_id;
          if (type === 'deal') preloadId = n.deal_id;
          if (preloadId) {
            entitySelector.loadAndSetValue(preloadId);
          }
        }
      } catch (e) {
        console.error('EntitySelector init failed:', e);
      }
    };

    typeSelect.addEventListener('change', () => {
      initSelector(typeSelect.value);
    });

    initSelector(relatedType);

    modal.element.querySelector('#note-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        title: fd.get('title'),
        content: fd.get('content'),
        contact_id: relatedIds.contact_id,
        organization_id: relatedIds.organization_id,
        deal_id: relatedIds.deal_id,
      };
      try {
        if (isEdit) await API.put(`/notes/${n.id}`, payload);
        else await API.post('/notes', payload);
        Toast.success(isEdit ? 'Note updated' : 'Note created');
        modal.close();
        this.load();
      } catch (err) { Toast.error(err.message || 'Failed'); }
    });
  },

  async confirmDelete(id) {
    if (!confirm('Delete this note?')) return;
    try {
      await API.del(`/notes/${id}`);
      Toast.success('Note deleted');
      this.load();
    } catch (err) { Toast.error(err.message || 'Failed'); }
  },
};