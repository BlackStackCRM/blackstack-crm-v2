class Modal {
  constructor(options = {}) {
    this.id = options.id || `modal-${Date.now()}`;
    this.title = options.title || '';
    this.content = options.content || '';
    this.size = options.size || 'md';
    this.onClose = options.onClose || null;
    this.element = null;
    this.previousActiveElement = null;
  }

  escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  open() {
    this.previousActiveElement = document.activeElement;
    const root = document.getElementById('modal-root');
    if (!root) return;

    this.element = document.createElement('div');
    this.element.id = this.id;
    this.element.className = 'fixed inset-0 z-[90] flex items-center justify-center p-4';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', `${this.id}-title`);

    const sizeClasses = {
      sm: 'max-w-sm',
      md: 'max-w-lg',
      lg: 'max-w-2xl',
      xl: 'max-w-4xl',
      full: 'max-w-6xl',
    };

    this.element.innerHTML = `
      <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true"></div>
      <div class="relative bg-surface-container-lowest rounded-xl shadow-2xl w-full ${sizeClasses[this.size] || sizeClasses.md} max-h-[90vh] flex flex-col animate-scale-in">
        <div class="flex items-center justify-between p-container-padding border-b border-outline-variant/30 shrink-0">
          <h2 id="${this.id}-title" class="font-h3 text-h3 text-on-surface">${this.escapeHTML(this.title)}</h2>
          <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors" aria-label="Close modal" data-modal-close>
            <span class="material-symbols-outlined text-[20px] text-on-surface-variant">close</span>
          </button>
        </div>
        <div class="p-container-padding overflow-y-auto flex-1">
          ${this.content}
        </div>
      </div>
    `;

    root.appendChild(this.element);
    root.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    this.trapFocus();
    this.attachEvents();
  }

  attachEvents() {
    const closeBtn = this.element.querySelector('[data-modal-close]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    const backdrop = this.element.querySelector('.absolute.inset-0');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.close());
    }

    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      }
      if (e.key === 'Tab') {
        this.handleTab(e);
      }
    });
  }

  handleTab(e) {
    const focusableElements = this.element.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusableElements.length) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  }

  trapFocus() {
    const focusableElements = this.element.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusableElements.length) {
      focusableElements[0].focus();
    }
  }

  close() {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
    const root = document.getElementById('modal-root');
    const modals = root ? root.querySelectorAll('[role="dialog"]') : [];
    if (modals.length === 0 && root) {
      root.classList.add('hidden');
    }
    document.body.style.overflow = '';
    if (this.previousActiveElement) {
      this.previousActiveElement.focus();
    }
    if (this.onClose) {
      this.onClose();
    }
  }

  setContent(content) {
    this.content = content;
    if (this.element) {
      const contentEl = this.element.querySelector('.overflow-y-auto');
      if (contentEl) {
        contentEl.innerHTML = content;
      }
    }
  }
}

window.Modal = Modal;
