const API_BASE = '/api';
let isSubscriptionModalOpen = false;
let subscriptionModalSnoozed = false;
let subscriptionReturnHash = null;

function showSubscriptionModal() {
  if (isSubscriptionModalOpen || subscriptionModalSnoozed || typeof document === 'undefined') return;
  isSubscriptionModalOpen = true;
  subscriptionReturnHash = window.location.hash && window.location.hash !== '#wallet'
    ? window.location.hash : (subscriptionReturnHash || '#dashboard');
  let overlay = document.getElementById('subscription-inactive-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'subscription-inactive-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'subscription-inactive-title');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.72);padding:24px';
    overlay.innerHTML = '<section style="width:min(100%,520px);background:#fff;border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.35);color:#172033"><h2 id="subscription-inactive-title" style="font-size:24px;font-weight:700;margin:0 0 12px">Subscription Inactive</h2><p style="line-height:1.6;margin:0 0 24px">Your subscription is not active. Please recharge your wallet immediately to continue using the software.</p><button id="subscription-go-wallet" type="button" style="background:#155eef;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-weight:600;cursor:pointer">Go to Wallet</button></section>';
    // Deliberately no close affordance or outside-click handler.
    document.body.appendChild(overlay);
    overlay.querySelector('#subscription-go-wallet').addEventListener('click', () => {
      subscriptionModalSnoozed = true;
      hideSubscriptionModal();
      if (window.location.hash === '#wallet') {
        window.dispatchEvent(new CustomEvent('page:navigate', { detail: { path: 'wallet' } }));
      } else window.location.hash = '#wallet';
    });
  }
  overlay.style.display = 'flex';
}

function hideSubscriptionModal() {
  const overlay = typeof document !== 'undefined' && document.getElementById('subscription-inactive-overlay');
  if (overlay) overlay.style.display = 'none';
  isSubscriptionModalOpen = false;
}

