const express = require('express');
const { body, validationResult } = require('express-validator');
const { AuthController } = require('../controllers/auth.controller');
const { authMiddleware } = require('../middleware/auth');
const { errorResponse } = require('../utils/response');
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
router.put('/profile', authMiddleware, controller.updateProfile.bind(controller));
router.put('/profile/password', authMiddleware, changePasswordValidation, handleValidation, controller.changePassword.bind(controller));

// SETUP STATUS (public) — login.js probes this BEFORE showing the login
// form. A 404 here disabled the login form entirely (showStoreError).
// Returns { mode: 'setup'|'login', userCount } — read-only, no user data.
router.get('/setup-status', controller.setupStatus.bind(controller));

// CREATE FIRST USER (public) — 409 once any user exists. Returns a session
// so the operator lands on the dashboard immediately after setup.
router.post('/setup/first-user',
  [
    body('full_name').isString().trim().notEmpty().withMessage('Full name is required.'),
    body('email').isString().trim().notEmpty().withMessage('A valid email address is required.'),
    body('password').isString().isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
    body('confirm_password').custom((value, { req }) => value === req.body.password)
      .withMessage('Passwords do not match.'),
  ],
  handleValidation,
  controller.createFirstUser.bind(controller));

module.exports = router;
