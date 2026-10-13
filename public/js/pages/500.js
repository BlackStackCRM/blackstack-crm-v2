window.PageModules = window.PageModules || {};

window.PageModules['500'] = {
  retryCount: 0,
  init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <div class="w-32 h-32 rounded-full bg-error-container/30 flex items-center justify-center">
          <span class="material-symbols-outlined text-[64px] text-error">error</span>
        </div>
        <h1 class="font-display text-h1 text-on-surface tracking-tight mt-stack-lg">Server Error</h1>
        <p class="font-body-md text-body-md text-on-surface-variant mt-2 max-w-md">Something went wrong on our end. Our team has been notified. Please try again in a moment.</p>
        <div id="500-error" class="hidden mt-stack-md bg-error-container/20 text-error rounded-lg p-stack-sm font-body-sm text-body-sm font-code"></div>
        <div class="mt-stack-md flex flex-wrap gap-stack-sm justify-center">
          <button id="retry-btn" class="flex items-center gap-stack-sm bg-secondary text-on-secondary px-6 py-3 rounded-lg hover:bg-secondary/90 transition-colors">
            <span class="material-symbols-outlined text-[18px]">refresh</span> Retry
          </button>
          <a href="mailto:support@blackstack.com" class="flex items-center gap-stack-sm border border-outline-variant text-on-surface px-6 py-3 rounded-lg hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined text-[18px]">mail</span> Contact Support
          </a>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-stack-md">Error ID: <span class="font-code">ERR-${Date.now().toString(36).toUpperCase()}</span></p>
      </div>
    `;
    document.getElementById('retry-btn').addEventListener('click', () => {
      this.retryCount++;
      Toast.info('Retrying...');
      setTimeout(() => { window.location.hash = 'dashboard'; }, 800);
    });
    return () => {};
  },
};
