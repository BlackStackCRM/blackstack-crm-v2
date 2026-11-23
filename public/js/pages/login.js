(function () {
  'use strict';

  const loginForm = document.getElementById('login-form');
  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const togglePasswordBtn = document.getElementById('toggle-password');
  const errorContainer = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  if (!loginForm) return;

  // ── Email input sanitization ────────────────────────────────────────────
  // Users paste values like "Email: name@example.com" or
  // "Username: name@example.com"; type=email then fails HTML5 validation
  // with the cryptic "A part followed by '@' should not contain the symbol
  // ':'". Sanitize on blur/paste and validate with a custom inline message
  // before submit — the browser tooltip never appears.
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

  // ── Login page protection ────────────────────────────────────────────────
  // If the user already has a valid server-verified session, redirect to the
  // dashboard instead of showing the login screen. A stale/invalid token is
  // cleared so the login form appears.
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

    // FIX (stale-permission recovery): if we were redirected here by the API
    // interceptor (401/403 after a server-side permission fix), show WHY so
    // the user understands the re-login instead of a silent bounce.
    try {
      const reason = new URLSearchParams(window.location.search).get('reason');
      if (reason) {
        localStorage.removeItem('crm_token');
        localStorage.removeItem('crm_user');
        showError(decodeURIComponent(reason));
      }
    } catch { /* ignore malformed query strings */ }
  })();

  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener('click', () => {
      const type = passwordInput.type === 'password' ? 'text' : 'password';
      passwordInput.type = type;
      togglePasswordBtn.querySelector('.material-symbols-outlined').textContent = type === 'password' ? 'visibility_off' : 'visibility';
    });
  }

  // Local setup mode no longer exists — the login handler always runs.

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Sanitize FIRST (strip pasted "Email:" / "Username:" prefixes etc.),
    // then validate with a helpful inline message — the raw browser tooltip
    // ("A part followed by '@' should not contain the symbol ':'") never
    // appears because checkValidity() is bypassed via novalidate.
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
      // Support redirecting back to the originally requested page (e.g. the
      // Server UI dashboard) after a successful CRM login.
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
})();
