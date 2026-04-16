import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationsModeService } from "../services/operations-mode/index.js";
import { createRollbackService } from "../services/rollback/index.js";
import { runInternalJob } from "./internal-job.js";
import { runJob } from "./runner.js";

function isDirectExecution(): boolean {
  return (
    typeof process.argv[1] === "string" &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

export async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const operationsMode = createOperationsModeService();
  const rollback = createRollbackService();

  await runJob(
    { name: "tier-15m", dryRun, stuckThresholdMinutes: 20 },
    async ({ logger }) => {
      const modeEvaluation = operationsMode.reconcileMode();
      const metricsSyncSummary = await runInternalJob("metrics-sync.ts", {
        dryRun,
      });
      const rollbackResult = rollback.applyIfNeeded();

      logger.info(
        { modeEvaluation, metricsSyncSummary, rollbackResult },
        "15-minute maintenance completed",
      );

      const parts = [
        `mode=${modeEvaluation.mode}`,
        modeEvaluation.changed
          ? `transition=${modeEvaluation.previousMode ?? "none"}->${modeEvaluation.mode}`
          : `stable=${modeEvaluation.reason}`,
        `metrics-sync=${metricsSyncSummary}`,
        rollbackResult.applied
          ? `rollback=${rollbackResult.channel}:${rollbackResult.reason}`
          : `rollback=${rollbackResult.reason}`,
      ];

      return parts.join("; ");
    },
  );
}

if (isDirectExecution()) {
  await main();
}
