-- Transactional Supabase side of the Platform Admin Factory Reset.
-- Apply this migration in Supabase before enabling the cloud checkbox.
-- The function is callable only with the server-side service role key.

CREATE OR REPLACE FUNCTION public.purge_all_tenant_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  tenant_user_ids uuid[];
  users_deleted integer := 0;
  agencies_deleted integer := 0;
  companies_deleted integer := 0;
  assignments_deleted integer := 0;
  agency_audit_entries_deleted integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = 'default') THEN
    RAISE EXCEPTION 'Required default company is missing; cloud purge aborted.';
  END IF;

  SELECT COALESCE(array_agg(user_id), ARRAY[]::uuid[])
    INTO tenant_user_ids
    FROM public.profiles;

  -- Remove restrictive child links first. All statements run in this one
  -- PostgreSQL function transaction, so any error restores the cloud state.
  DELETE FROM public.agency_parent_relationships;
  DELETE FROM public.customer_tenant_agency_history;
  DELETE FROM public.customer_tenant_agencies;
  GET DIAGNOSTICS assignments_deleted = ROW_COUNT;
  DELETE FROM public.agency_administrators;
  DELETE FROM public.agency_status_history;
  DELETE FROM public.agency_audit_entries;
  GET DIAGNOSTICS agency_audit_entries_deleted = ROW_COUNT;

  -- Profiles only represent tenant roles (agency/sub-agency/customer tenant).
  -- Auth users without a profile are left untouched.
  DELETE FROM auth.users WHERE id = ANY (tenant_user_ids);
  GET DIAGNOSTICS users_deleted = ROW_COUNT;

  DELETE FROM public.agencies;
  GET DIAGNOSTICS agencies_deleted = ROW_COUNT;
  DELETE FROM public.companies WHERE id <> 'default';
  GET DIAGNOSTICS companies_deleted = ROW_COUNT;
  RETURN jsonb_build_object(
    'users', users_deleted,
    'agencies', agencies_deleted,
    'companies', companies_deleted,
    'customerAssignments', assignments_deleted,
    'agencyAuditEntries', agency_audit_entries_deleted,
    'defaultCompanyPreserved', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_all_tenant_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_all_tenant_data() TO service_role;
