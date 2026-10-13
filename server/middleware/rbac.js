const { Authorizer } = require('../auth/authorizer');
const { AuthorizationError } = require('../utils/errors');

function requirePermission(permissionCode) {
  return (req, res, next) => {
    if (!req.user) {
      throw new AuthorizationError('Authentication required');
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
