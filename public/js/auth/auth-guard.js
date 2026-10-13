const AuthGuard = {
  check() {
    if (!AuthAPI.isAuthenticated()) {
      const intended = window.location.pathname + window.location.hash;
      sessionStorage.setItem('redirectAfterLogin', intended);
      window.location.href = '/login.html';
      return false;
    }
    return true;
  },

  redirectIfAuthenticated() {
    if (AuthAPI.isAuthenticated()) {
      window.location.href = '/index.html#dashboard';
    }
  },

  getIntendedRedirect() {
    return sessionStorage.getItem('redirectAfterLogin') || '/index.html#dashboard';
  },

  clearIntendedRedirect() {
    sessionStorage.removeItem('redirectAfterLogin');
  },
};

window.AuthGuard = AuthGuard;
