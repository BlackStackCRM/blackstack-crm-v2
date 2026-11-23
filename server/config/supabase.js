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

/**
 * P2 (fail-closed, audit §26.7 R3): a DESKTOP build must NEVER fall back to
 * the service-role key. Historically this fallback made a desktop install
 * that carried SUPABASE_SERVICE_ROLE_KEY in its env silently operate with
 * full admin privileges (auth.admin.*, cross-tenant writes). Packaged builds
 * set BLACKSTACK_DESKTOP=1 (electron/main.js) — under that flag only the
 * public anon/publishable key is accepted. Server/CI processes (no desktop
 * flag) keep the legacy fallback for the local dev sync worker.
 */
function isDesktopBuild() {
  return process.env.BLACKSTACK_DESKTOP === '1' || process.env.BLACKSTACK_DESKTOP === 'true';
}

function isConfigured() {
  const url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY;
  if (!isDesktopBuild()) {
    // Server/CI fallback retained (dev sync worker needs the service role).
    key = key || process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  return Boolean(url && key && url.trim() && key.trim());
}

function getSupabaseUrl() {
  return process.env.SUPABASE_URL;
}

/** The PUBLIC client key (anon). Used for auth grants and RLS-scoped reads. */
function getAnonKey() {
  // P2 fail-closed: desktop builds NEVER read the service-role key.
  if (isDesktopBuild()) return process.env.SUPABASE_ANON_KEY || null;
  return process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

/**
 * @deprecated Server-to-server sync callers should use a service role from a
 * trusted host environment, never from a desktop install. Under
 * BLACKSTACK_DESKTOP=1 this deliberately returns NULL (fail-closed) even if
 * the variable is present in the environment.
 */
function getServiceRoleKey() {
  if (isDesktopBuild()) return null;
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
