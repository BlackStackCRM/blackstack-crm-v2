class StatusBadge {
  static statuses = {
    active: { label: 'Active', bg: 'bg-secondary-container/10 text-secondary', dot: 'bg-secondary' },
    inactive: { label: 'Inactive', bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' },
    pending: { label: 'Pending', bg: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
    completed: { label: 'Completed', bg: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
    cancelled: { label: 'Cancelled', bg: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
    paid: { label: 'Paid', bg: 'bg-surface-container text-on-surface-variant', dot: 'bg-primary' },
    overdue: { label: 'Overdue', bg: 'bg-error-container text-on-error-container', dot: 'bg-error' },
    sent: { label: 'Sent', bg: 'bg-secondary-fixed text-on-secondary-fixed', dot: 'bg-secondary' },
    draft: { label: 'Draft', bg: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-outline' },
    open: { label: 'Open', bg: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
    won: { label: 'Won', bg: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
    lost: { label: 'Lost', bg: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
    'new': { label: 'New', bg: 'bg-slate-100 text-slate-700 border-slate-200', dot: 'bg-slate-500' },
    contacted: { label: 'Contacted', bg: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
    qualified: { label: 'Qualified', bg: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
    unqualified: { label: 'Unqualified', bg: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
    nurture: { label: 'Nurture', bg: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
    converted: { label: 'Converted', bg: 'bg-purple-50 text-purple-700 border-purple-200', dot: 'bg-purple-500' },
    prospect: { label: 'Prospect', bg: 'bg-teal-50 text-teal-700 border-teal-200', dot: 'bg-teal-500' },
    onboarding: { label: 'Onboarding', bg: 'bg-indigo-50 text-indigo-700 border-indigo-200', dot: 'bg-indigo-500' },
    renewal: { label: 'Renewal', bg: 'bg-pink-50 text-pink-700 border-pink-200', dot: 'bg-pink-500' },
    churned: { label: 'Churned', bg: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
    interested: { label: 'Interested', bg: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
    not_interested: { label: 'Not Interested', bg: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
    no_show: { label: 'No Show', bg: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
    rescheduled: { label: 'Rescheduled', bg: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
    scheduled: { label: 'Scheduled', bg: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
    high: { label: 'High', bg: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
    medium: { label: 'Medium', bg: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
    low: { label: 'Low', bg: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
  };

  static render(status, customConfig = null) {
    const config = customConfig || this.statuses[status?.toLowerCase()] || this.statuses.pending;
    return `
      <span class="inline-flex items-center px-2 py-0.5 rounded-full font-label-md text-[11px] gap-1 ${config.bg}">
        <span class="w-1.5 h-1.5 rounded-full ${config.dot}"></span>
        ${config.label}
      </span>
    `;
  }

  static create(status, customConfig = null) {
    const container = document.createElement('span');
    container.innerHTML = this.render(status, customConfig).trim();
    return container.firstChild;
  }
}

window.StatusBadge = StatusBadge;
