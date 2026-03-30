import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { ClaudeLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import {
  DryRunNoteApiClient,
  NoteApiClientImpl,
} from "../adapters/note-api/index.js";
import { FileSystemStorageClient } from "../adapters/storage/index.js";
import {
  DryRunThreadsApiClient,
  ThreadsGraphApiClient,
} from "../adapters/threads-api/index.js";
import { loadEnv } from "../config/env.js";
import { ensureAutonomyTables } from "../db/bootstrap.js";
import { db } from "../db/index.js";
import {
  heartbeatStates,
  scheduledJobRuns,
  thumbnailTasks,
} from "../db/schema.js";
import { AutoPublisherServiceImpl } from "../services/auto-publisher/index.js";
import { CadenceOptimizerServiceImpl } from "../services/cadence-optimizer/index.js";
import { ContentSchedulerServiceImpl } from "../services/content-scheduler/index.js";
import { NoteEngagementAnalysisServiceImpl } from "../services/note-engagement-analysis/index.js";
import { NotificationServiceImpl } from "../services/notification/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { ReplyExecutionServiceImpl } from "../services/reply-execution/index.js";
import { runJob } from "./runner.js";

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const maxPostsPerHour = readEnvInt("MAX_POSTS_PER_HOUR", 3);
const maxRepliesPerHour = readEnvInt("MAX_REPLIES_PER_HOUR", 10);
const env = loadEnv();

const llm = dryRun ? new DryRunLlmClient() : new ClaudeLlmClient();
const threadsApi = dryRun
  ? new DryRunThreadsApiClient()
  : new ThreadsGraphApiClient();
const storage = new FileSystemStorageClient();

const scheduler = new ContentSchedulerServiceImpl(maxPostsPerHour);
const orchestration = new OrchestrationServiceImpl();
const autoPublisher = new AutoPublisherServiceImpl({
  maxPostsPerHour,
  maxRepliesPerHour,
  dryRun,
});
const optimizer = new CadenceOptimizerServiceImpl();
const replyExecution = new ReplyExecutionServiceImpl(maxRepliesPerHour);
const noteEngagement = new NoteEngagementAnalysisServiceImpl();
const notification = new NotificationServiceImpl(storage);

ensureAutonomyTables();

function createNoteApiClient() {
  if (dryRun) {
    return new DryRunNoteApiClient();
  }
  if (env.NOTE_MODE === "research_only") {
    throw new Error("NOTE_MODE が research_only のため note 公開は無効");
  }
  return new NoteApiClientImpl();
}

async function runTrackedSubJob(
  jobName: string,
  task: () => Promise<string>,
  stuckThresholdMinutes = 60,
): Promise<string> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  const stuckThreshold = new Date(
    Date.now() - stuckThresholdMinutes * 60 * 1000,
  ).toISOString();
  db.update(scheduledJobRuns)
    .set({
      status: "failed",
      finishedAt: new Date().toISOString(),
      resultSummary: `Stuck running for over ${stuckThresholdMinutes} minutes`,
    })
    .where(
      and(
        eq(scheduledJobRuns.jobName, jobName),
        eq(scheduledJobRuns.status, "running"),
        lt(scheduledJobRuns.startedAt, stuckThreshold),
      ),
    )
    .run();

  db.insert(scheduledJobRuns)
    .values({
      id: runId,
      jobName,
      status: "running",
      startedAt,
      finishedAt: null,
      dryRun: dryRun ? 1 : 0,
      resultSummary: null,
      createdAt: startedAt,
    })
    .run();

  try {
    const summary = await task();
    db.update(scheduledJobRuns)
      .set({
        status: "completed",
        finishedAt: new Date().toISOString(),
        resultSummary: summary,
      })
      .where(eq(scheduledJobRuns.id, runId))
      .run();
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(scheduledJobRuns)
      .set({
        status: "failed",
        finishedAt: new Date().toISOString(),
        resultSummary: message,
      })
      .where(eq(scheduledJobRuns.id, runId))
      .run();
    throw error;
  }
}

