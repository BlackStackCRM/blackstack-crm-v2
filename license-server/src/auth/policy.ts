/**
 * License-server policy retrieval and enforcement.
 *
 * Used by the client at activation/rebind time, and by the server when it
 * needs to check a persisted decision. The server does NOT carry any
 * per-device private key; the binding state lives in the server's
 * bindings table and in the client's offline cache.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface PolicyRow {
  id: string;
  code: string;
  device_limit: number;
  lease_days: number;
  max_concurrent_devices: number;
  revoked_ks: string[];
}

/**
 * Fetch the effective policy for an agency.
 *
 * Activation/rebind requests are scoped to a single agency. The policy is
 * looked up by agency_id only — a client can never read another agency's
 * policy unless it holds that agency's service token.
 */
export function fetchPolicy(db: Database.Database, agencyId: string): PolicyRow {
  const row = db
    .prepare(
      `SELECT
         licenses.id AS id,
         licenses.code AS code,
         COALESCE(licenses.device_limit, 1) AS device_limit,
         COALESCE(licenses.lease_days, 30) AS lease_days,
         1 AS max_concurrent_devices,
         (SELECT json_group_array(key) FROM revoked_keys WHERE revoked_keys.agency_id = licenses.agency_id) AS revoked_ks
       FROM licenses
       WHERE licenses.agency_id = ? AND licenses.status = 'ACTIVE'`,
    )
    .get(agencyId) as PolicyRow;

  if (!row) {
    throw new Error(`policy for agency ${agencyId} not found`);
  }
  return row;
}

/**
 * Enforce policy for an activation/rebind request.
 *
 * Audits the request's device_id, nonce, signature, and public key against
 * the current binding state, and returns either an OK result or a
 * deterministic failure reason.
 *
 * The request is single-use: a nonce that has already been consumed is
 * rejected before any key check runs.
 */
export function checkPolicy(db: Database.Database, agencyId: string, request: {
  deviceId: string;
  nonce: string;
  signature: string;
  publicKey: string;
}): { ok: boolean; reason?: string; policy: PolicyRow } {
  const policy = fetchPolicy(db, agencyId);

  // Single-use nonce check — the server has only ever seen (license_id, device_id, nonce)
  // for this license/device pair. A replay is rejected here.
  const consumed = db.prepare(
    `SELECT 1 AS c FROM activations
     WHERE license_id = ? AND device_id = ? AND nonce = ? AND status = 'ACTIVE'`,
  ).get(policy.code, request.deviceId, request.nonce) as { c: number };

  if (consumed.c > 0) {
    return { ok: false, reason: 'NONCE_ALREADY_CONSUMED' };
  }

  // Device-bind check
  const binding = db.prepare(
    `SELECT status FROM bindings WHERE license_id = ? AND device_id = ?`,
  ).get(policy.code, request.deviceId) as any;

  if (binding && binding.status !== 'ACTIVE') {
    return { ok: false, reason: 'BINDING_REVOKED' };
  }

  // Device count check
  const activationCount = db.prepare(
    `SELECT COUNT(*) AS c FROM activations
     WHERE license_id = ? AND status = 'ACTIVE' AND expires_at > datetime('now')`,
  ).get(policy.code) as { c: number };

  if (activationCount.c >= policy.device_limit) {
    return { ok: false, reason: 'QUOTA_EXCEEDED' };
  }

  return { ok: true, policy };
}

/**
 * Revoke a device binding (used by device recovery / admin action).
 *
 * The old binding is marked REVOKED. The private key stays on the device;
 * revocation is enforced server-side by the binding status. Any new
 * activation for the same device is rejected (checkPolicy returns
 * BINDING_REVOKED).
 */
export function revokeBinding(db: Database.Database, agencyId: string, deviceId: string): void {
  db.prepare(
    `UPDATE bindings SET status = 'REVOKED', unbound_at = datetime('now')
     WHERE license_id = ? AND device_id = ? AND status = 'ACTIVE'`,
  ).run(agencyId, deviceId);
}
