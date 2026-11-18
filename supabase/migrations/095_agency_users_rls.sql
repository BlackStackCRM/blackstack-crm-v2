 -- ============================================================================
-- MIGRATION 095 — RLS policies for agency_users / agency_role_assignments
--
-- WHY: 087_distribution_agency_supabase.sql enables RLS on every agency
-- table but defines NO policies (explicit deny-all for non-service roles).
-- Migration 090 added subtree-read policies for profiles/agencies/companies,
-- but missed these two mapping tables. Any future anon/authenticated client
-- path (the planned service-role-key removal milestone) would get zero rows
-- from them — or worse, silently fail.
--
-- POLICY MODEL (matches 090): read scoped to the caller's agency subtree via
-- current_agency_id(); writes stay server-side only (service_role bypasses
-- RLS, unchanged behavior for the Node server).
--
-- TYPE NOTE: the 087 schema uses TEXT primary/foreign keys (agency_id,
-- user_id), while auth.uid() and current_agency_id() return uuid. Every
-- comparison below therefore casts the uuid side with ::text —
-- "text = uuid" raises `operator does not exist: text = uuid`.
--
-- APPLY IN: Supabase SQL Editor. Additive only; no existing table altered.
-- ============================================================================

BEGIN;

-- Helper reuse: 090 defines current_agency_id() (SECURITY DEFINER). Guard in
-- case 090 has not been applied yet on this project.
CREATE OR REPLACE FUNCTION current_agency_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT agency_id FROM profiles WHERE user_id = auth.uid() AND is_active
$$;

-- ── agency_users ─────────────────────────────────────────────────────────────
ALTER TABLE agency_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_users_subtree_read" ON agency_users;
CREATE POLICY "agency_users_subtree_read" ON agency_users
  FOR SELECT TO authenticated
  USING (
    agency_id = current_agency_id()::text
    -- A user may always see their own mapping row, even before their profile
    -- is linked to an agency.
    OR user_id = auth.uid()::text
  );

-- ── agency_role_assignments ──────────────────────────────────────────────────
ALTER TABLE agency_role_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_role_assignments_subtree_read" ON agency_role_assignments;
CREATE POLICY "agency_role_assignments_subtree_read" ON agency_role_assignments
  FOR SELECT TO authenticated
  USING (agency_id = current_agency_id()::text);

COMMIT;
