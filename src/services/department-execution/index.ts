import { randomUUID } from "node:crypto";
import type { LlmClient } from "../../adapters/llm/index.js";
import type { NoteApiClient } from "../../adapters/note-api/index.js";
import type { StorageClient } from "../../adapters/storage/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contentSlots,
  departmentRuns,
  departmentSummaries,
  humanInputs,
  noteDrafts,
  notePostResults,
  replyDecisions,
  threadPostDrafts,
  threadPostResults,
  thumbnailTasks,
  topics,
} from "../../db/schema.js";
import type {
  DepartmentExecutionResult,
  DepartmentExecutor,
  DepartmentName,
  DepartmentReport,
} from "../../domain/department/index.js";
import { resolveDepartmentName } from "../../domain/department/index.js";
import type {
  AutoPublisherService,
  PublishResult,
} from "../auto-publisher/index.js";
import type { CadenceOptimizerService } from "../cadence-optimizer/index.js";
import type {
  ActionType,
  ContentSchedulerService,
  ScheduledAction,
} from "../content-scheduler/index.js";
import type { NoteEngagementAnalysisService } from "../note-engagement-analysis/index.js";
import type { NotificationService } from "../notification/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { ReplyExecutionService } from "../reply-execution/index.js";
import type { RuntimeStateService } from "../runtime-state/index.js";

type TrackedSubJobRunner = (
  jobName: string,
  task: () => Promise<string>,
  stuckThresholdMinutes?: number,
) => Promise<string>;

export interface DepartmentExecutionDependencies {
  dryRun: boolean;
  maxPostsPerHour: number;
  llm: LlmClient;
  storage: StorageClient;
  threadsApi: ThreadsApiClient;
  orchestration: OrchestrationService;
  scheduler: ContentSchedulerService;
  autoPublisher: AutoPublisherService;
  optimizer: CadenceOptimizerService;
  replyExecution: ReplyExecutionService;
  noteEngagement: NoteEngagementAnalysisService;
  notification: NotificationService;
  runTrackedSubJob: TrackedSubJobRunner;
  createNoteApiClient: () => NoteApiClient;
  runtimeState: RuntimeStateService;
}

function createResult(
  action: ScheduledAction,
  summary: string,
  payload?: Record<string, unknown>,
): DepartmentExecutionResult {
  return {
    department: resolveDepartmentName(action.type),
    phase: action.type,
    status: "completed",
    summary,
    payload,
  };
}

