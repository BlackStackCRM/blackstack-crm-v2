/**
 * SUPPORT BUNDLE — Phase 2 (§23–§27)
 *
 * Manually initiated ZIP with sanitized diagnostics. HARD RULES:
 *  - NEVER includes CRM records or the database file (§25).
 *  - Every text file is REDACTED into a temp copy before packaging (§26).
 *  - Temp files live in the OS temp dir and are cleaned after packaging.
 *  - Nothing is uploaded automatically (§27).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getUserDataRoot, paths, getDatabasePath } = require('../config/userDataPath');
const { APP_VERSION } = require('../version');
const { redact } = require('./logManager');
const { getBackupStatus } = require('./backupService');
const { getStorageStatus } = require('./storageMonitor');
const { UpdateService } = require('./updateService');

function schemaInfo() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(getDatabasePath(), { readOnly: true });
    try {
      const mig = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
      const history = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
      return { maxSchemaVersion: mig ? mig.v : null, migrationCount: history.length, lastMigrations: history.slice(-5) };
    } finally { db.close(); }
  } catch (e) { return { error: 'database not readable: ' + e.message }; }
}

function safeJson(fn, fallback) { try { return fn(); } catch (e) { return { error: String(e.message || e) }; } }

/** Collect sanitized metadata (no CRM data, no secrets). */
function collectSystemInfo() {
  return {
    application: { name: 'BlackStack CRM', version: APP_VERSION },
    electron: safeJson(() => require('electron/package.json').version, 'bundled'),
    node: process.versions.node,
    platform: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    userDataRoot: getUserDataRoot(),
    databaseSchema: schemaInfo(),
    backupStatus: getBackupStatus(),
    storage: getStorageStatus(),
    updateStatus: null, // filled async below when possible
  };
}

/**
 * Generate the bundle. Returns { file, bytes, contents } or throws.
 * @param {string} outPath where to write the ZIP (defaults to %TEMP%)
 */
async function generateSupportBundle({ outPath } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-bundle-'));
  try {
    const info = collectSystemInfo();
    try { info.updateStatus = await UpdateService.getUpdateStatus(); } catch { info.updateStatus = { status: 'UNKNOWN' }; }
    // Agent health: the desktop app runs no separate Agent process (see FAQ).
    info.agent = { present: false, note: 'No separate Agent process exists; CRM backend runs in-process.' };

    fs.writeFileSync(path.join(tempDir, 'system-info.json'), JSON.stringify(info, null, 2));

    // Sanitized logs: redacted copies only, originals untouched (§26).
    const logsDir = path.join(getUserDataRoot(), 'logs');
    const logFiles = [];
    if (fs.existsSync(logsDir)) {
      for (const f of fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')).slice(-10)) {
        try {
          const raw = fs.readFileSync(path.join(logsDir, f), 'utf8');
          fs.writeFileSync(path.join(tempDir, 'log-' + f), redact(raw.slice(-512 * 1024))); // last 512 KB max
          logFiles.push(f);
        } catch { /* unreadable log: skip */ }
      }
    }

    // Crash logs (redacted).
    const crashDir = path.join(logsDir, 'crashes');
    if (fs.existsSync(crashDir)) {
      for (const f of fs.readdirSync(crashDir).filter((f) => f.endsWith('.log')).slice(-5)) {
        try {
          const raw = fs.readFileSync(path.join(crashDir, f), 'utf8');
          fs.writeFileSync(path.join(tempDir, 'crash-' + f), redact(raw.slice(-256 * 1024)));
        } catch { /* skip */ }
      }
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      note: 'Sanitized diagnostics only. No CRM records, database, uploads or unredacted logs are included.',
      logFiles,
    };
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Prefer the archiver package if available; otherwise a minimal
    // stored (uncompressed) ZIP writer — no external tools, no upload.
    const target = outPath || path.join(os.tmpdir(), `blackstack-support-bundle-${Date.now()}.zip`);
    try {
      const archiver = require('archiver');
      await zipWithArchiver(tempDir, target);
    } catch {
      zipMinimal(tempDir, target);
    }
    return {
      file: target,
      bytes: fs.statSync(target).size,
      contents: ['system-info.json', 'manifest.json', ...logFiles.map((f) => 'log-' + f)],
      message: 'Support bundle created successfully. Please review the contents before sharing it with support.',
    };
  } finally {
    // Clean temp copies (§27).
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function zipWithArchiver(srcDir, target) {
  return new Promise((resolve, reject) => {
    const archiver = require('archiver');
    const output = fs.createWriteStream(target);
    const ar = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve());
    ar.on('error', reject);
    ar.pipe(output);
    ar.directory(srcDir, false);
    ar.finalize();
  });
}

/** Minimal stored-ZIP writer (no dependencies) — small sanitized files only. */
function zipMinimal(srcDir, target) {
  const entries = fs.readdirSync(srcDir).map((f) => {
    const data = fs.readFileSync(path.join(srcDir, f));
    const nameBuf = Buffer.from(f, 'utf8');
    const crcTable = crcTable_();
    let crc = 0xFFFFFFFF;
    for (const b of data) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xFF];
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    return { nameBuf, data, crc };
  });
  const chunks = [];
  let offset = 0;
  const central = [];
  for (const e of entries) {
    e.offset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(e.crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(e.nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, e.nameBuf, e.data);
    offset += local.length + e.nameBuf.length + e.data.length;
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(e.crc, 16); cd.writeUInt32LE(e.data.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(e.offset, 42);
    central.push(Buffer.concat([cd, e.nameBuf]));
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(target, Buffer.concat([...chunks, cdBuf, eocd]));
}

function crcTable_() {
  if (crcTable_.t) return crcTable_.t;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable_.t = t;
  return t;
}

module.exports = { generateSupportBundle, collectSystemInfo, redact };
