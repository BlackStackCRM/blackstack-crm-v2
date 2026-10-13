class Pagination {
  constructor(containerId, options = {}) {
    this.container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    this.currentPage = options.page || 1;
    this.totalPages = options.totalPages || 1;
    this.totalItems = options.totalItems || 0;
    this.pageSize = options.pageSize || 10;
    this.onPageChange = options.onPageChange || null;
    this.render();
  }

  render() {
    if (!this.container) return;
    const startItem = (this.currentPage - 1) * this.pageSize + 1;
    const endItem = Math.min(this.currentPage * this.pageSize, this.totalItems);

    let pages = [];
    if (this.totalPages <= 7) {
      for (let i = 1; i <= this.totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (this.currentPage > 3) pages.push('...');
      for (let i = Math.max(2, this.currentPage - 1); i <= Math.min(this.totalPages - 1, this.currentPage + 1); i++) {
        pages.push(i);
      }
      if (this.currentPage < this.totalPages - 2) pages.push('...');
      pages.push(this.totalPages);
    }

    this.container.innerHTML = `
      <div class="flex items-center justify-between border-t border-outline-variant/30 px-stack-md py-3">
        <div class="font-body-sm text-body-sm text-on-surface-variant">
          Showing <span class="font-medium text-on-surface">${this.totalItems > 0 ? startItem : 0}</span> to <span class="font-medium text-on-surface">${endItem}</span> of <span class="font-medium text-on-surface">${this.totalItems}</span> results
        </div>
        <div class="flex items-center gap-1">
          <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-container disabled:opacity-40 disabled:cursor-not-allowed transition-colors" ${this.currentPage <= 1 ? 'disabled' : ''} data-page="prev" aria-label="Previous page">
            <span class="material-symbols-outlined text-[18px]">chevron_left</span>
          </button>
          ${pages.map(p => {
            if (p === '...') {
              return `<span class="px-2 text-on-surface-variant">...</span>`;
            }
            return `
              <button class="w-8 h-8 flex items-center justify-center rounded transition-colors ${this.currentPage === p ? 'bg-surface-container-high text-on-surface font-medium' : 'hover:bg-surface-container text-on-surface-variant'}" data-page="${p}" aria-label="Page ${p}" ${this.currentPage === p ? 'aria-current="page"' : ''}>
                ${p}
              </button>
            `;
          }).join('')}
          <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-container disabled:opacity-40 disabled:cursor-not-allowed transition-colors" ${this.currentPage >= this.totalPages ? 'disabled' : ''} data-page="next" aria-label="Next page">
            <span class="material-symbols-outlined text-[18px]">chevron_right</span>
          </button>
        </div>
      </div>
    `;

    this.container.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        let newPage = this.currentPage;
        if (page === 'prev') newPage = this.currentPage - 1;
        else if (page === 'next') newPage = this.currentPage + 1;
        else newPage = parseInt(page, 10);

        if (newPage >= 1 && newPage <= this.totalPages && newPage !== this.currentPage) {
          this.currentPage = newPage;
          if (this.onPageChange) this.onPageChange(newPage);
          this.render();
        }
      });
    });
  }

  update(options = {}) {
    if (options.page !== undefined) this.currentPage = options.page;
    if (options.totalPages !== undefined) this.totalPages = options.totalPages;
    if (options.totalItems !== undefined) this.totalItems = options.totalItems;
    if (options.pageSize !== undefined) this.pageSize = options.pageSize;
    this.render();
  }
}

window.Pagination = Pagination;
