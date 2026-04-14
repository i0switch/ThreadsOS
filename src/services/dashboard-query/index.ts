import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import * as s from "../../db/schema.js";
import { memoizeDashboardQuery } from "./request-cache.js";
import { AGENTS } from "../runtime-state/index.js";

function ago(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function tryParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function recordProposalEvent(params: {
  proposalId: string;
  stage: string;
  action: string;
  actorId: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
}) {
  db.insert(s.proposalEvents)
    .values({
      id: randomUUID(),
      proposalId: params.proposalId,
      stage: params.stage,
      action: params.action,
      actorId: params.actorId,
      note: params.note ?? null,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

function readStrategyStateImpl() {
  const row = db
    .select()
    .from(s.strategyStates)
    .where(eq(s.strategyStates.key, "heartbeat:global"))
    .get();

  if (!row) {
    return null;
  }

  const parsed = tryParseJson(row.stateJson);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  return parsed as {
    objective?: string;
    funnelStage?: string;
    priorityTopics?: string[];
    activeActionTypes?: string[];
    insightFocus?: string[];
  };
}

function readStrategyState() {
  return memoizeDashboardQuery("readStrategyState", [], readStrategyStateImpl);
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function latestRowsByKey<T>(
  rows: T[],
  keyOf: (row: T) => string,
  dateOf: (row: T) => string,
): T[] {
  const picked = new Map<string, T>();

  for (const row of rows) {
    const key = keyOf(row);
    const existing = picked.get(key);
    if (!existing) {
      picked.set(key, row);
      continue;
    }

    if (
      new Date(dateOf(row)).getTime() > new Date(dateOf(existing)).getTime()
    ) {
      picked.set(key, row);
    }
  }

  return Array.from(picked.values());
}

const DEPARTMENT_DISPLAY_NAMES: Record<string, string> = {
  command: "管理・指揮系統",
  "external-research": "外部リサーチ",
  "competitive-analysis": "競合リサーチ分析",
  threads: "Threads運用",
  note: "note運用",
  system: "システム",
};

const WORKSTREAM_DEFINITIONS = [
  {
    id: "command",
    label: "管理・指揮系統",
    departments: ["command"],
  },
  {
    id: "external-research",
    label: "外部リサーチ",
    departments: ["external-research"],
  },
  {
    id: "competitive-analysis",
    label: "競合リサーチ分析",
    departments: ["competitive-analysis"],
  },
  {
    id: "threads",
    label: "Threads運用",
    departments: ["threads"],
  },
  {
    id: "note",
    label: "note運用",
    departments: ["note"],
  },
] as const;

function departmentDisplayName(department: string): string {
  return DEPARTMENT_DISPLAY_NAMES[department] ?? department;
}

function hoursSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return (Date.now() - time) / 3_600_000;
}

function latestTimestamp(
  values: Array<string | null | undefined>,
): string | null {
  let latest: string | null = null;

  for (const value of values) {
    if (!value) continue;
    if (!latest || new Date(value).getTime() > new Date(latest).getTime()) {
      latest = value;
    }
  }

  return latest;
}

function statusRank(status: string): number {
  switch (status) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    default:
      return 1;
  }
}

function maxStatus(left: string, right: string): "ok" | "warning" | "critical" {
  return statusRank(left) >= statusRank(right)
    ? (left as "ok" | "warning" | "critical")
    : (right as "ok" | "warning" | "critical");
}

function operationalStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "稼働中";
    case "attention":
      return "注意";
    case "stalled":
      return "停滞";
    default:
      return "待機中";
  }
}

function humanizeInternalText(value: string | null | undefined): string | null {
  if (!value) {
    return value ?? null;
  }

  const replacements: Array<[RegExp, string]> = [
    [/Researched note competitors for (\d+) topics?\.?/g, "note競合を$1テーマ分リサーチ"],
    [/Generated (\d+) drafts, (\d+) passed audit\./g, "投稿案を$1件作成し、$2件が監査を通過"],
    [/Auto-published (\d+) threads posts?/g, "Threads投稿を$1件自動公開"],
    [/Generated (\d+) note drafts\./g, "note下書きを$1件作成"],
    [/Auto-published (\d+) notes?/g, "note記事を$1件自動公開"],
    [/Adjusted by cadence optimizer/g, "投稿ペースを自動調整"],
    [/No draft-bound pending slots to reschedule/g, "動かせる予約枠がなく、時間調整は見送り"],
    [/Note schedule optimized/g, "noteスケジュールを調整した"],
    [/Schedule optimized/g, "スケジュールを調整した"],
    [/Progress notification sent/g, "進捗共有を送信"],
    [/Would process (\d+) recent posts? for followup\.?/g, "直近$1件の投稿をフォローアップ予定"],
    [/Processed (\d+) posts? for post publish followup\.?/g, "$1件の投稿をフォローアップ処理"],
    [/No posts found for followup in the last 24 hours\.?/g, "直近24時間にフォローアップ対象の投稿なし"],
    [/Researched (\d+) topics?\.?/g, "$1テーマをリサーチ"],
    [/\[DRY-RUN\] Would generate note drafts from winning themes\.?/g, "(テスト) 勝ちテーマからnote下書きを生成予定"],
    [/\[HEARTBEAT\] LLM task [a-f0-9-]+ timed out after \d+/g, "LLMタスクがタイムアウト"],
    [/\[HEARTBEAT\] LLM task [a-f0-9-]+ failed: .*/g, "LLMタスクが失敗"],
    [/Too many parameter values were provided/g, "パラメータが多すぎてエラー"],
    [/NOT NULL constraint failed: .*/g, "データ保存エラー（必須項目が空）"],
    [/fetch failed/g, "外部通信に失敗"],
    [/\bnightly-note-pipeline\b/g, "夜間note運用"],
    [/\bhourly-heartbeat\b/g, "定期チェック"],
    [/\bnote-competitor-research\b/g, "note競合リサーチ"],
    [/\bweekly-retro\b/g, "週次ふりかえり"],
    [/\bpost-publish-followup\b/g, "公開後フォロー"],
    [/\bheartbeat running\b/g, "定期チェックを実行中"],
    [/\bfunnel_expansion\b/g, "ファネル拡大"],
    [/\bbootstrap\b/g, "立ち上げ"],
    [/\bgenerate_and_post\b/g, "投稿を作成して公開"],
    [/\bgenerate_note\b/g, "note記事生成"],
    [/\bgenerate_thread\b/g, "Threads投稿生成"],
    [/\bresearch_note\b/g, "noteリサーチ"],
    [/\bresearch_thread\b/g, "Threadsリサーチ"],
    [/\breply_safe\b/g, "安全に返信"],
    [/\bfetch_engagement\b/g, "反応確認"],
    [/\banalyze_competitors\b/g, "競合分析の実行"],
    [/\bfetch_competitor_updates\b/g, "競合データの更新"],
    [/\boptimize_schedule\b/g, "投稿スケジュールの最適化"],
    [/\bweekly_retro\b/g, "週次振り返り"],
    [/\bnotify\b/g, "進捗通知の送信"],
    [/\bprocess_human_inputs\b/g, "ユーザー入力の処理"],
    [/\bworking\b/g, "実行中"],
    [/\bidle\b/g, "待機中"],
    [/\bpaused\b/g, "停止中"],
    [/\bactive\b/g, "稼働中"],
    [/\bcompleted\b/g, "完了"],
    [/\bfailed\b/g, "失敗"],
    [/\brunning\b/g, "実行中"],
    [/objective未設定/g, "方針未設定"],
    [/stage未設定/g, "段階未設定"],
    [/status未設定/g, "状態未設定"],
    [/actions:/g, "実行内容:"],
    [/strategy:/g, "方針:"],
  ];

  let result = value;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  return result.replace(/\s+/g, " ").trim();
}

function humanizePolicyText(value: string | null | undefined): string | null {
  const humanized = humanizeInternalText(value);
  if (!humanized) {
    return humanized;
  }

  return humanized
    .replace(/ \/\s/g, " → ")
    .replace(/\[方針:([^\]]+)\]/g, "（方針:$1）")
    .trim();
}

const OBJECTIVE_LABELS: Record<string, string> = {
  directive_assimilation: "指示吸収フェーズ",
  funnel_expansion: "ファネル拡大フェーズ",
  engagement_compounding: "エンゲージメント強化フェーズ",
};

const ACTION_LABELS: Record<string, string> = {
  generate_and_post: "Threads投稿の生成と公開",
  generate_note: "note記事の生成",
  fetch_engagement: "エンゲージメントの取得",
  reply_safe: "安全なリプライの送信",
  optimize_schedule: "投稿スケジュールの最適化",
  research_threads: "Threadsテーマのリサーチ",
  research_note: "note競合のリサーチ",
  analyze_competitors: "競合分析の実行",
  fetch_competitor_updates: "競合データの更新",
  weekly_retro: "週次振り返り",
  notify: "進捗通知の送信",
  process_human_inputs: "ユーザー入力の処理",
};

const PREFERRED_WORKERS: Record<string, string> = {
  research_threads: "trend-researcher",
  research_note: "note-competitor-researcher",
  generate_and_post: "threads-post-generator",
  generate_note: "note-article-generator",
  fetch_engagement: "threads-engagement-analyst",
  reply_safe: "threads-reply-generator",
  weekly_retro: "threads-operations-director",
  optimize_schedule: "threads-operations-director",
  notify: "executive-director",
  process_human_inputs: "executive-director",
  analyze_competitors: "engagement-analyst",
  fetch_competitor_updates: "threads-competitor-researcher",
};

function resolveAgentName(actionType: string): string {
  const agentId = PREFERRED_WORKERS[actionType];
  const agent = agentId ? AGENTS.find((a) => a.id === agentId) : null;
  return agent?.name ?? actionType;
}

function buildDerivedKpis() {
  const proposals = db.select().from(s.proposals).all();
  const jobRuns = db.select().from(s.scheduledJobRuns).all();
  const budgets = db.select().from(s.budgetTracking).all();
  const notes = db.select().from(s.notePostResults).all();
  const now = new Date().toISOString();

  const approvedProposals = proposals.filter(
    (row) => row.status === "approved" || row.status === "executed",
  ).length;
  const completedJobs = jobRuns.filter(
    (row) => row.status === "completed",
  ).length;
  const failedJobs = jobRuns.filter((row) => row.status === "failed").length;
  const activeBudget = latestRowsByKey(
    budgets,
    (row) => `${row.scope}:${row.period}:${row.periodKey}`,
    (row) => row.updatedAt,
  );
  const budgetUtilization =
    activeBudget.length > 0
      ? activeBudget.reduce((sum, row) => {
          const tokenRatio =
            row.tokensLimit > 0 ? row.tokensUsed / row.tokensLimit : 0;
          const callRatio =
            row.callsLimit > 0 ? row.callsUsed / row.callsLimit : 0;
          return sum + Math.max(tokenRatio, callRatio);
        }, 0) / activeBudget.length
      : 0;
  const totalRevenue = sumBy(notes, (row) => row.revenueYen);
  const totalPurchases = sumBy(notes, (row) => row.purchasesCount);
  const averageCv =
    notes.length > 0
      ? notes.reduce((sum, row) => sum + row.conversionRate, 0) / notes.length
      : 0;

  return [
    {
      id: "derived:proposal-adoption-rate",
      channel: "operations",
      periodType: "derived",
      periodKey: "current",
      metricName: "proposal_adoption_rate",
      metricValue:
        proposals.length > 0 ? approvedProposals / proposals.length : 0,
      metrics: {
        proposal_adoption_rate:
          proposals.length > 0 ? approvedProposals / proposals.length : 0,
      },
      createdAt: now,
    },
    {
      id: "derived:job-success-rate",
      channel: "operations",
      periodType: "derived",
      periodKey: "current",
      metricName: "job_success_rate",
      metricValue: jobRuns.length > 0 ? completedJobs / jobRuns.length : 0,
      metrics: {
        job_success_rate:
          jobRuns.length > 0 ? completedJobs / jobRuns.length : 0,
        job_error_rate: jobRuns.length > 0 ? failedJobs / jobRuns.length : 0,
      },
      createdAt: now,
    },
    {
      id: "derived:budget-utilization",
      channel: "operations",
      periodType: "derived",
      periodKey: "current",
      metricName: "budget_utilization",
      metricValue: budgetUtilization,
      metrics: { budget_utilization: budgetUtilization },
      createdAt: now,
    },
    {
      id: "derived:note-revenue",
      channel: "note",
      periodType: "derived",
      periodKey: "current",
      metricName: "revenue_yen",
      metricValue: totalRevenue,
      metrics: {
        revenue_yen: totalRevenue,
        purchases_count: totalPurchases,
        average_conversion_rate: averageCv,
      },
      createdAt: now,
    },
  ];
}

function proposalStatusFromApprovedBy(approvedBy: string): string {
  switch (approvedBy) {
    case "human_approved":
    case "auto":
      return "approved";
    case "human_rejected":
      return "rejected";
    default:
      return "pending";
  }
}

export interface DashboardProposalRow {
  id: string;
  agentId: string;
  leaderAgentId: string | null;
  executiveAgentId: string | null;
  department: string;
  title: string;
  description: string;
  reason: string;
  evidence: string;
  expectedEffect: string;
  risk: string | null;
  priority: string;
  status: string;
  currentStage: string;
  currentApproverId: string | null;
  reviewerNote: string | null;
  reviewedAt: string | null;
  executedAt: string | null;
  createdAt: string;
  source: "proposal" | "optimization_decision";
}

export interface ProposalHistoryEntry {
  id: string;
  stage: string;
  action: string;
  actorId: string;
  note: string | null;
  metadataJson: string | null;
  createdAt: string;
}

export interface ProposalDetail {
  proposal: DashboardProposalRow;
  history: ProposalHistoryEntry[];
  currentStage: string;
  currentApproverId: string | null;
  relatedDepartmentControls: Array<{
    id: string;
    scope: string;
    action: string;
    reason: string;
    createdAt: string;
  }>;
}

function legacyProposalRows(): DashboardProposalRow[] {
  return db
    .select()
    .from(s.optimizationDecisions)
    .orderBy(desc(s.optimizationDecisions.createdAt))
    .limit(50)
    .all()
    .map((row) => ({
      id: row.id,
      agentId: "legacy-optimizer",
      leaderAgentId: null,
      executiveAgentId: null,
      department: row.channel,
      title: `${row.decisionType} adjustment`,
      description: `${row.beforeValue} -> ${row.afterValue}`,
      reason: row.reason,
      evidence: JSON.stringify({
        channel: row.channel,
        beforeValue: row.beforeValue,
        afterValue: row.afterValue,
        changePercent: row.changePercent,
      }),
      expectedEffect: row.afterValue,
      risk: null,
      priority: "medium",
      status: proposalStatusFromApprovedBy(row.approvedBy),
      currentStage: proposalStatusFromApprovedBy(row.approvedBy),
      currentApproverId: null,
      reviewerNote: null,
      reviewedAt: null,
      executedAt: null,
      createdAt: row.createdAt,
      source: "optimization_decision" as const,
    }));
}

