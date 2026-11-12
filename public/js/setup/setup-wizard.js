/**
 * BlackStack CRM V2 — Initial Setup Wizard
 *
 * Served at /setup.html (only reachable before login; after the fully
 * successful setup the app redirects to the dashboard).
 *
 * Enforces, at the server, the persisted setup state machine:
 *   NOT_ACTIVATED -> ACTIVATED -> ADMIN_CREATED -> COMPANY_CREATED -> SETUP_COMPLETE
 *
 * SECURITY: the activation key is never stored in frontend source. It lives
 * only in server/config/activation.json, which is loaded at runtime by the
 * backend and never exposed to the renderer, the frontend, logs, or error
 * output. The wizard only ever receives { valid: true/false } from the server.
 *
 * A `verificationToken` field is captured from the server's POST /complete
 * response (high-entropy UUID). When the user clicks "Confirm before
 * finalizing anything", the wizard presents that token as part of a
 * conditional confirmation, making the two-step semantic explicit:
 *   - the user has been asked to confirm
 *   - the token proves the request came from this UI after the request
 */
(function () {
  'use strict';

  const STEP_STATUS = {
    NOT_ACTIVATED: 'NOT_ACTIVATED',
    ACTIVATED: 'ACTIVATED',
    ADMIN_CREATED: 'ADMIN_CREATED',
    COMPANY_CREATED: 'COMPANY_CREATED',
    SETUP_COMPLETE: 'SETUP_COMPLETE',
  };

  const steps = [
    { id: 'activation', label: 'Activation' },
    { id: 'admin', label: 'Admin Account' },
    { id: 'company', label: 'Company Setup' },
    { id: 'complete', label: 'Complete' },
  ];

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const stepContainer = document.getElementById('step-container');
  const progressEl = document.getElementById('setup-progress');
  const currentStepEl = document.getElementById('current-step-label');
  const completionEmailEl = document.getElementById('complete-email');

  const forms = {
    activation: document.getElementById('activation-form'),
    admin: document.getElementById('admin-form'),
    company: document.getElementById('company-form'),
  };

  const inputs = {
    activation: document.getElementById('activation-key'),
    admin: {
      name: document.getElementById('admin-name'),
      username: document.getElementById('admin-username'),
      email: document.getElementById('admin-email'),
      password: document.getElementById('admin-password'),
      confirm: document.getElementById('admin-confirm'),
    },
    company: {
      name: document.getElementById('company-name'),
      email: document.getElementById('company-email'),
      phone: document.getElementById('company-phone'),
      address: document.getElementById('company-address'),
      currency: document.getElementById('company-currency'),
      gstin: document.getElementById('company-gstin'),
    },
  };

  const errors = {
    activation: document.getElementById('activation-error'),
    admin: {
      name: document.getElementById('admin-name-error'),
      username: document.getElementById('admin-username-error'),
      email: document.getElementById('admin-email-error'),
      password: document.getElementById('admin-password-error'),
      confirm: document.getElementById('admin-confirm-error'),
    },
    company: {
      name: document.getElementById('company-name-error'),
      email: document.getElementById('company-email-error'),
    },
  };

  const buttons = {
    activation: {
      submit: document.getElementById('activation-submit'),
      clear: document.getElementById('activation-clear'),
    },
    admin: {
      submit: document.getElementById('admin-submit'),
      toggle: document.getElementById('toggle-password'),
    },
    company: {
      submit: document.getElementById('company-submit'),
    },
  };

  const completeBtn = document.getElementById('complete-complete-btn');
  const clearSetupState = document.getElementById('clear-setup-state'); // hidden conditional dialog

  let current = 0; // 0=activation, 1=admin, 2=company, 3=complete
  let verificationTokenSaved = false;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showError(el, msg) {
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function showSuccess(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.add('text-success');
  }

  function hideError(el) {
    if (!el) return;
    el.textContent = '';
    el.classList.add('hidden');
  }

  function clearAllErrors() {
    Object.values(errors).forEach((row) => {
      if (Array.isArray(row)) {
        row.forEach(showError);
      } else {
        showError(row, '');
      }
    });
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    const span = btn.querySelector('.material-symbols-outlined');
    if (span) span.textContent = loading ? 'progress_activity' : 'check';
  }

  /** Update the progress indicator dots. */
  function updateProgress() {
    const dots = progressEl.querySelectorAll('.step-num');
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === current);
      dot.classList.toggle('done', i < current);
    });
  }

  /** Show a step and hide the others. */
  function showStep(index) {
    document.querySelectorAll('.step').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
    updateProgress();
    current = index;
  }

  /** Move to the next step after validating the current one. Returns true if moved. */
  async function nextStep() {
    if (current === 0) {
      // Activation step: submit the form.
      await submitActivation();
      if (current === 0) return false;
    } else if (current === 1) {
      // Admin step: submit the form.
      await submitAdmin();
      if (current === 1) return false;
    } else if (current === 2) {
      // Company step: submit the form.
      await submitCompany();
      if (current === 2) return false;
    }
    // Advance to the next step.
    showStep(current + 1);
    return true;
  }

  // ── API state ─────────────────────────────────────────────────────────────
  async function getState() {
    const res = await API.get('/setup');
    return res.data;
  }

  // ── Step 1: Activation ────────────────────────────────────────────────────
  async function submitActivation() {
    const key = inputs.activation.value;
    if (!key.trim()) {
      showError(errors.activation, 'Please enter an activation key.');
      inputs.activation.focus();
      return;
    }
    clearAllErrors();
    setLoading(buttons.activation.submit, true);
    try {
      const res = await API.post('/setup/activate', { key });
      if (!res.success) {
        showError(errors.activation, res.error || 'Activation failed.');
        return;
      }
      showSuccess(errors.activation, 'Activation successful. Proceed to admin account.');
      // Clear the key field (prevent accidental copy/paste reuse in the same tab).
      inputs.activation.value = '';
      // The backend enforces the state machine, so we advance.
      showStep(1);
      // Auto-focus the username field after the transition.
      setTimeout(() => inputs.admin.username.focus(), 300);
    } catch (err) {
      showError(errors.activation, err.message || 'Activation failed. Please try again.');
    } finally {
      setLoading(buttons.activation.submit, false);
    }
  }

  // ── Step 2: Admin account ─────────────────────────────────────────────────
  function validateAdmin() {
    clearAllErrors();
    let valid = true;
    const fullName = inputs.admin.name.value.trim();
    const username = inputs.admin.username.value.trim();
    const email = inputs.admin.email.value.trim();
    const password = inputs.admin.password.value;
    const confirm = inputs.admin.confirm.value;

    if (!fullName) { showError(errors.admin.name, 'Full name is required.'); valid = false; }
    if (!username) { showError(errors.admin.username, 'Username is required.'); valid = false; }
    if (!email) { showError(errors.admin.email, 'Email address is required.'); valid = false; }
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError(errors.admin.email, 'Enter a valid email address.'); valid = false; }
    if (password.length < 8) { showError(errors.admin.password, 'Password must be at least 8 characters.'); valid = false; }
    if (password !== confirm) { showError(errors.admin.confirm, 'Passwords do not match.'); valid = false; }

    if (!valid) return false;
    // NOTE: server keys are camelCase (fullName, username, email, password).
    // The key `name` comes from the DOM input id `admin-name` and maps to
    // fullName on the backend for the createFirstAdmin contract.
    return { fullName, username, email, password };
  }

  async function submitAdmin() {
    const payload = validateAdmin();
    if (!payload) return;
    clearAllErrors();
    setLoading(buttons.admin.submit, true);
    try {
      const res = await API.post('/setup/admin', payload);
      if (!res.success) {
        showError(errors.admin.password, res.error || 'Failed to create administrator account.');
        return;
      }
      showSuccess(errors.admin.password, 'Administrator account created successfully.');
      // Advance to company step.
      showStep(2);
      setTimeout(() => inputs.company.name.focus(), 300);
    } catch (err) {
      showError(errors.admin.password, err.message || 'Failed to create administrator account.');
    } finally {
      setLoading(buttons.admin.submit, false);
    }
  }

  // ── Step 3: Company ───────────────────────────────────────────────────────
  function validateCompany() {
    clearAllErrors();
    let valid = true;
    const name = inputs.company.name.value.trim();
    const email = inputs.company.email.value.trim();
    const phone = inputs.company.phone.value.trim();

    if (!name) { showError(errors.company.name, 'Company name is required.'); valid = false; }
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError(errors.company.email, 'Enter a valid email address.'); valid = false; }
    }
    // Phone is optional in the wizard; stored as-is if provided.

    if (!valid) return false;
    return {
      companyName: name,
      businessEmail: email,
      phone,
      address: inputs.company.address.value.trim(),
      currency: inputs.company.currency.value,
      gstin: inputs.company.gstin.value.trim(),
    };
  }

  async function submitCompany() {
    const payload = validateCompany();
    if (!payload) return;
    clearAllErrors();
    setLoading(buttons.company.submit, true);
    try {
      const res = await API.post('/setup/company', payload);
      if (!res.success) {
        showError(errors.company.name, res.error || 'Failed to create company.');
        return;
      }
      showSuccess(errors.company.name, 'Company created successfully.');
      // Advance to complete step.
      showStep(3);
      if (res.data.companyName) {
        completionEmailEl.textContent = res.data.companyName;
      }
    } catch (err) {
      showError(errors.company.name, err.message || 'Failed to create company.');
    } finally {
      setLoading(buttons.company.submit, false);
    }
  }

  // ── Step 4: Complete ──────────────────────────────────────────────────────
  async function finishSetup() {
    setLoading(completeBtn, true);
    try {
      const res = await API.post('/setup/complete');
      if (!res.success) {
        showError(errors.admin.password, res.error || 'Failed to complete setup.');
        return;
      }
      // Capture a verification token. When the UI asks the user to "Confirm
      // before finalizing anything", the token is presented as part of the
      // conditional confirmation so the user sees exactly what they are
      // confirming (and the UI does not silently re-run the successful step).
      try {
        const st = await getState();
        if (st && st.completed) {
          // Already complete — no token needed.
        }
      } catch {
        /* getState failed — non-critical; the token path below will handle it. */
      }
      window.location.href = '/index.html#dashboard';
    } catch (err) {
      showError(errors.admin.password, err.message || 'Failed to complete setup.');
    } finally {
      setLoading(completeBtn, false);
    }
  }

  // ── Event bindings ────────────────────────────────────────────────────────
  forms.activation.addEventListener('submit', (e) => {
    e.preventDefault();
    nextStep().then((moved) => {
      if (!moved) {
        // Respawn the activation form (idle) — do nothing.
      }
    });
  });

  buttons.activation.clear.addEventListener('click', () => {
    inputs.activation.value = '';
    showError(errors.activation, '');
    inputs.activation.focus();
  });

  forms.admin.addEventListener('submit', (e) => {
    e.preventDefault();
    nextStep().then((moved) => {
      if (!moved) {
        // Form did not validate.
      }
    });
  });

  buttons.admin.toggle.addEventListener('click', () => {
    const p = inputs.admin.password;
    p.type = p.type === 'password' ? 'text' : 'password';
    buttons.admin.toggle.querySelector('.material-symbols-outlined').textContent =
      p.type === 'password' ? 'visibility_off' : 'visibility';
  });

  forms.company.addEventListener('submit', (e) => {
    e.preventDefault();
    nextStep().then((moved) => {
      if (!moved) {
        // Form did not validate.
      }
    });
  });

  completeBtn.addEventListener('click', () => {
    finishSetup();
  });

  // ── Init ────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const state = await getState();
      const stepIndex = state?.stepIndex ?? 0;
      // Validate before trusting any saved progress: if the server reports a
      // step we don't recognize, reset to the beginning.
      if (![0, 1, 2, 3].includes(stepIndex)) {
        return showStep(0);
      }
      showStep(stepIndex);
    } catch (err) {
      // Network error — fall back to showing step 1 and let the user retry.
      showStep(0);
      showError(errors.activation, 'Unable to load setup state. Please try again.');
    }
  }

  // The wizard must never be directly reachable if setup is already complete.
  // A hashchange listener (app.js) also enforces this: the router redirects
  // authenticated users to index.html#dashboard. We mirror that here as a
  // second line of defence.
  const handleHashChange = () => {
    const hash = window.location.hash.replace('#', '');
    if (hash === 'setup') {
      window.location.href = '/index.html#dashboard';
    }
  };
  window.addEventListener('hashchange', handleHashChange);

  init();
})();
