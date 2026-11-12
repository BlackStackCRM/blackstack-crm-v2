class Sidebar {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.navContainer = document.getElementById('sidebar-nav');
    this.userContainer = document.getElementById('sidebar-user');
    this.overlay = document.getElementById('sidebar-overlay');
    this.toggleBtn = document.getElementById('sidebar-toggle');
    this.currentPath = window.location.hash.replace('#', '') || 'dashboard';
    this.items = [
      { path: 'dashboard', label: 'Dashboard', icon: 'dashboard', permission: 'dashboard.view' },
      { path: 'leads', label: 'Leads', icon: 'person_add', permission: 'leads.view' },
      { path: 'contacts', label: 'Contacts', icon: 'contacts', permission: 'contacts.view' },
      { path: 'organizations', label: 'Organizations', icon: 'corporate_fare', permission: 'organizations.view' },
      { path: 'deals', label: 'Deals', icon: 'handshake', permission: 'deals.view' },
      { path: 'tasks', label: 'Tasks', icon: 'task_alt', permission: 'tasks.view' },
      { path: 'appointments', label: 'Appointments', icon: 'event', permission: 'appointments.view' },
      { path: 'action-center', label: 'Action Center', icon: 'psychology', anyPermissions: ['leads.view', 'deals.view', 'tasks.view'] },
      { path: 'customer-bills', label: 'Customer Bills', icon: 'receipt_long', permission: 'customer_bills.view' },
      { path: 'accounting', label: 'Accounting & Finance', icon: 'account_balance', children: [
        { path: 'accounting/chart-of-accounts', label: 'Chart of Accounts', icon: 'account_tree', permission: 'accounting.view' },
        { path: 'accounting/journal', label: 'Journal', icon: 'description', permission: 'accounting.view' },
        { path: 'accounting/bills', label: 'Bills', icon: 'receipt_long', permission: 'accounting.view' },
        { path: 'accounting/receivables', label: 'Receivables', icon: 'trending_down', permission: 'accounting.view' },
        { path: 'accounting/payables', label: 'Payables', icon: 'payments', permission: 'accounting.view' },
        { path: 'accounting/outstanding', label: 'Outstanding', icon: 'account_balance_wallet', permission: 'accounting.view' },
        { path: 'accounting/ledger', label: 'Ledger', icon: 'book', permission: 'accounting.view' },
        { path: 'accounting/reports', label: 'Reports', icon: 'insights', permission: 'reports.view' },
        { path: 'accounting/cost-centres', label: 'Cost Centres', icon: 'business', permission: 'accounting.view' },
        { path: 'accounting/budgets', label: 'Budgets', icon: 'pie_chart', permission: 'accounting.view' },
        { path: 'accounting/bank-accounts', label: 'Bank Accounts', icon: 'account_balance', permission: 'accounting.view' },
      ] },
      { path: 'products', label: 'Products', icon: 'inventory_2', children: [
        { path: 'products', label: 'Products', icon: 'inventory_2', permission: 'products.view' },
        { path: 'inventory', label: 'Inventory Management', icon: 'warehouse', permission: 'inventory.view' },
      ] },
      { path: 'workflows', label: 'Workflows', icon: 'account_tree', permission: 'workflows.view' },
      { path: 'reports', label: 'Reports', icon: 'insights', permission: 'reports.view' },
      { path: 'settings', label: 'Settings', icon: 'settings' },
      { path: 'users', label: 'Users', icon: 'group' },
      { path: 'profile', label: 'Profile', icon: 'account_circle' },
      { path: 'wallet', label: 'Wallet', icon: 'account_balance_wallet' },
      { path: 'subscriptions', label: 'Subscriptions', icon: 'autorenew', requiresRole: ['platform'] },
      { path: 'storage', label: 'Storage', icon: 'database', requiresRole: ['platform'] },
      { path: 'customer-tenants', label: 'Customer Tenants', icon: 'groups', requiresCapability: 'viewCustomerTenants' },
      {
        path: 'agency-control',
        label: 'Agency Control',
        icon: 'account_tree',
        requiresAnyPermission: 'agency_control.',
      },
      {
        path: 'mother-company',
        label: 'Mother Company Control',
        icon: 'corporate_fare',
        requiresAnyPermission: 'mother_company.',
      },
    ];
    this.ready = this.init();
  }

  async init() {
    await this.refreshProfile();
    this.render();
    this.attachEvents();
    this.updateUser();
  }

  async refreshProfile() {
    try {
      const profile = await AuthAPI.getProfile();
      const user = profile || {};
      localStorage.setItem('crm_user', JSON.stringify(user));
    } catch {
      localStorage.removeItem('crm_token');
      localStorage.removeItem('crm_user');
      document.cookie = 'crm_token=; Path=/; Max-Age=0; SameSite=Lax';
      window.location.href = '/login.html';
    }
  }

  /** Permissions attached to the signed-in user, as granted by the server. */
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

  userEmail() {
    try {
      const raw = localStorage.getItem('crm_user');
      const user = raw ? JSON.parse(raw) : null;
      return user && typeof user.email === 'string' ? user.email : '';
    } catch {
      return '';
    }
  }

  /** Drop nav items the current user is not permitted to use. */
  visibleItems() {
    const perms = this.userPermissions();
    const hasPermission = (permission) => perms.includes('*') || perms.includes(permission);
    // Role gates for privileged navigation are based on the server profile.
    const user = AuthAPI.getUser();
    const role = window.RolePermissions
      ? window.RolePermissions.normalizeRole(user)
      : (user ? (user.hierarchyRole || this.roleFromLegacy(user)) : null);
    return this.items.map((item) => {
      if (item.path === 'mother-company') {
        const allowed = window.RolePermissions
          ? window.RolePermissions.canViewMotherCompany()
          : role === 'platform';
        if (!allowed && !(user && user.email === 'admin@blackstack.local')) return null;
      }
      if (item.path === 'agency-control') {
        const allowed = window.RolePermissions
          ? window.RolePermissions.canViewAgencyControl()
          : ['platform', 'agency'].includes(role);
        if (!allowed) return null;
      }
      if (item.path === 'users' && window.RolePermissions && !window.RolePermissions.canViewUsers()) return null;
      if (item.path === 'users' && role === 'customer_tenant') return null;
      // Customer tenants get the account and appearance tabs only. Their
      // system/data-safety settings remain hidden and server-protected.
      if (item.path === 'settings' && role === 'customer_tenant') return item;
      if (item.path === 'settings' && window.RolePermissions && !window.RolePermissions.canViewSettings()) return null;
      if (item.requiresCapability && !(window.RolePermissions && window.RolePermissions.can(item.requiresCapability))) return null;
      if (item.requiresRole) {
        if (!role || !item.requiresRole.includes(role)) return null;
      }
      if (item.permission && !hasPermission(item.permission)) return null;
      if (item.anyPermissions && !item.anyPermissions.some(hasPermission)) return null;
      if (item.children) {
        const children = item.children.filter((child) => !child.permission || hasPermission(child.permission));
        if (!children.length) return null;
        return { ...item, children };
      }
      if (!item.requiresAnyPermission) return item;
      // Always show Mother Company for the super-admin account so it is not
      // hidden by stale client-side permissions/cache.
      if (item.path === 'mother-company') {
        if (user && user.email === 'admin@blackstack.local') return item;
      }
      return perms.some((p) => p === '*' || String(p).startsWith(item.requiresAnyPermission)) ? item : null;
    }).filter(Boolean);
  }

  /** Map legacy role strings onto the 3-level hierarchy model. Mirrors the
   *  server's resolveCaller() normalization. */
  roleFromLegacy(user) {
    if (user.role === 'ADMIN') return 'platform';
    if (user.role === 'AGENCY' || user.role === 'agency') return 'agency';
    if (user.role === 'AGENCY_ADMIN' || user.role === 'sub_agency') return 'sub_agency';
    if (user.role === 'CUSTOMER_ADMIN' || user.role === 'customer_tenant') return 'customer_tenant';
    return null;
  }

  render() {
    if (!this.navContainer) return;
    const isParentActive = (item) => item.children
      ? this.currentPath.startsWith(item.path) || item.children.some(c => this.currentPath === c.path)
      : false;
    this.navContainer.innerHTML = this.visibleItems().map(item => {
      const isActive = this.currentPath === item.path;
      const activeClass = isActive
        ? 'bg-secondary-container text-on-secondary-container font-semibold'
        : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface';

      if (item.children) {
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
                : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface';
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
