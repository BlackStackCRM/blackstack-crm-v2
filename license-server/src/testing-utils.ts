import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config/validation.js';
import { createSchema } from './schema.js';

// 1. license server only, created with the server's own DB_PATH
// 2. license server allocates within quota atomically
// 3. device binding challenge-response, one-time nonce
// 4. key rotation: kid, trusted public-key set, revocation
// 5. idempotency: one result per mutation request
// 6. audit log for every privileged action

export interface LicenseRow {
  id: string;
  agency_id: string;
  product_id: string;
  code: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'SUSPENDED';
  device_limit: number;
  lease_days: number;
  allocated: number;
  allocated_at: string;
  expires_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ActivationRow {
  id: string;
  license_id: string;
  device_id: string;
  nonce: string;
  signature: string;
  public_key: string | null;
  status: 'ACTIVE' | 'REVOKED' | 'RECOVERY_PENDING';
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface BindingRow {
  id: string;
  license_id: string;
  device_id: string;
  public_key: string;
  status: 'ACTIVE' | 'REVOKED';
  bound_at: string;
  unbound_at: string | null;
}

export interface PolicyRow {
  lease_days: number;
  max_devices: number;
  revocation_policy: 'server_only' | 'any_server';
}

export interface AuditRow {
  id: string;
  agency_id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  old_values_json: string | null;
  new_values_json: string | null;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  created_at: string;
}

export function createSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    agency_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    device_limit INTEGER NOT NULL DEFAULT 1,
    lease_days INTEGER NOT NULL DEFAULT 30,
    allocated INTEGER NOT NULL DEFAULT 0,
    allocated_at TEXT,
    expires_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS activations (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    signature TEXT NOT NULL,
    public_key TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(license_id, device_id)
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS bindings (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    bound_at TEXT NOT NULL DEFAULT (datetime('now')),
    unbound_at TEXT,
    UNIQUE(license_id, device_id)
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS policy_cache (
    lease_days INTEGER NOT NULL DEFAULT 30,
    max_devices INTEGER NOT NULL DEFAULT 1,
    revocation_policy TEXT NOT NULL DEFAULT 'server_only',
    refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (lease_days, max_devices, revocation_policy)
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    agency_id TEXT,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    old_values_json TEXT,
    new_values_json TEXT,
    ip_address TEXT,
    user_agent TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
}

export function createTestDb(): { db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-server-test-'));
  const dbPath = path.join(dir, 'license.db');
  const db = new Database(dbPath);
  createSchema(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
