-- ============================================================================
-- MIGRATION 096 (rev 2) — RLS hardening: profiles + agency_users isolation
--
-- FIXES vs rev 1 (found in architecture audit):
--   * rev 1 walked a non-existent agencies.parent_agency_id column. The real
--     hierarchy lives in agency_parent_relationships (007/090); we now reuse
--     090's proven visible_agency_ids() helper instead of re-inventing it.
--   * rev 1 WIDENED the profiles read policy to the whole subtree, regressing
--     090's rule "a user may read only their own profile". Rev 2 restores
--     self-only read: tenant isolation must never broaden profile exposure.
--
-- SECURITY INVOKER NOTE: with the anon key the desktop client authenticates as
-- the user (JWT from signInWithPassword); auth.uid() then resolves to that
-- user and these policies apply. service_role bypasses RLS entirely, so the
-- trusted Node server / Edge Functions keep full access for provisioning.
--
-- APPLY IN: Supabase SQL Editor (as project owner). Idempotent; safe to re-run.
-- ============================================================================

BEGIN;

-- ── Helpers (090 definitions kept intact; recreated only as a guard) ─────────
CREATE OR REPLACE FUNCTION current_agency_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT agency_id FROM profiles WHERE user_id = auth.uid() AND is_active
$$;

CREATE OR REPLACE FUNCTION visible_agency_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE tree AS (
    SELECT current_agency_id() AS id
    UNION ALL
    SELECT r.child_agency_id
    FROM agency_parent_relationships r
    JOIN tree t ON r.parent_agency_id = t.id
  )
  SELECT id FROM tree WHERE id IS NOT NULL
$$;

-- ============================================================================
-- 1. profiles — SELF-ONLY read (090 semantics preserved; no broadening)
-- ============================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_self_or_subtree_read" ON profiles;
DROP POLICY IF EXISTS "profiles_self_read" ON profiles;
CREATE POLICY "profiles_self_read" ON profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Self-service update only (full_name etc.). role / agency_id / is_active
-- changes stay server-managed: service_role bypasses RLS.
DROP POLICY IF EXISTS "profiles_self_update" ON profiles;
CREATE POLICY "profiles_self_update" ON profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Insert/delete: server-side provisioning only.
DROP POLICY IF EXISTS "profiles_no_client_insert" ON profiles;
CREATE POLICY "profiles_no_client_insert" ON profiles
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "profiles_no_client_delete" ON profiles;
CREATE POLICY "profiles_no_client_delete" ON profiles
  FOR DELETE TO authenticated USING (false);

-- ============================================================================
-- 2. agency_users — mapping table (TEXT keys per migration 087)
-- ============================================================================
ALTER TABLE agency_users ENABLE ROW LEVEL SECURITY;

-- Read: your own mapping row, or rows inside your agency subtree.
-- (This is a mapping table, not personal data — subtree visibility here is
-- required for the app to render its own users, and stays inside the tenant
-- boundary. Personal profile data remains self-only via `profiles`.)
DROP POLICY IF EXISTS "agency_users_subtree_read" ON agency_users;
CREATE POLICY "agency_users_subtree_read" ON agency_users
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()::text
    OR agency_id IN (SELECT visible_agency_ids()::text)
  );

-- Writes stay server-side only.
DROP POLICY IF EXISTS "agency_users_no_client_write" ON agency_users;
CREATE POLICY "agency_users_no_client_write" ON agency_users
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "agency_users_no_client_update" ON agency_users;
CREATE POLICY "agency_users_no_client_update" ON agency_users
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS "agency_users_no_client_delete" ON agency_users;
CREATE POLICY "agency_users_no_client_delete" ON agency_users
  FOR DELETE TO authenticated USING (false);

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES (run afterwards in the SQL Editor)
--
-- Policies present:
--   SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE tablename IN ('profiles','agency_users') ORDER BY 1,2;
--
-- RLS enabled:
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('profiles','agency_users');
--
-- Isolation smoke tests (as an authenticated user of agency A):
--   -- 1. profile exposure is SELF-ONLY:
--   SELECT count(*) FROM profiles;                       -- must be 1
--   -- 2. no cross-tenant mapping rows:
--   SELECT count(*) FROM agency_users
--    WHERE agency_id NOT IN (SELECT visible_agency_ids()::text)
--      AND user_id <> auth.uid()::text;                  -- must be 0
-- ============================================================================
