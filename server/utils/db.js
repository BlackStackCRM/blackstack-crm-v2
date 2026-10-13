const { DatabaseConnection } = require('../database/connection');

let cachedDb = null;

function getConn() {
  if (!cachedDb) {
    const db = new DatabaseConnection();
    cachedDb = db.connect();
  }
  return cachedDb;
}

const getConnection = getConn;

/**
 * Return the CACHED connection without creating one.
 *
 * PHASE 3A INCIDENT HARDENING. `getConn()` lazily creates and caches a
 * connection bound to whatever DB_PATH was at call time, so a safety guard that
 * calls it can itself establish the binding it is trying to inspect. This
 * returns the existing cache only, or null when nothing has connected yet.
 */
function _peekCachedConnection() {
  return cachedDb || null;
}

/** Close the cached connection (used by backup/restore to unlock the db file). */
function _closeCachedConnection() {
  if (cachedDb) {
    try { cachedDb.close(); } catch { /* already closed */ }
    cachedDb = null;
  }
}

module.exports = { getConn, getConnection, _closeCachedConnection, _peekCachedConnection };