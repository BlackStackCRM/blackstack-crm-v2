/**
 * Single source of truth for the application version.
 * Semantic versioning: MAJOR.MINOR.PATCH
 *
 * Phase 1 of the Electron-preparation work introduced this module so the
 * version is defined in exactly one place. It is exposed to:
 *   - the CRM UI via GET /api/version (see server/routes/version.js)
 *   - the /api info endpoint
 *   - future Electron updater (Phase 2) via require('./server/version')
 *
 * PHASE D STEP 2 (2026-10-07) — the version is read from package.json.
 *
 * This used to be a hard-coded literal ('1.0.0'). That is wrong for a packaged
 * app: electron-builder injects the real version into the packaged
 * package.json, so a genuinely installed v1.0.1 still reported 1.0.0. It also
 * feeds `currentVersion` in the update state machine, so the updater compared
 * updates against a stale version.
 *
 * package.json remains the single source of truth. The literal is only a
 * last-resort fallback if package.json cannot be read.
 */
const { readFileSync } = require('fs');
const { join } = require('path');

const FALLBACK_VERSION = '1.0.0';

function readPackageVersion() {
  // server/version.js -> <repo>/server/version.js, so package.json is one level up.
  const candidates = [
    join(__dirname, '..', 'package.json'),      // source / unpacked asar
    join(__dirname, '..', '..', 'package.json'), // extra nesting safety
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      if (pkg && typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) {
        return pkg.version;
      }
    } catch { /* try the next candidate */ }
  }
  return FALLBACK_VERSION;
}

const APP_VERSION = readPackageVersion();
const APP_NAME = 'BlackStack CRM';

/** Minimum database schema version this application build supports. */
const MIN_SCHEMA_VERSION = 1;

function parseVersion(v) {
  const parts = String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

/** Compare two semver strings. Returns -1, 0 or 1. */
function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (A[key] !== B[key]) return A[key] < B[key] ? -1 : 1;
  }
  return 0;
}

function getVersionInfo() {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    minSchemaVersion: MIN_SCHEMA_VERSION,
  };
}

module.exports = { APP_VERSION, APP_NAME, MIN_SCHEMA_VERSION, parseVersion, compareVersions, getVersionInfo };
