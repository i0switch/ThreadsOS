import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import * as s from "../../db/schema.js";

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

function readStrategyState() {
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
  command: "司令塔",
  optimization: "改善判断",
  research: "リサーチ",
  threads: "Threads投稿",
  community: "返信・反応分析",
  note: "note運用",
  system: "システム",
};

const WORKSTREAM_DEFINITIONS = [
  {
    id: "command",
    label: "司令塔",
    departments: ["command", "optimization"],
  },
  {
    id: "research",
    label: "リサーチ",
    departments: ["research"],
  },
  {
    id: "threads",
    label: "Threads運用",
    departments: ["threads", "community"],
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

function currentProposalRows(status?: string): DashboardProposalRow[] {
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

export function getSummary(): DashboardSummary {
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
  const threadsDepartments = departmentOverviews.filter((row) =>
    ["threads", "community"].includes(row.department),
  );
  const noteAgents = allAgents.filter((row) => row.department === "note");
  const threadsAgents = allAgents.filter((row) =>
    ["threads", "community"].includes(row.department),
  );

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
            ? "投稿運用は動いているが、確認待ちや失敗が混ざっている"
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
      ? `要確認が${pendingReviews + pendingProposals}件`
      : health === "ok"
        ? "大きな確認待ちはなし"
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

export function getDepartments(): DepartmentOverview[] {
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

export function getDepartmentDetail(department: string): DepartmentDetail {
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

export function getReviews(status?: string) {
  const query = status
    ? db
        .select()
        .from(s.humanReviewItems)
        .where(eq(s.humanReviewItems.status, status))
    : db.select().from(s.humanReviewItems);

  return query.orderBy(desc(s.humanReviewItems.createdAt)).limit(50).all();
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

export function getAgents() {
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
