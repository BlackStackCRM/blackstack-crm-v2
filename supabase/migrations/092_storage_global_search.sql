-- Platform-only global Storage search over public tables.
-- The backend uses the service-role client after its platform-role guard;
-- this RPC is not callable by browser/authenticated roles.
CREATE OR REPLACE FUNCTION public.storage_search_redact_jsonb(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result jsonb;
  v_text text;
BEGIN
  IF jsonb_typeof(p_value) = 'object' THEN
    SELECT coalesce(jsonb_object_agg(e.key, public.storage_search_redact_jsonb(e.value)), '{}'::jsonb)
      INTO v_result FROM jsonb_each(p_value) e
      WHERE e.key !~* '(password|token|secret|api.?key|private.?key|credential|authorization|hash|salt|cookie)';
    RETURN v_result;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    SELECT coalesce(jsonb_agg(public.storage_search_redact_jsonb(e.value)), '[]'::jsonb)
      INTO v_result FROM jsonb_array_elements(p_value) e(value);
    RETURN v_result;
  ELSIF jsonb_typeof(p_value) = 'string' THEN
    v_text := p_value #>> '{}';
    IF left(btrim(v_text), 1) IN ('{', '[') THEN
      BEGIN
        RETURN public.storage_search_redact_jsonb(v_text::jsonb);
      EXCEPTION WHEN others THEN
        NULL;
      END;
    END IF;
    RETURN to_jsonb(regexp_replace(v_text, 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED TOKEN]', 'g'));
  END IF;
  RETURN p_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.storage_search_data(
  p_search_term text,
  p_max_results integer DEFAULT 300
)
RETURNS TABLE (
  table_name text,
  record_id text,
  row_data jsonb,
  matched_columns text[],
  relation_type text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '20s'
AS $$
DECLARE
  v_query text := btrim(coalesce(p_search_term, ''));
  v_pattern text;
  v_sensitive text := '(password|token|secret|api.?key|private.?key|credential|authorization|hash|salt|cookie)';
  v_table record;
  v_column record;
  v_sql text;
  v_row jsonb;
  v_safe jsonb;
  v_matches text[];
  v_tokens text[] := ARRAY[]::text[];
  v_seen text[] := ARRAY[]::text[];
  v_key text;
  v_total integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_max_results, 300), 300));
  v_remaining integer;
BEGIN
  IF length(v_query) < 2 OR length(v_query) > 200 THEN
    RAISE EXCEPTION 'Search text must be between 2 and 200 characters.' USING ERRCODE = '22023';
  END IF;
  v_pattern := '%' || replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';

  -- Direct value matches across every ordinary table in public. Credential-like
  -- keys are excluded from matching and from returned JSON.
  FOR v_table IN
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND t.table_name NOT LIKE 'schema_migrations%'
    ORDER BY t.table_name
  LOOP
    EXIT WHEN v_total >= v_limit;
    v_remaining := v_limit - v_total;
    v_sql := format(
      'SELECT to_jsonb(t) FROM public.%I t WHERE '
      || 'public.storage_search_redact_jsonb(to_jsonb(t))::text ILIKE $1 ESCAPE E''\\'' '
      || 'LIMIT $2', v_table.table_name);
    FOR v_row IN EXECUTE v_sql USING v_pattern, v_remaining LOOP
      v_safe := public.storage_search_redact_jsonb(v_row);
      SELECT coalesce(array_agg(e.key ORDER BY e.key), ARRAY[]::text[])
        INTO v_matches FROM jsonb_each_text(v_safe) e
        WHERE e.value ILIKE v_pattern ESCAPE E'\\';
      v_key := v_table.table_name || ':' || coalesce(v_row->>'id', v_safe::text);
      IF NOT v_key = ANY(v_seen) THEN
        v_seen := array_append(v_seen, v_key);
        table_name := v_table.table_name;
        record_id := v_row->>'id';
        row_data := v_safe;
        matched_columns := v_matches;
        relation_type := 'match';
        RETURN NEXT;
        v_total := v_total + 1;
        FOR v_key IN SELECT e.value FROM jsonb_each_text(v_safe) e
          WHERE e.key = 'id' OR e.key ~* '_id$'
        LOOP
          IF length(v_key) BETWEEN 3 AND 200 AND NOT v_key = ANY(v_tokens) THEN
            v_tokens := array_append(v_tokens, v_key);
          END IF;
        END LOOP;
      END IF;
      EXIT WHEN v_total >= v_limit;
    END LOOP;
  END LOOP;

  -- Include rows joined by conventional id / *_id columns, so searching an
  -- email also surfaces related users, companies, CRM records and audit rows.
  IF v_total < v_limit AND cardinality(v_tokens) > 0 THEN
    FOR v_table IN
      SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT LIKE 'schema_migrations%'
      ORDER BY t.table_name
    LOOP
      EXIT WHEN v_total >= v_limit;
      FOR v_column IN
        SELECT c.column_name FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = v_table.table_name
          AND (c.column_name = 'id' OR c.column_name ~* '_id$')
          AND c.column_name !~* v_sensitive
        ORDER BY c.ordinal_position
      LOOP
        EXIT WHEN v_total >= v_limit;
        v_remaining := v_limit - v_total;
        v_sql := format('SELECT to_jsonb(t) FROM public.%I t WHERE t.%I::text = ANY($1) LIMIT $2', v_table.table_name, v_column.column_name);
        FOR v_row IN EXECUTE v_sql USING v_tokens, v_remaining LOOP
          v_safe := public.storage_search_redact_jsonb(v_row);
          v_key := v_table.table_name || ':' || coalesce(v_row->>'id', v_safe::text);
          IF NOT v_key = ANY(v_seen) THEN
            v_seen := array_append(v_seen, v_key);
            table_name := v_table.table_name;
            record_id := v_row->>'id';
            row_data := v_safe;
            matched_columns := ARRAY[v_column.column_name];
            relation_type := 'linked';
            RETURN NEXT;
            v_total := v_total + 1;
          END IF;
          EXIT WHEN v_total >= v_limit;
        END LOOP;
      END LOOP;
    END LOOP;
  END IF;
