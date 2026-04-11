import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contentSlots,
  humanInputs,
  noteDrafts,
  noteIdeas,
  notePostResults,
  outboundNotifications,
  replyDecisions,
  scheduledJobRuns,
  strategyStates,
  threadPostDrafts,
  threadPostResults,
  topics,
} from "../../db/schema.js";

const JST_TIME_ZONE = "Asia/Tokyo";

export type ContentSlot = typeof contentSlots.$inferSelect;

export type ActionType =
  | "process_human_inputs"
  | "research_threads"
  | "research_note"
  | "generate_and_post"
  | "fetch_engagement"
  | "reply_safe"
  | "generate_note"
  | "optimize_schedule"
  | "weekly_retro"
  | "notify";

export interface ScheduledAction {
  type: ActionType;
  priority: number;
  reason: string;
}

export interface ContentSchedulerService {
  decideActions(): Promise<ScheduledAction[]>;
  syncThreadSlotsFromAuditedDrafts(maxSlots?: number): Promise<number>;
  syncNoteSlotsFromAuditedDrafts(maxSlots?: number): Promise<number>;
  getNextThreadSlot(): Promise<ContentSlot | null>;
  getNextNoteSlot(): Promise<ContentSlot | null>;
  reserveSlot(slotId: string, draftId: string): Promise<boolean>;
  completeSlot(slotId: string): Promise<void>;
  skipSlot(slotId: string): Promise<void>;
}

const STRATEGY_STATE_KEY = "heartbeat:global";

type PersistedStrategyState = {
  objective?:
    | "directive_assimilation"
    | "funnel_expansion"
    | "engagement_compounding";
  funnelStage?: "bootstrap" | "distribution" | "conversion" | "optimization";
};

function getJstHour(date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: JST_TIME_ZONE,
      hour: "2-digit",
      hour12: false,
    }).format(date),
  );
}

function getJstDayOfWeek(date = new Date()): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: JST_TIME_ZONE,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

function hoursBetween(later: Date, earlierIso: string): number {
  const earlier = new Date(earlierIso);
  if (Number.isNaN(earlier.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nextJstPublicationTime(baseTime = new Date(), hour = 21): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(baseTime);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const candidate = new Date(
    `${year}-${month}-${day}T${String(hour).padStart(2, "0")}:00:00+09:00`,
  );
  if (candidate.getTime() <= baseTime.getTime()) {
    return new Date(candidate.getTime() + 86_400_000);
  }
  return candidate;
}

function loadPersistedStrategyState(): PersistedStrategyState | null {
  const row = db
    .select()
    .from(strategyStates)
    .where(eq(strategyStates.key, STRATEGY_STATE_KEY))
    .get();
  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.stateJson) as PersistedStrategyState;
  } catch {
    return null;
  }
}

function adjustPriority(priority: number, delta: number): number {
  return Math.max(1, priority + delta);
}

function applyStrategyBias(actions: ScheduledAction[]): ScheduledAction[] {
  const strategy = loadPersistedStrategyState();
  if (!strategy) {
    return actions;
  }

  return actions
    .map((action) => {
      let delta = 0;

      switch (strategy.objective) {
        case "directive_assimilation":
          if (action.type === "process_human_inputs") delta -= 2;
          if (
            action.type === "research_threads" ||
            action.type === "research_note"
          )
            delta -= 1;
          break;
        case "funnel_expansion":
          if (action.type === "generate_note") delta -= 2;
          if (action.type === "generate_and_post") delta -= 1;
          if (action.type === "research_note") delta -= 1;
          break;
        case "engagement_compounding":
          if (action.type === "fetch_engagement") delta -= 2;
          if (action.type === "reply_safe") delta -= 1;
          if (action.type === "optimize_schedule") delta -= 1;
          break;
      }

      switch (strategy.funnelStage) {
        case "bootstrap":
          if (
            action.type === "generate_and_post" ||
            action.type === "generate_note"
          ) {
            delta -= 1;
          }
          break;
        case "conversion":
          if (action.type === "generate_note") delta -= 1;
          break;
        case "optimization":
          if (
            action.type === "optimize_schedule" ||
            action.type === "weekly_retro"
          ) {
            delta -= 1;
          }
          break;
      }

      if (delta === 0) {
        return action;
      }

      return {
        ...action,
        priority: adjustPriority(action.priority, delta),
        reason: `${action.reason} [strategy:${strategy.objective}/${strategy.funnelStage}]`,
      };
    })
    .sort((left, right) => left.priority - right.priority);
}

