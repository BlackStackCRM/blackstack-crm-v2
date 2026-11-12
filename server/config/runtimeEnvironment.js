const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function readSharedEnvPointer(userDataDir) {
  if (!userDataDir) return null;
  const pointer = path.join(userDataDir, 'shared-env-path.txt');
  try {
    const target = fs.readFileSync(pointer, 'utf8').trim();
    return target ? path.resolve(target) : null;
  } catch {
    return null;
  }
}

function envFromMigratedDatabase(userDataDir) {
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

function resolveSharedEnvPath({ explicitPath, userDataDir, appPath, cwd = process.cwd() } = {}) {
  const candidates = [
    explicitPath || process.env.BLACKSTACK_ENV_PATH,
    readSharedEnvPointer(userDataDir),
    envFromMigratedDatabase(userDataDir),
    path.join(cwd, '.env'),
    appPath && path.join(appPath, '.env'),
    path.resolve(__dirname, '../../.env'),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadRuntimeEnvironment({ envPath, required = false } = {}) {
  const resolvedEnvPath = envPath ? path.resolve(envPath) : null;
  if (!resolvedEnvPath || !fs.existsSync(resolvedEnvPath)) {
    if (required) throw new Error('The shared BlackStack environment file was not found. Set BLACKSTACK_ENV_PATH or create a shared-env-path.txt file in the Electron user-data folder.');
    return { envPath: null, envDir: null, dbPath: process.env.DB_PATH || null };
  }

  const loaded = dotenv.config({ path: resolvedEnvPath, override: false });
  if (loaded.error) throw loaded.error;
  const envDir = path.dirname(resolvedEnvPath);
  process.env.BLACKSTACK_ENV_PATH = resolvedEnvPath;
  process.env.BLACKSTACK_ENV_DIR = envDir;
  if (process.env.DB_PATH) {
    process.env.DB_PATH = path.isAbsolute(process.env.DB_PATH)
      ? path.normalize(process.env.DB_PATH)
      : path.resolve(envDir, process.env.DB_PATH);
  }
  return { envPath: resolvedEnvPath, envDir, dbPath: process.env.DB_PATH || null };
}

module.exports = { resolveSharedEnvPath, loadRuntimeEnvironment };
