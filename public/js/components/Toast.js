class Toast {
  static container = null;

  static getContainer() {
    if (!this.container) {
      this.container = document.getElementById('toast-container');
    }
    return this.container;
  }

  static show(message, type = 'info', duration = 4000) {
    const container = this.getContainer();
    if (!container) return;

    const toast = document.createElement('div');
    const icons = {
      success: 'check_circle',
      error: 'error',
      warning: 'warning',
      info: 'info',
    };
    const colors = {
      success: 'bg-green-50 text-green-800 border-green-200',
      error: 'bg-red-50 text-red-800 border-red-200',
      warning: 'bg-yellow-50 text-yellow-800 border-yellow-200',
      info: 'bg-blue-50 text-blue-800 border-blue-200',
    };

    toast.className = `pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-lg border shadow-lg ${colors[type] || colors.info} text-sm font-medium animate-slide-in`;
    toast.setAttribute('role', 'alert');
    toast.innerHTML = `
      <span class="material-symbols-outlined text-[18px] shrink-0">${icons[type] || icons.info}</span>
      <span class="flex-1">${message}</span>
      <button class="w-5 h-5 flex items-center justify-center rounded hover:bg-black/5 transition-colors shrink-0" aria-label="Dismiss">
        <span class="material-symbols-outlined text-[16px]">close</span>
      </button>
    `;

    const dismissBtn = toast.querySelector('button');
    const remove = () => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(12px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    };

    dismissBtn.addEventListener('click', remove);
    container.appendChild(toast);

    if (duration > 0) {
      setTimeout(remove, duration);
    }

    return toast;
  }

  static success(message, duration) {
    return this.show(message, 'success', duration);
  }

  static error(message, duration) {
    return this.show(message, 'error', duration);
  }

  static warning(message, duration) {
    return this.show(message, 'warning', duration);
  }

  static info(message, duration) {
    return this.show(message, 'info', duration);
  }
}

window.Toast = Toast;
