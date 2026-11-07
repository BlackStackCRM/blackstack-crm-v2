require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { migrate } = require('./database/migrate');
const { seed } = require('./database/seed');
const { runSafeMigrations } = require('./services/safeMigrationRunner');
const { APP_VERSION } = require('./version');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const contactsRoutes = require('./routes/contacts');
const organizationsRoutes = require('./routes/organizations');
const dealsRoutes = require('./routes/deals');
const pipelinesRoutes = require('./routes/pipelines');
const productsRoutes = require('./routes/products');
const invoicesRoutes = require('./routes/invoices');
const paymentsRoutes = require('./routes/payments');
const accountingRoutes = require('./routes/accounting');
const activitiesRoutes = require('./routes/activities');
const tasksRoutes = require('./routes/tasks');
const workflowsRoutes = require('./routes/workflows');
const reportsRoutes = require('./routes/reports');
const usersRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const searchRoutes = require('./routes/search');
const auditRoutes = require('./routes/audit');
const leadsRoutes = require('./routes/leads');
const customersRoutes = require('./routes/customers');
const appointmentsRoutes = require('./routes/appointments');
const notificationsRoutes = require('./routes/notifications');
const notesRoutes = require('./routes/notes');

const app = express();

// --- Request correlation IDs -------------------------------------------------
const crypto = require('crypto');
app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  // Accept only safe, sane client-provided IDs; otherwise mint our own.
  const safe = typeof incoming === 'string' && /^[A-Za-z0-9\-_]{1,64}$/.test(incoming) ? incoming : null;
  req.requestId = safe || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// --- Security headers --------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (process.env.ENABLE_HSTS === 'true') {
    // Only enable when the app is actually served over HTTPS.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// --- CORS: configurable allowed origins -------------------------------------
const allowedOrigins = (process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000,http://localhost:5173'))
  .split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin(origin, callback) {
    // Allow same-origin/no-origin (curl, health checks) and configured origins.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false); // reject unexpected origins
  },
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const { camelToSnake, snakeToCamel } = require('./utils/caseConverter');
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    req.body = camelToSnake(req.body);
  }
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    const converted = {};
    Object.keys(req.query).forEach(k => {
      const snakeKey = k.replace(/([A-Z])/g, '_$1').toLowerCase();
      converted[snakeKey] = req.query[k];
    });
    req.query = converted;
  }
  const originalJson = res.json.bind(res);
  res.json = (data) => originalJson(snakeToCamel(data));
  next();
});

// Structured request logging (morgan, with request id).
app.use(morgan((tokens, req, res) => JSON.stringify({
  timestamp: new Date().toISOString(),
  level: 'info',
  requestId: req.requestId,
  method: tokens.method(req, res),
  path: tokens.url(req, res),
  status: parseInt(tokens.status(req, res), 10),
  durationMs: parseFloat(tokens['response-time'](req, res))
})));

// Timeouts: never let a request hang indefinitely (server.ts in app.listen below).
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 30000;

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000,
  message: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' } },
  skip: process.env.NODE_ENV === 'development' || process.env.DEMO_MODE === 'true'
    ? () => true  // Disable rate limiting in development/demo mode
    : undefined,
});
app.use('/api/', limiter);

app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  // Liveness only — no internal details exposed.
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

app.get('/ready', (req, res) => {
  try {
    const { getConn } = require('./utils/db');
    getConn().prepare('SELECT 1').get();
    res.json({ success: true, data: { status: 'ready' } });
  } catch {
    res.status(503).json({ success: false, error: { code: 'NOT_READY', message: 'Database not ready.' } });
  }
});

// --- Retry worker (background cloud sync retry) ---
const { startRetryWorker } = require('./services/retry-worker');

