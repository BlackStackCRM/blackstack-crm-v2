class DataTable {
  constructor(containerId, config) {
    this.container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    this.config = {
      columns: config.columns || [],
      data: config.data || [],
      selectable: config.selectable || false,
      sortable: config.sortable !== false,
      onRowClick: config.onRowClick || null,
      onSort: config.onSort || null,
      emptyState: config.emptyState || 'No data available',
      loading: config.loading || false,
      rowActions: config.rowActions || null,
    };
    this.sortColumn = null;
    this.sortDirection = 'asc';
    this.selectedRows = new Set();
    this.render();
  }

  render() {
    if (!this.container) return;
    this.container.innerHTML = '';

    if (this.config.loading) {
      this.container.innerHTML = `
        <div class="flex items-center justify-center py-12">
          <div class="flex flex-col items-center gap-3">
            <span class="material-symbols-outlined text-[32px] text-on-surface-variant animate-spin">progress_activity</span>
            <p class="font-body-sm text-body-sm text-on-surface-variant">Loading...</p>
          </div>
        </div>
      `;
      return;
    }

    if (!this.config.data.length) {
      this.container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 text-center">
          <span class="material-symbols-outlined text-[48px] text-on-surface-variant/40 mb-2">search_off</span>
          <p class="font-body-sm text-body-sm text-on-surface-variant">${this.config.emptyState}</p>
        </div>
      `;
      return;
    }

    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'overflow-x-auto';

    const table = document.createElement('table');
    table.className = 'w-full text-left border-collapse whitespace-nowrap';

    table.innerHTML = `
      <thead>
        <tr class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase tracking-wider">
          ${this.config.selectable ? '<th class="py-3 pl-stack-md pr-2 w-12"><input type="checkbox" class="rounded border-outline-variant text-primary focus:ring-primary w-4 h-4 cursor-pointer" aria-label="Select all"/></th>' : ''}
          ${this.config.columns.map(col => `
            <th class="py-3 px-4 font-semibold ${col.align === 'right' ? 'text-right' : ''} ${col.sortable !== false && this.config.sortable ? 'group cursor-pointer hover:bg-surface-container transition-colors' : ''}" ${col.sortable !== false && this.config.sortable ? `data-sort="${col.key}"` : ''}>
              ${col.sortable !== false && this.config.sortable ? `
                <div class="flex items-center gap-1 ${col.align === 'right' ? 'justify-end' : ''}">
                  ${col.label}
                  <span class="material-symbols-outlined text-[14px] opacity-0 group-hover:opacity-100 transition-opacity">arrow_downward</span>
                </div>
              ` : col.label}
            </th>
          `).join('')}
          ${this.config.rowActions ? '<th class="py-3 pr-stack-md pl-2 w-12"></th>' : ''}
        </tr>
      </thead>
      <tbody class="divide-y divide-outline-variant/30 font-body-md text-body-md text-on-surface" id="data-table-body">
        ${this.renderRows()}
      </tbody>
    `;

    tableWrapper.appendChild(table);
    this.container.appendChild(tableWrapper);

    this.attachEvents();
  }

  renderRows() {
    let data = [...this.config.data];
    if (this.sortColumn) {
      data.sort((a, b) => {
        const aVal = a[this.sortColumn] || '';
        const bVal = b[this.sortColumn] || '';
        const cmp = aVal.localeCompare ? aVal.localeCompare(bVal) : (aVal > bVal ? 1 : aVal < bVal ? -1 : 0);
        return this.sortDirection === 'asc' ? cmp : -cmp;
      });
    }

    return data.map((row, index) => `
      <tr class="hover:bg-surface-container-low transition-colors group ${this.selectedRows.has(index) ? 'bg-secondary-fixed/30 hover:bg-secondary-fixed/40' : ''}" data-index="${index}">
        ${this.config.selectable ? `
          <td class="py-2.5 pl-stack-md pr-2">
            <input type="checkbox" class="row-checkbox rounded border-outline-variant text-primary focus:ring-primary w-4 h-4 cursor-pointer" ${this.selectedRows.has(index) ? 'checked' : ''} aria-label="Select row ${index + 1}"/>
          </td>
        ` : ''}
        ${this.config.columns.map(col => `
          <td class="py-2.5 px-4 ${col.align === 'right' ? 'text-right' : ''} ${col.className || ''}">
            ${col.render ? col.render(row[col.key], row) : row[col.key] ?? ''}
          </td>
        `).join('')}
        ${this.config.rowActions ? `
          <td class="py-2.5 pr-stack-md pl-2 text-right">
            <button class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant opacity-0 group-hover:opacity-100 transition-all row-action-btn" aria-label="More options">
              <span class="material-symbols-outlined text-[18px]">more_vert</span>
            </button>
          </td>
        ` : ''}
      </tr>
    `).join('');
  }

  attachEvents() {
    const thead = this.container.querySelector('thead');
    if (thead) {
      thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (th) {
          const key = th.dataset.sort;
          if (this.sortColumn === key) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
          } else {
            this.sortColumn = key;
            this.sortDirection = 'asc';
          }
          if (this.config.onSort) {
            this.config.onSort(key, this.sortDirection);
          }
          this.render();
        }
        const checkbox = e.target.closest('thead input[type="checkbox"]');
        if (checkbox) {
          this.toggleSelectAll(checkbox.checked);
        }
      });
    }

    const tbody = this.container.querySelector('tbody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const checkbox = e.target.closest('.row-checkbox');
        if (checkbox) {
          const row = checkbox.closest('tr');
          const index = parseInt(row.dataset.index);
          if (checkbox.checked) {
            this.selectedRows.add(index);
          } else {
            this.selectedRows.delete(index);
          }
          this.render();
        }
        const actionBtn = e.target.closest('.row-action-btn');
        if (actionBtn) {
          const row = actionBtn.closest('tr');
          const index = parseInt(row.dataset.index);
          if (this.config.rowActions) {
            this.config.rowActions(this.config.data[index], index);
          }
        }
        const tr = e.target.closest('tr');
        if (tr && this.config.onRowClick && !e.target.closest('button, input, a')) {
          this.config.onRowClick(this.config.data[parseInt(tr.dataset.index)], parseInt(tr.dataset.index));
        }
      });
    }
  }

  toggleSelectAll(checked) {
    if (checked) {
      this.config.data.forEach((_, i) => this.selectedRows.add(i));
    } else {
      this.selectedRows.clear();
    }
    this.render();
  }

  update(data) {
    this.config.data = data;
    this.render();
  }

  setLoading(loading) {
    this.config.loading = loading;
    this.render();
  }
}

window.DataTable = DataTable;
