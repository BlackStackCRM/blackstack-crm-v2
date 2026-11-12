/**
 * EMAIL INPUT SANITIZER — shared helper for every email input in the app.
 *
 * WHY THIS EXISTS
 *   Users routinely paste values like "Email: name@example.com" or
 *   "Username: name@example.com" (copied from emails, docs, or other apps)
 *   into email fields. `type="email"` then fails HTML5 validation with the
 *   cryptic browser tooltip: "A part followed by '@' should not contain the
 *   symbol ':'" — which tells the user nothing about what went wrong.
 *
 * WHAT IT DOES
 *   sanitizeEmailValue(value):
 *     1. trims leading/trailing whitespace,
 *     2. strips a leading label prefix — "Email:", "E-mail:", "Mail:",
 *        "Username:", "User:" (case-insensitive, optional colon/space),
 *     3. strips surrounding quotes and stray angle brackets that arrive with
 *        copy-pasted display addresses ("Name <name@example.com>"),
 *     4. lowercases nothing (emails are case-insensitive in practice; the
 *        original casing is preserved for display).
 *
 * attachEmailSanitizer(input, { errorEl, message }):
 *     wires the sanitizer to a specific input:
 *       - on `blur`: cleans the value in place (so the user SEES the
 *         correction) and shows a gentle inline notice when a prefix was
 *         actually stripped,
 *       - on `input`: clears the notice and error state as the user types,
 *       - exposes `sanitizeEmailValue` on window.EmailSanitizer for form
 *         submit handlers to call before sending to the API.
 */
(function () {
  'use strict';

  const PREFIX_RE = /^\s*(e-?mail|mail|username|user)\s*[:：]\s*/i;

  function sanitizeEmailValue(value) {
    let v = String(value == null ? '' : value);
    // display-name form: 'Someone <name@example.com>' -> name@example.com
    const bracket = v.match(/<\s*([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\s*>/);
    if (bracket) v = bracket[1];
    v = v.replace(/^["'\s]+|["'\s]+$/g, '');
    // strip the pasted label prefix, repeatedly (e.g. "Email: Username: x")
    let stripped = false;
    let prev;
    do {
      prev = v;
      v = v.replace(PREFIX_RE, '');
      if (v !== prev) stripped = true;
    } while (v !== prev);
    v = v.trim();
    return { value: v, stripped };
  }

  function attachEmailSanitizer(input, opts) {
    if (!input) return;
    const opts_ = opts || {};
    const notice = opts_.noticeEl || null;
    const errorEl = opts_.errorEl || null;

    const showNotice = (msg) => {
      if (notice) {
        notice.textContent = msg;
        notice.classList.remove('hidden');
      }
    };
    const clearNotice = () => {
      if (notice) {
        notice.textContent = '';
        notice.classList.add('hidden');
      }
    };
    const clearError = () => {
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
      }
    };

    // blur: clean in place so the user sees the corrected value.
    input.addEventListener('blur', () => {
      const { value, stripped } = sanitizeEmailValue(input.value);
      if (stripped || value !== input.value.trim()) {
        const before = input.value;
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        showNotice('Removed the pasted label ("' + before.trim().slice(0, 24) + '…"). Cleaned value: ' + value);
      }
    });

    // input: any typing clears the notice and error state.
    input.addEventListener('input', () => {
      clearNotice();
      clearError();
      input.classList.remove('border-error');
    });

    // also sanitize on paste immediately (before blur) for instant feedback
    input.addEventListener('paste', () => {
      setTimeout(() => {
        const { value } = sanitizeEmailValue(input.value);
        if (value !== input.value) input.value = value;
      }, 0);
    });
  }

  window.EmailSanitizer = { sanitizeEmailValue, attachEmailSanitizer };
})();
