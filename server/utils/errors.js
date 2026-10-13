class AppError extends Error {
  constructor(message, code = 'INTERNAL_ERROR', status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  /**
   * `fields` carries per-field messages so a client can attach each message to the
   * input that caused it, instead of showing one generic banner.
   *
   * This parameter was previously accepted-and-dropped: callers were already
   * passing a field map (e.g. AgencyService.validateAgencyInput), but the
   * constructor only forwarded `message`, so the detail never reached the client.
   * It is preserved here rather than changing every existing call site, and is
   * deliberately kept out of any log output.
   */
  constructor(message, fields) {
    super(message, 'VALIDATION_ERROR', 400);
    if (fields && typeof fields === 'object') {
      this.fields = fields;
      this.details = fields; // alias used by some existing callers
    }
  }
}

class NotFoundError extends AppError {
  constructor(entity, id) { super(`${entity} with ID ${id} not found`, 'NOT_FOUND', 404); }
}

class AuthenticationError extends AppError {
  constructor(message) { super(message, 'AUTHENTICATION_ERROR', 401); }
}

class AuthorizationError extends AppError {
  constructor(message) { super(message, 'AUTHORIZATION_ERROR', 403); }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  AuthenticationError,
  AuthorizationError
};