END;
$$;

-- Remove a source-specific selection as one PostgreSQL transaction. Core
-- identity/tenant tables are deliberately blocked; selected dependents must be
-- included, and are deleted child-first. Any constraint failure rolls back all.
CREATE OR REPLACE FUNCTION public.storage_delete_search_data(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '20s'
AS $$
DECLARE
  v_item record;
  v_fk record;
  v_sql text;
  v_exists boolean;
  v_has_dependent boolean;
  v_has_selected_child boolean;
  v_progress boolean;
  v_pending jsonb := p_items;
  v_deleted integer := 0;
  v_item_count integer;
  v_distinct_count integer;
  v_child_has_id boolean;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Select between 1 and 300 search results.' USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(DISTINCT coalesce(x.table_name,'') || ':' || coalesce(x.record_id,''))
    INTO v_item_count, v_distinct_count
    FROM jsonb_to_recordset(p_items) AS x(table_name text, record_id text);
  IF v_item_count <> v_distinct_count THEN
    RAISE EXCEPTION 'Duplicate selected search results.' USING ERRCODE = '22023';
  END IF;

  -- Validate every target and reject protected rows before doing any deletion.
  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(table_name text, record_id text)
  LOOP
    IF v_item.table_name IS NULL OR v_item.record_id IS NULL OR length(v_item.record_id) > 200
      OR v_item.table_name IN ('users','companies','agencies','roles','permissions','role_permissions','user_roles','system_metadata','auth_sessions')
      OR v_item.table_name LIKE 'schema_migrations%' THEN
      RAISE EXCEPTION 'A selected row is protected or invalid.' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema='public' AND t.table_name=v_item.table_name AND t.table_type='BASE TABLE')
      OR NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=v_item.table_name AND c.column_name='id')
      OR NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu USING (constraint_catalog,constraint_schema,constraint_name,table_name)
        WHERE tc.table_schema='public' AND tc.table_name=v_item.table_name AND tc.constraint_type='PRIMARY KEY'
        GROUP BY tc.constraint_name HAVING count(*)=1 AND max(kcu.column_name)='id'
      ) THEN
      RAISE EXCEPTION 'A selected row is not a supported removable record.' USING ERRCODE = '22023';
    END IF;
    v_sql := format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id::text=$1)', v_item.table_name);
    EXECUTE v_sql INTO v_exists USING v_item.record_id;
    IF NOT v_exists THEN RAISE EXCEPTION 'A selected cloud row no longer exists.' USING ERRCODE = 'P0002'; END IF;
  END LOOP;

  -- Reject any child row omitted from the selection.
  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(table_name text, record_id text)
  LOOP
    FOR v_fk IN
      SELECT child.table_name, child.column_name, parent.column_name AS parent_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage child
        ON child.constraint_catalog=tc.constraint_catalog AND child.constraint_schema=tc.constraint_schema
       AND child.constraint_name=tc.constraint_name AND child.table_name=tc.table_name
      JOIN information_schema.constraint_column_usage parent
        ON parent.constraint_catalog=tc.constraint_catalog AND parent.constraint_schema=tc.constraint_schema
       AND parent.constraint_name=tc.constraint_name AND parent.table_name=tc.table_name
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'
        AND parent.table_schema='public' AND parent.table_name=v_item.table_name
    LOOP
      SELECT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=v_fk.table_name AND c.column_name='id')
        INTO v_child_has_id;
      IF NOT v_child_has_id THEN
        v_sql := format('SELECT EXISTS(SELECT 1 FROM public.%I c JOIN public.%I p ON c.%I=p.%I WHERE p.id::text=$1)',v_fk.table_name,v_item.table_name,v_fk.column_name,v_fk.parent_column);
        EXECUTE v_sql INTO v_has_dependent USING v_item.record_id;
        IF v_has_dependent THEN RAISE EXCEPTION 'A selected row has dependent records that cannot be selected.' USING ERRCODE = '23503'; END IF;
      ELSE
        v_sql := format(
          'SELECT EXISTS(SELECT 1 FROM public.%I c JOIN public.%I p ON c.%I=p.%I '
          || 'WHERE p.id::text=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2) s(table_name text,record_id text) '
          || 'WHERE s.table_name=$3 AND s.record_id=c.id::text))',
          v_fk.table_name,v_item.table_name,v_fk.column_name,v_fk.parent_column);
        EXECUTE v_sql INTO v_has_dependent USING v_item.record_id,p_items,v_fk.table_name;
        IF v_has_dependent THEN RAISE EXCEPTION 'Include dependent rows in the selection before removing this record.' USING ERRCODE = '23503'; END IF;
      END IF;
    END LOOP;
  END LOOP;

  WHILE jsonb_array_length(v_pending) > 0 LOOP
    v_progress := false;
    FOR v_item IN SELECT * FROM jsonb_to_recordset(v_pending) AS x(table_name text, record_id text)
    LOOP
      v_has_selected_child := false;
      FOR v_fk IN
        SELECT child.table_name, child.column_name, parent.column_name AS parent_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage child
          ON child.constraint_catalog=tc.constraint_catalog AND child.constraint_schema=tc.constraint_schema
         AND child.constraint_name=tc.constraint_name AND child.table_name=tc.table_name
        JOIN information_schema.constraint_column_usage parent
          ON parent.constraint_catalog=tc.constraint_catalog AND parent.constraint_schema=tc.constraint_schema
         AND parent.constraint_name=tc.constraint_name AND parent.table_name=tc.table_name
        WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'
          AND parent.table_schema='public' AND parent.table_name=v_item.table_name
      LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=v_fk.table_name AND c.column_name='id') THEN
          v_sql := format(
            'SELECT EXISTS(SELECT 1 FROM public.%I c JOIN public.%I p ON c.%I=p.%I '
            || 'WHERE p.id::text=$1 AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2) s(table_name text,record_id text) '
            || 'WHERE s.table_name=$3 AND s.record_id=c.id::text))',
            v_fk.table_name,v_item.table_name,v_fk.column_name,v_fk.parent_column);
          EXECUTE v_sql INTO v_has_selected_child USING v_item.record_id,v_pending,v_fk.table_name;
          IF v_has_selected_child THEN EXIT; END IF;
        END IF;
      END LOOP;
      IF NOT v_has_selected_child THEN
        v_sql := format('DELETE FROM public.%I WHERE id::text=$1',v_item.table_name);
        EXECUTE v_sql USING v_item.record_id;
        GET DIAGNOSTICS v_item_count = ROW_COUNT;
        IF v_item_count <> 1 THEN RAISE EXCEPTION 'A selected cloud row changed during removal.' USING ERRCODE = '40001'; END IF;
        v_pending := (SELECT coalesce(jsonb_agg(e.value),'[]'::jsonb) FROM jsonb_array_elements(v_pending) e(value)
          WHERE e.value->>'table_name' <> v_item.table_name OR e.value->>'record_id' <> v_item.record_id);
        v_deleted := v_deleted + 1;
        v_progress := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_progress THEN RAISE EXCEPTION 'Selected rows contain a dependency cycle; no records were removed.' USING ERRCODE = '23503'; END IF;
  END LOOP;
  RETURN jsonb_build_object('removed',v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.storage_search_data(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storage_search_redact_jsonb(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storage_delete_search_data(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_search_data(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.storage_search_redact_jsonb(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.storage_delete_search_data(jsonb) TO service_role;
