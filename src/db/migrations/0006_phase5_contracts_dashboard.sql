CREATE TABLE IF NOT EXISTS rollbacks (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  trigger TEXT NOT NULL,
  reason TEXT NOT NULL,
  previous_state_json TEXT,
  applied_state_json TEXT,
  status TEXT NOT NULL DEFAULT 'executed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rollbacks_scope_created_idx
ON rollbacks (scope, created_at);
