/**
 * EntitySelector — backend-powered searchable selector for Contacts / Organizations.
 *
 * Usage:
 *   const sel = new EntitySelector(container, {
 *     type: 'contact' | 'organization',
 *     placeholder: 'Select contact...',
 *     onChange: (record | null) => {},
 *     filters: { organization_id: 'org_123' },   // extra query params for backend search
 *     allowCreate: true,                          // show "+ Create ..." shortcut
 *     onCreate: async () => { ... return createdRecordOrNull; }
 *   });
 *
 * The selection is stored on `sel.value` ({ id, label, ...record }) or null.
 * Search is performed by the backend (tenant-scoped): /contacts?search=... or /organizations?search=...
 */
class EntitySelector {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.options = Object.assign({ type: 'contact', placeholder: 'Select...', filters: {} }, options);
    this.value = null;
    this.items = [];
    this.timer = null;
    this.open = false;
    this.render();
  }

  get endpoint() {
    return this.options.type === 'organization' ? '/organizations' : '/contacts';
  }

  labelFor(r) {
    if (this.options.type === 'organization') return r.name || r.Name || r.id;
    return [r.firstName || r.first_name, r.lastName || r.last_name].filter(Boolean).join(' ') || r.email || r.id;
  }

  sublabelFor(r) {
    if (this.options.type === 'organization') return r.industry || r.website || '';
    return r.email || r.phone || '';
  }

  render() {
    this.container.classList.add('entity-selector');
    this.container.innerHTML = `
      <div class="relative">
        <div class="flex items-center gap-1 bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 focus-within:ring-2 focus-within:ring-secondary/40">
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">${this.options.type === 'organization' ? 'corporate_fare' : 'person'}</span>
          <input type="text" class="es-input flex-1 bg-transparent border-none outline-none text-body-md min-w-0" placeholder="${this.options.placeholder}" autocomplete="off"/>
          <button type="button" class="es-clear hidden text-on-surface-variant hover:text-on-surface" title="Clear selection"><span class="material-symbols-outlined text-[18px]">close</span></button>
          <span class="es-spinner hidden material-symbols-outlined text-[18px] animate-spin text-on-surface-variant">progress_activity</span>
        </div>
        <div class="es-dropdown hidden absolute z-[80] left-0 right-0 mt-1 bg-surface-bright border border-outline-variant/50 rounded-lg shadow-lg max-h-64 overflow-y-auto"></div>
        ${this.options.allowCreate ? '<button type="button" class="es-create mt-1 text-body-sm text-secondary hover:underline flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">add</span>Create ' + (this.options.type === 'organization' ? 'Organization' : 'Contact') + '</button>' : ''}
      </div>
    `;
    this.input = this.container.querySelector('.es-input');
    this.dropdown = this.container.querySelector('.es-dropdown');
    this.spinner = this.container.querySelector('.es-spinner');
    this.clearBtn = this.container.querySelector('.es-clear');

    this.input.addEventListener('input', () => {
      this.clearSelection(false);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.search(this.input.value.trim()), 250);
      this.showDropdown();
    });
    this.input.addEventListener('focus', () => { if (!this.value) this.showDropdown(); });
    this.clearBtn.addEventListener('click', () => { this.clearSelection(true); this.input.focus(); });
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target)) this.hideDropdown();
    });
    const createBtn = this.container.querySelector('.es-create');
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        if (!this.options.onCreate) return;
        const created = await this.options.onCreate();
        if (created && created.id) this.setValue(created);
      });
    }
  }

  showDropdown() {
    this.dropdown.classList.remove('hidden');
    this.open = true;
    if (!this.input.value.trim()) {
      this.search('');
    }
  }

  hideDropdown() {
    this.dropdown.classList.add('hidden');
    this.open = false;
  }

  setState(html) {
    this.dropdown.innerHTML = html;
  }

  async search(term) {
    this.spinner.classList.remove('hidden');
    this.setState('<div class="p-4 text-center text-body-sm text-on-surface-variant">Loading...</div>');
    try {
      const params = new URLSearchParams({ limit: '20', ...Object.fromEntries(Object.entries(this.options.filters).filter(([, v]) => v)) });
      if (term) params.set('search', term);
      const res = await API.get(`${this.endpoint}?${params.toString()}`);
      const data = res?.data || res || {};
      this.items = data.items || data.contacts || data.organizations || (Array.isArray(data) ? data : []);
      if (!this.items.length) {
        this.setState('<div class="p-4 text-center text-body-sm text-on-surface-variant">No records found</div>');
      } else {
        this.setState(this.items.map((r, i) => `
          <button type="button" data-idx="${i}" class="es-option w-full text-left px-3 py-2 hover:bg-surface-container transition-colors">
            <span class="block font-body-md text-body-md text-on-surface">${this.escapeHtml(this.labelFor(r))}</span>
            <span class="block font-body-sm text-body-sm text-on-surface-variant truncate">${this.escapeHtml(this.sublabelFor(r) || '')}</span>
          </button>
        `).join(''));
        this.dropdown.querySelectorAll('.es-option').forEach(btn => {
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.setValue(this.items[+btn.dataset.idx]);
            this.hideDropdown();
          });
        });
      }
    } catch (err) {
      this.setState('<div class="p-4 text-center text-body-sm text-error">Failed to load. ' + this.escapeHtml(err.message || '') + '</div>');
    } finally {
      this.spinner.classList.add('hidden');
    }
  }

  setValue(record) {
    this.value = record;
    this.input.value = this.labelFor(record);
    this.clearBtn.classList.remove('hidden');
    if (this.options.onChange) this.options.onChange(record);
  }

  clearSelection(fireChange = true) {
    this.value = null;
    if (!this.input.value) this.clearBtn.classList.add('hidden');
    if (fireChange && this.options.onChange) this.options.onChange(null);
  }

  getValue() { return this.value; }

  escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
}

window.EntitySelector = EntitySelector;
