/**
 * ErrorState — consistent error UI for failed API/database loads.
 * Never shows fake/mock data. Shows a retry action when provided.
 */
window.ErrorState = {
  render(container, retryFn, message) {
    if (!container) return;
    container.innerHTML = `
      <div class="p-12 text-center flex flex-col items-center gap-3">
        <span class="material-symbols-outlined text-[40px] text-error">cloud_off</span>
        <p class="font-body-md text-body-md text-on-surface-variant">${message || 'Unable to load data from server/database.'}</p>
        ${retryFn ? '<button id="error-retry" class="mt-2 px-4 py-2 rounded-lg bg-secondary text-on-secondary hover:bg-secondary/90 text-body-sm">Retry</button>' : ''}
      </div>`;
    const btn = container.querySelector('#error-retry');
    if (btn && retryFn) btn.addEventListener('click', () => { container.innerHTML = '<div class="p-12 text-center"><span class="material-symbols-outlined text-[32px] animate-spin text-on-surface-variant">progress_activity</span></div>'; retryFn(); });
  },
};
