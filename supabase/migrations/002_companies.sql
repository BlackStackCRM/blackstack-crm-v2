-- supabase/migrations/002_companies.sql
-- Minimal companies stub; FK target for agencies.company_id.
-- Mirrors local companies (000a_companies), Postgres-compatible.

CREATE TABLE IF NOT EXISTS companies (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
