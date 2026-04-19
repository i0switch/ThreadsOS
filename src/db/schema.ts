import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Status enums for runtime validation
export const DRAFT_STATUSES = [
  "drafted",
  "audited",
  "scheduled",
  "published",
  "measured",
  "scored",
  "archived",
] as const;
export const AUDIT_VERDICTS = [
  "pass",
  "rewrite",
  "skip",
  "quarantine",
] as const;
export const SEVERITIES = ["low", "medium", "high"] as const;
export const REPLY_DECISIONS = [
  "safe_auto_reply",
  "quarantine",
  "ignore",
] as const;
export const AUDITOR_ACTIONS = [
  "pass",
  "rewrite",
  "skip",
  "quarantine",
] as const;
export const JOB_STATUSES = ["running", "completed", "failed"] as const;
export const NOTE_IDEA_STATUSES = [
  "idea",
  "drafting",
  "drafted",
  "audited",
  "ready",
  "published",
] as const;
export const NOTE_DRAFT_STATUSES = [
  "drafted",
  "audited",
  "scheduled",
  "published",
  "measured",
  "scored",
  "archived",
] as const;

export const CAMPAIGN_STATUSES = ["active", "paused", "archived"] as const;
export const CAMPAIGN_BOTTLENECKS = ["Reach", "Click", "Read", "Buy"] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type CampaignBottleneck = (typeof CAMPAIGN_BOTTLENECKS)[number];

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    theme: text("theme").notNull(),
    bottleneckFocus: text("bottleneck_focus"),
    status: text("status").notNull().default("active"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    reasoning: text("reasoning"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    statusStartedIdx: index("campaigns_status_started_idx").on(
      table.status,
      table.startedAt,
    ),
  }),
);

