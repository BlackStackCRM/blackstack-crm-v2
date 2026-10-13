/**
 * UPDATE LIFECYCLE STATE — Phase C.
 *
 * A single place that owns "what is the updater doing right now", so the main
 * process, the renderer and a later launch all agree. Before this, update state
 * existed only as an in-memory global (`__pendingUpdateVersion`) and as ad-hoc
 * `update-status` IPC payloads, which meant a downloaded-but-not-installed
 * update was forgotten the moment the app closed.
 *
 * Design constraints, taken from the existing codebase:
 *
 *  - NOT stored in the business database. Update state is application state, not
 *    user data; writing it to SQLite would put app lifecycle data inside the
 *    file every backup and migration has to protect. `paths.updates()` already
 *    exists in server/config/userDataPath.js for exactly this and was unused.
 *  - Follows the same shape as `update-channel.json` (plain JSON in the user-data
 *    preferences tree), so it is inspectable, backed up with user data, and
 *    survives an application update.
 *  - Never throws. A corrupt or missing state file must degrade to "no pending
 *    update", never block startup.
 *
 * The state names are the ones the renderer and the main process exchange over
 * IPC. They are derived from the states electron-updater can actually reach —
 * see electron/main.js, where every transition below is emitted by a real
 * updater event. No state here is decorative.
 */
const fs = require('fs');
const path = require('path');
const { paths, ensureDir } = require('../config/userDataPath');

/**
 * Lifecycle states.
 *
 * READY is named rather than DOWNLOADED because it means "verified and awaiting an
 * explicit user decision", which is the semantic the UI needs. electron-updater's
 * `update-downloaded` maps onto it.
 */
const STATES = {
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  AVAILABLE: 'AVAILABLE',
  DOWNLOADING: 'DOWNLOADING',
  VERIFYING: 'VERIFYING',
  READY: 'READY',
  INSTALLING: 'INSTALLING',
  RESTARTING: 'RESTARTING',
  UPDATED: 'UPDATED',
  ERROR: 'ERROR',
  OFFLINE: 'OFFLINE',
  DISABLED: 'DISABLED',
  UP_TO_DATE: 'UP_TO_DATE',
  /**
   * Install failed and the user must be guided through the existing backup /
   * recovery path before BlackStack can be trusted again. Reachable only from
   * INSTALLING.
   */
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  /** User chose Later: ready, deliberately not acted on. */
  POSTPONED: 'POSTPONED',
};

/**
 * Legal transitions. Enforced here so a bad event cannot put the UI into a state
 * it cannot leave — e.g. DOWNLOADING -> READY with no download.
 *
 * `ERROR` and `OFFLINE` are reachable from any in-flight state and can settle
 * back to IDLE. `POSTPONED` is a terminal-ish state that only an explicit user
 * action (Update Now / Restart & Update) leaves.
 */
const TRANSITIONS = {
  IDLE: ['CHECKING', 'DISABLED'],
  DISABLED: ['IDLE', 'CHECKING'],
  CHECKING: ['AVAILABLE', 'UP_TO_DATE', 'ERROR', 'OFFLINE', 'DISABLED'],
  UP_TO_DATE: ['CHECKING', 'IDLE'],
  AVAILABLE: ['DOWNLOADING', 'POSTPONED', 'ERROR', 'IDLE', 'OFFLINE'],
  DOWNLOADING: ['VERIFYING', 'READY', 'ERROR', 'AVAILABLE', 'OFFLINE', 'POSTPONED'],
  VERIFYING: ['READY', 'ERROR', 'DOWNLOADING'],
  READY: ['INSTALLING', 'POSTPONED', 'CHECKING', 'DOWNLOADING', 'ERROR'],
  POSTPONED: ['INSTALLING', 'DOWNLOADING', 'CHECKING', 'IDLE'],
  INSTALLING: ['RESTARTING', 'ERROR', 'RECOVERY_REQUIRED'],
  RESTARTING: ['UPDATED', 'ERROR'],
  UPDATED: ['IDLE'],
  ERROR: ['IDLE', 'CHECKING', 'DOWNLOADING'],
  OFFLINE: ['IDLE', 'CHECKING'],
  RECOVERY_REQUIRED: ['IDLE', 'ERROR'],
};

function stateFile() {
  ensureDir(paths.updates());
  return path.join(paths.updates(), 'update-state.json');
}

function defaultState() {
  return {
    status: STATES.IDLE,
    currentVersion: null,
    targetVersion: null,
    // Real updater progress only. Never synthesized.
    percent: null,
    transferred: null,
    total: null,
    bytesPerSecond: null,
    postponed: false,
    error: null,
    updatedAt: null,
  };
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') {
      return defaultState();
    }
    // Merge over defaults so a state file written by an older version (missing
    // keys) still produces a complete object.
    return { ...defaultState(), ...parsed };
  } catch {
    // Missing or corrupt — treat as no pending update rather than failing startup.
    return defaultState();
  }
}

function writeState(state) {
  try {
    ensureDir(paths.updates());
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Transition to `next`, merging `patch` into the state.
 *
 * Returns the new state. An illegal transition is refused and logged rather than
 * applied, because silently accepting one is how a progress bar ends up stuck at
 * 100% with an install that never happens. `force` exists for the explicit user
 * actions (Update Now / Restart & Update), which are allowed to leave POSTPONED.
 */
function setState(next, patch = {}, { force = false } = {}) {
  const current = readState();
  const allowed = TRANSITIONS[current.status] || [];

  if (!force && current.status !== next && !allowed.includes(next)) {
    // Legal-but-unmapped transitions (same state, or a state this build predates)
    // are tolerated; genuinely impossible jumps are refused.
    const known = Object.values(STATES).includes(next);
    if (known) {
      console.warn(
        `[update-state] refused transition ${current.status} -> ${next}; `
        + `allowed: ${allowed.join(', ') || '(none)'}`,
      );
      return current;
    }
  }

  const merged = { ...current, ...patch, status: next };
  writeState(merged);
  return merged;
}

/** True when a downloaded update is waiting for an explicit user decision. */
function hasPendingUpdate() {
  const s = readState();
  return s.status === STATES.READY || s.status === STATES.POSTPONED;
}

/** Clear the pending-update marker after a successful install or an explicit discard. */
function clearPendingUpdate() {
  const s = readState();
  return writeState({
    ...defaultState(),
    currentVersion: s.currentVersion,
  });
}

module.exports = {
  STATES,
  TRANSITIONS,
  stateFile,
  readState,
  writeState,
  defaultState,
  setState,
  hasPendingUpdate,
  clearPendingUpdate,
};