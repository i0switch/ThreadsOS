import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { logger } from "../app/logger.js";
import { db } from "../db/index.js";
import { scheduledJobRuns } from "../db/schema.js";

export interface JobOptions {
  name: string;
  dryRun?: boolean;
}

export async function runJob(
  options: JobOptions,
  execute: (ctx: { dryRun: boolean; logger: typeof logger }) => Promise<string>,
): Promise<void> {
  const { name, dryRun = false } = options;
  const runId = randomUUID();
  const jobLogger = logger.child({ job: name, runId, dryRun });

  // 二重起動防止
  const running = db
    .select()
    .from(scheduledJobRuns)
    .where(
      and(
        eq(scheduledJobRuns.jobName, name),
        eq(scheduledJobRuns.status, "running"),
      ),
    )
    .get();

  if (running) {
    jobLogger.warn(
      { existingRunId: running.id },
      "Job already running, skipping",
    );
    return;
  }

  jobLogger.info("Job started");

  const startedAt = new Date().toISOString();

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
