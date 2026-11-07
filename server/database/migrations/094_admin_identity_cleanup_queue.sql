CREATE TABLE IF NOT EXISTS admin_identity_cleanup_queue (
  id TEXT PRIMARY KEY,
  agency_admin_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  supabase_user_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('PENDING_AUTH', 'AUTH_DELETED', 'CLOUD_MIRROR_DELETED', 'COMPLETE')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_identity_cleanup_pending
  ON admin_identity_cleanup_queue(phase, updated_at);