export const topics = sqliteTable("topics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  niche: text("niche").notNull(),
  priorityScore: integer("priority_score").notNull().default(0),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const researchItems = sqliteTable("research_items", {
  id: text("id").primaryKey(),
  topicId: text("topic_id").notNull(),
  source: text("source").notNull(),
  content: text("content").notNull(),
  evidenceType: text("evidence_type").notNull(),
  confidence: text("confidence").notNull(),
  createdAt: text("created_at").notNull(),
});

export const threadPostDrafts = sqliteTable("thread_post_drafts", {
  id: text("id").primaryKey(),
  topicId: text("topic_id").notNull(),
  body: text("body").notNull(),
  hookType: text("hook_type").notNull(),
  ctaType: text("cta_type").notNull(),
  noteTransition: text("note_transition"),
  campaignId: text("campaign_id"),
  angleId: text("angle_id"),
  ctaId: text("cta_id"),
  canaryGroup: text("canary_group"),
  status: text("status").notNull().default("drafted"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const threadPostAudits = sqliteTable("thread_post_audits", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").notNull().unique(),
  verdict: text("verdict").notNull(),
  severity: text("severity").notNull(),
  reasons: text("reasons").notNull(),
  suggestions: text("suggestions").notNull(),
  createdAt: text("created_at").notNull(),
});

export const threadPostResults = sqliteTable("thread_post_results", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").notNull(),
  threadsPostId: text("threads_post_id").notNull().unique(),
  campaignId: text("campaign_id"),
  angleId: text("angle_id"),
  ctaId: text("cta_id"),
  canaryGroup: text("canary_group"),
  impressions: integer("impressions").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  repliesCount: integer("replies_count").notNull().default(0),
  shares: integer("shares").notNull().default(0),
  publishedAt: text("published_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const threadReplies = sqliteTable("thread_replies", {
  id: text("id").primaryKey(),
  postResultId: text("post_result_id").notNull(),
  threadsReplyId: text("threads_reply_id").notNull(),
  author: text("author").notNull(),
  body: text("body").notNull(),
  sentiment: text("sentiment"),
  createdAt: text("created_at").notNull(),
});

export const replyDecisions = sqliteTable("reply_decisions", {
  id: text("id").primaryKey(),
  replyId: text("reply_id").notNull(),
  decision: text("decision").notNull(),
  autoReplyBody: text("auto_reply_body"),
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull(),
});

export const improvementInsights = sqliteTable("improvement_insights", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  insight: text("insight").notNull(),
  action: text("action").notNull(),
  priority: text("priority").notNull(),
  createdAt: text("created_at").notNull(),
});

export const noteIdeas = sqliteTable("note_ideas", {
  id: text("id").primaryKey(),
  sourceTopicId: text("source_topic_id"),
  angle: text("angle").notNull(),
  targetReader: text("target_reader").notNull(),
  priorityScore: integer("priority_score").notNull().default(0),
  status: text("status").notNull().default("idea"),
  createdAt: text("created_at").notNull(),
});

export const noteDrafts = sqliteTable("note_drafts", {
  id: text("id").primaryKey(),
  ideaId: text("idea_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  outline: text("outline"),
  cta: text("cta"),
  campaignId: text("campaign_id"),
  angleId: text("angle_id"),
  ctaId: text("cta_id"),
  priceVariantId: text("price_variant_id"),
  canaryGroup: text("canary_group"),
  publishReadinessScore: real("publish_readiness_score"),
  status: text("status").notNull().default("drafted"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const noteAudits = sqliteTable("note_audits", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").notNull().unique(),
  verdict: text("verdict").notNull(),
  strongestSection: text("strongest_section"),
  weakestSection: text("weakest_section"),
  rewriteGuidance: text("rewrite_guidance"),
  score: real("score").notNull(),
  createdAt: text("created_at").notNull(),
});

export const operatorProfiles = sqliteTable("operator_profiles", {
  id: text("id").primaryKey(),
  primaryNiche: text("primary_niche").notNull(),
  subNiches: text("sub_niches"),
  tone: text("tone"),
  forbiddenTopics: text("forbidden_topics"),
  monetizationGoal: text("monetization_goal"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const humanInputs = sqliteTable("human_inputs", {
  id: text("id").primaryKey(),
  inputType: text("input_type").notNull(),
  content: text("content").notNull(),
  processed: integer("processed").notNull().default(0),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull(),
});

export const contentSlots = sqliteTable(
  "content_slots",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    scheduledAt: text("scheduled_at").notNull(),
    topicId: text("topic_id"),
    draftId: text("draft_id"),
    campaignId: text("campaign_id"),
    angleId: text("angle_id"),
    ctaId: text("cta_id"),
    priceVariantId: text("price_variant_id"),
    canaryGroup: text("canary_group"),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(5),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    uniqueSlot: uniqueIndex(
      "content_slots_channel_scheduled_at_status_unique",
    ).on(table.channel, table.scheduledAt, table.status),
  }),
);

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  leaderAgentId: text("leader_agent_id"),
  executiveAgentId: text("executive_agent_id"),
  department: text("department").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  reason: text("reason").notNull(),
  evidence: text("evidence").notNull(),
  expectedEffect: text("expected_effect").notNull(),
  risk: text("risk"),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("pending"),
  currentStage: text("current_stage").notNull().default("executive_review"),
  currentApproverId: text("current_approver_id"),
  reviewerNote: text("reviewer_note"),
  reviewedAt: text("reviewed_at"),
  executedAt: text("executed_at"),
  createdAt: text("created_at").notNull(),
});

export const proposalEvents = sqliteTable(
  "proposal_events",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id").notNull(),
    stage: text("stage").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    note: text("note"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    proposalCreatedIdx: index("proposal_events_proposal_created_idx").on(
      table.proposalId,
      table.createdAt,
    ),
  }),
);

export const optimizationDecisions = sqliteTable("optimization_decisions", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  decisionType: text("decision_type").notNull(),
  beforeValue: text("before_value").notNull(),
  afterValue: text("after_value").notNull(),
  reason: text("reason").notNull(),
  changePercent: real("change_percent"),
  approvedBy: text("approved_by").notNull().default("auto"),
  createdAt: text("created_at").notNull(),
});

export const channelPerformanceSnapshots = sqliteTable(
  "channel_performance_snapshots",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    periodType: text("period_type").notNull(),
    periodKey: text("period_key").notNull(),
    metrics: text("metrics").notNull(),
    createdAt: text("created_at").notNull(),
  },
);

export const notePostResults = sqliteTable("note_post_results", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").notNull(),
  title: text("title"),
  noteUrl: text("note_url"),
  priceYen: integer("price_yen"),
  campaignId: text("campaign_id"),
  angleId: text("angle_id"),
  ctaId: text("cta_id"),
  priceVariantId: text("price_variant_id"),
  canaryGroup: text("canary_group"),
  views: integer("views").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  commentsCount: integer("comments_count").notNull().default(0),
  purchasesCount: integer("purchases_count").notNull().default(0),
  revenueYen: integer("revenue_yen").notNull().default(0),
  conversionRate: real("conversion_rate").notNull().default(0),
  trafficSource: text("traffic_source"),
  publishedAt: text("published_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const thumbnailTasks = sqliteTable("thumbnail_tasks", {
  id: text("id").primaryKey(),
  noteDraftId: text("note_draft_id").notNull(),
  status: text("status").notNull().default("pending"),
  instruction: text("instruction"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const LLM_TASK_STATUSES = [
  "pending",
  "processing",
  "done",
  "error",
] as const;
export const EXECUTION_OUTBOX_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

export const SESSION_HEALTH_STATES = [
  "healthy",
  "degraded",
  "quarantined",
  "recovered",
] as const;

export const llmTaskQueue = sqliteTable("llm_task_queue", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  prompt: text("prompt").notNull(),
  systemPrompt: text("system_prompt"),
  optionsJson: text("options_json"),
  result: text("result"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const funnelSnapshots = sqliteTable(
  "funnel_snapshots",
  {
    id: text("id").primaryKey(),
    periodKey: text("period_key").notNull(),
    periodType: text("period_type").notNull(),
    impressions: integer("impressions").notNull().default(0),
    profileTransitions: integer("profile_transitions").notNull().default(0),
    noteClicks: integer("note_clicks").notNull().default(0),
    noteViews: integer("note_views").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    revenue: integer("revenue").notNull().default(0),
    capturedAt: text("captured_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    periodUniq: uniqueIndex("funnel_snapshots_period_unique").on(
      table.periodType,
      table.periodKey,
    ),
  }),
);

export const threadsMetrics = sqliteTable("threads_metrics", {
  id: text("id").primaryKey(),
  publicationEventId: text("publication_event_id"),
  draftId: text("draft_id"),
  campaignId: text("campaign_id"),
  angleId: text("angle_id"),
  ctaId: text("cta_id"),
  canaryGroup: text("canary_group"),
  impressions: integer("impressions").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  replies: integer("replies").notNull().default(0),
  shares: integer("shares").notNull().default(0),
  profileTransitions: integer("profile_transitions").notNull().default(0),
  capturedAt: text("captured_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const noteMetrics = sqliteTable("note_metrics", {
  id: text("id").primaryKey(),
  publicationEventId: text("publication_event_id"),
  draftId: text("draft_id"),
  campaignId: text("campaign_id"),
  angleId: text("angle_id"),
  ctaId: text("cta_id"),
  priceVariantId: text("price_variant_id"),
  canaryGroup: text("canary_group"),
  noteClicks: integer("note_clicks").notNull().default(0),
  noteViews: integer("note_views").notNull().default(0),
  purchases: integer("purchases").notNull().default(0),
  revenue: integer("revenue").notNull().default(0),
  conversionRate: real("conversion_rate").notNull().default(0),
  capturedAt: text("captured_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const revenueEvents = sqliteTable("revenue_events", {
  id: text("id").primaryKey(),
  publicationEventId: text("publication_event_id"),
  draftId: text("draft_id"),
  campaignId: text("campaign_id"),
  priceVariantId: text("price_variant_id"),
  amountYen: integer("amount_yen").notNull(),
  purchasesCount: integer("purchases_count").notNull().default(1),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const experiments = sqliteTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id").notNull(),
    status: text("status").notNull().default("planned"),
    bottleneck: text("bottleneck").notNull(),
    actionType: text("action_type").notNull(),
    channel: text("channel").notNull(),
    patternKey: text("pattern_key").notNull(),
    primaryMetric: text("primary_metric").notNull(),
    hypothesis: text("hypothesis").notNull(),
    guidance: text("guidance").notNull(),
    sampleSize: integer("sample_size").notNull().default(1),
    canaryGroup: text("canary_group").notNull().default("canary"),
    angleId: text("angle_id"),
    ctaId: text("cta_id"),
    baselineJson: text("baseline_json").notNull(),
    diagnosisJson: text("diagnosis_json").notNull(),
    selectionJson: text("selection_json").notNull(),
    launchedAt: text("launched_at"),
    promotedAt: text("promoted_at"),
    rejectedAt: text("rejected_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    cycleIdx: index("experiments_cycle_idx").on(table.cycleId, table.createdAt),
    statusIdx: index("experiments_status_idx").on(
      table.status,
      table.updatedAt,
    ),
  }),
);

export const experimentResults = sqliteTable(
  "experiment_results",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull(),
    windowHours: integer("window_hours").notNull(),
    status: text("status").notNull().default("pending"),
    scheduledFor: text("scheduled_for").notNull(),
    measuredAt: text("measured_at"),
    outcome: text("outcome"),
    metricsJson: text("metrics_json"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    experimentWindowUniq: uniqueIndex(
      "experiment_results_experiment_window_unique",
    ).on(table.experimentId, table.windowHours),
    statusScheduleIdx: index("experiment_results_status_schedule_idx").on(
      table.status,
      table.scheduledFor,
    ),
  }),
);

export const winningPatterns = sqliteTable(
  "winning_patterns",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull(),
    patternKey: text("pattern_key").notNull(),
    bottleneck: text("bottleneck").notNull(),
    actionType: text("action_type").notNull(),
    primaryMetric: text("primary_metric").notNull(),
    baselineValue: real("baseline_value").notNull().default(0),
    observedValue: real("observed_value").notNull().default(0),
    evidenceJson: text("evidence_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    patternIdx: index("winning_patterns_key_idx").on(
      table.patternKey,
      table.createdAt,
    ),
  }),
);

export const losingPatterns = sqliteTable(
  "losing_patterns",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull(),
    patternKey: text("pattern_key").notNull(),
    bottleneck: text("bottleneck").notNull(),
    actionType: text("action_type").notNull(),
    primaryMetric: text("primary_metric").notNull(),
    baselineValue: real("baseline_value").notNull().default(0),
    observedValue: real("observed_value").notNull().default(0),
    evidenceJson: text("evidence_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    patternIdx: index("losing_patterns_key_idx").on(
      table.patternKey,
      table.createdAt,
    ),
  }),
);

export const sessionHealth = sqliteTable("session_health", {
  scope: text("scope").primaryKey(),
  state: text("state").notNull().default("healthy"),
  provider: text("provider").notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastSuccessAt: text("last_success_at"),
  lastFailureAt: text("last_failure_at"),
  detail: text("detail"),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    jobName: text("job_name").notNull(),
    leaseKey: text("lease_key").notNull(),
    ownerId: text("owner_id").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    dryRun: integer("dry_run").notNull().default(0),
    resultSummary: text("result_summary"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    jobStartedIdx: index("job_runs_job_started_idx").on(
      table.jobName,
      table.startedAt,
    ),
  }),
);

export const jobLeases = sqliteTable("job_leases", {
  id: text("id").primaryKey(),
  leaseKey: text("lease_key").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  heartbeatScope: text("heartbeat_scope"),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const executionOutbox = sqliteTable(
  "execution_outbox",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    targetPlatform: text("target_platform").notNull(),
    operationType: text("operation_type").notNull(),
    status: text("status").notNull().default("pending"),
    payloadJson: text("payload_json").notNull(),
    availableAt: text("available_at").notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: text("claimed_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    idempotencyUniq: uniqueIndex("execution_outbox_idempotency_unique").on(
      table.idempotencyKey,
    ),
  }),
);

export const publicationEvents = sqliteTable(
  "publication_events",
  {
    id: text("id").primaryKey(),
    targetPlatform: text("target_platform").notNull(),
    outboxId: text("outbox_id"),
    draftId: text("draft_id"),
    slotId: text("slot_id"),
    campaignId: text("campaign_id"),
    angleId: text("angle_id"),
    ctaId: text("cta_id"),
    priceVariantId: text("price_variant_id"),
    canaryGroup: text("canary_group"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    externalFingerprint: text("external_fingerprint").notNull(),
    publishedAt: text("published_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    fingerprintUniq: uniqueIndex("publication_events_fingerprint_unique").on(
      table.externalFingerprint,
    ),
  }),
);

export const decisionEvidence = sqliteTable("decision_evidence", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  decisionType: text("decision_type").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const heartbeatStates = sqliteTable("heartbeat_states", {
  jobName: text("job_name").primaryKey(),
  lastRunAt: text("last_run_at"),
  nextNotificationAt: text("next_notification_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lockedBy: text("locked_by"),
  lockedAt: text("locked_at"),
});

export const outboundNotifications = sqliteTable("outbound_notifications", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  content: text("content").notNull(),
  channel: text("channel").notNull().default("file"),
  sentAt: text("sent_at").notNull(),
  deliveredAt: text("delivered_at"),
  error: text("error"),
});

export const competitorSnapshots = sqliteTable("competitor_snapshots", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  data: text("data").notNull(),
  snapshotDate: text("snapshot_date").notNull(),
  createdAt: text("created_at").notNull(),
});

export const competitorAnalyses = sqliteTable("competitor_analyses", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  channel: text("channel").notNull(), // "threads" | "note"
  themes: text("themes").notNull(), // JSON array of theme strings
  hooks: text("hooks").notNull(), // JSON array of hook patterns
  engagementPatterns: text("engagement_patterns").notNull(), // JSON summary
  winningPatterns: text("winning_patterns").notNull(), // JSON array
  rawAnalysis: text("raw_analysis").notNull(), // Full LLM response
  createdAt: text("created_at").notNull(),
});

export const scheduledJobRuns = sqliteTable(
  "scheduled_job_runs",
  {
    id: text("id").primaryKey(),
    jobName: text("job_name").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    dryRun: integer("dry_run").notNull().default(0),
    resultSummary: text("result_summary"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    jobStartedIdx: index("scheduled_job_runs_job_started_idx").on(
      table.jobName,
      table.startedAt,
    ),
  }),
);

export const strategyStates = sqliteTable("strategy_states", {
  key: text("key").primaryKey(),
  scope: text("scope").notNull(),
  stateJson: text("state_json").notNull(),
  summary: text("summary"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const executiveCycles = sqliteTable("executive_cycles", {
  id: text("id").primaryKey(),
  objective: text("objective").notNull(),
  funnelStage: text("funnel_stage").notNull(),
  strategyKey: text("strategy_key").notNull(),
  status: text("status").notNull().default("running"),
  decisionJson: text("decision_json").notNull(),
  summary: text("summary"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
});

export const strategyHistory = sqliteTable(
  "strategy_history",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id").notNull(),
    objective: text("objective").notNull(),
    funnelStage: text("funnel_stage").notNull(),
    reasoning: text("reasoning").notNull(),
    departmentInstructions: text("department_instructions"), // JSON
    stateJson: text("state_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    createdIdx: index("strategy_history_created_idx").on(table.createdAt),
  }),
);

export const departmentNotifications = sqliteTable(
  "department_notifications",
  {
    id: text("id").primaryKey(),
    fromDepartment: text("from_department").notNull(),
    toDepartment: text("to_department").notNull(),
    notificationType: text("notification_type").notNull(), // "research_update" | "analysis_complete" | "instruction"
    content: text("content").notNull(),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    toUnreadIdx: index("dept_notif_to_unread_idx").on(
      table.toDepartment,
      table.readAt,
    ),
  }),
);

export const departmentRuns = sqliteTable(
  "department_runs",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id").notNull(),
    department: text("department").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    departmentCreatedIdx: index("department_runs_department_created_idx").on(
      table.department,
      table.createdAt,
    ),
  }),
);

// Phase 2: Memory, Agent, Budget, KPI, Department, SystemControl tables

export const MEMORY_LAYERS = [
  "persistent_policy",
  "department_summary",
  "event_log",
  "working_memory",
  "kpi_snapshot",
] as const;

export const AGENT_STATUSES = [
  "idle",
  "working",
  "proposing",
  "awaiting_approval",
  "paused",
] as const;

export const BUDGET_PERIODS = ["heartbeat", "daily"] as const;
export const RUNNER_HEALTH_STATUSES = [
  "healthy",
  "degraded",
  "tripped",
] as const;
export const ROLLBACK_STATUSES = ["planned", "executed", "failed"] as const;
export const OPERATIONS_MODES = [
  "full_autonomy",
  "threads_only",
  "observe_only",
  "safe_freeze",
] as const;
export const PATTERN_CHANNELS = ["threads", "note"] as const;

export const KPI_PERIOD_TYPES = ["hourly", "daily", "weekly"] as const;

export const KPI_CHANNELS = ["threads", "note", "operations"] as const;

export const DEPARTMENT_SUMMARY_TYPES = [
  "daily",
  "weekly",
  "win_pattern",
  "fail_pattern",
  "decision",
] as const;

export const SYSTEM_CONTROL_ACTIONS = ["pause", "resume", "stop"] as const;

export const memoryEntries = sqliteTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    layer: text("layer").notNull(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    version: integer("version").notNull().default(1),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    layerScopeKeyUniq: uniqueIndex("memory_entries_layer_scope_key_unique").on(
      table.layer,
      table.scope,
      table.key,
    ),
  }),
);

