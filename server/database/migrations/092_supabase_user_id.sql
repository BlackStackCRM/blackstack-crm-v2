-- Migration 092: role-based access — Supabase mirror id (local side).
-- Stores the Supabase auth user id alongside the local users row so the
-- server can sync password changes / metadata without a lookup round-trip.
-- ADDITIVE ONLY.

-- Applied programmatically via the guarded adapter helper (ALTER TABLE is
-- not idempotent in SQLite); this file is the canonical record.

CREATE INDEX IF NOT EXISTS idx_users_supabase_user_id ON users(supabase_user_id);
