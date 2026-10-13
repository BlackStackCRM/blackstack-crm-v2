const { body } = require('express-validator');

const loginValidation = [
  body('password').notEmpty().withMessage('Password is required'),
  body().custom((_, { req }) => {
    if (!req.body.email && !req.body.username) {
      throw new Error('Email or username is required');
    }
    return true;
  })
];

const changePasswordValidation = [
  body('new_password').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  body().custom((_, { req }) => {
    if (!req.body.current_password && !req.body.old_password) {
      throw new Error('Current password is required');
    }
    return true;
  })
];

module.exports = { loginValidation, changePasswordValidation };