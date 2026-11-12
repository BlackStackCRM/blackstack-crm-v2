-- Reinstall the transactional tenant purge function with explicit predicates
-- on intentionally whole-table deletes. Some Supabase projects enforce
-- pg_safeupdate and reject DELETE statements without a WHERE clause.
CREATE OR REPLACE FUNCTION public.purge_all_tenant_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
SET statement_timeout = '60s'
AS $$
DECLARE
  v_admin_id uuid;
  v_pending text[] := ARRAY[]::text[];
  v_order text[] := ARRAY[]::text[];
  v_table text;
  v_candidate text;
  v_has_children boolean;
  v_progress boolean;
  v_before bigint;
  v_deleted bigint;
  v_auth_deleted bigint := 0;
  v_company_deleted bigint := 0;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id='default') THEN
    RAISE EXCEPTION 'Required default company is missing; cloud purge aborted.';
  END IF;

  SELECT id INTO v_admin_id FROM auth.users
  WHERE lower(coalesce(email,''))='admin@blackstack.local'
  ORDER BY created_at ASC LIMIT 1;

  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_pending
  FROM information_schema.tables t
  WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
    AND t.table_name NOT IN ('companies','roles','permissions','role_permissions','schema_migrations')
    AND t.table_name NOT LIKE 'schema_migrations%';

  -- Delete child tables first; abort on a cycle so PostgreSQL rolls back all.
  WHILE cardinality(v_pending)>0 LOOP
    v_progress := false;
    FOREACH v_candidate IN ARRAY v_pending LOOP
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage child
          ON child.constraint_catalog=tc.constraint_catalog AND child.constraint_schema=tc.constraint_schema
         AND child.constraint_name=tc.constraint_name AND child.table_name=tc.table_name
        JOIN information_schema.constraint_column_usage parent
          ON parent.constraint_catalog=tc.constraint_catalog AND parent.constraint_schema=tc.constraint_schema
         AND parent.constraint_name=tc.constraint_name AND parent.table_name=tc.table_name
        WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'
          AND parent.table_schema='public' AND parent.table_name=v_candidate
          AND child.table_name=ANY(v_pending) AND child.table_name<>v_candidate
      ) INTO v_has_children;
      IF NOT v_has_children THEN
        v_order := array_append(v_order,v_candidate);
        v_pending := array_remove(v_pending,v_candidate);
        v_progress := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_progress THEN
      RAISE EXCEPTION 'Cloud purge found a foreign-key cycle; no data was deleted.';
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY v_order LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',v_table) INTO v_before;
    IF v_table='profiles' AND EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='user_id'
    ) AND v_admin_id IS NOT NULL THEN
      EXECUTE 'DELETE FROM public.profiles WHERE user_id::text<>$1::text' USING v_admin_id;
    ELSIF v_table='user_roles' AND EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='user_roles' AND column_name='user_id'
    ) AND v_admin_id IS NOT NULL THEN
      EXECUTE 'DELETE FROM public.user_roles WHERE user_id::text<>$1::text' USING v_admin_id;
    ELSE
      EXECUTE format('DELETE FROM public.%I WHERE true',v_table);
    END IF;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object(v_table,v_deleted);
  END LOOP;

  DELETE FROM public.companies WHERE id<>'default';
  GET DIAGNOSTICS v_company_deleted = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('companies',v_company_deleted);

  IF v_admin_id IS NULL THEN
    DELETE FROM auth.users WHERE true;
  ELSE
    DELETE FROM auth.users WHERE id<>v_admin_id;
  END IF;
  GET DIAGNOSTICS v_auth_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted',v_counts || jsonb_build_object('authUsers',v_auth_deleted),
    'retained',jsonb_build_object('defaultCompany',true,'adminAuthUser',v_admin_id IS NOT NULL,'systemRolesAndPermissions',true)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_all_tenant_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_all_tenant_data() TO service_role;
