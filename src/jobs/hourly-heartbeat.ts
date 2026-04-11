import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
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
import {
  departmentNotifications,
  departmentRuns,
  departmentSummaries,
  heartbeatStates,
  scheduledJobRuns,
  systemControls,
} from "../db/schema.js";
import { AutoPublisherServiceImpl } from "../services/auto-publisher/index.js";
import { createBudgetService } from "../services/budget/index.js";
import { CadenceOptimizerServiceImpl } from "../services/cadence-optimizer/index.js";
import { ContentSchedulerServiceImpl } from "../services/content-scheduler/index.js";
import { DepartmentExecutionServiceImpl } from "../services/department-execution/index.js";
import { createDiffCollectorService } from "../services/diff-collector/index.js";
import { ExecutiveServiceImpl } from "../services/executive/index.js";
import { createMemoryService } from "../services/memory/index.js";
import { NoteEngagementAnalysisServiceImpl } from "../services/note-engagement-analysis/index.js";
import { NotificationServiceImpl } from "../services/notification/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { createProposalFlowService } from "../services/proposal-flow/index.js";
import { ReplyExecutionServiceImpl } from "../services/reply-execution/index.js";
import { createRetrievalService } from "../services/retrieval/index.js";
import { createRuntimeStateService } from "../services/runtime-state/index.js";
import { createSafetyService } from "../services/safety/index.js";
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
const diffCollector = createDiffCollectorService();
const memoryService = createMemoryService();
const budgetService = createBudgetService();
const runtimeState = createRuntimeStateService();
const proposalFlow = createProposalFlowService();
const retrievalService = createRetrievalService(memoryService);
const safetyService = createSafetyService();
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
runtimeState.ensureCatalog();

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
    runtimeState,
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

  try {
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
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("unique constraint failed")
    ) {
      return `Skipped: ${jobName} is already running`;
    }
    throw error;
  }

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
    db.insert(heartbeatStates)
      .values({
        jobName: "hourly-heartbeat",
        lastRunAt: null,
        nextNotificationAt: null,
        consecutiveFailures: 0,
        lockedBy: null,
        lockedAt: null,
      })
      .onConflictDoNothing()
      .run();

    const current = db
      .select()
      .from(heartbeatStates)
      .where(eq(heartbeatStates.jobName, "hourly-heartbeat"))
      .get();

    const lockId = `hb-${Date.now()}`;
    const staleLockThreshold = new Date(
      Date.now() - 50 * 60 * 1000,
    ).toISOString();
    const lockResult = db
      .update(heartbeatStates)
      .set({
        lockedBy: lockId,
        lockedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(heartbeatStates.jobName, "hourly-heartbeat"),
          or(
            isNull(heartbeatStates.lockedBy),
            isNull(heartbeatStates.lockedAt),
            lt(heartbeatStates.lockedAt, staleLockThreshold),
          ),
        ),
      )
      .run();

    if (lockResult.changes === 0) {
      logger.warn("Heartbeat already running, skipping");
      return "Skipped: another heartbeat is running";
    }

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
      // ── Step 1: ハートビート起動 ──────────────────────────────
      const heartbeatPeriodKey = `hb-${new Date().toISOString().slice(0, 13)}`;

      // ── system_controls チェック ──────────────────────────────
      const activePauses = db
        .select()
        .from(systemControls)
        .where(
          and(eq(systemControls.action, "pause"), eq(systemControls.active, 1)),
        )
        .all();
      const pausedScopes = new Set(activePauses.map((c) => c.scope));

      if (pausedScopes.has("global")) {
        logger.warn("system_controls: global pause active, skipping heartbeat");
        return "Skipped: global pause active";
      }

      // ── Safety: force-stop check ─────────────────────────────
      if (safetyService.shouldForceStop()) {
        logger.error(
          "Safety: 5 consecutive failures detected, force-stopping heartbeat",
        );
        await notification
          .sendNotification({
            type: "critical",
            message:
              "緊急停止: 5回連続失敗検出。ハートビートを強制停止しました。",
          })
          .catch(() => {});
        return "Force-stopped: 5 consecutive failures";
      }

      // ── Step 2: 差分収集 ──────────────────────────────────────
      const diff = await diffCollector.collectSinceLastHeartbeat();
      logger.info({ diff }, "Diff collected since last heartbeat");

      // ── Step 3: 重要度判定 ────────────────────────────────────
      type DiffPriority = "critical" | "high" | "medium" | "low";
      const diffPriorities: Array<{
        item: string;
        count: number;
        priority: DiffPriority;
      }> = [
        {
          item: "newErrors",
          count: diff.newErrors,
          priority: diff.newErrors > 0 ? "critical" : "low",
        },
        {
          item: "newHumanInputs",
          count: diff.newHumanInputs,
          priority: diff.newHumanInputs > 0 ? "high" : "low",
        },
        {
          item: "newReplies",
          count: diff.newReplies,
          priority:
            diff.newReplies > 3
              ? "high"
              : diff.newReplies > 0
                ? "medium"
                : "low",
        },
        {
          item: "newEngagement",
          count: diff.newEngagement,
          priority: diff.newEngagement > 0 ? "medium" : "low",
        },
        {
          item: "newCompetitorPosts",
          count: diff.newCompetitorPosts,
          priority: diff.newCompetitorPosts > 0 ? "medium" : "low",
        },
        {
          item: "newDirectives",
          count: diff.newDirectives,
          priority: diff.newDirectives > 0 ? "medium" : "low",
        },
      ];
      logger.info({ diffPriorities }, "Diff priorities assessed");

      // ── Budget initialization (Step 13 prep) ─────────────────
      budgetService.initBudget(
        "global",
        "heartbeat",
        heartbeatPeriodKey,
        50000,
        30,
      );
      const departments = [
        "command",
        "external-research",
        "competitive-analysis",
        "threads",
        "note",
      ] as const;
      for (const dept of departments) {
        budgetService.initBudget(
          dept,
          "heartbeat",
          heartbeatPeriodKey,
          10000,
          10,
        );
      }

      // ── Safety: cost degradation check ───────────────────────
      const degradation = safetyService.checkCostDegradation();
      if (degradation === "emergency") {
        logger.warn("Safety: cost degradation=emergency, limiting actions");
      } else if (degradation === "degraded") {
        logger.warn("Safety: cost degradation=degraded");
      }

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

      // ── Step 3.5: 各部署から状況レポート収集（ボトムアップ） ──
      const departmentReports = departmentExecution.collectReports();
      logger.info(
        {
          reports: departmentReports.map((r) => ({
            department: r.department,
            summary: r.summary,
            recommendation: r.recommendation,
          })),
        },
        "Department reports collected (bottom-up)",
      );

      // ── Step 4: エグゼクティブ判断（LLM駆動） ───────────────────
      const actions = await scheduler.decideActions();
      const cycle = await executive.beginHeartbeatCycle(
        departmentReports,
        actions,
        llm,
      );
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
          degradation,
          llmReasoning: cycle.llmReasoning,
          departmentRecommendations: departmentReports.map((r) => ({
            department: r.department,
            recommendation: r.recommendation,
          })),
        },
        "Heartbeat cycle planned by executive (LLM-driven)",
      );

      // ── Step 5-6: 各部署へ最小コンテキスト配布 & 部署実行 ───
      for (const action of cycle.approvedActions) {
        runtimeState.startAction(action.type, action.reason);
        const department = executive.resolveDepartment(action.type);

        // Skip if department is paused by system_controls
        if (pausedScopes.has(department)) {
          logger.warn(
            { department, action: action.type },
            "Department paused by system_controls, skipping",
          );
          results.push(
            `SKIPPED: ${action.type} - department ${department} paused`,
          );
          continue;
        }

        // Budget check before execution
        if (!budgetService.canSpend(department, 1000, 1)) {
          logger.warn(
            { department, action: action.type },
            "Budget exceeded for department, deferring to next heartbeat",
          );
          results.push(`DEFERRED: ${action.type} - budget exceeded`);
          continue;
        }

        // Emergency degradation: skip non-critical actions
        if (degradation === "emergency" && action.priority > 3) {
          logger.warn(
            { action: action.type },
            "Emergency degradation: skipping low-priority action",
          );
          results.push(`DEFERRED: ${action.type} - emergency cost degradation`);
          continue;
        }

        // Step 5: Retrieve minimal context from memory for the department
        const deptMemory = memoryService.listByLayer(
          "department_summary",
          department,
        );
        const workingMemory = memoryService.listByLayer(
          "working_memory",
          department,
        );
        const retrievalContext = retrievalService.buildContext(action.reason, {
          scope: department,
          limit: 5,
        });
        memoryService.set(
          "working_memory",
          department,
          `action:${action.type}`,
          JSON.stringify({
            reason: action.reason,
            retrievalContext,
            diff,
          }),
          {
            expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
          },
        );
        logger.info(
          {
            action: action.type,
            reason: action.reason,
            deptMemoryKeys: deptMemory.map((m) => m.key),
            workingMemoryKeys: workingMemory.map((m) => m.key),
            retrievalContext,
          },
          "Executing heartbeat action with minimal context",
        );

        // ── Step 8-10: Auto-approval vs pending proposal ───────
        const isAutoApprovable = safetyService.checkAutoApproval(action);

        if (!isAutoApprovable && !dryRun) {
          const proposalRuntime = runtimeState.markPendingProposal(
            action.type,
            action.reason,
          );
          const proposalId = proposalFlow.createHierarchicalProposal({
            agentId: proposalRuntime.workerId,
            leaderAgentId: proposalRuntime.leaderId,
            executiveAgentId: proposalRuntime.executiveId,
            department,
            title: `${action.type} requires review`,
            description: action.reason,
            reason: action.reason,
            evidence: JSON.stringify({ diff, degradation, retrievalContext }),
            expectedEffect: `Execute ${action.type} action`,
            priority: action.priority <= 3 ? "high" : "medium",
            metadata: {
              actionType: action.type,
              priority: action.priority,
            },
          });
          results.push(
            `PENDING_REVIEW: ${action.type} - proposal ${proposalId} created`,
          );
          logger.info(
            { proposalId, action: action.type },
            "Action requires review, stored as proposal",
          );
          continue;
        }

        // ── Step 6: Department execution with executive instruction ────
        try {
          const instruction = cycle.departmentInstructions?.[department];
          if (instruction) {
            db.insert(departmentNotifications)
              .values({
                id: randomUUID(),
                fromDepartment: "command",
                toDepartment: department,
                notificationType: "instruction",
                content: instruction,
                readAt: null,
                createdAt: new Date().toISOString(),
              })
              .run();
          }
          const execution = await departmentExecution.execute(action, instruction);
          results.push(execution.summary);

          // Record budget spend
          budgetService.spend(department, 1000, 1);
          budgetService.spend("global", 1000, 1);

          // ── Step 7: リーダー結果統合 ──────────────────────────
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
          runtimeState.finishAction(action.type, execution.summary, 1000, 1);
        } catch (actionError) {
          const message =
            actionError instanceof Error
              ? actionError.message
              : String(actionError);
          logger.error(
            {
              action: action.type,
              error: message,
              stack:
                actionError instanceof Error ? actionError.stack : undefined,
            },
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
          runtimeState.finishAction(action.type, `FAILED: ${message}`);
        }
      }

      // ── Step 11: ログ保存（executiveが既に処理） ──────────────
      isFailed = results.some((r) => r.startsWith("FAILED:"));
      await executive.completeHeartbeatCycle(
        cycle.cycleId,
        isFailed ? "failed" : "completed",
        results.join("\n"),
      );

      // ── Step 12: サマリー更新 ─────────────────────────────────
      const now = new Date();
      const periodKey = now.toISOString().slice(0, 10); // daily key
      const cycleRuns = db
        .select()
        .from(departmentRuns)
        .where(eq(departmentRuns.cycleId, cycle.cycleId))
        .all();
      for (const dept of departments) {
        const deptRuns = cycleRuns.filter((r) => r.department === dept);
        if (deptRuns.length > 0) {
          const summaryContent = deptRuns.map((r) => r.summary).join("\n");
          db.insert(departmentSummaries)
            .values({
              id: randomUUID(),
              department: dept,
              summaryType: "daily",
              content: summaryContent,
              periodKey,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })
            .onConflictDoUpdate({
              target: [
                departmentSummaries.department,
                departmentSummaries.summaryType,
                departmentSummaries.periodKey,
              ],
              set: {
                content: summaryContent,
                updatedAt: now.toISOString(),
              },
            })
            .run();
        }
      }

      // ── Step 13: 予算記録（既にspend()で記録済み） ────────────
      const globalRemaining = budgetService.getRemainingBudget("global");
      logger.info(
        { globalRemaining, heartbeatPeriodKey },
        "Budget status at heartbeat completion",
      );

      // Expire stale working memory
      const expired = memoryService.expireWorking();
      if (expired > 0) {
        logger.info({ expired }, "Expired stale working memory entries");
      }

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