function currentProposalRowsImpl(status?: string): DashboardProposalRow[] {
  const rows = db
    .select()
    .from(s.proposals)
    .orderBy(desc(s.proposals.createdAt))
    .limit(100)
    .all()
    .map((row) => ({
      ...row,
      leaderAgentId: row.leaderAgentId,
      executiveAgentId: row.executiveAgentId,
      source: "proposal" as const,
    }));

  const filtered = status ? rows.filter((row) => row.status === status) : rows;
  if (filtered.length > 0) {
    return filtered.slice(0, 50);
  }

  const legacyRows = legacyProposalRows();
  return status
    ? legacyRows.filter((row) => row.status === status)
    : legacyRows;
}

function currentProposalRows(status?: string): DashboardProposalRow[] {
  return memoizeDashboardQuery("currentProposalRows", [status ?? null], () =>
    currentProposalRowsImpl(status),
  );
}

export interface DashboardSummary {
  currentTheme: string;
  currentPolicy: string;
  health: "ok" | "warning" | "critical";
  healthHeadline: string;
  healthReasons: string[];
  lastHeartbeatAt: string | null;
  nextHeartbeatAt: string | null;
  heartbeatFreshness: "fresh" | "stale" | "missing";
  nextHeartbeat: { jobName: string; nextAt: string | null } | null;
  threads24h: { published: number; impressions: number; likes: number };
  threads7d: { published: number; impressions: number; likes: number };
  notes24h: {
    published: number;
    views: number;
    likes: number;
    revenueYen: number;
  };
  notes7d: {
    published: number;
    views: number;
    likes: number;
    revenueYen: number;
  };
  nextHeartbeats: Array<{ jobName: string; nextAt: string | null }>;
  userActionItems: Array<{
    id: string;
    level: "critical" | "warning";
    title: string;
    description: string;
  }>;
  channelSnapshots: Array<{
    channel: "threads" | "note";
    label: string;
    status: "running" | "attention" | "stalled" | "idle";
    headline: string;
    summary: string;
    blockers: string[];
    nextStep: string;
    lastActivityAt: string | null;
    metrics24h: {
      published: number;
      impressionsOrViews: number;
      likes: number;
      revenueYen: number;
    };
    metrics7d: {
      published: number;
      impressionsOrViews: number;
      likes: number;
      revenueYen: number;
    };
  }>;
  workstreamSnapshots: Array<{
    id: string;
    label: string;
    departments: string[];
    status: "ok" | "warning" | "critical";
    headline: string;
    summary: string;
    blockers: string[];
    activeAgents: number;
    pendingItems: number;
    lastActivityAt: string | null;
  }>;
  alerts: Array<{
    id: string;
    type: string;
    reason: string;
    createdAt: string;
  }>;
  importantAlerts: Array<{
    id: string;
    type: string;
    scope: string | null;
    department: string | null;
    reason: string;
    createdAt: string;
  }>;
  recentDecisions: Array<{
    id: string;
    channel: string;
    decisionType: string;
    reason: string;
    createdAt: string;
  }>;
  activeControls: Array<{
    id: string;
    scope: string;
    action: string;
    reason: string;
    createdAt: string;
  }>;
  budgetStatus: Array<{
    scope: string;
    period: string;
    periodKey: string;
    tokensUsed: number;
    callsUsed: number;
    tokensLimit: number;
    callsLimit: number;
    tokensRemaining: number;
    callsRemaining: number;
    utilization: number;
  }>;
  proposalStats: Record<string, number>;
  departmentHighlights: Array<{
    department: string;
    summaryType: string;
    content: string;
    periodKey: string;
    updatedAt: string;
  }>;
  agentHighlights: Array<{
    id: string;
    name: string;
    department: string;
    role: string;
    status: string;
    currentTask: string | null;
    lastActiveAt: string | null;
  }>;
}

function getSummaryImpl(): DashboardSummary {
  const now24h = ago(24);
  const now7d = ago(24 * 7);
  const strategyState = readStrategyState();

  const threadRows24h = db
    .select()
    .from(s.threadPostResults)
    .where(gte(s.threadPostResults.publishedAt, now24h))
    .all();
  const threadRows7d = db
    .select()
    .from(s.threadPostResults)
    .where(gte(s.threadPostResults.publishedAt, now7d))
    .all();
  const noteRows24h = db
    .select()
    .from(s.notePostResults)
    .where(gte(s.notePostResults.publishedAt, now24h))
    .all();
  const noteRows7d = db
    .select()
    .from(s.notePostResults)
    .where(gte(s.notePostResults.publishedAt, now7d))
    .all();

  const heartbeatRows = db.select().from(s.heartbeatStates).all();
  const nextHeartbeats = heartbeatRows.map((row) => ({
    jobName: row.jobName,
    nextAt: row.nextNotificationAt,
  }));
  const primaryHeartbeat =
    heartbeatRows.find((row) => row.jobName === "hourly-heartbeat") ??
    heartbeatRows[0] ??
    null;
  const nextHeartbeat =
    nextHeartbeats
      .filter((row) => row.nextAt)
      .sort((left, right) => {
        const leftTime = left.nextAt ? new Date(left.nextAt).getTime() : 0;
        const rightTime = right.nextAt ? new Date(right.nextAt).getTime() : 0;
        return leftTime - rightTime;
      })[0] ??
    nextHeartbeats[0] ??
    null;
  const lastHeartbeatAt = primaryHeartbeat?.lastRunAt ?? null;
  const nextHeartbeatAt =
    primaryHeartbeat?.nextNotificationAt ?? nextHeartbeat?.nextAt ?? null;
  const heartbeatAgeHours = hoursSince(lastHeartbeatAt);
  const heartbeatFreshness: "fresh" | "stale" | "missing" = !primaryHeartbeat
    ? "missing"
    : !nextHeartbeatAt || heartbeatAgeHours === null
      ? "missing"
      : primaryHeartbeat.consecutiveFailures >= 2 || heartbeatAgeHours > 2.5
        ? "stale"
        : "fresh";

  const pendingReviewsRows = db
    .select()
    .from(s.humanReviewItems)
    .where(eq(s.humanReviewItems.status, "pending"))
    .orderBy(desc(s.humanReviewItems.createdAt))
    .all();
  const pendingProposalRows = db
    .select()
    .from(s.proposals)
    .where(eq(s.proposals.status, "pending"))
    .orderBy(desc(s.proposals.createdAt))
    .all();

  const alerts = [
    ...pendingReviewsRows.slice(0, 10).map((row) => ({
      id: row.id,
      type: row.itemType,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
    ...pendingProposalRows.slice(0, 10).map((row) => ({
      id: row.id,
      type: "proposal",
      reason: row.title,
      createdAt: row.createdAt,
    })),
  ]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    .slice(0, 10);
  const importantAlerts = [
    ...pendingReviewsRows.slice(0, 10).map((row) => ({
      id: row.id,
      type: row.itemType,
      scope: null,
      department: null,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
    ...pendingProposalRows.slice(0, 10).map((row) => ({
      id: row.id,
      type: "proposal",
      scope: row.department,
      department: row.department,
      reason: `${row.title} / ${row.priority}`,
      createdAt: row.createdAt,
    })),
    ...db
      .select()
      .from(s.systemControls)
      .where(eq(s.systemControls.active, 1))
      .orderBy(desc(s.systemControls.createdAt))
      .limit(10)
      .all()
      .map((row) => ({
        id: row.id,
        type: row.action,
        scope: row.scope,
        department: row.scope === "global" ? null : row.scope,
        reason: row.reason,
        createdAt: row.createdAt,
      })),
  ]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    .slice(0, 10);

  const recentDecisions = [
    ...db
      .select()
      .from(s.proposals)
      .orderBy(desc(s.proposals.createdAt))
      .limit(10)
      .all()
      .map((row) => ({
        id: row.id,
        channel: row.department,
        decisionType: row.status,
        reason: row.title,
        createdAt: row.createdAt,
      })),
    ...db
      .select()
      .from(s.optimizationDecisions)
      .orderBy(desc(s.optimizationDecisions.createdAt))
      .limit(10)
      .all()
      .map((row) => ({
        id: row.id,
        channel: row.channel,
        decisionType: row.decisionType,
        reason: row.reason,
        createdAt: row.createdAt,
      })),
  ]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    .slice(0, 10);

  const activeControls = db
    .select()
    .from(s.systemControls)
    .where(eq(s.systemControls.active, 1))
    .orderBy(desc(s.systemControls.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      scope: row.scope,
      action: row.action,
      reason: row.reason,
      createdAt: row.createdAt,
    }));

  const budgetStatus = latestRowsByKey(
    db.select().from(s.budgetTracking).all(),
    (row) => `${row.scope}:${row.period}`,
    (row) => row.updatedAt,
  )
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() -
        new Date(left.updatedAt).getTime(),
    )
    .slice(0, 8)
    .map((row) => {
      const tokensRemaining = row.tokensLimit - row.tokensUsed;
      const callsRemaining = row.callsLimit - row.callsUsed;
      const tokenRatio =
        row.tokensLimit > 0 ? row.tokensUsed / row.tokensLimit : 0;
      const callRatio = row.callsLimit > 0 ? row.callsUsed / row.callsLimit : 0;

      return {
        scope: row.scope,
        period: row.period,
        periodKey: row.periodKey,
        tokensUsed: row.tokensUsed,
        callsUsed: row.callsUsed,
        tokensLimit: row.tokensLimit,
        callsLimit: row.callsLimit,
        tokensRemaining,
        callsRemaining,
        utilization: Math.max(tokenRatio, callRatio),
      };
    });

  const proposalStats = db
    .select()
    .from(s.proposals)
    .all()
    .reduce<Record<string, number>>((stats, row) => {
      stats[row.status] = (stats[row.status] ?? 0) + 1;
      return stats;
    }, {});

  const departmentHighlights = latestRowsByKey(
    db.select().from(s.departmentSummaries).all(),
    (row) => `${row.department}:${row.summaryType}`,
    (row) => row.updatedAt,
  )
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() -
        new Date(left.updatedAt).getTime(),
    )
    .slice(0, 8)
    .map((row) => ({
      department: row.department,
      summaryType: row.summaryType,
      content: humanizeInternalText(row.content) ?? row.content,
      periodKey: row.periodKey,
      updatedAt: row.updatedAt,
    }));
  const allAgents = getAgents();
  const agentHighlights = allAgents
    .filter((row) => row.source === "agent_state")
    .slice(0, 6)
    .map((row) => ({
      id: row.id,
      name: row.name,
      department: row.department,
      role: row.role,
      status: row.status,
      currentTask: humanizeInternalText(row.currentTask),
      lastActiveAt: row.lastActiveAt,
    }));

  const departmentOverviews = getDepartments();
  const pendingReviews = pendingReviewsRows.length;
  const pendingProposals = pendingProposalRows.length;
  const recentJobRuns = db
    .select()
    .from(s.scheduledJobRuns)
    .orderBy(desc(s.scheduledJobRuns.createdAt))
    .limit(8)
    .all();
  const recentFailedJobs = recentJobRuns.filter(
    (row) => row.status === "failed",
  ).length;
  const staleDepartments = departmentOverviews.filter((row) => row.stale);

  const noteDepartments = departmentOverviews.filter(
    (row) => row.department === "note",
  );
  const threadsDepartments = departmentOverviews.filter(
    (row) => row.department === "threads",
  );
  const noteAgents = allAgents.filter((row) => row.department === "note");
  const threadsAgents = allAgents.filter((row) => row.department === "threads");

  const noteLastActivityAt = latestTimestamp(
    noteDepartments
      .map((row) => row.lastRunAt)
      .concat(noteAgents.map((row) => row.lastActiveAt)),
  );
  const threadsLastActivityAt = latestTimestamp(
    threadsDepartments
      .map((row) => row.lastRunAt)
      .concat(threadsAgents.map((row) => row.lastActiveAt)),
  );

  const noteIdleTooLong =
    (hoursSince(noteLastActivityAt) ?? Number.POSITIVE_INFINITY) > 12;
  const threadsIdleTooLong =
    (hoursSince(threadsLastActivityAt) ?? Number.POSITIVE_INFINITY) > 6;
  const noteRecentFailures = db
    .select()
    .from(s.departmentRuns)
    .where(eq(s.departmentRuns.department, "note"))
    .orderBy(desc(s.departmentRuns.createdAt))
    .limit(5)
    .all()
    .filter((row) => row.status === "failed").length;
  const threadsRecentFailures = db
    .select()
    .from(s.departmentRuns)
    .where(eq(s.departmentRuns.department, "threads"))
    .orderBy(desc(s.departmentRuns.createdAt))
    .limit(5)
    .all()
    .filter((row) => row.status === "failed").length;

  const threadsBlockers = unique(
    [
      ...threadsDepartments
        .map((row) => row.blockingReason)
        .filter((value): value is string => !!value),
      pendingReviews > 0 ? `${pendingReviews}件の自動処理停止が残っている` : null,
      threadsRecentFailures > 0 ? "直近の投稿処理で失敗が出ている" : null,
    ].filter((value): value is string => value !== null),
  );
  const noteBlockers = unique(
    [
      ...noteDepartments
        .map((row) => row.blockingReason)
        .filter((value): value is string => !!value),
      noteIdleTooLong && noteRows24h.length === 0
        ? "note運用の動きが止まっている"
        : null,
      noteRecentFailures > 0 ? "直近のnote生成で失敗が出ている" : null,
    ].filter((value): value is string => value !== null),
  );

  const threadsStatus: "running" | "attention" | "stalled" =
    threadsIdleTooLong || threadsRecentFailures >= 2
      ? "stalled"
      : threadsBlockers.length > 0
        ? "attention"
        : "running";
  const noteStatus: "running" | "attention" | "stalled" | "idle" =
    noteIdleTooLong || noteRecentFailures >= 2
      ? "stalled"
      : noteBlockers.length > 0
        ? "attention"
        : noteAgents.some((agent) => agent.status === "working") ||
            noteRows24h.length > 0
          ? "running"
          : "idle";

  let health: "ok" | "warning" | "critical" = "ok";
  const healthReasons: string[] = [];

  if (heartbeatFreshness === "missing") {
    health = maxStatus(health, "critical");
    healthReasons.push("定期チェックの次回予定が見つからない");
  } else if (heartbeatFreshness === "stale") {
    health = maxStatus(health, "critical");
    healthReasons.push("定期チェックが古いか失敗を繰り返している");
  }

  if (pendingReviews >= 10) {
    health = maxStatus(health, "critical");
    healthReasons.push(`自動処理が止まった確認待ちが ${pendingReviews}件ある`);
  } else if (pendingReviews >= 3) {
    health = maxStatus(health, "warning");
    healthReasons.push(`自動処理が止まった確認待ちが ${pendingReviews}件ある`);
  }

  if (pendingProposals >= 3) {
    health = maxStatus(health, "warning");
    healthReasons.push(`承認待ちの提案が ${pendingProposals}件ある`);
  }

  if (recentFailedJobs >= 2) {
    health = maxStatus(health, "critical");
    healthReasons.push("直近の定期ジョブで失敗が続いている");
  } else if (recentFailedJobs === 1) {
    health = maxStatus(health, "warning");
    healthReasons.push("直近の定期ジョブで失敗が出ている");
  }

  if (activeControls.length > 0) {
    health = maxStatus(health, "warning");
    healthReasons.push("手動で止めている処理がある");
  }

  if (noteStatus === "stalled") {
    health = maxStatus(health, "warning");
    healthReasons.push("note運用の動きが止まっている");
  }

  if (staleDepartments.length > 0) {
    health = maxStatus(health, "warning");
    healthReasons.push(
      `${staleDepartments.length}部署で最終実行から時間が空いている`,
    );
  }

  const userActionItems: DashboardSummary["userActionItems"] = [];
  if (pendingReviews > 0) {
    userActionItems.push({
      id: "reviews",
      level: pendingReviews >= 10 ? "critical" : "warning",
      title: `確認待ち ${pendingReviews}件`,
      description: "自動処理が止まった項目を承認管理で確認する",
    });
  }
  if (pendingProposals > 0) {
    userActionItems.push({
      id: "proposals",
      level: "warning",
      title: `提案待ち ${pendingProposals}件`,
      description: "改善提案の承認・却下を判断する",
    });
  }
  if (importantAlerts.length > 0) {
    userActionItems.push({
      id: "alerts",
      level: health === "critical" ? "critical" : "warning",
      title: `重要アラート ${importantAlerts.length}件`,
      description: "停止やタイムアウトの原因を先に確認する",
    });
  }
  if (noteStatus === "stalled") {
    userActionItems.push({
      id: "note-stalled",
      level: "warning",
      title: "note運用が停滞",
      description: "note生成の停止理由と未処理タスクを確認する",
    });
  }

  const channelSnapshots: DashboardSummary["channelSnapshots"] = [
    {
      channel: "threads",
      label: "Threads",
      status: threadsStatus,
      headline: `直近7日で ${threadRows7d.length}件投稿・${sumBy(threadRows7d, (row) => row.impressions)} 表示`,
      summary:
        threadsStatus === "running"
          ? "集客用の投稿運用は回っている"
          : threadsStatus === "attention"
            ? "投稿運用は動いているが、一部に停滞や再試行がある"
            : "投稿生成か公開のどこかで止まっている",
      blockers: threadsBlockers,
      nextStep:
        threadsStatus === "running"
          ? "勝ちテーマを維持しながら投稿を継続する"
          : "投稿の停止理由とレビュー滞留を先に解消する",
      lastActivityAt: threadsLastActivityAt,
      metrics24h: {
        published: threadRows24h.length,
        impressionsOrViews: sumBy(threadRows24h, (row) => row.impressions),
        likes: sumBy(threadRows24h, (row) => row.likes),
        revenueYen: 0,
      },
      metrics7d: {
        published: threadRows7d.length,
        impressionsOrViews: sumBy(threadRows7d, (row) => row.impressions),
        likes: sumBy(threadRows7d, (row) => row.likes),
        revenueYen: 0,
      },
    },
    {
      channel: "note",
      label: "note",
      status: noteStatus,
      headline: `直近7日で ${noteRows7d.length}本公開・売上 ¥${sumBy(noteRows7d, (row) => row.revenueYen)}`,
      summary:
        noteStatus === "running"
          ? "note記事の作成と収益化に動きがある"
          : noteStatus === "attention"
            ? "note運用は動いているが、生成失敗や確認不足が混ざっている"
            : noteStatus === "idle"
              ? "note運用は待機中で、新しい成果はまだ出ていない"
              : "note生成の流れが止まっている",
      blockers: noteBlockers,
      nextStep:
        noteStatus === "running"
          ? "反応の良いテーマから記事化を続ける"
          : "note生成の失敗原因と停滞箇所を先に確認する",
      lastActivityAt: noteLastActivityAt,
      metrics24h: {
        published: noteRows24h.length,
        impressionsOrViews: sumBy(noteRows24h, (row) => row.views),
        likes: sumBy(noteRows24h, (row) => row.likes),
        revenueYen: sumBy(noteRows24h, (row) => row.revenueYen),
      },
      metrics7d: {
        published: noteRows7d.length,
        impressionsOrViews: sumBy(noteRows7d, (row) => row.views),
        likes: sumBy(noteRows7d, (row) => row.likes),
        revenueYen: sumBy(noteRows7d, (row) => row.revenueYen),
      },
    },
  ];

  const workstreamSnapshots: DashboardSummary["workstreamSnapshots"] =
    WORKSTREAM_DEFINITIONS.map((definition) => {
      const rows = departmentOverviews.filter((row) =>
        (definition.departments as readonly string[]).includes(row.department),
      );
      const blockers = unique(
        rows
          .map((row) => row.blockingReason)
          .filter((value): value is string => !!value),
      );
      const pendingItems = rows.reduce(
        (total, row) => total + row.pendingProposals,
        0,
      );
      const activeAgents = rows.reduce(
        (total, row) => total + row.activeAgents,
        0,
      );
      const hasCritical = rows.some(
        (row) => row.paused || row.recentStatus === "failed",
      );
      const hasWarning = rows.some((row) => row.stale || !!row.blockingReason);
      const baseStatus = hasCritical ? "critical" : hasWarning ? "warning" : "ok";
      const status =
        definition.id === "note"
          ? noteStatus === "stalled"
            ? "critical"
            : noteStatus === "attention" || noteStatus === "idle"
              ? "warning"
              : "ok"
          : definition.id === "threads"
            ? threadsStatus === "stalled"
              ? "critical"
              : threadsStatus === "attention"
                ? "warning"
                : "ok"
            : baseStatus;
      const lastActivityAt = latestTimestamp(rows.map((row) => row.lastRunAt));
      const latestSummary = rows.find((row) => row.latestSummary)?.latestSummary;
      const summary =
        definition.id === "note" && noteStatus === "stalled"
          ? "note記事の作成と収益化が停滞している"
          : definition.id === "threads" && threadsStatus !== "running"
            ? "Threads投稿は動いているが、止まりや確認待ちが混ざっている"
            : humanizeInternalText(latestSummary) ??
              (status === "ok"
                ? "自律運用は大きく止まっていない"
                : status === "warning"
                  ? "一部に停滞や確認待ちがある"
                  : "止まっている処理があり、確認が必要");

      return {
        id: definition.id,
        label: definition.label,
        departments: definition.departments.map((department) =>
          departmentDisplayName(department),
        ),
        status,
        headline: `${rows.length}部署 / ${activeAgents}担当 / 未処理${pendingItems}件`,
        summary,
        blockers,
        activeAgents,
        pendingItems,
        lastActivityAt,
      };
    });

  const currentTheme =
    strategyState?.priorityTopics?.[0] ??
    departmentHighlights[0]?.content ??
    recentDecisions[0]?.reason ??
    "未設定";
  const currentPolicyParts = [
    strategyState?.objective ?? "objective未設定",
    strategyState?.funnelStage ?? "stage未設定",
    strategyState?.activeActionTypes?.length
      ? `actions:${strategyState.activeActionTypes.join(", ")}`
      : null,
  ].filter((value): value is string => value !== null);
  const healthHeadlineParts = [
    `Threadsは${operationalStatusLabel(threadsStatus)}`,
    `noteは${operationalStatusLabel(noteStatus)}`,
    pendingReviews + pendingProposals > 0
      ? `AIが${pendingReviews + pendingProposals}件の判断を処理中`
      : null,
  ].filter((value): value is string => value !== null);

  return {
    currentTheme,
    currentPolicy:
      humanizePolicyText(currentPolicyParts.join(" / ")) ?? "方針未設定",
    health,
    healthHeadline: healthHeadlineParts.join("、"),
    healthReasons,
    lastHeartbeatAt,
    nextHeartbeatAt,
    heartbeatFreshness,
    nextHeartbeat,
    threads24h: {
      published: threadRows24h.length,
      impressions: sumBy(threadRows24h, (row) => row.impressions),
      likes: sumBy(threadRows24h, (row) => row.likes),
    },
    threads7d: {
      published: threadRows7d.length,
      impressions: sumBy(threadRows7d, (row) => row.impressions),
      likes: sumBy(threadRows7d, (row) => row.likes),
    },
    notes24h: {
      published: noteRows24h.length,
      views: sumBy(noteRows24h, (row) => row.views),
      likes: sumBy(noteRows24h, (row) => row.likes),
      revenueYen: sumBy(noteRows24h, (row) => row.revenueYen),
    },
    notes7d: {
      published: noteRows7d.length,
      views: sumBy(noteRows7d, (row) => row.views),
      likes: sumBy(noteRows7d, (row) => row.likes),
      revenueYen: sumBy(noteRows7d, (row) => row.revenueYen),
    },
    nextHeartbeats,
    userActionItems,
    channelSnapshots,
    workstreamSnapshots,
    alerts,
    importantAlerts,
    recentDecisions,
    activeControls,
    budgetStatus,
    proposalStats,
    departmentHighlights,
    agentHighlights,
  };
}

export function getSummary(): DashboardSummary {
  return memoizeDashboardQuery("getSummary", [], getSummaryImpl);
}

type StoryboardStatus = "working" | "attention" | "stalled" | "idle";
type InboxLevel = "critical" | "warning" | "info";
type SetupStatus = "done" | "inferred" | "missing";
type TimelineActorType = "ai" | "human" | "system";
type TimelineKind =
  | "approval"
  | "rejection"
  | "pause"
  | "resume"
  | "directive"
  | "ai_action"
  | "error"
  | "stall"
  | "policy_change"
  | "review";

function setupStatusLabel(status: SetupStatus): string {
  switch (status) {
    case "done":
      return "完了";
    case "inferred":
      return "確認中";
    default:
      return "未設定";
  }
}

function metricDisplayName(key: string): string {
  const labels: Record<string, string> = {
    recommendedPostsPerDay: "推奨投稿数/日",
    minIntervalHours: "投稿の最小間隔",
    reasoning: "判断理由",
    slotsUpdated: "更新した枠数",
    source: "データ元",
    beforeValue: "変更前",
    afterValue: "変更後",
    changePercent: "変化率",
    channel: "対象",
    content: "内容",
    scope: "対象範囲",
    target: "反映先",
    priority: "優先度",
    department: "チーム",
    agentId: "担当AI",
    objective: "運用方針",
    funnelStage: "導線の段階",
  };

  return labels[key] ?? key;
}

function humanizeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "string") {
    return humanizeInternalText(value) ?? value;
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString("ja-JP")
      : value.toFixed(2);
  }

  if (typeof value === "boolean") {
    return value ? "はい" : "いいえ";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 4)
      .map((item) => humanizeValue(item))
      .join(" / ");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .slice(0, 4)
      .map(([key, item]) => `${metricDisplayName(key)}: ${humanizeValue(item)}`)
      .join(" / ");
  }

  return String(value);
}

