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

module.exports = router;