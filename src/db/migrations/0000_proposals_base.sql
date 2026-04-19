CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  department TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  expected_effect TEXT NOT NULL,
  risk TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer_note TEXT,
  reviewed_at TEXT,
  executed_at TEXT,
  created_at TEXT NOT NULL
);