function joinSummary(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

async function createNoteThumbnailTasks(
  notification: NotificationService,
  noteResults: PublishResult[],
): Promise<void> {
  for (const published of noteResults) {
    db.insert(thumbnailTasks)
      .values({
        id: randomUUID(),
        noteDraftId: published.draftId ?? published.id,
        status: "pending",
        instruction: `note公開済み。サムネを設定して: ${published.url}`,
        createdAt: new Date().toISOString(),
        completedAt: null,
      })
      .run();
    await notification.sendNotification({
      type: "action_needed",
      message: `note公開済み。サムネ設定して: ${published.url}`,
    });
  }
}

function supportsAction(actionTypes: ActionType[], actionType: ActionType) {
  return actionTypes.includes(actionType);
}

export class DepartmentExecutionServiceImpl {
  private readonly executors: DepartmentExecutor[];

  constructor(private readonly deps: DepartmentExecutionDependencies) {
    this.executors = [
      this.createCommandExecutor(),
      this.createResearchExecutor(),
      this.createThreadsExecutor(),
      this.createNoteExecutor(),
      this.createCommunityExecutor(),
      this.createOptimizationExecutor(),
    ];
  }

  collectReports(): DepartmentReport[] {
    return this.executors.map((executor) => executor.report());
  }

  private getLastRun(department: DepartmentName): string | null {
    const last = db
      .select()
      .from(departmentRuns)
      .where(eq(departmentRuns.department, department))
      .orderBy(desc(departmentRuns.createdAt))
      .limit(1)
      .get();
    return last?.createdAt ?? null;
  }

  private getLatestDepartmentSummary(department: DepartmentName): string | null {
    const row = db
      .select()
      .from(departmentSummaries)
      .where(eq(departmentSummaries.department, department))
      .orderBy(desc(departmentSummaries.updatedAt))
      .limit(1)
      .get();
    return row?.content ?? null;
  }

  async execute(action: ScheduledAction): Promise<DepartmentExecutionResult> {
    const executor = this.executors.find((candidate) =>
      candidate.supports(action.type),
    );
    if (!executor) {
      throw new Error(`No department executor registered for ${action.type}`);
    }

    return executor.execute({ action, dryRun: this.deps.dryRun });
  }

  private createCommandExecutor(): DepartmentExecutor {
    return {
      department: "command",
      supports: (actionType) => actionType === "process_human_inputs",
      report: (): DepartmentReport => {
        const pending = db
          .select()
          .from(humanInputs)
          .where(eq(humanInputs.processed, 0))
          .all();
        const currentState = this.getLatestDepartmentSummary("command");
        const liveSummary =
          pending.length > 0
            ? `未処理の人間入力が${pending.length}件あり。優先処理推奨`
            : "未処理の人間入力なし。待機中";
        return {
          department: "command",
          summary: currentState
            ? `${liveSummary}\n※前回の状態: ${currentState}`
            : liveSummary,
          metrics: { pendingInputs: pending.length },
          recommendation:
            pending.length > 0
              ? "process_human_inputs を実行すべき"
              : "動く必要なし",
          lastExecutedAt: this.getLastRun("command"),
        };
      },
      execute: async ({ action }) => {
        const summary = await this.deps.orchestration.processHumanInputs(
          this.deps.llm,
          this.deps.storage,
        );
        return createResult(action, summary);
      },
    };
  }

  private createResearchExecutor(): DepartmentExecutor {
    return {
      department: "research",
      supports: (actionType) =>
        supportsAction(["research_threads", "research_note"], actionType),
      report: (): DepartmentReport => {
        const lastResearch = db
          .select()
          .from(departmentRuns)
          .where(eq(departmentRuns.department, "research"))
          .orderBy(desc(departmentRuns.createdAt))
          .limit(1)
          .get();
        const hoursSince = lastResearch
          ? (Date.now() - new Date(lastResearch.createdAt).getTime()) /
            3_600_000
          : Infinity;
        const activeTopics = db
          .select()
          .from(topics)
          .where(eq(topics.status, "active"))
          .all().length;
        const researchCurrentState = this.getLatestDepartmentSummary("research");
        const researchLiveSummary =
          hoursSince > 24
            ? `最終リサーチから${Math.floor(hoursSince)}時間経過。更新推奨`
            : `最終リサーチから${Math.floor(hoursSince)}時間。まだ新鮮`;
        return {
          department: "research",
          summary: researchCurrentState
            ? `${researchLiveSummary}\n※前回の状態: ${researchCurrentState}`
            : researchLiveSummary,
          metrics: {
            hoursSinceLastResearch: Math.floor(hoursSince),
            activeTopics,
          },
          recommendation:
            hoursSince > 24 ? "リサーチ更新推奨" : "動く必要なし",
          lastExecutedAt: lastResearch?.createdAt ?? null,
        };
      },
      execute: async ({ action }) => {
        if (action.type === "research_threads") {
          const summary = await this.runAgentSubtask(
            "threads-competitor-researcher",
            "Threads競合と外部トレンドを整理",
            () =>
              this.deps.runTrackedSubJob("daily-topic-research", () =>
                this.deps.orchestration.runDailyTopicResearch(
                  this.deps.llm,
                  this.deps.storage,
                  this.deps.dryRun,
                ),
              ),
          );
          return createResult(action, summary);
        }

        const summary = await this.runAgentSubtask(
          "note-competitor-researcher",
          "note競合と売れ筋を整理",
          () =>
            this.deps.runTrackedSubJob("note-competitor-research", () =>
              this.deps.orchestration.runNoteResearch(
                this.deps.llm,
                this.deps.storage,
                this.deps.dryRun,
              ),
            ),
        );
        return createResult(action, summary);
      },
    };
  }

  private createThreadsExecutor(): DepartmentExecutor {
    return {
      department: "threads",
      supports: (actionType) => actionType === "generate_and_post",
      report: (): DepartmentReport => {
        const pendingDrafts = db
          .select()
          .from(threadPostDrafts)
          .where(eq(threadPostDrafts.status, "approved"))
          .all().length;
        const dueSlots = db
          .select()
          .from(contentSlots)
          .where(
            and(
              eq(contentSlots.channel, "threads"),
              eq(contentSlots.status, "pending"),
              lte(contentSlots.scheduledAt, new Date().toISOString()),
            ),
          )
          .all().length;
        const threadsCurrentState = this.getLatestDepartmentSummary("threads");
        const threadsLiveSummary = `承認済みドラフト在庫: ${pendingDrafts}件、期限到来スロット: ${dueSlots}件`;
        return {
          department: "threads",
          summary: threadsCurrentState
            ? `${threadsLiveSummary}\n※前回の状態: ${threadsCurrentState}`
            : threadsLiveSummary,
          metrics: { pendingDrafts, dueSlots },
          recommendation:
            pendingDrafts === 0
              ? "ドラフト生成が必要"
              : dueSlots > 0
                ? "公開実行推奨"
                : "在庫十分。動く必要なし",
          lastExecutedAt: this.getLastRun("threads"),
        };
      },
      execute: async ({ action }) => {
        const summaryParts = [
          await this.runAgentSubtask(
            "threads-post-generator",
            "Threads投稿ドラフト生成と公開計画を実行",
            () =>
              this.deps.orchestration.runDailyThreadsPlan(
                this.deps.llm,
                this.deps.storage,
                this.deps.dryRun,
              ),
          ),
        ];

        if (!this.deps.dryRun) {
          await this.deps.scheduler.syncThreadSlotsFromAuditedDrafts(
            this.deps.maxPostsPerHour,
          );
        }

        const published =
          await this.deps.autoPublisher.publishApprovedThreadDrafts(
            this.deps.threadsApi,
          );
        summaryParts.push(`Auto-published ${published.length} threads posts`);

        return createResult(action, joinSummary(summaryParts), {
          publishedCount: published.length,
        });
      },
    };
  }

  private createNoteExecutor(): DepartmentExecutor {
    return {
      department: "note",
      supports: (actionType) => actionType === "generate_note",
      report: (): DepartmentReport => {
        const pendingNoteDrafts = db
          .select()
          .from(noteDrafts)
          .where(eq(noteDrafts.status, "approved"))
          .all().length;
        const dueNoteSlots = db
          .select()
          .from(contentSlots)
          .where(
            and(
              eq(contentSlots.channel, "note"),
              eq(contentSlots.status, "pending"),
              lte(contentSlots.scheduledAt, new Date().toISOString()),
            ),
          )
          .all().length;
        const publishedNotes = db
          .select()
          .from(notePostResults)
          .all().length;
        const noteCurrentState = this.getLatestDepartmentSummary("note");
        const noteLiveSummary = `承認済み記事: ${pendingNoteDrafts}件、期限到来スロット: ${dueNoteSlots}件、公開済み: ${publishedNotes}件`;
        return {
          department: "note",
          summary: noteCurrentState
            ? `${noteLiveSummary}\n※前回の状態: ${noteCurrentState}`
            : noteLiveSummary,
          metrics: { pendingNoteDrafts, dueNoteSlots, publishedNotes },
          recommendation:
            publishedNotes === 0
              ? "note実績ゼロ。記事生成を最優先"
              : pendingNoteDrafts === 0
                ? "記事生成が必要"
                : dueNoteSlots > 0
                  ? "公開実行推奨"
                  : "動く必要なし",
          lastExecutedAt: this.getLastRun("note"),
        };
      },
      execute: async ({ action }) => {
        const summaryParts: string[] = [];
        const nextNoteSlot = await this.deps.scheduler.getNextNoteSlot();
        const hasDueNoteSlot = nextNoteSlot
          ? new Date(nextNoteSlot.scheduledAt).getTime() <= Date.now()
          : false;

        if (!hasDueNoteSlot) {
          summaryParts.push(
            await this.runAgentSubtask(
              "note-article-generator",
              "note記事の構成・本文・公開準備を実行",
              () =>
                this.deps.runTrackedSubJob("nightly-note-pipeline", () =>
                  this.deps.orchestration.runNightlyNotePipeline(
                    this.deps.llm,
                    this.deps.storage,
                    this.deps.dryRun,
                  ),
                ),
            ),
          );

          if (!this.deps.dryRun) {
            const seededNotes =
              await this.deps.scheduler.syncNoteSlotsFromAuditedDrafts(1);
            if (seededNotes > 0) {
              summaryParts.push(`Seeded ${seededNotes} note slots`);
            }
          }
        }

        const noteApi = this.deps.createNoteApiClient();
        const noteResults =
          await this.deps.autoPublisher.publishApprovedNoteDrafts(noteApi);
        summaryParts.push(`Auto-published ${noteResults.length} notes`);

        if (!this.deps.dryRun && noteResults.length > 0) {
          await createNoteThumbnailTasks(this.deps.notification, noteResults);
          await this.runAgentSubtask(
            "note-engagement-analyst",
            "note公開後の売上/CV/反応を分析",
            async () => {
              await this.deps.noteEngagement.fetchAndStoreNoteResults(noteApi);
              await this.deps.noteEngagement.generateNoteImprovements(
                this.deps.llm,
              );
              return "note公開後分析を更新";
            },
          );
        }

        return createResult(action, joinSummary(summaryParts), {
          publishedCount: noteResults.length,
        });
      },
    };
  }

  private createCommunityExecutor(): DepartmentExecutor {
    return {
      department: "community",
      supports: (actionType) =>
        supportsAction(["fetch_engagement", "reply_safe"], actionType),
      report: (): DepartmentReport => {
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
        const recentEngagement = db
          .select()
          .from(threadPostResults)
          .orderBy(desc(threadPostResults.publishedAt))
          .limit(5)
          .all();
        const avgEngagement =
          recentEngagement.length > 0
            ? recentEngagement.reduce(
                (sum, r) => sum + r.likes + r.repliesCount + r.shares,
                0,
              ) / recentEngagement.length
            : 0;
        const communityCurrentState = this.getLatestDepartmentSummary("community");
        const communityLiveSummary = `未返信: ${pendingReplies}件、直近5投稿の平均エンゲージメント: ${avgEngagement.toFixed(1)}`;
        return {
          department: "community",
          summary: communityCurrentState
            ? `${communityLiveSummary}\n※前回の状態: ${communityCurrentState}`
            : communityLiveSummary,
          metrics: {
            pendingReplies,
            avgEngagement: Math.round(avgEngagement),
          },
          recommendation:
            pendingReplies > 0 ? "リプライ処理推奨" : "動く必要なし",
          lastExecutedAt: this.getLastRun("community"),
        };
      },
      execute: async ({ action }) => {
        if (action.type === "fetch_engagement") {
          const summary = await this.runAgentSubtask(
            "threads-engagement-analyst",
            "Threads反応データを取得して分析",
            () =>
              this.deps.orchestration.runPostPublishFollowup(
                this.deps.threadsApi,
                this.deps.llm,
                this.deps.dryRun,
              ),
          );
          return createResult(action, summary);
        }

        const sent = await this.runAgentSubtask(
          "threads-reply-generator",
          "安全なThreads返信を実行",
          () =>
            this.deps.replyExecution.executeSafeReplies(this.deps.threadsApi),
        );
        return createResult(action, `Sent ${sent} safe replies`, {
          sentCount: sent,
        });
      },
    };
  }

  private createOptimizationExecutor(): DepartmentExecutor {
    return {
      department: "optimization",
      supports: (actionType) =>
        supportsAction(
          ["weekly_retro", "optimize_schedule", "notify"],
          actionType,
        ),
      report: (): DepartmentReport => {
        const lastRetro = db
          .select()
          .from(departmentRuns)
          .where(
            and(
              eq(departmentRuns.department, "optimization"),
              eq(departmentRuns.phase, "weekly_retro"),
            ),
          )
          .orderBy(desc(departmentRuns.createdAt))
          .limit(1)
          .get();
        const daysSince = lastRetro
          ? (Date.now() - new Date(lastRetro.createdAt).getTime()) / 86_400_000
          : Infinity;
        const optCurrentState = this.getLatestDepartmentSummary("optimization");
        const optLiveSummary = `最終振り返りから${Number.isFinite(daysSince) ? Math.floor(daysSince) : "∞"}日経過`;
        return {
          department: "optimization",
          summary: optCurrentState
            ? `${optLiveSummary}\n※前回の状態: ${optCurrentState}`
            : optLiveSummary,
          metrics: {
            daysSinceRetro: Number.isFinite(daysSince)
              ? Math.floor(daysSince)
              : 999,
          },
          recommendation:
            daysSince >= 7 ? "週次振り返り推奨" : "動く必要なし",
          lastExecutedAt: lastRetro?.createdAt ?? null,
        };
      },
      execute: async ({ action }) => {
        if (action.type === "weekly_retro") {
          const summary = await this.deps.runTrackedSubJob("weekly-retro", () =>
            this.deps.orchestration.runWeeklyRetro(
              this.deps.llm,
              this.deps.storage,
              this.deps.dryRun,
            ),
          );
          return createResult(action, summary);
        }

        if (action.type === "optimize_schedule") {
          await this.deps.optimizer.analyzeAndUpdate(this.deps.llm);
          return createResult(action, "Schedule optimized");
        }

        const report = await this.deps.notification.generateProgressReport();
        await this.deps.notification.sendNotification({
          type: "progress",
          report,
        });
        return createResult(action, "Progress notification sent");
      },
    };
  }

  private async runAgentSubtask<T>(
    agentId: string,
    task: string,
    work: () => Promise<T>,
  ): Promise<T> {
    this.deps.runtimeState.startAgent(agentId, task);
    try {
      const result = await work();
      this.deps.runtimeState.finishAgent(
        agentId,
        typeof result === "string" ? result : task,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.runtimeState.finishAgent(agentId, `FAILED: ${message}`);
      throw error;
    }
  }
}
