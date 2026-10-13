/**
 * Append-only update event log (no sensitive data).
 * Phase 3: standardized event taxonomy per spec §13.
 */
const fs = require('fs');
const path = require('path');

const EVENTS = {
  CHECK_STARTED: 'UPDATE_CHECK_STARTED',
  AVAILABLE: 'UPDATE_AVAILABLE',
  DOWNLOAD_STARTED: 'UPDATE_DOWNLOAD_STARTED',
  DOWNLOAD_COMPLETED: 'UPDATE_DOWNLOAD_COMPLETED',
  INSTALL_STARTED: 'UPDATE_INSTALL_STARTED',
  INSTALL_FAILED: 'UPDATE_INSTALL_FAILED',
  COMPLETED: 'UPDATE_COMPLETED',
  ROLLBACK_STARTED: 'UPDATE_ROLLBACK_STARTED',
  ROLLBACK_COMPLETED: 'UPDATE_ROLLBACK_COMPLETED',
  RECOVERY_REQUIRED: 'UPDATE_RECOVERY_REQUIRED',
};

const state = { dir: null };

const updateLogger = {
  EVENTS,
  init(dir) {
    state.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  },
  event(name, data = {}) {
    try {
      if (!state.dir) return;
      const line = JSON.stringify({ at: new Date().toISOString(), event: name, ...data }) + '\n';
      fs.appendFileSync(path.join(state.dir, 'updates.log'), line);
    } catch { /* logging must never block */ }
  },
};

module.exports = { updateLogger, EVENTS };
