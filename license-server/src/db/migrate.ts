#!/usr/bin/env node
/**
 * Run versioned migrations against the license database.
 *
 * Fail-closed: never migrates the CRM database. The path comes from
 * config/validation.ts, which refuses DB_PATH that resolves to
 * data/blackstack-crm.db.
 */
import { Database } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { config } from '../config/validation.js';
import { createSchema } from './schema.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Load .env if present (simple dotenv, key=val, # comment).
const dotenvPath = path.join(ROOT, '.env');
if (fs.existsSync(dotenvPath)) {
  for (const line of fs.readFileSync(dotenvPath, 'utf8').split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const cfg = config(process.env);
if (cfg.dbPath === 'data/blackstack-crm.db' || cfg.dbPath.startsWith('../data/blackstack-crm.db')) {
  console.error('[license-server:migrate] REFUSED: DB_PATH resolves to the CRM database.');
  console.error('[license-server:migrate] Aborting. The license server never writes to the CRM.');
  process.exit(1);
}

const db = new Database(cfg.dbPath);
createSchema(db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Versioned migrations live in src/db/migrations/ as .sql files.
const dir = path.join(ROOT, 'src', 'db', 'migrations');
if (!fs.existsSync(dir)) {
  console.error('[migrate] migrations dir missing, nothing to apply');
} else {
  for (const f of fs.readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.exec(sql);
    console.log(`[migrate] applied ${f}`);
  }
}
db.close();
console.log('[migrate] done');
