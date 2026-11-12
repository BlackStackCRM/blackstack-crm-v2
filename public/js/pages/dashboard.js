window.PageModules = window.PageModules || {};

window.PageModules.dashboard = {
  intervalId: null,
  revenueChart: null,
  pipelineChart: null,
  currentCurrency: 'USD',

  async init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};

    // Load default currency from settings
    try {
      const settings = await API.get('/settings', {}, { silent: true });
      this.currentCurrency = settings.defaultCurrency || 'USD';
    } catch { /* use default */ }

    main.innerHTML = `
      <div class="flex items-center justify-between mb-stack-lg">
        <div>
          <h1 class="font-display text-h1 text-on-surface tracking-tight">Dashboard</h1>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Overview of your sales performance and pipeline.</p>
        </div>
        <div class="flex items-center gap-stack-sm">
          <select id="dash-period" class="bg-surface-container-low border border-outline-variant/50 rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:ring-2 focus:ring-secondary/40">
            <option value="7">Last 7 days</option>
            <option value="30" selected>Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
          <button id="dash-refresh" class="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors" aria-label="Refresh">
            <span class="material-symbols-outlined text-[18px] text-on-surface-variant">refresh</span>
          </button>
        </div>
      </div>

      <div id="metrics-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-stack-md mb-stack-lg">
        ${this.metricCardSkeleton()}
        ${this.metricCardSkeleton()}
        ${this.metricCardSkeleton()}
        ${this.metricCardSkeleton()}
        ${this.metricCardSkeleton()}
        ${this.metricCardSkeleton()}
        ${this.metricCardSkeleton()}
        ${this.metricCardSkeleton()}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-stack-md mb-stack-lg">
        <div class="lg:col-span-2 bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <div class="flex items-center justify-between mb-stack-md">
            <h2 class="font-h3 text-h3 text-on-surface">Revenue Trend</h2>
            <div id="revenue-total" class="font-display text-h3 text-on-surface">—</div>
          </div>
          <div class="relative h-72"><canvas id="revenue-chart"></canvas></div>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
          <h2 class="font-h3 text-h3 text-on-surface mb-stack-md">Pipeline by Stage</h2>
          <div class="relative h-72"><canvas id="pipeline-chart"></canvas></div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-stack-md">
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="flex items-center justify-between p-container-padding border-b border-outline-variant/30">
            <h2 class="font-h3 text-h3 text-on-surface">Recent Activity</h2>
            <a href="#activities" class="text-secondary font-body-sm text-body-sm hover:underline">View all</a>
          </div>
          <div id="recent-activity" class="divide-y divide-outline-variant/30"></div>
        </div>
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="flex items-center justify-between p-container-padding border-b border-outline-variant/30">
            <h2 class="font-h3 text-h3 text-on-surface">Team Performance</h2>
            <a href="#reports" class="text-secondary font-body-sm text-body-sm hover:underline">View report</a>
          </div>
          <div id="team-performance"></div>
        </div>
      </div>

      <div class="mt-stack-lg">
        <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30">
          <div class="flex items-center justify-between p-container-padding border-b border-outline-variant/30">
            <h2 class="font-h3 text-h3 text-on-surface">Action Center</h2>
            <a href="#action-center" class="text-secondary font-body-sm text-body-sm hover:underline">View all</a>
          </div>
          <div id="action-center-preview" class="divide-y divide-outline-variant/30"></div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.load();

    this.intervalId = setInterval(() => this.load(true), 60000);

    return () => {
      if (this.intervalId) clearInterval(this.intervalId);
      if (this.revenueChart) { this.revenueChart.destroy(); this.revenueChart = null; }
      if (this.pipelineChart) { this.pipelineChart.destroy(); this.pipelineChart = null; }
    };
  },

  metricCardSkeleton() {
    return `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding animate-pulse">
        <div class="h-3 bg-surface-container rounded w-20 mb-3"></div>
        <div class="h-7 bg-surface-container rounded w-32 mb-2"></div>
        <div class="h-3 bg-surface-container rounded w-16"></div>
      </div>
    `;
  },

  metricCard(label, value, change, icon, color) {
    const up = (change || 0) >= 0;
    return `
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-container-padding">
        <div class="flex items-start justify-between">
          <div>
            <p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">${label}</p>
            <p class="font-display text-display text-on-surface mt-2">${value}</p>
            ${change !== undefined ? `
              <div class="flex items-center gap-1 mt-2">
                <span class="material-symbols-outlined text-[14px] ${up ? 'text-green-600' : 'text-red-600'}">${up ? 'trending_up' : 'trending_down'}</span>
                <span class="font-body-sm text-body-sm ${up ? 'text-green-600' : 'text-red-600'} font-medium">${Math.abs(change).toFixed(1)}%</span>
                <span class="font-body-sm text-body-sm text-on-surface-variant">vs prior</span>
              </div>` : ''}
          </div>
          <div class="w-10 h-10 rounded-lg ${color} flex items-center justify-center">
            <span class="material-symbols-outlined text-[20px]">${icon}</span>
          </div>
        </div>
      </div>
    `;
  },

  bindEvents() {
    document.getElementById('dash-refresh')?.addEventListener('click', () => this.load());
    document.getElementById('dash-period')?.addEventListener('change', () => this.load());
  },

  async load(silent = false) {
    try {
      const period = document.getElementById('dash-period')?.value || 30;
      const result = await API.get('/dashboard/summary', { period });
      const data = result?.data || result || {};
      this.renderMetrics(data);
      this.renderRevenueChart(data.revenueTrend || []);
      this.renderPipelineChart(data.pipeline || []);
      this.renderRecentActivity(data.recentActivity || []);
      this.renderTeam(data.teamPerformance || []);
      const actionResult = await this.renderActionCenter();
      if (actionResult && actionResult.failed) {
        Toast.error('Action Center failed: ' + (actionResult.error || 'unknown error'));
      }
      if (!silent) Toast.success('Dashboard refreshed');
    } catch (err) {
      const status = err && (err.status || err.statusCode);
      const msg = (err && (err.message || err.error)) || 'Unknown error';
      if (status === 401 || status === 429) {
        // The API client handles invalid bearer tokens and rate-limit notices.
        // Do not turn transient 429s or non-token 401s into another redirect.
        return;
      }
      ErrorState.render(
        document.querySelector(".page-content") || document.body,
        () => this.load(),
        'Failed to load dashboard: ' + msg
      );
    }
  },

  renderMetrics(d) {
    const grid = document.getElementById('metrics-grid');
    if (!grid) return;
    const fmt = (n) => Currency.format(n, this.currentCurrency);
    grid.innerHTML = [
      this.metricCard('Revenue', fmt(d.revenue), d.revenueChange, 'payments', 'bg-green-100 text-green-700'),
      this.metricCard('Deals Won', d.dealsWon || 0, d.dealsWonChange, 'emoji_events', 'bg-yellow-100 text-yellow-700'),
      this.metricCard('Active Deals', d.activeDeals || 0, d.activeDealsChange, 'handshake', 'bg-blue-100 text-blue-700'),
      this.metricCard('Tasks Due', d.tasksDue || 0, undefined, 'task_alt', 'bg-purple-100 text-purple-700'),
      this.metricCard('New Leads', d.newLeads || 0, undefined, 'person_add', 'bg-teal-100 text-teal-700'),
      this.metricCard('Qualified Leads', d.qualifiedLeads || 0, undefined, 'verified', 'bg-indigo-100 text-indigo-700'),
      this.metricCard('Customers', d.customers || 0, undefined, 'groups', 'bg-pink-100 text-pink-700'),
      this.metricCard('Appointments', d.appointments || 0, undefined, 'event', 'bg-orange-100 text-orange-700'),
    ].join('');
  },

  renderRevenueChart(data) {
    const ctx = document.getElementById('revenue-chart');
    if (!ctx) return;
    if (this.revenueChart) this.revenueChart.destroy();
    const labels = data.map(d => d.label || d.date || '');
    const values = data.map(d => d.value || d.amount || 0);
    const total = values.reduce((a, b) => a + b, 0);
    const totalEl = document.getElementById('revenue-total');
    if (totalEl) totalEl.textContent = Currency.format(total, this.currentCurrency);

    this.revenueChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Revenue',
          data: values,
          borderColor: '#0058be',
          backgroundColor: 'rgba(0,88,190,0.1)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#0058be',
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => Currency.format(v, this.currentCurrency) }, beginAtZero: true },
        },
      },
    });
  },

  renderPipelineChart(data) {
    const ctx = document.getElementById('pipeline-chart');
    if (!ctx) return;
    if (this.pipelineChart) this.pipelineChart.destroy();
    const labels = data.map(d => d.stage || d.name || '');
    const values = data.map(d => d.value || d.amount || 0);
    const colors = ['#0058be', '#2170e4', '#5f5e5e', '#747878', '#c8c6c5', '#444748'];

    this.pipelineChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors.slice(0, values.length), borderWidth: 0 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } },
        },
      },
    });
  },

  renderRecentActivity(items) {
    const c = document.getElementById('recent-activity');
    if (!c) return;
    if (!items.length) {
      c.innerHTML = `<div class="p-container-padding text-center"><p class="font-body-sm text-body-sm text-on-surface-variant">No recent activity</p></div>`;
      return;
    }
    const icons = { call: 'call', email: 'mail', meeting: 'event', note: 'sticky_note_2', demo: 'videocam', task: 'task_alt' };
    c.innerHTML = items.slice(0, 8).map(a => `
      <div class="p-container-padding hover:bg-surface-container-low transition-colors">
        <div class="flex items-start gap-stack-md">
          <div class="w-8 h-8 rounded-full bg-secondary-container/10 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[16px] text-secondary">${icons[a.type] || 'history'}</span>
          </div>
          <div class="flex-1 min-w-0">
            <p class="font-body-md text-body-md text-on-surface truncate">${a.title || a.description || ''}</p>
            <p class="font-body-sm text-body-sm text-on-surface-variant">${a.contactName || a.dealTitle || ''} · ${this.timeAgo(a.createdAt || a.date)}</p>
          </div>
        </div>
      </div>
    `).join('');
  },

  renderTeam(items) {
    const c = document.getElementById('team-performance');
    if (!c) return;
    if (!items.length) {
      c.innerHTML = `<div class="p-container-padding text-center"><p class="font-body-sm text-body-sm text-on-surface-variant">No team data</p></div>`;
      return;
    }
    const fmt = (n) => Currency.format(n, this.currentCurrency);
    c.innerHTML = `
      <table class="w-full">
        <thead class="bg-surface-container-low text-on-surface-variant font-label-md text-label-md uppercase tracking-wider">
          <tr>
            <th class="text-left py-2 px-container-padding font-semibold">Member</th>
            <th class="text-right py-2 px-container-padding font-semibold">Deals</th>
            <th class="text-right py-2 px-container-padding font-semibold">Revenue</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30 font-body-md text-body-md text-on-surface">
          ${items.map(m => `
            <tr class="hover:bg-surface-container-low transition-colors">
              <td class="py-2.5 px-container-padding">
                <div class="flex items-center gap-stack-sm">
                  <div class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-on-secondary text-[10px] font-semibold">${(m.name || 'U').split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()}</div>
                  <span class="truncate">${m.name || ''}</span>
                </div>
              </td>
              <td class="py-2.5 px-container-padding text-right">${m.dealsWon || m.deals || 0}</td>
              <td class="py-2.5 px-container-padding text-right font-medium">${fmt(m.revenue)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  },
  timeAgo(date) {
    if (!date) return '';
    const diff = Date.now() - new Date(date).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  },

  async renderActionCenter() {
    const c = document.getElementById('action-center-preview');
    if (!c) return;
    try {
      const res = await API.get('/ai/action-center');
      const data = res || {};
      const actions = (data.actions || []).slice(0, 5);
      if (!actions.length) {
        c.innerHTML = '<div class="p-container-padding text-center"><p class="font-body-sm text-body-sm text-on-surface-variant">You are all caught up!</p></div>';
        return { failed: false };
      }
      const icons = { overdue_task: 'task_alt', no_next_action: 'psychology', stale_lead: 'person_off', upcoming_appointment: 'event' };
      c.innerHTML = actions.map(a => '<div class="p-container-padding hover:bg-surface-container-low transition-colors">' +
        '<div class="flex items-start gap-stack-md">' +
          '<div class="w-8 h-8 rounded-full bg-secondary-container/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[16px] text-secondary">' + (icons[a.type] || 'psychology') + '</span></div>' +
          '<div class="flex-1 min-w-0">' +
            '<p class="font-body-md text-body-md text-on-surface truncate">' + (a.title || '') + '</p>' +
            '<p class="font-body-sm text-body-sm text-on-surface-variant">' + (a.reason || '') + '</p>' +
          '</div>' +
        '</div>' +
      '</div>').join('');
    } catch (e) {
      // FIX (dashboard diagnosis): surface the real error to load() instead of
      // swallowing it — a silent catch here blanked the whole dashboard with a
      // generic ErrorState while the actual cause (a broken SQL column
      // reference in /ai/action-center) stayed invisible.
      return { failed: true, error: (e && e.message) || 'unknown' };
    }
  },
};
