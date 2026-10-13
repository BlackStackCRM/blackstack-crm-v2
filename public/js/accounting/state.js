// Accounting & Finance shared state and utility functions
window.AccountingState = {
  currentCurrency: 'INR',
  accounts: {},
  costCentres: {},
  bankAccounts: {},

  async init() {
    try {
      const settings = await API.get('/settings');
      this.currentCurrency = settings.defaultCurrency || 'INR';
    } catch { /* use default */ }
  },

  fmt(amount, currency) {
    return Currency.format(amount, currency || this.currentCurrency);
  },

  getAccountType(nature) {
    const types = {
      ASSET: { label: 'Asset', color: 'text-blue-700', bg: 'bg-blue-50' },
      LIABILITY: { label: 'Liability', color: 'text-red-700', bg: 'bg-red-50' },
      EQUITY: { label: 'Equity', color: 'text-purple-700', bg: 'bg-purple-50' },
      INCOME: { label: 'Income', color: 'text-green-700', bg: 'bg-green-50' },
      EXPENSE: { label: 'Expense', color: 'text-orange-700', bg: 'bg-orange-50' },
      BANK: { label: 'Bank', color: 'text-indigo-700', bg: 'bg-indigo-50' },
      CASH: { label: 'Cash', color: 'text-amber-700', bg: 'bg-amber-50' }
    };
    return types[nature] || { label: nature || 'Unknown', color: 'text-on-surface-variant', bg: 'bg-surface-container-high' };
  },

  getVoucherTypeLabel(type) {
    const types = {
      'JOURNAL': 'Journal Voucher',
      'PAYMENT': 'Payment Voucher',
      'RECEIPT': 'Receipt Voucher',
      'CONTRA': 'Contra Voucher',
      'CREDIT_NOTE': 'Credit Note',
      'DEBIT_NOTE': 'Debit Note'
    };
    return types[type] || type;
  },

  getVoucherTypeIcon(type) {
    const icons = {
      'JOURNAL': 'book',
      'PAYMENT': 'payments',
      'RECEIPT': 'receipt_long',
      'CONTRA': 'change_history',
      'CREDIT_NOTE': 'note',
      'DEBIT_NOTE': 'description'
    };
    return icons[type] || 'article';
  },

  getVoucherStatusLabel(status) {
    const statuses = {
      'DRAFT': { label: 'Draft', bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' },
      'POSTED': { label: 'Posted', bg: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
      'CANCELLED': { label: 'Cancelled', bg: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
      'REVERSED': { label: 'Reversed', bg: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500' }
    };
    const s = statuses[status] || { label: status || 'Unknown', bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' };
    return s;
  },

  getBillStatusLabel(status) {
    const statuses = {
      'DRAFT': { label: 'Draft', bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' },
      'SUBMITTED': { label: 'Submitted', bg: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
      'PENDING_APPROVAL': { label: 'Pending Approval', bg: 'bg-yellow-50 text-yellow-700', dot: 'bg-yellow-500' },
      'APPROVED': { label: 'Approved', bg: 'bg-indigo-50 text-indigo-700', dot: 'bg-indigo-500' },
      'POSTED': { label: 'Posted', bg: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
      'PARTIALLY_PAID': { label: 'Partially Paid', bg: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500' },
      'PAID': { label: 'Paid', bg: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
      'OVERDUE': { label: 'Overdue', bg: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
      'CANCELLED': { label: 'Cancelled', bg: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
      'WRITTEN_OFF': { label: 'Written Off', bg: 'bg-gray-50 text-gray-700', dot: 'bg-gray-500' }
    };
    return statuses[status] || { label: status || 'Unknown', bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' };
  },

  getReceivableStatusLabel(status) {
    const statuses = {
      'CURRENT': { label: 'Current', bg: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
      'DUE_SOON': { label: 'Due Soon', bg: 'bg-yellow-50 text-yellow-700', dot: 'bg-yellow-500' },
      'OVERDUE': { label: 'Overdue', bg: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
      'PARTIALLY_PAID': { label: 'Partially Paid', bg: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500' },
      'PAID': { label: 'Paid', bg: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
      'WRITTEN_OFF': { label: 'Written Off', bg: 'bg-gray-50 text-gray-700', dot: 'bg-gray-500' }
    };
    return statuses[status] || { label: status || 'Unknown', bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' };
  },

  getCustomerBillStatuses() {
    return ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'WRITTEN_OFF'];
  },

  getCustomerBillWorkflow(status) {
    const workflows = {
      DRAFT: ['SUBMIT', 'DELETE'],
      SUBMITTED: [],
      PENDING_APPROVAL: ['APPROVE', 'BACK_TO_DRAFT'],
      APPROVED: ['POST'],
      POSTED: ['PAYMENT', 'CREDIT_NOTE', 'WRITEOFF'],
      PARTIALLY_PAID: ['PAYMENT', 'CREDIT_NOTE', 'WRITEOFF'],
      PAID: ['CREDIT_NOTE', 'WRITEOFF'],
      OVERDUE: ['PAYMENT', 'CREDIT_NOTE', 'WRITEOFF', 'DISPUTE'],
      CANCELLED: [],
      WRITTEN_OFF: [],
    };
    return workflows[status] || [];
  },

  canTransition(status, action) {
    const workflow = this.getCustomerBillWorkflow(status);
    // Normalize: handle both status values and action names
    const actionMap = {
      'POSTED': 'POST',
      'APPROVED': 'APPROVE',
      'SUBMITTED': 'SUBMIT',
      'PENDING_APPROVAL': 'APPROVE',
      'PAYMENT': 'PAYMENT',
      'CREDIT_NOTE': 'CREDIT_NOTE',
      'PAY': 'PAYMENT',
      'SUBMIT': 'SUBMIT',
      'APPROVE': 'APPROVE',
      'POST': 'POST',
      'DELETE': 'DELETE',
      'BACK_TO_DRAFT': 'BACK_TO_DRAFT',
      'WRITEOFF': 'WRITEOFF',
      'DISPUTE': 'DISPUTE',
    };
    const normalized = actionMap[action] || action;
    return workflow.includes(normalized);
  },

  statusBadge(status) {
    // Use getBillStatusLabel which includes all customer bill lifecycle statuses
    const config = this.getBillStatusLabel(status);
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] gap-1 ${config.bg}">
      <span class="w-1.5 h-1.5 rounded-full ${config.dot}"></span>
      ${config.label}
    </span>`;
  }
};