export class ContentSchedulerServiceImpl implements ContentSchedulerService {
  private readonly maxPostsPerHour: number;
  private readonly maxPostsPerDay: number;

  constructor(
    maxPostsPerHour = readEnvInt("MAX_POSTS_PER_HOUR", 3),
    maxPostsPerDay = readEnvInt("MAX_POSTS_PER_DAY", 4),
  ) {
    this.maxPostsPerHour = maxPostsPerHour;
    this.maxPostsPerDay = maxPostsPerDay;
  }

  async decideActions(): Promise<ScheduledAction[]> {
    const actions: ScheduledAction[] = [];
    const now = new Date();
    const nowIso = now.toISOString();
    const jstHour = getJstHour(now);

    const pendingInputs = db
      .select()
      .from(humanInputs)
      .where(eq(humanInputs.processed, 0))
      .all();
    if (pendingInputs.length > 0) {
      actions.push({
        type: "process_human_inputs",
        priority: 1,
        reason: `${pendingInputs.length}件の未処理human_inputs`,
      });
    }

    if (jstHour % 2 === 0) {
      const lastNotification = db
        .select()
        .from(outboundNotifications)
        .where(eq(outboundNotifications.type, "progress"))
        .orderBy(desc(outboundNotifications.sentAt))
        .limit(1)
        .get();
      const notificationAge = lastNotification
        ? hoursBetween(now, lastNotification.sentAt)
        : Number.POSITIVE_INFINITY;
      if (notificationAge >= 1.5) {
        actions.push({
          type: "notify",
          priority: 2,
          reason: "2時間おき通知",
        });
      }
    }

    const pendingReplies = db
      .select()
      .from(replyDecisions)
      .where(
        and(
          eq(replyDecisions.decision, "safe_auto_reply"),
          isNull(replyDecisions.sentAt),
        ),
      )
      .all();
    if (pendingReplies.length > 0) {
      actions.push({
        type: "reply_safe",
        priority: 3,
        reason: `${pendingReplies.length}件のsafe返信待ち`,
      });
    }

    const dueThreadSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "threads"),
          eq(contentSlots.status, "pending"),
          lte(contentSlots.scheduledAt, nowIso),
        ),
      )
      .all();
    if (dueThreadSlots.length > 0) {
      actions.push({
        type: "generate_and_post",
        priority: 4,
        reason: `${dueThreadSlots.length}件のThreads投稿スロットが到達`,
      });
    } else {
      // ブートストラップ: トピックはあるがドラフト・スロットがない場合は初回生成をトリガー
      const activeTopics = db
        .select()
        .from(topics)
        .where(eq(topics.status, "active"))
        .limit(1)
        .get();
      if (activeTopics) {
        const anyAuditedDraft = db
          .select()
          .from(threadPostDrafts)
          .where(eq(threadPostDrafts.status, "audited"))
          .limit(1)
          .get();
        if (!anyAuditedDraft) {
          actions.push({
            type: "generate_and_post",
            priority: 4,
            reason:
              "ブートストラップ: トピックありauditedドラフトなし→生成再試行",
          });
        }
      }
    }

    const dueNoteSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "note"),
          eq(contentSlots.status, "pending"),
          lte(contentSlots.scheduledAt, nowIso),
        ),
      )
      .all();
    const pendingNoteSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "note"),
          eq(contentSlots.status, "pending"),
        ),
      )
      .all();
    const lastNoteJob = db
      .select()
      .from(scheduledJobRuns)
      .where(
        and(
          eq(scheduledJobRuns.jobName, "nightly-note-pipeline"),
          eq(scheduledJobRuns.status, "completed"),
        ),
      )
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(1)
      .get();
    const noteJobAge = lastNoteJob
      ? hoursBetween(now, lastNoteJob.startedAt)
      : Number.POSITIVE_INFINITY;
    const recentNoteResults = db
      .select()
      .from(notePostResults)
      .orderBy(desc(notePostResults.publishedAt))
      .limit(1)
      .all();
    const needsNoteBootstrap =
      recentNoteResults.length === 0 && pendingNoteSlots.length === 0;
    const shouldGenerateNote =
      dueNoteSlots.length > 0 || needsNoteBootstrap || noteJobAge >= 24;
    if (shouldGenerateNote) {
      actions.push({
        type: "generate_note",
        priority: 5,
        reason:
          dueNoteSlots.length > 0
            ? `${dueNoteSlots.length}件のnoteスロットが到達`
            : needsNoteBootstrap
              ? "ブートストラップ: note公開実績もslotもないため生成を再開"
              : noteJobAge >= 24
                ? `前回noteパイプラインから${Math.floor(noteJobAge)}時間経過`
                : "noteの日次公開タイミング",
      });
    }

    const recentPosts = db
      .select()
      .from(threadPostResults)
      .orderBy(desc(threadPostResults.publishedAt))
      .limit(10)
      .all();
    const needsEngagement = recentPosts.some((post) => {
      const age = hoursBetween(now, post.publishedAt);
      return age >= 1 && age <= 48;
    });
    if (needsEngagement) {
      actions.push({
        type: "fetch_engagement",
        priority: 6,
        reason: "直近投稿のエンゲージメント追跡",
      });
    }

    const lastThreadResearchJob = db
      .select()
      .from(scheduledJobRuns)
      .where(
        and(
          eq(scheduledJobRuns.jobName, "daily-topic-research"),
          eq(scheduledJobRuns.status, "completed"),
        ),
      )
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(1)
      .get();
    const threadResearchAge = lastThreadResearchJob
      ? hoursBetween(now, lastThreadResearchJob.startedAt)
      : Number.POSITIVE_INFINITY;
    if (threadResearchAge >= 24) {
      actions.push({
        type: "research_threads",
        priority: 7,
        reason: `前回Threadsリサーチから${Math.floor(threadResearchAge)}時間経過`,
      });
    }

    const lastNoteResearchJob = db
      .select()
      .from(scheduledJobRuns)
      .where(
        and(
          eq(scheduledJobRuns.jobName, "note-competitor-research"),
          eq(scheduledJobRuns.status, "completed"),
        ),
      )
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(1)
      .get();
    const noteResearchAge = lastNoteResearchJob
      ? hoursBetween(now, lastNoteResearchJob.startedAt)
      : Number.POSITIVE_INFINITY;
    if (noteResearchAge >= 24) {
      actions.push({
        type: "research_note",
        priority: 8,
        reason: `前回noteリサーチから${Math.floor(noteResearchAge)}時間経過`,
      });
    }

    if (jstHour === 0 || jstHour === 1) {
      actions.push({
        type: "optimize_schedule",
        priority: 10,
        reason: "日次スケジュール最適化",
      });

      const dayOfWeek = getJstDayOfWeek(now);
      if (dayOfWeek === 1) {
        const lastRetroJob = db
          .select()
          .from(scheduledJobRuns)
          .where(
            and(
              eq(scheduledJobRuns.jobName, "weekly-retro"),
              eq(scheduledJobRuns.status, "completed"),
            ),
          )
          .orderBy(desc(scheduledJobRuns.startedAt))
          .limit(1)
          .get();
        const retroJobAge = lastRetroJob
          ? hoursBetween(now, lastRetroJob.startedAt)
          : Number.POSITIVE_INFINITY;
        if (retroJobAge >= 144) {
          actions.push({
            type: "weekly_retro",
            priority: 9,
            reason: `前回Weekly Retroから${Math.floor(retroJobAge)}時間経過`,
          });
        }
      }
    }

    return applyStrategyBias(actions);
  }

  async syncThreadSlotsFromAuditedDrafts(
    maxSlots = this.maxPostsPerHour,
  ): Promise<number> {
    if (maxSlots <= 0) {
      return 0;
    }

    const baseTime = new Date();
    const now = baseTime.toISOString();

    // 日次上限チェック: 今日すでにスケジュール済みのスロット数を確認
    const jstParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: JST_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(baseTime);
    const todayJst = `${jstParts.find((p) => p.type === "year")?.value}-${jstParts.find((p) => p.type === "month")?.value}-${jstParts.find((p) => p.type === "day")?.value}`;
    const todayStartUtc = new Date(`${todayJst}T00:00:00+09:00`).toISOString();
    const todayEndUtc = new Date(`${todayJst}T23:59:59+09:00`).toISOString();

    const todaySlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "threads"),
          gte(contentSlots.scheduledAt, todayStartUtc),
          lte(contentSlots.scheduledAt, todayEndUtc),
        ),
      )
      .all()
      .filter((s) => s.status !== "skipped");

    const remainingToday = this.maxPostsPerDay - todaySlots.length;
    if (remainingToday <= 0) {
      return 0;
    }
    maxSlots = Math.min(maxSlots, remainingToday);
    const topicPriority = new Map(
      db
        .select()
        .from(topics)
        .all()
        .map((topic) => [topic.id, topic.priorityScore] as const),
    );
    const existingDraftIds = new Set(
      db
        .select()
        .from(contentSlots)
        .where(eq(contentSlots.channel, "threads"))
        .all()
        .map((slot) => slot.draftId)
        .filter((draftId): draftId is string => Boolean(draftId)),
    );
    const auditedDrafts = db
      .select()
      .from(threadPostDrafts)
      .where(eq(threadPostDrafts.status, "audited"))
      .all();

    let inserted = 0;
    for (const draft of auditedDrafts) {
      if (inserted >= maxSlots) {
        break;
      }
      if (existingDraftIds.has(draft.id)) {
        continue;
      }

      db.insert(contentSlots)
        .values({
          id: randomUUID(),
          channel: "threads",
          scheduledAt: new Date(
            baseTime.getTime() + (inserted + 1) * 3_600_000,
          ).toISOString(),
          topicId: draft.topicId,
          draftId: draft.id,
          status: "pending",
          priority: topicPriority.get(draft.topicId) ?? 5,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      existingDraftIds.add(draft.id);
      inserted++;
    }

    return inserted;
  }

  async syncNoteSlotsFromAuditedDrafts(maxSlots = 1): Promise<number> {
    if (maxSlots <= 0) {
      return 0;
    }

    const baseTime = new Date();
    const now = baseTime.toISOString();
    const slotBase = nextJstPublicationTime(baseTime, 21);
    const existingDraftIds = new Set(
      db
        .select()
        .from(contentSlots)
        .where(eq(contentSlots.channel, "note"))
        .all()
        .map((slot) => slot.draftId)
        .filter((draftId): draftId is string => Boolean(draftId)),
    );
    const publishedDraftIds = new Set(
      db
        .select()
        .from(notePostResults)
        .all()
        .map((result) => result.draftId),
    );
    const ideaMeta = new Map(
      db
        .select()
        .from(noteIdeas)
        .all()
        .map(
          (idea) =>
            [
              idea.id,
              { topicId: idea.sourceTopicId, priority: idea.priorityScore },
            ] as const,
        ),
    );
    const auditedDrafts = db
      .select()
      .from(noteDrafts)
      .where(eq(noteDrafts.status, "audited"))
      .all()
      .filter((draft) => (draft.publishReadinessScore ?? 0) >= 7);

    let inserted = 0;
    for (const draft of auditedDrafts) {
      if (inserted >= maxSlots) {
        break;
      }
      if (existingDraftIds.has(draft.id) || publishedDraftIds.has(draft.id)) {
        continue;
      }

      const idea = ideaMeta.get(draft.ideaId);
      db.insert(contentSlots)
        .values({
          id: randomUUID(),
          channel: "note",
          scheduledAt: new Date(
            slotBase.getTime() + inserted * 86_400_000,
          ).toISOString(),
          topicId: idea?.topicId ?? null,
          draftId: draft.id,
          status: "pending",
          priority: idea?.priority ?? 5,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      existingDraftIds.add(draft.id);
      inserted++;
    }

    return inserted;
  }

  async getNextThreadSlot(): Promise<ContentSlot | null> {
    const row = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "threads"),
          eq(contentSlots.status, "pending"),
        ),
      )
      .orderBy(desc(contentSlots.priority), contentSlots.scheduledAt)
      .limit(1)
      .get();
    return row ?? null;
  }

  async getNextNoteSlot(): Promise<ContentSlot | null> {
    const row = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "note"),
          eq(contentSlots.status, "pending"),
        ),
      )
      .orderBy(desc(contentSlots.priority), contentSlots.scheduledAt)
      .limit(1)
      .get();
    return row ?? null;
  }

  async reserveSlot(slotId: string, draftId: string): Promise<boolean> {
    const result = db
      .update(contentSlots)
      .set({
        draftId,
        status: "reserved",
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(contentSlots.id, slotId), eq(contentSlots.status, "pending")),
      )
      .run();
    return result.changes > 0;
  }

  async completeSlot(slotId: string): Promise<void> {
    db.update(contentSlots)
      .set({
        status: "published",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contentSlots.id, slotId))
      .run();
  }

  async skipSlot(slotId: string): Promise<void> {
    db.update(contentSlots)
      .set({
        status: "skipped",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contentSlots.id, slotId))
      .run();
  }
}