export const agentStates = sqliteTable("agent_states", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  department: text("department").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull().default("idle"),
  currentTask: text("current_task"),
  lastCompletedTask: text("last_completed_task"),
  budgetUsedTokens: integer("budget_used_tokens").notNull().default(0),
  budgetUsedCalls: integer("budget_used_calls").notNull().default(0),
  lastActiveAt: text("last_active_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const budgetTracking = sqliteTable(
  "budget_tracking",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    period: text("period").notNull(),
    periodKey: text("period_key").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    callsUsed: integer("calls_used").notNull().default(0),
    tokensLimit: integer("tokens_limit").notNull(),
    callsLimit: integer("calls_limit").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    scopePeriodKeyUniq: uniqueIndex(
      "budget_tracking_scope_period_key_unique",
    ).on(table.scope, table.period, table.periodKey),
  }),
);

export const runnerHealth = sqliteTable("runner_health", {
  runner: text("runner").primaryKey(),
  status: text("status").notNull().default("healthy"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  timeoutCount: integer("timeout_count").notNull().default(0),
  invalidJsonCount: integer("invalid_json_count").notNull().default(0),
  totalCalls: integer("total_calls").notNull().default(0),
  lastModel: text("last_model"),
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
  lastSuccessAt: text("last_success_at"),
  lastFailureAt: text("last_failure_at"),
  updatedAt: text("updated_at").notNull(),
});

export const runnerBudgets = sqliteTable(
  "runner_budget",
  {
    id: text("id").primaryKey(),
    runner: text("runner").notNull(),
    periodKey: text("period_key").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    callsUsed: integer("calls_used").notNull().default(0),
    tokensLimit: integer("tokens_limit").notNull(),
    callsLimit: integer("calls_limit").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    runnerPeriodUniq: uniqueIndex("runner_budget_runner_period_unique").on(
      table.runner,
      table.periodKey,
    ),
  }),
);

