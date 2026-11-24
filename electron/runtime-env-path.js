/**
 * RUNTIME ENV RESOLUTION (shared with electron/main.js).
 *
 * Single source of truth for "which .env file is the running application
 * using". electron/main.js ensureLocalRuntimeConfig() and the server-side
 * runtimeEnvironment.resolveSharedEnvPath() must agree on this; duplicating
 * the logic caused the second-PC incident (repair patched the default AppData
 * path while the server actually read C:\BlackStackData\.env).
 *
 * Resolution order (first existing file wins):
 *   1. explicitPath / BLACKSTACK_ENV_PATH
 *   2. shared-env-path.txt in the user-data dir
 *   3. MIGRATED_FROM.txt marker
 *   4. cwd/.env
 *   5. appPath/.env
 *   6. <project root>/.env
 * Falls back to the canonical default (%APPDATA%\blackstack-crm-v2\data\.env)
 * for provisioning when none exists — a non-existing pointer target is also
 * treated as "provision/repair at that exact path" so custom shared data
 * directories (e.g. C:\BlackStackData) are honoured.
 */

const fs = require('fs');
const path = require('path');

function readPointer(userDataDir) {
  if (!userDataDir) return null;
  const pointer = path.join(userDataDir, 'shared-env-path.txt');
  try {
    const target = fs.readFileSync(pointer, 'utf8').trim();
    return target ? path.resolve(target) : null;
  } catch {
    return null;
  }
}

function fromMigratedDatabase(userDataDir) {
  if (!userDataDir) return null;
  const marker = path.join(userDataDir, 'database', 'MIGRATED_FROM.txt');
  try {
    const text = fs.readFileSync(marker, 'utf8');
    const match = /^Migrated from:\s*(.+)$/mi.exec(text);
    if (!match) return null;
    const migratedDb = path.resolve(match[1].trim());
    const dataDir = path.dirname(migratedDb);
    return path.join(path.dirname(dataDir), '.env');
  } catch {
    return null;
  }
}

/** Default runtime env path for THIS installation. */
function defaultRuntimeEnvPath() {
  return path.join(process.env.APPDATA || '', 'blackstack-crm-v2', 'data', '.env');
}

/**
 * Resolve the runtime .env path. Returns the first EXISTING candidate; when
 * none exists, returns the pointer target (if declared) or the canonical
 * default, so provisioning/repair writes to the location the server will
 * actually resolve next launch.
 *
 * @param {object} opts { explicitPath, userDataDir, appPath, cwd }
 * @returns {{ envPath: string, exists: boolean, source: string }}
 */
function resolveRuntimeEnvPath({ explicitPath, userDataDir, appPath, cwd = process.cwd() } = {}) {
  const candidates = [
    { p: explicitPath || process.env.BLACKSTACK_ENV_PATH, src: 'explicit' },
    { p: readPointer(userDataDir), src: 'shared-env-path.txt' },
    { p: fromMigratedDatabase(userDataDir), src: 'MIGRATED_FROM.txt' },
    { p: cwd ? path.join(cwd, '.env') : null, src: 'cwd' },
    { p: appPath ? path.join(appPath, '.env') : null, src: 'appPath' },
    { p: path.resolve(__dirname, '../../.env'), src: 'project-root' },
  ].filter((c) => c.p).map((c) => ({ p: path.resolve(c.p), src: c.src }));

  const existing = candidates.find((c) => { try { return fs.existsSync(c.p); } catch { return false; } });
  if (existing) return { envPath: existing.p, exists: true, source: existing.src };

  // None exists: prefer the declared pointer target, else the canonical default.
  const declared = candidates.find((c) => c.src === 'shared-env-path.txt');
  if (declared) return { envPath: declared.p, exists: false, source: 'shared-env-path.txt (declared, missing)' };
  return { envPath: defaultRuntimeEnvPath(), exists: false, source: 'canonical-default' };
}

/** Locate the packaged blackstack.env next to the running executable. */
function findPackagedEnvPath() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, '..', 'resources', 'blackstack.env'),
    path.join(dir, 'resources', 'blackstack.env'),
    path.join(dir, 'blackstack.env'),
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

module.exports = {
  resolveRuntimeEnvPath,
  findPackagedEnvPath,
  defaultRuntimeEnvPath,
  readPointer,
};
