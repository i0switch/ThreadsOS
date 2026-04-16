CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY NOT NULL,
  cycle_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  bottleneck TEXT NOT NULL,
  action_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  guidance TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 1,
  canary_group TEXT NOT NULL DEFAULT 'canary',
  angle_id TEXT,
  cta_id TEXT,
  baseline_json TEXT NOT NULL,
  diagnosis_json TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  launched_at TEXT,
  promoted_at TEXT,
  rejected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS experiments_cycle_idx
ON experiments (cycle_id, created_at);

CREATE INDEX IF NOT EXISTS experiments_status_idx
ON experiments (status, updated_at);

CREATE TABLE IF NOT EXISTS experiment_results (
  id TEXT PRIMARY KEY NOT NULL,
  experiment_id TEXT NOT NULL,
  window_hours INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_for TEXT NOT NULL,
  measured_at TEXT,
  outcome TEXT,
  metrics_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS experiment_results_experiment_window_unique
ON experiment_results (experiment_id, window_hours);

CREATE INDEX IF NOT EXISTS experiment_results_status_schedule_idx
ON experiment_results (status, scheduled_for);

CREATE TABLE IF NOT EXISTS winning_patterns (
  id TEXT PRIMARY KEY NOT NULL,
  experiment_id TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  bottleneck TEXT NOT NULL,
  action_type TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  baseline_value REAL NOT NULL DEFAULT 0,
  observed_value REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS winning_patterns_key_idx
ON winning_patterns (pattern_key, created_at);

CREATE TABLE IF NOT EXISTS losing_patterns (
  id TEXT PRIMARY KEY NOT NULL,
  experiment_id TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  bottleneck TEXT NOT NULL,
  action_type TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  baseline_value REAL NOT NULL DEFAULT 0,
  observed_value REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS losing_patterns_key_idx
ON losing_patterns (pattern_key, created_at);