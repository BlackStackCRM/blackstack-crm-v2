-- ============================================================================
-- 090_role_based_access.sql — Role-based access for the 3-level hierarchy
--
-- ROLES
--   agency           (L1) may create sub-agencies + customer tenants in its subtree
--   sub_agency       (L2) may create customer tenants under ITSELF only
--   customer_tenant  (L3) read-only on its own data
--
-- DESIGN NOTES
--   * profiles is 1:1 with auth.users (keyed by user_id). It carries the
--     username (Supabase Auth requires an email at signup; username is a
--     separate UNIQUE column resolved server-side at login).
--   * role + agency_id are SET BY THE SERVER in auth.users.app_metadata
--     (server-only table, never client-editable). profiles mirrors them for
--     plain SQL querying (RLS helper functions cannot read app_metadata
--     directly; they read profiles).
--   * parent_user_id records who created the account (chain of custody).
--   * must_change_password forces a password change on first login.
--   * is_active is the deactivate switch (revoked admins flip it).
--   * NO client path exists to these tables: every write goes through the
--     Node server with service_role, which bypasses RLS. RLS below is
--     defense-in-depth for a hypothetical future client path (audit F4/F5).
--
-- APPLY IN: Supabase SQL Editor. Additive only; no existing table altered.
-- ============================================================================

BEGIN;

-- ── 1. profiles ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username             text UNIQUE NOT NULL,
  role                 text NOT NULL CHECK (role IN ('agency','sub_agency','customer_tenant')),
  agency_id            uuid REFERENCES agencies(id),
  parent_user_id       uuid REFERENCES auth.users(id),
  must_change_password boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_agency ON profiles(agency_id);
CREATE INDEX IF NOT EXISTS idx_profiles_parent ON profiles(parent_user_id);

-- ── 2. helper functions (SECURITY DEFINER so RLS policies can call them
--      without recursive policy evaluation; search_path pinned) ───────────────
CREATE OR REPLACE FUNCTION current_role_name() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM profiles WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION current_agency_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT agency_id FROM profiles WHERE user_id = auth.uid() AND is_active
$$;

-- The caller's agency subtree: itself + all descendants (agency → subs →
-- sub-subs). Walks agency_parent_relationships transitively.
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

-- Is `target` inside the caller's subtree (or the caller's own agency)?
CREATE OR REPLACE FUNCTION in_my_subtree(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT target IN (SELECT visible_agency_ids())
$$;

-- ── 3. RLS policies (defense-in-depth; service_role bypasses these) ─────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- A user may read only their own profile.
DROP POLICY IF EXISTS "profiles_self_read" ON profiles;
CREATE POLICY "profiles_self_read" ON profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agencies_subtree_read" ON agencies;
CREATE POLICY "agencies_subtree_read" ON agencies
  FOR SELECT TO authenticated
  USING (id IN (SELECT visible_agency_ids()));

ALTER TABLE agency_parent_relationships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rel_subtree_read" ON agency_parent_relationships;
CREATE POLICY "rel_subtree_read" ON agency_parent_relationships
  FOR SELECT TO authenticated
  USING (parent_agency_id IN (SELECT visible_agency_ids())
      OR child_agency_id  IN (SELECT visible_agency_ids()));

ALTER TABLE customer_tenant_agencies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cta_subtree_read" ON customer_tenant_agencies;
CREATE POLICY "cta_subtree_read" ON customer_tenant_agencies
  FOR SELECT TO authenticated
  USING (agency_id IN (SELECT visible_agency_ids()));

-- companies: readable only where the row is the caller's own tenant company
-- or a company mapped into the caller's subtree. companies carries no
-- agency_id, so scope through the mapping table.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "companies_subtree_read" ON companies;
CREATE POLICY "companies_subtree_read" ON companies
  FOR SELECT TO authenticated
  USING (
    id::text IN (SELECT visible_agency_ids()::text)           -- agency's own tenant company
    OR id::text IN (
      SELECT cta.company_id::text FROM customer_tenant_agencies cta
      WHERE cta.agency_id::text IN (SELECT visible_agency_ids()::text)
    )
  );

COMMIT;
