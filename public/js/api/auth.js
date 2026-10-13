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
      localStorage.setItem('crm_token', result.token);
      localStorage.setItem('crm_user', JSON.stringify(result.user || {}));
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
    return window.API.get('/auth/profile');
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