function detailLinesFromValue(
  value: unknown,
  fallback = "情報なし",
  limit = 4,
): string[] {
  const parsed =
    typeof value === "string" ? tryParseJson(value) ?? value : value ?? null;

  if (parsed === null || parsed === undefined || parsed === "") {
    return [fallback];
  }

  if (typeof parsed === "string") {
    return [humanizeInternalText(parsed) ?? parsed];
  }

  if (Array.isArray(parsed)) {
    const lines = parsed
      .slice(0, limit)
      .map((item) => humanizeValue(item))
      .filter((item) => item !== "-");
    return lines.length > 0 ? lines : [fallback];
  }

  if (typeof parsed === "object") {
    const lines = Object.entries(parsed)
      .slice(0, limit)
      .map(([key, item]) => `${metricDisplayName(key)}: ${humanizeValue(item)}`);
    return lines.length > 0 ? lines : [fallback];
  }

  return [humanizeValue(parsed)];
}

function compactText(value: string | null | undefined, fallback = "情報なし") {
  const text = humanizeInternalText(value ?? "") ?? "";
  return text.length > 0 ? text : fallback;
}

function toStoryboardStatus(params: {
  paused: boolean;
  stale: boolean;
  hasBlocker: boolean;
  activeAgents: number;
}): StoryboardStatus {
  if (params.paused || params.stale) {
    return "stalled";
  }

  if (params.hasBlocker) {
    return "attention";
  }

  if (params.activeAgents > 0) {
    return "working";
  }

  return "idle";
}

function storyboardStatusLabel(status: StoryboardStatus): string {
  switch (status) {
    case "working":
      return "稼働中";
    case "attention":
      return "注意";
    case "stalled":
      return "停滞";
    default:
      return "待機中";
  }
}

function parseDirectiveContent(content: string): {
  content: string;
  scope?: string | null;
  target?: string | null;
  department?: string | null;
  agentId?: string | null;
  priority?: string | null;
} {
  const parsed = tryParseJson(content);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { content: humanizeInternalText(content) ?? content };
  }

  const directive = parsed as Record<string, unknown>;
  const topic =
    typeof directive.topic === "string" ? compactText(directive.topic) : null;
  const source =
    typeof directive.source === "string" ? compactText(directive.source) : null;
  const fallbackContent = topic
    ? `${topic} に関する運用メモを共有`
    : source
      ? `${source} の調査メモを共有`
      : "次回の運用判断に使う管理者メモを共有";

  return {
    content: humanizeValue(directive.content ?? fallbackContent),
    scope:
      typeof directive.scope === "string" ? directive.scope : (null as null),
    target:
      typeof directive.target === "string" ? directive.target : (null as null),
    department:
      typeof directive.department === "string"
        ? directive.department
        : (null as null),
    agentId:
      typeof directive.agentId === "string"
        ? directive.agentId
        : (null as null),
    priority:
      typeof directive.priority === "string"
        ? directive.priority
        : (null as null),
  };
}

function humanizeDecisionTitle(title: string, department: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("frequency")) {
    return `${departmentDisplayName(department)}の投稿頻度を見直す提案`;
  }
  if (lower.includes("timing")) {
    return `${departmentDisplayName(department)}の実行タイミングを見直す提案`;
  }
  return compactText(title);
}

function summarizeJobResult(jobName: string, resultSummary: string | null): string {
  const job = humanizeInternalText(jobName) ?? jobName;
  const result = compactText(resultSummary, "結果はまだありません");
  return `${job}: ${result}`;
}

function teamStatusFromChannels(
  statuses: Array<DashboardSummary["channelSnapshots"][number]["status"]>,
): StoryboardStatus {
  if (statuses.includes("stalled")) return "stalled";
  if (statuses.includes("attention")) return "attention";
  if (statuses.includes("running")) return "working";
  return "idle";
}