app.use('/api/auth', authRoutes);
// Mother Company / Distribution Agency control (Phase 1).
// Self-guarded: this router applies authMiddleware + requireMotherCompany to
// every route, so mounting it introduces no unauthenticated surface.
app.use('/api/mother-company', require('./routes/motherCompany'));
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/organizations', organizationsRoutes);
app.use('/api/deals', dealsRoutes);
app.use('/api/pipelines', pipelinesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/accounting', accountingRoutes);
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/customer-bills', require('./routes/customer-bills'));
app.use('/api/activities', activitiesRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/workflows', workflowsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/datasafety', require('./routes/dataSafety'));
app.use('/api/agency-control', require('./routes/agencyControl'));
app.use('/api', require('./routes/rbac'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/deletion', require('./routes/deletion'));

app.get('/api', (req, res) => {
  res.json({
    success: true,
    data: {
      name: 'BlackStack CRM V2 API',
      version: APP_VERSION,
      endpoints: [
        '/api/auth', '/api/dashboard', '/api/contacts', '/api/organizations',
        '/api/mother-company',
        '/api/deals', '/api/pipelines', '/api/products', '/api/invoices',
        '/api/payments', '/api/activities', '/api/tasks', '/api/workflows',
        '/api/reports', '/api/users', '/api/settings', '/api/search', '/api/audit',
        '/api/accounting', '/api/customer-bills', '/api/inventory'
      ]
    }
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' } });
});

// Global unhandled rejection and uncaught exception handlers — the server must
// never die silently on a 4xx/5xx API error. Any handler here logs the full
// stack and sends a structured error so the root cause is visible.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION]', {
    reason: reason && reason.message ? reason.message : String(reason),
    stack: reason && reason.stack,
    promise: promise && promise.toString ? promise.toString() : String(promise),
  });
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', {
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack,
  });
  // An uncaught exception can leave process state inconsistent. Fail closed;
  // Electron/service supervision can restart the application cleanly.
  process.exit(1);
});
app.use((err, req, res, next) => {
  // PHASE 3 STEP 3C (CRM-05): the constraint mapping now lives in
  // server/utils/errorMapping.js so it can be unit-tested directly.
  //
  // The previous inline version matched FOREIGN KEY | UNIQUE | NOT NULL | CHECK
  // with one pattern and then emitted the SAME "related records reference this
  // data" message for all four. A duplicate key or a bad enum therefore told the
  // user their record was referenced by dependents, which is false and points
  // them at the wrong problem entirely.
  const { classifyError } = require('./utils/errorMapping');
  const mapped = classifyError(err);
  const isSqliteConstraint = mapped.classification !== 'APPLICATION_ERROR'
    && mapped.classification !== 'INTERNAL';
  if (isSqliteConstraint) {
    const { AppError } = require('./utils/errors');
    err = new AppError(mapped.message, mapped.code, mapped.status);
  }
  const status = mapped.status;
  // Structured error log; never log secrets, passwords, or tokens.
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    userId: req.user?.userId,
    companyId: req.user?.companyId,
    status,
    error: err.code === 'VALIDATION_ERROR' || err.code === 'NOT_FOUND' ? err.message : String(err.message).slice(0, 200)
  }));
  // Stack traces are exposed ONLY under an explicit `NODE_ENV=development`.
  //
  // Verified by scripts/audit-error-disclosure.js: unset -> not exposed,
  // 'production' -> not exposed, 'development' -> exposed. That is the intended
  // arrangement, and it holds for a packaged build because the electron-builder
  // `files` allowlist is ["electron/**","server/**","public/**","package.json"] —
  // it ships no `.env`, so dotenv (line 1) finds nothing and NODE_ENV stays
  // unset. See scripts/audit-stack-exposure.js for the packaging evidence.
  //
  // Keep the comparison explicit rather than inlining a truthiness check: the
  // distinction between "unset" and "explicitly development" is load-bearing,
  // and a future refactor that treats them the same would either leak internals
  // to shipped users or break local debugging.
  const isDev = process.env.NODE_ENV === 'development';
  res.status(status).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 && !isDev ? 'An unexpected internal error occurred.' : (err.message || 'An unexpected internal error occurred.'),
      // Per-field validation detail, when the error carries it.
      //
      // ValidationError accepts a field map (utils/errors.js) and errorMapping
      // preserves it, but this handler rebuilt the response from `err` alone and
      // dropped it, so a client could never tell WHICH input failed — e.g. an
      // agency creation with a duplicate code returned only "Agency validation
      // failed." Forwarded only for VALIDATION_ERROR, and only a plain
      // string->string map, so no internal object can leak.
      ...(err.code === 'VALIDATION_ERROR' && err.fields
        && typeof err.fields === 'object'
        && Object.values(err.fields).every((v) => typeof v === 'string')
        ? { fields: err.fields }
        : {}),
      ...(isDev && { stack: err.stack })
    },
    requestId: req.requestId
  });
});

