/**
 * LOG MANAGER — Phase 2 (§10–§13)
 *
 * Centralized configuration, rotation and redaction for BlackStack logs.
 * Extends the existing logging (electron/main.js appends plain daily files);
 * this module provides:
 *   - write(category, message, meta)  — redacted, category-scoped log lines
 *   - rotateIfNeeded(category)        — size-based rotation
 *   - rotateDaily(category)           — date-based naming
 *   - cleanupOldLogs()                — 30-day retention sweep
 *   - redact(text)                    — secret scrubbing (§13)
 *
 * Safety (§11): rotation never crashes the app, never logs recursively,
 * tolerates missing dirs/permission errors, never deletes the active file.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CATEGORIES = [
  'application', 'database', 'migration', 'backup', 'restore',
  'update', 'installer', 'agent', 'crash', 'security',
];

function defaultConfig() {
  return {
    maxFileBytes: Math.max(1, parseInt(process.env.BLACKSTACK_LOG_MAX_MB || '10', 10)) * 1024 * 1024,
    retainRotated: Math.max(1, parseInt(process.env.BLACKSTACK_LOG_RETAIN || '5', 10)),
    maxAgeDays: Math.max(1, parseInt(process.env.BLACKSTACK_LOG_MAX_AGE_DAYS || '30', 10)),
  };
}

let cfg = defaultConfig();
function configure(overrides = {}) { cfg = { ...cfg, ...overrides }; return cfg; }
function getConfig() { return { ...cfg }; }

/** Redact secrets before anything is written (§13). */
function redact(text) {
  if (text == null) return '';
  let s = typeof text === 'string' ? text : (() => { try { return JSON.stringify(text); } catch { return String(text); } })();
  const patterns = [
    // Bearer / token / api key style assignments and headers
    [/\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi, 'Bearer [REDACTED]'],
    [/(\bAuthorization\b\s*[:=]\s*)[^\r\n]*/gi, '$1[REDACTED]'],
    [/((?:api[_-]?key|apikey|token|password|passwd|pwd|secret|license[_-]?key|refresh[_-]?token|access[_-]?token|session[_-]?cookie)\s*[:=]\s*)\S+/gi, '$1[REDACTED]'],
    [/([A-Za-z0-9+/]{40,}={0,2})/g, '[REDACTED-BASE64]'], // long base64 blobs
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]'],
    [/(postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\/)[^\s]+/gi, '[REDACTED-CONNECTION-STRING]'],
  ];
  for (const [re, repl] of patterns) s = s.replace(re, repl);
  return s;
}

function logDir(baseDir) { return baseDir; }

function logPath(baseDir, category, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return path.join(baseDir, `${category}-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.log`);
}

/** Write one redacted log line. Never throws; never recurses. */
function write(baseDir, category, message, meta) {
  try {
    if (!CATEGORIES.includes(category)) category = 'application';
    fs.mkdirSync(baseDir, { recursive: true });
    const file = logPath(baseDir, category);
    const line = `[${new Date().toISOString()}] [${category}] ${redact(message)}` +
      (meta !== undefined ? ` ${redact(meta)}` : '') + '\n';
    fs.appendFileSync(file, line);
    rotateIfNeeded(baseDir, category);
  } catch { /* logging must never crash the app (§11) */ }
}

/** Size-based rotation (§10). Never deletes the active file. */
function rotateIfNeeded(baseDir, category) {
  try {
    const active = logPath(baseDir, category);
    if (!fs.existsSync(active) || fs.statSync(active).size < cfg.maxFileBytes) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = path.join(baseDir, `${category}-${stamp}.log`);
    // If a rotated file with this exact name exists (same-second), shift it.
    let target = rotated;
    let i = 1;
    while (fs.existsSync(target)) { target = rotated.replace(/\.log$/, `-${i++}.log`); }
    fs.renameSync(active, target);
    pruneRotated(baseDir, category);
  } catch { /* best effort (§11) */ }
}

/** Keep only cfg.retainRotated rotated files for a category. */
function pruneRotated(baseDir, category) {
  try {
    const files = fs.readdirSync(baseDir)
      .filter((f) => f.startsWith(`${category}-`) && f.endsWith('.log') && f !== logPath(baseDir, category) && !/^\w+-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(baseDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(cfg.retainRotated)) {
      try { fs.unlinkSync(path.join(baseDir, f)); } catch { /* permission/lock: skip */ }
    }
  } catch { /* best effort */ }
}

/** Delete logs older than cfg.maxAgeDays (§10). Runs best-effort. */
function cleanupOldLogs(baseDir, now = new Date()) {
  const removed = [];
  try {
    if (!fs.existsSync(baseDir)) return removed;
    const cutoff = now.getTime() - cfg.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(baseDir)) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(baseDir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed.push(f); }
      } catch { /* skip locked files */ }
    }
  } catch { /* best effort */ }
  return removed;
}

/** Run daily + size maintenance at startup (called by electron/main). */
function maintain(baseDir) { return cleanupOldLogs(baseDir); }

module.exports = {
  CATEGORIES, configure, getConfig, redact, write, logPath,
  rotateIfNeeded, cleanupOldLogs, maintain, defaultConfig,
};
