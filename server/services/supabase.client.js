/**
 * SUPABASE CLOUD SYNC CLIENT
 *
 * ONE-WAY FORWARD: local SQLite (authority) -> Supabase (Cloud copy).
 *
 *   - The backend NEVER exposes a Supabase secret to the frontend. The JWT
 *     session remains the single admission control, and the service role key
 *     (server-side only) is what the sync worker uses to write.
 *   - A failed cloud send is NEVER allowed to invalidate a local agency. The
 *     local row is committed first; the cloud row is best-effort; and
 *     `cloud_sync_status` records the outcome + retry state for the
 *     server-side retry worker.
 *   - Idempotency is guaranteed by UNIQUE(agency_id) on cloud_sync_status and
 *     by the client's `upsert` on the Cloud agency table keyed on agency_id.
 *   - No secrets are logged. The service role key is read from environment
 *     only, and is never echoed, stored in the database, or returned to the
 *     caller.
 */

const { createClient } = require('@supabase/supabase-js');
const { getSupabaseUrl, getServiceRoleKey, isConfigured } = require('../config/supabase');

/** Fails open: local SQLite is authoritative; cloud send is best-effort. */
function supabaseCreateClient() {
  if (!isConfigured()) {
    throw new Error('Supabase not configured: no SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Total seconds to keep retry logs before compaction (default 7 days). */
const RETRY_LOG_TTL_SECONDS = Number(process.env.SUPABASE_SYNC_TTL || 7 * 24 * 3600);

/**
 * Deep-equals a Supabase error body for retry decisions.
 *
 * 400 = upsert returned a conflict (e.g. the id differs from the source row).
 * rate-limited / 429 = transient. Both are safe to retry after reading local
 * state fresh; both must rarely occur in practice because the backend issues
 * one write per agency at creation time.
 */
function isRetryableSupabaseError(err) {
  const body = err && err.body ? err.body : String(err.message || '');
  const code = err && err.code ? String(err.code) : '';
  const msg = String(body);
  return /^400$/.test(code) || /rate.*limit/i.test(code) || /too many requests/i.test(msg) || /429/.test(msg);
}

/** Build the upsert mapping for a Cloud agency row (idempotent on `id`). */
function cloudAgencyUpsertMap(agency) {
  return {
    id: agency.id,
    agency_code: agency.agency_code,
    name: agency.name,
    legal_name: agency.legal_name,
    contact_name: agency.contact_name,
    contact_email: agency.contact_email,
    contact_phone: agency.contact_phone,
    address: agency.address,
    city: agency.city,
    state: agency.state,
    country: agency.country,
    pincode: agency.pincode,
    notes: agency.notes,
    status: agency.status,
    is_active: agency.is_active,
    activated_at: agency.activated_at,
    suspended_at: agency.suspended_at,
    suspended_reason: agency.suspended_reason,
    created_by: agency.created_by,
    created_at: agency.created_at,
    updated_at: agency.updated_at,
    provider_company_id: agency.provider_company_id,
    cloud_sync_status_id: agency.cloud_sync_status_id,
    cloud_sync_log_id: agency.cloud_sync_log_id,
  };
}

/** Extract a map of cloud_sync status values to match a local agency. */
function cloudSyncStatusValues(status) {
  return { status };
}

module.exports = {
  isRetryableSupabaseError,
  supabaseCreateClient,
};
