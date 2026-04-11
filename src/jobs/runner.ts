import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { logger } from "../app/logger.js";
import { ensureAutonomyTables } from "../db/bootstrap.js";
import { db } from "../db/index.js";
import { scheduledJobRuns } from "../db/schema.js";

export interface JobOptions {
  name: string;
  dryRun?: boolean;
  stuckThresholdMinutes?: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("unique constraint failed")
  );
}

export async function runJob(
  options: JobOptions,
  execute: (ctx: { dryRun: boolean; logger: typeof logger }) => Promise<string>,
): Promise<void> {
  ensureAutonomyTables();

  const { name, dryRun = false, stuckThresholdMinutes = 60 } = options;
  const runId = randomUUID();
  const jobLogger = logger.child({ job: name, runId, dryRun });

  // Stuck running cleanup
  const stuckThreshold = new Date(
    Date.now() - stuckThresholdMinutes * 60 * 1000,
  ).toISOString();
  const cleanedUp = db
    .update(scheduledJobRuns)
    .set({
      status: "failed",
      finishedAt: new Date().toISOString(),
      resultSummary: `Stuck running for over ${stuckThresholdMinutes} minutes`,
    })
    .where(
      and(
        eq(scheduledJobRuns.jobName, name),
        eq(scheduledJobRuns.status, "running"),
        lt(scheduledJobRuns.startedAt, stuckThreshold),
      ),
    )
    .run();

  if (cleanedUp.changes > 0) {
    jobLogger.warn(
      { cleanedUpCount: cleanedUp.changes },
      "Cleaned up stuck running jobs",
    );
  }

  jobLogger.info("Job started");

  const startedAt = new Date().toISOString();

  try {
    db.insert(scheduledJobRuns)
      .values({
        id: runId,
        jobName: name,
        status: "running",
        startedAt,
        createdAt: startedAt,
        dryRun: dryRun ? 1 : 0,
      })
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      jobLogger.warn("Job already running, skipping");
      return;
    }
    throw error;
  }

  try {
    const summary = await execute({ dryRun, logger: jobLogger });

    db.update(scheduledJobRuns)
      .set({
        status: "completed",
        finishedAt: new Date().toISOString(),
        resultSummary: summary,
      })
      .where(eq(scheduledJobRuns.id, runId))
      .run();

    jobLogger.info({ summary }, "Job completed");
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

    jobLogger.error({ error: message }, "Job failed");
    throw error;
  }
}
