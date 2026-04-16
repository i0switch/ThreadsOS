CREATE TABLE IF NOT EXISTS runner_health (
  runner TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  timeout_count INTEGER NOT NULL DEFAULT 0,
  invalid_json_count INTEGER NOT NULL DEFAULT 0,
  total_calls INTEGER NOT NULL DEFAULT 0,
  last_model TEXT,
  last_error TEXT,
  last_duration_ms INTEGER,
  last_success_at TEXT,
  last_failure_at TEXT,
  updated_at TEXT NOT NULL
);
