/**
 * SUPABASE CONFIGURATION
 *
 * The Supabase project reference is injected at runtime through environment
 * variables. None of these values are logged, stored in the database, or
 * returned to the frontend.
 *
 *   SUPABASE_URL          - https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY - server-side service role key (used for the
 *                               server-to-server sync worker only; never
 *                               sent to the browser)
 *   SUPABASE_PROJECT_REF  - optional project reference label (e.g.
 *                           qzxvcxywotqeqvwerofi)
 *
 * The local database is the CRM's authority. Cloud sync is a best-effort
 * forward: every sync call returns `{ ok, localAffected }` with no secret in
 * the response, and a failed send is recorded in `cloud_sync_status`.
 */

const { createClient: supabaseCreateClient, SupabaseClient } = require('@supabase/supabase-js');

function isConfigured() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && key && url.trim() && key.trim());
}

function getSupabaseUrl() {
  return process.env.SUPABASE_URL;
}

function getServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function getProjectRef() {
  return process.env.SUPABASE_PROJECT_REF || null;
}

function getSupabaseClient() {
  if (!isConfigured()) {
    throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing or empty).');
  }
  return supabaseCreateClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

module.exports = {
  isConfigured,
  getSupabaseUrl,
  getServiceRoleKey,
  getProjectRef,
  getSupabaseClient,
  supabaseCreateClient,
};
