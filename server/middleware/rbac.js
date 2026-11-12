const { Authorizer } = require('../auth/authorizer');
const { AuthorizationError } = require('../utils/errors');
const { getConn } = require('../utils/db');
const { resolveCaller } = require('../services/rbac.service');

function requirePermission(permissionCode) {
  return (req, res, next) => {
    if (!req.user) {
      throw new AuthorizationError('Authentication required');
    }

    // Hierarchy permissions are role boundaries, not ordinary grants. Do not
    // let '*' or stale role_permissions rows restore forbidden controls.
    if (permissionCode.startsWith('agency_control.')) {
      const caller = resolveCaller(getConn(), { userId: req.user.userId });
      const role = caller && caller.role;
      const subAgencyCustomerAccess = role === 'sub_agency'
        && permissionCode === 'agency_control.customers.manage';
      if (!['platform', 'agency'].includes(role) && !subAgencyCustomerAccess) {
        throw new AuthorizationError('Agency control access required for this role');
      }
    }

    if (permissionCode.startsWith('users.') || permissionCode === 'settings.manage') {
      const caller = resolveCaller(getConn(), { userId: req.user.userId });
      if (!caller || !['platform', 'agency'].includes(caller.role)) {
        throw new AuthorizationError('This administrative feature is not available for your role');
      }
    }

    Authorizer.assertPermission(req.user, permissionCode);
    next();
  };
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const { SessionManager } = require('../auth/session');
    const token = authHeader.split(' ')[1];
    const session = SessionManager.verifyToken(token);
    if (session) {
      req.user = session;
    }
  }
  next();
}

module.exports = { requirePermission, optionalAuth };
