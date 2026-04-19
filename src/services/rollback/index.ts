import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  anomalyEvents,
  funnelSnapshots,
  improvementInsights,
  rollbacks,
  winningPatterns,
} from "../../db/schema.js";
import { getCompiledContractStore } from "../contracts/index.js";

type RollbackChannel = "threads" | "note";

interface RollbackThresholds {
  ctrDropRatio: number;
  purchaseRateDropRatio: number;
  revenuePerViewDropRatio: number;
  complaintSpikeCount: number;
  complaintWindowMs: number;
}

const FALLBACK_THRESHOLDS: RollbackThresholds = {
  ctrDropRatio: 0.7,
  purchaseRateDropRatio: 0.6,
  revenuePerViewDropRatio: 0.6,
  complaintSpikeCount: 3,
  complaintWindowMs: 24 * 60 * 60 * 1000,
};

function loadRollbackThresholds(): RollbackThresholds {
  try {
    const store = getCompiledContractStore();
    const policy = store.policies.find((p) => p.id === "rollback-thresholds");
    const thresholds = policy?.thresholds ?? {};
    const windowHours = Number(thresholds.complaintWindowHours);
    return {
      ctrDropRatio:
        Number(thresholds.ctrDropRatio) || FALLBACK_THRESHOLDS.ctrDropRatio,
      purchaseRateDropRatio:
        Number(thresholds.purchaseRateDropRatio) ||
        FALLBACK_THRESHOLDS.purchaseRateDropRatio,
      revenuePerViewDropRatio:
        Number(thresholds.revenuePerViewDropRatio) ||
        FALLBACK_THRESHOLDS.revenuePerViewDropRatio,
      complaintSpikeCount:
        Number(thresholds.complaintSpikeCount) ||
        FALLBACK_THRESHOLDS.complaintSpikeCount,
      complaintWindowMs: Number.isFinite(windowHours)
        ? windowHours * 60 * 60 * 1000
        : FALLBACK_THRESHOLDS.complaintWindowMs,
    };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[rollback] Failed to load rollback-thresholds policy; using fallback",
    );
    return FALLBACK_THRESHOLDS;
  }
}

export interface WinningPatternInput {
  channel: RollbackChannel;
  sourceType: string;
  sourceId: string;
  insight: string;
  action: string;
  metricName: string;
  metricValue: number;
  evidence?: Record<string, unknown>;
}

export interface RollbackTrigger {
  channel: RollbackChannel;
  kind: string;
  previousValue: number;
  currentValue: number;
  thresholdRatio: number;
  snapshotPeriodKey: string;
}

export interface RollbackDecision {
  shouldRollback: boolean;
  channel: RollbackChannel | null;
  reason: string;
  trigger: RollbackTrigger | null;
  targetPattern: {
    id: string | null;
    insight: string;
    action: string;
  } | null;
}

export interface RollbackExecutionResult extends RollbackDecision {
  applied: boolean;
  rollbackId: string | null;
}

