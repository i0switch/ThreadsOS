import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import * as s from "../../db/schema.js";
import {
  type AuditorAction,
  normalizeAuditorAction,
} from "../auditor/index.js";
import { getCompiledContractStore } from "../contracts/index.js";

type ModeKind =
  | "full_autonomy"
  | "threads_only"
  | "observe_only"
  | "safe_freeze";

export interface DashboardObservationResponse {
  generatedAt: string;
  mode: {
    current: ModeKind;
    label: string;
    reason: string;
  };
  bottleneck: {
    stage: "reach" | "click" | "read" | "buy" | null;
    label: string;
    reason: string;
    snapshotAt: string | null;
    metrics: Array<{
      label: string;
      value: string;
      context: string;
    }>;
  };
  runnerHealth: Array<{
    runner: string;
    status: string;
    consecutiveFailures: number;
    lastModel: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastError: string | null;
    timeoutCount: number;
    invalidJsonCount: number;
    totalCalls: number;
    budget: {
      periodKey: string | null;
      callsUsed: number;
      callsLimit: number;
      tokensUsed: number;
      tokensLimit: number;
    } | null;
  }>;
  sessionHealth: Array<{
    scope: string;
    provider: string;
    state: string;
    consecutiveFailures: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    detail: string | null;
  }>;
  outbox: {
    counts: Record<string, number>;
    items: Array<{
      id: string;
      targetPlatform: string;
      operationType: string;
      status: string;
      attempts: number;
      lastError: string | null;
      updatedAt: string;
    }>;
  };
  anomalies: Array<{
    id: string;
    category: string;
    severity: string;
    message: string;
    detectedAt: string;
  }>;
  decisionEvidence: Array<{
    id: string;
    entityType: string;
    entityId: string;
    decisionType: string;
    summary: string;
    createdAt: string;
  }>;
  rollbacks: Array<{
    id: string;
    scope: string;
    trigger: string;
    reason: string;
    status: string;
    createdAt: string;
  }>;
  contracts: {
    compiledAt: string;
    summary: {
      agents: number;
      playbooks: number;
      policies: number;
    };
    agents: Array<{
      id: string;
      department: string;
      primaryRunner: string;
      fallbackRunner: string;
      llmBudget: number;
      fallback: string;
    }>;
    playbooks: Array<{
      id: string;
      owner: string;
      stepCount: number;
    }>;
    policies: Array<{
      id: string;
      scope: string;
      ruleCount: number;
    }>;
  };
  auditor: {
    counts: Record<AuditorAction, number>;
    items: Array<{
      id: string;
      subjectType: string;
      subjectId: string;
      action: AuditorAction;
      reason: string;
      source: string;
      createdAt: string;
    }>;
  };
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

function parseJson(raw: string | null): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "記録なし";
  }

  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }

  return JSON.stringify(value).slice(0, 120);
}

function ratioLabel(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.0%";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function deriveMode(input: {
  runnerHealth: Array<{ status: string }>;
  sessionHealth: Array<{ scope: string; provider: string; state: string }>;
  outboxFailedCount: number;
  activeControls: Array<{ scope: string; action: string }>;
}): DashboardObservationResponse["mode"] {
  const globalPause = input.activeControls.some(
    (control) => control.scope === "global" && control.action === "pause",
  );
  const trippedCount = input.runnerHealth.filter(
    (row) => row.status === "tripped",
  ).length;
  const noteSession = input.sessionHealth.find(
    (row) => row.scope === "note" || row.provider === "note",
  );

  if (globalPause || trippedCount >= 2) {
    return {
      current: "safe_freeze",
      label: "Safe Freeze",
      reason: globalPause
        ? "global pause が有効なため投稿を停止中"
        : "複数 runner が tripped しているため新規実行を停止中",
    };
  }

  if (noteSession?.state === "quarantined") {
    return {
      current: "threads_only",
      label: "Threads-only",
      reason: "note session が quarantined のため Threads 運用のみ継続",
    };
  }

  if (trippedCount >= 1 || input.outboxFailedCount > 0) {
    return {
      current: "observe_only",
      label: "Observe-only",
      reason:
        trippedCount >= 1
          ? "runner 異常を検知したため観測優先へ退避"
          : "failed outbox が残っているため実行より観測を優先",
    };
  }

  return {
    current: "full_autonomy",
    label: "Full Autonomy",
    reason: "runner, session, outbox に重大な停止条件なし",
  };
}

