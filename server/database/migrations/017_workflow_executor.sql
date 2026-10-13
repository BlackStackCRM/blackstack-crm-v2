CREATE TABLE IF NOT EXISTS workflow_nodes (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_name TEXT,
  node_order INTEGER NOT NULL,
  config_json TEXT,
  next_node_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE
);
