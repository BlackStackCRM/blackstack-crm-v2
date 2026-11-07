const AuthAPI = {
  // The crm_token cookie is shared across localhost ports, which lets the
  // Server UI control server (port 3001) forward the session to this CRM for
  // server-side validation (SSO). The token itself remains validated only by
  // the CRM — nothing about it is trusted without verification.
  _setSessionCookie(token) {
    document.cookie = `crm_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  },
  _clearSessionCookie() {
    document.cookie = 'crm_token=; Path=/; Max-Age=0; SameSite=Lax';
  },

  async login(email, password) {
    const result = await window.API.post('/auth/login', { email, password });
    if (result?.token) {
      // WARNING: Stored in localStorage. If an XSS vulnerability occurs, the token can be stolen.
      // Future refactor must use HttpOnly cookies.
      localStorage.setItem('crm_token', result.token);
      // Immediately fetch the authoritative profile so permissions/roles are
      // fresh before any sidebar/page renders. This avoids showing stale
      // permissions from the JWT payload, especially after permission changes.
      try {
        const profile = await this.getProfile();
        const user = (profile && profile.data) ? profile.data : (profile || {});
        localStorage.setItem('crm_user', JSON.stringify(user));
      } catch {
        localStorage.setItem('crm_user', '{}');
      }
      this._setSessionCookie(result.token);
    }
    return result;
  },

  async logout() {
    try {
      await window.API.post('/auth/logout');
    } finally {
      localStorage.removeItem('crm_token');
      localStorage.removeItem('crm_user');
      this._clearSessionCookie();
    }
  },

  async getProfile() {
    const token = localStorage.getItem('crm_token');
    const response = await fetch('/api/auth/profile', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = await response.json();
    if (!response.ok || result.success === false) {
      const error = new Error(result.error?.message || 'Failed to load profile');
      error.status = response.status;
      error.code = result.error?.code;
      throw error;
    }
    return (result && result.data) ? result.data : result;
  },

  async changePassword(oldPassword, newPassword) {
    return window.API.put('/auth/profile/password', { oldPassword, newPassword });
  },

  isAuthenticated() {
    return !!localStorage.getItem('crm_token');
  },

  getUser() {
    const user = localStorage.getItem('crm_user');
    return user ? JSON.parse(user) : null;
  },
};

window.AuthAPI = AuthAPI;
