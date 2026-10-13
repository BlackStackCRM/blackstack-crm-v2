window.PageModules = window.PageModules || {};

window.PageModules['401'] = {
  init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <div class="w-32 h-32 rounded-full bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-[64px] text-secondary">lock_clock</span>
        </div>
        <h1 class="font-display text-h1 text-on-surface tracking-tight mt-stack-lg">Session Expired</h1>
        <p class="font-body-md text-body-md text-on-surface-variant mt-2 max-w-md">Your session has ended for security reasons. Please log in again to continue working.</p>
        <a href="/login.html" class="mt-stack-md flex items-center gap-stack-sm bg-secondary text-on-secondary px-6 py-3 rounded-lg hover:bg-secondary/90 transition-colors">
          <span class="material-symbols-outlined text-[18px]">login</span> Login
        </a>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-stack-md">Need help? <a href="mailto:support@blackstack.com" class="text-secondary hover:underline">Contact support</a></p>
      </div>
    `;
    return () => {};
  },
};
