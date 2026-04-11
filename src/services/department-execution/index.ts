import { randomUUID } from "node:crypto";
import type { LlmClient } from "../../adapters/llm/index.js";
import type { NoteApiClient } from "../../adapters/note-api/index.js";
import type { StorageClient } from "../../adapters/storage/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  competitorAnalyses,
  competitorSnapshots,
  contentSlots,
  departmentNotifications,
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
import { ResearchServiceImpl } from "../research/index.js";
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
  department = resolveDepartmentName(action.type),
): DepartmentExecutionResult {
  return {
    department,
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
      this.createExternalResearchExecutor(),
      this.createCompetitiveAnalysisExecutor(),
      this.createThreadsExecutor(),
      this.createNoteExecutor(),
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

  private getUnreadNotifications(department: DepartmentName): string {
    const unread = db
      .select()
      .from(departmentNotifications)
      .where(
        and(
          eq(departmentNotifications.toDepartment, department),
          isNull(departmentNotifications.readAt),
        ),
      )
      .orderBy(desc(departmentNotifications.createdAt))
      .limit(5)
      .all();

    if (unread.length === 0) return "";

    // Mark as read
    for (const n of unread) {
      db.update(departmentNotifications)
        .set({ readAt: new Date().toISOString() })
        .where(eq(departmentNotifications.id, n.id))
        .run();
    }

    return `\n📨 他部署からの通知${unread.length}件: ${unread.map((n) => `[${n.fromDepartment}→${n.notificationType}]`).join(", ")}`;
  }

  async execute(
    action: ScheduledAction,
    instruction?: string,
  ): Promise<DepartmentExecutionResult> {
    const executor = this.executors.find((candidate) =>
      candidate.supports(action.type),
    );
    if (!executor) {
      throw new Error(`No department executor registered for ${action.type}`);
    }

    return executor.execute({ action, dryRun: this.deps.dryRun, instruction });
  }

  private createCommandExecutor(): DepartmentExecutor {
    return {
      department: "command",
      supports: (actionType) =>
        supportsAction(["process_human_inputs", "notify"], actionType),
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
      execute: async ({ action, instruction }) => {
        if (instruction) {
          logger.info(
            { department: "command", instruction },
            "Executive instruction received",
          );
        }
        if (action.type === "notify") {
          const report = await this.deps.notification.generateProgressReport();
          await this.deps.notification.sendNotification({
            type: "progress",
            report,
          });
          return createResult(action, "Progress notification sent");
        }

        const summary = await this.deps.orchestration.processHumanInputs(
          this.deps.llm,
          this.deps.storage,
        );
        return createResult(action, summary);
      },
    };
  }

  private createExternalResearchExecutor(): DepartmentExecutor {
    return {
      department: "external-research",
      supports: (actionType) => actionType === "research_threads",
      report: (): DepartmentReport => {
        const lastResearch = db
          .select()
          .from(departmentRuns)
          .where(eq(departmentRuns.department, "external-research"))
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
        const researchCurrentState = this.getLatestDepartmentSummary(
          "external-research",
        );
        const researchLiveSummary =
          hoursSince > 24
            ? `最終リサーチから${Math.floor(hoursSince)}時間経過。更新推奨`
            : `最終リサーチから${Math.floor(hoursSince)}時間。まだ新鮮`;
        return {
          department: "external-research",
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
      execute: async ({ action, instruction }) => {
        if (instruction) {
          logger.info(
            { department: "external-research", instruction },
            "Executive instruction received",
          );
        }
        const summary = await this.runAgentSubtask(
          "trend-researcher",
          "外部トレンドとトピック調査を更新",
          () =>
            this.deps.runTrackedSubJob("daily-topic-research", () =>
              this.deps.orchestration.runDailyTopicResearch(
                this.deps.llm,
                this.deps.storage,
                this.deps.dryRun,
              ),
            ),
        );
        return createResult(action, summary, undefined, "external-research");
      },
    };
  }

  private createCompetitiveAnalysisExecutor(): DepartmentExecutor {
    const research = new ResearchServiceImpl();
    return {
      department: "competitive-analysis",
      supports: (actionType) => actionType === "analyze_competitors",
      report: (): DepartmentReport => {
        const snapshots = db
          .select()
          .from(competitorSnapshots)
          .orderBy(desc(competitorSnapshots.createdAt))
          .all();
        const latestSnapshot = snapshots[0] ?? null;
        const daysSinceSnapshot = latestSnapshot
          ? Math.floor(
              (Date.now() - new Date(latestSnapshot.createdAt).getTime()) /
                86_400_000,
            )
          : 999;
        const analyses = db
          .select()
          .from(competitorAnalyses)
          .orderBy(desc(competitorAnalyses.createdAt))
          .limit(1)
          .all();
        const latestAnalysis = analyses[0] ?? null;
        const daysSinceAnalysis = latestAnalysis
          ? Math.floor(
              (Date.now() - new Date(latestAnalysis.createdAt).getTime()) /
                86_400_000,
            )
          : 999;
        const currentState = this.getLatestDepartmentSummary(
          "competitive-analysis",
        );
        const caNotifications = this.getUnreadNotifications("competitive-analysis");
        const liveSummary = latestSnapshot
          ? `競合スナップショット: ${snapshots.length}件（最新${daysSinceSnapshot}日前）、分析: ${latestAnalysis ? `最新${daysSinceAnalysis}日前` : "未実行"}${caNotifications}`
          : `競合スナップショット未取得。比較材料の蓄積が必要${caNotifications}`;

        return {
          department: "competitive-analysis",
          summary: currentState
            ? `${liveSummary}\n※前回の状態: ${currentState}`
            : liveSummary,
          metrics: {
            snapshotCount: snapshots.length,
            daysSinceSnapshot,
            daysSinceAnalysis,
          },
          recommendation:
            daysSinceAnalysis >= 7 && snapshots.length > 0
              ? "競合分析を実行すべき"
              : snapshots.length === 0
                ? "競合スナップショットの蓄積を優先すべき"
                : "動く必要なし",
          lastExecutedAt:
            latestAnalysis?.createdAt ??
            this.getLastRun("competitive-analysis"),
        };
      },
      execute: async ({ action, instruction }) => {
        if (instruction) {
          logger.info(
            { department: "competitive-analysis", instruction },
            "Executive instruction received",
          );
        }
        const summary = await this.runAgentSubtask(
          "engagement-analyst",
          "競合投稿の分析と勝ちパターン抽出",
          async () => {
            const threadsResult = await research.analyzeCompetitorSnapshots(
              this.deps.llm,
              "threads",
            );
            const noteResult = await research.analyzeCompetitorSnapshots(
              this.deps.llm,
              "note",
            );

            // Push notifications to threads and note departments
            const now = new Date().toISOString();
            if (threadsResult.winningPatterns.length > 0) {
              db.insert(departmentNotifications)
                .values({
                  id: randomUUID(),
                  fromDepartment: "competitive-analysis",
                  toDepartment: "threads",
                  notificationType: "analysis_complete",
                  content: JSON.stringify({
                    winningPatterns: threadsResult.winningPatterns,
                    summary: threadsResult.summary,
                  }),
                  readAt: null,
                  createdAt: now,
                })
                .run();
            }
            if (noteResult.winningPatterns.length > 0) {
              db.insert(departmentNotifications)
                .values({
                  id: randomUUID(),
                  fromDepartment: "competitive-analysis",
                  toDepartment: "note",
                  notificationType: "analysis_complete",
                  content: JSON.stringify({
                    winningPatterns: noteResult.winningPatterns,
                    summary: noteResult.summary,
                  }),
                  readAt: null,
                  createdAt: now,
                })
                .run();
            }

            return `競合分析完了: Threads ${threadsResult.analysisCount}件, note ${noteResult.analysisCount}件分析。勝ちパターン: ${[...threadsResult.winningPatterns, ...noteResult.winningPatterns].join(", ") || "なし"}`;
          },
        );
        return createResult(action, summary, undefined, "competitive-analysis");
      },
    };
  }

  private createThreadsExecutor(): DepartmentExecutor {
    return {
      department: "threads",
      supports: (actionType) =>
        supportsAction(
          [
            "generate_and_post",
            "fetch_engagement",
            "reply_safe",
            "optimize_schedule",
            "weekly_retro",
          ],
          actionType,
        ),
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
                (sum, row) => sum + row.likes + row.repliesCount + row.shares,
                0,
              ) / recentEngagement.length
            : 0;
        const threadsCurrentState = this.getLatestDepartmentSummary("threads");
        const threadsNotifications = this.getUnreadNotifications("threads");
        const threadsLiveSummary = `承認済みドラフト在庫: ${pendingDrafts}件、期限到来スロット: ${dueSlots}件、未返信: ${pendingReplies}件、直近5投稿の平均エンゲージメント: ${avgEngagement.toFixed(1)}${threadsNotifications}`;
        return {
          department: "threads",
          summary: threadsCurrentState
            ? `${threadsLiveSummary}\n※前回の状態: ${threadsCurrentState}`
            : threadsLiveSummary,
          metrics: {
            pendingDrafts,
            dueSlots,
            pendingReplies,
            avgEngagement: Math.round(avgEngagement),
          },
          recommendation:
            dueSlots > 0
                ? "公開実行推奨"
                : pendingReplies > 0
                  ? "リプライ処理推奨"
                  : pendingDrafts === 0
                    ? "ドラフト生成が必要"
                    : "在庫十分。動く必要なし",
          lastExecutedAt: this.getLastRun("threads"),
        };
      },
      execute: async ({ action, instruction }) => {
        if (instruction) {
          logger.info(
            { department: "threads", instruction },
            "Executive instruction received",
          );
        }
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

        if (action.type === "reply_safe") {
          const sent = await this.runAgentSubtask(
            "threads-reply-generator",
            "安全なThreads返信を実行",
            () =>
              this.deps.replyExecution.executeSafeReplies(this.deps.threadsApi),
          );
          return createResult(action, `Sent ${sent} safe replies`, {
            sentCount: sent,
          });
        }

        if (action.type === "optimize_schedule") {
          const summary = await this.runAgentSubtask(
            "cadence-optimizer",
            "Threadsの投稿頻度と時間帯を最適化",
            async () => {
              await this.deps.optimizer.analyzeAndUpdate(this.deps.llm, "threads");
              return "Threads schedule optimized";
            },
          );
          return createResult(action, summary);
        }

        if (action.type === "weekly_retro") {
          const summary = await this.runAgentSubtask(
            "cadence-optimizer",
            "Threads運用の週次ふりかえりを更新",
            () =>
              this.deps.runTrackedSubJob("weekly-retro", () =>
                this.deps.orchestration.runWeeklyRetro(
                  this.deps.llm,
                  this.deps.storage,
                  this.deps.dryRun,
                ),
              ),
          );
          return createResult(action, summary);
        }

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

  private async runNoteOptimizationTasks(): Promise<string[]> {
    await this.deps.optimizer.analyzeAndUpdate(this.deps.llm, "note");

    const report = await this.deps.notification.generateProgressReport();
    await this.deps.notification.sendNotification({
      type: "progress",
      report,
    });

    return ["Note schedule optimized", "Progress notification sent"];
  }

  private createNoteExecutor(): DepartmentExecutor {
    return {
      department: "note",
      supports: (actionType) =>
        supportsAction(["generate_note", "research_note"], actionType),
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
        const noteResearchSnapshots = db
          .select()
          .from(competitorSnapshots)
          .all()
          .filter((row) => row.source.startsWith("note_search:"))
          .length;
        const noteCurrentState = this.getLatestDepartmentSummary("note");
        const noteNotifications = this.getUnreadNotifications("note");
        const noteLiveSummary = `承認済み記事: ${pendingNoteDrafts}件、期限到来スロット: ${dueNoteSlots}件、公開済み: ${publishedNotes}件、競合スナップショット: ${noteResearchSnapshots}件${noteNotifications}`;
        return {
          department: "note",
          summary: noteCurrentState
            ? `${noteLiveSummary}\n※前回の状態: ${noteCurrentState}`
            : noteLiveSummary,
          metrics: {
            pendingNoteDrafts,
            dueNoteSlots,
            publishedNotes,
            noteResearchSnapshots,
          },
          recommendation:
            publishedNotes === 0
              ? "note実績ゼロ。記事生成を最優先"
              : noteResearchSnapshots === 0
                ? "競合リサーチを先に回すべき"
              : pendingNoteDrafts === 0
                  ? "記事生成が必要"
                  : dueNoteSlots > 0
                    ? "公開実行推奨"
                    : "動く必要なし",
          lastExecutedAt: this.getLastRun("note"),
        };
      },
      execute: async ({ action, instruction }) => {
        if (instruction) {
          logger.info(
            { department: "note", instruction },
            "Executive instruction received",
          );
        }
        if (action.type === "research_note") {
          const summaryParts = [
            await this.runAgentSubtask(
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
            ),
          ];

          if (!this.deps.dryRun) {
            summaryParts.push(...(await this.runNoteOptimizationTasks()));
          }

          return createResult(action, joinSummary(summaryParts));
        }

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

        if (!this.deps.dryRun) {
          summaryParts.push(...(await this.runNoteOptimizationTasks()));
        }

        return createResult(action, joinSummary(summaryParts), {
          publishedCount: noteResults.length,
        });
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