export interface DashboardHomeResponse {
  generatedAt: string;
  hero: {
    health: "ok" | "warning" | "critical";
    title: string;
    summary: string;
    currentTheme: string;
    currentPolicy: string;
    nextHeartbeatAt: string | null;
    nextHeartbeatLabel: string;
  };
  setupChecklist: {
    summary: string;
    completedCount: number;
    totalCount: number;
    items: Array<{
      id: string;
      label: string;
      status: SetupStatus;
      statusLabel: string;
      detail: string;
      nextStep: string;
    }>;
  };
  heartbeatLoop: {
    cadenceLabel: string;
    status: StoryboardStatus;
    statusLabel: string;
    summary: string;
    explanation: string;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
  stoppedItems: Array<{
    id: string;
    label: string;
    reason: string;
    status: "warning" | "critical";
    selectKind: "inbox" | "team" | "funnel-stage" | "funnel";
    selectId: string;
  }>;
  awaitingConfirmation: {
    count: number;
    urgentCount: number;
    summary: string;
    preview: Array<{
      id: string;
      title: string;
      team: string;
      level: InboxLevel;
      kind: string;
    }>;
  };
  todayResults: Array<{
    id: string;
    label: string;
    value: string;
    context: string;
    tone: "neutral" | "good" | "warn";
  }>;
  aiActivity: Array<{
    id: string;
    title: string;
    summary: string;
    team: string;
    at: string;
  }>;
  funnelPreview: {
    status: StoryboardStatus;
    title: string;
    summary: string;
    theme: string;
    threadsAction: string;
    noteAction: string;
    blocker: string | null;
  };
  currentFlow: {
    nowRunning: string;
    stoppedReason: string | null;
    nextHumanAction: string | null;
    nextAiAction: string;
    funnelBottleneck: string | null;
    growthHint: string | null;
  };
  revenueSummary: {
    value: string;
    trend: string;
    context: string;
  };
}

export interface DashboardInboxResponse {
  generatedAt: string;
  mode: "exception_only";
  summary: string;
  items: Array<{
    id: string;
    kind: "proposal" | "review" | "stall";
    level: InboxLevel;
    title: string;
    summary: string;
    team: string;
    createdAt: string;
    requiresDecision: boolean;
    requestedDecision: string;
    approveEndpoint: string | null;
    rejectEndpoint: string | null;
    detail: {
      whyNow: string;
      impact: string;
      seenInformation: string[];
      nextIfApproved: string | null;
      nextIfRejected: string | null;
    };
  }>;
}

export interface DashboardStoryboardResponse {
  generatedAt: string;
  teams: Array<{
    id: string;
    label: string;
    purpose: string;
    nowDoing: string;
    basedOn: string[];
    handoffTo: string;
    status: StoryboardStatus;
    statusLabel: string;
    waitingOnHuman: boolean;
    waitingReason: string | null;
    memberSummary: string;
    members: Array<{
      id: string;
      name: string;
      role: string;
      status: string;
    }>;
    outputs: string[];
    blockers: string[];
  }>;
}

export interface DashboardDecisionFeedResponse {
  generatedAt: string;
  items: Array<{
    id: string;
    source: "proposal" | "optimization";
    title: string;
    team: string;
    decidedAt: string;
    status: string;
    seenInformation: string[];
    judgment: string;
    execution: string;
    expectedResult: string;
  }>;
}

export interface DashboardTimelineResponse {
  generatedAt: string;
  humanEventCount: number;
  events: Array<{
    id: string;
    at: string;
    actor: string;
    actorType: TimelineActorType;
    team: string;
    kind: TimelineKind;
    title: string;
    summary: string;
    details: string[];
    requiresAttention: boolean;
  }>;
}

export interface DashboardFunnelResponse {
  generatedAt: string;
  currentTheme: string;
  themeReason: string;
  status: StoryboardStatus;
  summary: string;
  blockers: string[];
  nextFocus: string;
  stages: Array<{
    id: string;
    title: string;
    headline: string;
    detail: string;
    status: StoryboardStatus;
    metrics: Array<{
      label: string;
      value: string;
      context: string;
    }>;
  }>;
}

export function getDashboardFunnel(): DashboardFunnelResponse {
  const summary = getSummary();
  const strategyState = readStrategyState();
  const threadsDetail = getDepartmentDetail("threads");
  const noteDetail = getDepartmentDetail("note");

  const theme =
    strategyState?.priorityTopics?.[0] ??
    summary.currentTheme ??
    noteDetail.currentTheme ??
    threadsDetail.currentTheme;
  const themeReason =
    humanizePolicyText(
      [
        strategyState?.objective,
        strategyState?.funnelStage,
        summary.currentPolicy,
      ]
        .filter((value): value is string => !!value)
        .join(" / "),
    ) ?? "方針情報はまだありません";

  const threadsSnapshot = summary.channelSnapshots.find(
    (item) => item.channel === "threads",
  );
  const noteSnapshot = summary.channelSnapshots.find(
    (item) => item.channel === "note",
  );

  const threadsActions = unique(
    [
      threadsDetail.currentTheme,
      threadsDetail.currentPolicy,
      ...threadsDetail.signals.outputs,
    ].filter((value): value is string => !!value),
  );
  const noteActions = unique(
    [
      noteDetail.currentTheme,
      noteDetail.currentPolicy,
      ...noteDetail.signals.outputs,
    ].filter((value): value is string => !!value),
  );

  const blockers = unique(
    [
      ...(threadsSnapshot?.blockers ?? []),
      ...(noteSnapshot?.blockers ?? []),
      summary.heartbeatFreshness !== "fresh"
        ? "定期チェックの間隔が乱れている"
        : null,
    ].filter((value): value is string => value !== null),
  );

  const status = teamStatusFromChannels([
    threadsSnapshot?.status ?? "idle",
    noteSnapshot?.status ?? "idle",
  ]);

  return {
    generatedAt: new Date().toISOString(),
    currentTheme: theme,
    themeReason,
    status,
    summary:
      status === "working"
        ? "Threadsで集客し、noteで収益化する流れが動いている"
        : status === "attention"
          ? "導線は動いているが、一部に停滞がある。AIが対処中"
          : status === "stalled"
            ? "集客から収益化までの流れのどこかで止まりが出ている"
            : "導線は待機中",
    blockers,
    nextFocus:
      blockers.length > 0
        ? blockers[0]
        : "反応が良いテーマを起点に、Threadsからnoteへの導線を伸ばす",
    stages: [
      {
        id: "theme",
        title: "いまのテーマ軸",
        headline: theme,
        detail: themeReason,
        status: "working",
        metrics: [
          {
            label: "方針",
            value: compactText(summary.currentPolicy),
            context: "司令塔がいま見ている方向性",
          },
        ],
      },
      {
        id: "threads",
        title: "Threadsでの集客",
        headline:
          threadsActions[0] ??
          threadsSnapshot?.summary ??
          "Threads側の集客アクションはまだありません",
        detail:
          threadsSnapshot?.nextStep ??
          "Threads投稿と反応分析で流入をつくる段階です",
        status: teamStatusFromChannels([threadsSnapshot?.status ?? "idle"]),
        metrics: [
          {
            label: "今日の投稿",
            value: String(summary.threads24h.published),
            context: "直近24時間で出たThreads投稿",
          },
          {
            label: "7日表示",
            value: summary.threads7d.impressions.toLocaleString("ja-JP"),
            context: "集客の母数になっている表示数",
          },
        ],
      },
      {
        id: "bridge",
        title: "Threadsからnoteへの橋渡し",
        headline:
          strategyState?.activeActionTypes?.length
            ? `誘導アクション: ${strategyState.activeActionTypes
                .map((item) => compactText(item))
                .join(" / ")}`
            : "noteテーマを起点に投稿内容を組み立てる",
        detail:
          "Threads投稿は単独運用ではなく、noteで売るテーマへ流すための導線として動く",
        status,
        metrics: [
          {
            label: "導線の段階",
            value: compactText(strategyState?.funnelStage, "未設定"),
            context: "いま強めたい導線の位置",
          },
        ],
      },
      {
        id: "note",
        title: "noteでの収益化",
        headline:
          noteActions[0] ??
          noteSnapshot?.summary ??
          "note側の収益化アクションはまだありません",
        detail:
          noteSnapshot?.nextStep ?? "記事生成と改善で収益化を進める段階です",
        status: teamStatusFromChannels([noteSnapshot?.status ?? "idle"]),
        metrics: [
          {
            label: "今日の公開本数",
            value: String(summary.notes24h.published),
            context: "直近24時間で公開したnote記事",
          },
          {
            label: "7日売上",
            value: `¥${summary.notes7d.revenueYen.toLocaleString("ja-JP")}`,
            context: "直近7日で積み上がった収益",
          },
        ],
      },
    ],
  };
}

export function getDashboardInbox(): DashboardInboxResponse {
  const proposals = currentProposalRows("pending").filter(
    (proposal) =>
      proposal.currentStage === "human_review" ||
      proposal.priority === "high" ||
      proposal.priority === "critical" ||
      !!proposal.risk,
  );
  const reviews = getReviews("pending");
  const summary = getSummary();
  const departments = getDepartments();

  const proposalItems: DashboardInboxResponse["items"] = proposals.map(
    (proposal) => ({
      id: proposal.id,
      kind: "proposal",
      level: proposal.priority === "high" ? "critical" : "warning",
      title: humanizeDecisionTitle(proposal.title, proposal.department),
      summary: compactText(proposal.reason, "AIからの提案があります"),
      team: departmentDisplayName(proposal.department),
      createdAt: proposal.createdAt,
      requiresDecision: true,
      requestedDecision: "AIからの提案を採用するか決めて",
      approveEndpoint: `/api/dashboard/proposals/${proposal.id}/approve`,
      rejectEndpoint: `/api/dashboard/proposals/${proposal.id}/reject`,
      detail: {
        whyNow: compactText(proposal.reason, "いま判断が必要です"),
        impact: compactText(
          humanizeValue(tryParseJson(proposal.expectedEffect)),
          "反映すると次の運用に進みます",
        ),
        seenInformation: unique([
          ...detailLinesFromValue(proposal.evidence, "根拠情報なし"),
          ...detailLinesFromValue(proposal.description, "提案内容なし"),
        ]).slice(0, 5),
        nextIfApproved: "次の定期チェックまたは担当AIがこの内容を反映する",
        nextIfRejected: "現方針のまま運用を継続し、必要なら別案を待つ",
      },
    }),
  );

  const reviewItems: DashboardInboxResponse["items"] = reviews.map((review) => ({
    id: review.id,
    kind: "review",
    level: "warning",
    title: `人の判断が必要: ${compactText(review.itemType)}`,
    summary: compactText(review.reason),
    team: "AIチーム全体",
    createdAt: review.createdAt,
    requiresDecision: true,
    requestedDecision: "止まっている処理を続けてよいか決めて",
    approveEndpoint: `/api/dashboard/reviews/${review.id}/approve`,
    rejectEndpoint: `/api/dashboard/reviews/${review.id}/reject`,
    detail: {
      whyNow: "自動処理だけでは判断できず、ここで止まっている",
      impact: "承認すると自動処理が再開し、却下するとその流れを止められる",
      seenInformation: [compactText(review.reason)],
      nextIfApproved: "停止していた処理を再開する",
      nextIfRejected: "この流れを止めて別判断を待つ",
    },
  }));

  const stallItems: DashboardInboxResponse["items"] = [
    ...(summary.heartbeatFreshness !== "fresh"
      ? [
          {
            id: "stall:heartbeat",
            kind: "stall" as const,
            level:
              summary.heartbeatFreshness === "missing"
                ? ("critical" as const)
                : ("warning" as const),
            title: "定期チェックの動きが不安定",
            summary:
              summary.heartbeatFreshness === "missing"
                ? "次の定期チェックが見つからない"
                : "定期チェックの間隔が乱れている",
            team: "司令塔",
            createdAt: summary.lastHeartbeatAt ?? new Date().toISOString(),
            requiresDecision: false,
            requestedDecision: "状態を確認して、必要なら手動で再開して",
            approveEndpoint: null,
            rejectEndpoint: null,
            detail: {
              whyNow: compactText(summary.healthReasons[0], "運用全体に影響します"),
              impact: "ここが止まると、AIチーム全体の自律運用が鈍る",
              seenInformation: summary.healthReasons,
              nextIfApproved: null,
              nextIfRejected: null,
            },
          },
        ]
      : []),
    ...departments
      .filter((department) => !!department.blockingReason)
      .slice(0, 4)
      .map((department) => ({
        id: `stall:${department.department}`,
        kind: "stall" as const,
        level: (department.paused ? "critical" : "warning") as InboxLevel,
        title: `${department.displayName}で停滞が発生`,
        summary: compactText(department.blockingReason),
        team: department.displayName,
        createdAt: department.lastRunAt ?? new Date().toISOString(),
        requiresDecision: false,
        requestedDecision: "止まりの原因を確認して、次の一手を決めて",
        approveEndpoint: null,
        rejectEndpoint: null,
        detail: {
          whyNow: compactText(department.statusSummary),
          impact: "ここが止まると、前後のチームへの受け渡しも遅れる",
          seenInformation: [
            `最新フェーズ: ${compactText(department.recentPhase, "未記録")}`,
            `最終実行: ${department.lastRunAt ?? "未記録"}`,
            compactText(department.latestSummary),
          ],
          nextIfApproved: null,
          nextIfRejected: null,
        },
      })),
  ];

  const items = [...proposalItems, ...reviewItems, ...stallItems]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    )
    .slice(0, 16);

  return {
    generatedAt: new Date().toISOString(),
    mode: "exception_only",
    summary:
      items.length > 0
        ? "ふだんはAIだけで回る。いまは例外的に人の確認が必要なものだけを出している"
        : "ふだんはここは空。初期設定が終われば、あとは毎時ハートビートで自律運用します",
    items,
  };
}

