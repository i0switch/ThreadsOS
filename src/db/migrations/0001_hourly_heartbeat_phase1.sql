ALTER TABLE reply_decisions ADD COLUMN sent_at TEXT;

CREATE TABLE IF NOT EXISTS operator_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  primary_niche TEXT NOT NULL,
  sub_niches TEXT,
  tone TEXT,
  forbidden_topics TEXT,
  monetization_goal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  input_type TEXT NOT NULL,
  content TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_slots (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  topic_id TEXT,
  draft_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS content_slots_channel_scheduled_at_status_unique
ON content_slots (channel, scheduled_at, status);

CREATE TABLE IF NOT EXISTS optimization_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  before_value TEXT NOT NULL,
  after_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  change_percent REAL,
  approved_by TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_performance_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL,
  period_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  metrics TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_post_results (
  id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL,
  title TEXT,
  note_url TEXT,
  price_yen INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  purchases_count INTEGER NOT NULL DEFAULT 0,
  revenue_yen INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  traffic_source TEXT,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thumbnail_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  note_draft_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  instruction TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS heartbeat_states (
  job_name TEXT PRIMARY KEY NOT NULL,
  last_run_at TEXT,
  next_notification_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_at TEXT
);

CREATE TABLE IF NOT EXISTS outbound_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'file',
  sent_at TEXT NOT NULL,
  delivered_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  data TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id TEXT PRIMARY KEY NOT NULL,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT,
  created_at TEXT NOT NULL
);
