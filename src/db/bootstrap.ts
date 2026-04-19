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
  try {
    db.run(
      sql.raw("ALTER TABLE thread_post_drafts ADD COLUMN campaign_id TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE thread_post_drafts ADD COLUMN angle_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE thread_post_drafts ADD COLUMN cta_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE thread_post_drafts ADD COLUMN canary_group TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }

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
  try {
    db.run(
      sql.raw("ALTER TABLE thread_post_results ADD COLUMN campaign_id TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE thread_post_results ADD COLUMN angle_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE thread_post_results ADD COLUMN cta_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE thread_post_results ADD COLUMN canary_group TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }

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
  try {
    db.run(sql.raw("ALTER TABLE content_slots ADD COLUMN campaign_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE content_slots ADD COLUMN angle_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE content_slots ADD COLUMN cta_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE content_slots ADD COLUMN price_variant_id TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE content_slots ADD COLUMN canary_group TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS content_slots_channel_scheduled_at_status_unique
    ON content_slots (channel, scheduled_at, status)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    leader_agent_id TEXT,
    executive_agent_id TEXT,
    department TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    expected_effect TEXT NOT NULL,
    risk TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending',
    current_stage TEXT NOT NULL DEFAULT 'executive_review',
    current_approver_id TEXT,
    reviewer_note TEXT,
    reviewed_at TEXT,
    executed_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS proposal_events (
    id TEXT PRIMARY KEY NOT NULL,
    proposal_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    note TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS proposal_events_proposal_created_idx
    ON proposal_events (proposal_id, created_at)`),
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

  db.run(sql`CREATE TABLE IF NOT EXISTS competitor_analyses (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    themes TEXT NOT NULL,
    hooks TEXT NOT NULL,
    engagement_patterns TEXT NOT NULL,
    winning_patterns TEXT NOT NULL,
    raw_analysis TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS strategy_history (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    funnel_stage TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    department_instructions TEXT,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_history_created_idx ON strategy_history(created_at)`,
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS department_notifications (
    id TEXT PRIMARY KEY,
    from_department TEXT NOT NULL,
    to_department TEXT NOT NULL,
    notification_type TEXT NOT NULL,
    content TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL
  )`);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS dept_notif_to_unread_idx ON department_notifications(to_department, read_at)`,
  );

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

  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS scheduled_job_runs_job_started_idx
    ON scheduled_job_runs (job_name, started_at)`),
  );

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_runs_running_job_unique
    ON scheduled_job_runs (job_name)
    WHERE status = 'running'`),
  );

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

  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS department_runs_department_created_idx
    ON department_runs (department, created_at)`),
  );

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
  )`);

  try {
    db.run(sql.raw("ALTER TABLE note_post_results ADD COLUMN title TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE note_post_results ADD COLUMN price_yen INTEGER"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw(
        "ALTER TABLE note_post_results ADD COLUMN purchases_count INTEGER NOT NULL DEFAULT 0",
      ),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw(
        "ALTER TABLE note_post_results ADD COLUMN revenue_yen INTEGER NOT NULL DEFAULT 0",
      ),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw(
        "ALTER TABLE note_post_results ADD COLUMN conversion_rate REAL NOT NULL DEFAULT 0",
      ),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE note_post_results ADD COLUMN traffic_source TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE note_post_results ADD COLUMN campaign_id TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE note_post_results ADD COLUMN angle_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE note_post_results ADD COLUMN cta_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE note_post_results ADD COLUMN price_variant_id TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(
      sql.raw("ALTER TABLE note_post_results ADD COLUMN canary_group TEXT"),
    );
  } catch (error) {
    ignoreDuplicateColumn(error);
  }

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
  try {
    db.run(sql.raw("ALTER TABLE note_drafts ADD COLUMN campaign_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE note_drafts ADD COLUMN angle_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE note_drafts ADD COLUMN cta_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE note_drafts ADD COLUMN price_variant_id TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }
  try {
    db.run(sql.raw("ALTER TABLE note_drafts ADD COLUMN canary_group TEXT"));
  } catch (error) {
    ignoreDuplicateColumn(error);
  }

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

  db.run(sql`CREATE TABLE IF NOT EXISTS funnel_snapshots (
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
  )`);
  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS funnel_snapshots_period_unique
    ON funnel_snapshots (period_type, period_key)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS threads_metrics (
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
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS note_metrics (
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
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS revenue_events (
    id TEXT PRIMARY KEY NOT NULL,
    publication_event_id TEXT,
    draft_id TEXT,
    campaign_id TEXT,
    price_variant_id TEXT,
    amount_yen INTEGER NOT NULL,
    purchases_count INTEGER NOT NULL DEFAULT 1,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS session_health (
    scope TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL DEFAULT 'healthy',
    provider TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_success_at TEXT,
    last_failure_at TEXT,
    detail TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS job_runs (
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
  )`);
  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS job_runs_job_started_idx
    ON job_runs (job_name, started_at)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS job_leases (
    id TEXT PRIMARY KEY NOT NULL,
    lease_key TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    heartbeat_scope TEXT,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS execution_outbox (
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
  )`);
  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS execution_outbox_idempotency_unique
    ON execution_outbox (idempotency_key)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS publication_events (
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
  )`);
  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS publication_events_fingerprint_unique
    ON publication_events (external_fingerprint)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS decision_evidence (
    id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS experiments (
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
  )`);
  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS experiments_cycle_idx
    ON experiments (cycle_id, created_at)`),
  );
  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS experiments_status_idx
    ON experiments (status, updated_at)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS experiment_results (
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
  )`);
  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS experiment_results_experiment_window_unique
    ON experiment_results (experiment_id, window_hours)`),
  );
  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS experiment_results_status_schedule_idx
    ON experiment_results (status, scheduled_for)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS winning_patterns (
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
  )`);
  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS winning_patterns_key_idx
    ON winning_patterns (pattern_key, created_at)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS losing_patterns (
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
  )`);
  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS losing_patterns_key_idx
    ON losing_patterns (pattern_key, created_at)`),
  );

  // Phase 2 tables

  db.run(sql`CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY NOT NULL,
    layer TEXT NOT NULL,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_layer_scope_key_unique
    ON memory_entries (layer, scope, key)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_states (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    current_task TEXT,
    last_completed_task TEXT,
    budget_used_tokens INTEGER NOT NULL DEFAULT 0,
    budget_used_calls INTEGER NOT NULL DEFAULT 0,
    last_active_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS budget_tracking (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    period TEXT NOT NULL,
    period_key TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    calls_used INTEGER NOT NULL DEFAULT 0,
    tokens_limit INTEGER NOT NULL,
    calls_limit INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS budget_tracking_scope_period_key_unique
    ON budget_tracking (scope, period, period_key)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS runner_health (
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
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS runner_budget (
    id TEXT PRIMARY KEY NOT NULL,
    runner TEXT NOT NULL,
    period_key TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    calls_used INTEGER NOT NULL DEFAULT 0,
    tokens_limit INTEGER NOT NULL,
    calls_limit INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS runner_budget_runner_period_unique
    ON runner_budget (runner, period_key)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS anomaly_events (
    id TEXT PRIMARY KEY NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata_json TEXT,
    detected_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS rollbacks (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    trigger TEXT NOT NULL,
    reason TEXT NOT NULL,
    previous_state_json TEXT,
    applied_state_json TEXT,
    status TEXT NOT NULL DEFAULT 'executed',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS rollbacks_scope_created_idx
    ON rollbacks (scope, created_at)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    channel TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    period_type TEXT NOT NULL,
    period_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS kpi_snapshots_channel_metric_period_unique
    ON kpi_snapshots (channel, metric_name, period_type, period_key)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS department_summaries (
    id TEXT PRIMARY KEY NOT NULL,
    department TEXT NOT NULL,
    summary_type TEXT NOT NULL,
    content TEXT NOT NULL,
    period_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS department_summaries_dept_type_period_unique
    ON department_summaries (department, summary_type, period_key)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS operations_mode_state (
    scope TEXT PRIMARY KEY NOT NULL,
    mode TEXT NOT NULL DEFAULT 'full_autonomy',
    reason TEXT NOT NULL,
    evidence_json TEXT,
    last_transition_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS system_controls (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'system',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`);

  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS system_controls_scope_action_active_idx
    ON system_controls (scope, action, active)`),
  );

  db.run(sql`CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    theme TEXT NOT NULL,
    bottleneck_focus TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    reasoning TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(
    sql.raw(`CREATE INDEX IF NOT EXISTS campaigns_status_started_idx
    ON campaigns (status, started_at)`),
  );
}
