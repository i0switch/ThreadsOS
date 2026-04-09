import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contentSlots,
  departmentRuns,
  executiveCycles,
  humanInputs,
  improvementInsights,
  notePostResults,
  replyDecisions,
  strategyStates,
  threadPostDrafts,
  threadPostResults,
  topics,
} from "../../db/schema.js";
import {
  type DepartmentDirective,
  type DepartmentName,
  type FunnelStage,
  type HeartbeatObjective,
  resolveDepartmentName,
} from "../../domain/department/index.js";
import type {
  ActionType,
  ScheduledAction,
} from "../content-scheduler/index.js";

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
}

export interface ExecutiveService {
  beginHeartbeatCycle(actions: ScheduledAction[]): Promise<HeartbeatCyclePlan>;
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

const MAX_ACTIONS_PER_CYCLE: Record<HeartbeatObjective, number> = {
  directive_assimilation: 2,
  engagement_compounding: 2,
  funnel_expansion: 3,
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

type PlannedAction = {
  action: ScheduledAction;
  index: number;
};

type ActionSelectionResult = {
  approvedActions: ScheduledAction[];
  skippedActions: Array<{ action: ScheduledAction; reason: string }>;
};

export class ExecutiveServiceImpl implements ExecutiveService {
  private selectActionPlan(
    actions: ScheduledAction[],
    strategy: StrategyStateSnapshot,
  ): ActionSelectionResult {
    const plannedActions = actions
      .map((action, index) => ({ action, index }))
      .sort((left, right) => {
        if (left.action.priority !== right.action.priority) {
          return left.action.priority - right.action.priority;
        }
        return left.index - right.index;
      });
    const approved = new Set<number>();
    const skipped = new Map<number, string>();
    const maxActions = MAX_ACTIONS_PER_CYCLE[strategy.objective];

    const findFirst = (types: ActionType[]): PlannedAction | undefined =>
      plannedActions.find(
        (planned) =>
          !approved.has(planned.index) &&
          !skipped.has(planned.index) &&
          types.includes(planned.action.type),
      );

    const approve = (planned: PlannedAction | undefined): boolean => {
      if (!planned || approved.size >= maxActions) {
        return false;
      }
      approved.add(planned.index);
      return true;
    };

    const skipMatching = (types: ActionType[], reason: string): void => {
      for (const planned of plannedActions) {
        if (
          approved.has(planned.index) ||
          skipped.has(planned.index) ||
          !types.includes(planned.action.type)
        ) {
          continue;
        }
        skipped.set(planned.index, reason);
      }
    };

    const chooseGrowthPrimary = (): PlannedAction | undefined => {
      if (strategy.dueNoteSlots > 0 || strategy.latestNoteCount === 0) {
        return findFirst(["generate_note"]);
      }

      if (strategy.dueThreadSlots > 0) {
        return findFirst(["generate_and_post"]);
      }

      return findFirst([
        "generate_note",
        "generate_and_post",
        "research_threads",
        "research_note",
      ]);
    };

    approve(findFirst(["process_human_inputs"]));

    switch (strategy.objective) {
      case "directive_assimilation": {
        approve(findFirst(["reply_safe"]));
        skipMatching(
          [
            "generate_note",
            "generate_and_post",
            "research_threads",
            "research_note",
            "fetch_engagement",
            "optimize_schedule",
            "weekly_retro",
          ],
          "executive deferred while assimilating pending directives",
        );
        break;
      }
      case "engagement_compounding": {
        approve(findFirst(["fetch_engagement"]));
        approve(findFirst(["reply_safe"]));
        skipMatching(
          [
            "generate_note",
            "generate_and_post",
            "research_threads",
            "research_note",
            "optimize_schedule",
            "weekly_retro",
          ],
          "executive deferred to prioritize engagement follow-up",
        );
        break;
      }
      case "funnel_expansion": {
        const primary = chooseGrowthPrimary();
        const approvedPrimary = approve(primary);

        if (approvedPrimary) {
          if (primary?.action.type === "generate_note") {
            skipMatching(
              ["generate_and_post"],
              "executive deferred threads generation in favor of note expansion",
            );
          }
          if (primary?.action.type === "generate_and_post") {
            skipMatching(
              ["generate_note"],
              "executive deferred note generation in favor of threads expansion",
            );
          }
          skipMatching(
            ["research_threads", "research_note"],
            "executive deferred research because a primary growth action is already scheduled",
          );
        } else {
          approve(findFirst(["research_threads", "research_note"]));
        }

        approve(findFirst(["reply_safe"]));
        skipMatching(
          ["fetch_engagement", "optimize_schedule", "weekly_retro"],
          "executive deferred non-growth work to keep the heartbeat focused",
        );
        break;
      }
    }

    if (approved.size < maxActions) {
      approve(findFirst(["weekly_retro", "optimize_schedule"]));
    }

    if (approved.size < maxActions) {
      approve(findFirst(["notify"]));
    }

    for (const planned of plannedActions) {
      if (approved.has(planned.index) || skipped.has(planned.index)) {
        continue;
      }
      skipped.set(
        planned.index,
        "executive deferred to keep the heartbeat within budget",
      );
    }

    return {
      approvedActions: plannedActions
        .filter((planned) => approved.has(planned.index))
        .map((planned) => planned.action),
      skippedActions: plannedActions
        .filter((planned) => skipped.has(planned.index))
        .map((planned) => ({
          action: planned.action,
          reason:
            skipped.get(planned.index) ??
            "executive deferred to keep the heartbeat within budget",
        })),
    };
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
      if (!topicName) {
        continue;
      }

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

    if (ranked.length >= 3) {
      return ranked.slice(0, 3);
    }

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

  private deriveObjective(context: {
    pendingHumanInputs: number;
    dueNoteSlots: number;
    latestNoteCount: number;
    pendingReplies: number;
  }): HeartbeatObjective {
    if (context.pendingHumanInputs > 0) {
      return "directive_assimilation";
    }
    if (context.dueNoteSlots > 0 || context.latestNoteCount === 0) {
      return "funnel_expansion";
    }
    if (context.pendingReplies > 0) {
      return "engagement_compounding";
    }
    return "funnel_expansion";
  }

  private deriveFunnelStage(context: {
    latestNoteCount: number;
    dueNoteSlots: number;
    dueThreadSlots: number;
  }): FunnelStage {
    if (context.latestNoteCount === 0) {
      return "bootstrap";
    }
    if (context.dueNoteSlots > 0) {
      return "conversion";
    }
    if (context.dueThreadSlots > 0) {
      return "distribution";
    }
    return "optimization";
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

  async beginHeartbeatCycle(
    actions: ScheduledAction[],
  ): Promise<HeartbeatCyclePlan> {
    const now = new Date().toISOString();
    const dueThreadSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "threads"),
          eq(contentSlots.status, "pending"),
          lte(contentSlots.scheduledAt, now),
        ),
      )
      .all().length;
    const dueNoteSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "note"),
          eq(contentSlots.status, "pending"),
          lte(contentSlots.scheduledAt, now),
        ),
      )
      .all().length;
    const pendingHumanInputs = db
      .select()
      .from(humanInputs)
      .where(eq(humanInputs.processed, 0))
      .all().length;
    const pendingReplies = db
      .select()
      .from(replyDecisions)
      .where(
        and(
          eq(replyDecisions.decision, "safe_auto_reply"),
          isNull(replyDecisions.sentAt),
        ),
      )
      .all().length;
    const latestNoteCount = db
      .select()
      .from(notePostResults)
      .orderBy(desc(notePostResults.publishedAt))
      .limit(20)
      .all().length;

    const baseStrategy: StrategyStateSnapshot = {
      objective: this.deriveObjective({
        pendingHumanInputs,
        dueNoteSlots,
        latestNoteCount,
        pendingReplies,
      }),
      funnelStage: this.deriveFunnelStage({
        latestNoteCount,
        dueNoteSlots,
        dueThreadSlots,
      }),
      priorityTopics: this.collectPriorityTopics(),
      pendingHumanInputs,
      dueThreadSlots,
      dueNoteSlots,
      pendingReplies,
      latestNoteCount,
      insightFocus: this.collectInsightFocus(),
      activeActionTypes: [],
    };
    const { approvedActions, skippedActions } = this.selectActionPlan(
      actions,
      baseStrategy,
    );
    const strategy: StrategyStateSnapshot = {
      ...baseStrategy,
      activeActionTypes: unique(approvedActions.map((action) => action.type)),
    };
    const cycleId = randomUUID();
    const directives = this.buildDirectives(approvedActions);

    db.insert(strategyStates)
      .values({
        key: STRATEGY_STATE_KEY,
        scope: "heartbeat",
        stateJson: JSON.stringify(strategy),
        summary: `${strategy.objective}:${strategy.funnelStage}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: strategyStates.key,
        set: {
          scope: "heartbeat",
          stateJson: JSON.stringify(strategy),
          summary: `${strategy.objective}:${strategy.funnelStage}`,
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
          directives,
          candidateActions: actions,
          approvedActions,
          skippedActions,
        }),
        summary: null,
        startedAt: now,
        completedAt: null,
        createdAt: now,
      })
      .run();

    return {
      cycleId,
      strategyKey: STRATEGY_STATE_KEY,
      objective: strategy.objective,
      funnelStage: strategy.funnelStage,
      approvedActions,
      skippedActions,
      directives,
      strategy,
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
