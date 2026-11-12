-- BlackStack CRM V2 — Cloud Verification SQL
-- Run AFTER manual_apply_all.sql to confirm the cloud schema is correct.
-- Expected: pgcrypto enabled, 5 tables, FKs, indexes, and 0 rows everywhere.

-- 1. pgcrypto extension
SELECT 'pgcrypto' AS check_name, COUNT(*) AS enabled
FROM pg_extension
WHERE extname = 'pgcrypto';

-- 2. Table existence + row counts
SELECT 'companies' AS table_name, COUNT(*) AS row_count FROM companies
UNION ALL SELECT 'agencies', COUNT(*) FROM agencies
UNION ALL SELECT 'agency_administrators', COUNT(*) FROM agency_administrators
UNION ALL SELECT 'agency_status_history', COUNT(*) FROM agency_status_history
UNION ALL SELECT 'agency_audit_entries', COUNT(*) FROM agency_audit_entries;

-- 3. Foreign keys
SELECT 'fk_agencies_company' AS fk_checksum, CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME
FROM information_schema.table_constraints
WHERE constraint_type = 'FOREIGN KEY'
  AND table_name IN ('agencies','agency_administrators')
ORDER BY table_name, constraint_name;

-- 4. Indexes
SELECT 'index' AS check_type, indexname AS index_name, tablename AS table_name, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_agencies_code','idx_agencies_company','idx_agencies_provider','idx_agencies_status',
    'idx_agency_administrators_agency','idx_agency_status_history_agency','idx_agency_audit_entries_agency'
  )
ORDER BY tablename, indexname;

-- 5. Device shape counters
SELECT 'companies' AS table_name, COUNT(*) AS n FROM companies UNION ALL
SELECT 'agencies', COUNT(*) FROM agencies UNION ALL
SELECT 'agency_administrators', COUNT(*) FROM agency_administrators UNION ALL
SELECT 'agency_status_history', COUNT(*) FROM agency_status_history UNION ALL
SELECT 'agency_audit_entries', COUNT(*) FROM agency_audit_entries;
