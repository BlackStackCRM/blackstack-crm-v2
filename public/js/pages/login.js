(function () {
  'use strict';

  const loginForm = document.getElementById('login-form');
  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const togglePasswordBtn = document.getElementById('toggle-password');
  const errorContainer = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  if (!loginForm) return;

  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener('click', () => {
      const type = passwordInput.type === 'password' ? 'text' : 'password';
      passwordInput.type = type;
      togglePasswordBtn.querySelector('.material-symbols-outlined').textContent = type === 'password' ? 'visibility_off' : 'visibility';
    });
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!loginForm.checkValidity()) {
      loginForm.reportValidity();
      return;
    }

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    hideError();

    try {
      await AuthAPI.login(email, password);
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