export interface RollbackService {
  evaluate(): RollbackDecision;
  applyIfNeeded(): RollbackExecutionResult;
  recordWinningPattern(input: WinningPatternInput): string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function parseTriggerJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function looksLikeComplaint(text: string): boolean {
  return /(complaint|refund|chargeback|abuse|spam|danger|クレーム|返金)/i.test(
    text,
  );
}

function parseWinningPatternEvidence(evidenceJson: string): {
  sourceType?: string;
  sourceId?: string;
  insight?: string;
  action?: string;
} | null {
  try {
    return JSON.parse(evidenceJson) as {
      sourceType?: string;
      sourceId?: string;
      insight?: string;
      action?: string;
    };
  } catch {
    return null;
  }
}

export function createRollbackService(): RollbackService {
  const thresholds = loadRollbackThresholds();

  function recordWinningPattern(input: WinningPatternInput): string {
    const now = nowIso();
    const id = randomUUID();
    db.insert(winningPatterns)
      .values({
        id,
        experimentId: input.sourceId,
        patternKey: `${input.channel}:${input.metricName}:${input.sourceId}`,
        bottleneck: input.channel,
        actionType: input.action,
        primaryMetric: input.metricName,
        baselineValue: 0,
        observedValue: input.metricValue,
        evidenceJson: JSON.stringify({
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          insight: input.insight,
          action: input.action,
          ...(input.evidence ?? {}),
        }),
        createdAt: now,
      })
      .run();
    return id;
  }

  function resolveTargetPattern(channel: RollbackChannel) {
    const explicitPattern = db
      .select()
      .from(winningPatterns)
      .where(eq(winningPatterns.bottleneck, channel))
      .orderBy(desc(winningPatterns.createdAt))
      .limit(1)
      .get();

    if (explicitPattern) {
      const evidence = parseWinningPatternEvidence(
        explicitPattern.evidenceJson,
      );
      return {
        id: explicitPattern.id,
        insight: evidence?.insight ?? explicitPattern.patternKey,
        action: evidence?.action ?? explicitPattern.actionType,
      };
    }

    const fallbackSourceType = channel === "threads" ? "thread_post" : "note";
    const fallbackInsight = db
      .select()
      .from(improvementInsights)
      .where(eq(improvementInsights.sourceType, fallbackSourceType))
      .orderBy(desc(improvementInsights.createdAt))
      .limit(1)
      .get();

    if (!fallbackInsight) {
      return null;
    }

    return {
      id: null,
      insight: fallbackInsight.insight,
      action: fallbackInsight.action,
    };
  }

  function evaluate(): RollbackDecision {
    const snapshots = db
      .select()
      .from(funnelSnapshots)
      .orderBy(desc(funnelSnapshots.capturedAt))
      .limit(2)
      .all();

    if (snapshots.length < 2) {
      return {
        shouldRollback: false,
        channel: null,
        reason: "not enough funnel snapshots",
        trigger: null,
        targetPattern: null,
      };
    }

    const [latest, previous] = snapshots;
    const currentCtr = ratio(latest.profileTransitions, latest.impressions);
    const previousCtr = ratio(
      previous.profileTransitions,
      previous.impressions,
    );
    if (previousCtr > 0 && currentCtr < previousCtr * thresholds.ctrDropRatio) {
      return {
        shouldRollback: true,
        channel: "threads",
        reason: "profile transition rate dropped sharply",
        trigger: {
          channel: "threads",
          kind: "profile_transition_rate_drop",
          previousValue: previousCtr,
          currentValue: currentCtr,
          thresholdRatio: thresholds.ctrDropRatio,
          snapshotPeriodKey: latest.periodKey,
        },
        targetPattern: resolveTargetPattern("threads"),
      };
    }

    const currentPurchaseRate = ratio(latest.purchases, latest.noteViews);
    const previousPurchaseRate = ratio(previous.purchases, previous.noteViews);
    if (
      previousPurchaseRate > 0 &&
      currentPurchaseRate <
        previousPurchaseRate * thresholds.purchaseRateDropRatio
    ) {
      return {
        shouldRollback: true,
        channel: "note",
        reason: "purchase conversion dropped sharply",
        trigger: {
          channel: "note",
          kind: "purchase_rate_drop",
          previousValue: previousPurchaseRate,
          currentValue: currentPurchaseRate,
          thresholdRatio: thresholds.purchaseRateDropRatio,
          snapshotPeriodKey: latest.periodKey,
        },
        targetPattern: resolveTargetPattern("note"),
      };
    }

    const currentRevenuePerView = ratio(latest.revenue, latest.noteViews);
    const previousRevenuePerView = ratio(previous.revenue, previous.noteViews);
    if (
      previousRevenuePerView > 0 &&
      currentRevenuePerView <
        previousRevenuePerView * thresholds.revenuePerViewDropRatio
    ) {
      return {
        shouldRollback: true,
        channel: "note",
        reason: "revenue efficiency dropped sharply",
        trigger: {
          channel: "note",
          kind: "revenue_per_view_drop",
          previousValue: previousRevenuePerView,
          currentValue: currentRevenuePerView,
          thresholdRatio: thresholds.revenuePerViewDropRatio,
          snapshotPeriodKey: latest.periodKey,
        },
        targetPattern: resolveTargetPattern("note"),
      };
    }

    const recentComplaintCount = db
      .select()
      .from(anomalyEvents)
      .orderBy(desc(anomalyEvents.detectedAt))
      .all()
      .filter(
        (row) =>
          new Date(row.detectedAt).getTime() >=
            Date.now() - thresholds.complaintWindowMs &&
          looksLikeComplaint(
            `${row.category} ${row.message} ${row.metadataJson ?? ""}`,
          ),
      ).length;
    if (recentComplaintCount >= thresholds.complaintSpikeCount) {
      return {
        shouldRollback: true,
        channel: "note",
        reason: "complaint signal spiked",
        trigger: {
          channel: "note",
          kind: "complaint_signal_spike",
          previousValue: thresholds.complaintSpikeCount - 1,
          currentValue: recentComplaintCount,
          thresholdRatio: 1,
          snapshotPeriodKey: latest.periodKey,
        },
        targetPattern: resolveTargetPattern("note"),
      };
    }

    return {
      shouldRollback: false,
      channel: null,
      reason: "rollback conditions not met",
      trigger: null,
      targetPattern: null,
    };
  }

  function applyIfNeeded(): RollbackExecutionResult {
    const decision = evaluate();
    if (
      !decision.shouldRollback ||
      !decision.channel ||
      !decision.trigger ||
      !decision.targetPattern
    ) {
      return {
        ...decision,
        applied: false,
        rollbackId: null,
      };
    }

    const existingRollback = db
      .select()
      .from(rollbacks)
      .where(eq(rollbacks.scope, decision.channel))
      .orderBy(desc(rollbacks.updatedAt))
      .limit(1)
      .get();
    const existingTrigger = existingRollback
      ? parseTriggerJson(existingRollback.previousStateJson ?? "")
      : null;
    if (
      existingTrigger?.snapshotPeriodKey ===
        decision.trigger.snapshotPeriodKey &&
      existingTrigger?.kind === decision.trigger.kind
    ) {
      return {
        ...decision,
        applied: false,
        rollbackId: existingRollback?.id ?? null,
      };
    }

    const appliedAt = nowIso();
    const rollbackId = randomUUID();
    const sourceType = decision.channel === "threads" ? "thread_post" : "note";

    db.insert(improvementInsights)
      .values({
        id: randomUUID(),
        sourceType,
        sourceId: `rollback:${decision.trigger.snapshotPeriodKey}`,
        insight: `Rollback triggered for ${decision.channel}: ${decision.reason}.`,
        action: decision.targetPattern.action,
        priority: "high",
        createdAt: appliedAt,
      })
      .run();

    db.insert(rollbacks)
      .values({
        id: rollbackId,
        scope: decision.channel,
        trigger: decision.trigger.kind,
        reason: decision.reason,
        previousStateJson: JSON.stringify(decision.trigger),
        appliedStateJson: JSON.stringify({
          targetPatternId: decision.targetPattern.id,
          targetInsight: decision.targetPattern.insight,
          targetAction: decision.targetPattern.action,
        }),
        status: "executed",
        createdAt: appliedAt,
        updatedAt: appliedAt,
      })
      .run();

    return {
      ...decision,
      applied: true,
      rollbackId,
    };
  }

  return {
    evaluate,
    applyIfNeeded,
    recordWinningPattern,
  };
}
