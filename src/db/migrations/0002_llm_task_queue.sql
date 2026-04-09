CREATE TABLE IF NOT EXISTS llm_task_queue (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  options_json TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
