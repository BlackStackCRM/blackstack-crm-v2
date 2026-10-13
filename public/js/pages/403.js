window.PageModules = window.PageModules || {};

window.PageModules['403'] = {
  init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <div class="relative">
          <div class="w-32 h-32 rounded-full bg-error-container/30 flex items-center justify-center">
            <span class="material-symbols-outlined text-[64px] text-error">block</span>
          </div>
          <div class="absolute -bottom-2 -right-2 w-12 h-12 rounded-full bg-error flex items-center justify-center text-on-error font-display text-h1">403</div>
        </div>
        <h1 class="font-display text-h1 text-on-surface tracking-tight mt-stack-lg">Access Denied</h1>
        <p class="font-body-md text-body-md text-on-surface-variant mt-2 max-w-md">You don't have permission to access this page or resource. Please contact your administrator if you believe this is a mistake.</p>
        <a href="#dashboard" class="mt-stack-md flex items-center gap-stack-sm bg-secondary text-on-secondary px-6 py-3 rounded-lg hover:bg-secondary/90 transition-colors">
          <span class="material-symbols-outlined text-[18px]">arrow_back</span> Back to Dashboard
        </a>
      </div>
    `;
    return () => {};
  },
};
