CREATE TABLE mcp_gateway_instance_state (
  instance_key TEXT PRIMARY KEY NOT NULL,
  grant_version INTEGER,
  refresh_started_at TEXT,
  refresh_failed_at TEXT,
  updated_at TEXT NOT NULL
);