await runJob(
  { name: "hourly-heartbeat", dryRun },
  async ({ dryRun, logger }) => {
    const state = db
      .select()
      .from(heartbeatStates)
      .where(eq(heartbeatStates.jobName, "hourly-heartbeat"))
      .get();

    if (!state) {
      db.insert(heartbeatStates)
        .values({
          jobName: "hourly-heartbeat",
          lastRunAt: null,
          nextNotificationAt: null,
          consecutiveFailures: 0,
          lockedBy: null,
          lockedAt: null,
        })
        .run();
    }

    const current =
      state ??
      db
        .select()
        .from(heartbeatStates)
        .where(eq(heartbeatStates.jobName, "hourly-heartbeat"))
        .get();

    if (current?.lockedBy && current.lockedAt) {
      const lockAgeMinutes =
        (Date.now() - new Date(current.lockedAt).getTime()) / 60_000;
      if (lockAgeMinutes < 50) {
        logger.warn(
          { lockedBy: current.lockedBy, lockAgeMinutes },
          "Heartbeat already running, skipping",
        );
        return "Skipped: another heartbeat is running";
      }
    }

    const lockId = `hb-${Date.now()}`;
    db.update(heartbeatStates)
      .set({
        lockedBy: lockId,
        lockedAt: new Date().toISOString(),
      })
      .where(eq(heartbeatStates.jobName, "hourly-heartbeat"))
      .run();

    let isFailed = false;
    try {
      if (!dryRun) {
        const seededThreads =
          await scheduler.syncThreadSlotsFromAuditedDrafts(maxPostsPerHour);
        if (seededThreads > 0) {
          logger.info(
            { seeded: seededThreads },
            "Seeded thread slots before heartbeat",
          );
        }

        const seededNotes = await scheduler.syncNoteSlotsFromAuditedDrafts(1);
        if (seededNotes > 0) {
          logger.info(
            { seeded: seededNotes },
            "Seeded note slots before heartbeat",
          );
        }
      }

      const actions = await scheduler.decideActions();
      const results: string[] = [];

      for (const action of actions) {
        logger.info(
          { action: action.type, reason: action.reason },
          "Executing heartbeat action",
        );

        try {
          switch (action.type) {
            case "process_human_inputs":
              results.push(
                await orchestration.processHumanInputs(llm, storage),
              );
              break;

            case "research_threads":
              results.push(
                await runTrackedSubJob("daily-topic-research", () =>
                  orchestration.runDailyTopicResearch(llm, storage, dryRun),
                ),
              );
              break;

            case "research_note":
              results.push(
                await runTrackedSubJob("note-competitor-research", () =>
                  orchestration.runNoteResearch(llm, storage, dryRun),
                ),
              );
              break;

            case "generate_and_post": {
              results.push(
                await orchestration.runDailyThreadsPlan(llm, storage, dryRun),
              );
              if (!dryRun) {
                await scheduler.syncThreadSlotsFromAuditedDrafts(
                  maxPostsPerHour,
                );
              }
              const published =
                await autoPublisher.publishApprovedThreadDrafts(threadsApi);
              results.push(`Auto-published ${published.length} threads posts`);
              break;
            }

            case "fetch_engagement":
              results.push(
                await orchestration.runPostPublishFollowup(
                  threadsApi,
                  llm,
                  dryRun,
                ),
              );
              break;

            case "reply_safe": {
              const sent = await replyExecution.executeSafeReplies(threadsApi);
              results.push(`Sent ${sent} safe replies`);
              break;
            }

            case "generate_note": {
              const nextNoteSlot = await scheduler.getNextNoteSlot();
              const hasDueNoteSlot = nextNoteSlot
                ? new Date(nextNoteSlot.scheduledAt).getTime() <= Date.now()
                : false;

              if (!hasDueNoteSlot) {
                results.push(
                  await runTrackedSubJob("nightly-note-pipeline", () =>
                    orchestration.runNightlyNotePipeline(llm, storage, dryRun),
                  ),
                );
                if (!dryRun) {
                  const seededNotes =
                    await scheduler.syncNoteSlotsFromAuditedDrafts(1);
                  if (seededNotes > 0) {
                    results.push(`Seeded ${seededNotes} note slots`);
                  }
                }
              }

              const noteApi = createNoteApiClient();
              const noteResults =
                await autoPublisher.publishApprovedNoteDrafts(noteApi);
              results.push(`Auto-published ${noteResults.length} notes`);

              if (!dryRun) {
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

                if (noteResults.length > 0) {
                  await noteEngagement.fetchAndStoreNoteResults(noteApi);
                  await noteEngagement.generateNoteImprovements(llm);
                }
              }
              break;
            }

            case "weekly_retro":
              results.push(
                await runTrackedSubJob("weekly-retro", () =>
                  orchestration.runWeeklyRetro(llm, storage, dryRun),
                ),
              );
              break;

            case "optimize_schedule":
              await optimizer.analyzeAndUpdate(llm);
              results.push("Schedule optimized");
              break;

            case "notify": {
              const report = await notification.generateProgressReport();
              await notification.sendNotification({ type: "progress", report });
              results.push("Progress notification sent");
              break;
            }
          }
        } catch (actionError) {
          const message =
            actionError instanceof Error
              ? actionError.message
              : String(actionError);
          logger.error(
            { action: action.type, error: message },
            "Action failed, continuing",
          );
          results.push(`FAILED: ${action.type} - ${message}`);
        }
      }

      isFailed = results.some((r) => r.startsWith("FAILED:"));
      return results.join("\n");
    } catch (err) {
      isFailed = true;
      throw err;
    } finally {
      const prevFailures = current?.consecutiveFailures ?? 0;
      const newFailures = isFailed ? prevFailures + 1 : 0;

      if (isFailed && newFailures >= 5 && (newFailures === 5 || newFailures % 5 === 0)) {
        await notification
          .sendNotification({
            type: "critical",
            message: `🚨 緊急: ${newFailures}回連続失敗`,
          })
          .catch((e) =>
            logger.error({ error: String(e) }, "Failed to send critical alert"),
          );
      } else if (isFailed && newFailures >= 3 && (newFailures === 3 || newFailures % 3 === 0)) {
        await notification
          .sendNotification({
            type: "alert",
            message: `⚠️ ${newFailures}回連続失敗中`,
          })
          .catch((e) =>
            logger.error({ error: String(e) }, "Failed to send alert"),
          );
      } else if (!isFailed && prevFailures > 0) {
        await notification
          .sendNotification({
            type: "recovery",
            message: "recovery通知",
          })
          .catch((e) =>
            logger.error(
              { error: String(e) },
              "Failed to send recovery notice",
            ),
          );
      }

      db.update(heartbeatStates)
        .set({
          lockedBy: null,
          lockedAt: null,
          lastRunAt: new Date().toISOString(),
          consecutiveFailures: newFailures,
        })
        .where(eq(heartbeatStates.jobName, "hourly-heartbeat"))
        .run();
    }
  },
);
