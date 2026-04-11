import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
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
import type {
  ActionType,
  ScheduledAction,
} from "../content-scheduler/index.js";
import { parseJsonObject } from "../../utils/llm-json.js";

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
}

export interface ExecutiveService {
  beginHeartbeatCycle(
    reports: DepartmentReport[],
    candidateActions: ScheduledAction[],
    llm: LlmClient,
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
        departmentInstructions: Object.keys(departmentInstructions).length > 0
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
  ): string {
    const reportSection = reports
      .map(
        (r) =>
          `### ${r.department}部\n- 状況: ${r.summary}\n- 数値: ${JSON.stringify(r.metrics)}\n- 推奨: ${r.recommendation}\n- 最終実行: ${r.lastExecutedAt ?? "なし"}`,
      )
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
      .limit(5)
      .all();

    const historySection = recentHistory.length > 0
      ? `## 過去の戦略判断（直近${recentHistory.length}回）\n${recentHistory.map((h, i) => `${i + 1}. objective=${h.objective}, funnelStage=${h.funnelStage}, 理由: ${h.reasoning}`).join("\n")}\n\n中長期的な方向性の一貫性を考慮してください。頻繁な方針転換は避け、根拠がない限り前回の方針を継続してください。\n\n`
      : "";

    return `あなたはThreadsOS運用の最高責任者（エグゼクティブ）です。
各部署から上がってきた状況レポートと、実行候補アクションを見て、
今回のハートビートで何を実行すべきかを判断してください。

## 判断原則
- 動く必要がない部署は動かさない（コスト削減）
- 部署の推奨を尊重しつつ、全体最適を考える
- note実績ゼロならnote生成を最優先（ファネル構築）
- 人間入力があれば最優先で処理
- 1回のハートビートで最大3アクションまで
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

## 回答形式（JSONのみ）
{
  "objective": "directive_assimilation" | "funnel_expansion" | "engagement_compounding",
  "funnelStage": "bootstrap" | "distribution" | "conversion" | "optimization",
  "approvedActionTypes": ["action_type_1", "action_type_2"],
  "reasoning": "判断理由を1-2文で",
  "departmentInstructions": {
    "department_name": "この部署への具体的指示"
  }
}`;
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
  ): HeartbeatCyclePlan {
    const cycleId = randomUUID();
    const limited = candidateActions.slice(0, 3);
    const fallbackReason =
      "LLM response parse failed; fallback: up to 3 candidate actions approved";
    const skipped = candidateActions.slice(3).map((a) => ({
      action: a,
      reason: fallbackReason,
    }));
    return {
      cycleId,
      strategyKey: STRATEGY_STATE_KEY,
      objective: "funnel_expansion",
      funnelStage: "bootstrap",
      approvedActions: limited,
      skippedActions: skipped,
      directives: this.buildDirectives(limited),
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
        activeActionTypes: limited.map((a) => a.type),
      },
      llmReasoning: fallbackReason,
      departmentInstructions: {},
    };
  }

  async beginHeartbeatCycle(
    reports: DepartmentReport[],
    candidateActions: ScheduledAction[],
    llm: LlmClient,
  ): Promise<HeartbeatCyclePlan> {
    const prompt = this.buildExecutivePrompt(reports, candidateActions);

    const raw = await llm.generate(prompt, {
      temperature: 0.3,
      systemPrompt:
        "You are an executive decision maker for an autonomous social media system. Return ONLY valid JSON.",
      tier: "standard",
    });

    const decision = parseJsonObject<LlmExecutiveDecision>(raw);

    if (!decision) {
      logger.warn(
        { raw },
        "Executive LLM response parse failed, falling back to approving all candidates",
      );
      const fallback = this.buildFallbackPlan(candidateActions);
      const fbNow = new Date().toISOString();
      db.insert(strategyStates)
        .values({
          key: STRATEGY_STATE_KEY,
          scope: "heartbeat",
          stateJson: JSON.stringify(fallback.strategy),
          summary: `${fallback.strategy.objective}:${fallback.strategy.funnelStage} — ${fallback.llmReasoning ?? ""}`,
          createdAt: fbNow,
          updatedAt: fbNow,
        })
        .onConflictDoUpdate({
          target: strategyStates.key,
          set: {
            scope: "heartbeat",
            stateJson: JSON.stringify(fallback.strategy),
            summary: `${fallback.strategy.objective}:${fallback.strategy.funnelStage} — ${fallback.llmReasoning ?? ""}`,
            updatedAt: fbNow,
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
          startedAt: fbNow,
          completedAt: null,
          createdAt: fbNow,
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
      return fallback;
    }

    const rawApproved = Array.isArray(decision.approvedActionTypes)
      ? (decision.approvedActionTypes as string[])
      : [];
    const approvedActions = candidateActions.filter((a) =>
      rawApproved.includes(a.type),
    );
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

    const objective: HeartbeatObjective = isHeartbeatObjective(decision.objective)
      ? decision.objective
      : "funnel_expansion";
    const funnelStage: FunnelStage = isFunnelStage(decision.funnelStage)
      ? decision.funnelStage
      : "bootstrap";

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
