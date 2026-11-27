(function () {
  'use strict';

  // ── DOM elements ──
  const loginForm = document.getElementById('login-form');
  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const togglePasswordBtn = document.getElementById('toggle-password');
  const errorContainer = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  // Version & update elements
  const appVersionEl = document.getElementById('login-app-version');
  const checkUpdateBtn = document.getElementById('login-check-update');
  const channelRadios = document.querySelectorAll('input[name="login-update-channel"]');
  const updateSection = document.getElementById('login-update-section');
  const updateStatus = document.getElementById('login-update-status');
  const updateNone = document.getElementById('login-update-none');
  const updateChecking = document.getElementById('login-update-checking');
  const updateHeader = document.getElementById('login-update-header');
  const channelBadge = document.getElementById('login-update-channel-badge');
  const currentVersionEl = document.getElementById('login-update-current');
  const availableVersionEl = document.getElementById('login-update-available');
  const updateDescriptionEl = document.getElementById('login-update-description');
  const updateNowBtn = document.getElementById('login-update-now');
  const updateLaterBtn = document.getElementById('login-update-later');
  const updateProgress = document.getElementById('login-update-progress');
  const updateProgressBar = document.getElementById('login-update-progress-bar');
  const updatePercentEl = document.getElementById('login-update-percent');
  const updateProgressTextEl = document.getElementById('login-update-progress-text');
  const updateError = document.getElementById('login-update-error');
  const updateErrorMessageEl = document.getElementById('login-update-error-message');
  const updateNoneVersionEl = document.getElementById('login-update-none-version');

  if (!loginForm) return;

  // ── Desktop API availability ──
  const hasDesktop = typeof window.desktop !== 'undefined' && typeof window.desktop.getAppInfo === 'function';

  // ── Helpers ──
  function showError(message) {
    if (!errorContainer) return;
    errorContainer.innerHTML = `
      <div class="flex items-center gap-2 text-error font-body-sm text-body-sm">
        <span class="material-symbols-outlined text-[18px]">error</span>
        <span>${message}</span>
      </div>
    `;
    errorContainer.classList.remove('hidden');
  }

  function hideError() {
    if (errorContainer) {
      errorContainer.classList.add('hidden');
      errorContainer.innerHTML = '';
    }
  }

  function setLoading(loading) {
    if (!submitBtn) return;
    submitBtn.disabled = loading;
    submitBtn.innerHTML = loading
      ? '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Signing in...'
      : '<span class="material-symbols-outlined text-[18px]">login</span> Sign in';
  }

  function parseVersion(v) {
    const parts = String(v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  }

  function isNewer(candidate, current) {
    const A = parseVersion(candidate);
    const B = parseVersion(current);
    for (const key of ['major', 'minor', 'patch']) {
      if (A[key] !== B[key]) return A[key] > B[key];
    }
    return false;
  }

  function formatVersion(v) {
    return v && v !== '0.0.0' ? `v${v}` : 'v—';
  }

  function setChannelLabel(channel) {
    if (channelBadge) {
      const isPre = channel === 'beta';
      channelBadge.textContent = isPre ? 'Pre-release' : 'Stable';
      channelBadge.className = `px-1.5 py-0.5 rounded text-[10px] font-label-md ${
        isPre ? 'bg-secondary-fixed text-on-secondary-fixed' : 'bg-primary-fixed text-on-primary-fixed'
      }`;
    }
  }

  // ── Update UI state machine ──
  function renderUpdateState(state) {
    const status = state.status || 'IDLE';
    const current = state.currentVersion || null;
    const target = state.targetVersion || null;
    const percent = state.percent;
    const error = state.error;

    // Hide all sub-panels first
    updateStatus.classList.add('hidden');
    updateNone.classList.add('hidden');
    updateChecking.classList.add('hidden');
    updateProgress.classList.add('hidden');
    updateError.classList.add('hidden');

    if (status === 'CHECKING') {
      updateChecking.classList.remove('hidden');
      if (checkUpdateBtn) checkUpdateBtn.disabled = true;
    } else if (status === 'AVAILABLE') {
      updateStatus.classList.remove('hidden');
      if (updateHeader) updateHeader.firstElementChild.textContent = 'Update available';
      if (currentVersionEl) currentVersionEl.textContent = formatVersion(current);
      if (availableVersionEl) availableVersionEl.textContent = formatVersion(target);
      if (updateDescriptionEl) updateDescriptionEl.textContent = 'A new version of BlackStack CRM is available.';
      updateNowBtn.disabled = false;
      updateLaterBtn.disabled = false;
      if (checkUpdateBtn) checkUpdateBtn.disabled = false;
    } else if (status === 'READY' || status === 'POSTPONED') {
      updateStatus.classList.remove('hidden');
      if (updateHeader) updateHeader.firstElementChild.textContent = 'Update ready';
      if (currentVersionEl) currentVersionEl.textContent = formatVersion(current);
      if (availableVersionEl) availableVersionEl.textContent = formatVersion(target);
      if (updateDescriptionEl) updateDescriptionEl.textContent = 'The update has been downloaded and is ready to install.';
      updateNowBtn.disabled = false;
      updateLaterBtn.disabled = true;
      if (checkUpdateBtn) checkUpdateBtn.disabled = false;
    } else if (status === 'DOWNLOADING') {
      updateStatus.classList.remove('hidden');
      updateProgress.classList.remove('hidden');
      if (updateHeader) updateHeader.firstElementChild.textContent = 'Downloading update';
      if (currentVersionEl) currentVersionEl.textContent = formatVersion(current);
      if (availableVersionEl) availableVersionEl.textContent = formatVersion(target);
      if (updateDescriptionEl) updateDescriptionEl.textContent = '';
      if (updatePercentEl) updatePercentEl.textContent = (percent != null ? percent : 0) + '%';
      if (updateProgressBar) updateProgressBar.style.width = (percent != null ? percent : 0) + '%';
      if (updateProgressTextEl) updateProgressTextEl.textContent = 'Downloading update…';
      updateNowBtn.disabled = true;
      updateLaterBtn.disabled = true;
      if (checkUpdateBtn) checkUpdateBtn.disabled = false;
    } else if (status === 'UP_TO_DATE') {
      updateNone.classList.remove('hidden');
      if (updateNoneVersionEl) updateNoneVersionEl.textContent = formatVersion(current);
      if (checkUpdateBtn) checkUpdateBtn.disabled = false;
    } else if (status === 'ERROR' || status === 'OFFLINE') {
      updateError.classList.remove('hidden');
      if (updateErrorMessageEl) updateErrorMessageEl.textContent = error || 'Update check failed.';
      if (checkUpdateBtn) checkUpdateBtn.disabled = false;
    } else {
      // IDLE or unknown — nothing to show yet
      if (checkUpdateBtn) checkUpdateBtn.disabled = false;
    }
  }

  // ── Version display ──
  async function loadAppVersion() {
    if (!hasDesktop) {
      if (appVersionEl) appVersionEl.textContent = 'BlackStack CRM (dev)';
      return;
    }
    try {
      const info = await window.desktop.getAppInfo();
      if (info && info.version) {
        const v = formatVersion(info.version);
        if (appVersionEl) appVersionEl.textContent = `BlackStack CRM ${v}`;
        if (currentVersionEl) currentVersionEl.textContent = v;
        if (updateNoneVersionEl) updateNoneVersionEl.textContent = v;
      } else {
        if (appVersionEl) appVersionEl.textContent = 'BlackStack CRM';
      }
    } catch (e) {
      if (appVersionEl) appVersionEl.textContent = 'BlackStack CRM';
    }
  }

  async function loadUpdateState() {
    if (!hasDesktop) return;
    try {
      const result = await window.desktop.getUpdateState();
      if (result.ok && result.state) {
        renderUpdateState(result.state);
      }
    } catch { /* ignore — state will be set by event stream */ }
  }

  async function loadChannel() {
    if (!hasDesktop) return;
    try {
      const result = await window.desktop.getChannel();
      if (result.ok && result.channel) {
        const isPre = result.channel === 'beta';
        const radio = document.querySelector(`input[name="login-update-channel"][value="${isPre ? 'beta' : 'stable'}"]`);
        if (radio) radio.checked = true;
        setChannelLabel(result.channel);
      }
    } catch { /* default stable */ }
  }

  // ── Update actions ──
  async function checkForUpdates() {
    if (!hasDesktop) return;
    hideError();
    renderUpdateState({ status: 'CHECKING' });
    try {
      await window.desktop.checkForUpdate();
      // State will arrive via onUpdateStatus event
    } catch (e) {
      renderUpdateState({ status: 'ERROR', error: String(e && e.message || e) });
    }
  }

  async function startDownload() {
    if (!hasDesktop) return;
    hideError();
    try {
      const result = await window.desktop.startDownload();
      if (!result.ok) {
        renderUpdateState({ status: 'ERROR', error: result.message || 'Failed to start download' });
      }
      // Progress arrives via onUpdateStatus
    } catch (e) {
      renderUpdateState({ status: 'ERROR', error: String(e && e.message || e) });
    }
  }

  async function postponeUpdate() {
    if (!hasDesktop) return;
    hideError();
    try {
      await window.desktop.postponeUpdate();
      renderUpdateState({ status: 'POSTPONED' });
    } catch (e) {
      renderUpdateState({ status: 'ERROR', error: String(e && e.message || e) });
    }
  }

  async function installUpdate() {
    if (!hasDesktop) return;
    hideError();
    try {
      const result = await window.desktop.installUpdate();
      if (!result.ok) {
        renderUpdateState({ status: 'ERROR', error: result.message || 'Failed to install update' });
      }
      // State changes handled by main process events
    } catch (e) {
      renderUpdateState({ status: 'ERROR', error: String(e && e.message || e) });
    }
  }

  async function setChannel(channel) {
    if (!hasDesktop) return;
    try {
      const result = await window.desktop.setChannel(channel);
      if (result.ok) {
        setChannelLabel(result.channel);
        // Do NOT auto-check — user must explicitly check after switching
        renderUpdateState({ status: 'IDLE' });
      } else {
        showError(result.message || 'Failed to switch update channel');
      }
    } catch (e) {
      showError(String(e && e.message || e));
    }
  }

  // ── Event listeners ──
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      checkForUpdates();
    });
  }

  channelRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      setChannel(e.target.value);
    });
  });

  if (updateNowBtn) {
    updateNowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      startDownload();
    });
  }

  if (updateLaterBtn) {
    updateLaterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      postponeUpdate();
    });
  }

  // ── Listen for real-time update status from main process ──
  if (hasDesktop && typeof window.desktop.onUpdateStatus === 'function') {
    window.desktop.onUpdateStatus((data) => {
      renderUpdateState(data);
    });
  }

  // ── Login form ──
  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener('click', () => {
      const type = passwordInput.type === 'password' ? 'text' : 'password';
      passwordInput.type = type;
      togglePasswordBtn.querySelector('.material-symbols-outlined').textContent = type === 'password' ? 'visibility_off' : 'visibility';
    });
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const { value: cleanEmail } = getCleanEmail();
    emailInput.value = cleanEmail;

    if (!cleanEmail || !passwordInput.value) {
      showError('Please enter both email and password.');
      return;
    }
    if (!EMAIL_RE.test(cleanEmail)) {
      showError('Please enter a valid email address (e.g., name@example.com).');
      emailInput.classList.add('border-error');
      emailInput.focus();
      return;
    }
    const password = passwordInput.value;

    setLoading(true);
    hideError();

    try {
      await AuthAPI.login(cleanEmail, password);
      const urlRedirect = new URLSearchParams(window.location.search).get('redirect');
      const intended = (urlRedirect && urlRedirect.startsWith('/')) ? urlRedirect
        : (urlRedirect && /^https?:\/\//.test(urlRedirect)) ? urlRedirect
        : sessionStorage.getItem('redirectAfterLogin') || '/index.html#dashboard';
      sessionStorage.removeItem('redirectAfterLogin');
      window.location.href = intended;
    } catch (err) {
      showError(err.message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  });

  // ── Email sanitization ──
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const emailNotice = document.getElementById('login-email-notice');
  if (window.EmailSanitizer && emailInput) {
    window.EmailSanitizer.attachEmailSanitizer(emailInput, { noticeEl: emailNotice, errorEl: errorContainer });
  }
  const getCleanEmail = () => {
    const s = window.EmailSanitizer
      ? window.EmailSanitizer.sanitizeEmailValue(emailInput.value)
      : { value: emailInput.value.trim(), stripped: false };
    return s;
  };

  // ── Login page protection ──
  (async function ensureCorrectAuthState() {
    try {
      const user = await AuthAPI.validateSession();
      if (user) {
        const redirect = sessionStorage.getItem('redirectAfterLogin') || '/index.html#dashboard';
        sessionStorage.removeItem('redirectAfterLogin');
        window.location.href = redirect;
        return;
      }
    } catch {
      // validateSession() already clears stale state on failure
    }
    try {
      const reason = new URLSearchParams(window.location.search).get('reason');
      if (reason) {
        localStorage.removeItem('crm_token');
        localStorage.removeItem('crm_user');
        showError(decodeURIComponent(reason));
      }
    } catch { /* ignore malformed query strings */ }
  })();

  // ── Initialize update section ──
  (async function initUpdates() {
    await loadAppVersion();
    if (hasDesktop) {
      await loadChannel();
      await loadUpdateState();
    } else {
      // No desktop API — hide the update section entirely
      if (updateSection) updateSection.style.display = 'none';
    }
  })();

})();
