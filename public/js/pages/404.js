window.PageModules = window.PageModules || {};

window.PageModules['404'] = {
  init() {
    const main = document.getElementById('page-container');
    if (!main) return () => {};
    main.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <svg class="w-48 h-48 mb-stack-md" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="100" cy="100" r="80" fill="#f1edec"/>
          <text x="100" y="115" text-anchor="middle" font-size="64" font-weight="700" fill="#0058be" font-family="Inter, sans-serif">404</text>
          <circle cx="60" cy="60" r="6" fill="#0058be" opacity="0.3"/>
          <circle cx="150" cy="50" r="4" fill="#0058be" opacity="0.5"/>
          <circle cx="40" cy="140" r="5" fill="#0058be" opacity="0.4"/>
          <circle cx="170" cy="150" r="7" fill="#0058be" opacity="0.3"/>
        </svg>
        <h1 class="font-display text-h1 text-on-surface tracking-tight mt-stack-md">Page Not Found</h1>
        <p class="font-body-md text-body-md text-on-surface-variant mt-2 max-w-md">The page you are looking for doesn't exist or has been moved. Check the URL or head back to your dashboard.</p>
        <a href="#dashboard" class="mt-stack-md flex items-center gap-stack-sm bg-secondary text-on-secondary px-6 py-3 rounded-lg hover:bg-secondary/90 transition-colors">
          <span class="material-symbols-outlined text-[18px]">arrow_back</span> Back to Dashboard
        </a>
      </div>
    `;
    return () => {};
  },
};