export function getDashboardHome(): DashboardHomeResponse {
  const summary = getSummary();
  const inbox = getDashboardInbox();
  const funnel = getDashboardFunnel();
  const operatorProfile = db.select().from(s.operatorProfiles).limit(1).get();
  const activeTopics = db
    .select()
    .from(s.topics)
    .where(eq(s.topics.status, "active"))
    .all();
  const researchCount =
    db.select({ value: count() }).from(s.researchItems).get()?.value ?? 0;
  const competitorSnapshotCount =
    db.select({ value: count() }).from(s.competitorSnapshots).get()?.value ?? 0;
  const threadPublishCount =
    db.select({ value: count() }).from(s.threadPostResults).get()?.value ?? 0;
  const notePublishCount =
    db.select({ value: count() }).from(s.notePostResults).get()?.value ?? 0;
  const noteDraftCount =
    db.select({ value: count() }).from(s.noteDrafts).get()?.value ?? 0;
  const completedThumbnailCount =
    db
      .select({ value: count() })
      .from(s.thumbnailTasks)
      .where(eq(s.thumbnailTasks.status, "completed"))
      .get()?.value ?? 0;
  const pendingThumbnailCount =
    db
      .select({ value: count() })
      .from(s.thumbnailTasks)
      .where(eq(s.thumbnailTasks.status, "pending"))
      .get()?.value ?? 0;
  const workstreamToTeamSelection: Record<string, string> = {
    command: "management",
    research: "external-research",
    threads: "threads",
    note: "note",
  };
  const totalTodayRuns =
    db
      .select({ value: count() })
      .from(s.scheduledJobRuns)
      .where(gte(s.scheduledJobRuns.createdAt, ago(24)))
      .get()?.value ?? 0;
  const todayRuns = db
    .select()
    .from(s.scheduledJobRuns)
    .where(gte(s.scheduledJobRuns.createdAt, ago(24)))
    .orderBy(desc(s.scheduledJobRuns.createdAt))
    .limit(10)
    .all();

  const stoppedItems: DashboardHomeResponse["stoppedItems"] = [
    ...summary.channelSnapshots
      .filter((item) => item.status !== "running" && item.status !== "idle")
      .map((item) => ({
        id: `channel:${item.channel}`,
        label: `${item.label}の流れ`,
        reason: item.blockers[0] ?? item.summary,
        status: (item.status === "stalled" ? "critical" : "warning") as
          | "critical"
          | "warning",
        selectKind: "funnel-stage" as const,
        selectId: item.channel,
      })),
    ...summary.workstreamSnapshots
      .filter((item) => item.status !== "ok")
      .map((item) => ({
        id: `workstream:${item.id}`,
        label: `${item.label}チーム`,
        reason: item.blockers[0] ?? item.summary,
        status: (item.status === "critical" ? "critical" : "warning") as
          | "critical"
          | "warning",
        selectKind: "team" as const,
        selectId: workstreamToTeamSelection[item.id] ?? "management",
      })),
  ].slice(0, 6);

  const aiActivity = todayRuns.map((run) => ({
    id: run.id,
    title:
      run.status === "failed"
        ? `${compactText(run.jobName)}で問題が発生`
        : `${compactText(run.jobName)}を実行`,
    summary: summarizeJobResult(run.jobName, run.resultSummary),
    team:
      run.jobName.includes("note")
        ? "note運用"
        : run.jobName.includes("research")
          ? "リサーチ"
          : run.jobName.includes("heartbeat")
            ? "司令塔"
            : "Threads運用",
    at: run.createdAt,
  }));

  const setupChecklist: DashboardHomeResponse["setupChecklist"]["items"] = [
    {
      id: "theme",
      label: "運用テーマ・ジャンルの共有",
      status:
        operatorProfile?.primaryNiche || activeTopics.length > 0 || summary.currentTheme !== "未設定"
          ? "done"
          : "missing",
      statusLabel: setupStatusLabel(
        operatorProfile?.primaryNiche || activeTopics.length > 0 || summary.currentTheme !== "未設定"
          ? "done"
          : "missing",
      ),
      detail:
        operatorProfile?.primaryNiche || summary.currentTheme !== "未設定"
          ? `いまの軸: ${operatorProfile?.primaryNiche ?? summary.currentTheme}`
          : "テーマ軸がまだ見つかっていない",
      nextStep:
        operatorProfile?.primaryNiche || activeTopics.length > 0 || summary.currentTheme !== "未設定"
          ? "このテーマを起点に Threads と note をつなげて回す"
          : "ジャンルか主テーマを1つ入れると回り始める",
    },
    {
      id: "research",
      label: "参考資料や競合リサーチ結果の提供",
      status:
        researchCount + competitorSnapshotCount > 0 ? "done" : "missing",
      statusLabel: setupStatusLabel(
        researchCount + competitorSnapshotCount > 0 ? "done" : "missing",
      ),
      detail:
        researchCount + competitorSnapshotCount > 0
          ? `参考資料 ${researchCount}件 / 競合データ ${competitorSnapshotCount}件`
          : "参考資料や競合データがまだ入っていない",
      nextStep:
        researchCount + competitorSnapshotCount > 0
          ? "集まった材料を、各部署の判断根拠として回し続ける"
          : "資料URLや競合メモを渡すと、判断の精度が上がる",
    },
    {
      id: "accounts",
      label: "Threads / note アカウント設定",
      status:
        threadPublishCount > 0 && notePublishCount > 0
          ? "done"
          : threadPublishCount > 0 || notePublishCount > 0 || noteDraftCount > 0
            ? "inferred"
            : "missing",
      statusLabel: setupStatusLabel(
        threadPublishCount > 0 && notePublishCount > 0
          ? "done"
          : threadPublishCount > 0 || notePublishCount > 0 || noteDraftCount > 0
            ? "inferred"
            : "missing",
      ),
      detail:
        threadPublishCount > 0 && notePublishCount > 0
          ? `Threads実績 ${threadPublishCount}件 / note実績 ${notePublishCount}件`
          : threadPublishCount > 0 || notePublishCount > 0 || noteDraftCount > 0
            ? "一部の接続や生成までは見えているが、両方の公開確認まではそろっていない"
            : "Threads と note の接続確認がまだ見えない",
      nextStep:
        threadPublishCount > 0 && notePublishCount > 0
          ? "毎時ハートビートから、そのまま両チャネル運用へ入れる"
          : "Threads と note の接続をそろえると、自律運用ループに入りやすい",
    },
    {
      id: "note-header",
      label: "noteヘッダー画像の追加",
      status:
        completedThumbnailCount > 0
          ? "done"
          : pendingThumbnailCount > 0
            ? "inferred"
            : "missing",
      statusLabel: setupStatusLabel(
        completedThumbnailCount > 0
          ? "done"
          : pendingThumbnailCount > 0
            ? "inferred"
            : "missing",
      ),
      detail:
        completedThumbnailCount > 0
          ? `ヘッダー画像タスク完了 ${completedThumbnailCount}件`
          : pendingThumbnailCount > 0
            ? `ヘッダー画像の準備中タスク ${pendingThumbnailCount}件`
            : "ヘッダー画像の反映状況がまだ見えない",
      nextStep:
        completedThumbnailCount > 0
          ? "note販売導線の第一印象まで含めて運用を回せる"
          : "ヘッダー画像を入れると note 側の販売体験が整う",
    },
  ];
  const setupCompletedCount = setupChecklist.filter(
    (item) => item.status === "done",
  ).length;
  const heartbeatLoop: DashboardHomeResponse["heartbeatLoop"] = {
    cadenceLabel: "1時間に1回のハートビート",
    status:
      summary.heartbeatFreshness === "fresh"
        ? "working"
        : summary.heartbeatFreshness === "stale"
          ? "attention"
          : "stalled",
    statusLabel:
      summary.heartbeatFreshness === "fresh"
        ? "正常に巡回中"
        : summary.heartbeatFreshness === "stale"
          ? "間隔が乱れている"
          : "起動源が止まっている",
    summary:
      summary.heartbeatFreshness === "fresh"
        ? "毎時のハートビートを起点に、司令塔から各部署へ判断と実行を回している"
        : summary.heartbeatFreshness === "stale"
          ? "毎時ハートビートはあるが、失敗や遅れが混ざっている"
          : "毎時ハートビートが見つからず、自律運用OSの起動が不安定",
    explanation:
      "ユーザーは最初の4つを渡すのが主な役割。その後はこの毎時ハートビートが、リサーチ・投稿・分析・改善をつなぎ続ける",
    lastRunAt: summary.lastHeartbeatAt,
    nextRunAt: summary.nextHeartbeatAt,
  };

  return {
    generatedAt: new Date().toISOString(),
    hero: {
      health: summary.health,
      title: summary.healthHeadline,
      summary:
        summary.healthReasons.length > 0
          ? `最初の4つを渡したあと、AIチームは毎時ハートビートで回る。いまは ${summary.healthReasons.join(" / ")}`
          : "最初の4つを渡せば、あとはAIチームが毎時ハートビートで回り続ける",
      currentTheme: summary.currentTheme,
      currentPolicy: summary.currentPolicy,
      nextHeartbeatAt: summary.nextHeartbeatAt,
      nextHeartbeatLabel:
        summary.nextHeartbeatAt !== null
          ? "次の毎時ハートビート"
          : "毎時ハートビートの予定なし",
    },
    setupChecklist: {
      summary:
        setupCompletedCount === 4
          ? "最初に必要な4つはそろっている。このまま毎時ハートビートで継続運用できる"
          : `${setupCompletedCount}/4 完了。ユーザーが主に触るのはこの4つだけ`,
      completedCount: setupCompletedCount,
      totalCount: 4,
      items: setupChecklist,
    },
    heartbeatLoop,
    stoppedItems,
    awaitingConfirmation: {
      count: inbox.items.filter((item) => item.kind !== "stall").length,
      urgentCount: inbox.items.filter((item) => item.kind !== "stall" && item.level === "critical").length,
      summary: (() => {
        const decisions = inbox.items.filter((item) => item.kind !== "stall");
        return decisions.length > 0
          ? "通常はAIだけで回る。いまは例外的に判断待ちが出ている"
          : "いまは判断待ちなし。AIチームだけで継続運用できている";
      })(),
      preview: inbox.items.filter((item) => item.kind !== "stall").slice(0, 3).map((item) => ({
        id: item.id,
        title: item.title,
        team: item.team,
        level: item.level,
        kind: item.kind,
      })),
    },
    todayResults: [
      {
        id: "threads-posts",
        label: "今日のThreads投稿",
        value: String(summary.threads24h.published),
        context: `${summary.threads24h.impressions.toLocaleString("ja-JP")} 表示 / ${summary.threads24h.likes.toLocaleString("ja-JP")} いいね`,
        tone: summary.threads24h.published > 0 ? "good" : "warn",
      },
      {
        id: "note-posts",
        label: "今日のnote公開",
        value: String(summary.notes24h.published),
        context: `${summary.notes24h.views.toLocaleString("ja-JP")} 閲覧 / ¥${summary.notes24h.revenueYen.toLocaleString("ja-JP")}`,
        tone: summary.notes24h.published > 0 ? "good" : "warn",
      },
      {
        id: "team-health",
        label: "いま止まりがある数",
        value: String(stoppedItems.length),
        context: "先に確認したい停滞や注意",
        tone: stoppedItems.length > 0 ? "warn" : "neutral",
      },
      {
        id: "recent-actions",
        label: "今日AIが動いた回数",
        value: String(totalTodayRuns),
        context: "直近24時間の重要な実行数",
        tone: totalTodayRuns > 0 ? "good" : "neutral",
      },
    ],
    aiActivity,
    funnelPreview: {
      status: funnel.status,
      title: "Threads→note の流れ",
      summary: funnel.summary,
      theme: funnel.currentTheme,
      threadsAction:
        funnel.stages.find((item) => item.id === "threads")?.headline ?? "-",
      noteAction:
        funnel.stages.find((item) => item.id === "note")?.headline ?? "-",
      blocker: funnel.blockers[0] ?? null,
    },
    currentFlow: {
      nowRunning: summary.heartbeatFreshness === "fresh"
        ? `定期チェックが正常稼働中。今日の実行: ${totalTodayRuns}回`
        : summary.heartbeatFreshness === "stale"
          ? "定期チェックに遅延あり"
          : "定期チェックが停止中",
      stoppedReason: stoppedItems.length > 0
        ? stoppedItems.map((item) => `${item.label}: ${item.reason}`).join(" / ")
        : null,
      nextHumanAction: inbox.items.filter((item) => item.kind !== "stall").length > 0
        ? inbox.items.filter((item) => item.kind !== "stall")[0].title
        : null,
      nextAiAction: aiActivity.length > 0
        ? aiActivity[0].title
        : "次の定期チェックで自動判断",
      funnelBottleneck: funnel.blockers.length > 0
        ? funnel.blockers[0]
        : null,
      growthHint: (() => {
        if (summary.notes7d.revenueYen === 0 && notePublishCount === 0) {
          return "まずnote記事を1本公開すると、収益化導線が動き始める";
        }
        if (summary.notes7d.revenueYen === 0 && notePublishCount > 0) {
          return "記事は出ているが売上がまだない。価格設定や記事テーマの見直しで突破口をつくれる";
        }
        if (summary.threads24h.published === 0) {
          return "Threads投稿が止まっている。集客導線を動かすには投稿再開が最優先";
        }
        return null;
      })(),
    },
    revenueSummary: {
      value: `¥${summary.notes7d.revenueYen.toLocaleString("ja-JP")}`,
      trend: summary.notes7d.revenueYen > 0
        ? `${summary.notes7d.published}本の記事から収益発生中`
        : "まだ収益なし",
      context: summary.notes7d.revenueYen > 0
        ? `閲覧 ${summary.notes7d.views.toLocaleString("ja-JP")} / いいね ${summary.notes7d.likes.toLocaleString("ja-JP")}`
        : "記事の公開と価格設定が収益化の第一歩",
    },
  };
}

