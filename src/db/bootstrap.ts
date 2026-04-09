import { sql } from "drizzle-orm";
import { db } from "./index.js";

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes("duplicate column name")) return true;
  // DrizzleError wraps the original SQLite error in `cause`
  if ("cause" in error && error.cause instanceof Error) {
    return error.cause.message.toLowerCase().includes("duplicate column name");
  }
  return false;
}

function ignoreDuplicateColumn(error: unknown): void {
  if (isDuplicateColumnError(error)) {
    return;
  }

  throw error;
}

export function ensureAutonomyTables(): void {
  db.run(sql`CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    niche TEXT NOT NULL,
    priority_score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thread_post_drafts (
    id TEXT PRIMARY KEY NOT NULL,
    topic_id TEXT NOT NULL,
    body TEXT NOT NULL,
    hook_type TEXT NOT NULL,
    cta_type TEXT NOT NULL,
    note_transition TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thread_post_results (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL,
    threads_post_id TEXT NOT NULL UNIQUE,
    impressions INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    replies_count INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thread_replies (
    id TEXT PRIMARY KEY NOT NULL,
    post_result_id TEXT NOT NULL,
    threads_reply_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    sentiment TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS improvement_insights (
    id TEXT PRIMARY KEY NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    insight TEXT NOT NULL,
    action TEXT NOT NULL,
    priority TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS human_review_items (
    id TEXT PRIMARY KEY NOT NULL,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT,
    reviewer_note TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS reply_decisions (
    id TEXT PRIMARY KEY NOT NULL,
    reply_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    auto_reply_body TEXT,
    created_at TEXT NOT NULL
  )`);

  try {
    db.run(sql.raw("ALTER TABLE reply_decisions ADD COLUMN sent_at TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }

  db.run(sql`CREATE TABLE IF NOT EXISTS content_slots (
    id TEXT PRIMARY KEY NOT NULL,
    channel TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    topic_id TEXT,
    draft_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS content_slots_channel_scheduled_at_status_unique
    ON content_slots (channel, scheduled_at, status)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS heartbeat_states (
    job_name TEXT PRIMARY KEY NOT NULL,
    last_run_at TEXT,
    next_notification_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    locked_by TEXT,
    locked_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thumbnail_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    note_draft_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    instruction TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS outbound_notifications (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'file',
    sent_at TEXT NOT NULL,
    delivered_at TEXT,
    error TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS competitor_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    data TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS scheduled_job_runs (
    id TEXT PRIMARY KEY NOT NULL,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    dry_run INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS strategy_states (
    key TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    state_json TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS executive_cycles (
    id TEXT PRIMARY KEY NOT NULL,
    objective TEXT NOT NULL,
    funnel_stage TEXT NOT NULL,
    strategy_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    decision_json TEXT NOT NULL,
    summary TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS department_runs (
    id TEXT PRIMARY KEY NOT NULL,
    cycle_id TEXT NOT NULL,
    department TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS operator_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    primary_niche TEXT NOT NULL,
    sub_niches TEXT,
    tone TEXT,
    forbidden_topics TEXT,
    monetization_goal TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS human_inputs (
    id TEXT PRIMARY KEY NOT NULL,
    input_type TEXT NOT NULL,
    content TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    processed_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS optimization_decisions (
    id TEXT PRIMARY KEY NOT NULL,
    channel TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    before_value TEXT NOT NULL,
    after_value TEXT NOT NULL,
    reason TEXT NOT NULL,
    change_percent REAL,
    approved_by TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS channel_performance_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    channel TEXT NOT NULL,
    period_type TEXT NOT NULL,
    period_key TEXT NOT NULL,
    metrics TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS note_post_results (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL,
    note_url TEXT,
    views INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    comments_count INTEGER NOT NULL DEFAULT 0,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS note_ideas (
    id TEXT PRIMARY KEY NOT NULL,
    source_topic_id TEXT,
    angle TEXT NOT NULL,
    target_reader TEXT NOT NULL,
    priority_score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idea',
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS note_drafts (
    id TEXT PRIMARY KEY NOT NULL,
    idea_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    outline TEXT,
    cta TEXT,
    publish_readiness_score REAL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS research_items (
    id TEXT PRIMARY KEY NOT NULL,
    topic_id TEXT NOT NULL,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    confidence TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thread_post_audits (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL UNIQUE,
    verdict TEXT NOT NULL,
    severity TEXT NOT NULL,
    reasons TEXT NOT NULL,
    suggestions TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS note_audits (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL UNIQUE,
    verdict TEXT NOT NULL,
    strongest_section TEXT,
    weakest_section TEXT,
    rewrite_guidance TEXT,
    score REAL NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS llm_task_queue (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    prompt TEXT NOT NULL,
    system_prompt TEXT,
    options_json TEXT,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS human_review_items_item_type_item_id_unique
    ON human_review_items (item_type, item_id)`),
  );
}
