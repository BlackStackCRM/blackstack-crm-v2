window.PageModules = window.PageModules || {};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

window.PageModules.chartOfAccounts = {
  state: {
    page: 1,
    pageSize: 50,
    search: "",
    typeFilter: "ALL",
    statusFilter: "ALL",
    levelFilter: "ALL",
  },
  searchTimer: null,
  treeData: null,
  expandedNodes: {},

  async init() {
    const main = document.getElementById("page-container");
    if (!main) return () => {};

    await AccountingState.init();
    main.innerHTML = this.renderPage();

    this.bindEvents();
    await this.load();
    return () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    };
  },

  renderPage() {
    return `
      <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Chart of Accounts</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Manage your company's accounts and General Ledger structure.</p>
          </div>
          <div class="flex items-center gap-2">
            <button id="coa-print" class="flex items-center gap-1 bg-surface-container hover:bg-surface-container-high px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <span class="material-symbols-outlined text-[18px]">print</span> Print
            </button>
            <button id="coa-export" class="flex items-center gap-1 bg-surface-container hover:bg-surface-container-high px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <span class="material-symbols-outlined text-[18px]">file_download</span> Export
            </button>
            <button id="coa-import" class="flex items-center gap-1 bg-surface-container hover:bg-surface-container-high px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <span class="material-symbols-outlined text-[18px]">file_upload</span> Import
            </button>
            <button id="coa-add-btn" class="flex items-center gap-1 bg-secondary text-on-secondary px-4 py-2 rounded-lg hover:bg-secondary/90 text-sm font-medium transition-colors">
              <span class="material-symbols-outlined text-[18px]">add</span> Add Account
            </button>
          </div>
        </div>

        <!-- Summary Cards -->
        <div id="coa-summary" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-4">
        </div>

        <!-- Search & Filter Bar -->
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="relative flex-1 min-w-[240px]">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
              <input id="coa-search" placeholder="Search by code, name, or description..." class="w-full bg-surface-container-low py-2 pl-10 pr-4 rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <select id="coa-type-filter" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="ALL">All Types</option>
              <option value="GROUP">Groups</option>
              <option value="LEDGER">Ledger Accounts</option>
              <option value="ASSET">Asset</option>
              <option value="LIABILITY">Liability</option>
              <option value="EQUITY">Equity</option>
              <option value="INCOME">Income</option>
              <option value="EXPENSE">Expense</option>
              <option value="BANK">Bank</option>
              <option value="CASH">Cash</option>
            </select>
            <select id="coa-status-filter" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="ALL">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
            <select id="coa-level-filter" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="ALL">All Levels</option>
              <option value="PARENT">Parent Accounts</option>
              <option value="CHILD">Sub Accounts</option>
            </select>
          </div>
        </div>

        <!-- Tree Table -->
        <style>
          /* ONE grid definition shared by header and every row */
          .coa-grid-template {
            display: grid;
            align-items: center;
            width: 100%;
            grid-template-columns: 120px minmax(300px, 1fr) 100px 120px 150px 100px 60px;
          }
          /* Compact, ERP-style rows */
          #coa-table .coa-row { height: 48px; min-height: 0; }
          #coa-table .coa-row.coa-row-group { height: 52px; }
          #coa-table .coa-row > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          #coa-table .coa-row.coa-row-group > div { font-weight: 500; }
          /* Table scrolls horizontally on narrow screens instead of collapsing */
          #coa-table-scroll { overflow-x: auto; }
          #coa-table-inner { min-width: 860px; }
          @media (max-width: 900px) {
            .coa-grid-template {
              grid-template-columns: 90px minmax(180px, 1fr) 90px 100px 120px 90px 50px;
            }
          }
        </style>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 overflow-hidden" id="coa-table">
          <div id="coa-table-scroll">
            <div id="coa-table-inner">
          <div class="coa-grid-template bg-surface-container border-b border-outline-variant/30 px-4 h-11 text-xs font-label-md text-on-surface-variant uppercase">
            <div>Code</div>
            <div>Account Name</div>
            <div class="text-center">Type</div>
            <div class="text-center">Category</div>
            <div class="text-right">Balance</div>
            <div class="text-center">Status</div>
            <div class="text-center">Actions</div>
          </div>
          <div id="coa-tree" class="p-0"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  openAddAccountModal() {
    const self = this;
    const modal = new Modal({
      title: "Create Account",
      content: `
        <p class="font-body-sm text-body-sm text-on-surface-variant mb-4">Choose what to create:</p>
        <div class="space-y-3">
          <button data-act="create-group" class="flex items-center gap-3 w-full px-4 py-4 text-left bg-surface-container-low hover:bg-surface-container-high border border-outline-variant/30 rounded-xl transition-colors">
            <span class="material-symbols-outlined text-[24px] text-on-surface-variant">folder</span>
            <span>
              <span class="block font-body text-body text-on-surface">Create Account Group</span>
              <span class="block font-body-sm text-body-sm text-on-surface-variant">Group or parent account for organizing ledger accounts</span>
            </span>
          </button>
          <button data-act="create-ledger" class="flex items-center gap-3 w-full px-4 py-4 text-left bg-surface-container-low hover:bg-surface-container-high border border-outline-variant/30 rounded-xl transition-colors">
            <span class="material-symbols-outlined text-[24px] text-on-surface-variant">account_balance</span>
            <span>
              <span class="block font-body text-body text-on-surface">Create Ledger Account</span>
              <span class="block font-body-sm text-body-sm text-on-surface-variant">Actual ledger account for recording transactions</span>
            </span>
          </button>
        </div>
      `,
    });
    modal.open();
    modal.element.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      modal.close();
      if (act === "create-group") return self.openGroupForm();
      if (act === "create-ledger") return self.openForm();
    });
  },

  bindEvents() {
    const self = this;
    document.getElementById("coa-add-btn").addEventListener("click", () => {
      self.openAddAccountModal();
    });

    document
      .getElementById("coa-print")
      .addEventListener("click", () => self.printView());
    document
      .getElementById("coa-export")
      .addEventListener("click", () => self.exportAccounts());
    document
      .getElementById("coa-import")
      .addEventListener("click", () => self.openImportModal());
    document.getElementById("coa-search").addEventListener("input", (e) => {
      clearTimeout(self.searchTimer);
      self.searchTimer = setTimeout(() => {
        self.state.search = e.target.value;
        self.state.page = 1;
        self.load();
      }, 300);
    });
    document
      .getElementById("coa-type-filter")
      .addEventListener("change", (e) => {
        self.state.typeFilter = e.target.value;
        self.load();
      });
    document
      .getElementById("coa-status-filter")
      .addEventListener("change", (e) => {
        self.state.statusFilter = e.target.value;
        self.load();
      });
    document
      .getElementById("coa-level-filter")
      .addEventListener("change", (e) => {
        self.state.levelFilter = e.target.value;
        self.load();
      });
  },

  async load() {
    const container = document.getElementById("coa-tree");
    container.innerHTML =
      '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>';
    try {
      const treeRes = await API.get("/accounting/accounts/tree");
      const treeData = treeRes?.data || treeRes || {};
      this.treeData = treeData.tree || [];
      this.renderSummary(treeData.summary || {});
      this.renderTree(this.treeData);
    } catch (err) {
      container.innerHTML =
        '<div class="p-6 text-center text-error">Failed to load chart of accounts</div>';
    }
  },

  renderSummary(summary) {
    const container = document.getElementById("coa-summary");
    const cards = [
      {
        label: "Total Accounts",
        value: summary.total || 0,
        icon: "account_tree",
        color: "text-primary",
      },
      {
        label: "Asset Accounts",
        value: summary.ASSET || 0,
        icon: "account_balance",
        color: "text-blue-700",
      },
      {
        label: "Liability Accounts",
        value: summary.LIABILITY || 0,
        icon: "trending_down",
        color: "text-red-700",
      },
      {
        label: "Equity Accounts",
        value: summary.EQUITY || 0,
        icon: "diversity_3",
        color: "text-purple-700",
      },
      {
        label: "Income Accounts",
        value: summary.INCOME || 0,
        icon: "trending_up",
        color: "text-green-700",
      },
      {
        label: "Expense Accounts",
        value: summary.EXPENSE || 0,
        icon: "receipt_long",
        color: "text-orange-700",
      },
    ];
    container.innerHTML = cards
      .map(
        (c) => `
      <div class="bg-surface-container-low rounded-xl border border-outline-variant/30 p-4 text-center">
        <div class="flex items-center justify-center gap-2 mb-1">
          <span class="material-symbols-outlined text-[20px] ${c.color}">${c.icon}</span>
          <span class="font-display text-2xl font-semibold text-on-surface">${c.value}</span>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant">${c.label}</p>
      </div>
    `,
      )
      .join("");
  },

  getTypeLabel(type) {
    return type.charAt(0) + type.slice(1).toLowerCase();
  },

  renderTree(accounts) {
    const container = document.getElementById("coa-tree");
    if (!accounts || accounts.length === 0) {
      container.innerHTML =
        '<div class="p-12 text-center"><p class="text-on-surface-variant">No accounts found. Create your first account to get started.</p></div>';
      return;
    }

    // Backend returns a pre-built nested tree with `children` arrays.
    const rootNodes = Array.isArray(accounts) ? accounts : [];

    const renderNode = (node, depth = 0) => {
      const hasChildren = node.children && node.children.length > 0;
      const isExpanded = this.expandedNodes[node.id] !== false;
      const toggleIcon = hasChildren ? (isExpanded ? "▼" : "▶") : "";
      const balance = node.balance || 0;

      // Support both camelCase (backend) and snake_case (legacy) properties
      const isGroup =
        node.kind === "group" ||
        node.isGroup === true ||
        node.isGroup === 1 ||
        node.is_group === 1 ||
        node.is_group === true;
      const isActive =
        node.isActive !== undefined ? node.isActive : node.is_active !== 0;
      const typeLabel = this.getTypeLabel(node.type || "");
      const categoryLabel = typeLabel;

      // Role badge (GROUP or LEDGER) — single, non-duplicated
      const roleBadge = isGroup ? "GROUP" : "LEDGER";

      let rowClass =
        "coa-grid-template coa-row border-b border-outline-variant/10 hover:bg-surface-container/40";
      if (isGroup) rowClass += " coa-row-group bg-surface-container/30";
      if (!isActive) rowClass += " opacity-60";

      // Group rows get stronger visual weight; ledger rows are lighter
      const nameClass = isGroup
        ? "font-medium text-on-surface"
        : "text-on-surface";

      // Indentation is ONLY in the Account Name cell
      const nameIndent = depth * 20;

      const balanceStr = balance !== 0 ? this.fmt(balance) : this.fmt(0);

      // Status badge with fixed dimensions
      const statusBadge = isActive ? "Active" : "Inactive";
      const statusBadgeClass = isActive
        ? "bg-green-100 text-green-700"
        : "bg-red-100 text-red-700";

      // Account name cell: expand icon + group/ledger icon + name + indentation
      // The toggle icon is part of the Account Name cell, indentation only here
      const indentSpan =
        nameIndent > 0
          ? `<span style="display: inline-block; width: ${nameIndent}px"></span>`
          : "";
      const expandIcon = hasChildren
        ? `<span class="coa-expand-icon text-on-surface-variant text-[11px] select-none mr-1 w-[12px] text-center" style="cursor: pointer">${toggleIcon}</span>`
        : '<span style="display: inline-block; width: 12px"></span>';
      const typeIcon = isGroup
        ? '<span class="material-symbols-outlined text-[14px] text-on-surface-variant mr-1" style="width: 16px; height: 16px">folder</span>'
        : '<span class="material-symbols-outlined text-[14px] text-on-surface-variant mr-1" style="width: 16px; height: 16px">account_balance</span>';

      return `
        <div class="${rowClass}" data-account-id="${node.id}">
          <div class="pl-4 font-code text-[13px] text-on-surface-variant">${node.code || ""}</div>
          <div class="${nameClass} text-[13px] flex items-center min-w-0" title="${node.name}">
            ${indentSpan}${expandIcon}${typeIcon}<span class="truncate">${node.name}</span>
          </div>
          <div class="text-center text-[12px] tracking-wide ${isGroup ? "text-on-surface" : "text-on-surface-variant"}">${roleBadge}</div>
          <div class="text-center text-[12px] text-on-surface-variant">${categoryLabel}</div>
          <div class="pr-4 font-code text-[13px] text-on-surface text-right">${balanceStr}</div>
          <div class="text-center">
            <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] justify-center ${statusBadgeClass}">${statusBadge}</span>
          </div>
          <div class="flex items-center justify-center">
            <button class="coa-row-menu p-1 rounded hover:bg-surface-container transition-opacity" data-account='${encodeURIComponent(JSON.stringify(node))}'>
              <span class="material-symbols-outlined text-[16px] text-on-surface-variant">more_vert</span>
            </button>
          </div>
        </div>
        ${
          hasChildren
            ? `<div class="coa-children-${node.id}" style="${isExpanded ? "display: block" : "display: none"}">
          ${node.children.map((child) => renderNode(child, depth + 1)).join("")}
        </div>`
            : ""
        }`;
    };

    container.innerHTML = `<div class="coa-tree-inner">${rootNodes.map((node) => renderNode(node, 0)).join("")}</div>`;

    // Bind expand/collapse and row menu
    container.querySelectorAll("[data-account-id]").forEach((rowEl) => {
      // Find the expand/collapse icon inside the Account Name cell
      const expandIcon = rowEl.querySelector(".coa-expand-icon");
      if (expandIcon) {
        expandIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          const accountId = rowEl.dataset.accountId;
          const childrenContainer = document.querySelector(
            `.coa-children-${accountId}`,
          );
          if (childrenContainer) {
            const isHidden = childrenContainer.style.display === "none";
            childrenContainer.style.display = isHidden ? "block" : "none";
            this.expandedNodes[accountId] = isHidden;
            expandIcon.textContent = isHidden ? "▼" : "▶";
          }
        });
      }

      const menuBtn = rowEl.querySelector(".coa-row-menu");
      if (menuBtn) {
        menuBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const nodeStr = menuBtn.dataset.account;
          const node = JSON.parse(decodeURIComponent(nodeStr));
          this.openRowMenu(node);
        });
      }
    });

    // Expand all top-level groups by default
    rootNodes.forEach((node) => {
      this.expandedNodes[node.id] = true;
    });
  },

  openRowMenu(row) {
    const self = this;
    const isGroup =
      row.kind === "group" ||
      row.isGroup === true ||
      row.isGroup === 1 ||
      row.is_group === 1 ||
      row.is_group === true;
    let actions = "";
    if (isGroup) {
      actions =
        '<button data-act="view-group" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">visibility</span> View</button>' +
        '<button data-act="add-child-group" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">folder_open</span> Add Child Group</button>' +
        '<button data-act="add-ledger" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">account_balance</span> Add Ledger Account</button>' +
        '<button data-act="move" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">open_in_full</span> Move</button>';
    } else {
      actions =
        '<button data-act="view-ledger" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">account_balance</span> View Ledger</button>';
    }
    actions +=
      '<button data-act="edit" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">edit</span> Edit</button>' +
      '<button data-act="toggle" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-container text-left"><span class="material-symbols-outlined text-[18px]">' +
      (row.is_active !== 0 ? "visibility_off" : "visibility") +
      "</span>" +
      (row.is_active !== 0 ? "Deactivate" : "Activate") +
      "</button>" +
      '<button data-act="delete" class="flex items-center gap-2 px-3 py-2 rounded hover:bg-error-container/20 text-error text-left"><span class="material-symbols-outlined text-[18px]">delete</span> Delete</button>';

    const modal = new Modal({
      title: `${row.code} - ${row.name}`,
      size: "sm",
      content: '<div class="flex flex-col gap-1">' + actions + "</div>",
    });
    modal.open();
    modal.element.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      modal.close();
      if (act === "edit")
        return isGroup ? self.openGroupForm(row) : self.openForm(row);
      if (act === "view-group") return self.viewGroup(row);
      if (act === "toggle") return self.toggleActive(row);
      if (act === "view-ledger")
        return window.dispatchEvent(
          new CustomEvent("page:navigate", {
            detail: {
              path: "accounting/ledger-detail?id=" + encodeURIComponent(row.id),
            },
          }),
        );
      if (act === "delete") return self.confirmDelete(row);
      if (act === "move") return self.openMoveForm(row);
      if (act === "add-child-group")
        return self.openGroupForm({ parent_id: row.id });
      if (act === "add-ledger")
        return self.openForm({ account_group_id: row.id, parent_id: null });
    });
  },

  async openForm(row = null) {
    const self = this;
    const isEdit = !!row;
    const i = row || {};
    let createAnother = false;
    const modal = new Modal({
      title: isEdit ? "Edit Ledger Account" : "Create Ledger Account",
      subtitle: isEdit
        ? "Update account details."
        : "Create a new General Ledger posting account.",
      size: "xl",
      content: this.renderLedgerForm(i, isEdit),
    });
    modal.open();

    // Auto-generated code preview (display-only; the backend generates the
    // final code at create time).
    if (!isEdit) {
      API.get("/accounting/codes/preview?entity=LEDGER_ACCOUNT")
        .then((r) => {
          const codeInput = modal.element.querySelector('#coa-form input[name="code"]');
          if (codeInput && r?.code) codeInput.value = r.code;
        })
        .catch(() => {});
    }

    const typeSelect = modal.element.querySelector('select[name="type"]');
    const groupSelect = modal.element.querySelector("#coa-group-select");
    const natureSelect = modal.element.querySelector(
      'select[name="debit_credit_nature"]',
    );
    const noGroupsMsg = modal.element.querySelector("#coa-no-groups-msg");
    const createGroupLink = modal.element.querySelector(
      "#coa-create-group-link",
    );
    const quickCreateBtn = modal.element.querySelector(
      "#coa-quick-create-group",
    );
    const form = modal.element.querySelector("#coa-form");

    // Derive nature from account type
    const deriveNature = (type) => {
      const creditTypes = ["LIABILITY", "EQUITY", "INCOME"];
      let nature;
      const typeInfo = loadedTypes.find((t) => t.value === type);
      if (typeInfo && typeInfo.nature) {
        nature = typeInfo.nature;
      } else {
        nature = creditTypes.includes(type) ? "CREDIT" : "DEBIT";
      }
      if (natureSelect) natureSelect.value = nature;
      return nature;
    };

    // Check if no groups are available for the current type
    const checkEmptyState = (groups) => {
      if (noGroupsMsg) {
        noGroupsMsg.classList.toggle("hidden", groups.length > 0);
      }
      if (groupSelect) {
        groupSelect.disabled = groups.length === 0;
      }
    };

    // Load groups filtered by selected Account Type
    const loadGroupsForType = async (selectedType) => {
      if (!groupSelect) return;
      const res = await API.get("/accounting/accounts/groups");
      const allGroups =
        res?.groups ||
        res?.data?.groups ||
        res?.items ||
        res?.data?.items ||
        [];
      let filtered = allGroups;
      if (selectedType) {
        // Look up the nature of the selected type (DEBIT or CREDIT)
        const typeInfo = loadedTypes.find((t) => t.value === selectedType);
        const typeNature = typeInfo?.nature;
        if (typeNature) {
          // Filter by nature: DEBIT types match DEBIT groups, CREDIT types match CREDIT groups
          filtered = filtered.filter(
            (g) =>
              g.type === selectedType ||
              (g.debit_credit_nature || g.debitCreditNature) === typeNature,
          );
        } else {
          filtered = filtered.filter(
            (g) =>
              g.type === selectedType ||
              (selectedType === "ASSET" &&
                (g.type === "BANK" || g.type === "CASH")),
          );
        }
      }

      const groupMap = new Map();
      filtered.forEach((g) => groupMap.set(g.id, g));

      if (filtered.length === 0) {
        groupSelect.innerHTML =
          '<option value="" disabled selected>-- Select Type First --</option>';
      } else {
        const options = filtered.map((g) => {
          let indent = "";
          let parent = g.parent_id;
          let level = 0;
          while (parent && groupMap.has(parent) && level < 10) {
            indent += "— ";
            parent = groupMap.get(parent).parent_id;
            level++;
          }
          return `<option value="${escapeHtml(g.id)}" ${g.id === (i.account_group_id || i.group_id) ? "selected" : ""}>${indent}${escapeHtml(g.code)} - ${escapeHtml(g.name)}</option>`;
        });
        groupSelect.innerHTML = options.join("");
      }
      checkEmptyState(filtered);
    };

    // ── Account Type management (custom types) ──
    const BUILT_IN_TYPES = [
      { value: "ASSET", label: "Asset", nature: "DEBIT" },
      { value: "LIABILITY", label: "Liability", nature: "CREDIT" },
      { value: "EQUITY", label: "Equity", nature: "CREDIT" },
      { value: "INCOME", label: "Income", nature: "CREDIT" },
      { value: "EXPENSE", label: "Expense", nature: "DEBIT" },
      { value: "BANK", label: "Bank", nature: "DEBIT" },
      { value: "CASH", label: "Cash", nature: "DEBIT" },
    ];

    let loadedTypes = [...BUILT_IN_TYPES];

    const loadAccountTypes = async () => {
      try {
        const res = await API.get("/accounting/account-types");
        const apiTypes = res?.types || res?.data?.types || [];
        // Normalize API types to match BUILT_IN_TYPES format (value/label/nature)
        const normalized = apiTypes.map((t) => ({
          value: t.name || t.value,
          label:
            t.label ||
            t.name ||
            (t.value ? t.value.charAt(0) + t.value.slice(1).toLowerCase() : ""),
          nature: t.nature || t.debit_credit_nature || t.debitCreditNature,
          isBuiltin: t.is_builtin || t.isBuiltin || false,
        }));
        loadedTypes = [
          ...BUILT_IN_TYPES,
          ...normalized.filter(
            (t) => !BUILT_IN_TYPES.some((b) => b.value === t.value),
          ),
        ];
        renderTypeOptions();
      } catch (err) {
        loadedTypes = [...BUILT_IN_TYPES];
        renderTypeOptions();
      }
    };

    const renderTypeOptions = () => {
      if (!typeSelect) return;
      let html = "";
      loadedTypes.forEach((t) => {
        html += `<option value="${t.value}">${t.label}</option>`;
      });
      // Add the "+ Create New Account Type" option
      html += `<option value="__create_new__" class="text-secondary font-medium">+ Create New Account Type</option>`;
      typeSelect.innerHTML = html;
      // Restore previous selection if it still exists
      if (i.type && loadedTypes.some((t) => t.value === i.type)) {
        typeSelect.value = i.type;
      }
    };

    const openCreateTypeModal = (onTypeCreated) => {
      const typeModal = new Modal({
        title: "Create New Account Type",
        subtitle: "Add a custom account type for your organisation.",
        size: "md",
        content: `
          <form id="coa-new-type-form" class="space-y-4">
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Account Type Name *</label>
              <input name="name" type="text" required placeholder="e.g., GRANTS, PREPAID, DEFERRED..."
                     class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Debit/Credit Nature</label>
              <select name="debit_credit_nature" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
                <option value="DEBIT">Debit</option>
                <option value="CREDIT">Credit</option>
              </select>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Description (optional)</label>
              <textarea name="description" rows="2" placeholder="Purpose of this account type..."
                        class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"></textarea>
            </div>
            <div class="flex justify-end gap-2 pt-2 border-t border-outline-variant/30">
              <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
              <button type="submit" id="coa-new-type-submit"
                      class="bg-secondary text-on-secondary px-5 py-2 rounded-lg hover:bg-secondary/90 font-medium disabled:opacity-50">Create Account Type</button>
            </div>
          </form>
        `,
      });
      typeModal.open();

      const typeForm = typeModal.element.querySelector("#coa-new-type-form");
      const submitBtn = typeModal.element.querySelector("#coa-new-type-submit");

      typeForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(typeForm);
        const typeName = fd.get("name").trim().toUpperCase();
        const description = fd.get("description").trim();
        const nature = fd.get("debit_credit_nature");

        // Validate: not empty
        if (!typeName) {
          Toast.error("Account Type Name is required");
          return;
        }

        // Validate: not a duplicate (check built-in + loaded)
        if (BUILT_IN_TYPES.some((b) => b.value === typeName)) {
          Toast.error(
            `"${typeName}" is a built-in account type and cannot be duplicated`,
          );
          return;
        }
        if (loadedTypes.some((t) => t.value === typeName)) {
          Toast.error(`An account type named "${typeName}" already exists`);
          return;
        }

        submitBtn.disabled = true;
        submitBtn.classList.add("opacity-50", "cursor-not-allowed");

        try {
          const resp = await API.post("/accounting/account-types", {
            name: typeName,
            description: description,
            debit_credit_nature: nature,
          });
          const newType = resp.data?.type || resp?.type || resp;
          typeModal.close();

          // Reload types and select the newly created one
          await loadAccountTypes();
          if (typeSelect) {
            typeSelect.value = newType?.name || newType?.value;
            // Trigger nature derivation for the new type
            deriveNature(newType?.name || newType?.value);
          }
          if (onTypeCreated) onTypeCreated(newType);
          Toast.success("Account type created successfully");
        } catch (err) {
          const msg =
            err.message || err.code || "Failed to create account type";
          Toast.error(msg);
        } finally {
          submitBtn.disabled = false;
          submitBtn.classList.remove("opacity-50", "cursor-not-allowed");
        }
      });
    };

    // Initial load
    const initialType = i.type || "ASSET";
    await loadAccountTypes();
    deriveNature(initialType);
    await loadGroupsForType(initialType);

    // When Account Type changes
    if (typeSelect) {
      typeSelect.addEventListener("change", async () => {
        const selectedType = typeSelect.value;
        if (selectedType === "__create_new__") {
          // Reset the select to the previous value
          typeSelect.value = i.type || "ASSET";
          openCreateTypeModal();
          return;
        }
        deriveNature(selectedType);
        await loadGroupsForType(selectedType);
      });
    }

    // Quick-create group button — create a group pre-filled with current type
    quickCreateBtn?.addEventListener("click", async () => {
      const currentType = typeSelect?.value || "ASSET";
      self.openGroupForm({ type: currentType });
    });

    // "Create one now" link in empty state
    createGroupLink?.addEventListener("click", async (e) => {
      e.preventDefault();
      const currentType = typeSelect?.value || "ASSET";
      await self.openGroupForm({ type: currentType });
      // After group is created, reload the group dropdown
      await loadGroupsForType(typeSelect?.value || "ASSET");
    });

    const createAnotherBtn = modal.element.querySelector(
      "#coa-create-another-acc",
    );
    if (createAnotherBtn) {
      createAnotherBtn.addEventListener("click", async () => {
        createAnother = true;
        await form.dispatchEvent(new Event("submit"));
      });
    }

    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = {
          code: fd.get("code").trim(),
          name: fd.get("name").trim(),
          type: fd.get("type"),
          account_group_id: fd.get("account_group_id") || null,
          parent_id: fd.get("parent_id") || null,
          is_group: false,
          allow_direct_posting: fd.get("allow_direct_posting") !== "false",
          reconciliation_required: !!fd.get("reconciliation_required"),
          opening_balance: parseFloat(fd.get("opening_balance")) || 0,
          opening_balance_type: fd.get("opening_balance_type"),
          opening_balance_date: fd.get("opening_balance_date") || null,
          debit_credit_nature: fd.get("debit_credit_nature"),
          description: fd.get("description") || "",
          is_active: fd.get("is_active") === "1" ? 1 : 0,
        };
        try {
          if (isEdit) {
            await API.put("/accounting/accounts/" + i.id, payload);
            Toast.success("Account updated");
          } else {
            await API.post("/accounting/accounts", payload);
            Toast.success("Account created");
          }
          if (createAnother) {
            createAnother = false;
            // Reset form fields but keep Account Type and Group
            e.target.reset();
            // Re-derive nature for current type
            deriveNature(typeSelect?.value || "ASSET");
            return;
          }
          modal.close();
          self.load();
        } catch (err) {
          Toast.error(err.message || "Failed to save account");
        }
      });
    }
  },

  renderLedgerForm(i, isEdit) {
    return `
      <form id="coa-form" class="space-y-4">
        <div class="border-b border-outline-variant/30 pb-3">
          <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-3">Basic Information</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Account Code</label>
              <input name="code" value="${escapeHtml(i.code || "")}" ${isEdit ? "" : "readonly"} placeholder="${isEdit ? "" : "Loading…"}" class="w-full bg-surface-container border border-outline-variant/40 rounded-lg px-3 py-2 text-body-md text-on-surface font-code ${isEdit ? "" : "opacity-80 cursor-not-allowed"}"/>
              ${isEdit ? "" : `<div class="font-body-xs text-on-surface-variant mt-1">Auto-generated</div>`}
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Account Name *</label>
              <input name="name" value="${escapeHtml(i.name)}" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Account Type *</label>
              <select name="type" id="coa-type-select" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"></select>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Account Group *</label>
              <div class="flex gap-2">
                <select name="account_group_id" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40" id="coa-group-select"></select>
                <button type="button" id="coa-quick-create-group" class="px-3 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-body-sm text-xs shrink-0" title="Create Account Group">
                  +
                </button>
              </div>
              <div id="coa-no-groups-msg" class="hidden mt-1 font-body-xs text-on-surface-variant">No Account Groups found for this Account Type. <a href="#" id="coa-create-group-link" class="text-secondary">Create one now</a>.</div>
            </div>
          </div>
        </div>
        <div class="border-b border-outline-variant/30 pb-3">
          <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-3">Accounting Configuration</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Debit/Credit Nature</label>
              <select name="debit_credit_nature" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
                <option value="DEBIT" ${i.debit_credit_nature === "DEBIT" ? "selected" : ""}>Debit</option>
                <option value="CREDIT" ${i.debit_credit_nature === "CREDIT" ? "selected" : ""}>Credit</option>
              </select>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Opening Balance</label>
              <input name="opening_balance" type="number" step="0.01" value="${i.opening_balance || 0}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Opening Balance Type</label>
              <select name="opening_balance_type" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
                <option value="DEBIT" ${i.opening_balance_type === "DEBIT" ? "selected" : ""}>Debit</option>
                <option value="CREDIT" ${i.opening_balance_type === "CREDIT" ? "selected" : ""}>Credit</option>
              </select>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Opening Balance Date</label>
              <input name="opening_balance_date" type="date" value="${i.opening_balance_date || new Date().toISOString().slice(0, 10)}" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            </div>
            <div class="md:col-span-2 flex items-end justify-end gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="reconciliation_required" ${i.reconciliation_required ? "checked" : ""} class="w-4 h-4 rounded text-secondary focus:ring-secondary/40 border-outline-variant/50"/>
                <span class="font-label-sm text-label-sm text-on-surface">Reconciliation Required</span>
              </label>
            </div>
          </div>
        </div>
        <div>
          <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-3">Additional Configuration</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="md:col-span-2">
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Description</label>
              <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40" placeholder="Optional description...">${escapeHtml(i.description)}</textarea>
            </div>
            <div>
              <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Status</label>
              <select name="is_active" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
                <option value="1" ${i.is_active !== 0 ? "selected" : ""}>Active</option>
                <option value="0" ${i.is_active === 0 ? "selected" : ""}>Inactive</option>
              </select>
            </div>
            <div class="flex items-end justify-end gap-2">
              <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
              <button type="button" id="coa-create-another-acc" class="px-4 py-2 rounded-lg border border-outline-variant/50 hover:bg-surface-container text-on-surface">${isEdit ? "Save & Close" : "Create & Add Another"}</button>
              <button type="submit" class="bg-secondary text-on-secondary px-5 py-2 rounded-lg hover:bg-secondary/90 font-medium">${isEdit ? "Save Changes" : "Create Account"}</button>
            </div>
          </div>
        </div>
      </form>
    `;
  },

  openGroupForm(row = null) {
    const self = this;
    const isEdit = !!row;
    const i = row || {};
    let createAnother = false;
    const modal = new Modal({
      title: isEdit ? "Edit Account Group" : "Create Account Group",
      subtitle: isEdit
        ? "Update group details."
        : "Create a group to organize related ledger accounts.",
      size: "lg",
      content: `
        <form id="coa-group-form" class="space-y-4">
          <div class="border-b border-outline-variant/30 pb-3">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-3">Group Information</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Group Code</label>
                <input name="code" value="${i.code || ""}" ${isEdit ? "" : "readonly"} placeholder="${isEdit ? "" : "Loading…"}" class="w-full bg-surface-container border border-outline-variant/40 rounded-lg px-3 py-2 text-body-md text-on-surface font-code ${isEdit ? "" : "opacity-80 cursor-not-allowed"}"/>
                ${isEdit ? "" : `<div class="font-body-xs text-on-surface-variant mt-1">Auto-generated</div>`}
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Group Name *</label>
                <input name="name" value="${i.name || ""}" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Account Type *</label>
                <select name="type" required class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
                  <option value="ASSET" ${i.type === "ASSET" ? "selected" : ""}>Asset</option>
                  <option value="LIABILITY" ${i.type === "LIABILITY" ? "selected" : ""}>Liability</option>
                  <option value="EQUITY" ${i.type === "EQUITY" ? "selected" : ""}>Equity</option>
                  <option value="INCOME" ${i.type === "INCOME" ? "selected" : ""}>Income</option>
                  <option value="EXPENSE" ${i.type === "EXPENSE" ? "selected" : ""}>Expense</option>
                </select>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Parent Group</label>
                <select name="parent_id" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40" id="coa-parent-select">
                  <option value="">No parent (top-level)</option>
                </select>
              </div>
            </div>
          </div>
          <div>
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-3">Additional Configuration</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="md:col-span-2">
                <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Description</label>
                <textarea name="description" rows="2" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40" placeholder="Optional description...">${i.description || ""}</textarea>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Status</label>
                <select name="is_active" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
                  <option value="1" ${i.is_active !== 0 ? "selected" : ""}>Active</option>
                  <option value="0" ${i.is_active === 0 ? "selected" : ""}>Inactive</option>
                </select>
              </div>
              <div>
                <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">Allow Child Accounts</label>
                <div class="flex items-center gap-4">
                  <label class="flex items-center gap-2">
                    <input type="radio" name="allow_child_accounts" value="1" ${i.allow_child_accounts !== 0 ? "checked" : ""} class="text-secondary focus:ring-secondary"/>
                    <span class="font-body-sm text-on-surface">Yes</span>
                  </label>
                  <label class="flex items-center gap-2">
                    <input type="radio" name="allow_child_accounts" value="0" ${i.allow_child_accounts === 0 ? "checked" : ""} class="text-secondary focus:ring-secondary"/>
                    <span class="font-body-sm text-on-surface">No</span>
                  </label>
                </div>
              </div>
              <div class="flex items-end justify-end gap-2">
                <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
                <button type="button" id="coa-create-another" class="px-4 py-2 rounded-lg border border-outline-variant/50 hover:bg-surface-container text-on-surface">${isEdit ? "Save & Close" : "Create & Add Another"}</button>
                <button type="submit" class="bg-secondary text-on-secondary px-5 py-2 rounded-lg hover:bg-secondary/90 font-medium">${isEdit ? "Save Changes" : "Create Account Group"}</button>
              </div>
            </div>
          </div>
        </form>
      `,
    });
    modal.open();

    // Auto-generated group code preview (display-only; the backend generates
    // the final code at create time).
    if (!isEdit) {
      API.get("/accounting/codes/preview?entity=ACCOUNT_GROUP")
        .then((r) => {
          const codeInput = modal.element.querySelector('#coa-group-form input[name="code"]');
          if (codeInput && r?.code) codeInput.value = r.code;
        })
        .catch(() => {});
    }

    // Load parent groups for selection (excluding self and descendants)
    const parentEl = modal.element.querySelector("#coa-parent-select");
    if (parentEl) {
      this._loadParentGroups(parentEl, i.parent_id, i.id);
      // Type inheritance: when parent changes, suggest the parent's type
      parentEl.addEventListener("change", async () => {
        const selectedId = parentEl.value;
        if (!selectedId) return;
        try {
          const res = await API.get(
            "/accounting/accounts/groups/suggest/" + selectedId,
          );
          const suggestion = res?.suggestion;
          if (suggestion && suggestion.type) {
            const typeSelect = modal.element.querySelector(
              'select[name="type"]',
            );
            if (typeSelect) {
              // Only auto-set if current type doesn't match (i.e., it was the default or user hasn't changed it)
              const currentValue = typeSelect.value;
              const parentType = suggestion.type;
              if (!currentValue || currentValue === parentType) {
                typeSelect.value = parentType;
              }
            }
          }
        } catch {}
      });
    }

    const form = modal.element.querySelector("#coa-group-form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = {
          code: fd.get("code").trim(),
          name: fd.get("name").trim(),
          type: fd.get("type"),
          parent_id: fd.get("parent_id") || null,
          description: fd.get("description") || "",
          is_active: fd.get("is_active") === "1" ? 1 : 0,
          allow_child_accounts: fd.get("allow_child_accounts") === "1" ? 1 : 0,
        };
        try {
          if (isEdit) {
            await API.put("/accounting/accounts/groups/" + i.id, payload);
            Toast.success("Account group updated");
          } else {
            const res = await API.post("/accounting/accounts/groups", payload);
            Toast.success("Account group created");
            // If Create & Add Another was clicked, reset form and keep modal open
            if (createAnother) {
              form.reset();
              fd.set("code", "");
              fd.set("name", "");
              // Re-pick the parent type suggestion if parent is still selected
              const parentEl =
                modal.element.querySelector("#coa-parent-select");
              if (parentEl && parentEl.value) {
                const suggestRes = await API.get(
                  "/accounting/accounts/groups/suggest/" + parentEl.value,
                );
                const suggestion = suggestRes?.data?.suggestion;
                if (suggestion?.type) {
                  modal.element.querySelector('select[name="type"]').value =
                    suggestion.type;
                }
              }
              return;
            }
          }
          modal.close();
          self.load();
        } catch (err) {
          Toast.error(err.message || "Failed to save group");
        }
      });
    }

    // Create & Add Another button
    const addAnotherBtn = modal.element.querySelector("#coa-create-another");
    if (addAnotherBtn) {
      addAnotherBtn.addEventListener("click", async () => {
        createAnother = true;
        await form.dispatchEvent(new Event("submit"));
      });
    }
  },

  async _loadParentGroups(el, selectedId, excludeId = null) {
    try {
      const res = await API.get("/accounting/accounts/groups");
      const groups = res?.groups || res?.items || [];
      const groupMap = new Map();
      groups.forEach((g) => groupMap.set(g.id, g));
      let allExcluded = new Set();
      if (excludeId) {
        const collectDescendants = (parentId) => {
          groups.forEach((g) => {
            if (g.parent_id === parentId) {
              allExcluded.add(g.id);
              collectDescendants(g.id);
            }
          });
        };
        collectDescendants(excludeId);
        allExcluded.add(excludeId);
      }
      const options = groups
        .filter((g) => !allExcluded.has(g.id))
        .map((g) => {
          let indent = "";
          let parent = g.parent_id;
          let level = 0;
          while (parent && groupMap.has(parent) && level < 10) {
            indent += "— ";
            parent = groupMap.get(parent).parent_id;
            level++;
          }
          return `<option value="${g.id}" ${g.id === selectedId ? "selected" : ""}>${indent}${g.code} - ${g.name} (${g.type})</option>`;
        });
      el.innerHTML =
        '<option value="">No parent (top-level)</option>' + options.join("");
    } catch {
      el.innerHTML = '<option value="">No parent (top-level)</option>';
    }
  },

  async _loadGroups(selector, selectedId, filterType = null) {
    const el = document.querySelector(selector);
    if (!el) return;
    try {
      const res = await API.get("/accounting/accounts/groups");
      const groups = res?.groups || res?.items || [];
      const validTypes = [
        "ASSET",
        "LIABILITY",
        "EQUITY",
        "INCOME",
        "EXPENSE",
        "BANK",
        "CASH",
      ];
      let filtered = groups.filter((g) => validTypes.includes(g.type));
      // If filterType is provided, only show groups of that type (and BANK/CASH as subtypes of ASSET)
      if (filterType) {
        filtered = filtered.filter(
          (g) =>
            g.type === filterType || g.type === "BANK" || g.type === "CASH",
        );
      }

      // Build hierarchical indentation
      const groupMap = new Map();
      filtered.forEach((g) => groupMap.set(g.id, g));

      if (filtered.length === 0) {
        el.innerHTML =
          '<option value="" disabled selected>No Account Groups Available</option>';
      } else {
        const options = filtered.map((g) => {
          let indent = "";
          let parent = g.parent_id;
          let level = 0;
          while (parent && groupMap.has(parent) && level < 10) {
            indent += "— ";
            parent = groupMap.get(parent).parent_id;
            level++;
          }
          return `<option value="${g.id}" ${g.id === selectedId ? "selected" : ""}>${indent}${g.code} - ${g.name}</option>`;
        });
        el.innerHTML = options.join("");
      }
    } catch {
      el.innerHTML = '<option value="">Loading...</option>';
    }
  },

  async toggleActive(row) {
    try {
      await API.put("/accounting/accounts/" + row.id, {
        is_active: !row.is_active,
      });
      Toast.success(
        "Account " + (row.is_active !== 0 ? "deactivated" : "activated"),
      );
      this.load();
    } catch (err) {
      Toast.error(err.message);
    }
  },

  confirmDelete(row) {
    const self = this;
    const isGroup =
      row.kind === "group" ||
      row.isGroup === true ||
      row.isGroup === 1 ||
      row.is_group === 1 ||
      row.is_group === true;
    let endpoint, label;
    if (isGroup) {
      endpoint = "/accounting/accounts/groups/" + row.id;
      label = "Account Group";
    } else {
      endpoint = "/accounting/accounts/" + row.id;
      label = "Ledger Account";
    }

    const modal = new Modal({
      title: `Delete ${label}?`,
      size: "sm",
      content: `<p class="font-body-md text-on-surface mb-4">Delete <strong>${row.code} - ${row.name}</strong>?</p>
        <p class="font-body-sm text-on-surface-variant mb-4">This action is permanent and cannot be undone.</p>
        <div class="flex justify-end gap-2"><button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
        <button id="confirm-coa-delete" class="bg-error text-on-error px-4 py-2 rounded-lg hover:bg-error/90">Delete</button></div>`,
    });
    modal.open();
    modal.element
      .querySelector("#confirm-coa-delete")
      .addEventListener("click", async () => {
        try {
          await API.del(endpoint);
          Toast.success(`${label} deleted`);
          modal.close();
          self.load();
        } catch (err) {
          Toast.error(err.message || "Failed to delete");
        }
      });
  },

  openMoveForm(row) {
    const self = this;
    const isGroup =
      row.kind === "group" ||
      row.isGroup === true ||
      row.isGroup === 1 ||
      row.is_group === 1 ||
      row.is_group === true;
    const modal = new Modal({
      title: `Move ${isGroup ? "Account Group" : "Ledger Account"}`,
      size: "md",
      content: `
        <div class="space-y-4">
          <p class="font-body-sm text-on-surface-variant">Move <strong>${row.code} - ${row.name}</strong> to a new parent group.</p>
          <div>
            <label class="block font-label-sm text-label-sm text-on-surface-variant mb-1">New Parent Group</label>
            <select name="new_parent_id" id="coa-move-select" class="w-full bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40">
              <option value="">No parent (top-level)</option>
            </select>
          </div>
          <div class="flex justify-end gap-2 pt-2 border-t border-outline-variant/30">
            <button type="button" data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
            <button id="coa-move-confirm" class="bg-secondary text-on-secondary px-5 py-2 rounded-lg hover:bg-secondary/90 font-medium">Move</button>
          </div>
        </div>
      `,
    });
    modal.open();
    const moveSelect = modal.element.querySelector("#coa-move-select");
    if (moveSelect) {
      this._loadParentGroups(
        moveSelect,
        row.parent_id || row.account_group_id,
        row.id,
      );
    }
    modal.element
      .querySelector("#coa-move-confirm")
      .addEventListener("click", async () => {
        const newParent = moveSelect.value;
        const endpoint = isGroup
          ? "/accounting/accounts/groups/" + row.id
          : "/accounting/accounts/" + row.id;
        const payload = isGroup
          ? { parent_id: newParent || null }
          : {
              account_group_id: newParent || "ag_asset",
              parent_id: newParent || null,
            };
        try {
          if (isGroup) await API.put(endpoint, payload);
          else await API.put(endpoint, payload);
          Toast.success("Moved successfully");
          modal.close();
          self.load();
        } catch (err) {
          Toast.error(err.message || "Failed to move");
        }
      });
  },

  viewGroup(row) {
    const self = this;
    const modal = new Modal({
      title: `${row.code} - ${row.name}`,
      size: "lg",
      content:
        '<div id="coa-group-detail"><div class="text-center py-12"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div></div>',
    });
    modal.open();
    API.get("/accounting/accounts/groups/" + row.id)
      .then((res) => {
        const group = res?.data || res || {};
        const children = group.child_groups || [];
        const accounts = group.child_accounts || [];
        const detail = modal.element.querySelector("#coa-group-detail");
        detail.innerHTML = `
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-4"><div><label class="font-label-sm text-on-surface-variant">Group Code</label><p class="font-code text-on-surface">${group.code || ""}</p></div><div><label class="font-label-sm text-on-surface-variant">Group Name</label><p class="font-body-md text-on-surface">${group.name || ""}</p></div></div>
          <div class="grid grid-cols-2 gap-4"><div><label class="font-label-sm text-on-surface-variant">Account Type</label><p class="text-on-surface">${group.type || ""}</p></div><div><label class="font-label-sm text-on-surface-variant">Status</label><p class="text-on-surface">${group.is_active !== 0 ? "Active" : "Inactive"}</p></div></div>
          <div><label class="font-label-sm text-on-surface-variant">Allow Child Accounts</label><p class="text-on-surface">${group.allow_child_accounts !== 0 ? "Yes" : "No"}</p></div>
          <div><label class="font-label-sm text-on-surface-variant">Allow Direct Posting</label><p class="text-on-surface">${group.is_group ? "No (Group)" : "Yes"}</p></div>
          ${group.description ? `<div><label class="font-label-sm text-on-surface-variant">Description</label><p class="text-on-surface">${group.description}</p></div>` : ""}
          <div>
            <h4 class="font-label-md text-on-surface-variant uppercase mb-2">Child Groups (${children.length})</h4>
            <div class="space-y-1">${children.map((g) => `<div class="font-code text-[13px] text-on-surface-variant">${g.code} - ${g.name}</div>`).join("") || '<p class="text-on-surface-variant">No child groups</p>'}</div>
          </div>
          <div>
            <h4 class="font-label-md text-on-surface-variant uppercase mb-2">Child Ledger Accounts (${accounts.length})</h4>
            <div class="space-y-1">${accounts.map((a) => `<div class="font-code text-[13px] text-on-surface-variant">${a.code} - ${a.name}</div>`).join("") || '<p class="text-on-surface-variant">No child accounts</p>'}</div>
          </div>
        </div>
      `;
      })
      .catch(() => {
        document.getElementById("coa-group-detail").innerHTML =
          '<p class="text-error">Failed to load details</p>';
      });
  },

  openImportModal() {
    const self = this;
    const modal = new Modal({
      title: "Import Accounts",
      size: "lg",
      content: `
        <div class="space-y-4">
          <div class="bg-surface-container-low rounded-lg border border-outline-variant/30 p-4 text-center">
            <span class="material-symbols-outlined text-[32px] text-on-surface-variant">file_upload</span>
            <p class="font-body-sm text-on-surface-variant mt-2">Upload CSV file with account data</p>
          </div>
          <div class="border border-dashed border-outline-variant/50 rounded-lg p-4 text-center">
            <input type="file" id="coa-import-file" accept=".csv,.json" class="hidden"/>
            <label for="coa-import-file" class="cursor-pointer flex items-center justify-center gap-2">
              <span class="material-symbols-outlined">attach_file</span> Choose file
            </label>
            <div id="coa-import-filename" class="font-body-sm text-on-surface-variant mt-2">No file selected</div>
          </div>
          <div id="coa-import-preview" class="max-h-60 overflow-y-auto border border-outline-variant/30 rounded-lg hidden"></div>
          <div class="flex justify-end gap-2 pt-2">
            <button data-modal-close class="px-4 py-2 rounded-lg hover:bg-surface-container text-on-surface">Cancel</button>
            <button id="coa-import-confirm" class="bg-secondary text-on-secondary px-5 py-2 rounded-lg hover:bg-secondary/90 disabled:opacity-50" disabled>Import</button>
          </div>
        </div>
      `,
    });
    modal.open();

    let parsedData = null;
    const fileInput = modal.element.querySelector("#coa-import-file");
    const filenameEl = modal.element.querySelector("#coa-import-filename");
    const previewEl = modal.element.querySelector("#coa-import-preview");
    const confirmBtn = modal.element.querySelector("#coa-import-confirm");

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      filenameEl.textContent = file.name;
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          let data;
          if (file.name.endsWith(".json")) {
            data = JSON.parse(event.target.result);
          } else {
            const lines = event.target.result
              .split("\n")
              .filter((l) => l.trim());
            const headers = lines[0]
              .split(",")
              .map((h) => h.trim().toLowerCase());
            data = lines.slice(1).map((line) => {
              const values = line.split(",");
              const row = {};
              headers.forEach((h, idx) => {
                let v = values[idx]?.trim() || "";
                if (
                  [
                    "is_group",
                    "allow_direct_posting",
                    "reconciliation_required",
                    "is_active",
                  ].includes(h)
                ) {
                  v = v === "yes" || v === "true" || v === "1";
                }
                if (h === "opening_balance") v = parseFloat(v) || 0;
                row[h] = v;
              });
              return row;
            });
          }
          parsedData = data;
          let html = '<div class="p-2 space-y-1">';
          data.slice(0, 10).forEach((row) => {
            html += `<div class="font-body-sm">${row.code} - ${row.name} (${row.type})</div>`;
          });
          if (data.length > 10)
            html += `<div class="font-body-sm text-on-surface-variant">+ ${data.length - 10} more</div>`;
          html += "</div>";
          previewEl.innerHTML = html;
          previewEl.classList.remove("hidden");
          confirmBtn.disabled = false;
        } catch (err) {
          Toast.error("Failed to parse file: " + err.message);
        }
      };
      reader.readAsText(file);
    });

    confirmBtn.addEventListener("click", async () => {
      if (!parsedData) return;
      modal.close();
      try {
        const res = await API.post("/accounting/accounts/import", {
          accounts: parsedData,
        });
        if (res.results) {
          const r = res.results;
          Toast.success(
            `Import complete: ${r.created} created, ${r.updated} updated, ${r.errors.length} errors`,
          );
          self.load();
        } else {
          Toast.error(res.error?.message || "Import failed");
        }
      } catch (err) {
        Toast.error(err.message || "Import failed");
      }
    });
  },

  exportAccounts() {
    window.open("/api/accounting/accounts/export", "_blank");
  },

  printView() {
    window.print();
  },

  fmt(n) {
    return AccountingState.fmt(n);
  },
};
