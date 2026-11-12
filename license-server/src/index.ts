/**
 * License-server entry point.
 *
 * Boot order is deliberate and fail-closed:
 *   1. Load .env (if any)
 *   2. Validate config. Refuses to start on missing/weak values or on
 *      DB_PATH resolving to the CRM database.
 *   3. Open license.db, create schema, run migrations.
 *   4. Start Express. The CRM JWT is never accepted here.
 *
 * Uses node:sqlite (built-in, cross-platform). Resolved via createRequire
 * because node:sqlite has no named ESM exports (CJS-only built-in).
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import express from 'express';
import { parseConfig } from './config/validation.js';
import { createSchema } from './db/schema.js';
import { licensesRouter } from './routes/licenses.js';
import { connect } from './db/connection.js';

const require = createRequire(import.meta.url);
const nodeSqlite = require('node:sqlite');
const DatabaseSync = nodeSqlite?.DatabaseSync || nodeSqlite.Database;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const envFile = '.env';

// Load .env only for keys NOT already set in the environment (test
// harnesses and the agent shell set DB_PATH/PORT/JWT_SECRET preferentially).
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (Object.prototype.hasOwnProperty.call(process.env, k)) continue; // already set
    process.env[k] = v;
  }
}

const cfg = parseConfig();
if (cfg.dbPath === 'data/blackstack-crm.db' || cfg.dbPath.startsWith('../data/blackstack-crm.db')) {
  console.error('[license-server] REFUSED: DB_PATH resolves to the CRM database.');
  process.exit(1);
}

const db = connect(cfg.dbPath);
createSchema(db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const app = express();
app.use(express.json());

app.use('/api/licenses', licensesRouter(db, cfg));

app.get('/health', (req, res) => {
  res.json({ ok: true, version: '0.1.0', dbPath: cfg.dbPath });
});

const port = cfg.port;
const server = app.listen(port, () => {
  console.log('[license-server] listening on ' + port);
  console.log('[license-server] dbPath: ' + cfg.dbPath);
});

function shutdown() {
  server.close(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally {
      db.close();
      process.exit(0);
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
