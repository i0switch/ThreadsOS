ALTER TABLE thread_post_drafts ADD COLUMN campaign_id TEXT;
ALTER TABLE thread_post_drafts ADD COLUMN angle_id TEXT;
ALTER TABLE thread_post_drafts ADD COLUMN cta_id TEXT;
ALTER TABLE thread_post_drafts ADD COLUMN canary_group TEXT;

ALTER TABLE thread_post_results ADD COLUMN campaign_id TEXT;
ALTER TABLE thread_post_results ADD COLUMN angle_id TEXT;
ALTER TABLE thread_post_results ADD COLUMN cta_id TEXT;
ALTER TABLE thread_post_results ADD COLUMN canary_group TEXT;

ALTER TABLE note_drafts ADD COLUMN campaign_id TEXT;
ALTER TABLE note_drafts ADD COLUMN angle_id TEXT;
ALTER TABLE note_drafts ADD COLUMN cta_id TEXT;
ALTER TABLE note_drafts ADD COLUMN price_variant_id TEXT;
ALTER TABLE note_drafts ADD COLUMN canary_group TEXT;

ALTER TABLE content_slots ADD COLUMN campaign_id TEXT;
ALTER TABLE content_slots ADD COLUMN angle_id TEXT;
ALTER TABLE content_slots ADD COLUMN cta_id TEXT;
ALTER TABLE content_slots ADD COLUMN price_variant_id TEXT;
ALTER TABLE content_slots ADD COLUMN canary_group TEXT;

ALTER TABLE note_post_results ADD COLUMN campaign_id TEXT;
ALTER TABLE note_post_results ADD COLUMN angle_id TEXT;
ALTER TABLE note_post_results ADD COLUMN cta_id TEXT;
ALTER TABLE note_post_results ADD COLUMN price_variant_id TEXT;
ALTER TABLE note_post_results ADD COLUMN canary_group TEXT;

CREATE TABLE IF NOT EXISTS funnel_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  period_key TEXT NOT NULL,
  period_type TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  profile_transitions INTEGER NOT NULL DEFAULT 0,
  note_clicks INTEGER NOT NULL DEFAULT 0,
  note_views INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  revenue INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS funnel_snapshots_period_unique
ON funnel_snapshots (period_type, period_key);

CREATE TABLE IF NOT EXISTS threads_metrics (
  id TEXT PRIMARY KEY NOT NULL,
  publication_event_id TEXT,
  draft_id TEXT,
  campaign_id TEXT,
  angle_id TEXT,
  cta_id TEXT,
  canary_group TEXT,
  impressions INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  profile_transitions INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_metrics (
  id TEXT PRIMARY KEY NOT NULL,
  publication_event_id TEXT,
  draft_id TEXT,
  campaign_id TEXT,
  angle_id TEXT,
  cta_id TEXT,
  price_variant_id TEXT,
  canary_group TEXT,
  note_clicks INTEGER NOT NULL DEFAULT 0,
  note_views INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  revenue INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_events (
  id TEXT PRIMARY KEY NOT NULL,
  publication_event_id TEXT,
  draft_id TEXT,
  campaign_id TEXT,
  price_variant_id TEXT,
  amount_yen INTEGER NOT NULL,
  purchases_count INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY NOT NULL,
  job_name TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_runs_job_started_idx
ON job_runs (job_name, started_at);

CREATE TABLE IF NOT EXISTS job_leases (
  id TEXT PRIMARY KEY NOT NULL,
  lease_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  heartbeat_scope TEXT,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  target_platform TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_outbox_idempotency_unique
ON execution_outbox (idempotency_key);

CREATE TABLE IF NOT EXISTS publication_events (
  id TEXT PRIMARY KEY NOT NULL,
  target_platform TEXT NOT NULL,
  outbox_id TEXT,
  draft_id TEXT,
  slot_id TEXT,
  campaign_id TEXT,
  angle_id TEXT,
  cta_id TEXT,
  price_variant_id TEXT,
  canary_group TEXT,
  external_id TEXT,
  external_url TEXT,
  external_fingerprint TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS publication_events_fingerprint_unique
ON publication_events (external_fingerprint);

CREATE TABLE IF NOT EXISTS decision_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runner_budget (
  id TEXT PRIMARY KEY NOT NULL,
  runner TEXT NOT NULL,
  period_key TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  calls_used INTEGER NOT NULL DEFAULT 0,
  tokens_limit INTEGER NOT NULL,
  calls_limit INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS runner_budget_runner_period_unique
ON runner_budget (runner, period_key);

CREATE TABLE IF NOT EXISTS anomaly_events (
  id TEXT PRIMARY KEY NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  detected_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