export function getDashboardStoryboard(): DashboardStoryboardResponse {
  const departments = getDepartments();
  const departmentMap = new Map(departments.map((item) => [item.department, item]));
  const detailMap = new Map(
    [
      "command",
      "external-research",
      "competitive-analysis",
      "threads",
      "note",
    ].map(
      (department) => [department, getDepartmentDetail(department)],
    ),
  );
  const agents = getAgents();
  const summary = getSummary();

  const blueprints = [
    {
      id: "management",
      label: "管理・指揮系統",
      purpose: "全体を見て、どのチームに何を優先させるか決める",
      departments: ["command"],
      handoffTo: "外部リサーチ部署 / Threads運用部署 / note運用部署",
      memberFilter: (agent: ReturnType<typeof getAgents>[number]) =>
        agent.department === "command",
    },
    {
      id: "external-research",
      label: "外部リサーチ部署",
      purpose: "市場や最新情報を集めて、各チームの判断材料を増やす",
      departments: ["external-research"],
      handoffTo: "競合リサーチ分析部署",
      memberFilter: (agent: ReturnType<typeof getAgents>[number]) =>
        agent.department === "external-research",
    },
    {
      id: "competitive-analysis",
      label: "競合リサーチ分析部署",
      purpose: "競合の勝ち筋を読み解いて、各チームへ改善案を渡す",
      departments: ["competitive-analysis"],
      handoffTo: "Threads運用部署 / note運用部署",
      memberFilter: (agent: ReturnType<typeof getAgents>[number]) =>
        agent.department === "competitive-analysis",
    },
    {
      id: "threads",
      label: "Threads運用部署",
      purpose: "noteにつながる集客導線をThreads側でつくる",
      departments: ["threads"],
      handoffTo: "note運用部署",
      memberFilter: (agent: ReturnType<typeof getAgents>[number]) =>
        agent.department === "threads",
    },
    {
      id: "note",
      label: "note運用部署",
      purpose: "集客された関心を記事と販売導線で収益へ変える",
      departments: ["note"],
      handoffTo: "管理・指揮系統",
      memberFilter: (agent: ReturnType<typeof getAgents>[number]) =>
        agent.department === "note",
    },
  ];

  const teams: DashboardStoryboardResponse["teams"] = blueprints.map((blueprint) => {
    const relevantDepartments = blueprint.departments
      .map((department) => departmentMap.get(department))
      .filter(
        (department): department is DepartmentOverview => department !== undefined,
      );
    const details = blueprint.departments
      .map((department) => detailMap.get(department))
      .filter((detail): detail is DepartmentDetail => detail !== undefined);
    const members = agents.filter(blueprint.memberFilter).map((agent) => ({
      id: agent.id,
      name: agent.name ?? agent.jobName,
      role: agent.role,
      status: agent.status,
    }));

    const blockers = unique(
      details.flatMap((detail) => detail.signals.blockers).concat(
        relevantDepartments
          .map((department) => department.blockingReason)
          .filter((value): value is string => !!value),
      ),
    );
    const basedOn = unique(
      details
        .flatMap((detail) => detail.signals.inputs)
        .concat(details.map((detail) => detail.currentTheme))
        .filter((value): value is string => !!value),
    ).slice(0, 5);
    const outputs = unique(
      details
        .flatMap((detail) => detail.signals.outputs)
        .concat(details.map((detail) => detail.currentTheme))
        .filter((value): value is string => !!value),
    ).slice(0, 5);

    const activeAgents = relevantDepartments.reduce(
      (total, department) => total + department.activeAgents,
      0,
    );
    const status = toStoryboardStatus({
      paused: relevantDepartments.some((department) => department.paused),
      stale: relevantDepartments.some((department) => department.stale),
      hasBlocker: blockers.length > 0,
      activeAgents,
    });

    const waitingCount = details.reduce(
      (total, detail) =>
        total +
        detail.proposals.filter((proposal) => proposal.status === "pending").length,
      0,
    );

    return {
      id: blueprint.id,
      label: blueprint.label,
      purpose: blueprint.purpose,
      nowDoing:
        outputs[0] ??
        basedOn[0] ??
        "いまの動きはまだ記録されていません",
      basedOn,
      handoffTo: blueprint.handoffTo,
      status,
      statusLabel: storyboardStatusLabel(status),
      waitingOnHuman: waitingCount > 0,
      waitingReason:
        waitingCount > 0 ? `確認待ちの提案が ${waitingCount}件ある` : null,
      memberSummary: `${members.length}人の担当AIが関与`,
      members,
      outputs,
      blockers,
    };
  });

  // 動的部署: blueprintsに含まれない部署を自動追加
  const coveredDepartments = new Set(blueprints.flatMap((bp) => bp.departments));
  for (const dept of departments) {
    if (coveredDepartments.has(dept.department)) continue;
    const detail = getDepartmentDetail(dept.department);
    const deptAgents = agents.filter((a) => a.department === dept.department);
    const deptBlockers = detail
      ? unique(detail.signals.blockers.concat(dept.blockingReason ? [dept.blockingReason] : []))
      : dept.blockingReason ? [dept.blockingReason] : [];
    const deptOutputs = detail
      ? unique(detail.signals.outputs.filter((v): v is string => !!v)).slice(0, 5)
      : [];
    const deptBasedOn = detail
      ? unique(detail.signals.inputs.filter((v): v is string => !!v)).slice(0, 5)
      : [];
    const status = toStoryboardStatus({
      paused: dept.paused,
      stale: dept.stale,
      hasBlocker: deptBlockers.length > 0,
      activeAgents: dept.activeAgents,
    });
    teams.push({
      id: dept.department,
      label: departmentDisplayName(dept.department),
      purpose: detail?.currentTheme ?? "動的に検出された部署",
      nowDoing: deptOutputs[0] ?? deptBasedOn[0] ?? "いまの動きはまだ記録されていません",
      basedOn: deptBasedOn,
      handoffTo: "管理・指揮系統",
      status,
      statusLabel: storyboardStatusLabel(status),
      waitingOnHuman: dept.pendingProposals > 0,
      waitingReason: dept.pendingProposals > 0 ? `確認待ちの提案が ${dept.pendingProposals}件ある` : null,
      memberSummary: `${deptAgents.length}人の担当AIが関与`,
      members: deptAgents.map((a) => ({ id: a.id, name: a.name ?? a.jobName, role: a.role, status: a.status })),
      outputs: deptOutputs,
      blockers: deptBlockers,
    });
  }

  const threadsSnapshot = summary.channelSnapshots.find(
    (item) => item.channel === "threads",
  );
  const noteSnapshot = summary.channelSnapshots.find(
    (item) => item.channel === "note",
  );
  const noteTeam = teams.find((team) => team.id === "note");
  const threadsTeam = teams.find((team) => team.id === "threads");

  if (threadsTeam && threadsSnapshot) {
    threadsTeam.outputs = unique([threadsSnapshot.summary, ...threadsTeam.outputs]).slice(
      0,
      5,
    );
  }

  if (noteTeam && noteSnapshot) {
    noteTeam.outputs = unique([noteSnapshot.summary, ...noteTeam.outputs]).slice(
      0,
      5,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    teams,
  };
}

export function getDashboardDecisions(): DashboardDecisionFeedResponse {
  const proposals = currentProposalRows()
    .map((proposal) => ({
      id: proposal.id,
      source: "proposal" as const,
      title: humanizeDecisionTitle(proposal.title, proposal.department),
      team: departmentDisplayName(proposal.department),
      decidedAt: proposal.createdAt,
      status: proposal.status,
      seenInformation: unique([
        ...detailLinesFromValue(proposal.evidence, "根拠情報なし"),
        ...detailLinesFromValue(proposal.description, "提案内容なし"),
      ]).slice(0, 4),
      judgment: compactText(proposal.reason, "AIが改善提案を出しました"),
      execution:
        proposal.status === "pending"
          ? "この提案は人の確認待ち"
          : proposal.status === "approved"
            ? "提案は承認され、反映フェーズへ進んだ"
            : proposal.status === "rejected"
              ? "提案は見送りになった"
              : `提案ステータス: ${proposal.status}`,
      expectedResult: compactText(
        humanizeValue(tryParseJson(proposal.expectedEffect)),
        "期待結果はまだ記録されていません",
      ),
    }))
    .slice(0, 8);

  const optimizations = db
    .select()
    .from(s.optimizationDecisions)
    .orderBy(desc(s.optimizationDecisions.createdAt))
    .limit(8)
    .all()
    .map((decision) => ({
      id: decision.id,
      source: "optimization" as const,
      title: humanizeDecisionTitle(
        `${decision.decisionType} adjustment`,
        decision.channel,
      ),
      team: departmentDisplayName(decision.channel),
      decidedAt: decision.createdAt,
      status: proposalStatusFromApprovedBy(decision.approvedBy),
      seenInformation: detailLinesFromValue(
        {
          beforeValue: tryParseJson(decision.beforeValue),
          afterValue: tryParseJson(decision.afterValue),
        },
        "比較データなし",
      ),
      judgment: compactText(decision.reason, "AIが改善判断を行った"),
      execution: `AIが ${departmentDisplayName(decision.channel)} の設定を調整`,
      expectedResult: compactText(
        humanizeValue(tryParseJson(decision.afterValue)),
        "調整結果はまだありません",
      ),
    }));

  return {
    generatedAt: new Date().toISOString(),
    items: [...proposals, ...optimizations]
      .sort(
        (left, right) =>
          new Date(right.decidedAt).getTime() - new Date(left.decidedAt).getTime(),
      )
      .slice(0, 12),
  };
}

export function getDashboardTimeline(): DashboardTimelineResponse {
  const inbox = getDashboardInbox();
  const proposalLookup = new Map(
    db.select().from(s.proposals).all().map((proposal) => [proposal.id, proposal]),
  );
  const directiveRows = db
    .select()
    .from(s.humanInputs)
    .orderBy(desc(s.humanInputs.createdAt))
    .limit(8)
    .all();
  const controls = db
    .select()
    .from(s.systemControls)
    .orderBy(desc(s.systemControls.createdAt))
    .limit(12)
    .all();
  const proposalEvents = db
    .select()
    .from(s.proposalEvents)
    .orderBy(desc(s.proposalEvents.createdAt))
    .limit(16)
    .all();
  const reviews = db
    .select()
    .from(s.humanReviewItems)
    .orderBy(desc(s.humanReviewItems.createdAt))
    .limit(12)
    .all();
  const jobRuns = db
    .select()
    .from(s.scheduledJobRuns)
    .orderBy(desc(s.scheduledJobRuns.createdAt))
    .limit(12)
    .all();
  const optimizations = db
    .select()
    .from(s.optimizationDecisions)
    .orderBy(desc(s.optimizationDecisions.createdAt))
    .limit(10)
    .all();

  const events: DashboardTimelineResponse["events"] = [
    ...controls.map((control) => ({
      id: control.id,
      at: control.createdAt,
      actor: control.createdBy === "dashboard" ? "管理者" : compactText(control.createdBy),
      actorType: "human" as const,
      team: control.scope === "global" ? "AIチーム全体" : departmentDisplayName(control.scope),
      kind: control.action === "resume" ? ("resume" as const) : ("pause" as const),
      title:
        control.action === "resume"
          ? `${control.scope === "global" ? "全体" : departmentDisplayName(control.scope)}を再開`
          : `${control.scope === "global" ? "全体" : departmentDisplayName(control.scope)}を停止`,
      summary: compactText(control.reason),
      details: [
        `対象: ${control.scope === "global" ? "AIチーム全体" : departmentDisplayName(control.scope)}`,
      ],
      requiresAttention: control.action !== "resume",
    })),
    ...directiveRows.map((input) => {
      const directive = parseDirectiveContent(input.content);
      return {
        id: input.id,
        at: input.createdAt,
        actor: "管理者",
        actorType: "human" as const,
        team: directive.department
          ? departmentDisplayName(directive.department)
          : "AIチーム全体",
        kind: "directive" as const,
        title: "管理者メモを投入",
        summary: directive.content,
        details: [
          directive.scope ? `対象範囲: ${directive.scope}` : "対象範囲: 全体",
          directive.target ? `反映先: ${directive.target}` : "反映先: 次回の運用判断",
          directive.priority ? `優先度: ${directive.priority}` : "優先度: 中",
        ],
        requiresAttention: false,
      };
    }),
    ...proposalEvents.map((event) => {
      const proposal = proposalLookup.get(event.proposalId);
      const kind =
        event.action === "approved"
          ? ("approval" as const)
          : event.action === "rejected"
            ? ("rejection" as const)
            : ("review" as const);
      return {
        id: event.id,
        at: event.createdAt,
        actor:
          event.actorId === "dashboard-human"
            ? "管理者"
            : compactText(event.actorId),
        actorType:
          event.actorId === "dashboard-human"
            ? ("human" as const)
            : ("ai" as const),
        team: proposal
          ? departmentDisplayName(proposal.department)
          : "AIチーム全体",
        kind,
        title:
          kind === "approval"
            ? "AIからの提案を承認"
            : kind === "rejection"
              ? "AIからの提案を却下"
              : "AIが提案を作成",
        summary: compactText(event.note ?? proposal?.title),
        details: [
          proposal ? humanizeDecisionTitle(proposal.title, proposal.department) : "提案情報なし",
          `段階: ${event.stage}`,
        ],
        requiresAttention: kind !== "approval",
      };
    }),
    ...reviews.map((review) => ({
      id: review.id,
      at: review.reviewedAt ?? review.createdAt,
      actor: review.reviewedAt ? "管理者" : "AIチーム",
      actorType: review.reviewedAt ? ("human" as const) : ("system" as const),
      team: "AIチーム全体",
      kind:
        review.status === "approved"
          ? ("approval" as const)
          : review.status === "rejected"
            ? ("rejection" as const)
            : ("review" as const),
      title:
        review.status === "pending"
          ? "人の判断が必要な項目が発生"
          : review.status === "approved"
            ? "レビュー項目を承認"
            : "レビュー項目を却下",
      summary: compactText(review.reason),
      details: [
        `種別: ${review.itemType}`,
        review.reviewerNote ? `メモ: ${review.reviewerNote}` : "メモなし",
      ],
      requiresAttention: review.status === "pending",
    })),
    ...inbox.items
      .filter((item) => item.kind === "stall")
      .slice(0, 8)
      .map((item) => ({
        id: `timeline:${item.id}`,
        at: item.createdAt,
        actor: "システム",
        actorType: "system" as const,
        team: item.team,
        kind: "stall" as const,
        title: item.title,
        summary: item.summary,
        details: [
          item.detail.whyNow,
          item.detail.impact,
          ...item.detail.seenInformation.slice(0, 2),
        ],
        requiresAttention: true,
      })),
    ...jobRuns.map((run) => ({
      id: run.id,
      at: run.createdAt,
      actor: "AIチーム",
      actorType: "ai" as const,
      team:
        run.jobName.includes("note")
          ? "note運用"
          : run.jobName.includes("research")
            ? "外部リサーチ部署"
            : run.jobName.includes("heartbeat")
              ? "管理・指揮系統"
              : "Threads運用部署",
      kind: run.status === "failed" ? ("error" as const) : ("ai_action" as const),
      title:
        run.status === "failed"
          ? `${compactText(run.jobName)}でエラー`
          : `${compactText(run.jobName)}を実行`,
      summary: compactText(run.resultSummary, "実行結果はまだありません"),
      details: [
        `開始: ${run.startedAt ?? "-"}`,
        `終了: ${run.finishedAt ?? "-"}`,
      ],
      requiresAttention: run.status === "failed",
    })),
    ...optimizations.map((decision) => ({
      id: decision.id,
      at: decision.createdAt,
      actor: "AIチーム",
      actorType: "ai" as const,
      team: departmentDisplayName(decision.channel),
      kind: "policy_change" as const,
      title: "AIが運用方針を調整",
      summary: compactText(decision.reason),
      details: detailLinesFromValue(
        {
          beforeValue: tryParseJson(decision.beforeValue),
          afterValue: tryParseJson(decision.afterValue),
        },
        "変更内容なし",
      ),
      requiresAttention: false,
    })),
  ];

  const sortedEvents = events
    .sort(
      (left, right) =>
        new Date(right.at).getTime() - new Date(left.at).getTime(),
    )
    .slice(0, 40);

  return {
    generatedAt: new Date().toISOString(),
    humanEventCount: sortedEvents.filter((e) => e.actorType === "human").length,
    events: sortedEvents,
  };
}

export interface DepartmentOverview {
  department: string;
  displayName: string;
  totalRuns: number;
  recentStatus: string | null;
  recentPhase: string | null;
  lastRunAt: string | null;
  paused: boolean;
  activeAgents: number;
  pendingProposals: number;
  latestSummary: string | null;
  statusSummary: string;
  stale: boolean;
  blockingReason: string | null;
}

function getDepartmentsImpl(): DepartmentOverview[] {
  const departmentRuns = db
    .select()
    .from(s.departmentRuns)
    .orderBy(desc(s.departmentRuns.createdAt))
    .all();
  const agentRows = db.select().from(s.agentStates).all();
  const proposalRows = db.select().from(s.proposals).all();
  const summaryRows = db.select().from(s.departmentSummaries).all();
  const controls = db
    .select()
    .from(s.systemControls)
    .where(
      and(eq(s.systemControls.action, "pause"), eq(s.systemControls.active, 1)),
    )
    .all();

  const allDepartments = new Set<string>();
  for (const row of departmentRuns) allDepartments.add(row.department);
  for (const row of agentRows) allDepartments.add(row.department);
  for (const row of proposalRows) allDepartments.add(row.department);
  for (const row of summaryRows) allDepartments.add(row.department);

  const latestSummaries = latestRowsByKey(
    summaryRows,
    (row) => row.department,
    (row) => row.updatedAt,
  );
  const summaryMap = new Map(
    latestSummaries.map(
      (row) =>
        [row.department, humanizeInternalText(row.content) ?? row.content] as const,
    ),
  );

  const controlScopes = new Set(controls.map((row) => row.scope));
  const rowsByDepartment = new Map<string, DepartmentOverview>();

  for (const department of allDepartments) {
    rowsByDepartment.set(department, {
      department,
      displayName: departmentDisplayName(department),
      totalRuns: 0,
      recentStatus: null,
      recentPhase: null,
      lastRunAt: null,
      paused: controlScopes.has(department) || controlScopes.has("global"),
      activeAgents: agentRows.filter(
        (row) => row.department === department && row.status !== "paused",
      ).length,
      pendingProposals: proposalRows.filter(
        (row) => row.department === department && row.status === "pending",
      ).length,
      latestSummary: summaryMap.get(department) ?? null,
      statusSummary: "データ待ち",
      stale: false,
      blockingReason: null,
    });
  }

  for (const row of departmentRuns) {
    const existing = rowsByDepartment.get(row.department);
    if (!existing) {
      continue;
    }

    existing.totalRuns += 1;
    if (!existing.lastRunAt) {
      existing.recentStatus = row.status;
      existing.recentPhase = row.phase;
      existing.lastRunAt = row.createdAt;
    }
  }

  for (const row of rowsByDepartment.values()) {
    const staleHours = row.department === "note" ? 12 : 6;
    row.stale = row.lastRunAt
      ? (hoursSince(row.lastRunAt) ?? 0) > staleHours
      : true;

    row.blockingReason = row.paused
      ? "手動で停止中"
      : row.recentStatus === "failed"
        ? "直近の実行で失敗"
        : row.pendingProposals > 0
          ? `${row.pendingProposals}件の提案待ち`
          : row.stale
            ? "最終実行から時間が空いている"
            : null;

    row.statusSummary = row.paused
      ? "人の確認のため停止中"
      : row.recentStatus === "failed"
        ? "直近の処理で失敗が出ている"
        : row.stale
          ? "更新が止まっている可能性がある"
          : row.activeAgents > 0
            ? "自動で動作中"
            : row.totalRuns > 0
              ? "待機中"
              : "まだ実行データがない";
  }

  return Array.from(rowsByDepartment.values()).sort((left, right) => {
    const leftTime = left.lastRunAt ? new Date(left.lastRunAt).getTime() : 0;
    const rightTime = right.lastRunAt ? new Date(right.lastRunAt).getTime() : 0;
    return (
      rightTime - leftTime || left.department.localeCompare(right.department)
    );
  });
}

export function getDepartments(): DepartmentOverview[] {
  return memoizeDashboardQuery("getDepartments", [], getDepartmentsImpl);
}

export interface DepartmentDetail {
  department: string;
  currentTheme: string;
  currentPolicy: string;
  paused: boolean;
  runs: Array<{
    id: string;
    cycleId: string;
    phase: string;
    status: string;
    summary: string;
    createdAt: string;
  }>;
  cycle: {
    id: string;
    objective: string;
    status: string;
    startedAt: string;
  } | null;
  summaries: Array<{
    id: string;
    summaryType: string;
    content: string;
    periodKey: string;
    updatedAt: string;
  }>;
  proposals: DashboardProposalRow[];
  agents: ReturnType<typeof getAgents>;
  budget: {
    scope: string;
    tokensRemaining: number;
    callsRemaining: number;
    utilization: number;
  } | null;
  controls: Array<{
    id: string;
    scope: string;
    action: string;
    reason: string;
    createdAt: string;
  }>;
  signals: {
    inputs: string[];
    outputs: string[];
    blockers: string[];
    questions: string[];
    priorityTasks: string[];
  };
  importantAlerts: Array<{
    id: string;
    type: string;
    reason: string;
    createdAt: string;
  }>;
}

function getDepartmentDetailImpl(department: string): DepartmentDetail {
  const runs = db
    .select()
    .from(s.departmentRuns)
    .where(eq(s.departmentRuns.department, department))
    .orderBy(desc(s.departmentRuns.createdAt))
    .limit(20)
    .all()
    .map((row) => ({
      id: row.id,
      cycleId: row.cycleId,
      phase: row.phase,
      status: row.status,
      summary: humanizeInternalText(row.summary) ?? row.summary,
      createdAt: row.createdAt,
    }));

  let cycle: DepartmentDetail["cycle"] = null;
  if (runs[0]) {
    const currentCycle = db
      .select()
      .from(s.executiveCycles)
      .where(eq(s.executiveCycles.id, runs[0].cycleId))
      .get();

    if (currentCycle) {
      cycle = {
        id: currentCycle.id,
        objective: currentCycle.objective,
        status: currentCycle.status,
        startedAt: currentCycle.startedAt,
      };
    }
  }

  const summaries = db
    .select()
    .from(s.departmentSummaries)
    .where(eq(s.departmentSummaries.department, department))
    .orderBy(desc(s.departmentSummaries.updatedAt))
    .limit(10)
    .all()
    .map((row) => ({
      id: row.id,
      summaryType: row.summaryType,
      content: humanizeInternalText(row.content) ?? row.content,
      periodKey: row.periodKey,
      updatedAt: row.updatedAt,
    }));

  const proposals = currentProposalRows().filter(
    (row) => row.department === department,
  );
  const agents = getAgents().filter((row) => row.department === department);
  const controls = db
    .select()
    .from(s.systemControls)
    .where(
      and(
        eq(s.systemControls.scope, department),
        eq(s.systemControls.active, 1),
      ),
    )
    .all()
    .map((row) => ({
      id: row.id,
      scope: row.scope,
      action: row.action,
      reason: row.reason,
      createdAt: row.createdAt,
    }));

  const latestBudget = latestRowsByKey(
    db
      .select()
      .from(s.budgetTracking)
      .where(eq(s.budgetTracking.scope, department))
      .all(),
    (row) => row.scope,
    (row) => row.updatedAt,
  )[0];
  const strategyState = readStrategyState();
  const latestSummary = summaries[0]?.content ?? null;
  const currentTheme =
    latestSummary ??
    strategyState?.priorityTopics?.[0] ??
    proposals[0]?.title ??
    "未設定";
  const currentPolicyParts = [
    strategyState?.objective ?? runs[0]?.phase ?? "objective未設定",
    strategyState?.funnelStage ?? runs[0]?.status ?? "status未設定",
    controls.length > 0 ? "paused" : "active",
  ].filter((value): value is string => value.length > 0);
  const currentPolicy =
    humanizePolicyText(currentPolicyParts.join(" / ")) ?? "方針未設定";
  const budgetUtilization = latestBudget
    ? Math.max(
        latestBudget.tokensLimit > 0
          ? latestBudget.tokensUsed / latestBudget.tokensLimit
          : 0,
        latestBudget.callsLimit > 0
          ? latestBudget.callsUsed / latestBudget.callsLimit
          : 0,
      )
    : null;
  const importantAlerts = [
    ...controls.map((row) => ({
      id: row.id,
      type: row.action,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
    ...proposals
      .filter((row) => row.status === "pending")
      .map((row) => ({
        id: row.id,
        type: "proposal",
        reason: row.title,
        createdAt: row.createdAt,
      })),
    ...(budgetUtilization && budgetUtilization > 0.85
      ? [
          {
            id: `budget:${department}`,
            type: "budget",
            reason: `予算使用率 ${(budgetUtilization * 100).toFixed(0)}%`,
            createdAt: latestBudget?.updatedAt ?? new Date().toISOString(),
          },
        ]
      : []),
  ].slice(0, 8);
  const signals = {
    inputs: unique(
      [
        latestSummary ? `最新サマリー: ${latestSummary}` : null,
        cycle
          ? humanizePolicyText(`cycle: ${cycle.objective} / ${cycle.status}`)
          : null,
        ...agents.map(
          (agent) =>
            `${agent.name}: ${
              humanizeInternalText(agent.currentTask ?? agent.status ?? "idle") ??
              "待機中"
            }`,
        ),
      ].filter((value): value is string => value !== null),
    ),
    outputs: unique(
      [
        ...runs.slice(0, 5).map((row) => `${row.phase}: ${row.summary}`),
        ...summaries
          .slice(0, 5)
          .map((row) => `${row.summaryType}: ${row.content}`),
      ].filter((value): value is string => value.length > 0),
    ),
    blockers: unique(
      [
        controls.length > 0 ? "部署停止中" : null,
        budgetUtilization && budgetUtilization > 0.85
          ? `予算残量が少ない (${Math.round((1 - budgetUtilization) * 100)}%)`
          : null,
        proposals.some((row) => row.status === "pending")
          ? "未処理提案あり"
          : null,
        agents.length === 0 ? "担当者データなし" : null,
      ].filter((value): value is string => value !== null),
    ),
    questions: unique(
      [
        cycle
          ? `この部署の次の優先フェーズは ${runs[0]?.phase ?? cycle.status} でよいか`
          : null,
        proposals[0]?.reviewerNote
          ? "差し戻し理由を反映して再提案するか"
          : null,
        latestSummary ? null : "直近の部署サマリーが未作成",
      ].filter((value): value is string => value !== null),
    ),
    priorityTasks: unique(
      [
        ...proposals
          .filter((row) => row.status === "pending")
          .slice(0, 3)
          .map((row) => row.title),
        ...agents
          .filter((agent) => agent.currentTask)
          .map((agent) => humanizeInternalText(agent.currentTask) as string),
        cycle ? humanizeInternalText(`cycle:${cycle.objective}`) : null,
      ].filter((value): value is string => value !== null),
    ),
  };

  return {
    department,
    currentTheme,
    currentPolicy,
    paused: controls.length > 0,
    runs,
    cycle,
    summaries,
    proposals,
    agents,
    budget: latestBudget
      ? {
          scope: latestBudget.scope,
          tokensRemaining: latestBudget.tokensLimit - latestBudget.tokensUsed,
          callsRemaining: latestBudget.callsLimit - latestBudget.callsUsed,
          utilization: Math.max(
            latestBudget.tokensLimit > 0
              ? latestBudget.tokensUsed / latestBudget.tokensLimit
              : 0,
            latestBudget.callsLimit > 0
              ? latestBudget.callsUsed / latestBudget.callsLimit
              : 0,
          ),
        }
      : null,
    controls,
    signals,
    importantAlerts,
  };
}

export function getDepartmentDetail(department: string): DepartmentDetail {
  return memoizeDashboardQuery("getDepartmentDetail", [department], () =>
    getDepartmentDetailImpl(department),
  );
}

function getReviewsImpl(status?: string) {
  const query = status
    ? db
        .select()
        .from(s.humanReviewItems)
        .where(eq(s.humanReviewItems.status, status))
    : db.select().from(s.humanReviewItems);

  return query.orderBy(desc(s.humanReviewItems.createdAt)).limit(50).all();
}

export function getReviews(status?: string) {
  return memoizeDashboardQuery("getReviews", [status ?? null], () =>
    getReviewsImpl(status),
  );
}

export function approveReview(id: string, note?: string) {
  db.update(s.humanReviewItems)
    .set({
      status: "approved",
      reviewedAt: new Date().toISOString(),
      reviewerNote: note ?? null,
    })
    .where(eq(s.humanReviewItems.id, id))
    .run();
}

export function rejectReview(id: string, note?: string) {
  db.update(s.humanReviewItems)
    .set({
      status: "rejected",
      reviewedAt: new Date().toISOString(),
      reviewerNote: note ?? null,
    })
    .where(eq(s.humanReviewItems.id, id))
    .run();
}

export function getProposals(status?: string) {
  return currentProposalRows(status);
}

export function getProposalHistory(id: string): ProposalHistoryEntry[] {
  const proposal = db
    .select()
    .from(s.proposals)
    .where(eq(s.proposals.id, id))
    .get();

  if (proposal) {
    return db
      .select()
      .from(s.proposalEvents)
      .where(eq(s.proposalEvents.proposalId, id))
      .orderBy(asc(s.proposalEvents.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        stage: row.stage,
        action: row.action,
        actorId: row.actorId,
        note: row.note,
        metadataJson: row.metadataJson,
        createdAt: row.createdAt,
      }));
  }

  const legacyDecision = db
    .select()
    .from(s.optimizationDecisions)
    .where(eq(s.optimizationDecisions.id, id))
    .get();

  if (!legacyDecision) {
    return [];
  }

  return [
    {
      id: legacyDecision.id,
      stage: "optimization",
      action: "created",
      actorId: "legacy-optimizer",
      note: legacyDecision.reason,
      metadataJson: JSON.stringify({
        channel: legacyDecision.channel,
        beforeValue: legacyDecision.beforeValue,
        afterValue: legacyDecision.afterValue,
        changePercent: legacyDecision.changePercent,
      }),
      createdAt: legacyDecision.createdAt,
    },
  ];
}

export function getProposalDetail(id: string): ProposalDetail | null {
  const proposal = db
    .select()
    .from(s.proposals)
    .where(eq(s.proposals.id, id))
    .get();

  if (proposal) {
    const detailProposal: DashboardProposalRow = {
      id: proposal.id,
      agentId: proposal.agentId,
      leaderAgentId: proposal.leaderAgentId,
      executiveAgentId: proposal.executiveAgentId,
      department: proposal.department,
      title: proposal.title,
      description: proposal.description,
      reason: proposal.reason,
      evidence: proposal.evidence,
      expectedEffect: proposal.expectedEffect,
      risk: proposal.risk,
      priority: proposal.priority,
      status: proposal.status,
      currentStage: proposal.currentStage,
      currentApproverId: proposal.currentApproverId,
      reviewerNote: proposal.reviewerNote,
      reviewedAt: proposal.reviewedAt,
      executedAt: proposal.executedAt,
      createdAt: proposal.createdAt,
      source: "proposal",
    };

    return {
      proposal: detailProposal,
      history: getProposalHistory(id),
      currentStage: proposal.currentStage,
      currentApproverId: proposal.currentApproverId,
      relatedDepartmentControls: db
        .select()
        .from(s.systemControls)
        .where(eq(s.systemControls.scope, proposal.department))
        .orderBy(desc(s.systemControls.createdAt))
        .limit(10)
        .all()
        .map((row) => ({
          id: row.id,
          scope: row.scope,
          action: row.action,
          reason: row.reason,
          createdAt: row.createdAt,
        })),
    };
  }

  const legacyDecision = db
    .select()
    .from(s.optimizationDecisions)
    .where(eq(s.optimizationDecisions.id, id))
    .get();

  if (!legacyDecision) {
    return null;
  }

  const legacyProposal: DashboardProposalRow = {
    id: legacyDecision.id,
    agentId: "legacy-optimizer",
    leaderAgentId: null,
    executiveAgentId: null,
    department: legacyDecision.channel,
    title: `${legacyDecision.decisionType} adjustment`,
    description: `${legacyDecision.beforeValue} -> ${legacyDecision.afterValue}`,
    reason: legacyDecision.reason,
    evidence: JSON.stringify({
      channel: legacyDecision.channel,
      beforeValue: legacyDecision.beforeValue,
      afterValue: legacyDecision.afterValue,
      changePercent: legacyDecision.changePercent,
    }),
    expectedEffect: legacyDecision.afterValue,
    risk: null,
    priority: "medium",
    status: proposalStatusFromApprovedBy(legacyDecision.approvedBy),
    currentStage: proposalStatusFromApprovedBy(legacyDecision.approvedBy),
    currentApproverId: null,
    reviewerNote: null,
    reviewedAt: null,
    executedAt: null,
    createdAt: legacyDecision.createdAt,
    source: "optimization_decision",
  };

  return {
    proposal: legacyProposal,
    history: getProposalHistory(id),
    currentStage: legacyProposal.currentStage,
    currentApproverId: legacyProposal.currentApproverId,
    relatedDepartmentControls: db
      .select()
      .from(s.systemControls)
      .where(eq(s.systemControls.scope, legacyProposal.department))
      .orderBy(desc(s.systemControls.createdAt))
      .limit(10)
      .all()
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        action: row.action,
        reason: row.reason,
        createdAt: row.createdAt,
      })),
  };
}