export const anomalyEvents = sqliteTable("anomaly_events", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  metadataJson: text("metadata_json"),
  detectedAt: text("detected_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const rollbacks = sqliteTable(
  "rollbacks",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    trigger: text("trigger").notNull(),
    reason: text("reason").notNull(),
    previousStateJson: text("previous_state_json"),
    appliedStateJson: text("applied_state_json"),
    status: text("status").notNull().default("executed"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    rollbackScopeCreatedIdx: index("rollbacks_scope_created_idx").on(
      table.scope,
      table.createdAt,
    ),
  }),
);

export const kpiSnapshots = sqliteTable(
  "kpi_snapshots",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    metricName: text("metric_name").notNull(),
    metricValue: real("metric_value").notNull(),
    periodType: text("period_type").notNull(),
    periodKey: text("period_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    channelMetricPeriodUniq: uniqueIndex(
      "kpi_snapshots_channel_metric_period_unique",
    ).on(table.channel, table.metricName, table.periodType, table.periodKey),
  }),
);

export const departmentSummaries = sqliteTable(
  "department_summaries",
  {
    id: text("id").primaryKey(),
    department: text("department").notNull(),
    summaryType: text("summary_type").notNull(),
    content: text("content").notNull(),
    periodKey: text("period_key").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    deptSummaryPeriodUniq: uniqueIndex(
      "department_summaries_dept_type_period_unique",
    ).on(table.department, table.summaryType, table.periodKey),
  }),
);

export const operationsModeState = sqliteTable("operations_mode_state", {
  scope: text("scope").primaryKey(),
  mode: text("mode").notNull().default("full_autonomy"),
  reason: text("reason").notNull(),
  evidenceJson: text("evidence_json"),
  lastTransitionAt: text("last_transition_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const systemControls = sqliteTable(
  "system_controls",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull().default("system"),
    active: integer("active").notNull().default(1),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (table) => ({
    controlScopeActionIdx: index("system_controls_scope_action_active_idx").on(
      table.scope,
      table.action,
      table.active,
    ),
  }),
);
