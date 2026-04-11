ALTER TABLE proposals ADD COLUMN leader_agent_id TEXT;
ALTER TABLE proposals ADD COLUMN executive_agent_id TEXT;
ALTER TABLE proposals ADD COLUMN current_stage TEXT NOT NULL DEFAULT 'human_review';
ALTER TABLE proposals ADD COLUMN current_approver_id TEXT;

CREATE TABLE IF NOT EXISTS proposal_events (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  note TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS proposal_events_proposal_created_idx
  ON proposal_events (proposal_id, created_at);
