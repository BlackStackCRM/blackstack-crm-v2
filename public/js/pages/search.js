window.PageModules = window.PageModules || {};

window.PageModules.search = {
  state: { query: '', types: new Set() },
  searchTimer: null,
  typeConfig: {
    contacts: { label: 'Contacts', icon: 'contacts', route: 'contacts' },
    organizations: { label: 'Organizations', icon: 'corporate_fare', route: 'organizations' },
    deals: { label: 'Deals', icon: 'handshake', route: 'deals' },
    products: { label: 'Products', icon: 'inventory_2', route: 'products' },
    invoices: { label: 'Invoices', icon: 'receipt_long', route: 'invoices' },
    tasks: { label: 'Tasks', icon: 'task_alt', route: 'tasks' },
    activities: { label: 'Activities', icon: 'history', route: 'activities' },
  },

  currentCurrency: 'USD',

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    // Load default currency from settings
    try {
      const settings = await API.get('/settings', {}, { silent: true });
      this.currentCurrency = settings.defaultCurrency || 'USD';
    } catch { /* use default */ }
    const initialQuery = new URLSearchParams(window.location.hash.split('?')[1] || '').get('q') || '';
    main.innerHTML = `
      <div class="mb-stack-lg">
        <h1 class="font-display text-h1 text-on-surface tracking-tight">Search</h1>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Search across all your CRM data.</p>
      </div>

      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 mb-stack-md">
        <div class="p-container-padding">
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]">search</span>
            <input id="srch-input" value="${initialQuery}" placeholder="Search contacts, deals, invoices..." class="w-full bg-surface-container-low py-3 pl-12 pr-4 rounded-lg font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/40" autofocus/>
          </div>
          <div class="flex flex-wrap items-center gap-stack-sm mt-stack-md">
            <span class="font-label-md text-label-md uppercase text-on-surface-variant">Quick filters:</span>
            ${Object.entries(this.typeConfig).map(([k, v]) => `<button data-type="${k}" class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border border-outline-variant hover:bg-secondary hover:text-on-secondary hover:border-secondary transition-colors font-body-sm"><span class="material-symbols-outlined text-[12px]">${v.icon}</span>${v.label}</button>`).join('')}
          </div>
        </div>
      </div>

      <div id="search-results"></div>
    `;
    this.bindEvents();
    if (initialQuery) this.performSearch(initialQuery);
    return () => { if (this.searchTimer) clearTimeout(this.searchTimer); };
  },

  bindEvents() {
    const input = document.getElementById('srch-input');
    input.addEventListener('input', (e) => {
      this.state.query = e.target.value;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.performSearch(this.state.query), 300);
    });
    document.querySelectorAll('[data-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.type;
        if (this.state.types.has(t)) { this.state.types.delete(t); btn.classList.remove('bg-secondary','text-on-secondary','border-secondary'); btn.classList.add('border-outline-variant'); }
        else { this.state.types.add(t); btn.classList.add('bg-secondary','text-on-secondary','border-secondary'); btn.classList.remove('border-outline-variant'); }
        this.performSearch(this.state.query);
      });
    });
  },

  async performSearch(q) {
    const container = document.getElementById('search-results');
    if (!q || q.length < 2) {
      container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[48px] text-on-surface-variant/40">search</span><p class="font-body-sm text-body-sm text-on-surface-variant mt-2">Type at least 2 characters to search</p></div>';
      return;
    }
    container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const types = Array.from(this.state.types);
      const res = await API.get('/search', { q, types: types.join(',') });
      this.renderResults(container, res?.data || res || {}, q);
    } catch (err) { this.renderErrorState(container, err); }
  },

  renderErrorState(container, err) {
    container.innerHTML = `
      <div class="p-12 text-center">
        <span class="material-symbols-outlined text-[48px] text-error/60">cloud_off</span>
        <p class="font-body-md text-on-surface mt-2">Search failed</p>
        <p class="font-body-sm text-body-sm text-on-surface-variant">${escHtml(err?.message || 'Unable to reach the server. Please try again.')}</p>
        <button id="search-retry" class="mt-4 px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md">Retry</button>
      </div>`;
    const retryBtn = container.querySelector('#search-retry');
    if (retryBtn) retryBtn.addEventListener('click', () => this.performSearch(q));
  },

  renderResults(container, data, q) {
    const groups = Object.entries(this.typeConfig).filter(([k]) => data[k] && data[k].length);
    if (!groups.length) {
      container.innerHTML = `<div class="p-12 text-center"><span class="material-symbols-outlined text-[48px] text-on-surface-variant/40">search_off</span><p class="font-body-md text-on-surface mt-2">No results for "${q}"</p><p class="font-body-sm text-body-sm text-on-surface-variant">Try a different search term</p></div>`;
      return;
    }
    container.innerHTML = '<div class="space-y-stack-md">' + groups.map(([k, cfg]) => `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <div class="px-container-padding py-stack-sm border-b border-outline-variant/30 flex items-center gap-stack-sm">
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">${cfg.icon}</span>
          <h3 class="font-h3 text-h3 text-on-surface">${cfg.label}</h3>
          <span class="font-label-md text-label-md text-on-surface-variant">${data[k].length}</span>
        </div>
        <div class="divide-y divide-outline-variant/30">
          ${data[k].map(item => this.renderItem(k, cfg, item)).join('')}
        </div>
      </div>
    `).join('') + '</div>';
  },

  renderItem(type, cfg, item) {
    const hash = `#${cfg.route}/${item.id}`;
    if (type === 'contacts') {
      return `<a href="${hash}" class="block p-container-padding hover:bg-surface-container-low transition-colors">
        <div class="flex items-center gap-stack-sm">
          <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-on-secondary text-[10px] font-semibold">${(item.firstName?.[0] || '')}${item.lastName?.[0] || ''}</div>
          <div class="flex-1 min-w-0">
            <p class="font-medium text-on-surface truncate">${item.name || (item.firstName + ' ' + item.lastName)}</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${item.email || ''} ${item.organization ? '· ' + item.organization : ''}</p>
          </div>
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">chevron_right</span>
        </div>
      </a>`;
    }
    if (type === 'organizations') {
      return `<a href="${hash}" class="block p-container-padding hover:bg-surface-container-low transition-colors">
        <div class="flex items-center gap-stack-sm">
          <div class="w-8 h-8 rounded-lg bg-secondary-container/20 flex items-center justify-center"><span class="material-symbols-outlined text-[18px] text-secondary">corporate_fare</span></div>
          <div class="flex-1 min-w-0">
            <p class="font-medium text-on-surface truncate">${item.name}</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${item.industry || ''}</p>
          </div>
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">chevron_right</span>
        </div>
      </a>`;
    }
    if (type === 'deals') {
      return `<a href="${hash}" class="block p-container-padding hover:bg-surface-container-low transition-colors">
        <div class="flex items-center gap-stack-sm">
          <div class="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center"><span class="material-symbols-outlined text-[18px] text-green-700">handshake</span></div>
          <div class="flex-1 min-w-0">
            <p class="font-medium text-on-surface truncate">${item.title}</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${item.stage || ''} · ${Currency.format(item.value || 0, this.currentCurrency)}</p>
          </div>
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">chevron_right</span>
        </div>
      </a>`;
    }
    if (type === 'invoices') {
      return `<a href="${hash}" class="block p-container-padding hover:bg-surface-container-low transition-colors">
        <div class="flex items-center gap-stack-sm">
          <div class="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center"><span class="material-symbols-outlined text-[18px] text-purple-700">receipt_long</span></div>
          <div class="flex-1 min-w-0">
            <p class="font-code text-code font-medium text-on-surface">${item.number}</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant">${Currency.format(item.total || 0, this.currentCurrency)} · ${item.status || ''}</p>
          </div>
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">chevron_right</span>
        </div>
      </a>`;
    }
    if (type === 'products') {
      return `<a href="${hash}" class="block p-container-padding hover:bg-surface-container-low transition-colors">
        <div class="flex items-center gap-stack-sm">
          <div class="w-8 h-8 rounded-lg bg-yellow-100 flex items-center justify-center"><span class="material-symbols-outlined text-[18px] text-yellow-700">inventory_2</span></div>
          <div class="flex-1 min-w-0">
            <p class="font-medium text-on-surface truncate">${item.name}</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant">${Currency.format(item.price || 0, this.currentCurrency)}</p>
          </div>
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">chevron_right</span>
        </div>
      </a>`;
    }
    return `<a href="${hash}" class="block p-container-padding hover:bg-surface-container-low transition-colors">
      <div class="flex items-center gap-stack-sm">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant">${cfg.icon}</span>
        <div class="flex-1 min-w-0">
          <p class="font-medium text-on-surface truncate">${item.title || item.name || ''}</p>
          ${item.status ? `<p class="font-body-sm text-body-sm text-on-surface-variant">${item.status}</p>` : ''}
        </div>
        <span class="material-symbols-outlined text-[18px] text-on-surface-variant">chevron_right</span>
      </div>
    </a>`;
  },
};
