import {
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
  noteUrl: text("note_url"),
  views: integer("views").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  commentsCount: integer("comments_count").notNull().default(0),
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

export const scheduledJobRuns = sqliteTable("scheduled_job_runs", {
  id: text("id").primaryKey(),
  jobName: text("job_name").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  dryRun: integer("dry_run").notNull().default(0),
  resultSummary: text("result_summary"),
  createdAt: text("created_at").notNull(),
});

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

export const departmentRuns = sqliteTable("department_runs", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  department: text("department").notNull(),
  phase: text("phase").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json"),
  createdAt: text("created_at").notNull(),
});

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
