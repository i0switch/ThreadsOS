import { randomUUID } from "node:crypto";
import type { LlmClient } from "../../adapters/llm/index.js";
import type { NoteApiClient } from "../../adapters/note-api/index.js";
import type { StorageClient } from "../../adapters/storage/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { db } from "../../db/index.js";
import { thumbnailTasks } from "../../db/schema.js";
import type {
  DepartmentExecutionResult,
  DepartmentExecutor,
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
      execute: async ({ action }) => {
        if (action.type === "research_threads") {
          const summary = await this.deps.runTrackedSubJob(
            "daily-topic-research",
            () =>
              this.deps.orchestration.runDailyTopicResearch(
                this.deps.llm,
                this.deps.storage,
                this.deps.dryRun,
              ),
          );
          return createResult(action, summary);
        }

        const summary = await this.deps.runTrackedSubJob(
          "note-competitor-research",
          () =>
            this.deps.orchestration.runNoteResearch(
              this.deps.llm,
              this.deps.storage,
              this.deps.dryRun,
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
      execute: async ({ action }) => {
        const summaryParts = [
          await this.deps.orchestration.runDailyThreadsPlan(
            this.deps.llm,
            this.deps.storage,
            this.deps.dryRun,
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
      execute: async ({ action }) => {
        const summaryParts: string[] = [];
        const nextNoteSlot = await this.deps.scheduler.getNextNoteSlot();
        const hasDueNoteSlot = nextNoteSlot
          ? new Date(nextNoteSlot.scheduledAt).getTime() <= Date.now()
          : false;

        if (!hasDueNoteSlot) {
          summaryParts.push(
            await this.deps.runTrackedSubJob("nightly-note-pipeline", () =>
              this.deps.orchestration.runNightlyNotePipeline(
                this.deps.llm,
                this.deps.storage,
                this.deps.dryRun,
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
          await this.deps.noteEngagement.fetchAndStoreNoteResults(noteApi);
          await this.deps.noteEngagement.generateNoteImprovements(
            this.deps.llm,
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
      execute: async ({ action }) => {
        if (action.type === "fetch_engagement") {
          const summary = await this.deps.orchestration.runPostPublishFollowup(
            this.deps.threadsApi,
            this.deps.llm,
            this.deps.dryRun,
          );
          return createResult(action, summary);
        }

        const sent = await this.deps.replyExecution.executeSafeReplies(
          this.deps.threadsApi,
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
}
