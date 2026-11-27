/* Minimal repro: replicate the app-level auth middleware chain (app.js 152-168)
 * and the /api 404 catch-all, using the real middleware, to find what hangs. */
const path = require('path');
const { loadRuntimeEnvironment } = require(path.join(__dirname, '..', 'server', 'config', 'runtimeEnvironment'));
loadRuntimeEnvironment({ envPath: process.env.APPDATA + '\\blackstack-crm-v2\\data\\.env' });

const S = (m) => require(path.join(__dirname, '..', 'server', m));
const { SessionManager } = S('auth/session');
const { authMiddleware } = S('middleware/auth');
const { checkSubscriptionStatus, isSubscriptionBypassPath } = S('middleware/subscription');

const s = SessionManager.createSession({ id: 'admin', email: 'admin@blackstack.local', role: 'ADMIN' }, { companyId: 'default', permissions: ['*'] });

function fakeRes(label) {
  return {
    status(c) { this._c = c; return this; },
    json(b) { console.log(label, '-> response', this._c, JSON.stringify(b).slice(0, 100)); },
  };
}

const req = {
  headers: { authorization: 'Bearer ' + s.token },
  path: '/storage',
  method: 'GET',
  body: {},
  query: {},
  requestId: 't',
};

console.log('bypass?', isSubscriptionBypassPath(req.path));
const t0 = Date.now();
try {
  authMiddleware(req, fakeRes('auth'), (authError) => {
    if (authError) { console.log('auth error:', authError.message); return; }
    checkSubscriptionStatus(req, fakeRes('sub'), () => {
      console.log('CHAIN COMPLETED after', Date.now() - t0, 'ms');
    });
  });
} catch (e) {
  console.log('authMiddleware THREW (Express would catch):', e.message, e.status || '');
}
setTimeout(() => { console.error('NEVER COMPLETED after', Date.now() - t0, 'ms'); process.exit(2); }, 10000);