async function recoverSubscriptionAccess() {
  try {
    const response = await API.get('/wallet/subscription', {}, { silent: true });
    const sub = response && response.subscription;
    const endDate = sub && (sub.endDate || sub.expiresAt);
    if (!sub || sub.status !== 'ACTIVE' || !endDate || new Date(endDate).getTime() < Date.now()) return false;
    subscriptionModalSnoozed = false;
    hideSubscriptionModal();
    const route = (subscriptionReturnHash || '#dashboard').replace(/^#/, '');
    if (window.location.hash === '#wallet') {
      window.location.hash = `#${route}`;
    } else {
      window.dispatchEvent(new CustomEvent('page:navigate', { detail: { path: window.location.hash.replace(/^#/, '') || route } }));
    }
    subscriptionReturnHash = null;
    return true;
  } catch (error) {
    console.warn('[subscription] status recheck failed:', error && error.message);
    return false;
  }
}

async function request(method, endpoint, data = null, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
  };

  const token = localStorage.getItem('crm_token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config = {
    method,
    headers,
    ...options,
  };

  if (data && method !== 'GET' && method !== 'DELETE') {
    config.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, config);
    const result = await response.json();

    // Support two response shapes:
    //  1. { success: true, data: ... }  (auth, dashboard, etc)
    //  2. { items, total } or raw object (inventory, CRUD endpoints) — treat 2xx as success
    const isSuccess = result.success === true || (response.ok && result.success !== false);
    if (!response.ok || (result.success === false && !response.ok)) {
      const error = new Error(result.error?.message || 'Request failed');
      error.status = response.status;
      error.code = result.error?.code || (typeof result.error === 'string' ? result.error : undefined);
      error.retryAfter = response.headers.get('Retry-After');
      // Attach the full error payload so callers can extract per-field details
      // (e.g. ValidationError.fields) instead of only the generic message.
      error.body = result;
      throw error;
    }
    // Return data from wrapper, or the result itself for unwrapped responses
    return result.data !== undefined ? result.data : result;
  } catch (error) {
    // DECORATIVE CALLS: options.silent marks background/best-effort requests
    // (Topbar notifications, decoration counters). Their failure must never
    // drive global navigation — the caller handles (or swallows) the error.
    //
    // STALE-PERMISSION RECOVERY: a 403 "Permission denied" after a
    // server-side permission fix means the browser holds a stale
    // LocalStorage user object (permissions built at login, before the
    // fix). Clear the cache and force re-login with a message explaining
    // WHY. EXCEPTION: an account with must_change_password legitimately
    // lacks most permissions until it sets a real password — forcing
    // logout here caused the sub-agency login LOOP (login OK → dashboard
    // 403 → logout → login …). Keep the session, route to the forced
    // change-password screen; the change clears the flag.
    if (error.status === 429) {
      const retryAfter = Number(error.retryAfter);
      const waitMessage = Number.isFinite(retryAfter) && retryAfter > 0
        ? ` Please try again in ${retryAfter} seconds.`
        : ' Please wait a moment and try again.';
      if (!options.silent && typeof Toast !== 'undefined') {
        Toast.error(`Too many requests.${waitMessage}`);
      }
      throw error;
    }
    const authMessage = (error.body && error.body.error && error.body.error.message)
      || error.message || '';
    const subscriptionError = error.status === 403 && error.code === 'SUBSCRIPTION_INACTIVE';
    if (subscriptionError) {
      if (window.location.hash !== '#wallet') subscriptionModalSnoozed = false;
      showSubscriptionModal();
      throw error;
    }
    const invalidSessionToken = error.status === 401
      && /invalid or expired token/i.test(authMessage);
    if (invalidSessionToken) {
      let cachedUser = {};
      try { cachedUser = JSON.parse(localStorage.getItem('crm_user') || '{}'); } catch { /* ignore */ }
      if (cachedUser.email === 'admin@blackstack.local') {
        // Temporary diagnostic requested for the super-admin redirect loop.
        console.warn('[session-debug] Super-admin request rejected; redirecting to login.', {
          endpoint, status: error.status, response: error.body,
        });
      }
      handleUnauthorized('Your session has expired. Please log in again.');
      throw error;
    }
    if (error.status === 401) {
      if (!options.silent && typeof Toast !== 'undefined') Toast.error(authMessage || 'Request was not authorized.');
      throw error;
    }
    // ENDPOINT-SCOPED SOFT FAILURES: decorative endpoints whose failure must
    // never log the user out (Topbar notification counters, settings summary).
    // Hierarchy accounts legitimately lack notifications.view; a 403 here is
    // informational for the caller, not a session-wide auth failure.
    const SOFT_403 = ['notifications/unread-count', 'notifications', 'settings'];
    const isSoft403 = error.status === 403 && SOFT_403.some((p) => endpoint.startsWith('/' + p));
    if (error.status === 403 && !isSoft403) {
      let mustChange = false;
      try {
        mustChange = JSON.parse(localStorage.getItem('crm_user') || '{}').mustChangePassword === true;
      } catch { /* malformed cache — treat as normal 403 */ }
      if (mustChange) {
        window.location.hash = '#change-password';
        window.dispatchEvent(new CustomEvent('page:navigate', { detail: { path: 'change-password' } }));
        throw error; // caller shows its own message; no logout
      }
      handleForbidden(error);
    }
    throw error;
    // FIX (stale-permission recovery): a 403 after a server-side permission
    // fix means the browser is holding a stale LocalStorage user object
    // (permissions built at login, before the fix). Clear the cached profile
    // and force re-login so the fresh grants take effect — with a message
    // that explains WHY, instead of a generic failure screen.
    //
    // EXCEPT: an account with must_change_password still set legitimately
    // lacks most permissions until it sets a real password. Forcing logout
    // here caused the sub-agency login LOOP (login OK → dashboard 403 →
    // logout → login …). Instead: keep the session, route to the forced
    // change-password screen, and let the change clear the flag.
    if (!options.silent && error.status === 403) {
      let mustChange = false;
      try {
        mustChange = JSON.parse(localStorage.getItem('crm_user') || '{}').mustChangePassword === true;
      } catch { /* malformed cache — treat as normal 403 */ }
      if (mustChange) {
        window.location.hash = '#change-password';
        window.dispatchEvent(new CustomEvent('page:navigate', { detail: { path: 'change-password' } }));
        throw error; // caller shows its own message; no logout
      }
      handleForbidden(error);
    }
    throw error;
  }
}

function handleForbidden(error) {
  // Only force a re-login when the 403 is a PERMISSION problem (server says
  // "Permission denied: …"). Other 403 shapes (e.g. Mother Company guards)
  // are legitimate access restrictions for this user and must NOT log them
  // out — they would just bounce back to the same screen.
  const raw = (error.body && error.body.error && error.body.error.message)
    || error.message || '';
  if (!/^permission denied/i.test(raw)) return;
  localStorage.removeItem('crm_token');
  localStorage.removeItem('crm_user');
  document.cookie = 'crm_token=; Path=/; Max-Age=0; SameSite=Lax';
  const msg = encodeURIComponent(
    'Session expired or permissions updated. Please log in again.');
  window.location.href = '/login.html?reason=' + msg;
}

function handleUnauthorized(customMessage) {
  localStorage.removeItem('crm_token');
  localStorage.removeItem('crm_user');
  // Clear the shared SSO cookie too, so the Server UI loses access with the
  // CRM session (cookies are not port-specific on localhost).
  document.cookie = 'crm_token=; Path=/; Max-Age=0; SameSite=Lax';
  const msg = encodeURIComponent(customMessage || 'Your session has expired. Please log in again.');
  window.location.href = '/login.html?reason=' + msg;
}

function get(endpoint, params = {}, options = {}) {
  // Skip undefined/null params — URLSearchParams would serialize them as the
  // literal string "undefined", corrupting server-side date/amount filters.
  const clean = {};
  Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null && params[k] !== '') clean[k] = params[k]; });
  const query = new URLSearchParams(clean).toString();
  const url = query ? `${endpoint}?${query}` : endpoint;
  return request('GET', url, null, options);
}

// Disable submit buttons inside any open modal while a mutation is in flight,
// to prevent duplicate submissions. Buttons are restored on completion.
function setSubmittingState(state) {
  document.querySelectorAll('.modal-overlay button[type="submit"], .modal button[type="submit"]').forEach(btn => {
    btn.disabled = state;
    btn.classList.toggle('opacity-50', state);
    btn.classList.toggle('cursor-not-allowed', state);
  });
}

async function mutating(method, endpoint, data, options = {}) {
  setSubmittingState(true);
  try {
    return await request(method, endpoint, data, options);
  } finally {
    setSubmittingState(false);
  }
}

function post(endpoint, data, options = {}) {
  return mutating('POST', endpoint, data, options);
}

function put(endpoint, data) {
  return mutating('PUT', endpoint, data);
}

function patch(endpoint, data) {
  return mutating('PATCH', endpoint, data);
}

function del(endpoint) {
  return mutating('DELETE', endpoint);
}

window.API = {
  request,
  get,
  post,
  put,
  patch,
  del,
  handleUnauthorized
};
window.SubscriptionGate = {
  recover: recoverSubscriptionAccess,
  show: showSubscriptionModal,
  hide: hideSubscriptionModal,
  get isOpen() { return isSubscriptionModalOpen; },
};
