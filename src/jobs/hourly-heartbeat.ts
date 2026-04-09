import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { createLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import {
  DryRunNoteApiClient,
  NoteApiClientImpl,
  PlaywrightNoteApiClient,
} from "../adapters/note-api/index.js";
import { FileSystemStorageClient } from "../adapters/storage/index.js";
import {
  DryRunThreadsApiClient,
  ThreadsGraphApiClient,
} from "../adapters/threads-api/index.js";
import { loadEnv } from "../config/env.js";
import { ensureAutonomyTables } from "../db/bootstrap.js";
import { db } from "../db/index.js";
import { heartbeatStates, scheduledJobRuns } from "../db/schema.js";
import { AutoPublisherServiceImpl } from "../services/auto-publisher/index.js";
import { CadenceOptimizerServiceImpl } from "../services/cadence-optimizer/index.js";
import { ContentSchedulerServiceImpl } from "../services/content-scheduler/index.js";
import { DepartmentExecutionServiceImpl } from "../services/department-execution/index.js";
import { ExecutiveServiceImpl } from "../services/executive/index.js";
import { NoteEngagementAnalysisServiceImpl } from "../services/note-engagement-analysis/index.js";
import { NotificationServiceImpl } from "../services/notification/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { ReplyExecutionServiceImpl } from "../services/reply-execution/index.js";
import { refreshToken, updateEnvFile } from "./refresh-threads-token.js";
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
let env = loadEnv();

const llm = dryRun ? new DryRunLlmClient() : createLlmClient();
let threadsApi = dryRun
  ? new DryRunThreadsApiClient()
  : new ThreadsGraphApiClient();
const storage = new FileSystemStorageClient();

const scheduler = new ContentSchedulerServiceImpl(maxPostsPerHour);
const executive = new ExecutiveServiceImpl();
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
let departmentExecution = createDepartmentExecution();

ensureAutonomyTables();

function createNoteApiClient() {
  if (dryRun) {
    return new DryRunNoteApiClient();
  }
  if (env.NOTE_MODE === "research_only") {
    throw new Error("NOTE_MODE が research_only のため note 公開は無効");
  }
  if (env.NOTE_MODE === "browser_assisted") {
    return new PlaywrightNoteApiClient();
  }
  return new NoteApiClientImpl();
}

function createDepartmentExecution() {
  return new DepartmentExecutionServiceImpl({
    dryRun,
    maxPostsPerHour,
    llm,
    storage,
    threadsApi,
    orchestration,
    scheduler,
    autoPublisher,
    optimizer,
    replyExecution,
    noteEngagement,
    notification,
    runTrackedSubJob,
    createNoteApiClient,
  });
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

    // ── トークン自動更新（週1回） ──────────────────────────────
    const tokenState = db
      .select()
      .from(heartbeatStates)
      .where(eq(heartbeatStates.jobName, "refresh-threads-token"))
      .get();

    const lastTokenRefresh = tokenState?.lastRunAt
      ? new Date(tokenState.lastRunAt).getTime()
      : 0;
    const daysSinceRefresh = (Date.now() - lastTokenRefresh) / 86_400_000;

    if (daysSinceRefresh >= 7 && env.THREADS_ACCESS_TOKEN && !dryRun) {
      try {
        logger.info("週次トークンリフレッシュを実行中...");
        const result = await refreshToken(env.THREADS_ACCESS_TOKEN);
        await updateEnvFile(result.access_token);

        // env とクライアントを再読み込み
        const { config: reloadDotenv } = await import("dotenv");
        reloadDotenv({ override: true });
        env = loadEnv();
        if (!dryRun) {
          threadsApi = new ThreadsGraphApiClient();
          departmentExecution = createDepartmentExecution();
        }

        // heartbeatStatesの更新
        if (!tokenState) {
          db.insert(heartbeatStates)
            .values({
              jobName: "refresh-threads-token",
              lastRunAt: new Date().toISOString(),
              consecutiveFailures: 0,
            })
            .run();
        } else {
          db.update(heartbeatStates)
            .set({
              lastRunAt: new Date().toISOString(),
              consecutiveFailures: 0,
            })
            .where(eq(heartbeatStates.jobName, "refresh-threads-token"))
            .run();
        }

        const expiresInDays = Math.floor(result.expires_in / 86400);
        logger.info({ expiresInDays }, "トークンリフレッシュ完了");
      } catch (tokenErr) {
        logger.warn(
          {
            error:
              tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
          },
          "トークンリフレッシュ失敗（処理は続行）",
        );
      }
    }

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
      const cycle = await executive.beginHeartbeatCycle(actions);
      const results: string[] = [];

      logger.info(
        {
          cycleId: cycle.cycleId,
          objective: cycle.objective,
          funnelStage: cycle.funnelStage,
          approvedActions: cycle.approvedActions.map((action) => action.type),
          skippedActions: cycle.skippedActions.map((item) => ({
            type: item.action.type,
            reason: item.reason,
          })),
          directives: cycle.directives,
        },
        "Heartbeat cycle planned by executive",
      );

      for (const action of cycle.approvedActions) {
        logger.info(
          { action: action.type, reason: action.reason },
          "Executing heartbeat action",
        );

        const department = executive.resolveDepartment(action.type);

        try {
          const execution = await departmentExecution.execute(action);
          results.push(execution.summary);
          await executive.recordDepartmentRun({
            cycleId: cycle.cycleId,
            department: execution.department,
            phase: execution.phase,
            status: execution.status,
            summary: execution.summary,
            payload: {
              reason: action.reason,
              objective: cycle.objective,
              ...execution.payload,
            },
          });
        } catch (actionError) {
          const message =
            actionError instanceof Error
              ? actionError.message
              : String(actionError);
          logger.error(
            { action: action.type, error: message, stack: actionError instanceof Error ? actionError.stack : undefined },
            "Action failed, continuing",
          );
          results.push(`FAILED: ${action.type} - ${message}`);
          await executive.recordDepartmentRun({
            cycleId: cycle.cycleId,
            department,
            phase: action.type,
            status: "failed",
            summary: message,
            payload: {
              reason: action.reason,
              objective: cycle.objective,
            },
          });
        }
      }

      isFailed = results.some((r) => r.startsWith("FAILED:"));
      await executive.completeHeartbeatCycle(
        cycle.cycleId,
        isFailed ? "failed" : "completed",
        results.join("\n"),
      );
      return results.join("\n");
    } catch (err) {
      isFailed = true;
      throw err;
    } finally {
      const prevFailures = current?.consecutiveFailures ?? 0;
      const newFailures = isFailed ? prevFailures + 1 : 0;

      if (
        isFailed &&
        newFailures >= 5 &&
        (newFailures === 5 || newFailures % 5 === 0)
      ) {
        await notification
          .sendNotification({
            type: "critical",
            message: `🚨 緊急: ${newFailures}回連続失敗`,
          })
          .catch((e) =>
            logger.error({ error: String(e) }, "Failed to send critical alert"),
          );
      } else if (
        isFailed &&
        newFailures >= 3 &&
        (newFailures === 3 || newFailures % 3 === 0)
      ) {
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
