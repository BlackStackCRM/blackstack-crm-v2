const express = require('express');
const { validationResult } = require('express-validator');
const { AuthController } = require('../controllers/auth.controller');
const { authMiddleware } = require('../middleware/auth');
const { errorResponse, successResponse } = require('../utils/response');
const { loginValidation, changePasswordValidation } = require('../validators/auth.validator');

const router = express.Router();
const controller = new AuthController();

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  }
  next();
};

router.post('/login', loginValidation, handleValidation, controller.login.bind(controller));
router.post('/logout', authMiddleware, controller.logout.bind(controller));
router.get('/profile', authMiddleware, controller.getProfile.bind(controller));
// Compatibility alias for clients that refer to the current identity as /me.
router.get('/me', authMiddleware, controller.getProfile.bind(controller));
router.put('/profile', authMiddleware, controller.updateProfile.bind(controller));
router.put('/profile/password', authMiddleware, changePasswordValidation, handleValidation, controller.changePassword.bind(controller));

// SETUP/REGISTRATION ENDPOINTS RETIRED (customer-facing).
//
// Customer accounts are provisioned centrally by the Agency through Supabase;
// after a Supabase-authenticated login the account and its company are synced
// down into the local SQLite database automatically. A customer must never be
// able to create the first user, register a company or activate a licence on
// their own machine, so these endpoints are disabled at the router:
//
//   GET  /api/auth/setup-status        -> always mode 'login'
//   POST /api/auth/setup/first-user    -> 403 SETUP_DISABLED
//
// The setup-status probe stays (login.js polls it on page load; a 404 would
// disable the login form entirely), but it now reports that the login screen
// is always the entry point.
router.get('/setup-status', (req, res) => {
  res.json(successResponse({ mode: 'login', userCount: -1, setupDisabled: true }));
});

router.post('/setup/first-user', (req, res) => {
  res.status(403).json(errorResponse(
    'SETUP_DISABLED',
    'Local account registration is disabled. Your account is created by the Agency — please sign in with the credentials you were provided.'
  ));
});

module.exports = router;
