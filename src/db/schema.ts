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
  "draft",
  "audited",
  "approved",
  "published",
  "rejected",
] as const;
export const AUDIT_VERDICTS = [
  "pass",
  "revise",
  "reject",
  "human_review",
] as const;
export const SEVERITIES = ["low", "medium", "high"] as const;
export const REPLY_DECISIONS = [
  "safe_auto_reply",
  "human_review",
  "ignore",
] as const;
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
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
  "draft",
  "audited",
  "approved",
  "published",
  "rejected",
] as const;

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
  status: text("status").notNull().default("draft"),
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
  publishReadinessScore: real("publish_readiness_score"),
  status: text("status").notNull().default("draft"),
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

export const PROPOSAL_PRIORITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export const PROPOSAL_STATUSES = [
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "executed",
] as const;
export const PROPOSAL_STAGES = [
  "leader_review",
  "executive_review",
  "human_review",
  "approved",
  "rejected",
  "executed",
] as const;

export const BUDGET_PERIODS = ["heartbeat", "daily"] as const;

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

export const proposals = sqliteTable(
  "proposals",
  {
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
    currentStage: text("current_stage").notNull().default("human_review"),
    currentApproverId: text("current_approver_id"),
    reviewerNote: text("reviewer_note"),
    reviewedAt: text("reviewed_at"),
    executedAt: text("executed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    proposalStatusDepartmentIdx: index(
      "proposals_status_department_created_idx",
    ).on(table.status, table.department, table.createdAt),
  }),
);

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

export const humanReviewItems = sqliteTable(
  "human_review_items",
  {
    id: text("id").primaryKey(),
    itemType: text("item_type").notNull(),
    itemId: text("item_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    reviewedAt: text("reviewed_at"),
    reviewerNote: text("reviewer_note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    itemTypeItemIdUniq: uniqueIndex(
      "human_review_items_item_type_item_id_unique",
    ).on(table.itemType, table.itemId),
  }),
);
