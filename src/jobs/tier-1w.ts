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
    { name: "tier-1w", dryRun, stuckThresholdMinutes: 240 },
    async ({ logger }) => {
      const modeEvaluation = operationsMode.reconcileMode();
      if (
        modeEvaluation.mode === "observe_only" ||
        modeEvaluation.mode === "safe_freeze"
      ) {
        logger.warn(
          { modeEvaluation },
          "Skipping weekly tier due to active mode",
        );
        return `mode=${modeEvaluation.mode}; skipped weekly-retro`;
      }

      const retroSummary = await runInternalJob("weekly-retro.ts", { dryRun });
      logger.info({ modeEvaluation, retroSummary }, "Weekly tier completed");
      return `mode=${modeEvaluation.mode}; weekly-retro=${retroSummary}`;
    },
  );
}

if (isDirectExecution()) {
  await main();
}