export function approveProposal(id: string, note?: string) {
  const now = new Date().toISOString();
  const proposal = db
    .select()
    .from(s.proposals)
    .where(eq(s.proposals.id, id))
    .get();

  if (proposal) {
    db.update(s.proposals)
      .set({
        status: "approved",
        currentStage: "approved",
        currentApproverId: null,
        reviewerNote: note ?? null,
        reviewedAt: now,
      })
      .where(eq(s.proposals.id, id))
      .run();
    recordProposalEvent({
      proposalId: id,
      stage: proposal.currentStage,
      action: "approved",
      actorId: "dashboard-human",
      note: note ?? "dashboard approved proposal",
    });
    db.insert(s.humanInputs)
      .values({
        id: `proposal_exec_${proposal.id}_${Date.now()}`,
        inputType: "directive",
        content: `[approved-proposal:${proposal.id}] ${proposal.title}\n${proposal.description}`,
        processed: 0,
        createdAt: now,
      })
      .run();
    return;
  }

  db.update(s.optimizationDecisions)
    .set({ approvedBy: "human_approved" })
    .where(eq(s.optimizationDecisions.id, id))
    .run();
}

export function rejectProposal(id: string, note?: string) {
  const now = new Date().toISOString();
  const proposal = db
    .select()
    .from(s.proposals)
    .where(eq(s.proposals.id, id))
    .get();

  if (proposal) {
    db.update(s.proposals)
      .set({
        status: "rejected",
        currentStage: "rejected",
        currentApproverId: null,
        reviewerNote: note ?? null,
        reviewedAt: now,
      })
      .where(eq(s.proposals.id, id))
      .run();
    recordProposalEvent({
      proposalId: id,
      stage: proposal.currentStage,
      action: "rejected",
      actorId: "dashboard-human",
      note: note ?? "dashboard rejected proposal",
    });
    return;
  }

  db.update(s.optimizationDecisions)
    .set({ approvedBy: "human_rejected" })
    .where(eq(s.optimizationDecisions.id, id))
    .run();
}

