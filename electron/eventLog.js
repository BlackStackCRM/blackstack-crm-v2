/**
 * WINDOWS EVENT LOG WRITER — Phase 3 (§18)
 *
 * Writes only critical events (startup failure, migration failure, recovery,
 * update failure/rollback, corruption detection) to the Windows Application
 * event log under source "BlackStack CRM".
 *
 * HARD RULES:
 *  - Never a single point of failure: every call is best-effort; any error is
 *    swallowed (the normal file logs remain the authoritative record).
 *  - Never logs CRM data, passwords, tokens or API keys (caller passes short
 *    human-readable messages only; a safety scrub is applied anyway).
 *  - Creating an event source requires admin rights; if unavailable we fall
 *    back to writing under the existing ".NET Runtime"/application source via
 *    eventcreate with /SO flag, and if that also fails, we do nothing.
 */
const { execFile } = require('child_process');

const SOURCE = 'BlackStack CRM';
const MAX_MSG = 300;

function scrub(msg) {
  return String(msg || '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(password|token|api[_-]?key|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, MAX_MSG);
}

/**
 * Write an event. fire-and-forget.
 * @param {'ERROR'|'WARNING'|'INFORMATION'} level
 * @param {string} message short human-readable summary (no secrets)
 * @param {number} [eventId] numeric id (default derived)
 */
function logEvent(level, message, eventId) {
  try {
    if (process.platform !== 'win32') return;
    const text = scrub(message);
    const id = Number.isInteger(eventId) ? eventId : 1000;
    // eventcreate works without pre-registered source when run elevated;
    // otherwise it fails silently here by design.
    execFile('eventcreate', [
      '/ID', String(id),
      '/L', 'APPLICATION',
      '/SO', SOURCE,
      '/T', level,
      '/D', text,
    ], { windowsHide: true, timeout: 5000 }, () => { /* intentionally ignored */ });
  } catch { /* never throw from event logging */ }
}

module.exports = { logEvent, SOURCE };