function deriveBottleneck(): DashboardObservationResponse["bottleneck"] {
  const latest = db
    .select()
    .from(s.funnelSnapshots)
    .orderBy(desc(s.funnelSnapshots.capturedAt))
    .limit(1)
    .get();

  if (!latest) {
    return {
      stage: null,
      label: "未判定",
      reason: "funnel_snapshots がまだ記録されていません",
      snapshotAt: null,
      metrics: [],
    };
  }

  const stages = [
    {
      stage: "reach" as const,
      label: "Reach",
      numerator: latest.profileTransitions,
      denominator: latest.impressions,
      context: `${latest.profileTransitions}/${latest.impressions}`,
    },
    {
      stage: "click" as const,
      label: "Click",
      numerator: latest.noteClicks,
      denominator: latest.profileTransitions,
      context: `${latest.noteClicks}/${latest.profileTransitions}`,
    },
    {
      stage: "read" as const,
      label: "Read",
      numerator: latest.noteViews,
      denominator: latest.noteClicks,
      context: `${latest.noteViews}/${latest.noteClicks}`,
    },
    {
      stage: "buy" as const,
      label: "Buy",
      numerator: latest.purchases,
      denominator: latest.noteViews,
      context: `${latest.purchases}/${latest.noteViews}`,
    },
  ];

  const weakest = stages
    .filter((stage) => stage.denominator > 0)
    .sort(
      (left, right) =>
        left.numerator / left.denominator - right.numerator / right.denominator,
    )[0];

  return {
    stage: weakest?.stage ?? null,
    label: weakest?.label ?? "未判定",
    reason: weakest
      ? `${weakest.label} が最も落ち込んでいます (${ratioLabel(
          weakest.numerator,
          weakest.denominator,
        )})`
      : "分母が不足しているため判定保留",
    snapshotAt: latest.capturedAt,
    metrics: stages.map((stage) => ({
      label: stage.label,
      value: ratioLabel(stage.numerator, stage.denominator),
      context: stage.context,
    })),
  };
}