export function getLogs(page = 1, perPage = 30) {
  const offset = (page - 1) * perPage;
  const rows = db
    .select()
    .from(s.scheduledJobRuns)
    .orderBy(desc(s.scheduledJobRuns.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();

  const total =
    db.select({ value: count() }).from(s.scheduledJobRuns).get()?.value ?? 0;

  return { rows, total, page, perPage };
}

export function pauseSystem(scope: string, reason = "dashboard pause request") {
  const now = new Date().toISOString();
  const activePause = db
    .select()
    .from(s.systemControls)
    .where(
      and(
        eq(s.systemControls.scope, scope),
        eq(s.systemControls.action, "pause"),
        eq(s.systemControls.active, 1),
      ),
    )
    .get();

  if (activePause) {
    return;
  }

  db.insert(s.systemControls)
    .values({
      id: randomUUID(),
      scope,
      action: "pause",
      reason,
      createdBy: "dashboard",
      active: 1,
      createdAt: now,
      resolvedAt: null,
    })
    .run();
}

export function resumeSystem(
  scope: string,
  reason = "dashboard resume request",
) {
  const now = new Date().toISOString();
  db.update(s.systemControls)
    .set({
      active: 0,
      resolvedAt: now,
    })
    .where(
      and(
        eq(s.systemControls.scope, scope),
        eq(s.systemControls.action, "pause"),
        eq(s.systemControls.active, 1),
      ),
    )
    .run();

  db.insert(s.systemControls)
    .values({
      id: randomUUID(),
      scope,
      action: "resume",
      reason,
      createdBy: "dashboard",
      active: 0,
      createdAt: now,
      resolvedAt: now,
    })
    .run();
}

export function addDirective(
  content:
    | string
    | {
        content: string;
        scope?: string | null;
        target?: string | null;
        department?: string | null;
        agentId?: string | null;
        priority?: string | null;
      },
) {
  const now = new Date().toISOString();
  const id = `directive_${Date.now()}`;
  const directiveContent =
    typeof content === "string"
      ? content
      : JSON.stringify(
          {
            kind: "directive",
            content: content.content,
            scope: content.scope ?? null,
            target: content.target ?? null,
            department: content.department ?? null,
            agentId: content.agentId ?? null,
            priority: content.priority ?? null,
            createdAt: now,
          },
          null,
          2,
        );
  db.insert(s.humanInputs)
    .values({
      id,
      inputType: "directive",
      content: directiveContent,
      processed: 0,
      createdAt: now,
    })
    .run();
  return id;
}

export function getKpi() {
  const structuredRows = db
    .select()
    .from(s.kpiSnapshots)
    .orderBy(desc(s.kpiSnapshots.createdAt))
    .limit(60)
    .all();

  const mappedStructuredRows = structuredRows.map((row) => ({
    id: row.id,
    channel: row.channel,
    periodType: row.periodType,
    periodKey: row.periodKey,
    metricName: row.metricName,
    metricValue: row.metricValue,
    metrics: { [row.metricName]: row.metricValue },
    createdAt: row.createdAt,
  }));

  if (mappedStructuredRows.length > 0) {
    return [...mappedStructuredRows, ...buildDerivedKpis()];
  }

  const legacyRows = db
    .select()
    .from(s.channelPerformanceSnapshots)
    .orderBy(desc(s.channelPerformanceSnapshots.createdAt))
    .limit(60)
    .all()
    .map((row) => ({
      ...row,
      metrics: tryParseJson(row.metrics),
      createdAt: row.createdAt,
    }));

  return [...legacyRows, ...buildDerivedKpis()];
}

function getAgentsImpl() {
  const statefulAgents = db
    .select()
    .from(s.agentStates)
    .orderBy(desc(s.agentStates.updatedAt))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      jobName: row.name,
      department: row.department,
      role: row.role,
      status: row.status,
      currentTask: humanizeInternalText(row.currentTask),
      lastCompletedTask: humanizeInternalText(row.lastCompletedTask),
      budgetUsedTokens: row.budgetUsedTokens,
      budgetUsedCalls: row.budgetUsedCalls,
      lastActiveAt: row.lastActiveAt,
      locked: false,
      lockedBy: null,
      lockedAt: null,
      consecutiveFailures: 0,
      nextNotificationAt: null,
      source: "agent_state" as const,
    }));

  const heartbeatAgents = db
    .select()
    .from(s.heartbeatStates)
    .all()
    .map((row) => ({
      id: `heartbeat:${row.jobName}`,
      name: row.jobName,
      jobName: row.jobName,
      department: "system",
      role: "scheduler",
      status: row.lockedBy ? "working" : "idle",
      currentTask: row.lockedBy
        ? humanizeInternalText("heartbeat running")
        : null,
      lastCompletedTask: null,
      budgetUsedTokens: 0,
      budgetUsedCalls: 0,
      lastActiveAt: row.lastRunAt,
      locked: !!row.lockedBy,
      lockedBy: row.lockedBy,
      lockedAt: row.lockedAt,
      consecutiveFailures: row.consecutiveFailures,
      nextNotificationAt: row.nextNotificationAt,
      source: "heartbeat_state" as const,
    }));

  return [...statefulAgents, ...heartbeatAgents].sort((left, right) => {
    const leftTime = left.lastActiveAt
      ? new Date(left.lastActiveAt).getTime()
      : 0;
    const rightTime = right.lastActiveAt
      ? new Date(right.lastActiveAt).getTime()
      : 0;
    return rightTime - leftTime;
  });
}

export function getAgents() {
  return memoizeDashboardQuery("getAgents", [], getAgentsImpl);
}

// ── Recent Posts ─────────────────────────────────────────
export function getRecentPosts() {
  const posts = db
    .select({
      id: s.threadPostResults.id,
      body: s.threadPostDrafts.body,
      impressions: s.threadPostResults.impressions,
      likes: s.threadPostResults.likes,
      repliesCount: s.threadPostResults.repliesCount,
      publishedAt: s.threadPostResults.publishedAt,
    })
    .from(s.threadPostResults)
    .leftJoin(
      s.threadPostDrafts,
      eq(s.threadPostResults.draftId, s.threadPostDrafts.id),
    )
    .orderBy(desc(s.threadPostResults.publishedAt))
    .limit(10)
    .all()
    .map((row) => ({
      id: row.id,
      body: row.body ? row.body.slice(0, 100) : "",
      impressions: row.impressions,
      likes: row.likes,
      repliesCount: row.repliesCount,
      publishedAt: row.publishedAt,
    }));

  const bestRow = db
    .select({
      id: s.threadPostResults.id,
      body: s.threadPostDrafts.body,
      impressions: s.threadPostResults.impressions,
      likes: s.threadPostResults.likes,
      repliesCount: s.threadPostResults.repliesCount,
      publishedAt: s.threadPostResults.publishedAt,
    })
    .from(s.threadPostResults)
    .leftJoin(
      s.threadPostDrafts,
      eq(s.threadPostResults.draftId, s.threadPostDrafts.id),
    )
    .orderBy(desc(s.threadPostResults.impressions))
    .limit(1)
    .get();

  const bestPost = bestRow
    ? {
        id: bestRow.id,
        body: bestRow.body ? bestRow.body.slice(0, 100) : "",
        impressions: bestRow.impressions,
        likes: bestRow.likes,
        repliesCount: bestRow.repliesCount,
        publishedAt: bestRow.publishedAt,
      }
    : null;

  return { posts, bestPost };
}

// ── Recent Notes ─────────────────────────────────────────
export function getRecentNotes() {
  const published = db
    .select()
    .from(s.notePostResults)
    .orderBy(desc(s.notePostResults.publishedAt))
    .limit(5)
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title ?? "",
      noteUrl: row.noteUrl ?? null,
      views: row.views,
      likes: row.likes,
      revenueYen: row.revenueYen,
      publishedAt: row.publishedAt,
    }));

  const drafts = db
    .select()
    .from(s.noteDrafts)
    .orderBy(desc(s.noteDrafts.createdAt))
    .limit(5)
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
    }));

  const thumbnailTasks = db
    .select({
      id: s.thumbnailTasks.id,
      noteTitle: s.noteDrafts.title,
      instruction: s.thumbnailTasks.instruction,
      createdAt: s.thumbnailTasks.createdAt,
    })
    .from(s.thumbnailTasks)
    .leftJoin(
      s.noteDrafts,
      eq(s.thumbnailTasks.noteDraftId, s.noteDrafts.id),
    )
    .where(eq(s.thumbnailTasks.status, "pending"))
    .all()
    .map((row) => ({
      id: row.id,
      noteTitle: row.noteTitle ?? "",
      instruction: row.instruction ?? "",
      createdAt: row.createdAt,
    }));

  return { published, drafts, thumbnailTasks };
}

// ── Heartbeat History ────────────────────────────────────
export function getHeartbeatHistory() {
  const cycles = db
    .select()
    .from(s.executiveCycles)
    .orderBy(desc(s.executiveCycles.createdAt))
    .limit(10)
    .all();

  return {
    cycles: cycles.map((cycle) => {
      const runs = db
        .select()
        .from(s.departmentRuns)
        .where(eq(s.departmentRuns.cycleId, cycle.id))
        .orderBy(asc(s.departmentRuns.createdAt))
        .all()
        .map((run) => ({
          department: DEPARTMENT_DISPLAY_NAMES[run.department] ?? run.department,
          actionType: ACTION_LABELS[run.phase] ?? run.phase,
          status: run.status,
          summary: humanizeInternalText(run.summary ?? ""),
          agentName: resolveAgentName(run.phase),
        }));

      // Parse executive decision for reasoning and department instructions
      let reasoning: string | null = null;
      let departmentInstructions: Record<string, string> | null = null;
      if (cycle.decisionJson) {
        try {
          const decision = JSON.parse(cycle.decisionJson);
          reasoning = decision.reasoning ?? null;
          if (decision.departmentInstructions) {
            departmentInstructions = {};
            for (const [k, v] of Object.entries(decision.departmentInstructions)) {
              const label = DEPARTMENT_DISPLAY_NAMES[k] ?? k;
              departmentInstructions[label] = v as string;
            }
          }
        } catch { /* ignore parse errors */ }
      }

      return {
        id: cycle.id,
        objective: OBJECTIVE_LABELS[cycle.objective] ?? cycle.objective,
        funnelStage: cycle.funnelStage,
        summary: humanizeInternalText(cycle.summary ?? ""),
        reasoning,
        departmentInstructions,
        createdAt: cycle.createdAt,
        runs,
      };
    }),
  };
}

export function getAgentDetail(id: string) {
  if (id.startsWith("heartbeat:")) {
    const jobName = id.slice("heartbeat:".length);
    const row = db
      .select()
      .from(s.heartbeatStates)
      .where(eq(s.heartbeatStates.jobName, jobName))
      .get();

    if (!row) {
      return null;
    }

    return {
      id,
      name: row.jobName,
      department: "system",
      role: "scheduler",
      status: row.lockedBy ? "working" : "idle",
      currentTask: row.lockedBy
        ? humanizeInternalText("heartbeat running")
        : null,
      locked: !!row.lockedBy,
      lockedBy: row.lockedBy,
      lockedAt: row.lockedAt,
      consecutiveFailures: row.consecutiveFailures,
      nextNotificationAt: row.nextNotificationAt,
      lastActiveAt: row.lastRunAt,
      recentRuns: db
        .select()
        .from(s.scheduledJobRuns)
        .where(eq(s.scheduledJobRuns.jobName, row.jobName))
        .orderBy(desc(s.scheduledJobRuns.createdAt))
        .limit(10)
        .all(),
    };
  }

  const agent = db
    .select()
    .from(s.agentStates)
    .where(eq(s.agentStates.id, id))
    .get();

  if (!agent) {
    return null;
  }

  const budget = latestRowsByKey(
    db
      .select()
      .from(s.budgetTracking)
      .where(eq(s.budgetTracking.scope, agent.department))
      .all(),
    (row) => row.scope,
    (row) => row.updatedAt,
  )[0];

  return {
    id: agent.id,
    name: agent.name,
    department: agent.department,
    role: agent.role,
    status: agent.status,
    currentTask: humanizeInternalText(agent.currentTask),
    lastCompletedTask: humanizeInternalText(agent.lastCompletedTask),
    budgetUsedTokens: agent.budgetUsedTokens,
    budgetUsedCalls: agent.budgetUsedCalls,
    lastActiveAt: agent.lastActiveAt,
    recentProposals: currentProposalRows().filter(
      (row) => row.agentId === agent.id,
    ),
    budget: budget
      ? {
          scope: budget.scope,
          tokensRemaining: budget.tokensLimit - budget.tokensUsed,
          callsRemaining: budget.callsLimit - budget.callsUsed,
          utilization: Math.max(
            budget.tokensLimit > 0 ? budget.tokensUsed / budget.tokensLimit : 0,
            budget.callsLimit > 0 ? budget.callsUsed / budget.callsLimit : 0,
          ),
        }
      : null,
  };
}
