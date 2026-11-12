const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createClient(response) {
  const values = new Map([['crm_token', 'valid-looking-token'], ['crm_user', JSON.stringify({ email: 'user@example.com' })]]);
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    removeItem: (key) => values.delete(key),
  };
  const window = { location: { href: '', hash: '' }, dispatchEvent() {} };
  const Toast = { error: vi.fn() };
  const context = {
    window,
    localStorage,
    document: { cookie: '', querySelectorAll: () => [] },
    fetch: vi.fn(async () => response),
    URLSearchParams,
    CustomEvent: class CustomEvent {},
    Toast,
    console: { warn: vi.fn() },
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/js/api/client.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'public/js/api/client.js' });
  return { API: window.API, Toast, window, values };
}

function response(status, payload, retryAfter = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'Retry-After' ? retryAfter : null) },
    json: async () => payload,
  };
}

describe('API client session handling', () => {
  it('shows a 429 notice without clearing the session or redirecting', async () => {
    const client = createClient(response(429, {
      success: false,
      error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
    }, '12'));

    await expect(client.API.get('/dashboard/summary')).rejects.toMatchObject({ status: 429 });

    expect(client.values.has('crm_token')).toBe(true);
    expect(client.window.location.href).toBe('');
    expect(client.Toast.error).toHaveBeenCalledWith('Too many requests. Please try again in 12 seconds.');
  });

  it('redirects and clears the cached session for an explicitly invalid token', async () => {
    const client = createClient(response(401, {
      success: false,
      error: { code: 'AUTHENTICATION_ERROR', message: 'Invalid or expired token' },
    }));

    await expect(client.API.get('/dashboard/summary')).rejects.toMatchObject({ status: 401 });

    expect(client.values.has('crm_token')).toBe(false);
    expect(client.window.location.href).toContain('/login.html?reason=');
  });

  it('does not treat a non-token 401 as an expired session', async () => {
    const client = createClient(response(401, {
      success: false,
      error: { code: 'AUTHENTICATION_ERROR', message: 'User account is not active' },
    }));

    await expect(client.API.get('/dashboard/summary')).rejects.toMatchObject({ status: 401 });

    expect(client.values.has('crm_token')).toBe(true);
    expect(client.window.location.href).toBe('');
    expect(client.Toast.error).toHaveBeenCalledWith('User account is not active');
  });

  it('keeps the session and shows an access notice for a permission 403', async () => {
    const client = createClient(response(403, {
      success: false,
      error: { code: 'AUTHORIZATION_ERROR', message: 'Permission denied: leads.view' },
    }));

    await expect(client.API.get('/leads')).rejects.toMatchObject({ status: 403 });

    expect(client.values.has('crm_token')).toBe(true);
    expect(client.values.has('crm_user')).toBe(true);
    expect(client.window.location.href).toBe('');
    expect(client.Toast.error).toHaveBeenCalledWith('You do not have permission to view this resource.');
  });
});