export function getDashboardObservation(): DashboardObservationResponse {
  const compiled = getCompiledContractStore();
  const runnerBudgetRows = latestRowsByKey(
    db.select().from(s.runnerBudgets).all(),
    (row) => row.runner,
    (row) => row.updatedAt,
  );
  const runnerBudgetMap = new Map(
    runnerBudgetRows.map((row) => [row.runner, row]),
  );
  const runnerHealth = db
    .select()
    .from(s.runnerHealth)
    .orderBy(desc(s.runnerHealth.updatedAt))
    .all()
    .map((row) => ({
      runner: row.runner,
      status: row.status,
      consecutiveFailures: row.consecutiveFailures,
      lastModel: row.lastModel ?? null,
      lastSuccessAt: row.lastSuccessAt ?? null,
      lastFailureAt: row.lastFailureAt ?? null,
      lastError: row.lastError ?? null,
      timeoutCount: row.timeoutCount,
      invalidJsonCount: row.invalidJsonCount,
      totalCalls: row.totalCalls,
      budget: runnerBudgetMap.get(row.runner)
        ? {
            periodKey: runnerBudgetMap.get(row.runner)?.periodKey ?? null,
            callsUsed: runnerBudgetMap.get(row.runner)?.callsUsed ?? 0,
            callsLimit: runnerBudgetMap.get(row.runner)?.callsLimit ?? 0,
            tokensUsed: runnerBudgetMap.get(row.runner)?.tokensUsed ?? 0,
            tokensLimit: runnerBudgetMap.get(row.runner)?.tokensLimit ?? 0,
          }
        : null,
    }));

  const sessionHealth = db
    .select()
    .from(s.sessionHealth)
    .orderBy(desc(s.sessionHealth.updatedAt))
    .all()
    .map((row) => ({
      scope: row.scope,
      provider: row.provider,
      state: row.state,
      consecutiveFailures: row.consecutiveFailures,
      lastSuccessAt: row.lastSuccessAt ?? null,
      lastFailureAt: row.lastFailureAt ?? null,
      detail: row.detail ?? null,
    }));

  const activeControls = db
    .select()
    .from(s.systemControls)
    .where(eq(s.systemControls.active, 1))
    .all()
    .map((row) => ({
      scope: row.scope,
      action: row.action,
    }));

  const outboxRows = db
    .select()
    .from(s.executionOutbox)
    .orderBy(desc(s.executionOutbox.updatedAt))
    .limit(12)
    .all();
  const outboxCounts = outboxRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  const anomalies = db
    .select()
    .from(s.anomalyEvents)
    .orderBy(desc(s.anomalyEvents.detectedAt))
    .limit(8)
    .all()
    .map((row) => ({
      id: row.id,
      category: row.category,
      severity: row.severity,
      message: row.message,
      detectedAt: row.detectedAt,
    }));

  const decisionEvidence = db
    .select()
    .from(s.decisionEvidence)
    .orderBy(desc(s.decisionEvidence.createdAt))
    .limit(12)
    .all()
    .map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      decisionType: row.decisionType,
      summary: compactValue(parseJson(row.evidenceJson)),
      createdAt: row.createdAt,
    }));

  const rollbacks = db
    .select()
    .from(s.rollbacks)
    .orderBy(desc(s.rollbacks.createdAt))
    .limit(8)
    .all()
    .map((row) => ({
      id: row.id,
      scope: row.scope,
      trigger: row.trigger,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
    }));

  const threadAudits = db
    .select()
    .from(s.threadPostAudits)
    .orderBy(desc(s.threadPostAudits.createdAt))
    .limit(12)
    .all()
    .map((row) => {
      const reasons = parseJson(row.reasons);
      return {
        id: row.id,
        subjectType: "thread_draft",
        subjectId: row.draftId,
        action: normalizeAuditorAction({
          verdict: row.verdict,
          severity: row.severity,
        }),
        reason: Array.isArray(reasons)
          ? reasons.join(" / ")
          : compactValue(reasons),
        source: "thread_post_audits",
        createdAt: row.createdAt,
      };
    });

  const noteAudits = db
    .select()
    .from(s.noteAudits)
    .orderBy(desc(s.noteAudits.createdAt))
    .limit(12)
    .all()
    .map((row) => ({
      id: row.id,
      subjectType: "note_draft",
      subjectId: row.draftId,
      action: normalizeAuditorAction({
        verdict: row.verdict,
        score: row.score,
      }),
      reason:
        [row.weakestSection, row.rewriteGuidance]
          .filter((value): value is string => !!value)
          .join(" / ") || `score=${row.score}`,
      source: "note_audits",
      createdAt: row.createdAt,
    }));

  const auditorItems = [...threadAudits, ...noteAudits]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    .slice(0, 16);
  const auditorCounts = auditorItems.reduce<Record<AuditorAction, number>>(
    (acc, item) => {
      acc[item.action] += 1;
      return acc;
    },
    {
      pass: 0,
      rewrite: 0,
      skip: 0,
      quarantine: 0,
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    mode: deriveMode({
      runnerHealth,
      sessionHealth,
      outboxFailedCount: outboxCounts.failed ?? 0,
      activeControls,
    }),
    bottleneck: deriveBottleneck(),
    runnerHealth,
    sessionHealth,
    outbox: {
      counts: outboxCounts,
      items: outboxRows.map((row) => ({
        id: row.id,
        targetPlatform: row.targetPlatform,
        operationType: row.operationType,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError ?? null,
        updatedAt: row.updatedAt,
      })),
    },
    anomalies,
    decisionEvidence,
    rollbacks,
    contracts: {
      compiledAt: compiled.compiledAt,
      summary: {
        agents: compiled.agents.length,
        playbooks: compiled.playbooks.length,
        policies: compiled.policies.length,
      },
      agents: compiled.agents.map((contract) => ({
        id: contract.id,
        department: contract.department,
        primaryRunner: contract.primaryRunner,
        fallbackRunner: contract.fallbackRunner,
        llmBudget: contract.llmBudget,
        fallback: contract.fallback,
      })),
      playbooks: compiled.playbooks.map((contract) => ({
        id: contract.id,
        owner: contract.owner,
        stepCount: contract.steps.length,
      })),
      policies: compiled.policies.map((contract) => ({
        id: contract.id,
        scope: contract.scope,
        ruleCount: contract.rules.length,
      })),
    },
    auditor: {
      counts: auditorCounts,
      items: auditorItems,
    },
  };
}

