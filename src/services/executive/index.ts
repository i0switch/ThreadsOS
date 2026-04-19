import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { createRuntimeLedgerRepository } from "../../db/repositories/runtime-ledger.js";
import {
  departmentRuns,
  executiveCycles,
  improvementInsights,
  strategyHistory,
  strategyStates,
  threadPostDrafts,
  threadPostResults,
  topics,
} from "../../db/schema.js";
import {
  type DepartmentDirective,
  type DepartmentName,
  type DepartmentReport,
  type FunnelStage,
  type HeartbeatObjective,
  resolveDepartmentName,
} from "../../domain/department/index.js";
import { parseJsonObject } from "../../utils/llm-json.js";
import type {
  ActionType,
  ScheduledAction,
} from "../content-scheduler/index.js";

export interface BrandPolicy {
  tone: "professional" | "casual" | "bold" | "educational";
  topicsToAvoid: string[];
  topicsToEmphasize: string[];
  contentGuards: "strict" | "moderate" | "permissive";
}

export interface GrowthPolicy {
  channelFocus: ("threads" | "note")[];
  contentFrequency: "aggressive" | "steady" | "conservative";
  audienceStrategy: "existing" | "adjacent" | "new";
}

export interface MonetizationPolicy {
  priceStrategy: "premium" | "standard" | "value";
  conversionFocus: "direct" | "nurture" | "educational";
  revenueTarget: "growth" | "maintain" | "experiment";
}

export interface StrategyPolicies {
  brand: BrandPolicy;
  growth: GrowthPolicy;
  monetization: MonetizationPolicy;
}

export const DEFAULT_POLICIES: StrategyPolicies = {
  brand: {
    tone: "casual",
    topicsToAvoid: [],
    topicsToEmphasize: [],
    contentGuards: "moderate",
  },
  growth: {
    channelFocus: ["threads", "note"],
    contentFrequency: "steady",
    audienceStrategy: "existing",
  },
  monetization: {
    priceStrategy: "standard",
    conversionFocus: "nurture",
    revenueTarget: "growth",
  },
};

export interface StrategyStateSnapshot {
  objective: HeartbeatObjective;
  funnelStage: FunnelStage;
  priorityTopics: string[];
  pendingHumanInputs: number;
  dueThreadSlots: number;
  dueNoteSlots: number;
  pendingReplies: number;
  latestNoteCount: number;
  insightFocus: string[];
  activeActionTypes: ActionType[];
  policies: StrategyPolicies;
}

export interface ContentGuidance {
  topicsToEmphasize: string[];
  topicsToAvoid: string[];
  recommendedTone: string;
  replyPolicy: string;
}

export interface ErrorContext {
  recentFailures: Array<{ jobName: string; error: string; at: string }>;
  pendingReviewCount: number;
  pendingProposalCount: number;
  consecutiveFailures: number;
  pendingProposalSummaries?: Array<{
    id: string;
    actionType: string;
    reason: string;
  }>;
}

export interface HeartbeatCyclePlan {
  cycleId: string;
  strategyKey: string;
  objective: HeartbeatObjective;
  funnelStage: FunnelStage;
  approvedActions: ScheduledAction[];
  skippedActions: Array<{ action: ScheduledAction; reason: string }>;
  directives: DepartmentDirective[];
  strategy: StrategyStateSnapshot;
  llmReasoning?: string;
  departmentInstructions?: Record<string, string>;
  contentGuidance?: ContentGuidance;
  policyUpdates?: Partial<StrategyPolicies>;
  proposalDecisions?: Array<{
    proposalId: string;
    decision: "approve" | "reject";
  }>;
}

