/**
 * Global SQLite-error -> HTTP-status classification.
 *
 * PHASE 3 STEP 3C — CRM-05.
 *
 * WHY THIS EXISTS
 *   The logic used to live inline in the Express error handler in server/app.js,
 *   where it was unreachable from any test. It was also wrong:
 *
 *     const FK_RE = /FOREIGN KEY constraint failed|UNIQUE constraint failed
 *                 |NOT NULL constraint failed|CHECK constraint failed/i;
 *     if (FK_RE.test(err.message)) {
 *       // BOTH branches emitted the same message:
 *       //   'The operation was blocked because related records reference this data.'
 *     }
 *
 *   The pattern matches FOUR distinct failures, yet every one of them was
 *   reported as a DEPENDENCY problem. A duplicate key, a bad enum value and a
 *   missing required field all told the user that "related records reference this
 *   data" — which is false, and sends them looking in the wrong place entirely.
 *
 *   Extracting the mapping here makes it directly testable, which is what the
 *   regression suite in tests/crm-error-semantics.test.js asserts against. The
 *   handler in server/app.js now delegates to `classifyError`.
 */

/**
 * Classify a SQLite / application error into a client-safe HTTP status and code.
 *
 * Mapping:
 *   FOREIGN KEY  -> 409 ENTITY_HAS_DEPENDENCIES   (genuine dependency)
 *   UNIQUE        -> 409 DUPLICATE_VALUE           (duplicate, NOT a dependency)
 *   CHECK         -> 400 VALIDATION_ERROR          (value outside the allowed set)
 *   NOT NULL      -> 400 VALIDATION_ERROR          (required value missing)
 *
 * Anything unrecognised is left alone, so a genuinely unexpected fault still
 * surfaces as 500 rather than being laundered into a 4xx. That distinction
 * matters: mislabelling a server fault as a validation error would hide real
 * defects.
 *
 * @param {Error & {code?: string, status?: number}} err
 * @returns {{code: string, status: number, message: string, fields?: Record<string,string>}}
 */
function classifyError(err) {
  const message = String((err && err.message) || '');
  const originalCode = (err && err.code) || 'INTERNAL_ERROR';

  // An error that already carries an explicit HTTP status is trusted as-is.
  // AppError, ValidationError and NotFoundError all set `status`.
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const mapped = {
      code: originalCode,
      status: err.status,
      message: err.message,
      classification: 'APPLICATION_ERROR',
    };
    // Carry per-field validation detail through to the client so a form can
    // attach each message to the input that caused it. ValidationError sets this
    // (see utils/errors.js); it was being dropped here, so callers that supplied
    // a field map never saw it. Only a plain string->string map is forwarded —
    // anything else could leak internals.
    if (originalCode === 'VALIDATION_ERROR' && err.fields && typeof err.fields === 'object'
      && Object.values(err.fields).every((v) => typeof v === 'string')) {
      mapped.fields = err.fields;
    }
    return mapped;
  }

  if (/FOREIGN KEY constraint failed/i.test(message)
    || originalCode === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return {
      code: 'ENTITY_HAS_DEPENDENCIES',
      status: 409,
      message: 'The operation was blocked because related records reference this data.',
      classification: 'FOREIGN_KEY',
    };
  }

  if (/UNIQUE constraint failed/i.test(message)) {
    return {
      code: 'DUPLICATE_VALUE',
      status: 409,
      message: 'A record with this unique value already exists.',
      classification: 'UNIQUE',
    };
  }

  if (/CHECK constraint failed/i.test(message)) {
    return {
      code: 'VALIDATION_ERROR',
      status: 400,
      message: 'A supplied value is not in the allowed set for this field.',
      classification: 'CHECK',
    };
  }

  if (/NOT NULL constraint failed/i.test(message)) {
    return {
      code: 'VALIDATION_ERROR',
      status: 400,
      message: 'A required value was missing.',
      classification: 'NOT_NULL',
    };
  }

  // Not a recognised constraint failure — leave it as an internal error so real
  // faults stay visible instead of being disguised as bad input.
  return {
    code: originalCode,
    status: 500,
    message: 'An unexpected internal error occurred.',
    classification: 'INTERNAL',
  };
}

module.exports = { classifyError };