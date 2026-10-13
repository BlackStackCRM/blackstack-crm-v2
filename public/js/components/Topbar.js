class Topbar {
  constructor() {
    this.searchContainer = document.getElementById('topbar-search');
    this.notificationsContainer = document.getElementById('topbar-notifications');
    this.userContainer = document.getElementById('topbar-user');
    this.notificationBadge = document.getElementById('notification-badge');
    this.searchDropdown = null;
    this.userDropdown = null;
    this.notificationDropdown = null;
    this.init();
  }

  init() {
    this.renderUserMenu();
    this.renderNotifications();
    this.attachEvents();
  }

  renderUserMenu() {
    if (!this.userContainer) return;
    const user = AuthAPI.getUser();
    const initials = `${user?.firstName?.[0] || ''}${user?.lastName?.[0] || ''}`.toUpperCase();
    this.userContainer.innerHTML = `
      <button id="user-menu-btn" class="flex items-center gap-stack-sm p-1 rounded-lg hover:bg-surface-container transition-colors" aria-haspopup="true" aria-expanded="false" aria-label="User menu">
        <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-on-secondary font-label-md text-[10px] font-semibold">
          ${initials || 'U'}
        </div>
        <span class="material-symbols-outlined text-[18px] text-on-surface-variant hidden sm:block">expand_more</span>
      </button>
      <div id="user-dropdown" class="hidden absolute right-0 top-full mt-2 w-56 bg-surface-container-lowest rounded-xl shadow-lg border border-outline-variant/50 py-1 z-50 animate-scale-in" role="menu">
        <div class="px-4 py-3 border-b border-outline-variant/30">
          <p class="font-body-sm text-body-sm text-on-surface font-medium">${user?.firstName || ''} ${user?.lastName || ''}</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant">${user?.email || ''}</p>
        </div>
        <a href="#profile" class="flex items-center gap-2 px-4 py-2 text-body-sm text-on-surface hover:bg-surface-container transition-colors" role="menuitem">
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">person</span>
          Profile
        </a>
        <a href="#settings" class="flex items-center gap-2 px-4 py-2 text-body-sm text-on-surface hover:bg-surface-container transition-colors" role="menuitem">
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">settings</span>
          Settings
        </a>
        <div class="border-t border-outline-variant/30 mt-1 pt-1">
          <button id="logout-btn" class="w-full flex items-center gap-2 px-4 py-2 text-body-sm text-error hover:bg-error-container/20 transition-colors text-left" role="menuitem">
            <span class="material-symbols-outlined text-[18px]">logout</span>
            Logout
          </button>
        </div>
      </div>
    `;
    this.userDropdown = document.getElementById('user-dropdown');
  }

  renderNotifications() {
    if (!this.notificationsContainer) return;
    this.notificationsContainer.innerHTML = `
      <button id="notifications-btn" class="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors relative" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant">notifications</span>
        <span id="notification-badge" class="absolute top-1.5 right-1.5 w-2 h-2 bg-error rounded-full hidden"></span>
      </button>
      <div id="notifications-dropdown" class="hidden absolute right-0 top-full mt-2 w-80 bg-surface-container-lowest rounded-xl shadow-lg border border-outline-variant/50 py-2 z-50 animate-scale-in" role="menu">
        <div class="px-4 py-3 border-b border-outline-variant/30 flex items-center justify-between">
          <p class="font-label-md text-label-md text-on-surface uppercase tracking-wider">Notifications</p>
          <button id="mark-all-read" class="text-body-sm text-secondary hover:underline">Mark all read</button>
        </div>
        <div id="notifications-list" class="max-h-80 overflow-y-auto">
          <div class="px-4 py-6 text-center">
            <span class="material-symbols-outlined text-[32px] text-on-surface-variant/50 mb-2 block animate-spin">progress_activity</span>
          </div>
        </div>
      </div>
    `;
    this.notificationDropdown = document.getElementById('notifications-dropdown');
    this.notificationBadge = document.getElementById('notification-badge');
    this.loadNotifications();
  }

  async loadNotifications() {
    try {
      const unread = await API.get('/notifications/unread-count');
      const count = unread?.count || 0;
      if (this.notificationBadge) {
        this.notificationBadge.classList.toggle('hidden', count === 0);
      }

      const res = await API.get('/notifications', { limit: 10 });
      const items = res?.items || res?.data?.items || [];
      const list = document.getElementById('notifications-list');
      if (!list) return;

      if (!items.length) {
        list.innerHTML = '<div class="px-4 py-6 text-center"><p class="font-body-sm text-body-sm text-on-surface-variant">No notifications yet</p></div>';
        return;
      }

      list.innerHTML = items.map(n => `
        <div class="px-4 py-3 hover:bg-surface-container-low transition-colors ${n.isRead ? '' : 'bg-secondary-container/5'}">
          <p class="font-body-sm text-body-sm text-on-surface font-medium">${n.title || ''}</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">${n.message || ''}</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${new Date(n.createdAt).toLocaleString()}</p>
        </div>
      `).join('');
    } catch {}
  }

  async markAllRead() {
    try {
      await API.post('/notifications/mark-all-read');
      this.loadNotifications();
    } catch {}
  }

  attachEvents() {
    document.addEventListener('click', (e) => {
      if (this.userDropdown && !this.userContainer.contains(e.target)) {
        this.userDropdown.classList.add('hidden');
      }
      if (this.notificationDropdown && !this.notificationsContainer.contains(e.target)) {
        this.notificationDropdown.classList.add('hidden');
      }
    });

    if (this.userContainer) {
      this.userContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('#user-menu-btn');
        if (btn) {
          e.stopPropagation();
          this.userDropdown.classList.toggle('hidden');
          btn.setAttribute('aria-expanded', !this.userDropdown.classList.contains('hidden'));
        }
        const logoutBtn = e.target.closest('#logout-btn');
        if (logoutBtn) {
          AuthAPI.logout().then(() => {
            window.location.href = '/login.html';
          });
        }
      });
    }

    if (this.notificationsContainer) {
      this.notificationsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('#notifications-btn');
        if (btn) {
          e.stopPropagation();
          this.notificationDropdown.classList.toggle('hidden');
        }
        const markRead = e.target.closest('#mark-all-read');
        if (markRead) {
          e.stopPropagation();
          this.markAllRead();
        }
      });
    }

    if (this.searchContainer) {
      const input = this.searchContainer.querySelector('input');
      if (input) {
        input.addEventListener('input', (e) => this.handleSearch(e.target.value));
      }
    }
  }

  handleSearch(query) {
    if (!query || query.length < 2) return;
    const event = new CustomEvent('global:search', { detail: { query } });
    window.dispatchEvent(event);
  }
}

window.Topbar = Topbar;
