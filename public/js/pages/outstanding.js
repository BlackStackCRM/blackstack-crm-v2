window.PageModules = window.PageModules || {};

window.PageModules.outstanding = {
  state: { dateFrom: '', dateTo: '' },

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    await AccountingState.init();

    main.innerHTML = `
      <div class="space-y-stack-lg">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="font-display text-h1 text-on-surface tracking-tight">Outstanding Dashboard</h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Track receivables, payables, and aging analysis.</p>
          </div>
          <div class="flex gap-stack-sm">
            <input id="out-from" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <input id="out-to" type="date" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40"/>
            <button id="out-refresh" class="flex items-center gap-1 bg-secondary/10 text-secondary px-3 py-2 rounded-lg hover:bg-secondary/20">
              <span class="material-symbols-outlined text-[18px]">refresh</span>
            </button>
          </div>
        </div>

        <div id="out-summary" class="grid grid-cols-2 sm:grid-cols-4 gap-stack-md"></div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-stack-md">
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Receivable Aging</h3>
            <div id="out-recaging" class="space-y-2"></div>
          </div>
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
            <h3 class="font-label-md text-label-md text-on-surface-variant uppercase mb-stack-sm">Payable Aging</h3>
            <div id="out-payaging" class="space-y-2"></div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.load();
    return () => {};
  },

  bindEvents() {
    document.getElementById('out-refresh').addEventListener('click', () => this.load());
    document.getElementById('out-from').addEventListener('change', () => this.load());
    document.getElementById('out-to').addEventListener('change', () => this.load());
  },

  async load() {
    try {
      const [recRes, payRes] = await Promise.all([
        API.get('/accounting/receivables/summary'),
        API.get('/accounting/payables/summary')
      ]);
      const rec = recRes?.data || {};
      const pay = payRes?.data || {};
      const recAging = rec.aging?.[0] || {};
      const payAging = pay.aging?.[0] || {};

      document.getElementById('out-summary').innerHTML = [
        this.sumCard('Total Receivables', this.fmt(rec.total_outstanding), 'account_balance', 'bg-blue-100 text-blue-700'),
        this.sumCard('Total Payables', this.fmt(pay.total_outstanding), 'payment', 'bg-red-100 text-red-700'),
        this.sumCard('Overdue Receivables', this.fmt(recAging?.total_overdue), 'schedule', 'bg-orange-100 text-orange-700'),
        this.sumCard('Overdue Payables', this.fmt(payAging?.total_overdue), 'schedule', 'bg-yellow-100 text-yellow-700'),
      ].join('');

      // Receivable aging bars
      const recBuckets = [
        { label: '0-30 days', value: parseFloat(recAging?.aging_0_30 || recAging?.d0_30 || 0) },
        { label: '31-60 days', value: parseFloat(recAging?.aging_31_60 || recAging?.d31_60 || 0) },
        { label: '61-90 days', value: parseFloat(recAging?.aging_61_90 || recAging?.d61_90 || 0) },
        { label: '91-180 days', value: parseFloat(recAging?.aging_91_180 || recAging?.d91_180 || 0) },
        { label: '180+ days', value: parseFloat(recAging?.aging_180_plus || recAging?.d180_plus || 0) }
      ];
      const recMax = Math.max(...recBuckets.map(b => b.value), 1);
      document.getElementById('out-recaging').innerHTML = recBuckets.map(b => this.agingBar(b.label, b.value, recMax, this.fmt(b.value))).join('');

      // Payable aging bars
      const payBuckets = [
        { label: '0-30 days', value: parseFloat(payAging?.aging_0_30 || payAging?.d0_30 || 0) },
        { label: '31-60 days', value: parseFloat(payAging?.aging_31_60 || payAging?.d31_60 || 0) },
        { label: '61-90 days', value: parseFloat(payAging?.aging_61_90 || payAging?.d61_90 || 0) },
        { label: '91-180 days', value: parseFloat(payAging?.aging_91_180 || payAging?.d91_180 || 0) },
        { label: '180+ days', value: parseFloat(payAging?.aging_180_plus || payAging?.d180_plus || 0) }
      ];
      const payMax = Math.max(...payBuckets.map(b => b.value), 1);
      document.getElementById('out-payaging').innerHTML = payBuckets.map(b => this.agingBar(b.label, b.value, payMax, this.fmt(b.value))).join('');
    } catch (err) {
      console.error('Outstanding load error:', err);
    }
  },

  sumCard(label, value, icon, colorClass) {
    return `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
        <div class="flex items-center gap-stack-sm">
          <span class="material-symbols-outlined text-[20px] ${colorClass}">${icon}</span>
          <div>
            <p class="font-body-sm text-body-sm text-on-surface-variant">${label}</p>
            <p class="font-display text-h2 text-on-surface">${value}</p>
          </div>
        </div>
      </div>
    `;
  },

  agingBar(label, value, max, formattedValue) {
    return `
      <div class="flex items-center gap-stack-sm">
        <span class="font-body-xs text-body-xs text-on-surface-variant w-[80px]">${label}</span>
        <div class="flex-1 bg-surface-container-high rounded-lg h-6 overflow-hidden">
          <div class="h-full bg-error transition-all" style="width: ${(value / max) * 100}%"></div>
        </div>
        <span class="font-code text-code font-medium w-[100px] text-right">${formattedValue}</span>
      </div>
    `;
  },

  fmt(n) { return AccountingState.fmt(n); }
};
