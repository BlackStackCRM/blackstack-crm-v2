class Sidebar {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.navContainer = document.getElementById('sidebar-nav');
    this.userContainer = document.getElementById('sidebar-user');
    this.overlay = document.getElementById('sidebar-overlay');
    this.toggleBtn = document.getElementById('sidebar-toggle');
    this.currentPath = window.location.hash.replace('#', '') || 'dashboard';
    this.items = [
      { path: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { path: 'leads', label: 'Leads', icon: 'person_add' },
      { path: 'contacts', label: 'Contacts', icon: 'contacts' },
      { path: 'organizations', label: 'Organizations', icon: 'corporate_fare' },
      { path: 'deals', label: 'Deals', icon: 'handshake' },
      { path: 'tasks', label: 'Tasks', icon: 'task_alt' },
      { path: 'appointments', label: 'Appointments', icon: 'event' },
      { path: 'action-center', label: 'Action Center', icon: 'psychology' },
      { path: 'customer-bills', label: 'Customer Bills', icon: 'receipt_long' },
      { path: 'accounting', label: 'Accounting & Finance', icon: 'account_balance', children: [
        { path: 'accounting/chart-of-accounts', label: 'Chart of Accounts', icon: 'account_tree' },
        { path: 'accounting/journal', label: 'Journal', icon: 'description' },
        { path: 'accounting/bills', label: 'Bills', icon: 'receipt_long' },
        { path: 'accounting/receivables', label: 'Receivables', icon: 'trending_down' },
        { path: 'accounting/payables', label: 'Payables', icon: 'payments' },
        { path: 'accounting/outstanding', label: 'Outstanding', icon: 'account_balance_wallet' },
        { path: 'accounting/ledger', label: 'Ledger', icon: 'book' },
        { path: 'accounting/reports', label: 'Reports', icon: 'insights' },
        { path: 'accounting/cost-centres', label: 'Cost Centres', icon: 'business' },
        { path: 'accounting/budgets', label: 'Budgets', icon: 'pie_chart' },
        { path: 'accounting/bank-accounts', label: 'Bank Accounts', icon: 'account_balance' },
      ] },
      { path: 'products', label: 'Products', icon: 'inventory_2', children: [
        { path: 'products', label: 'Products', icon: 'inventory_2' },
        { path: 'inventory', label: 'Inventory Management', icon: 'warehouse' },
      ] },
      { path: 'workflows', label: 'Workflows', icon: 'account_tree' },
      { path: 'reports', label: 'Reports', icon: 'insights' },
      { path: 'settings', label: 'Settings', icon: 'settings' },
      { path: 'users', label: 'Users', icon: 'group' },
      { path: 'profile', label: 'Profile', icon: 'account_circle' },
      {
        path: 'mother-company',
        label: 'Mother Company Control',
        icon: 'corporate_fare',
        // Usability only: this entry is hidden from users without a
        // mother_company.* permission so they never see a link that would 403.
        // The actual access control is server-side in middleware/motherCompany.js,
        // which does not honour the '*' wildcard customer admins carry.
        requiresAnyPermission: 'mother_company.',
      },
    ];
    this.init();
  }

  init() {
    this.render();
    this.attachEvents();
    this.updateUser();
  }

  /**
   * Permissions attached to the signed-in user, as granted by the server.
   * Returns [] when nothing is stored, which hides every gated entry — the safe
   * default, since showing an entry that will 403 is worse than hiding one.
   */
  userPermissions() {
    try {
      const raw = localStorage.getItem('crm_user');
      const user = raw ? JSON.parse(raw) : null;
      const list = (user && user.permissions) || [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** Drop nav items the current user is not permitted to use. */
  visibleItems() {
    const perms = this.userPermissions();
    return this.items.filter((item) => {
      if (!item.requiresAnyPermission) return true;
      return perms.some((p) => String(p).startsWith(item.requiresAnyPermission));
    });
  }

  render() {
    if (!this.navContainer) return;
    const isParentActive = (item) => item.children
      ? this.currentPath.startsWith(item.path) || item.children.some(c => this.currentPath === c.path)
      : false;
    // Render only entries this user is permitted to use (see visibleItems()).
    this.navContainer.innerHTML = this.visibleItems().map(item => {
      const isActive = this.currentPath === item.path;
      const activeClass = isActive
        ? 'bg-secondary-container text-on-secondary-container font-semibold'
        : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface';

      if (item.children) {
        // Parent item with children
        const accExpanded = isParentActive(item);
        return `
          <div class="flex flex-col">
            <a href="#${item.path}" data-path="${item.path}"
               class="flex items-center justify-between gap-stack-md px-stack-md py-stack-sm rounded-lg ${activeClass} transition-colors">
              <div class="flex items-center gap-stack-md">
                <span class="material-symbols-outlined text-[20px]">${item.icon}</span>
                <span class="text-body-md">${item.label}</span>
              </div>
              <span class="material-symbols-outlined text-[16px] transition-transform ${accExpanded ? 'rotate-90' : ''}">chevron_right</span>
            </a>
            ${accExpanded ? item.children.map(child => {
              const childActive = this.currentPath === child.path;
              const childClass = childActive
                ? 'bg-secondary-container text-on-secondary-container font-semibold'
                : 'text-on-surface-variant hover:bg-secondary-container hover:text-on-surface';
              return `
                <a href="#${child.path}" data-path="${child.path}"
                   class="flex items-center gap-stack-md px-stack-md py-stack-sm rounded-lg ${childClass} transition-colors ml-6">
                  <span class="material-symbols-outlined text-[16px]">${child.icon}</span>
                  <span class="text-body-md text-sm">${child.label}</span>
                </a>
              `;
            }).join('') : ''}
          </div>
        `;
      }

      // Regular item
      return `
        <a href="#${item.path}" data-path="${item.path}"
           class="flex items-center gap-stack-md px-stack-md py-stack-sm rounded-lg ${activeClass} transition-colors">
          <span class="material-symbols-outlined text-[20px]">${item.icon}</span>
          <span class="text-body-md">${item.label}</span>
        </a>
      `;
    }).join('');
  }

  attachEvents() {
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', () => this.toggle());
    }
    if (this.overlay) {
      this.overlay.addEventListener('click', () => this.close());
    }
    if (this.navContainer) {
      this.navContainer.addEventListener('click', (e) => {
        const link = e.target.closest('a[data-path]');
        if (link) {
          e.preventDefault();
          this.navigate(link.dataset.path);
        }
      });
    }
  }

  navigate(path) {
    this.currentPath = path;
    this.render();
    window.location.hash = path;
    this.close();
    const event = new CustomEvent('page:navigate', { detail: { path } });
    window.dispatchEvent(event);
  }

  toggle() {
    this.container.classList.toggle('-translate-x-full');
    this.overlay.classList.toggle('hidden');
    document.body.style.overflow = this.container.classList.contains('-translate-x-full') ? '' : 'hidden';
  }

  close() {
    if (window.innerWidth < 768) {
      this.container.classList.add('-translate-x-full');
      this.overlay.classList.add('hidden');
      document.body.style.overflow = '';
    }
  }

  updateUser() {
    if (!this.userContainer) return;
    const user = AuthAPI.getUser();
    if (user) {
      const initials = `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase();
      this.userContainer.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-on-secondary font-label-md text-[10px] font-semibold shrink-0">
          ${initials || 'U'}
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-body-sm text-body-sm text-on-surface truncate font-medium">${user.firstName || ''} ${user.lastName || ''}</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${user.email || ''}</p>
        </div>
      `;
    }
  }

  setActive(path) {
    this.currentPath = path;
    this.render();
  }
}

window.Sidebar = Sidebar;
