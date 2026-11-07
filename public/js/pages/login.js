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

  // ── First-user setup detection ────────────────────────────────────────
  // The auth page asks the BACKEND whether the real user store is empty.
  // mode 'setup'  -> swap the login form for the Create First User form.
  // mode 'login'  -> keep the normal login page.
  // 503/retry     -> show an error + retry button; never assume empty.
  // Any client-side caching, localStorage flags or hardcoded counts are
  // never consulted — the server's answer is the only source of truth.
  (async function detectSetupMode() {
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
    let status;
    try {
      const r = await fetch('/api/auth/setup-status');
      if (r.status === 503) {
        showStoreError('Cannot verify the user store right now.');
        return;
      }
      status = (await r.json())?.data;
    } catch {
      showStoreError('Cannot reach the server to verify setup state.');
      return;
    }
    if (status && status.mode === 'setup' && status.userCount === 0) {
      showFirstUserForm();
    }
  })();

  function showStoreError(message) {
    if (!errorContainer) return;
    errorContainer.innerHTML = `
      <div class="flex flex-col gap-2 text-error font-body-sm text-body-sm">
        <div class="flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">error</span><span>${message}</span></div>
        <button type="button" id="retry-setup-check" class="self-start px-3 py-1.5 rounded-lg border border-outline-variant hover:bg-surface-container">Retry</button>
      </div>
    `;
    errorContainer.classList.remove('hidden');
    document.getElementById('retry-setup-check')?.addEventListener('click', () => window.location.reload());
    if (submitBtn) submitBtn.disabled = true; // don't log in until verified
  }

  function showFirstUserForm() {
    setupMode = true;
    const heading = document.querySelector('h1');
    const sub = heading?.nextElementSibling;
    if (heading) heading.textContent = 'Create First User';
    if (sub) sub.textContent = 'Set up the System Administrator account';

    loginForm.innerHTML = `
      <div>
        <label for="login-email" class="block font-label-md text-label-md text-on-surface mb-1">Full name</label>
        <input type="text" id="setup-fullname" name="full_name" required autocomplete="name" class="w-full bg-surface-container-low py-2.5 px-3 rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40 transition-shadow" placeholder="Your full name"/>
      </div>
      <div>
        <label for="login-email" class="block font-label-md text-label-md text-on-surface mb-1">Email</label>
        <input type="email" id="login-email" name="email" required autocomplete="email" class="w-full bg-surface-container-low py-2.5 px-3 rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40 placeholder:text-on-surface-variant/70 transition-shadow" placeholder="you@company.com"/>
      </div>
      <div>
        <label for="login-password" class="block font-label-md text-label-md text-on-surface mb-1">Password</label>
        <input type="password" id="login-password" name="password" required minlength="8" autocomplete="new-password" class="w-full bg-surface-container-low py-2.5 px-3 rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40 transition-shadow" placeholder="At least 8 characters"/>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Minimum 8 characters with uppercase, lowercase and a number.</p>
      </div>
      <div>
        <label for="setup-confirm-password" class="block font-label-md text-label-md text-on-surface mb-1">Confirm password</label>
        <input type="password" id="setup-confirm-password" name="confirm_password" required autocomplete="new-password" class="w-full bg-surface-container-low py-2.5 px-3 rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/40 transition-shadow" placeholder="Repeat the password"/>
      </div>
      <div id="login-error" class="hidden"></div>
      <button type="submit" id="login-submit" class="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-on-primary font-label-md text-label-md uppercase tracking-wider hover:bg-primary/90 transition-colors shadow-sm">
        <span class="material-symbols-outlined text-[18px]">person_add</span>
        Create First User
      </button>
    `;

    // Re-bind (the form was replaced).
    const errBox = document.getElementById('login-error');
    const newEmail = document.getElementById('login-email');
    const newSubmit = document.getElementById('login-submit');

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fullName = document.getElementById('setup-fullname').value.trim();
      const email = newEmail.value.trim();
      const password = document.getElementById('login-password').value;
      const confirm = document.getElementById('setup-confirm-password').value;

      if (!fullName || !email || !password || !confirm) { showError('All fields are required.'); return; }
      if (password !== confirm) { showError('Passwords do not match.'); return; }
      if (password.length < 8) { showError('Password must be at least 8 characters.'); return; }

      newSubmit.disabled = true;
      newSubmit.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Creating…';
      hideError();
      try {
        const r = await fetch('/api/auth/setup/first-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_name: fullName, email, password, confirm_password: confirm }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          // 409 = someone else created the first account — fall back to login.
          showError(body?.error?.message || 'Setup failed.');
          if (r.status === 409) setTimeout(() => window.location.reload(), 2500);
          newSubmit.disabled = false;
          newSubmit.innerHTML = '<span class="material-symbols-outlined text-[18px]">person_add</span> Create First User';
          return;
        }
        // Secure authenticated session (same shape as login).
        const data = body?.data || {};
        if (data.token) {
          try {
            // WARNING: Stored in localStorage. If an XSS vulnerability occurs, the token can be stolen.
            // Future refactor must use HttpOnly cookies.
            localStorage.setItem('crm_token', data.token);
            localStorage.setItem('crm_user', JSON.stringify(data.user || {}));
          } catch { /* storage unavailable — session still valid server-side */ }
        }
        window.location.href = '/index.html#dashboard';
      } catch {
        showError('Network error — please try again.');
        newSubmit.disabled = false;
        newSubmit.innerHTML = '<span class="material-symbols-outlined text-[18px]">person_add</span> Create First User';
      }
    });
  }

  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener('click', () => {
      const type = passwordInput.type === 'password' ? 'text' : 'password';
      passwordInput.type = type;
      togglePasswordBtn.querySelector('.material-symbols-outlined').textContent = type === 'password' ? 'visibility_off' : 'visibility';
    });
  }

  // Mode flag: when the first-user setup form is active, the login handler
  // must not run (both listeners are attached to the same form element).
  let setupMode = false;

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (setupMode) return; // handled by the setup listener

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
