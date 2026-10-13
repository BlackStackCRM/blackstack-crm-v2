const API_BASE = '/api';

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
      error.code = result.error?.code;
      throw error;
    }
    // Return data from wrapper, or the result itself for unwrapped responses
    return result.data !== undefined ? result.data : result;
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
    }
    throw error;
  }
}

function handleUnauthorized() {
  localStorage.removeItem('crm_token');
  localStorage.removeItem('crm_user');
  // Clear the shared SSO cookie too, so the Server UI loses access with the
  // CRM session (cookies are not port-specific on localhost).
  document.cookie = 'crm_token=; Path=/; Max-Age=0; SameSite=Lax';
  window.location.href = '/login.html';
}

function get(endpoint, params = {}) {
  // Skip undefined/null params — URLSearchParams would serialize them as the
  // literal string "undefined", corrupting server-side date/amount filters.
  const clean = {};
  Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null && params[k] !== '') clean[k] = params[k]; });
  const query = new URLSearchParams(clean).toString();
  const url = query ? `${endpoint}?${query}` : endpoint;
  return request('GET', url);
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

async function mutating(method, endpoint, data) {
  setSubmittingState(true);
  try {
    return await request(method, endpoint, data);
  } finally {
    setSubmittingState(false);
  }
}

function post(endpoint, data) {
  return mutating('POST', endpoint, data);
}

function put(endpoint, data) {
  return mutating('PUT', endpoint, data);
}

function del(endpoint) {
  return mutating('DELETE', endpoint);
}

window.API = {
  request,
  get,
  post,
  put,
  del,
  handleUnauthorized
};