export interface CampaignRevenueSummary {
  campaignId: string;
  name: string;
  theme: string;
  status: string;
  bottleneckFocus: string | null;
  startedAt: string;
  endedAt: string | null;
  totalRevenueYen: number;
  totalPurchases: number;
  latestSnapshot: {
    capturedAt: string;
    impressions: number;
    profileTransitions: number;
    noteClicks: number;
    noteViews: number;
    purchases: number;
    revenue: number;
  } | null;
}

function getLatestCampaignSnapshot(
  campaignId: string,
): CampaignRevenueSummary["latestSnapshot"] {
  const row = db
    .select()
    .from(s.noteMetrics)
    .where(eq(s.noteMetrics.campaignId, campaignId))
    .orderBy(desc(s.noteMetrics.capturedAt))
    .limit(1)
    .get();
  if (!row) return null;

  const threadsRow = db
    .select()
    .from(s.threadsMetrics)
    .where(eq(s.threadsMetrics.campaignId, campaignId))
    .orderBy(desc(s.threadsMetrics.capturedAt))
    .limit(1)
    .get();

  return {
    capturedAt: row.capturedAt,
    impressions: threadsRow?.impressions ?? 0,
    profileTransitions: threadsRow?.profileTransitions ?? 0,
    noteClicks: row.noteClicks,
    noteViews: row.noteViews,
    purchases: row.purchases,
    revenue: row.revenue,
  };
}

export function getCampaignRevenue(
  campaignId: string,
): CampaignRevenueSummary | null {
  const campaign = db
    .select()
    .from(s.campaigns)
    .where(eq(s.campaigns.id, campaignId))
    .get();
  if (!campaign) return null;

  const revenueRows = db
    .select()
    .from(s.revenueEvents)
    .where(eq(s.revenueEvents.campaignId, campaignId))
    .all();

  const totalRevenueYen = revenueRows.reduce(
    (sum, row) => sum + (row.amountYen ?? 0),
    0,
  );
  const totalPurchases = revenueRows.reduce(
    (sum, row) => sum + (row.purchasesCount ?? 0),
    0,
  );

  return {
    campaignId: campaign.id,
    name: campaign.name,
    theme: campaign.theme,
    status: campaign.status,
    bottleneckFocus: campaign.bottleneckFocus ?? null,
    startedAt: campaign.startedAt,
    endedAt: campaign.endedAt ?? null,
    totalRevenueYen,
    totalPurchases,
    latestSnapshot: getLatestCampaignSnapshot(campaignId),
  };
}

export function listCampaignSummaries(options?: {
  status?: "active" | "paused" | "archived";
}): CampaignRevenueSummary[] {
  const rows = options?.status
    ? db
        .select()
        .from(s.campaigns)
        .where(eq(s.campaigns.status, options.status))
        .orderBy(desc(s.campaigns.startedAt))
        .all()
    : db.select().from(s.campaigns).orderBy(desc(s.campaigns.startedAt)).all();

  return rows
    .map((row) => getCampaignRevenue(row.id))
    .filter((entry): entry is CampaignRevenueSummary => entry !== null);
}
