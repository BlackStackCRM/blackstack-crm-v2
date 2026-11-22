/**
 * SUPABASE CONFIGURATION
 *
 * The Supabase project reference is injected at runtime through environment
 * variables. None of these values are logged, stored in the database, or
 * returned to the frontend.
 *
 *   SUPABASE_URL      - https://<project>.supabase.co
 *   SUPABASE_ANON_KEY - public anon key. This is the ONLY Supabase credential
 *                       shipped with the desktop client. It is safe to embed:
 *                       every table read/write it performs is governed by RLS
 *                       policies, and privileged operations (auth.admin.*,
 *                       service-role writes) are NOT permitted with it.
 *   SUPABASE_PROJECT_REF - optional project reference label
 *
 * SECURITY NOTE (client deployments):
 *   The SUPABASE_SERVICE_ROLE_KEY must NEVER be placed in the desktop .env or
 *   the packaged blackstack.env. Any operation that requires the service role
 *   (admin user lookup, cross-tenant reads, sync workers) must run server-side
 *   or in a Supabase Edge Function. The desktop client talks to Supabase only
 *   through:
 *     - supabase.auth.signInWithPassword()  (anon key — Auth API)
 *     - RLS-protected table reads           (own agency rows only)
 */

const { createClient: supabaseCreateClient, SupabaseClient } = require('@supabase/supabase-js');

function isConfigured() {
  const url = process.env.SUPABASE_URL;
  // Accept either key name so dev machines that still export the service role
  // keep working, but production builds only carry SUPABASE_ANON_KEY.
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && key && url.trim() && key.trim());
}

function getSupabaseUrl() {
  return process.env.SUPABASE_URL;
}

/** The PUBLIC client key (anon). Used for auth grants and RLS-scoped reads. */
function getAnonKey() {
  return process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

/**
 * @deprecated Server-to-server sync callers should use a service role from a
 * trusted host environment, never from a desktop install. Kept only so the
 * dev-server sync worker (which has a private .env with the service role)
 * continues to function. Returns the anon key when no service role is present.
 */
function getServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
}

function getProjectRef() {
  return process.env.SUPABASE_PROJECT_REF || null;
}

function getSupabaseClient() {
  if (!isConfigured()) {
    throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_ANON_KEY missing or empty).');
  }
  return supabaseCreateClient(getSupabaseUrl(), getAnonKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

module.exports = {
  isConfigured,
  getSupabaseUrl,
  getAnonKey,
  getServiceRoleKey,
  getProjectRef,
  getSupabaseClient,
  supabaseCreateClient,
};