export interface ExecutiveService {
  beginHeartbeatCycle(
    reports: DepartmentReport[],
    candidateActions: ScheduledAction[],
    llm: LlmClient,
    errorContext?: ErrorContext,
    options?: { isDryRun?: boolean },
  ): Promise<HeartbeatCyclePlan>;
  resolveDepartment(actionType: ActionType): DepartmentName;
  recordDepartmentRun(params: {
    cycleId: string;
    department: DepartmentName;
    phase: string;
    status: "completed" | "failed";
    summary: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  completeHeartbeatCycle(
    cycleId: string,
    status: "completed" | "failed",
    summary: string,
  ): Promise<void>;
}

const STRATEGY_STATE_KEY = "heartbeat:global";

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

interface LlmExecutiveDecision {
  objective: unknown;
  funnelStage: unknown;
  approvedActionTypes: unknown;
  reasoning: unknown;
  departmentInstructions: unknown;
  contentGuidance?: unknown;
  policyUpdates?: unknown;
  proposalDecisions?: unknown;
}

function isHeartbeatObjective(v: unknown): v is HeartbeatObjective {
  return (
    v === "directive_assimilation" ||
    v === "funnel_expansion" ||
    v === "engagement_compounding"
  );
}

function isFunnelStage(v: unknown): v is FunnelStage {
  return (
    v === "bootstrap" ||
    v === "distribution" ||
    v === "conversion" ||
    v === "optimization"
  );
}

export class ExecutiveServiceImpl implements ExecutiveService {
  private loadCurrentPolicies(): StrategyPolicies {
    const existing = db
      .select()
      .from(strategyStates)
      .where(eq(strategyStates.key, STRATEGY_STATE_KEY))
      .get();
    if (existing) {
      try {
        const state = JSON.parse(
          existing.stateJson,
        ) as Partial<StrategyStateSnapshot>;
        if (state.policies) return state.policies;
      } catch {
        // parse failure, use defaults
      }
    }
    return { ...DEFAULT_POLICIES };
  }

  private saveStrategyHistory(
    cycleId: string,
    objective: HeartbeatObjective,
    funnelStage: FunnelStage,
    reasoning: string,
    departmentInstructions: Record<string, string>,
    strategy: StrategyStateSnapshot,
  ): void {
    db.insert(strategyHistory)
      .values({
        id: randomUUID(),
        cycleId,
        objective,
        funnelStage,
        reasoning,
        departmentInstructions:
          Object.keys(departmentInstructions).length > 0
            ? JSON.stringify(departmentInstructions)
            : null,
        stateJson: JSON.stringify(strategy),
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  private buildExecutivePrompt(
    reports: DepartmentReport[],
    candidateActions: ScheduledAction[],
    errorContext?: ErrorContext,
  ): string {
    const reportSection = reports
      .map((r) => {
        const headline = (r.summary ?? "").slice(0, 100);
        const metricsEntries =
          r.metrics && typeof r.metrics === "object"
            ? Object.entries(r.metrics as Record<string, unknown>)
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(0, 3)
            : [];
        const keyMetrics =
          metricsEntries.length > 0
            ? metricsEntries
                .map(
                  ([k, v]) =>
                    `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
                )
                .join(", ")
            : "なし";
        const status = (r.recommendation ?? "").slice(0, 50);
        return `### ${r.department}部\n- headline: ${headline}\n- keyMetrics: ${keyMetrics}\n- status: ${status}`;
      })
      .join("\n\n");

    const actionSection = candidateActions
      .map(
        (a, i) =>
          `${i + 1}. type="${a.type}" priority=${a.priority} reason="${a.reason}"`,
      )
      .join("\n");

    const recentHistory = db
      .select()
      .from(strategyHistory)
      .orderBy(desc(strategyHistory.createdAt))
      .limit(3)
      .all();

    const historySection =
      recentHistory.length > 0
        ? `## 過去の戦略判断（直近${recentHistory.length}回）\n${recentHistory.map((h, i) => `${i + 1}. objective=${h.objective}, funnelStage=${h.funnelStage}, 理由: ${(h.reasoning ?? "").slice(0, 400)}`).join("\n")}\n\n中長期的な方向性の一貫性を考慮してください。頻繁な方針転換は避け、根拠がない限り前回の方針を継続してください。\n\n`
        : "";

    return `あなたはThreadsOS運用の最高責任者（エグゼクティブ）です。
各部署から上がってきた状況レポートと、実行候補アクションを見て、
今回のハートビートで何を実行すべきかを判断してください。

## 判断原則
- 動く必要がない部署は動かさない（コスト削減）
- 部署の推奨を尊重しつつ、全体最適を考える
- note実績ゼロならnote生成を最優先（ファネル構築）
- 人間入力があれば最優先で処理
- 1回のハートビートで最大3アクションまで実行可能（予算制御で上限管理）
- 必ず「メイン改善1つ + 保全系（リサーチ/競合分析/エンゲージメント取得/通知）」の組合せで選べ
- 全12機能（Threads6+note6）を均等に回すこと。特定アクションだけ毎回選ぶのは禁止
- 24時間以上リサーチが止まっていたらリサーチを必ず含めること
- note公開実績が少なければgenerate_noteを優先すること
- 各部署のデータに基づいて根拠ある判断をする

## objectiveの選択肢
- "directive_assimilation": 人間の入力・指示を優先処理
- "funnel_expansion": コンテンツ生成・ファネル拡大を優先
- "engagement_compounding": エンゲージメント・コミュニティ対応を優先

## funnelStageの選択肢
- "bootstrap": 実績ゼロ、最初のコンテンツ作成が必要
- "distribution": コンテンツ配信フェーズ
- "conversion": 収益化・コンバージョンフェーズ
- "optimization": 最適化フェーズ

${historySection}## 各部署の状況レポート

${reportSection}

## 実行候補アクション

${actionSection}

## 運用ポリシー（現在の方針を更新する場合のみ記載）
brand: tone（professional/casual/bold/educational）、topicsToAvoid、topicsToEmphasize、contentGuards（strict/moderate/permissive）
growth: channelFocus（threads/note配列）、contentFrequency（aggressive/steady/conservative）、audienceStrategy（existing/adjacent/new）
monetization: priceStrategy（premium/standard/value）、conversionFocus（direct/nurture/educational）、revenueTarget（growth/maintain/experiment）

## 回答形式（JSONのみ）
{
  "objective": "directive_assimilation" | "funnel_expansion" | "engagement_compounding",
  "funnelStage": "bootstrap" | "distribution" | "conversion" | "optimization",
  "approvedActionTypes": ["main_action", "maintenance_action_1", "maintenance_action_2"],
  "reasoning": "判断理由を1-2文で",
  "departmentInstructions": {
    "department_name": "この部署への具体的指示"
  },
  "contentGuidance": {
    "topicsToEmphasize": ["強調すべきテーマ"],
    "topicsToAvoid": ["避けるべきテーマ"],
    "recommendedTone": "推奨トーン",
    "replyPolicy": "返信方針の指示"
  },
  "policyUpdates": {
    "brand": { ... },
    "growth": { ... },
    "monetization": { ... }
  },
  "proposalDecisions": [
    { "proposalId": "uuid", "decision": "approve" | "reject" }
  ]
}${errorContext ? this.buildErrorSection(errorContext) : ""}`;
  }

  private buildErrorSection(ctx: ErrorContext): string {
    const failureCount = ctx.recentFailures.length;
    const failureDetails =
      failureCount > 0
        ? ctx.recentFailures
            .slice(0, 3)
            .map(
              (f) =>
                `  - ${f.jobName}: ${(f.error ?? "").slice(0, 120)} (${f.at})`,
            )
            .join("\n") +
          (failureCount > 3 ? `\n  ...他 ${failureCount - 3} 件` : "")
        : "  なし";

    const proposalCount = ctx.pendingProposalSummaries?.length ?? 0;
    const proposalDetails =
      proposalCount > 0
        ? ctx.pendingProposalSummaries
            ?.slice(0, 3)
            .map(
              (p) =>
                `  - [${p.id}] ${p.actionType}: ${(p.reason ?? "").slice(0, 120)}`,
            )
            .join("\n") +
          (proposalCount > 3 ? `\n  ...他 ${proposalCount - 3} 件` : "")
        : "  なし";

    return `

## 直近のエラー状況
- 失敗ジョブ: ${failureCount}件 (代表${Math.min(failureCount, 3)}件)
${failureDetails}
- 未処理レビュー: ${ctx.pendingReviewCount}件
- 未処理プロポーザル: ${ctx.pendingProposalCount}件 (代表${Math.min(proposalCount, 3)}件)
${proposalDetails}
- 連続失敗数: ${ctx.consecutiveFailures}

エラーが存在する場合、以下の対処を検討せよ:
- 回復可能なエラー（一時的なAPI障害等）→ 該当アクションを再スケジュール
- pending レビューの自律判断 → 安全と判断できるものは自動承認
- pending プロポーザルの自律承認 → Executiveとして承認可能なものは承認

## プロポーザル判断
上記の未処理プロポーザルがある場合、proposalDecisionsフィールドで各プロポーザルに対して判断を返してください:
- "approve": 安全と判断し承認
- "reject": リスクがあるため却下`;
  }

  private collectPriorityTopics(): string[] {
    const topicMap = new Map(
      db
        .select()
        .from(topics)
        .where(eq(topics.status, "active"))
        .all()
        .map((topic) => [topic.id, topic.name] as const),
    );
    const draftTopicMap = new Map(
      db
        .select()
        .from(threadPostDrafts)
        .all()
        .map((draft) => [draft.id, draft.topicId] as const),
    );
    const scoredTopics = new Map<string, number>();

    const recentResults = db
      .select()
      .from(threadPostResults)
      .orderBy(desc(threadPostResults.publishedAt))
      .limit(20)
      .all();

    for (const result of recentResults) {
      const topicId = draftTopicMap.get(result.draftId);
      const topicName = topicId ? topicMap.get(topicId) : null;
      if (!topicName) continue;

      const current = scoredTopics.get(topicName) ?? 0;
      const nextScore =
        current +
        (result.likes + result.repliesCount + result.shares) /
          Math.max(result.impressions, 1);
      scoredTopics.set(topicName, nextScore);
    }

    const ranked = [...scoredTopics.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([topicName]) => topicName);

    if (ranked.length >= 3) return ranked.slice(0, 3);

    const fallback = db
      .select()
      .from(topics)
      .where(eq(topics.status, "active"))
      .orderBy(desc(topics.priorityScore))
      .limit(3)
      .all()
      .map((topic) => topic.name);

    return unique([...ranked, ...fallback]).slice(0, 3);
  }

  private collectInsightFocus(): string[] {
    return db
      .select()
      .from(improvementInsights)
      .orderBy(desc(improvementInsights.createdAt))
      .limit(6)
      .all()
      .map((insight) => insight.insight)
      .slice(0, 3);
  }

  private buildDirectives(actions: ScheduledAction[]): DepartmentDirective[] {
    const grouped = new Map<DepartmentName, ActionType[]>();
    for (const action of actions) {
      const department = this.resolveDepartment(action.type);
      const current = grouped.get(department) ?? [];
      current.push(action.type);
      grouped.set(department, current);
    }

    return [...grouped.entries()].map(([department, actionTypes]) => ({
      department,
      goal: `${department} 部署で ${actionTypes.length} 件の実行を継続する`,
      actionTypes: unique(actionTypes),
    }));
  }

  private buildFallbackPlan(
    candidateActions: ScheduledAction[],
    options?: {
      isDryRun?: boolean;
      fallbackReason?: string;
      anomalyCategory?: string;
      anomalyMessage?: string;
      anomalyMetadata?: Record<string, unknown>;
    },
  ): HeartbeatCyclePlan {
    // Spec §2 (絶対条件「迷ったら止める」) §20 (confidence 低 → 実行しない) に従い、
    // Executive LLM failure 時は何も実行しない。連続失敗時は anomalyEvents 経由で
    // operations-mode が safe_freeze に昇格させる。
    // dry-run 時は anomaly を記録しない（本番の安全判定を汚染しないため）。
    const cycleId = randomUUID();
    const fallbackReason =
      options?.fallbackReason ??
      "LLM response parse failed; safe-stop until next heartbeat (no actions executed)";
    const skipped = candidateActions.map((a) => ({
      action: a,
      reason: fallbackReason,
    }));

    if (!options?.isDryRun) {
      try {
        const ledger = createRuntimeLedgerRepository();
        ledger.recordAnomaly({
          category: options?.anomalyCategory ?? "executive_parse_failure",
          severity: "high",
          message:
            options?.anomalyMessage ??
            "Executive LLM parse failed; safe-stop applied. Connected anomalies feed operations-mode safe_freeze trigger.",
          metadata: {
            candidateCount: candidateActions.length,
            cycleId,
            ...(options?.anomalyMetadata ?? {}),
          },
        });
      } catch (anomalyErr) {
        logger.warn(
          {
            error:
              anomalyErr instanceof Error
                ? anomalyErr.message
                : String(anomalyErr),
          },
          "Failed to record executive fallback anomaly",
        );
      }
    }

    return {
      cycleId,
      strategyKey: STRATEGY_STATE_KEY,
      objective: "funnel_expansion",
      funnelStage: "bootstrap",
      approvedActions: [],
      skippedActions: skipped,
      directives: [],
      strategy: {
        objective: "funnel_expansion",
        funnelStage: "bootstrap",
        priorityTopics: [],
        pendingHumanInputs: 0,
        dueThreadSlots: 0,
        dueNoteSlots: 0,
        pendingReplies: 0,
        latestNoteCount: 0,
        insightFocus: [],
        activeActionTypes: [],
        policies: this.loadCurrentPolicies(),
      },
      llmReasoning: fallbackReason,
      departmentInstructions: {},
    };
  }

  private persistFallbackPlan(fallback: HeartbeatCyclePlan): void {
    const now = new Date().toISOString();
    db.insert(strategyStates)
      .values({
        key: STRATEGY_STATE_KEY,
        scope: "heartbeat",
        stateJson: JSON.stringify(fallback.strategy),
        summary: `${fallback.strategy.objective}:${fallback.strategy.funnelStage} — ${fallback.llmReasoning ?? ""}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: strategyStates.key,
        set: {
          scope: "heartbeat",
          stateJson: JSON.stringify(fallback.strategy),
          summary: `${fallback.strategy.objective}:${fallback.strategy.funnelStage} — ${fallback.llmReasoning ?? ""}`,
          updatedAt: now,
        },
      })
      .run();
    db.insert(executiveCycles)
      .values({
        id: fallback.cycleId,
        objective: fallback.objective,
        funnelStage: fallback.funnelStage,
        strategyKey: STRATEGY_STATE_KEY,
        status: "running",
        decisionJson: JSON.stringify({
          fallbackReason: fallback.llmReasoning,
          approvedActions: fallback.approvedActions,
          skippedActions: fallback.skippedActions,
        }),
        summary: null,
        startedAt: now,
        completedAt: null,
        createdAt: now,
      })
      .run();
    this.saveStrategyHistory(
      fallback.cycleId,
      fallback.objective,
      fallback.funnelStage,
      fallback.llmReasoning ?? "",
      {},
      fallback.strategy,
    );
  }

  async beginHeartbeatCycle(
    reports: DepartmentReport[],
    candidateActions: ScheduledAction[],
    llm: LlmClient,
    errorContext?: ErrorContext,
    options?: { isDryRun?: boolean },
  ): Promise<HeartbeatCyclePlan> {
    const prompt = this.buildExecutivePrompt(
      reports,
      candidateActions,
      errorContext,
    );

    let raw: string;
    try {
      raw = await llm.generate(prompt, {
        label: "executive-heartbeat-cycle",
        temperature: 0.3,
        systemPrompt:
          "You are an executive decision maker for an autonomous social media system. Return ONLY valid JSON.",
        tier: "standard",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { error: message },
        "Executive LLM request failed; safe-stop applied (no actions approved)",
      );
      const fallback = this.buildFallbackPlan(candidateActions, {
        isDryRun: options?.isDryRun,
        fallbackReason: `Executive LLM request failed (${message}); safe-stop until next heartbeat (no actions executed)`,
        anomalyCategory: "executive_runner_failure",
        anomalyMessage:
          "Executive LLM request failed; safe-stop applied. Connected anomalies feed operations-mode safe_freeze trigger.",
        anomalyMetadata: { error: message },
      });
      this.persistFallbackPlan(fallback);
      return fallback;
    }

    const decision = parseJsonObject<LlmExecutiveDecision>(raw);

    if (!decision) {
      logger.warn(
        { raw },
        "Executive LLM response parse failed; safe-stop applied (no actions approved)",
      );
      const fallback = this.buildFallbackPlan(candidateActions, {
        isDryRun: options?.isDryRun,
      });
      this.persistFallbackPlan(fallback);
      return fallback;
    }

    const rawApproved = Array.isArray(decision.approvedActionTypes)
      ? (decision.approvedActionTypes as string[])
      : [];
    const approvedActions = candidateActions
      .filter((a) => rawApproved.includes(a.type))
      .slice(0, 3);
    const rawReasoning =
      typeof decision.reasoning === "string" ? decision.reasoning : "";
    const rawInstructions =
      decision.departmentInstructions !== null &&
      typeof decision.departmentInstructions === "object" &&
      !Array.isArray(decision.departmentInstructions)
        ? (decision.departmentInstructions as Record<string, string>)
        : {};
    const skippedActions = candidateActions
      .filter((a) => !rawApproved.includes(a.type))
      .map((a) => ({
        action: a,
        reason: `Executive LLM deferred: ${rawReasoning}`,
      }));

    const cycleId = randomUUID();
    const now = new Date().toISOString();
    const directives = this.buildDirectives(approvedActions);

    const objective: HeartbeatObjective = isHeartbeatObjective(
      decision.objective,
    )
      ? decision.objective
      : "funnel_expansion";
    const funnelStage: FunnelStage = isFunnelStage(decision.funnelStage)
      ? decision.funnelStage
      : "bootstrap";

    // ── ポリシー更新の処理 ──
    const existingPolicies = this.loadCurrentPolicies();
    const rawPolicyUpdates =
      decision.policyUpdates &&
      typeof decision.policyUpdates === "object" &&
      !Array.isArray(decision.policyUpdates)
        ? (decision.policyUpdates as Partial<StrategyPolicies>)
        : undefined;
    const mergedPolicies: StrategyPolicies = {
      brand: { ...existingPolicies.brand, ...(rawPolicyUpdates?.brand ?? {}) },
      growth: {
        ...existingPolicies.growth,
        ...(rawPolicyUpdates?.growth ?? {}),
      },
      monetization: {
        ...existingPolicies.monetization,
        ...(rawPolicyUpdates?.monetization ?? {}),
      },
    };

    // ── プロポーザル判断の処理 ──
    const rawProposalDecisions = Array.isArray(decision.proposalDecisions)
      ? (
          decision.proposalDecisions as Array<{
            proposalId: string;
            decision: "approve" | "reject" | string;
          }>
        ).filter(
          (d): d is { proposalId: string; decision: "approve" | "reject" } =>
            d &&
            typeof d.proposalId === "string" &&
            (d.decision === "approve" || d.decision === "reject"),
        )
      : [];

    // ── コンテンツガイダンスの処理 ──
    const rawContentGuidance =
      decision.contentGuidance &&
      typeof decision.contentGuidance === "object" &&
      !Array.isArray(decision.contentGuidance)
        ? (decision.contentGuidance as ContentGuidance)
        : undefined;

    const strategy: StrategyStateSnapshot = {
      objective,
      funnelStage,
      priorityTopics: this.collectPriorityTopics(),
      pendingHumanInputs:
        reports.find((r) => r.department === "command")?.metrics
          .pendingInputs ?? 0,
      dueThreadSlots:
        reports.find((r) => r.department === "threads")?.metrics.dueSlots ?? 0,
      dueNoteSlots:
        reports.find((r) => r.department === "note")?.metrics.dueNoteSlots ?? 0,
      pendingReplies:
        reports.find((r) => r.department === "threads")?.metrics
          .pendingReplies ?? 0,
      latestNoteCount:
        reports.find((r) => r.department === "note")?.metrics.publishedNotes ??
        0,
      insightFocus: this.collectInsightFocus(),
      activeActionTypes: unique(approvedActions.map((a) => a.type)),
      policies: mergedPolicies,
    };

    db.insert(strategyStates)
      .values({
        key: STRATEGY_STATE_KEY,
        scope: "heartbeat",
        stateJson: JSON.stringify(strategy),
        summary: `${strategy.objective}:${strategy.funnelStage} — ${rawReasoning}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: strategyStates.key,
        set: {
          scope: "heartbeat",
          stateJson: JSON.stringify(strategy),
          summary: `${strategy.objective}:${strategy.funnelStage} — ${rawReasoning}`,
          updatedAt: now,
        },
      })
      .run();

    db.insert(executiveCycles)
      .values({
        id: cycleId,
        objective: strategy.objective,
        funnelStage: strategy.funnelStage,
        strategyKey: STRATEGY_STATE_KEY,
        status: "running",
        decisionJson: JSON.stringify({
          llmReasoning: rawReasoning,
          departmentInstructions: rawInstructions,
          departmentReports: reports,
          directives,
          candidateActions,
          approvedActions,
          skippedActions,
        }),
        summary: null,
        startedAt: now,
        completedAt: null,
        createdAt: now,
      })
      .run();

    this.saveStrategyHistory(
      cycleId,
      objective,
      funnelStage,
      rawReasoning,
      rawInstructions,
      strategy,
    );

    return {
      cycleId,
      strategyKey: STRATEGY_STATE_KEY,
      objective,
      funnelStage,
      approvedActions,
      skippedActions,
      directives,
      strategy,
      llmReasoning: rawReasoning,
      departmentInstructions: rawInstructions,
      contentGuidance: rawContentGuidance,
      policyUpdates: rawPolicyUpdates,
      proposalDecisions:
        rawProposalDecisions.length > 0 ? rawProposalDecisions : undefined,
    };
  }

  resolveDepartment(actionType: ActionType): DepartmentName {
    return resolveDepartmentName(actionType);
  }

  async recordDepartmentRun(params: {
    cycleId: string;
    department: DepartmentName;
    phase: string;
    status: "completed" | "failed";
    summary: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    db.insert(departmentRuns)
      .values({
        id: randomUUID(),
        cycleId: params.cycleId,
        department: params.department,
        phase: params.phase,
        status: params.status,
        summary: params.summary,
        payloadJson: params.payload ? JSON.stringify(params.payload) : null,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  async completeHeartbeatCycle(
    cycleId: string,
    status: "completed" | "failed",
    summary: string,
  ): Promise<void> {
    db.update(executiveCycles)
      .set({
        status,
        summary,
        completedAt: new Date().toISOString(),
      })
      .where(eq(executiveCycles.id, cycleId))
      .run();
  }
}
