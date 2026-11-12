-- supabase/migrations/001_pgcrypto.sql
-- pgcrypto provides gen_random_uuid(). Not enabled by default on all Supabase
-- projects, so applied explicitly at bootstrap.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
