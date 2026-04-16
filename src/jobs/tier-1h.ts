import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationsModeService } from "../services/operations-mode/index.js";
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

  await runJob(
    { name: "tier-1h", dryRun, stuckThresholdMinutes: 90 },
    async ({ logger }) => {
      const modeEvaluation = operationsMode.reconcileMode();
      if (modeEvaluation.mode === "safe_freeze") {
        logger.warn({ modeEvaluation }, "Skipping hourly tier in safe freeze");
        return `mode=${modeEvaluation.mode}; skipped hourly-heartbeat`;
      }

      const heartbeatSummary = await runInternalJob("hourly-heartbeat.ts", {
        dryRun,
      });
      logger.info(
        { modeEvaluation, heartbeatSummary },
        "Hourly tier completed",
      );
      return `mode=${modeEvaluation.mode}; hourly-heartbeat=${heartbeatSummary}`;
    },
  );
}

if (isDirectExecution()) {
  await main();
}