const PORT = process.env.PORT || 3000;

// SERVER BINDING (spec §20):
//   The desktop app must never expose the CRM on the LAN.
//   - When BLACKSTACK_DESKTOP=1 (set by electron/main.js), bind to 127.0.0.1
//     ONLY. Never 0.0.0.0.
//   - Dev/launcher mode keeps the historic behavior so existing workflows are
//     unaffected.
const HOST = process.env.BLACKSTACK_DESKTOP === '1' ? '127.0.0.1' : undefined;

let server;

/** Start listening; resolves with the http.Server so the Electron host can stop it cleanly. */
function listenOnce(port, host) {
  return new Promise((resolve, reject) => {
    const srv = host ? app.listen(port, host, () => resolve(srv)) : app.listen(port, () => resolve(srv));
    srv.on('error', reject);
  });
}

// PHASE 1 DATA-SAFETY STARTUP FLOW:
//   existing db detected -> verified backup -> idempotent migrations
//   (tracked in schema_migrations; never resets/recreates the database)
//   -> integrity check -> start CRM. On failure: restore verified backup.
//
// Stale-lock policy (Phase 1 hardening):
//   - Lock with a LIVE owner: RECOVERY_REQUIRED -> hard exit (safe block).
//   - Stale lock (owner provably dead): runSafeMigrations recovers it and
//     proceeds safely — a crashed server must not permanently brick startup.
runSafeMigrations({ backup: process.env.MIGRATION_BACKUP !== 'false', recoverStaleLock: true }).then((result) => {
  if (result.status !== 'OK') {
    console.error('[startup] Safe migration returned:', result.status, '-', result.message || '');
    if (result.status === 'RECOVERY_REQUIRED' || result.status.startsWith('ABORTED')) {
      // Do NOT start with an unknown database state and do NOT delete anything.
      console.error('[startup] Recovery required. Database left untouched. Restore the latest verified backup via POST /api/datasafety/backups/restore, then restart.');
      process.exit(1);
    }
    // MIGRATION_FAILED / INTEGRITY_FAILURE without rollback: stop, never continue destructively.
    process.exit(1);
  }
  // Bootstrap seed data ONLY when DEMO_MODE=true (explicit, development-only).
  const demoMode = process.env.DEMO_MODE === 'true';
  // Start the background retry worker AFTER migrations succeeded and the DB
  // connection is bound (runSafeMigrations completed above).
  startRetryWorker();
  const startServer = () => {
    listenOnce(PORT, HOST)
      .then((srv) => {
        server = srv;
        server.keepAliveTimeout = REQUEST_TIMEOUT_MS;
        server.headersTimeout = REQUEST_TIMEOUT_MS + 5000;
        console.log(`BlackStack CRM V2 API running on http://${HOST || '0.0.0.0'}:${PORT} (v${APP_VERSION})`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      })
      .catch((err) => {
        if (err && err.code === 'EADDRINUSE') {
          console.error(`[startup] Port ${PORT} is already in use (EADDRINUSE).`);
        }
        console.error('[startup] Failed to start HTTP server:', err && err.message);
        process.exit(1);
      });
  };
  if (demoMode) {
    seed().then(startServer).catch((err) => {
      console.error('Failed to seed:', err);
      process.exit(1);
    });
  } else {
    startServer();
  }
}).catch((err) => {
  console.error('Failed to run migrations:', err);
  process.exit(1);
});

// --- Graceful shutdown -------------------------------------------------------
async function shutdown(signal) {
  console.log(`[shutdown] ${signal} received; closing server...`);
  // Stop the background retry worker (clears timer, waits for in-flight pass).
  try {
    const { stopRetryWorker } = require('./services/retry-worker');
    stopRetryWorker();
  } catch { /* worker may not have been started */ }
  if (server) {
    server.close(() => {
      try {
        const { getConn } = require('./utils/db');
        getConn().close();
      } catch { /* already closed */ }
      console.log('[shutdown] SQLite connection closed. Exiting.');
      process.exit(0);
    });
    // Force-exit if active requests do not drain in time.
    setTimeout(() => { console.error('[shutdown] Timed out; forcing exit.'); process.exit(1); }, 10000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
