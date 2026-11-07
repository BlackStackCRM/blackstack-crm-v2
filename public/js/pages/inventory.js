/**
 * Inventory Management Page Module (Premium Redesign)
 *
 * Renders the Inventory Management dashboard under the Products section.
 * Apple-inspired premium UI: clean, minimal, spacious, professional.
 *
 * Uses a grouped navigation list instead of colorful cards.
 * Each option links to a master grid or transaction workflow via the API.
 */
(function () {
  'use strict';

  // ─── Section definitions with logical grouping ─────────────────────────────
  // Note: Some cards (batch_management, expiry_management, etc.) appear in multiple contexts
  // but are rendered only once here to avoid duplicates.
  const SECTIONS = [
    {
      key: 'inventory_masters',
      title: 'Inventory Masters',
      description: 'Configure products, units, locations and stock classification',
      icon: 'inventory_2',
      cards: [
        'stock_groups', 'stock_categories', 'brands', 'models',
        // Stock items are the physical inventory entity and are managed at
        // #inventory/stock_items (public/js/pages/products.js links to that
        // route twice, and inventory-sub.js defines a full StockItemPage for it),
        // but the dashboard had no card for it — so the one page the product
        // form itself navigates to was unreachable from the dashboard.
        'stock_items'
      ]
    },
    {
      key: 'storage_locations',
      title: 'Storage & Locations',
      description: 'Manage warehouses, locations and storage configuration',
      icon: 'warehouse',
      cards: ['godowns', 'locations']
    },
    {
      key: 'batch_tracking',
      title: 'Batch & Tracking',
      description: 'Manage batches, serials and expiry tracking',
      icon: 'layers',
      cards: ['batches', 'batch_wise_stock', 'batch_management', 'expiry_management',
              'manufacturing_date', 'expiry_date', 'serial_number_tracking',
              'godown_wise_stock', 'location_wise_stock', 'batch_wise_stock_mgmt']
    },
    {
      key: 'stock_transactions',
      title: 'Stock Transactions',
      description: 'Record and manage inventory movements and adjustments',
      icon: 'assignment',
      cards: ['opening_stock', 'stock_inward', 'stock_outward', 'stock_transfer',
                'stock_adjustment', 'physical_stock', 'stock_journal']
    },
    {
      key: 'reports',
      title: 'Reports',
      description: 'View inventory reports and valuations',
      icon: 'analytics',
      cards: ['stock_valuation']
    }
  ];

  // ─── Card configuration (UI labels, icons only - no color per card) ───────────
  const CARD_CONFIG = {
    // Inventory Masters
    stock_groups: { label: 'Stock Groups', icon: 'folder', description: 'Organize products into hierarchical groups' },
    stock_categories: { label: 'Stock Categories', icon: 'category', description: 'Define product categories and classifications' },
    brands: { label: 'Brand', icon: 'verified', description: 'Manage product brands' },
    models: { label: 'Model', icon: 'memory', description: 'Define product models' },
    stock_items: { label: 'Stock Items', icon: 'inventory_2', description: 'Physical inventory items with units, pricing and tracking' },
    // Storage & Locations
    godowns: { label: 'Godowns', icon: 'warehouse', description: 'Manage warehouses and storage locations' },
    locations: { label: 'Locations', icon: 'place', description: 'Define specific locations within godowns' },

    // Batch & Tracking
    batches: { label: 'Batches', icon: 'layers', description: 'Create and manage product batches' },
    batch_wise_stock: { label: 'Batch-wise Stock', icon: 'view_module', description: 'View stock by batch' },
    batch_management: { label: 'Batch Management', icon: 'inventory', description: 'Manage batch operations', isReport: true },
    expiry_management: { label: 'Expiry Management', icon: 'event_busy', description: 'Track expiry dates and alerts', isReport: true },
    manufacturing_date: { label: 'Manufacturing Date', icon: 'calendar_today', description: 'View manufacturing date reports', isReport: true },
    expiry_date: { label: 'Expiry Date', icon: 'calendar_month', description: 'View expiry date reports', isReport: true },
    serial_number_tracking: { label: 'Serial Number Tracking', icon: 'qr_code_2', description: 'Track items by serial number', isReport: true },
    godown_wise_stock: { label: 'Godown-wise Stock', icon: 'warehouse', description: 'View stocks by warehouse', isReport: true },
    location_wise_stock: { label: 'Location-wise Stock', icon: 'place', description: 'View stocks by location', isReport: true },
    batch_wise_stock_mgmt: { label: 'Batch-wise Stock', icon: 'view_module', description: 'Manage batch stock levels', isReport: true },

    // Stock Transactions
    opening_stock: { label: 'Opening Stock', icon: 'inventory', group: 'stock_mgmt', description: 'Record initial stock balances' },
    stock_inward: { label: 'Stock Inward', icon: 'login', group: 'stock_mgmt', description: 'Record stock received' },
    stock_outward: { label: 'Stock Outward', icon: 'logout', group: 'stock_mgmt', description: 'Record stock dispatched' },
    stock_transfer: { label: 'Stock Transfer', icon: 'swap_horiz', group: 'stock_mgmt', description: 'Transfer stock between locations' },
    stock_adjustment: { label: 'Stock Adjustment', icon: 'tune', group: 'stock_mgmt', description: 'Adjust stock quantities' },
    physical_stock: { label: 'Physical Stock', icon: 'fact_check', group: 'stock_mgmt', description: 'Record physical stock counts' },
    stock_journal: { label: 'Stock Journal', icon: 'book', group: 'stock_mgmt', description: 'View stock transaction records' },

    // Stock Valuation Report
    stock_valuation: { label: 'Stock Valuation', icon: 'paid', isReport: true, description: 'View stock valuation reports' },
  };

  // Map: frontend card key -> API endpoint path
  const API_MAP = {
    stock_groups: '/api/inventory/masters/stock_groups',
    stock_categories: '/api/inventory/masters/stock_categories',
    godowns: '/api/inventory/masters/godowns',
    locations: '/api/inventory/masters/locations',
    batches: '/api/inventory/masters/batches',
    batch_wise_stock: '/api/inventory/reports/batch-stock',
    brands: '/api/inventory/masters/brands',
    models: '/api/inventory/masters/models',
    // Stock items are NOT served by the generic masters endpoint — the page reads
    // them from /api/inventory/stocks, which joins stock_balances (see
    // StockItemPage in inventory-sub.js and API_MAP there).
    stock_items: '/api/inventory/stocks',
    opening_stock: '/api/inventory/vouchers',
    stock_inward: '/api/inventory/vouchers',
    stock_outward: '/api/inventory/vouchers',
    stock_transfer: '/api/inventory/vouchers',
    stock_adjustment: '/api/inventory/vouchers',
    physical_stock: '/api/inventory/physical-stock',
    stock_journal: '/api/inventory/vouchers',
    stock_valuation: '/api/inventory/reports/valuation',
    batch_management: '/api/inventory/reports/batch-stock',
    expiry_management: '/api/inventory/reports/expiry',
    manufacturing_date: '/api/inventory/reports/serials',
    expiry_date: '/api/inventory/reports/expiry',
    serial_number_tracking: '/api/inventory/reports/serials',
    godown_wise_stock: '/api/inventory/reports/godown-stock',
    location_wise_stock: '/api/inventory/reports/location-stock',
    batch_wise_stock_mgmt: '/api/inventory/reports/batch-stock',
  };

  // ─── Render the inventory dashboard with sections ──────────────────────────
  function render(container) {
    container.innerHTML = `
      <div class="space-y-8">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3">
          <div>
            <h1 class="text-2xl font-bold text-on-surface tracking-tight">Inventory Management</h1>
            <p class="text-sm text-on-surface-variant mt-1">Manage stock masters, transactions, warehouses, tracking and inventory reports</p>
          </div>
          <button id="inv-refresh-btn"
                  class="px-4 py-2 text-sm font-medium text-secondary bg-secondary-container rounded-lg hover:bg-secondary/20 transition-colors flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px]">refresh</span>
            Refresh
          </button>
        </div>

        <!-- Search Bar -->
        <div class="px-4">
          <div class="relative max-w-lg">
            <span class="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-[18px]">search</span>
            <input type="text" placeholder="Search inventory options..."
                   class="w-full bg-surface-container-low border border-outline-variant/40 rounded-xl py-2.5 pl-12 pr-4 text-body-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-secondary/40 focus:border-secondary/50 transition-all duration-200"
                   id="inv-search-input"/>
            <div class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant/50 hidden sm:block">
              ⌘ /
            </div>
          </div>
        </div>

        <!-- Sections -->
        ${SECTIONS.map(section => `
          <section class="px-4">
            <div class="flex items-center gap-2 mb-4 px-1">
              <span class="material-symbols-outlined text-[18px] text-secondary/70">${section.icon}</span>
              <h2 class="text-base font-semibold text-on-surface">${section.title}</h2>
            </div>
            <p class="text-sm text-on-surface-variant mb-5">${section.description}</p>
            <div class="space-y-1">
              ${section.cards.map(cardKey => renderCard(cardKey, CARD_CONFIG[cardKey])).join('')}
            </div>
          </section>
        `).join('')}
      </div>
    `;

    // Attach search handler
    const searchInput = container.querySelector('#inv-search-input');
    if (searchInput) {
      let searchTimer = null;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        const term = e.target.value.toLowerCase();
        searchTimer = setTimeout(() => {
          // Filter sections by search term
          const cards = container.querySelectorAll('[data-inv-card]');
          cards.forEach(card => {
            const label = card.querySelector('.card-title')?.textContent?.toLowerCase() || '';
            card.style.display = label.includes(term) ? '' : 'none';
          });
          // Show/hide sections based on whether they have visible cards
          container.querySelectorAll('section').forEach(section => {
            const visibleCards = section.querySelectorAll('[data-inv-card]:not([style*="display: none"])');
            section.style.display = visibleCards.length > 0 ? '' : 'none';
          });
        }, 150);
      });
    }

    // Attach click handlers (delegated)
    container.addEventListener('click', (e) => {
      const card = e.target.closest('[data-inv-card]');
      if (card) {
        e.preventDefault();
        const key = card.dataset.invCard;
        handleCardClick(key);
      }
    });

    // Refresh button handler
    const refreshBtn = container.querySelector('#inv-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        container.innerHTML = '';
        render(container);
        if (window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('inventory:refresh'));
        }
      });
    }
  }

  // ─── Render a single navigation item (maintains data-inv-card for backward compatibility) ───
  function renderCard(key, cfg) {
    const isReport = cfg.isReport || false;

    return `
      <div data-inv-card="${key}"
           class="nav-item group relative flex items-center gap-4 px-3 py-2.5 rounded-xl
                  hover:bg-surface-container transition-colors duration-200 cursor-pointer
                  border-l-4 border-transparent hover:border-secondary/30">
        <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-secondary-container flex items-center justify-center">
          <span class="material-symbols-outlined text-[18px] text-secondary">${cfg.icon}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="card-title text-sm font-medium text-on-surface leading-snug">
            ${cfg.label}
            ${isReport ? '<span class="material-symbols-outlined text-[14px] text-secondary/60 ml-1">analytics</span>' : ''}
          </div>
          ${cfg.description ? `<p class="text-xs text-on-surface-variant/60 mt-0.5">${cfg.description}</p>` : ''}
        </div>
        ${isReport ? `<span class="text-xs font-medium text-secondary/80 bg-secondary-container/40 px-2 py-0.5 rounded-full">Report</span>` : ''}
      </div>
    `;
  }

  // Alias for backward compatibility
  const renderNavItem = renderCard;

  // ─── Handle card click: route to master, transaction, or report ─────────────
  function handleCardClick(key) {
    const config = CARD_CONFIG[key];
    if (!config) return;

    const apiPath = API_MAP[key];
    const isReport = config.isReport || false;

    // Dispatch a custom event so the app can navigate to a detail view if needed
    if (isReport) {
      window.location.hash = `inventory/${key}`;
      window.dispatchEvent(new CustomEvent('page:navigate', {
        detail: { path: `inventory/${key}`, mode: 'report', key, apiPath, label: config.label }
      }));
    } else if (config.group === 'stock_mgmt') {
      window.location.hash = `inventory/${key}`;
      window.dispatchEvent(new CustomEvent('page:navigate', {
        detail: { path: `inventory/${key}`, mode: 'master', key, apiPath, label: config.label }
      }));
    } else {
      window.location.hash = `inventory/${key}`;
      window.dispatchEvent(new CustomEvent('page:navigate', {
        detail: { path: `inventory/${key}`, mode: 'master', key, apiPath, label: config.label }
      }));
    }
  }

  // Alias for backward compatibility
  const handleNavItemClick = handleCardClick;

  // ─── Fetch inventory data from API ───────────────────────────────────────────
  async function fetchData(apiPath) {
    try {
      const response = await fetch(apiPath, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (err) {
      console.error(`[inventory] Failed to fetch ${apiPath}:`, err.message);
      return null;
    }
  }

  // ─── Module init — called by app.js router ───────────────────────────────────
  function init() {
    const container = document.createElement('div');
    container.id = 'inventory-page';
    container.className = 'p-0';

    render(container);

    // Mount into the page container
    const pageContainer = document.getElementById('page-container');
    if (pageContainer) {
      pageContainer.innerHTML = '';
      pageContainer.appendChild(container);
    }

    return function cleanup() {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    };
  }

  // ─── Register on window.PageModules ────────────────────────────────────────
  if (!window.PageModules) {
    window.PageModules = {};
  }
  window.PageModules.inventory = { init, renderCard, CARD_CONFIG, API_MAP, fetchData, SECTIONS };
})();