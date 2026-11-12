/**
 * License-server database schema.
 *
 * SEPARATE database from the CRM.
 *   CRM : data/blackstack-crm.db  (unchanged, never written by this server)
 *   lic : license.db             (this server's only data)
 *
 * The license server never opens the CRM database. Config guard in
 * config/validation.ts refuses to start if DB_PATH would resolve to the CRM
 * file. Everything below is owned by this service.
 *
 * Uses node:sqlite (built-in, cross-platform, no native addon needed).
 */
import { Database } from 'node:sqlite';

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

export function createSchema(db: Database.DatabaseSync): void {
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
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(license_id, device_id)
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS bindings (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    bound_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    unbound_at TEXT,
    UNIQUE(license_id, device_id)
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS policy_cache (
    lease_days INTEGER NOT NULL DEFAULT 30,
    max_devices INTEGER NOT NULL DEFAULT 1,
    revocation_policy TEXT NOT NULL DEFAULT 'server_only',
    refreshed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
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
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  );`);

  // Idempotency table: single-row-per-key store used by the allocation
  // middleware. The row is written atomically with the license allocation
  // (see src/middleware/quota.ts) so that allocation + idempotency record
  // commit together (or both roll back on failure).
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    status INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    created_license_ids TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  );`);
}
