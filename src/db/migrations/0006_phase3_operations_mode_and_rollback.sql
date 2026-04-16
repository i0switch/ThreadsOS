CREATE TABLE IF NOT EXISTS operations_mode_state (
  scope TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL DEFAULT 'full_autonomy',
  reason TEXT NOT NULL,
  evidence_json TEXT,
  last_transition_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);